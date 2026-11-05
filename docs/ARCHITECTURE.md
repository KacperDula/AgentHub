# Architecture

AgentTrace Desktop shows live what Claude Code agents, subagents and background tasks are doing. Everything runs on the
user's machine; there is no AgentTrace server.

```
Claude Code logs (~/.claude/projects/**/*.jsonl)
        │  new complete lines only (offsets in SQLite)
        ▼
Watcher (apps/desktop/src/main/watcher.ts) ──► parseLines (packages/core) ──► SQLite (better-sqlite3, WAL)
                                                                                 │
                         Insights runner (rules every 15 min / on session end) ◄─┤
                         AI provider (only on "Analyze", user's own model)       │
                                                                                 ▼
                                             Local server :8787 (read-only JSON API + SSE + built UI)
                                                  │                         │
                                       App window (Electron)       Browser elsewhere (LAN / Tailscale,
                                       + IPC for settings           token → HttpOnly cookie, read-only)
```

Data leaves the machine only through two doors, both opened by the user: remote viewing (read-only) and the AI
provider (only the summary shown in the "What will be sent" preview).

## Packages

| Path            | What                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `packages/core` | Pure TypeScript, no Node/DOM/React imports (enforced by ESLint): parser, Live Map model, insights. |
| `packages/ui`   | React + Vite + @xyflow/react + dagre. Loaded in the app window and in any browser.                |
| `apps/desktop`  | Electron (electron-vite): watcher, SQLite store, HTTP server, tray, IPC, insights runner, updater. |
| `fixtures/anon` | Anonymized transcripts for tests (`npm run anonymize`). Real logs (`fixtures/raw`) are git-ignored. |

## Core

- `parseLines(lines, ctx)` turns raw transcript lines into rows. It is pure: whatever earlier batches stored comes
  through `ctx` (`ParseContext`), and everything new or changed is returned (`events`, `updates`, `todoSnapshots`,
  `subagentLinks`, `relinks`, `sessionUpdates`). Rules:
  - one event per content block, `source_uuid = uuid + ":" + index` (or a hash of the line);
  - token usage once per `message.id` (`input = input_tokens + cache_creation_input_tokens`);
  - subagents: `isSidechain` or `/subagents/` in the path; linked to the spawning `Agent`/`Task` call by their first
    prompt or by `toolUseResult.agentId`, with earlier events moved to the new key;
  - background launches (`toolUseResult.isAsync` / `backgroundTaskId`) stay running until their `<task-notification>`
    (parsed field by field, no closing tag required) or a `TaskStop`;
  - a notice read before its call (backfill reads the main transcript before subagents') still closes the call.
- `buildTree(events, todos, now, { asOf, expanded, subagentAverages })` returns the Live Map model: cards (prompt →
  main agent → subagents → tools → resources), states, badges, progress, ETA, the "Running now" list, folding of
  finished subagents, and replay via `asOf`.
- `createMemoryStore()` has the same semantics as the SQLite store; a desktop test checks they stay identical.
- `insights.ts`: per-session signals, an aggregate usage profile, and the AI payload/prompt builders.
- `prompts.ts`: the prompt coach (rule-based review of each prompt the user typed, with what happened next) and
  subagent advice (`subagent-*` signals with a copyable fix).
- `recap.ts`: the Explain page's turn-by-turn recap of a session, and the AI explanation payload/prompt.

## Desktop

- **Watcher**: watches `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`) and an optional extra folder, reads only
  new bytes, keeps `user` / `assistant` / `system` lines and `queue-operation` enqueue lines with a
  `<task-notification>`, trims strings to 2,000 characters, sorts each batch by timestamp, and stores offsets in the same
  transaction as the rows. Files never seen before are backfilled when modified within the last 24 hours (configurable).
- **Store**: `sessions`, `agent_events`, `todo_snapshots`, `subagents`, `file_offsets`, `settings`, plus
  `insight_signals`, `session_profiles` (aggregates only), `suggestions`, `prompt_reviews` and `explanations`.
  Retention deletes old sessions.
- **Notes** (`notes.ts`): one folder per user under `Documents/AgentTrace/Notes`, read and written only through IPC
  (never served over HTTP). Its text, and the AI-written `_learnings.md`, are added to AI payloads when the user allows it.
- **Server**: `127.0.0.1:8787` by default (next free port if taken). GET-only JSON API, SSE stream and the built UI. The
  only non-GET route is `POST /login`; a test fails if another one is added. With remote viewing off, requests must carry
  a localhost `Host` header (DNS-rebinding guard). With it on, every request needs a session cookie obtained by
  exchanging the access token (rate-limited); "Revoke all browsers" rotates the token and drops all sessions.
- **Window and IPC**: one window that loads the local server, sandboxed, with a preload exposing an allow-listed
  `invoke()` for settings, demo, remote viewing and AI. Only the app window can change anything.
- **Secrets**: API keys and the access token are encrypted with Electron `safeStorage` (OS keychain) in their own file,
  never in SQLite or logs.
- **Packaging**: electron-builder (`.dmg` universal, NSIS x64/arm64, AppImage, `.deb`), electron-updater with GitHub
  Releases. better-sqlite3 ships N-API prebuilds for every platform, so nothing is compiled at install or package time.

## Testing

`npm test` runs Vitest for all three packages: parser rules on synthetic lines and the demo, Live Map states/ETA/folding/
replay, insights, the SQLite store's parity with the memory store, the server's read-only and auth rules, and the
watcher's restart behaviour. `AGENTTRACE_FIXTURES=~/.claude/projects npx vitest run packages/core/test/fixtures.test.ts`
replays your own logs in place (read-only) and checks that background work shown as running matches the raw logs.
