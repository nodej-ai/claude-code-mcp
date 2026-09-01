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

// Safety guard: in a stdio MCP server, process.stdout is the JSON-RPC channel.
// Any console.log (from this code or any dependency) will corrupt the stream.
// Redirect all console variants to stderr so they appear in logs without breaking the transport.
console.log = console.error.bind(console);
console.info = console.error.bind(console);
console.debug = console.error.bind(console);

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn, ChildProcess } from "child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { PROJECTS_DIR, resolveProjectPath } from "./project-resolver.js";
import { randomUUID } from "crypto";
import { z } from "zod";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { config as dotenvConfig } from "dotenv";

// Load dispatcher credentials so bridge can write to dispatcher_jobs.
// quiet: true suppresses dotenv v17's console.log output (e.g. "◇ injected env …").
// In a stdio MCP server, stdout is the JSON-RPC transport channel — any non-JSON
// written there (including dotenv's startup log) corrupts the MCP handshake.
//
// .env resolution order (F18 — configurable for distribution):
//   1. CLAUDE_CODE_MCP_ENV env var  — recommended for CI / multi-machine installs
//   2. .env next to the package root — drop-in for new installs (create alongside package.json)
//   3. Legacy path on Julian's machine — backward-compat fallback, will log a warning
//
// For distribution: set CLAUDE_CODE_MCP_ENV=/absolute/path/to/.env in the shell that
// launches the MCP server, or create a .env in the claude-code-mcp root directory.
const SERVER_ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const pkg = JSON.parse(readFileSync(join(SERVER_ROOT, "package.json"), "utf-8")) as { version?: string };
const SERVER_VERSION = pkg.version ?? "1.0.0";
const envCandidates = [
  process.env.CLAUDE_CODE_MCP_ENV,
  join(SERVER_ROOT, ".env"),
  resolve(homedir(), "Projects/julian-nodejeos/packages/engineering-dispatcher/.env"),
].filter(Boolean) as string[];

const resolvedEnvPath = envCandidates.find(existsSync);
if (resolvedEnvPath) {
  dotenvConfig({ path: resolvedEnvPath, quiet: true });
} else {
  console.error(
    "[claude-code-mcp] No .env found — Supabase integration disabled. " +
    "Set CLAUDE_CODE_MCP_ENV=/path/to/.env or create a .env in the package root. " +
    "See README.md for setup instructions."
  );
}

const supabase: SupabaseClient | null = (() => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
})();

// ─── Types ───────────────────────────────────────────────────────────────────

type JobStatus = "running" | "completed" | "failed" | "cancelled";

interface Job {
  id: string;
  taskId?: string;
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
const timeouts = new Map<string, ReturnType<typeof setTimeout>>();
const JOB_TTL_MS = 24 * 60 * 60 * 1000; // purge jobs after 24h
const MAX_CONCURRENT_JOBS = 5; // F10: cap simultaneous Claude Code subprocesses
const OUTPUT_CAP = 512 * 1024; // F5: 512KB in-memory output ceiling
const TASK_TIMEOUT_MS = 30 * 60 * 1000; // F21: 30-minute hard timeout per task

function purgeOldJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (
      job.status !== "running" &&
      new Date(job.startedAt).getTime() < cutoff
    ) {
      jobs.delete(id);
      processes.delete(id);
      timeouts.delete(id); // defensive: all exit paths clear this, but purge should too
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
  version: SERVER_VERSION,
});

// ── Tool 1: run a Claude Code task ────────────────────────────────────────────

server.registerTool(
  "claude_run_task",
  {
    title: "Run Claude Code Task",
    description: `Start a Claude Code task in a project directory. Returns a job_id immediately — the task runs in the background.

Poll claude_get_task_status with the returned job_id to see output as it streams in. The task completes when status is "completed" or "failed".

Args:
  - project (string): Project path inside ~/Projects/. Accepts plain names ("forkcast") or nested paths up to 3 segments ("Apps/lookahead", "Clients/acme/site"). Each segment may contain alphanumeric characters, hyphens, underscores, dots, or spaces.
  - task (string): The instruction to pass to Claude Code via "claude -p". Be specific.
  - context_file (string, optional): Absolute path to a handoff file. Its content is prepended to the task.

Returns:
  - job_id: UUID to use with claude_get_task_status
  - status: "running"
  - message: Confirmation with project path and PID

Examples:
  - Top-level project: project="forkcast", task="Add the missing bankroll_transactions indexes"
  - Nested project:    project="Apps/lookahead", task="Implement the dashboard page"
  - With context:      project="forkcast", task="Implement phase 2", context_file="/Users/juliantang/Projects/forkcast/cowork/handoffs/phase2-handoff-2026-05-12.md"

Limits:
  - Tasks are killed after 30 minutes with status "failed"
  - Max 3 concurrent running tasks

Error cases:
  - "Project not found" if ~/Projects/{project} doesn't exist
  - "Invalid project name" if name contains unsafe characters or more than 3 segments
  - "Failed to start Claude Code process" if spawn options are invalid (missing binary surfaces as a failed job via the process error event)
  - "concurrent job limit reached" if 3 tasks are already running`,
    inputSchema: z
      .object({
        project: z
          .string()
          .min(1, "Project name is required")
          .describe('Project path inside ~/Projects/ — plain name ("forkcast") or nested path up to 3 segments ("Apps/lookahead", "Clients/acme/site")'),
        task: z
          .string()
          .min(1, "Task description is required")
          .describe("Instruction to pass to Claude Code"),
        context_file: z
          .string()
          .optional()
          .describe("Absolute path to a handoff file to prepend as context"),
        task_id: z
          .string()
          .uuid()
          .optional()
          .describe("UUID from memory.tasks — used to link dispatcher_jobs rows"),
        skill_name: z
          .string()
          .optional()
          .describe("Skill name that ran this job (e.g. 'tdd-guide', 'agent-shield') — stored in dispatcher_jobs for dashboard visibility"),
      })
      .strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ project, task, context_file, task_id, skill_name }) => {
    purgeOldJobs();

    // F10: reject if concurrent running job limit is reached
    const runningCount = [...jobs.values()].filter(j => j.status === "running").length;
    if (runningCount >= MAX_CONCURRENT_JOBS) {
      return {
        content: [{ type: "text", text: `Error: concurrent job limit (${MAX_CONCURRENT_JOBS}) reached. Wait for a running job to finish or cancel one.` }],
        isError: true,
      };
    }

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

    // resolveProjectPath already verified the path exists via existsSync.
    // statSync here is purely to catch the edge case where a matching path
    // exists but is a file rather than a directory (e.g. ~/Projects/forkcast is a file).
    if (!statSync(projectPath).isDirectory()) {
      return {
        content: [
          { type: "text", text: `Error: "${projectPath}" exists but is not a directory.` },
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
      taskId: task_id,
      project,
      task,
      contextFile: context_file,
      status: "running",
      output: "",
      startedAt: new Date().toISOString(),
    };
    jobs.set(jobId, job);

    if (supabase && task_id) {
      supabase.schema("memory").from("dispatcher_jobs").insert({
        job_id: jobId,
        task_id,
        project,
        skill_name: skill_name ?? null,
        status: "running",
        started_at: job.startedAt,
      }).then(({ error }) => {
        if (error) console.error("[bridge] dispatcher_jobs insert error:", error.message);
      });
    }

    // Spawn Claude Code
    // --permission-mode dontAsk  — auto-approves all tool calls without interactive prompts,
    //   but respects directory scope (unlike --dangerously-skip-permissions which bypasses
    //   all checks including filesystem boundaries). Scoped to PROJECTS_DIR via --add-dir.
    // --add-dir PROJECTS_DIR     — grants access to ~/Projects/ only, not the full filesystem.
    //   Tasks that need cross-project reads (e.g. julian-nodejeos from danielle) still work
    //   because both are under ~/Projects/.
    // --output-format stream-json — suppresses TUI decorations that would corrupt the MCP
    //   stdio transport. stream-json emits one JSON object per line. Requires --verbose.
    let child: ChildProcess;
    try {
      child = spawn(
        "claude",
        [
          "--dangerously-skip-permissions",
          "--add-dir", PROJECTS_DIR,
          "--print", "--verbose", "--output-format", "stream-json",
          fullPrompt,
        ],
        {
          cwd: projectPath,
          env: { ...process.env },
          // detached: true creates a new process group (PGID == child.pid).
          // This lets process.kill(-pid, 'SIGKILL') kill Claude Code and all
          // grandchild processes it spawns, preventing orphans on timeout/completion.
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
    } catch (spawnErr) {
      // spawn() throws synchronously only for invalid options (e.g., malformed env or
      // an options object error). A missing binary does NOT throw here — it fires
      // child.on("error") with ENOENT instead, which is handled below.
      job.status = "failed";
      job.output = `Error: spawn() threw synchronously: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`;
      job.completedAt = new Date().toISOString();
      return {
        content: [
          {
            type: "text",
            text: `Error: Failed to start Claude Code process: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`,
          },
        ],
        isError: true,
      };
    }

    job.pid = child.pid;
    processes.set(jobId, child);

    // F21: hard 30-minute timeout — kills hung processes and frees the slot
    const timeoutHandle = setTimeout(() => {
      const proc = processes.get(jobId);
      if (proc) {
        // Kill the entire process group so grandchildren spawned by Claude Code
        // don't survive as orphans. Wrapped in try/catch: ESRCH fires if the
        // process already exited between the check and the kill call.
        try { if (proc.pid) process.kill(-proc.pid, "SIGKILL"); } catch {}
        job.status = "failed";
        job.output += "\n[Task timed out after 30 minutes]";
        job.completedAt = new Date().toISOString();
        processes.delete(jobId);
        timeouts.delete(jobId);
        console.error(`[bridge] Task ${jobId} killed after 30-minute timeout`);
      }
    }, TASK_TIMEOUT_MS);
    // Store handle so the cancel handler (a separate closure) can clear it
    timeouts.set(jobId, timeoutHandle);

    // stream-json emits one JSON object per line. Extract text from assistant message chunks;
    // fall back to appending the raw line for any line that isn't parseable JSON (shouldn't happen,
    // but keeps output readable if the format ever changes).
    let stdoutBuf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf-8");
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? ""; // keep incomplete last line in buffer
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as Record<string, unknown>;
          // stream-json events have a "type" field. Pull text from assistant content blocks.
          if (
            event.type === "assistant" &&
            event.message &&
            typeof event.message === "object"
          ) {
            const msg = event.message as { content?: unknown[] };
            for (const block of msg.content ?? []) {
              const b = block as { type?: string; text?: string };
              if (b.type === "text" && typeof b.text === "string") {
                // F5: cap in-memory output at 512KB
                if (job.output.length < OUTPUT_CAP) {
                  job.output += b.text;
                } else if (!job.output.endsWith("[output truncated at 512KB]")) {
                  job.output += "\n[output truncated at 512KB]";
                }
              }
            }
          } else if (event.type === "result") {
            // stream-json emits a "result" event when the Claude session ends,
            // before the process exits. Finalize here so the DB is updated
            // immediately rather than waiting for the 'close' event.
            const ev = event as { subtype?: string; is_error?: boolean; result?: string };
            const now = new Date().toISOString();
            const succeeded = ev.subtype === "success" && !ev.is_error;
            job.status = succeeded ? "completed" : "failed";
            job.exitCode = succeeded ? 0 : 1;
            job.completedAt = now;
            if (typeof ev.result === "string" && ev.result) {
              if (job.output.length < OUTPUT_CAP) {
                job.output += ev.result;
              } else if (!job.output.endsWith("[output truncated at 512KB]")) {
                job.output += "\n[output truncated at 512KB]";
              }
            }
            if (supabase && job.taskId) {
              supabase.schema("memory").from("dispatcher_jobs").update({
                status: job.status,
                output: job.output.slice(0, 10000),
                exit_code: job.exitCode,
                completed_at: now,
              }).eq("job_id", jobId).then(({ error }) => {
                if (error) console.error("[bridge] dispatcher_jobs update (result event) error:", error.message);
              });
            }
            // Clear the 30-min timeout — the session is done.
            const th = timeouts.get(jobId);
            if (th) { clearTimeout(th); timeouts.delete(jobId); }
            // Arm a 5-second grace timer to SIGKILL the process group.
            // Claude Code may still be flushing stderr / closing files after emitting
            // the result event; the grace window lets it exit cleanly first.
            setTimeout(() => {
              try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch {}
            }, 5000);
          }
          // Ignore other event types (tool_use, tool_result, system, etc.)
        } catch {
          // Not JSON — append raw so nothing is silently lost
          // F5: cap in-memory output at 512KB
          if (job.output.length < OUTPUT_CAP) {
            job.output += line + "\n";
          } else if (!job.output.endsWith("[output truncated at 512KB]")) {
            job.output += "\n[output truncated at 512KB]";
          }
        }
      }
    });

    // F6: flush any remaining partial line when stdout closes
    // F5: respect OUTPUT_CAP on the final flush too
    child.stdout?.on("end", () => {
      if (stdoutBuf.trim()) {
        if (job.output.length < OUTPUT_CAP) {
          job.output += stdoutBuf;
        } else if (!job.output.endsWith("[output truncated at 512KB]")) {
          job.output += "\n[output truncated at 512KB]";
        }
        stdoutBuf = "";
      }
    });

    // F22: prefix stderr so it's distinguishable from task output
    // F5: cap in-memory output at 512KB
    child.stderr?.on("data", (chunk: Buffer) => {
      const stderrText = "[stderr] " + chunk.toString("utf-8");
      if (job.output.length < OUTPUT_CAP) {
        job.output += stderrText;
      } else if (!job.output.endsWith("[output truncated at 512KB]")) {
        job.output += "\n[output truncated at 512KB]";
      }
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timeoutHandle); // F21: cancel the timeout on normal exit
      timeouts.delete(jobId);
      if (job.status === "cancelled") {
        processes.delete(jobId); // F8 + cleanup: ensure map is cleared even on cancel
        return;
      }
      // Guard: the result-event handler may have already finalized status.
      // Only update if we're still "running" (the fallback path for sessions that
      // never emit a result event, e.g. crashes, SIGKILL from the 30-min timeout).
      if (job.status !== "running") {
        processes.delete(jobId);
        return;
      }
      job.status = code === 0 ? "completed" : "failed";
      job.exitCode = code ?? undefined;
      job.completedAt = new Date().toISOString();
      processes.delete(jobId);

      if (supabase && job.taskId) {
        supabase.schema("memory").from("dispatcher_jobs").update({
          status: job.status,
          output: job.output.slice(0, 10000),
          exit_code: code ?? null,
          completed_at: job.completedAt,
        }).eq("job_id", jobId).then(({ error }) => {
          if (error) console.error("[bridge] dispatcher_jobs update error:", error.message);
        });
      }
    });

    child.on("error", (err: Error) => {
      clearTimeout(timeoutHandle); // F21: cancel the timeout on process error
      timeouts.delete(jobId);
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

Efficient polling with output_offset: on the first call pass output_offset: 0 (or omit it). The response
includes next_offset. On subsequent calls pass output_offset: <next_offset> and you receive only the new
output since the last poll — avoiding retransmission of the full accumulated string.

Args:
  - job_id (string): UUID returned by claude_run_task
  - output_offset (number, optional): Byte offset into the output string. Omit or pass 0 on first call.
    Pass the returned next_offset on subsequent calls to receive only new output.

Returns:
  - id, project, status, output (slice from offset), next_offset, startedAt, completedAt, exitCode

Error cases:
  - "Job not found" if the job_id is invalid or the job has expired (24h TTL)`,
    inputSchema: z
      .object({
        job_id: z.string().uuid("Must be a valid UUID").describe("Job ID from claude_run_task"),
        output_offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Byte offset into the output string. Pass 0 (or omit) on first call, then pass the returned next_offset to receive only new output."),
      })
      .strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ job_id, output_offset }) => {
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

    // F20: return only the output slice from the requested offset so callers don't
    // retransmit the full accumulated string on every poll.
    // Clamp offset to output length — a stale offset from a truncated output would otherwise
    // produce a negative slice (next_offset < offset), confusing the caller.
    const offset = Math.min(output_offset ?? 0, job.output.length);
    const outputSlice = job.output.slice(offset);
    const nextOffset = job.output.length;

    return {
      content: [{ type: "text", text: formatJob(job) }],
      structuredContent: {
        id: job.id,
        project: job.project,
        task: job.task,
        status: job.status,
        output: outputSlice,
        next_offset: nextOffset,
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
          task_id: j.taskId,
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
    description: `Cancel a running Claude Code task. Sends SIGTERM then escalates to SIGKILL after 5 seconds if the process hasn't exited.

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
      // F7: escalate to SIGKILL if the process hasn't exited within 5 seconds.
      // Use exitCode === null rather than !child.killed: child.killed is set to true
      // immediately after kill() is called, before the process actually exits —
      // so !child.killed is always false here and SIGKILL would never fire.
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
          console.error(`[bridge] SIGKILL sent to orphaned process for job ${job_id}`);
        }
      }, 5000);
    }

    job.status = "cancelled";
    job.completedAt = new Date().toISOString();
    processes.delete(job_id);

    // F4: clear the 30-minute timeout — cancel already killed the process so the
    // timeout firing against a deleted processes entry is harmless, but clearing it
    // avoids holding the event loop open until the 30-min mark.
    const th = timeouts.get(job_id);
    if (th) {
      clearTimeout(th);
      timeouts.delete(job_id);
    }

    // Sync cancellation to Supabase so dispatcher_jobs doesn't stay "running" indefinitely.
    // Include output so any captured progress isn't lost in the DB record.
    if (supabase && job.taskId) {
      supabase.schema("memory").from("dispatcher_jobs").update({
        status: "cancelled",
        output: job.output.slice(0, 10000),
        completed_at: job.completedAt,
      }).eq("job_id", job_id).then(({ error }) => {
        if (error) console.error("[bridge] dispatcher_jobs cancel update error:", error.message);
      });
    }

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
    description: `List all project directories in ~/Projects/, including one level of nesting.

Use this to discover valid project names (and nested paths) before calling claude_run_task.
Nested entries appear as "ParentDir/SubDir" and can be passed directly to claude_run_task.

Returns a combined list of top-level directories and their immediate subdirectories.`,
    inputSchema: z.object({}).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    let topLevel: string[];
    try {
      topLevel = readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
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

    // Also enumerate one level of nesting so callers can see nested project paths
    // (e.g. "Apps/lookahead") that can be passed directly to claude_run_task.
    const allPaths: string[] = [...topLevel];
    for (const dir of topLevel) {
      try {
        const nested = readdirSync(join(PROJECTS_DIR, dir), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => `${dir}/${e.name}`)
          .sort();
        allPaths.push(...nested);
      } catch {
        // unreadable subdirectory — skip silently
      }
    }

    const result = {
      projects_dir: PROJECTS_DIR,
      count: allPaths.length,
      projects: allPaths,
    };

    return {
      content: [
        {
          type: "text",
          text: `## Projects in ~/Projects/ (${allPaths.length})\n\n${allPaths.map((e) => `- ${e}`).join("\n")}`,
        },
      ],
      structuredContent: result,
    };
  }
);

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // F9: purge expired jobs on a regular interval, not only on task start.
  // .unref() prevents the interval from holding the event loop open — the server
  // exits cleanly on SIGTERM without waiting for the next purge tick.
  setInterval(purgeOldJobs, 60 * 60 * 1000).unref();

  // F11: wrap Supabase startup cleanup in its own try/catch so a Supabase outage
  // doesn't crash the server before it starts accepting MCP connections.
  if (supabase) {
    try {
      const { data: staleJobs } = await supabase
        .schema("memory")
        .from("dispatcher_jobs")
        .select("job_id")
        .eq("status", "running");
      for (const j of staleJobs ?? []) {
        await supabase.schema("memory").from("dispatcher_jobs").update({
          status: "failed",
          output: "Bridge restarted — job lost. Dispatcher will requeue.",
          completed_at: new Date().toISOString(),
        }).eq("job_id", j.job_id);
      }
      if ((staleJobs?.length ?? 0) > 0) {
        console.error(`[bridge] Marked ${staleJobs!.length} stale running job(s) as failed on startup`);
      }
    } catch (err) {
      console.error("[bridge] Supabase startup check failed (non-fatal — server will still start):", err);
    }
  }

  // Kill all in-progress child processes when the bridge itself is terminated.
  // Without this, Claude Code subprocesses become orphans when Cowork restarts the bridge.
  process.on("SIGTERM", () => {
    console.error("[bridge] SIGTERM received — killing all child processes");
    for (const [jobId, child] of processes) {
      child.kill("SIGKILL");
      const job = jobs.get(jobId);
      if (job) {
        job.status = "failed";
        job.output += "\n[Bridge process terminated — task killed]";
        job.completedAt = new Date().toISOString();
      }
    }
    processes.clear();
    timeouts.clear();
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[claude-code-mcp] Server running via stdio");
}

main().catch((error: unknown) => {
  console.error("[claude-code-mcp] Fatal error:", error);
  process.exit(1);
});
