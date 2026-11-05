import { buildDemoScript, createMemoryStore, parseLines, stampDemo, type RawLine } from "../src";

export const T0 = Date.parse("2026-11-04T12:00:00Z");

/** Feeds lines through parseLines + a memory store, in batches of `batch` (incremental processing). */
export function ingest(lines: RawLine[], batch = 200, store = createMemoryStore()) {
  let inserted = 0;
  let skipped = 0;
  for (let i = 0; i < lines.length; i += batch) {
    const r = parseLines(lines.slice(i, i + batch), store.ctx);
    inserted += store.apply(r);
    skipped += r.skipped;
  }
  return { store, inserted, skipped };
}

export function demoLines(sessionId = "demo-1") {
  return stampDemo(buildDemoScript(sessionId), T0);
}

let n = 0;
/** Tiny builders for raw transcript lines. */
export const raw = {
  file: (sid: string, agentId?: string) =>
    agentId ? `/p/-proj/${sid}/subagents/agent-${agentId}.jsonl` : `/p/-proj/${sid}.jsonl`,
  line(sid: string, type: string, ts: number, extra: Record<string, unknown> = {}) {
    return {
      type,
      sessionId: sid,
      uuid: `u-${++n}`,
      parentUuid: `p-${n}`,
      timestamp: new Date(ts).toISOString(),
      cwd: "/w/app",
      ...extra,
    };
  },
  call(sid: string, ts: number, id: string, name: string, input: Record<string, unknown>, extra = {}) {
    return raw.line(sid, "assistant", ts, {
      message: {
        id: `msg-${id}`,
        model: "claude-opus-5-5",
        content: [{ type: "tool_use", id, name, input }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      ...extra,
    });
  },
  result(sid: string, ts: number, id: string, content: string, toolUseResult?: unknown, isError = false, extra = {}) {
    return raw.line(sid, "user", ts, {
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
      ...(toolUseResult ? { toolUseResult } : {}),
      ...extra,
    });
  },
  notify(sid: string, ts: number, taskId: string, toolUseId: string, status = "completed", closeTag = true) {
    const body = `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>Agent "x" ${status}</summary>`;
    return {
      type: "queue-operation",
      operation: "enqueue",
      sessionId: sid,
      timestamp: new Date(ts).toISOString(),
      content: closeTag ? body + "</task-notification>" : body,
    };
  },
};
