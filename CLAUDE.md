# claude-code-mcp

## Location
**Canonical path:** `~/Projects/claude-code-mcp`
**GitHub repo:** `nodej-ai/claude-code-mcp` (transferred from juliantang/ on 2026-05-27)
**Install:** `curl -fsSL https://raw.githubusercontent.com/nodej-ai/claude-code-mcp/main/install.sh | bash`

## Purpose
Local stdio MCP server (TypeScript, Node.js ≥22) exposing 5 tools for spawning and managing `claude` CLI subprocesses as async jobs. Cowork uses this to dispatch implementation work to Engineering (Claude Code) without a manual context-switch.

## Status
**LIVE and in production.** Phase 1 complete as of 2026-05-20. Runtime audit complete 2026-05-27 (23 fixes across 4 rounds).

## Architecture
- Single entry point: `src/index.ts` (~880 lines)
- Spawns `claude --print --verbose --output-format stream-json` subprocesses
- In-memory job tracking: `Map<string, Job>` + `Map<string, ChildProcess>` + `Map<string, ReturnType<typeof setTimeout>>`
- Optional Supabase integration: writes to `memory.dispatcher_jobs` (requires `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`)
- stdio transport: stdout is JSON-RPC channel — `console.log = console.error` guard at entry file top

## Tools
- `claude_run_task(project, task, context_file?)` — spawns Claude Code, returns job_id
- `claude_get_task_status(job_id, output_offset?)` — incremental polling, returns output slice + next_offset
- `claude_list_tasks(status?)` — lists tracked jobs (includes task_id)
- `claude_cancel_task(job_id)` — SIGTERM + 5s SIGKILL escalation
- `claude_list_projects()` — lists ~/Projects/* directories

## Build
```bash
npm install
npm run build       # tsc → dist/
npm run typecheck   # tsc --noEmit
npm run lint        # eslint src/
```

## Key Constraints
- `MAX_CONCURRENT_JOBS=3` — concurrency gate
- `OUTPUT_CAP=512KB` — truncation ceiling with notice
- `TASK_TIMEOUT_MS=30min` — SIGKILL on timeout (stored in `timeouts` Map for cancel access)
- Project paths restricted to `~/Projects/` — directory traversal blocked
- dotenv loaded with `quiet: true` — prevents v17+ stdout pollution (see [[dotenv-quiet-for-stdio-servers]])
- Cancel uses `child.exitCode === null` predicate for SIGKILL escalation (NOT `child.killed`)

## Desktop Config
```json
"claude-code-bridge": {
  "command": "node",
  "args": ["/Users/juliantang/Projects/claude-code-mcp/dist/index.js"]
}
```

## Cowork vs Claude Code
- **Cowork** writes specs, dispatches tasks, polls status
- **Claude Code** implements features, commits, pushes
