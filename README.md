# claude-code-mcp

Local MCP bridge that lets Cowork run Claude Code tasks programmatically. Write a task from Cowork, Claude Code executes it in your project directory, output streams back in real time.

## Install

**Prerequisites:** Node.js 18+, Claude Code CLI

```bash
curl -fsSL https://raw.githubusercontent.com/nodej-ai/claude-code-mcp/main/install.sh | bash
```

Then restart Cowork.

## Tools

| Tool | Description |
|---|---|
| `claude_run_task` | Start a Claude Code task in a project. Returns `job_id` immediately. |
| `claude_get_task_status` | Poll for output and status. Call every 3-5s until `completed` or `failed`. |
| `claude_list_tasks` | List all tracked jobs, optionally filtered by status. |
| `claude_cancel_task` | Send SIGTERM to a running job. |
| `claude_list_projects` | List directories in ~/Projects/. |

## How it works

Tasks run as Claude Code subprocesses with `--dangerously-skip-permissions`. Output from stdout and stderr is buffered in memory and returned on each `claude_get_task_status` poll. Jobs expire after 24 hours.

## Update

Re-run the install script — it pulls the latest and rebuilds.
