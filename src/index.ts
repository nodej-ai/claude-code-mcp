#!/usr/bin/env node
/**
 * claude-code-mcp-server
 *
 * Local MCP server that lets Cowork run Claude Code tasks programmatically.
 * Uses async job tracking: run_task returns a job_id immediately; poll
 * get_task_status to receive streaming output as it accumulates.
 *
 * Transport: stdio (registered in claude_desktop_config.json)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn, ChildProcess } from "child_process";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { z } from "zod";

// ─── Types ───────────────────────────────────────────────────────────────────

type JobStatus = "running" | "completed" | "failed" | "cancelled";

interface Job {
  id: string;
  project: string;
  task: string;
  contextFile?: string;
  status: JobStatus;
  output: string;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  pid?: number;
}

// ─── In-memory job store ──────────────────────────────────────────────────────

const jobs = new Map<string, Job>();
const processes = new Map<string, ChildProcess>();
const JOB_TTL_MS = 24 * 60 * 60 * 1000; // purge jobs after 24h

function purgeOldJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (
      job.status !== "running" &&
      new Date(job.startedAt).getTime() < cutoff
    ) {
      jobs.delete(id);
      processes.delete(id);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PROJECTS_DIR = join(homedir(), "Projects");

function resolveProjectPath(project: string): string {
  // Prevent directory traversal
  const safeName = project.replace(/[^a-zA-Z0-9_\-. ]/g, "");
  if (safeName !== project) {
    throw new Error(
      `Invalid project name: "${project}". Use alphanumeric characters, hyphens, underscores, or spaces.`
    );
  }
  const projectPath = resolve(PROJECTS_DIR, project);
  if (!projectPath.startsWith(PROJECTS_DIR)) {
    throw new Error(`Project path escapes Projects directory.`);
  }
  return projectPath;
}

function formatJob(job: Job): string {
  const lines = [
    `**Job ID**: ${job.id}`,
    `**Project**: ${job.project}`,
    `**Status**: ${job.status}`,
    `**Started**: ${job.startedAt}`,
  ];
  if (job.completedAt) lines.push(`**Completed**: ${job.completedAt}`);
  if (job.exitCode !== undefined) lines.push(`**Exit code**: ${job.exitCode}`);
  if (job.pid) lines.push(`**PID**: ${job.pid}`);
  lines.push(``, `### Output`, `\`\`\``, job.output || "(no output yet)", `\`\`\``);
  return lines.join("\n");
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "claude-code-mcp-server",
  version: "1.0.0",
});

// ── Tool 1: run a Claude Code task ────────────────────────────────────────────

server.registerTool(
  "claude_run_task",
  {
    title: "Run Claude Code Task",
    description: `Start a Claude Code task in a project directory. Returns a job_id immediately — the task runs in the background.

Poll claude_get_task_status with the returned job_id to see output as it streams in. The task completes when status is "completed" or "failed".

Args:
  - project (string): Project folder name inside ~/Projects/ (e.g. "forkcast", "academic-architect")
  - task (string): The instruction to pass to Claude Code via "claude -p". Be specific.
  - context_file (string, optional): Absolute path to a handoff file. Its content is prepended to the task.

Returns:
  - job_id: UUID to use with claude_get_task_status
  - status: "running"
  - message: Confirmation with project path and PID

Examples:
  - Run a task: project="forkcast", task="Add the missing bankroll_transactions indexes from the schema handoff"
  - With context: project="forkcast", task="Implement phase 2", context_file="/Users/juliantang/Projects/forkcast/cowork/handoffs/phase2-handoff-2026-05-12.md"

Error cases:
  - "Project not found" if ~/Projects/{project} doesn't exist
  - "Invalid project name" if name contains unsafe characters
  - "claude binary not found" if Claude Code CLI isn't installed`,
    inputSchema: z
      .object({
        project: z
          .string()
          .min(1, "Project name is required")
          .describe("Folder name inside ~/Projects/"),
        task: z
          .string()
          .min(1, "Task description is required")
          .describe("Instruction to pass to Claude Code"),
        context_file: z
          .string()
          .optional()
          .describe("Absolute path to a handoff file to prepend as context"),
      })
      .strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ project, task, context_file }) => {
    purgeOldJobs();

    let projectPath: string;
    try {
      projectPath = resolveProjectPath(project);
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }

    // Verify project directory exists
    try {
      const stat = statSync(projectPath);
      if (!stat.isDirectory()) {
        return {
          content: [
            { type: "text", text: `Error: "${projectPath}" exists but is not a directory.` },
          ],
          isError: true,
        };
      }
    } catch {
      return {
        content: [
          {
            type: "text",
            text: `Error: Project not found at ${projectPath}. Run claude_list_projects to see available projects.`,
          },
        ],
        isError: true,
      };
    }

    // Build the full prompt (prepend context file if provided)
    let fullPrompt = task;
    if (context_file) {
      try {
        const contextContent = readFileSync(context_file, "utf-8");
        fullPrompt = `${contextContent}\n\n---\n\n${task}`;
      } catch {
        return {
          content: [
            {
              type: "text",
              text: `Error: Could not read context file at "${context_file}". Check the path and try again.`,
            },
          ],
          isError: true,
        };
      }
    }

    const jobId = randomUUID();
    const job: Job = {
      id: jobId,
      project,
      task,
      contextFile: context_file,
      status: "running",
      output: "",
      startedAt: new Date().toISOString(),
    };
    jobs.set(jobId, job);

    // Spawn Claude Code
    let child: ChildProcess;
    try {
      child = spawn("claude", ["--dangerously-skip-permissions", "--print", fullPrompt], {
        cwd: projectPath,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      job.status = "failed";
      job.output = "Error: Failed to spawn claude process. Is Claude Code CLI installed and on PATH?";
      job.completedAt = new Date().toISOString();
      return {
        content: [
          {
            type: "text",
            text: `Error: claude binary not found. Install Claude Code CLI and ensure it's on PATH.`,
          },
        ],
        isError: true,
      };
    }

    job.pid = child.pid;
    processes.set(jobId, child);

    // Stream stdout to buffer
    child.stdout?.on("data", (chunk: Buffer) => {
      job.output += chunk.toString("utf-8");
    });

    // Stream stderr to buffer (prefixed so it's distinguishable)
    child.stderr?.on("data", (chunk: Buffer) => {
      job.output += chunk.toString("utf-8");
    });

    child.on("close", (code: number | null) => {
      job.status = code === 0 ? "completed" : "failed";
      job.exitCode = code ?? undefined;
      job.completedAt = new Date().toISOString();
      processes.delete(jobId);
    });

    child.on("error", (err: Error) => {
      job.status = "failed";
      job.output += `\n[Process error: ${err.message}]`;
      job.completedAt = new Date().toISOString();
      processes.delete(jobId);
    });

    const result = {
      job_id: jobId,
      status: "running",
      project,
      project_path: projectPath,
      pid: child.pid,
      message: `Claude Code started in ${projectPath} (PID ${child.pid}). Poll claude_get_task_status("${jobId}") to track output.`,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  }
);

// ── Tool 2: get task status + output ─────────────────────────────────────────

server.registerTool(
  "claude_get_task_status",
  {
    title: "Get Claude Code Task Status",
    description: `Get the current status and accumulated output of a running or completed Claude Code task.

Call this repeatedly (every 3-5 seconds) while status is "running" to see output as it streams in.
Stop polling when status is "completed" or "failed".

Args:
  - job_id (string): UUID returned by claude_run_task

Returns:
  - id, project, status, output (accumulated so far), startedAt, completedAt, exitCode

Error cases:
  - "Job not found" if the job_id is invalid or the job has expired (24h TTL)`,
    inputSchema: z
      .object({
        job_id: z.string().uuid("Must be a valid UUID").describe("Job ID from claude_run_task"),
      })
      .strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ job_id }) => {
    const job = jobs.get(job_id);
    if (!job) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Job "${job_id}" not found. It may have expired (24h TTL) or the ID is incorrect. Run claude_list_tasks to see active jobs.`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: formatJob(job) }],
      structuredContent: {
        id: job.id,
        project: job.project,
        task: job.task,
        status: job.status,
        output: job.output,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        exitCode: job.exitCode,
        pid: job.pid,
      },
    };
  }
);

// ── Tool 3: list tasks ────────────────────────────────────────────────────────

server.registerTool(
  "claude_list_tasks",
  {
    title: "List Claude Code Tasks",
    description: `List recent Claude Code tasks tracked by this server.

Args:
  - status (string, optional): Filter by status — "running", "completed", "failed", "cancelled", or omit for all.

Returns list of jobs with id, project, status, startedAt, and task preview (first 100 chars).`,
    inputSchema: z
      .object({
        status: z
          .enum(["running", "completed", "failed", "cancelled"])
          .optional()
          .describe('Filter by status. Omit for all jobs.'),
      })
      .strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ status }) => {
    const filtered = [...jobs.values()].filter(
      (j) => !status || j.status === status
    );

    if (filtered.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: status
              ? `No ${status} jobs found.`
              : "No jobs found. Use claude_run_task to start one.",
          },
        ],
      };
    }

    // Sort newest first
    filtered.sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );

    const lines = filtered.map((j) => {
      const preview = j.task.length > 100 ? j.task.slice(0, 97) + "..." : j.task;
      return `- **${j.id}** | ${j.project} | ${j.status} | ${j.startedAt}\n  Task: ${preview}`;
    });

    return {
      content: [
        {
          type: "text",
          text: `## Claude Code Tasks (${filtered.length})\n\n${lines.join("\n\n")}`,
        },
      ],
      structuredContent: {
        count: filtered.length,
        jobs: filtered.map((j) => ({
          id: j.id,
          project: j.project,
          status: j.status,
          startedAt: j.startedAt,
          completedAt: j.completedAt,
          task_preview: j.task.slice(0, 100),
        })),
      },
    };
  }
);

// ── Tool 4: cancel task ───────────────────────────────────────────────────────

server.registerTool(
  "claude_cancel_task",
  {
    title: "Cancel Claude Code Task",
    description: `Cancel a running Claude Code task by sending SIGTERM to the subprocess.

Args:
  - job_id (string): UUID of the running job to cancel

Returns:
  - success: true/false
  - message: Confirmation or error

Error cases:
  - "Job not found" if job_id doesn't exist
  - "Job is not running" if the job has already completed or been cancelled`,
    inputSchema: z
      .object({
        job_id: z.string().uuid("Must be a valid UUID").describe("Job ID to cancel"),
      })
      .strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ job_id }) => {
    const job = jobs.get(job_id);
    if (!job) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Job "${job_id}" not found.`,
          },
        ],
        isError: true,
      };
    }

    if (job.status !== "running") {
      return {
        content: [
          {
            type: "text",
            text: `Error: Job "${job_id}" is not running (status: ${job.status}). Nothing to cancel.`,
          },
        ],
        isError: true,
      };
    }

    const child = processes.get(job_id);
    if (child) {
      child.kill("SIGTERM");
    }

    job.status = "cancelled";
    job.completedAt = new Date().toISOString();
    processes.delete(job_id);

    const result = {
      success: true,
      job_id,
      message: `Job "${job_id}" cancelled.`,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  }
);

// ── Tool 5: list projects ─────────────────────────────────────────────────────

server.registerTool(
  "claude_list_projects",
  {
    title: "List Projects",
    description: `List all project directories in ~/Projects/.

Use this to discover valid project names before calling claude_run_task.

Returns a list of directory names.`,
    inputSchema: z.object({}).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    let entries: string[];
    try {
      entries = readdirSync(PROJECTS_DIR)
        .filter((name) => {
          try {
            return statSync(join(PROJECTS_DIR, name)).isDirectory();
          } catch {
            return false;
          }
        })
        .sort();
    } catch {
      return {
        content: [
          {
            type: "text",
            text: `Error: Could not read ${PROJECTS_DIR}. Does the directory exist?`,
          },
        ],
        isError: true,
      };
    }

    const result = {
      projects_dir: PROJECTS_DIR,
      count: entries.length,
      projects: entries,
    };

    return {
      content: [
        {
          type: "text",
          text: `## Projects in ~/Projects/ (${entries.length})\n\n${entries.map((e) => `- ${e}`).join("\n")}`,
        },
      ],
      structuredContent: result,
    };
  }
);

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[claude-code-mcp] Server running via stdio");
}

main().catch((error: unknown) => {
  console.error("[claude-code-mcp] Fatal error:", error);
  process.exit(1);
});
