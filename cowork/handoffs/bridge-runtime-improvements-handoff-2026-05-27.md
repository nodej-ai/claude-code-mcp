# Bridge Runtime Improvements — Handoff 2026-05-27

## Context

`~/Projects/claude-code-mcp` is the local MCP server that lets Cowork run Claude Code tasks
(spawn `claude --print ...`, poll for output, cancel). A post-upgrade audit (2026-05-27) identified
runtime, feature, and security gaps. F16 (trust model), F18 (env config), and five one-liner bugs
have already been fixed in this session. This handoff covers the remaining items.

Already done — do NOT redo:
- F16: replaced `--dangerously-skip-permissions` with `--permission-mode dontAsk --add-dir ~/Projects/`
- F18: .env resolution now tries CLAUDE_CODE_MCP_ENV → package root .env → legacy path
- F6: stdout buffer flushed on `end` event
- F8: `close` handler guards against overwriting cancelled status
- F9: `setInterval(purgeOldJobs, 60 * 60 * 1000)` added to `main()`
- F11: Supabase startup wrapped in try/catch
- F22: stderr prefixed with `[stderr] `
- F3: `.nvmrc` added (Node 22.22.0)

Source: `src/index.ts` — single-file TypeScript server, 720 lines after current fixes.
Build: `npm run build` → `dist/index.js`.

---

## Items to implement

### F5 — Output string unbounded growth (Medium)
**File:** `src/index.ts`
**Problem:** `job.output` is append-only with no ceiling. Long or verbose tasks accumulate megabytes
in-process. The Supabase write already truncates to 10,000 chars but the in-memory string is never
capped — with concurrent jobs and a 24h TTL this can grow materially.
**Fix:** Cap `job.output` at 512KB when appending. Add a truncation notice when the cap is hit.
```typescript
const OUTPUT_CAP = 512 * 1024;
// In the stdout data handler, replace: job.output += b.text
if (job.output.length < OUTPUT_CAP) {
  job.output += b.text;
} else if (!job.output.endsWith("[output truncated at 512KB]")) {
  job.output += "\n[output truncated at 512KB]";
}
// Apply the same guard in the stderr handler and the raw-line fallback.
```

### F7 — SIGTERM not followed by SIGKILL (Low)
**File:** `src/index.ts`, `claude_cancel_task` handler (~line 591)
**Problem:** Cancel sends SIGTERM but never escalates. A hung Claude Code process becomes an orphan
with no way to detect or kill it.
**Fix:** After `child.kill("SIGTERM")`, set a 5-second timeout that sends SIGKILL if the process
is still in `processes`:
```typescript
child.kill("SIGTERM");
setTimeout(() => {
  const proc = processes.get(job_id);
  if (proc && !proc.killed) {
    proc.kill("SIGKILL");
    console.error(`[bridge] SIGKILL sent to orphaned process for job ${job_id}`);
  }
}, 5000);
```

### F10 — No concurrent job limit (Medium)
**File:** `src/index.ts`, `claude_run_task` handler, before spawn (~line 285)
**Problem:** No cap on simultaneous Claude Code subprocesses. Each is resource-heavy; five concurrent
tasks can noticeably impact the host machine.
**Fix:** Add a `MAX_CONCURRENT_JOBS = 3` constant and reject if exceeded:
```typescript
const MAX_CONCURRENT_JOBS = 3;
const runningCount = [...jobs.values()].filter(j => j.status === "running").length;
if (runningCount >= MAX_CONCURRENT_JOBS) {
  return { content: [{ type: "text", text: `Error: concurrent job limit (${MAX_CONCURRENT_JOBS}) reached. Wait for a running job to finish or cancel one.` }], isError: true };
}
```

### F20 — Full output string resent on every poll (Medium)
**File:** `src/index.ts`, `claude_get_task_status` handler and `Job` interface
**Problem:** Callers must poll every 3-5s and receive the entire `job.output` on each call. For
long tasks this means repeatedly transferring growing strings.
**Fix:** Add an optional `output_offset` integer to `claude_get_task_status`. Return only
`job.output.slice(offset)` and include `next_offset` in the response so the caller can advance.
- Add `output_offset?: number` to the inputSchema (optional, default 0)
- Return `output: job.output.slice(offset)` and `next_offset: job.output.length`
- Update the tool description to document the offset pattern

### F21 — No task timeout (Medium)
**File:** `src/index.ts`, `claude_run_task` handler, after spawn
**Problem:** A hung Claude Code process runs indefinitely, holding a process slot and accumulating
output until the 24h TTL removes the job record (but not the process — it becomes an orphan since
`processes.delete` only happens on `close` or cancel).
**Fix:** Add `TASK_TIMEOUT_MS = 30 * 60 * 1000` (30 min) and a timeout at spawn time:
```typescript
const timeoutHandle = setTimeout(() => {
  const proc = processes.get(jobId);
  if (proc) {
    proc.kill("SIGKILL");
    job.status = "failed";
    job.output += "\n[Task timed out after 30 minutes]";
    job.completedAt = new Date().toISOString();
    processes.delete(jobId);
  }
}, TASK_TIMEOUT_MS);

// In the close handler, add: clearTimeout(timeoutHandle);
```

### F1 — No linter (Low)
**Fix:** Add ESLint with TypeScript support.
```bash
npm install -D eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin
```
Create `eslint.config.mjs` with `@typescript-eslint/recommended` rules. Add `"lint": "eslint src/"` to
package.json scripts.

### F2 — No typecheck script (Low)
**Fix:** One-liner — add to package.json scripts:
```json
"typecheck": "tsc --noEmit"
```

### F13 — @types/node behind (Low)
**Fix:** `npm install -D @types/node@22` to stay pinned to the Node 22 major line
(matches the .nvmrc now at 22.22.0).

---

## Rebuild and restart

After each change:
```bash
cd ~/Projects/claude-code-mcp && npm run build
pkill -f 'claude-code-mcp/dist/index.js'
```
The Cowork desktop app restarts the bridge automatically.

## Test

After F10 (concurrency limit):
- Verify `claude_run_task` rejects when 3 jobs are already running.

After F20 (output offset):
- Start a long task, poll with `output_offset: 0`, confirm `next_offset` advances, poll again
  with `output_offset: <next_offset>`, confirm only new content is returned.

After F21 (timeout):
- Difficult to test without a deliberately hung task. Confirm `timeoutHandle` is cleared in the
  close handler to avoid node process keeping alive.
