import type { AgentEvent, ParseContext, ParseResult, Session, SubagentLink, TodoSnapshot } from "./types";
import { promptHead, str } from "./util";

/**
 * In-memory store with the same semantics as the desktop SQLite store. Used by tests and replays;
 * the desktop store has a parity test against it.
 */
export function createMemoryStore() {
  const events = new Map<string, AgentEvent>();
  const callIndex = new Map<string, string>(); // sid|toolUseId -> source_uuid
  const todos = new Map<string, TodoSnapshot>();
  const links = new Map<string, SubagentLink>();
  const sessions = new Map<string, Session>();
  const tokenMsgs = new Set<string>();

  const isCall = (e: AgentEvent) => e.event_type === "tool_call" || e.event_type === "subagent_spawn";
  const linkedTids = () => new Set([...links.values()].map((l) => l.session_id + "|" + l.tool_use_id));

  const ctx: ParseContext = {
    getCall(sid, tid) {
      const id = callIndex.get(sid + "|" + tid);
      return id ? events.get(id) : undefined;
    },
    findSpawnByPrompt(sid, head) {
      const linked = linkedTids();
      return [...events.values()].find(
        (e) =>
          e.session_id === sid &&
          e.event_type === "subagent_spawn" &&
          !linked.has(sid + "|" + e.tool_use_id) &&
          promptHead(str(e.payload.input?.prompt)) === head,
      );
    },
    getLink: (sid, aid) => links.get(sid + "|" + aid),
    runningCalls: (sid) =>
      [...events.values()].filter((e) => e.session_id === sid && isCall(e) && e.status === "running"),
    messageHasTokens: (sid, mid) => tokenMsgs.has(sid + "|" + mid),
    getNotification: (sid, tid) =>
      [...events.values()].find(
        (e) => e.session_id === sid && e.tool_use_id === tid && e.source_uuid.startsWith("notify:"),
      ),
  };

  function apply(r: ParseResult): number {
    let inserted = 0;
    for (const e of r.events) {
      if (events.has(e.source_uuid)) continue;
      const row = { ...e, payload: { ...e.payload } };
      events.set(e.source_uuid, row);
      inserted++;
      if (isCall(row) && row.tool_use_id) callIndex.set(row.session_id + "|" + row.tool_use_id, row.source_uuid);
      if (row.message_id && row.input_tokens != null) tokenMsgs.add(row.session_id + "|" + row.message_id);
      const s = sessions.get(row.session_id);
      if (s) {
        s.event_count++;
        s.total_input_tokens += row.input_tokens ?? 0;
        s.total_output_tokens += row.output_tokens ?? 0;
      }
    }
    for (const u of r.updates) {
      const cur = events.get(u.source_uuid);
      if (cur)
        Object.assign(cur, {
          status: u.status,
          ended_at: u.ended_at,
          duration_ms: u.duration_ms,
          payload: { ...u.payload },
        });
    }
    for (const l of r.subagentLinks) {
      const k = l.session_id + "|" + l.agent_id;
      if (!links.has(k)) links.set(k, l);
    }
    for (const t of r.todoSnapshots) if (!todos.has(t.source_uuid)) todos.set(t.source_uuid, { ...t });
    for (const rl of r.relinks) {
      for (const row of [...events.values(), ...todos.values()]) {
        if (row.session_id === rl.session_id && row.agent_id === rl.agent_id) {
          row.agent_key = rl.agent_key;
          row.agent_name = rl.agent_name;
        }
      }
    }
    for (const m of r.sessionUpdates) {
      const s = sessions.get(m.id);
      if (!s) {
        // Counts were added above only for existing sessions; recount for a new one.
        const rows = [...events.values()].filter((e) => e.session_id === m.id);
        sessions.set(m.id, {
          ...m,
          event_count: rows.length,
          total_input_tokens: rows.reduce((a, e) => a + (e.input_tokens ?? 0), 0),
          total_output_tokens: rows.reduce((a, e) => a + (e.output_tokens ?? 0), 0),
        });
      } else {
        s.project_path ??= m.project_path;
        s.git_branch = m.git_branch ?? s.git_branch;
        s.model = m.model ?? s.model;
        s.started_at = Math.min(s.started_at, m.started_at);
        s.last_event_at = Math.max(s.last_event_at, m.last_event_at);
      }
    }
    return inserted;
  }

  const byTime = <T extends { created_at: number }>(a: T, b: T) => a.created_at - b.created_at;
  return {
    ctx,
    apply,
    events: (sid?: string) => [...events.values()].filter((e) => !sid || e.session_id === sid).sort(byTime),
    todos: (sid?: string) => [...todos.values()].filter((t) => !sid || t.session_id === sid).sort(byTime),
    links: () => [...links.values()],
    sessions: () => [...sessions.values()],
  };
}

export type MemoryStore = ReturnType<typeof createMemoryStore>;
