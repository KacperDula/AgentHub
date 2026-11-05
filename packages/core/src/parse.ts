import type {
  AgentEvent,
  CallStatus,
  EventType,
  ParseContext,
  ParseResult,
  RawLine,
  SessionMeta,
  SubagentLink,
  Todo,
} from "./types";
import { isFailedStatus, parseNotifications } from "./notify";
import { summarizeCall } from "./summary";
import { clip, hashString, obj, oneLine, promptHead, str, textOf } from "./util";

const KEEP_TYPES = new Set(["user", "assistant", "system"]);
const TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);

/** The line types worth storing: messages, plus enqueued background-completion notices. */
export function isWantedLine(o: any): boolean {
  if (!o || typeof o !== "object") return false;
  if (KEEP_TYPES.has(o.type)) return true;
  return o.type === "queue-operation" && o.operation === "enqueue" && str(o.content).includes("<task-notification>");
}

export function agentIdFromFile(file: string): string | null {
  return /agent-([^/\\]+)\.jsonl$/.exec(file)?.[1] ?? null;
}

const normalizeTodos = (raw: unknown[]): Todo[] =>
  raw.map((t) => {
    const o = obj(t);
    return {
      content: str(o.content),
      status: TODO_STATUSES.has(o.status) ? o.status : "pending",
      ...(str(o.activeForm) ? { activeForm: str(o.activeForm) } : {}),
    };
  });

/**
 * Turns raw Claude Code transcript lines into rows. Pure: everything already stored comes from `ctx`,
 * everything new or changed is returned. One bad line never breaks the batch.
 */
export function parseLines(lines: RawLine[], ctx: ParseContext, opts: { now?: number } = {}): ParseResult {
  const out: ParseResult = {
    events: [],
    updates: [],
    todoSnapshots: [],
    subagentLinks: [],
    relinks: [],
    sessionUpdates: [],
    skipped: 0,
  };
  const now = opts.now ?? Date.now();
  const calls = new Map<string, AgentEvent>(); // "sid|toolUseId" -> live row (new in batch, or a copy of a stored one)
  const stored = new Set<string>(); // source_uuids of rows copied from ctx
  const touched = new Map<string, AgentEvent>(); // stored rows we changed
  const links = new Map<string, SubagentLink>();
  const linkedSpawns = new Set<string>();
  const tokenMsgs = new Set<string>();
  const sessions = new Map<string, SessionMeta>();
  const inBatch = new Set<string>();
  const notices = new Map<string, AgentEvent>(); // sid|toolUseId -> notification row in this batch

  const getCall = (sid: string, tid: string): AgentEvent | undefined => {
    const k = sid + "|" + tid;
    let c = calls.get(k);
    if (!c) {
      const s = ctx.getCall(sid, tid);
      if (s) {
        c = { ...s, payload: { ...s.payload } };
        calls.set(k, c);
        stored.add(c.source_uuid);
      }
    }
    return c;
  };
  const changed = (c: AgentEvent) => {
    if (stored.has(c.source_uuid)) touched.set(c.source_uuid, c);
  };
  const getLink = (sid: string, aid: string) => links.get(sid + "|" + aid) ?? ctx.getLink(sid, aid);

  const close = (c: AgentEvent, status: CallStatus, ts: number, extra?: Record<string, unknown>) => {
    if (c.status !== "running") return;
    c.status = status;
    c.ended_at = ts;
    c.duration_ms = Math.max(0, ts - c.created_at);
    if (extra) c.payload = { ...c.payload, ...extra };
    changed(c);
  };

  const runningCalls = (sid: string): AgentEvent[] => {
    const seen = new Map<string, AgentEvent>();
    for (const s of ctx.runningCalls(sid)) if (s.tool_use_id) seen.set(s.tool_use_id, getCall(sid, s.tool_use_id)!);
    for (const [k, c] of calls) if (k.startsWith(sid + "|") && c.tool_use_id) seen.set(c.tool_use_id, c);
    return [...seen.values()].filter((c) => c.status === "running");
  };

  /** Ends a background task by its id: a background command, or a subagent linked to that agentId. */
  const endTask = (sid: string, taskId: string, status: CallStatus, ts: number, extra?: Record<string, unknown>) => {
    if (!taskId) return;
    const spawnId = getLink(sid, taskId)?.tool_use_id;
    for (const c of runningCalls(sid)) {
      if (
        c.payload.background_task_id === taskId ||
        c.payload.agent_id === taskId ||
        (spawnId && c.tool_use_id === spawnId)
      )
        close(c, status, ts, extra);
    }
  };

  const link = (sid: string, agentId: string, spawn: AgentEvent) => {
    if (!spawn.tool_use_id || getLink(sid, agentId)) return;
    const name = str(spawn.payload.subagent_name) || agentId;
    const l: SubagentLink = { session_id: sid, agent_id: agentId, tool_use_id: spawn.tool_use_id, name };
    links.set(sid + "|" + agentId, l);
    linkedSpawns.add(sid + "|" + spawn.tool_use_id);
    out.subagentLinks.push(l);
    out.relinks.push({ session_id: sid, agent_id: agentId, agent_key: l.tool_use_id, agent_name: name });
    for (const r of [...out.events, ...out.todoSnapshots]) {
      if (r.session_id === sid && r.agent_id === agentId) {
        r.agent_key = l.tool_use_id;
        r.agent_name = name;
      }
    }
  };

  const findSpawn = (sid: string, head: string): AgentEvent | undefined => {
    const free = (e: AgentEvent) => !linkedSpawns.has(sid + "|" + e.tool_use_id);
    const inThisBatch = out.events.find(
      (e) =>
        e.session_id === sid &&
        e.event_type === "subagent_spawn" &&
        free(e) &&
        promptHead(str(e.payload.input?.prompt)) === head,
    );
    if (inThisBatch) return inThisBatch;
    const s = ctx.findSpawnByPrompt(sid, head);
    return s && free(s) ? getCall(sid, s.tool_use_id!) : undefined;
  };

  const push = (e: AgentEvent) => {
    if (inBatch.has(e.source_uuid)) return;
    inBatch.add(e.source_uuid);
    out.events.push(e);
  };

  const touchSession = (sid: string, ts: number, o: any, isMain: boolean) => {
    let s = sessions.get(sid);
    if (!s) {
      s = { id: sid, project_path: null, git_branch: null, model: null, started_at: ts, last_event_at: ts };
      sessions.set(sid, s);
    }
    s.started_at = Math.min(s.started_at, ts);
    s.last_event_at = Math.max(s.last_event_at, ts);
    if (!isMain) return;
    if (!s.project_path && str(o.cwd)) s.project_path = str(o.cwd);
    if (str(o.gitBranch)) s.git_branch = str(o.gitBranch);
    const model = str(o.message?.model);
    if (model && !model.startsWith("<")) s.model = model;
  };

  const handleNotifications = (sid: string, text: string, ts: number) => {
    for (const n of parseNotifications(text)) {
      const call = n.toolUseId ? getCall(sid, n.toolUseId) : undefined;
      const status: CallStatus = isFailedStatus(n.status) ? "error" : "done";
      const row: AgentEvent = {
        source_uuid: `notify:${n.toolUseId || n.taskId}:${n.status}`,
        session_id: sid,
        parent_uuid: null,
        agent_key: call?.agent_key ?? "main",
        agent_name: call?.agent_name ?? "main",
        agent_id: call?.agent_id ?? null,
        is_subagent: call?.is_subagent ?? false,
        event_type: "tool_result",
        tool_name: call?.tool_name ?? null,
        tool_use_id: n.toolUseId || null,
        status,
        summary: oneLine(n.summary || `Background task ${n.status}`, 200),
        payload: {
          content: clip(n.summary, 2000),
          background: true,
          task_id: n.taskId,
          task_status: n.status,
          duration_ms: n.durationMs,
        },
        input_tokens: null,
        output_tokens: null,
        message_id: null,
        created_at: ts,
        ended_at: null,
        duration_ms: null,
      };
      push(row);
      if (n.toolUseId) notices.set(sid + "|" + n.toolUseId, row);
      if (call) close(call, status, ts);
      else endTask(sid, n.taskId, status, ts);
    }
  };

  const handle = (file: string, o: any) => {
    if (!o || typeof o !== "object") return void out.skipped++;
    const sid = str(o.sessionId);
    if (!sid) return void out.skipped++;
    const parsed = Date.parse(str(o.timestamp));
    const ts = Number.isFinite(parsed) ? parsed : now;

    if (o.type === "queue-operation") {
      if (!isWantedLine(o)) return void out.skipped++;
      touchSession(sid, ts, o, false);
      return handleNotifications(sid, str(o.content), ts);
    }
    if (!KEEP_TYPES.has(o.type)) return void out.skipped++;

    const isSub = o.isSidechain === true || file.replace(/\\/g, "/").includes("/subagents/");
    touchSession(sid, ts, o, !isSub);

    // Which agent wrote this line.
    let key = "main";
    let name = "main";
    let agentId: string | null = null;
    if (isSub) {
      agentId = str(o.agentId) || agentIdFromFile(file) || "unknown";
      let l = getLink(sid, agentId);
      if (!l && o.parentUuid == null && o.type === "user") {
        // The first line of a subagent transcript is the prompt its parent passed in.
        const prompt = textOf(o.message?.content);
        const spawn = prompt ? findSpawn(sid, promptHead(prompt)) : undefined;
        if (spawn) {
          link(sid, agentId, spawn);
          l = getLink(sid, agentId);
        }
      }
      key = l ? l.tool_use_id : "agent:" + agentId;
      name = l ? l.name : agentId;
    }

    const lineId = str(o.uuid) || hashString(JSON.stringify(o));
    const cwd = str(o.cwd);
    const base = (i: number, type: EventType): AgentEvent => ({
      source_uuid: `${lineId}:${i}`,
      session_id: sid,
      parent_uuid: str(o.parentUuid) || null,
      agent_key: key,
      agent_name: name,
      agent_id: agentId,
      is_subagent: isSub,
      event_type: type,
      tool_name: null,
      tool_use_id: null,
      status: null,
      summary: "",
      payload: {},
      input_tokens: null,
      output_tokens: null,
      message_id: str(o.message?.id) || null,
      created_at: ts,
      ended_at: null,
      duration_ms: null,
    });

    if (o.type === "system") {
      const e = base(0, "other");
      const content = str(o.content);
      e.summary = oneLine(content || (o.subtype ? `system: ${o.subtype}` : "system"), 200);
      e.payload = { subtype: str(o.subtype) || null, content: clip(content, 300) };
      return push(e);
    }

    const msg = obj(o.message);
    const blocks: any[] =
      typeof msg.content === "string"
        ? [{ type: "text", text: msg.content }]
        : Array.isArray(msg.content)
          ? msg.content
          : [];
    let tokensChecked = false;

    blocks.forEach((b, i) => {
      if (!b || typeof b !== "object") return;
      let e: AgentEvent;

      if (b.type === "text") {
        const t = str(b.text);
        if (t.includes("<task-notification>")) return handleNotifications(sid, t, ts);
        if (o.type === "user") {
          if (o.isMeta) return;
          e = base(i, t.startsWith("<") || t.startsWith("Caveat:") ? "other" : "user_prompt");
        } else e = base(i, "assistant_text");
        e.summary = oneLine(t, 200);
        e.payload = { text: clip(t, 2000) };
      } else if (b.type === "thinking") {
        e = base(i, "thinking");
        e.summary = oneLine(str(b.thinking), 200);
        e.payload = { text: clip(str(b.thinking), 2000) };
      } else if (b.type === "tool_use") {
        const id = str(b.id);
        if (id && getCall(sid, id)) return; // same call sent twice
        const toolName = str(b.name) || "tool";
        const input = obj(b.input);
        const isSpawn = toolName === "Task" || toolName === "Agent";
        e = base(i, isSpawn ? "subagent_spawn" : "tool_call");
        e.tool_name = toolName;
        e.tool_use_id = id || null;
        e.status = "running";
        e.payload = { input };
        if (input.run_in_background === true) e.payload.background = true;
        if (isSpawn) {
          e.payload.subagent_name = str(input.subagent_type) || str(input.description) || "subagent";
          e.payload.description = str(input.description);
        }
        e.summary = summarizeCall(toolName, input, cwd);
        if (toolName === "TodoWrite" && Array.isArray(input.todos)) {
          out.todoSnapshots.push({
            source_uuid: e.source_uuid,
            session_id: sid,
            agent_key: key,
            agent_name: name,
            agent_id: agentId,
            todos: normalizeTodos(input.todos),
            created_at: ts,
          });
        }
        if (id) {
          calls.set(sid + "|" + id, e);
          // Its completion notice may have been read first (backfill reads the main transcript before subagents').
          const notice = notices.get(sid + "|" + id) ?? ctx.getNotification(sid, id);
          if (notice && notice.created_at >= ts) {
            e.status = notice.status;
            e.ended_at = notice.created_at;
            e.duration_ms = notice.created_at - ts;
            e.payload.background = true;
          }
        }
      } else if (b.type === "tool_result") {
        const tid = str(b.tool_use_id);
        const call = tid ? getCall(sid, tid) : undefined;
        const isErr = b.is_error === true;
        const tur = obj(o.toolUseResult);
        const content = clip(textOf(b.content), 2000);
        e = base(i, "tool_result");
        e.tool_use_id = tid || null;
        e.tool_name = call?.tool_name ?? null;
        e.status = isErr ? "error" : "done";
        e.summary = oneLine(content, 200);
        e.payload = {
          content,
          is_error: isErr,
          meta: {
            isAsync: tur.isAsync ?? null,
            status: tur.status ?? null,
            agentId: tur.agentId ?? null,
            backgroundTaskId: tur.backgroundTaskId ?? null,
          },
        };
        if (call) {
          const background = !isErr && (tur.isAsync === true || !!str(tur.backgroundTaskId));
          if (background) {
            // Launched in the background: stays running until its <task-notification> (or TaskStop).
            call.payload = {
              ...call.payload,
              background: true,
              ...(str(tur.backgroundTaskId) ? { background_task_id: str(tur.backgroundTaskId) } : {}),
              ...(str(tur.agentId) ? { agent_id: str(tur.agentId) } : {}),
            };
            changed(call);
          } else close(call, isErr ? "error" : "done", ts);
          if (call.event_type === "subagent_spawn" && str(tur.agentId)) link(sid, str(tur.agentId), call);
          if (call.tool_name === "TaskStop") {
            const input = obj(call.payload.input);
            endTask(sid, str(input.task_id) || str(input.shell_id), "done", ts, { stopped: true });
          }
        }
      } else return;

      if (!tokensChecked && o.type === "assistant") {
        tokensChecked = true;
        if (str(msg.model) && !str(msg.model).startsWith("<")) e.payload.model = msg.model;
        const mid = str(msg.id);
        const usage = obj(msg.usage);
        const k = sid + "|" + mid;
        if (mid && msg.usage && !tokenMsgs.has(k) && !ctx.messageHasTokens(sid, mid)) {
          tokenMsgs.add(k);
          e.input_tokens = (Number(usage.input_tokens) || 0) + (Number(usage.cache_creation_input_tokens) || 0);
          e.output_tokens = Number(usage.output_tokens) || 0;
        }
      }
      push(e);
    });
  };

  for (const { file, line } of lines) {
    try {
      handle(str(file), line);
    } catch {
      out.skipped++;
    }
  }

  out.updates = [...touched.values()];
  out.sessionUpdates = [...sessions.values()];
  return out;
}
