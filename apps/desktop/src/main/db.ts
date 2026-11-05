import Database from "better-sqlite3";
import {
  emptyProfile,
  mergeProfiles,
  promptHead,
  promptStats,
  type PromptReview,
  type PromptStats,
  type Signal,
  type Suggestion,
  type UsageProfile,
  type Vote,
  type AgentEvent,
  type ParseContext,
  type ParseResult,
  type Session,
  type SubagentLink,
  type TodoSnapshot,
} from "@agenttrace/core";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, project_path TEXT, git_branch TEXT, model TEXT,
  started_at INTEGER NOT NULL, last_event_at INTEGER NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0, total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0, is_demo INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agent_events (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, source_uuid TEXT NOT NULL UNIQUE, parent_uuid TEXT,
  agent_name TEXT, agent_key TEXT, agent_id TEXT, is_subagent INTEGER NOT NULL DEFAULT 0, event_type TEXT NOT NULL,
  tool_name TEXT, tool_use_id TEXT, status TEXT, summary TEXT, payload TEXT,
  input_tokens INTEGER, output_tokens INTEGER, message_id TEXT,
  created_at INTEGER NOT NULL, ended_at INTEGER, duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS ev_session_time ON agent_events(session_id, created_at);
CREATE INDEX IF NOT EXISTS ev_tool_use ON agent_events(session_id, tool_use_id);
CREATE INDEX IF NOT EXISTS ev_agent ON agent_events(session_id, agent_id);
CREATE INDEX IF NOT EXISTS ev_message ON agent_events(session_id, message_id);
CREATE INDEX IF NOT EXISTS ev_type ON agent_events(session_id, event_type, created_at);
CREATE INDEX IF NOT EXISTS ev_status ON agent_events(session_id, status);
CREATE TABLE IF NOT EXISTS todo_snapshots (
  id INTEGER PRIMARY KEY, source_uuid TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL, agent_name TEXT,
  agent_key TEXT, agent_id TEXT, todos TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS todo_session ON todo_snapshots(session_id, agent_key, created_at);
CREATE TABLE IF NOT EXISTS subagents (
  session_id TEXT NOT NULL, agent_id TEXT NOT NULL, tool_use_id TEXT NOT NULL, name TEXT,
  PRIMARY KEY (session_id, agent_id)
);
CREATE TABLE IF NOT EXISTS file_offsets (file TEXT PRIMARY KEY, offset INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS insight_signals (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT, severity TEXT, title TEXT, detail TEXT,
  numbers TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session_profiles (session_id TEXT PRIMARY KEY, profile TEXT NOT NULL, analyzed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY, scope TEXT NOT NULL, session_id TEXT, severity TEXT, title TEXT, why TEXT,
  fix_kind TEXT, fix TEXT, vote INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS prompt_reviews (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, created_at INTEGER NOT NULL, text TEXT, words INTEGER,
  severity TEXT, issues TEXT NOT NULL, outcome TEXT NOT NULL, better TEXT
);
CREATE INDEX IF NOT EXISTS pr_session ON prompt_reviews(session_id);
CREATE INDEX IF NOT EXISTS pr_time ON prompt_reviews(created_at);
CREATE TABLE IF NOT EXISTS explanations (session_id TEXT PRIMARY KEY, text TEXT NOT NULL, created_at INTEGER NOT NULL);
`;

/** Per-session tables, cleared together with their session. */
const SESSION_TABLES = [
  "agent_events",
  "todo_snapshots",
  "subagents",
  "insight_signals",
  "session_profiles",
  "suggestions",
  "prompt_reviews",
  "explanations",
];

const toReview = (r: any): PromptReview => ({
  ...r,
  issues: JSON.parse(r.issues),
  outcome: JSON.parse(r.outcome),
});

const COLS = [
  "session_id",
  "source_uuid",
  "parent_uuid",
  "agent_name",
  "agent_key",
  "agent_id",
  "is_subagent",
  "event_type",
  "tool_name",
  "tool_use_id",
  "status",
  "summary",
  "payload",
  "input_tokens",
  "output_tokens",
  "message_id",
  "created_at",
  "ended_at",
  "duration_ms",
];

export interface Changes {
  sessions: Session[];
  events: AgentEvent[];
  todos: TodoSnapshot[];
  relinked: string[];
}

const toEvent = (r: any): AgentEvent => {
  const { id: _id, ...rest } = r;
  return { ...rest, is_subagent: !!r.is_subagent, payload: r.payload ? JSON.parse(r.payload) : {} };
};
const toTodo = (r: any): TodoSnapshot => {
  const { id: _id, ...rest } = r;
  return { ...rest, todos: JSON.parse(r.todos) };
};
const toSession = (r: any): Session => ({ ...r, is_demo: !!r.is_demo });
const eventRow = (e: AgentEvent) => ({
  ...e,
  is_subagent: e.is_subagent ? 1 : 0,
  payload: JSON.stringify(e.payload ?? {}),
});

export function openStore(file: string) {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);
  // Columns added after the first release.
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  if (!cols("insight_signals").includes("fix")) db.exec("ALTER TABLE insight_signals ADD COLUMN fix TEXT");

  const q = {
    getCall: db.prepare(
      "SELECT * FROM agent_events WHERE session_id = ? AND tool_use_id = ? AND event_type IN ('tool_call','subagent_spawn') LIMIT 1",
    ),
    unlinkedSpawns: db.prepare(
      `SELECT e.* FROM agent_events e WHERE e.session_id = ? AND e.event_type = 'subagent_spawn'
       AND NOT EXISTS (SELECT 1 FROM subagents s WHERE s.session_id = e.session_id AND s.tool_use_id = e.tool_use_id)
       ORDER BY e.created_at`,
    ),
    getLink: db.prepare("SELECT * FROM subagents WHERE session_id = ? AND agent_id = ?"),
    running: db.prepare(
      "SELECT * FROM agent_events WHERE session_id = ? AND status = 'running' AND event_type IN ('tool_call','subagent_spawn')",
    ),
    hasTokens: db.prepare(
      "SELECT 1 FROM agent_events WHERE session_id = ? AND message_id = ? AND input_tokens IS NOT NULL LIMIT 1",
    ),
    notification: db.prepare(
      "SELECT * FROM agent_events WHERE session_id = ? AND tool_use_id = ? AND source_uuid LIKE 'notify:%' LIMIT 1",
    ),
    insEvent: db.prepare(
      `INSERT OR IGNORE INTO agent_events (${COLS.join(",")}) VALUES (${COLS.map((c) => "@" + c).join(",")})`,
    ),
    updEvent: db.prepare(
      "UPDATE agent_events SET status = @status, ended_at = @ended_at, duration_ms = @duration_ms, payload = @payload WHERE source_uuid = @source_uuid",
    ),
    eventByUuid: db.prepare("SELECT * FROM agent_events WHERE source_uuid = ?"),
    insLink: db.prepare(
      "INSERT OR IGNORE INTO subagents (session_id, agent_id, tool_use_id, name) VALUES (@session_id, @agent_id, @tool_use_id, @name)",
    ),
    insTodo: db.prepare(
      `INSERT OR IGNORE INTO todo_snapshots (source_uuid, session_id, agent_name, agent_key, agent_id, todos, created_at)
       VALUES (@source_uuid, @session_id, @agent_name, @agent_key, @agent_id, @todos, @created_at)`,
    ),
    relinkEvents: db.prepare(
      "UPDATE agent_events SET agent_key = ?, agent_name = ? WHERE session_id = ? AND agent_id = ?",
    ),
    relinkTodos: db.prepare(
      "UPDATE todo_snapshots SET agent_key = ?, agent_name = ? WHERE session_id = ? AND agent_id = ?",
    ),
    upsertSession: db.prepare(
      `INSERT INTO sessions (id, project_path, git_branch, model, started_at, last_event_at)
       VALUES (@id, @project_path, @git_branch, @model, @started_at, @last_event_at)
       ON CONFLICT(id) DO UPDATE SET
         project_path = COALESCE(sessions.project_path, excluded.project_path),
         git_branch = COALESCE(excluded.git_branch, sessions.git_branch),
         model = COALESCE(excluded.model, sessions.model),
         started_at = MIN(sessions.started_at, excluded.started_at),
         last_event_at = MAX(sessions.last_event_at, excluded.last_event_at)`,
    ),
    bumpSession: db.prepare(
      "UPDATE sessions SET event_count = event_count + 1, total_input_tokens = total_input_tokens + ?, total_output_tokens = total_output_tokens + ? WHERE id = ?",
    ),
    session: db.prepare("SELECT * FROM sessions WHERE id = ?"),
    sessions: db.prepare("SELECT * FROM sessions ORDER BY last_event_at DESC"),
    mainPlans: db.prepare(
      `SELECT t.session_id, t.todos FROM todo_snapshots t
       WHERE t.agent_key = 'main' AND t.created_at = (SELECT MAX(created_at) FROM todo_snapshots WHERE session_id = t.session_id AND agent_key = 'main')`,
    ),
    events: db.prepare(
      "SELECT * FROM (SELECT * FROM agent_events WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?) ORDER BY created_at, id",
    ),
    todos: db.prepare("SELECT * FROM todo_snapshots WHERE session_id = ? ORDER BY created_at, id"),
    getOffset: db.prepare("SELECT offset FROM file_offsets WHERE file = ?"),
    setOffset: db.prepare(
      "INSERT INTO file_offsets (file, offset) VALUES (?, ?) ON CONFLICT(file) DO UPDATE SET offset = excluded.offset",
    ),
    getSetting: db.prepare("SELECT value FROM settings WHERE key = ?"),
    setSetting: db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ),
    markDemo: db.prepare(
      "INSERT INTO sessions (id, started_at, last_event_at, is_demo) VALUES (?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET is_demo = 1",
    ),
  };

  const ctx: ParseContext = {
    getCall: (sid, tid) => {
      const r = q.getCall.get(sid, tid);
      return r ? toEvent(r) : undefined;
    },
    findSpawnByPrompt: (sid, head) =>
      q.unlinkedSpawns
        .all(sid)
        .map(toEvent)
        .find((e) => promptHead(String(e.payload.input?.prompt ?? "")) === head),
    getLink: (sid, aid) => (q.getLink.get(sid, aid) as SubagentLink | undefined) ?? undefined,
    runningCalls: (sid) => q.running.all(sid).map(toEvent),
    messageHasTokens: (sid, mid) => !!q.hasTokens.get(sid, mid),
    getNotification: (sid, tid) => {
      const r = q.notification.get(sid, tid);
      return r ? toEvent(r) : undefined;
    },
  };

  /** Writes one parse result (and the file offsets it covers) atomically. */
  const apply: (r: ParseResult, offsets?: Map<string, number>) => Changes = db.transaction(
    (r: ParseResult, offsets?: Map<string, number>): Changes => {
      for (const s of r.sessionUpdates) q.upsertSession.run(s);
      const events: AgentEvent[] = [];
      for (const e of r.events) {
        if (q.insEvent.run(eventRow(e)).changes) {
          events.push(e);
          q.bumpSession.run(e.input_tokens ?? 0, e.output_tokens ?? 0, e.session_id);
        }
      }
      for (const u of r.updates) {
        q.updEvent.run({ ...u, payload: JSON.stringify(u.payload) });
        const row = q.eventByUuid.get(u.source_uuid);
        if (row) events.push(toEvent(row));
      }
      for (const l of r.subagentLinks) q.insLink.run(l);
      const todos: TodoSnapshot[] = [];
      for (const t of r.todoSnapshots)
        if (q.insTodo.run({ ...t, todos: JSON.stringify(t.todos) }).changes) todos.push(t);
      const relinked = new Set<string>();
      for (const rl of r.relinks) {
        q.relinkEvents.run(rl.agent_key, rl.agent_name, rl.session_id, rl.agent_id);
        q.relinkTodos.run(rl.agent_key, rl.agent_name, rl.session_id, rl.agent_id);
        relinked.add(rl.session_id);
      }
      for (const [f, o] of offsets ?? []) q.setOffset.run(f, o);
      const sids = new Set([...r.sessionUpdates.map((s) => s.id), ...events.map((e) => e.session_id)]);
      const sessions = [...sids]
        .map((id) => q.session.get(id))
        .filter(Boolean)
        .map(toSession);
      return { sessions, events, todos, relinked: [...relinked] };
    },
  );

  const getSetting = <T>(key: string, fallback: T): T => {
    const r = q.getSetting.get(key) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as T) : fallback;
  };

  const deleteSessions: (ids: string[]) => void = db.transaction((ids: string[]) => {
    for (const t of SESSION_TABLES)
      db.prepare(`DELETE FROM ${t} WHERE session_id IN (SELECT value FROM json_each(?))`).run(JSON.stringify(ids));
    db.prepare("DELETE FROM sessions WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(ids));
  });

  return {
    ctx,
    apply,
    getSetting,
    setSetting: (key: string, value: unknown) => q.setSetting.run(key, JSON.stringify(value)),
    getOffset: (file: string) => (q.getOffset.get(file) as { offset: number } | undefined)?.offset,
    session: (id: string) => {
      const r = q.session.get(id);
      return r ? toSession(r) : undefined;
    },
    sessions(): (Session & { plan_progress: number | null })[] {
      const plans = new Map(
        (q.mainPlans.all() as { session_id: string; todos: string }[]).map((p) => {
          const todos = JSON.parse(p.todos) as { status: string }[];
          const done = todos.filter((t) => t.status === "completed").length;
          const doing = todos.filter((t) => t.status === "in_progress").length;
          return [p.session_id, todos.length ? (done + 0.5 * doing) / todos.length : null];
        }),
      );
      return q.sessions.all().map((r) => ({ ...toSession(r), plan_progress: plans.get((r as any).id) ?? null }));
    },
    events: (sid: string, limit = 5000) => q.events.all(sid, limit).map(toEvent),
    /** Every prompt typed into a session's main agent, oldest first (for its prompt card). */
    prompts: (sid: string) =>
      db
        .prepare(
          "SELECT * FROM agent_events WHERE session_id = ? AND event_type = 'user_prompt' AND is_subagent = 0 ORDER BY created_at, id LIMIT 2000",
        )
        .all(sid)
        .map(toEvent),
    todos: (sid: string) => q.todos.all(sid).map(toTodo),
    sessionIds: (sinceMs = 0) =>
      (
        db.prepare("SELECT id FROM sessions WHERE last_event_at >= ? ORDER BY last_event_at").all(sinceMs) as {
          id: string;
        }[]
      ).map((r) => r.id),
    /** Spans of subagents across all sessions, for the no-plan ETA (first to last event, by name). */
    subagentAverages(now: number): Record<string, number> {
      const rows = db
        .prepare(
          `SELECT agent_name AS name, AVG(span) AS avg FROM (
             SELECT agent_name, MAX(created_at) - MIN(created_at) AS span, MAX(created_at) AS last
             FROM agent_events WHERE is_subagent = 1 AND agent_key NOT LIKE 'agent:%'
             GROUP BY session_id, agent_key)
           WHERE last < ? AND span > 0 GROUP BY agent_name`,
        )
        .all(now - 120_000) as { name: string; avg: number }[];
      return Object.fromEntries(rows.map((r) => [r.name, r.avg]));
    },
    markDemo: (sid: string, now: number) => q.markDemo.run(sid, now, now),
    demoSessionIds: () =>
      (db.prepare("SELECT id FROM sessions WHERE is_demo = 1").all() as { id: string }[]).map((r) => r.id),
    deleteSessions,
    /** Retention: drops sessions idle for longer than `days`, and older events of the rest. */
    retain(days: number, now: number) {
      const cutoff = now - days * 86_400_000;
      const old = (db.prepare("SELECT id FROM sessions WHERE last_event_at < ?").all(cutoff) as { id: string }[]).map(
        (r) => r.id,
      );
      if (old.length) deleteSessions(old);
      db.prepare("DELETE FROM agent_events WHERE created_at < ?").run(cutoff);
      db.prepare("DELETE FROM todo_snapshots WHERE created_at < ?").run(cutoff);
      return old.length;
    },
    /** Deletes everything collected. File offsets stay, so old logs are not imported again. */
    deleteAll() {
      db.transaction(() => {
        for (const t of [...SESSION_TABLES, "sessions"]) db.prepare(`DELETE FROM ${t}`).run();
      })();
      db.exec("VACUUM"); // really remove the data from the file
    },
    // ---- insights ----
    /** Sessions whose events changed since they were last analyzed; `idleOnly` = only ones quiet for 2+ min. */
    staleSessions(now: number, idleOnly: boolean): string[] {
      return (
        db
          .prepare(
            `SELECT s.id FROM sessions s LEFT JOIN session_profiles p ON p.session_id = s.id
             WHERE (p.analyzed_at IS NULL OR p.analyzed_at < s.last_event_at) AND (? = 0 OR s.last_event_at < ?)`,
          )
          .all(idleOnly ? 1 : 0, now - 120_000) as { id: string }[]
      ).map((r) => r.id);
    },
    saveSessionInsights: db.transaction(
      (sid: string, signals: Signal[], profile: UsageProfile, now: number, reviews: PromptReview[] = []) => {
        db.prepare("DELETE FROM insight_signals WHERE session_id = ?").run(sid);
        const ins = db.prepare(
          "INSERT OR REPLACE INTO insight_signals (id, session_id, kind, severity, title, detail, numbers, fix, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        for (const g of signals)
          ins.run(g.id, sid, g.kind, g.severity, g.title, g.detail, JSON.stringify(g.numbers), g.fix ?? null, now);
        db.prepare(
          "INSERT INTO session_profiles (session_id, profile, analyzed_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET profile = excluded.profile, analyzed_at = excluded.analyzed_at",
        ).run(sid, JSON.stringify(profile), now);
        db.prepare("DELETE FROM prompt_reviews WHERE session_id = ?").run(sid);
        const insReview = db.prepare(
          `INSERT OR REPLACE INTO prompt_reviews (id, session_id, created_at, text, words, severity, issues, outcome, better)
           VALUES (@id, @session_id, @created_at, @text, @words, @severity, @issues, @outcome, @better)`,
        );
        for (const r of reviews)
          insReview.run({
            ...r,
            session_id: sid,
            issues: JSON.stringify(r.issues),
            outcome: JSON.stringify(r.outcome),
          });
      },
    ) as (sid: string, signals: Signal[], profile: UsageProfile, now: number, reviews?: PromptReview[]) => void,
    signals(sid?: string): Signal[] {
      const rows = (
        sid
          ? db.prepare("SELECT * FROM insight_signals WHERE session_id = ?").all(sid)
          : db.prepare("SELECT * FROM insight_signals ORDER BY created_at DESC LIMIT 300").all()
      ) as any[];
      return rows.map(({ fix, created_at: _t, ...r }) => ({
        ...r,
        numbers: JSON.parse(r.numbers),
        ...(fix ? { fix } : {}),
      }));
    },
    /** Reviewed prompts, newest first. */
    promptReviews(limit = 150, sid?: string): PromptReview[] {
      const rows = sid
        ? db
            .prepare("SELECT * FROM prompt_reviews WHERE session_id = ? ORDER BY created_at DESC LIMIT ?")
            .all(sid, limit)
        : db.prepare("SELECT * FROM prompt_reviews ORDER BY created_at DESC LIMIT ?").all(limit);
      return rows.map(toReview);
    },
    promptStats(): PromptStats {
      const rows = db.prepare("SELECT words, issues, outcome FROM prompt_reviews").all() as any[];
      return promptStats(
        rows.map((r) => ({ words: r.words, issues: JSON.parse(r.issues), outcome: JSON.parse(r.outcome) })),
      );
    },
    saveExplanation: (sid: string, text: string, now: number) =>
      db
        .prepare(
          "INSERT INTO explanations (session_id, text, created_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET text = excluded.text, created_at = excluded.created_at",
        )
        .run(sid, text, now),
    explanation: (sid: string) =>
      (db.prepare("SELECT text, created_at FROM explanations WHERE session_id = ?").get(sid) as
        { text: string; created_at: number } | undefined) ?? null,
    suggestion: (id: number) =>
      db.prepare("SELECT * FROM suggestions WHERE id = ?").get(id) as
        { title: string; why: string; fix: string; fix_kind: string } | undefined,
    profile(): UsageProfile {
      return (db.prepare("SELECT profile FROM session_profiles").all() as { profile: string }[]).reduce(
        (acc, r) => mergeProfiles(acc, JSON.parse(r.profile)),
        emptyProfile(),
      );
    },
    saveSuggestions(scope: string, sid: string | null, list: Suggestion[], now: number) {
      const ins = db.prepare(
        "INSERT INTO suggestions (scope, session_id, severity, title, why, fix_kind, fix, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const x of list) ins.run(scope, sid, x.severity, x.title, x.why, x.fix_kind, x.fix, now);
    },
    suggestions: () => db.prepare("SELECT * FROM suggestions ORDER BY created_at DESC, id LIMIT 100").all(),
    vote: (id: number, vote: 1 | -1 | null) => db.prepare("UPDATE suggestions SET vote = ? WHERE id = ?").run(vote, id),
    votes: (): Vote[] =>
      db
        .prepare("SELECT title, vote FROM suggestions WHERE vote IS NOT NULL ORDER BY created_at DESC LIMIT 30")
        .all() as Vote[],
    close() {
      db.close();
    },
  };
}

export type Store = ReturnType<typeof openStore>;
