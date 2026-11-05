import type {
  AgentEvent,
  AgentState,
  Card,
  Edge,
  LiveModel,
  Look,
  Progress,
  RunningChip,
  TodoSnapshot,
  TreeOptions,
} from "./types";
import { isMachinePrompt } from "./prompts";
import { mcpParts, stripToolPrefix } from "./summary";
import { oneLine, str } from "./util";

const MIN = 60_000;
const BACKGROUND_EXPIRY = 60 * MIN;

export const LOOK: Record<AgentState, Look> = {
  Thinking: "running",
  "Running tool": "running",
  "Background work": "running",
  Working: "running",
  Starting: "running",
  "Waiting for you": "waiting",
  Done: "done",
  Error: "error",
  Idle: "idle",
};

export function fmtEta(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return s < 60 ? `~${s} s left` : `~${Math.round(s / 60)} min left`;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export const fmtCallDuration = (ms: number | null): string =>
  ms == null ? "" : ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;

const isCall = (e: AgentEvent) => e.event_type === "tool_call" || e.event_type === "subagent_spawn";

/** Progress from the latest TodoWrite plan, with the ETA rule from the plan spec. */
export function planProgress(snaps: TodoSnapshot[], t: number): Progress | null {
  const latest = snaps[snaps.length - 1]?.todos;
  if (!latest?.length) return null;
  const total = latest.length;
  const completed = latest.filter((x) => x.status === "completed").length;
  const inProgress = latest.filter((x) => x.status === "in_progress").length;
  const value = (completed + 0.5 * inProgress) / total;
  if (completed === total) return { value: 1, label: "Plan complete · 100%" };
  if (!completed) return { value: null, label: "estimating…" };
  const planStart = snaps[0].created_at;
  let lastCompletion = planStart;
  let prev = 0;
  for (const s of snaps) {
    const c = s.todos.filter((x) => x.status === "completed").length;
    if (c > prev) lastCompletion = s.created_at;
    prev = c;
  }
  const avg = (lastCompletion - planStart) / completed;
  const eta = lastCompletion + avg * (total - completed) - t;
  if (eta <= 0) return { value, label: `taking longer than usual · ${pct(value)}`, warn: true };
  return { value, label: `${fmtEta(eta)} · ${pct(value)}`, etaMs: eta };
}

interface AgentInfo {
  key: string;
  cardId: string;
  events: AgentEvent[];
  spawn?: AgentEvent;
  agentId: string | null;
  state: AgentState;
  start: number | null;
  end: number | null;
}

const RESOURCE: Record<string, { label: string; verb?: string }> = {
  Read: { label: "FILES", verb: "read" },
  NotebookRead: { label: "FILES", verb: "read" },
  Edit: { label: "FILES", verb: "edited" },
  MultiEdit: { label: "FILES", verb: "edited" },
  NotebookEdit: { label: "FILES", verb: "edited" },
  Write: { label: "FILES", verb: "written" },
  Bash: { label: "COMMAND" },
  PowerShell: { label: "COMMAND" },
  WebFetch: { label: "WEB" },
  WebSearch: { label: "WEB" },
  Grep: { label: "SEARCH" },
  Glob: { label: "SEARCH" },
};

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const domain = (u: string) => /^[a-z]+:\/\/([^/?#]+)/i.exec(u)?.[1] ?? u;
const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];
export const shortList = (xs: string[]): string[] => (xs.length <= 2 ? xs : [xs[0], `+${xs.length - 1} more`]);

const CONTINUED = "This session is being continued from a previous conversation";

/** The "Primary Request and Intent" part of Claude Code's summary after the context ran out. */
export function intentFromSummary(text: string): string | null {
  const m = /Primary Request and Intent:?\s*\n?([\s\S]*?)(?=\n\s*2\.\s|\n\s*#{1,3}\s|$)/i.exec(text);
  const body = (m?.[1] ?? text.split(/\n\s*Summary:\s*\n/i)[1] ?? "").trim();
  return body ? oneLine(body.replace(/^\s*[-*•]\s+/gm, ""), 700) : null;
}

/** "Where are we? What's left?": a check-in, not the task the session is for. */
const STATUS =
  /\b(where are we|where do we stand|what'?s left|status( update| report)?|how far|progress report|are we done)\b|(πο[υύ] βρισκ[οό]μαστε|τι (γ[ιί]νεται|[έε]χει μ[είι]νει|μ[έε]νει)|τελει[ωώ]σαμε|[έε]χουμε τελει[ωώ]σ|κατ[άα]σταση)/iu;
const promptWords = (t: string) => t.split(/\s+/).filter(Boolean).length;
/** A prompt that asks for work (not a reply, a correction or a check-in). */
export const isTaskPrompt = (text: string) => promptWords(text) >= 6 && !STATUS.test(text) && !isMachinePrompt(text);

/**
 * What the session is about: the prompt the user pinned, else the first prompt that asks for work (check-ins like
 * "where are we?" are skipped), or, when the log starts with Claude Code's summary of an earlier conversation, the
 * request recorded in that summary. Also returns the latest prompt.
 */
export function sessionPrompt(
  prompts: AgentEvent[],
  pinnedId?: string,
): {
  goal: AgentEvent | null;
  goalText: string;
  fromSummary: boolean;
  pinned: boolean;
  latest: AgentEvent | null;
} {
  const text = (e: AgentEvent) => str(e.payload.text) || e.summary;
  const sorted = [...prompts].sort((a, b) => a.created_at - b.created_at);
  const real = sorted.filter((e) => !isMachinePrompt(text(e)));
  const latest = real.at(-1) ?? null;
  const pin = pinnedId ? sorted.find((e) => e.source_uuid === pinnedId) : undefined;
  if (pin) return { goal: pin, goalText: text(pin), fromSummary: false, pinned: true, latest };
  const task = real.find((e) => isTaskPrompt(text(e)));
  const summary = sorted.find((e) => text(e).trimStart().startsWith(CONTINUED));
  if (summary && (!task || summary.created_at < task.created_at)) {
    const intent = intentFromSummary(text(summary));
    if (intent) return { goal: summary, goalText: intent, fromSummary: true, pinned: false, latest };
  }
  const goal = task ?? real[0] ?? null;
  return { goal, goalText: goal ? text(goal) : "", fromSummary: false, pinned: false, latest };
}

function resourceItems(name: string, calls: AgentEvent[]): string[] {
  const inputs = calls.map((c) => c.payload.input ?? {});
  const mcp = mcpParts(name);
  if (mcp) return [mcp.server];
  switch (RESOURCE[name]?.label) {
    case "FILES":
      return uniq(inputs.map((i) => baseName(str(i.file_path) || str(i.notebook_path))));
    case "COMMAND":
      return uniq(inputs.map((i) => str(i.command)).reverse());
    case "WEB":
      return uniq(inputs.map((i) => (name === "WebFetch" ? domain(str(i.url)) : str(i.query))));
    case "SEARCH":
      return uniq(inputs.map((i) => str(i.pattern)));
  }
  return [];
}

/** Builds the Live Map model: prompt, main agent, subagents, tools, resources, states, progress, ETA. */
export function buildTree(
  allEvents: AgentEvent[],
  allTodos: TodoSnapshot[],
  now: number,
  opts: TreeOptions = {},
): LiveModel {
  const asOf = opts.asOf;
  const t = asOf ?? now;
  let events = allEvents;
  let todos = allTodos;
  if (asOf != null) {
    events = allEvents
      .filter((e) => e.created_at <= asOf)
      .map((e) =>
        e.ended_at != null && e.ended_at > asOf ? { ...e, status: "running", ended_at: null, duration_ms: null } : e,
      );
    todos = allTodos.filter((s) => s.created_at <= asOf);
  }
  events = [...events].sort((a, b) => a.created_at - b.created_at);
  todos = [...todos].sort((a, b) => a.created_at - b.created_at);

  const isRunning = (c: AgentEvent) =>
    c.status === "running" && !(c.payload.background && t - c.created_at > BACKGROUND_EXPIRY);

  // ---- index ----
  const byAgent = new Map<string, AgentEvent[]>();
  const spawns = new Map<string, AgentEvent>();
  const results = new Map<string, AgentEvent[]>();
  const taskResults = new Map<string, AgentEvent>();
  for (const e of events) {
    if (!byAgent.has(e.agent_key)) byAgent.set(e.agent_key, []);
    byAgent.get(e.agent_key)!.push(e);
    if (e.event_type === "subagent_spawn" && e.tool_use_id) spawns.set(e.tool_use_id, e);
    if (e.event_type === "tool_result") {
      if (e.tool_use_id) {
        if (!results.has(e.tool_use_id)) results.set(e.tool_use_id, []);
        results.get(e.tool_use_id)!.push(e);
      }
      if (e.payload.task_id) taskResults.set(String(e.payload.task_id), e);
    }
  }
  if (!byAgent.has("main")) byAgent.set("main", []);
  for (const tid of spawns.keys()) if (!byAgent.has(tid)) byAgent.set(tid, []);
  const plans = new Map<string, TodoSnapshot[]>();
  for (const s of todos) {
    if (!plans.has(s.agent_key)) plans.set(s.agent_key, []);
    plans.get(s.agent_key)!.push(s);
  }

  const cardIdOf = (key: string) => (key === "main" ? "agent:main" : "sub:" + key);
  const meaningful = (evs: AgentEvent[]) => evs.filter((e) => e.event_type !== "other");
  const runningOf = (evs: AgentEvent[]) => evs.filter((e) => isCall(e) && isRunning(e));

  // ---- agent states ----
  const agents: AgentInfo[] = [];
  for (const [key, evs] of byAgent) {
    const spawn = spawns.get(key);
    const agentId = evs.find((e) => e.agent_id)?.agent_id ?? (key.startsWith("agent:") ? key.slice(6) : null);
    const mine = meaningful(evs);
    const last = mine[mine.length - 1];
    const quiet = last ? t - last.created_at : Infinity;
    const running = runningOf(evs);
    const fg = running.some((c) => !c.payload.background);
    let state: AgentState;
    if (key === "main") {
      if (fg) state = "Running tool";
      else if (running.length)
        state = quiet < MIN && last?.event_type !== "assistant_text" ? "Thinking" : "Background work";
      else if (!last || quiet > 2 * MIN) state = "Idle";
      else if (last.event_type === "assistant_text") state = "Waiting for you";
      else state = "Thinking";
    } else if (spawn) {
      if (spawn.status === "error") state = "Error";
      else if (fg) state = "Running tool";
      else if (spawn.status === "running") {
        if (running.length) state = "Background work";
        else if (!evs.length) state = "Starting";
        else if (quiet < MIN) state = "Thinking";
        else if (quiet > 30 * MIN) state = "Idle";
        else state = "Working";
      } else state = "Done";
    } else {
      const res = agentId ? taskResults.get(agentId) : undefined;
      if (res) state = res.status === "error" ? "Error" : "Done";
      else if (fg) state = "Running tool";
      else state = quiet < 2 * MIN ? "Thinking" : "Idle";
    }
    const first = evs[0]?.created_at ?? null;
    const start = spawn?.created_at ?? first;
    const done = state === "Done" || state === "Error";
    const end = done ? (spawn?.ended_at ?? evs[evs.length - 1]?.created_at ?? start) : null;
    agents.push({ key, cardId: cardIdOf(key), events: evs, spawn, agentId, state, start, end });
  }
  agents.sort((a, b) => (a.key === "main" ? -1 : b.key === "main" ? 1 : (a.start ?? 0) - (b.start ?? 0)));
  const mainInfo = agents[0];

  // ---- cards ----
  const cards: Card[] = [];
  const mainEvents = mainInfo.events;
  const prompts = mainEvents.filter((e) => e.event_type === "user_prompt");
  const lastPrompt = prompts[prompts.length - 1];
  const mainLook = LOOK[mainInfo.state];
  // The prompt card shows what the session is for, not whatever was typed last. `allPrompts` holds every prompt of
  // the session (the loaded events may be only the latest few thousand).
  const pool = new Map<string, AgentEvent>();
  for (const e of [...(opts.allPrompts ?? []), ...prompts])
    if (e.event_type === "user_prompt" && !e.is_subagent && e.created_at <= t) pool.set(e.source_uuid, e);
  const sp = sessionPrompt([...pool.values()], opts.mainPromptId);
  const latestText =
    sp.latest && sp.latest !== sp.goal ? oneLine(str(sp.latest.payload.text) || sp.latest.summary, 200) : "";
  cards.push({
    id: "prompt",
    kind: "prompt",
    parentId: null,
    label: "PROMPT",
    title: sp.fromSummary ? "Your prompt (from the summary)" : sp.pinned ? "Your main prompt" : "Your prompt",
    look: mainLook === "running" ? "running" : "done",
    startedAt: sp.goal?.created_at ?? null,
    endedAt: mainLook === "running" ? null : (mainEvents[mainEvents.length - 1]?.created_at ?? null),
    lines: [sp.goal ? sp.goalText : "Waiting for a prompt…", latestText],
    eventIds: [...pool.values()].sort((a, b) => a.created_at - b.created_at).map((e) => e.source_uuid),
  });

  const modelOf = (evs: AgentEvent[]) => {
    for (let i = evs.length - 1; i >= 0; i--) if (evs[i].payload.model) return String(evs[i].payload.model);
    return undefined;
  };
  const tokens = (evs: AgentEvent[]) => ({
    tokensIn: evs.reduce((a, e) => a + (e.input_tokens ?? 0), 0),
    tokensOut: evs.reduce((a, e) => a + (e.output_tokens ?? 0), 0),
  });

  const progressOf = (a: AgentInfo, name: string): Progress => {
    const plan = planProgress(plans.get(a.key) ?? [], t);
    const look = LOOK[a.state];
    if (look === "done" || look === "error")
      return plan && plan.value === 1 ? plan : { value: 1, label: a.state === "Error" ? "Failed" : "Finished" };
    if (plan) return plan;
    if (look !== "running") return { value: 1, label: a.state };
    const avg = a.key !== "main" ? opts.subagentAverages?.[name] : undefined;
    if (avg && a.start != null) {
      const elapsed = t - a.start;
      const value = Math.min(0.95, elapsed / avg);
      const eta = avg - elapsed;
      if (eta <= 0) return { value, label: `taking longer than usual · ${pct(value)}`, warn: true };
      return { value, label: `${fmtEta(eta)} · ${pct(value)}`, etaMs: eta };
    }
    return { value: null, label: "estimating…" };
  };

  const currentTodo = (key: string) => {
    const latest = plans.get(key)?.at(-1)?.todos;
    if (!latest) return "No plan yet";
    const cur = latest.find((x) => x.status === "in_progress");
    if (cur) return "▸ " + (cur.activeForm || cur.content);
    return latest.every((x) => x.status === "completed") ? "✓ Plan complete" : "▸ " + latest[0].content;
  };

  for (const a of agents) {
    const name = a.spawn ? str(a.spawn.payload.subagent_name) : (a.events[0]?.agent_name ?? a.key);
    const tk = tokens(a.events);
    const model = modelOf(a.events);
    const common = {
      look: LOOK[a.state],
      state: a.state,
      startedAt: a.key === "main" ? (lastPrompt?.created_at ?? a.start) : a.start,
      endedAt: a.end,
      agentKey: a.key,
      model,
      ...tk,
      eventCount: a.events.length,
      plan: plans.get(a.key)?.at(-1)?.todos,
      progress: progressOf(a, name),
      eventIds: a.events.map((e) => e.source_uuid),
    };
    if (a.key === "main") {
      cards.push({
        id: a.cardId,
        kind: "agent",
        parentId: "prompt",
        label: "AGENT",
        title: "Main agent",
        lines: [currentTodo(a.key)],
        ...common,
      });
      continue;
    }
    const short = a.agentId ? `subagent ${a.agentId.slice(0, 7)}` : "subagent";
    const generic = !a.spawn || name === "general-purpose" || name === a.agentId;
    const description = a.spawn ? str(a.spawn.payload.description) : "";
    const parentKey = a.spawn?.agent_key;
    cards.push({
      id: a.cardId,
      kind: "subagent",
      parentId: parentKey && byAgent.has(parentKey) ? cardIdOf(parentKey) : "agent:main",
      label: "SUBAGENT",
      title: generic ? description || short : name,
      subtitle: generic
        ? a.spawn
          ? str(a.spawn.payload.input?.subagent_type) || "general-purpose"
          : undefined
        : description,
      lines: [currentTodo(a.key)],
      ...common,
    });
  }

  // tools and resources, per agent, one card per tool name
  const runningTools: RunningChip[] = [];
  for (const a of agents) {
    const groups = new Map<string, AgentEvent[]>();
    for (const e of a.events) {
      if (e.event_type !== "tool_call" || !e.tool_name || e.tool_name === "TodoWrite") continue;
      if (!groups.has(e.tool_name)) groups.set(e.tool_name, []);
      groups.get(e.tool_name)!.push(e);
    }
    for (const [name, calls] of groups) {
      const mcp = mcpParts(name);
      const running = calls.filter(isRunning);
      const last = calls[calls.length - 1];
      const shown = running[running.length - 1] ?? last;
      const errors = calls.filter((c) => c.status === "error").length;
      const look: Look = running.length ? "running" : last.status === "error" ? "error" : "done";
      const id = `tool:${a.key}:${name}`;
      const detail = (c: AgentEvent) =>
        mcp ? c.summary.split(": ").slice(1).join(": ") || mcp.tool : stripToolPrefix(c.summary, name);
      const lines = [detail(shown)];
      if (look === "done") lines.push(`last call ${fmtCallDuration(last.duration_ms)}`);
      if (look === "error") lines.push("last call failed");
      const eventIds = calls.flatMap((c) => [c, ...(results.get(c.tool_use_id ?? "") ?? [])].map((e) => e.source_uuid));
      cards.push({
        id,
        kind: mcp ? "mcp" : "tool",
        parentId: a.cardId,
        label: mcp ? "MCP TOOL" : "BUILT-IN TOOL",
        title: mcp ? mcp.tool : name,
        server: mcp?.server,
        toolName: name,
        calls: calls.length,
        errors,
        look,
        startedAt: shown.created_at,
        endedAt: look === "running" ? null : last.ended_at,
        lines,
        eventIds,
      });
      for (const c of running) {
        const what = c.payload.background
          ? `(background) ${str(c.payload.input?.description) || detail(c)}`
          : detail(c);
        runningTools.push({
          cardId: id,
          kind: "tool",
          label: `${mcp ? mcp.tool : name} ${what}`,
          startedAt: c.created_at,
        });
      }
      const items = resourceItems(name, calls);
      if (items.length) {
        const kind = mcp ? { label: "MCP SERVER" } : RESOURCE[name];
        cards.push({
          id: `res:${a.key}:${name}`,
          kind: "resource",
          parentId: id,
          label: kind.label,
          title: kind.verb ? `${items.length} ${kind.verb}` : items[0],
          items,
          look,
          startedAt: shown.created_at,
          endedAt: null,
          lines: kind.verb
            ? shortList(items)
            : [items.length > 1 ? `+${items.length - 1} more` : `${calls.length} call${calls.length === 1 ? "" : "s"}`],
          eventIds,
        });
      }
    }
  }

  // ---- fold each agent's tools into one chip (opened per agent, or all with showTools) ----
  const hidden = new Set<string>();
  const toolChip = new Map<string, string>(); // hidden tool card id -> its chip id
  if (!opts.showTools) {
    for (const a of agents) {
      const tools = cards.filter((c) => c.parentId === a.cardId && (c.kind === "tool" || c.kind === "mcp"));
      if (!tools.length) continue;
      const chipId = "tools:" + a.cardId;
      if (opts.expanded?.has(chipId)) {
        for (const c of tools) c.foldId = chipId;
        continue;
      }
      const ids = new Set(tools.map((c) => c.id));
      for (const c of cards) {
        if (ids.has(c.id)) toolChip.set(c.id, chipId);
        if (ids.has(c.id) || (c.parentId && ids.has(c.parentId))) hidden.add(c.id);
      }
      const calls = tools.reduce((n, c) => n + (c.calls ?? 0), 0);
      const errors = tools.reduce((n, c) => n + (c.errors ?? 0), 0);
      const runningNow = tools.filter((c) => c.look === "running");
      const byUse = [...tools].sort((x, y) => (y.calls ?? 0) - (x.calls ?? 0));
      cards.push({
        id: chipId,
        kind: "fold",
        foldKind: "tools",
        parentId: a.cardId,
        label: "TOOLS",
        title: `${tools.length} tool${tools.length === 1 ? "" : "s"} · ${calls} call${calls === 1 ? "" : "s"}`,
        look: runningNow.length ? "running" : "done",
        startedAt: runningNow.length ? Math.min(...runningNow.map((c) => c.startedAt ?? t)) : null,
        endedAt: null,
        errors,
        lines: [
          runningNow.length
            ? `running: ${runningNow.map((c) => c.title).join(", ")}`
            : byUse.map((c) => (c.calls && c.calls > 1 ? `${c.title} ×${c.calls}` : c.title)).join(" · "),
        ],
        eventIds: tools.flatMap((c) => c.eventIds),
        folded: byUse.map((c) => ({ id: c.id, title: c.calls && c.calls > 1 ? `${c.title} ×${c.calls}` : c.title })),
      });
    }
  }

  // ---- fold finished subagents ----
  const foldAfter = opts.foldAfterMs ?? 30_000;
  const children = new Map<string, Card[]>();
  for (const c of cards)
    if (c.parentId) (children.get(c.parentId) ?? children.set(c.parentId, []).get(c.parentId)!).push(c);
  const subtree = (id: string): Card[] => (children.get(id) ?? []).flatMap((c) => [c, ...subtree(c.id)]);
  const folds = new Map<string, Card>();
  for (const c of cards) {
    if (c.kind !== "subagent" || c.state !== "Done" || c.endedAt == null || t - c.endedAt < foldAfter) continue;
    const below = subtree(c.id);
    if (below.some((x) => x.look === "running")) continue;
    const foldId = "fold:" + c.parentId;
    if (opts.expanded?.has(foldId)) {
      c.foldId = foldId;
      continue;
    }
    hidden.add(c.id);
    for (const x of below) hidden.add(x.id);
    const chip =
      folds.get(foldId) ??
      ({
        id: foldId,
        kind: "fold",
        foldKind: "subagents",
        parentId: c.parentId,
        label: "FINISHED",
        title: "",
        look: "done",
        startedAt: null,
        endedAt: null,
        lines: [],
        eventIds: [],
        folded: [],
      } as Card);
    chip.folded!.push({ id: c.id, title: c.title });
    folds.set(foldId, chip);
  }
  // A nested subagent's chip goes away when its parent subagent is folded too (it is part of the parent's subtree).
  for (const [id, chip] of folds) if (chip.parentId && hidden.has(chip.parentId)) folds.delete(id);
  for (const chip of folds.values()) {
    const n = chip.folded!.length;
    chip.title = `${n} finished subagent${n === 1 ? "" : "s"}`;
    chip.lines = [chip.folded!.map((f) => f.title).join(" · ")];
  }
  const visible = [...cards.filter((c) => !hidden.has(c.id)), ...folds.values()];

  const edges: Edge[] = visible
    .filter((c) => c.parentId)
    .map((c) => ({ id: `${c.parentId}->${c.id}`, source: c.parentId!, target: c.id, running: c.look === "running" }));

  // ---- running now ----
  const running: RunningChip[] = [];
  for (const c of visible) {
    if (c.kind === "subagent" && c.look === "running")
      running.push({ cardId: c.id, kind: "subagent", label: c.title, startedAt: c.startedAt ?? t });
  }
  // Tools folded into a chip still show in "Running now"; clicking them selects the chip.
  for (const r of runningTools) {
    const chip = toolChip.get(r.cardId);
    const cardId = chip && !hidden.has(chip) ? chip : r.cardId;
    if (!hidden.has(cardId)) running.push({ ...r, cardId });
  }
  if (mainInfo.state === "Thinking")
    running.push({
      cardId: "agent:main",
      kind: "thinking",
      label: "Main agent · thinking",
      startedAt: mainInfo.events.at(-1)?.created_at ?? t,
    });

  // ---- session progress ----
  const mainCard = cards.find((c) => c.id === "agent:main")!;
  const mainPlan = planProgress(plans.get("main") ?? [], t);
  const anyRunning = running.length > 0 || mainLook === "running";
  let progress: Progress;
  if (!anyRunning) {
    const label = mainInfo.state === "Waiting for you" ? "Waiting for you" : "Idle";
    const v = mainPlan?.value ?? 1;
    progress = { value: v, label: `${label} · ${pct(v)}` };
  } else {
    const etas = visible
      .filter((c) => c.look === "running" && c.progress?.etaMs != null)
      .map((c) => c.progress!.etaMs!);
    const longest = etas.length ? Math.max(...etas) : null;
    const v = mainPlan?.value ?? null;
    if (longest != null)
      progress = { value: v, label: `${fmtEta(longest)}${v != null ? " · " + pct(v) : ""}`, etaMs: longest };
    else progress = mainPlan ?? mainCard.progress ?? { value: null, label: "estimating…" };
  }

  return {
    cards: visible,
    edges,
    running,
    mainState: mainInfo.state,
    session: {
      progress,
      model: mainCard.model ?? null,
      tokens: events.reduce((a, e) => a + (e.input_tokens ?? 0) + (e.output_tokens ?? 0), 0),
      events: events.length,
      startedAt: events[0]?.created_at ?? null,
    },
    now: t,
  };
}

/** Separates a session id from a card id on a combined map ("<sessionId>/<cardId>"). */
export const SESSION_SEP = "/";
export const splitCardId = (id: string): { sessionId: string | null; cardId: string } => {
  const i = id.indexOf(SESSION_SEP);
  return i < 0 || id === "group"
    ? { sessionId: null, cardId: id }
    : { sessionId: id.slice(0, i), cardId: id.slice(i + 1) };
};

/**
 * Several Claude Code sessions (CLIs) on one map: one "project" card on top, then each session's own tree
 * (prompt → main agent → subagents → tools). Card ids are prefixed with the session id.
 */
export function combineModels(
  parts: { sessionId: string; label: string; model: LiveModel }[],
  opts: { title: string; now: number },
): LiveModel {
  const p = (sid: string, id: string) => sid + SESSION_SEP + id;
  const runningSessions = parts.filter((x) => x.model.running.length > 0 || LOOK[x.model.mainState] === "running");
  const cards: Card[] = [
    {
      id: "group",
      kind: "group",
      parentId: null,
      label: "PROJECT",
      title: opts.title,
      look: runningSessions.length ? "running" : "done",
      startedAt: Math.min(...parts.map((x) => x.model.session.startedAt ?? opts.now)),
      endedAt: null,
      lines: [
        `${parts.length} sessions · ${runningSessions.length ? `${runningSessions.length} working` : "all quiet"}`,
      ],
      eventIds: [],
    },
  ];
  const edges: Edge[] = [];
  const running: RunningChip[] = [];
  for (const { sessionId: sid, label, model } of parts) {
    for (const c of model.cards) {
      const card: Card = {
        ...c,
        id: p(sid, c.id),
        parentId: c.parentId ? p(sid, c.parentId) : "group",
        sessionId: sid,
        ...(c.foldId ? { foldId: p(sid, c.foldId) } : {}),
        ...(c.folded ? { folded: c.folded.map((f) => ({ ...f, id: p(sid, f.id) })) } : {}),
      };
      if (c.kind === "prompt") card.label = `PROMPT · ${label}`;
      if (c.kind === "agent") card.title = `Main agent · ${label}`;
      cards.push(card);
    }
    for (const e of model.edges)
      edges.push({ ...e, id: p(sid, e.id), source: p(sid, e.source), target: p(sid, e.target) });
    const prompt = model.cards.find((c) => c.kind === "prompt");
    if (prompt)
      edges.push({ id: `group->${p(sid, prompt.id)}`, source: "group", target: p(sid, prompt.id), running: false });
    for (const r of model.running) running.push({ ...r, cardId: p(sid, r.cardId), label: `${label} · ${r.label}` });
  }
  const working = runningSessions.length;
  const models = new Set(parts.map((x) => x.model.session.model).filter(Boolean));
  return {
    cards,
    edges,
    running,
    mainState: working
      ? "Working"
      : parts.some((x) => x.model.mainState === "Waiting for you")
        ? "Waiting for you"
        : "Idle",
    session: {
      progress: working
        ? { value: null, label: `${working} of ${parts.length} working` }
        : { value: 1, label: `All ${parts.length} quiet` },
      model: models.size === 1 ? [...models][0] : models.size ? `${models.size} models` : null,
      tokens: parts.reduce((n, x) => n + x.model.session.tokens, 0),
      events: parts.reduce((n, x) => n + x.model.session.events, 0),
      startedAt: parts.reduce<number | null>(
        (m, x) => (x.model.session.startedAt == null ? m : Math.min(m ?? Infinity, x.model.session.startedAt)),
        null,
      ),
    },
    now: opts.now,
  };
}

/** Average duration (first to last event) of finished subagents by name, for the no-plan ETA. */
export function subagentAverages(events: AgentEvent[], now: number): Record<string, number> {
  const spans = new Map<string, { name: string; first: number; last: number }>();
  for (const e of events) {
    if (e.agent_key === "main" || e.agent_key.startsWith("agent:")) continue;
    const k = e.session_id + "|" + e.agent_key;
    const s = spans.get(k);
    if (!s) spans.set(k, { name: e.agent_name, first: e.created_at, last: e.created_at });
    else {
      s.first = Math.min(s.first, e.created_at);
      s.last = Math.max(s.last, e.created_at);
    }
  }
  const sums = new Map<string, { total: number; n: number }>();
  for (const s of spans.values()) {
    if (now - s.last < 2 * MIN) continue;
    const a = sums.get(s.name) ?? { total: 0, n: 0 };
    a.total += s.last - s.first;
    a.n++;
    sums.set(s.name, a);
  }
  return Object.fromEntries([...sums].map(([k, v]) => [k, v.total / v.n]));
}
