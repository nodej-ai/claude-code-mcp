# claude-code-mcp — Setup

Local MCP server that lets Cowork run Claude Code tasks programmatically.
Cowork calls `claude_run_task`, gets a job_id back, then polls `claude_get_task_status`
to see output as it accumulates. No manual tab-switching, no copy-pasting handoffs.

---

## Step 1: Move to ~/Projects/

```bash
mv ~/Projects/Training\ Material/claude-code-mcp ~/Projects/claude-code-mcp
```

## Step 2: Re-run npm install on your Mac

The node_modules were built in a Linux sandbox. Re-install natively:

```bash
cd ~/Projects/claude-code-mcp
npm install
npm run build
```

Confirm the build succeeds:

```bash
node dist/index.js  # Should hang (waiting for MCP client) — that's correct. Ctrl-C.
```

## Step 3: Register with Claude Desktop / Cowork

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`.
Add the `claude-code-bridge` entry inside `"mcpServers"`:

```json
{
  "mcpServers": {
    "claude-code-bridge": {
      "command": "node",
      "args": ["/Users/juliantang/Projects/claude-code-mcp/dist/index.js"]
    }
  }
}
```

If you already have other MCP servers in the file, add the new entry alongside them.

## Step 4: Restart Claude Desktop / Cowork

The MCP server starts on demand each session. No persistent process needed.

---

## Tools available after setup

| Tool | What it does |
|---|---|
| `claude_run_task` | Starts a Claude Code task in a project dir. Returns job_id immediately. |
| `claude_get_task_status` | Returns accumulated output + status for a job. Poll until "completed"/"failed". |
| `claude_list_tasks` | Lists all tracked jobs, optionally filtered by status. |
| `claude_cancel_task` | Sends SIGTERM to a running job. |
| `claude_list_projects` | Lists all directories in ~/Projects/. |

## Example usage (from Cowork)

"Run the phase 2 handoff in forkcast" →

```
claude_run_task(
  project: "forkcast",
  task: "Implement phase 2 from the handoff",
  context_file: "/Users/juliantang/Projects/forkcast/cowork/handoffs/phase2-handoff-2026-05-12.md"
)
→ { job_id: "abc-123", status: "running", pid: 12345 }

claude_get_task_status(job_id: "abc-123")
→ { status: "running", output: "Reading handoff...\nCreating migration..." }

claude_get_task_status(job_id: "abc-123")
→ { status: "completed", output: "...", exitCode: 0 }
```

## Notes

- Jobs are held in memory for 24 hours, then purged.
- If Claude Desktop restarts, in-flight job history is lost (the subprocess may still run — check via `ps aux | grep claude`).
- stderr is merged into the output buffer so you see all Claude Code output in one stream.
- The server uses stdio transport — it starts as a subprocess of Claude Desktop, not a persistent daemon.
