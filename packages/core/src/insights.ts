import type { AgentEvent } from "./types";
import type { PromptReview, PromptStats } from "./prompts";
import { mcpParts } from "./summary";
import { clip, fmtDuration, obj, str } from "./util";

export type Severity = "high" | "medium" | "low";

export interface Signal {
  id: string;
  session_id: string;
  kind: string;
  severity: Severity;
  title: string;
  detail: string;
  numbers: Record<string, number | string>;
  /** Copyable text that applies the advice (a prompt line, a CLAUDE.md line…). */
  fix?: string;
}

const MIN = 60_000;
const CORRECTION = /^(no|nope|stop|wrong|όχι|οχι|λάθος|λαθος|σταμάτα|σταματα)(?!\p{L})/iu;
const isCall = (e: AgentEvent) => e.event_type === "tool_call" || e.event_type === "subagent_spawn";

export function isCorrection(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= 40 && CORRECTION.test(t);
}

/** Rule-based signals for one session. Free, local, always on. */
export function sessionSignals(events: AgentEvent[], now: number, averages: Record<string, number> = {}): Signal[] {
  const sid = events[0]?.session_id ?? "";
  const out: Signal[] = [];
  const add = (kind: string, key: string, s: Omit<Signal, "id" | "session_id" | "kind">) =>
    out.push({ id: `${sid}:${kind}:${key}`, session_id: sid, kind, ...s });

  // Same Bash command 3+ times in a row (per agent).
  const byAgent = new Map<string, AgentEvent[]>();
  for (const e of events)
    if (e.event_type === "tool_call")
      (byAgent.get(e.agent_key) ?? byAgent.set(e.agent_key, []).get(e.agent_key)!).push(e);
  const repeats = new Map<string, number>();
  for (const calls of byAgent.values()) {
    let prev = "";
    let run = 0;
    for (const c of calls) {
      if (c.tool_name !== "Bash" && c.tool_name !== "PowerShell") continue;
      const cmd = str(c.payload.input?.command).trim();
      run = cmd && cmd === prev ? run + 1 : 1;
      prev = cmd;
      if (run >= 3) repeats.set(cmd, Math.max(repeats.get(cmd) ?? 0, run));
    }
  }
  for (const [cmd, n] of repeats)
    add("repeated-command", cmd, {
      severity: n >= 5 ? "high" : "medium",
      title: `Same command ran ${n} times in a row`,
      detail: clip(cmd, 160),
      numbers: { times: n },
    });

  // Tool error rate above 20%.
  const results = events.filter((e) => e.event_type === "tool_result" && !e.payload.background);
  const errors = results.filter((e) => e.status === "error");
  if (results.length >= 5 && errors.length / results.length > 0.2) {
    const byTool = new Map<string, number>();
    for (const e of errors) byTool.set(e.tool_name ?? "?", (byTool.get(e.tool_name ?? "?") ?? 0) + 1);
    const worst = [...byTool].sort((a, b) => b[1] - a[1])[0];
    const rate = errors.length / results.length;
    add("error-rate", "all", {
      severity: rate > 0.4 ? "high" : "medium",
      title: `Tool error rate ${Math.round(rate * 100)}%`,
      detail: `${errors.length} of ${results.length} tool calls failed; most failures: ${worst[0]} (${worst[1]}).`,
      numbers: { errors: errors.length, total: results.length, rate: Math.round(rate * 100) },
    });
  }

  // Same file read 3+ times.
  const reads = new Map<string, number>();
  for (const e of events)
    if (e.event_type === "tool_call" && e.tool_name === "Read") {
      const p = str(e.payload.input?.file_path);
      if (p) reads.set(p, (reads.get(p) ?? 0) + 1);
    }
  for (const [p, n] of [...reads]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3))
    add("repeated-read", p, {
      severity: n >= 6 ? "medium" : "low",
      title: `Same file read ${n} times`,
      detail: clip(p, 160),
      numbers: { times: n },
    });

  // A single step over 50k input tokens.
  const big = events.filter((e) => (e.input_tokens ?? 0) > 50_000);
  if (big.length) {
    const max = Math.max(...big.map((e) => e.input_tokens!));
    add("large-step", "all", {
      severity: max > 150_000 ? "high" : "medium",
      title: `${big.length} step${big.length > 1 ? "s" : ""} over 50k input tokens`,
      detail: `Largest step: ${Math.round(max / 1000)}k input tokens. Large contexts are slow and costly.`,
      numbers: { steps: big.length, max_tokens: max },
    });
  }

  // Short user corrections.
  const corrections = events.filter(
    (e) => e.event_type === "user_prompt" && !e.is_subagent && isCorrection(str(e.payload.text) || e.summary),
  );
  if (corrections.length)
    add("corrections", "all", {
      severity: corrections.length >= 3 ? "medium" : "low",
      title: `${corrections.length} short correction${corrections.length > 1 ? "s" : ""} from you`,
      detail: `Messages like "${clip(corrections[0].summary, 40)}" usually mean the agent went the wrong way.`,
      numbers: { corrections: corrections.length },
    });

  // Background work that never reported back.
  const last = events.at(-1)?.created_at ?? now;
  const lost = events.filter(
    (e) =>
      isCall(e) &&
      e.status === "running" &&
      e.payload.background &&
      (now - e.created_at > 60 * MIN || now - last > 30 * MIN),
  );
  if (lost.length)
    add("lost-background", "all", {
      severity: "medium",
      title: `${lost.length} background task${lost.length > 1 ? "s" : ""} never reported back`,
      detail: lost
        .slice(0, 3)
        .map((e) => clip(e.summary, 80))
        .join(" · "),
      numbers: { tasks: lost.length },
    });

  // Subagents much slower than their own average.
  for (const a of agentSpans(events)) {
    const avg = averages[a.name];
    if (!avg || a.key === "main" || a.duration < MIN || a.duration < 2 * avg) continue;
    add("slow-subagent", a.key, {
      severity: a.duration > 4 * avg ? "medium" : "low",
      title: `${a.name} took ${(a.duration / avg).toFixed(1)}× its usual time`,
      detail: `${fmtDuration(a.duration)} vs an average of ${fmtDuration(avg)}.`,
      numbers: { duration_ms: a.duration, average_ms: Math.round(avg) },
    });
  }

  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

interface Span {
  key: string;
  name: string;
  first: number;
  last: number;
  duration: number;
  tokens: number;
  ok: boolean;
}

function agentSpans(events: AgentEvent[]): Span[] {
  const spans = new Map<string, Span>();
  const spawnStatus = new Map<string, string | null>();
  for (const e of events)
    if (e.event_type === "subagent_spawn" && e.tool_use_id) spawnStatus.set(e.tool_use_id, e.status);
  for (const e of events) {
    const s = spans.get(e.agent_key);
    const tk = (e.input_tokens ?? 0) + (e.output_tokens ?? 0);
    if (!s)
      spans.set(e.agent_key, {
        key: e.agent_key,
        name: e.agent_name,
        first: e.created_at,
        last: e.created_at,
        duration: 0,
        tokens: tk,
        ok: true,
      });
    else {
      s.last = Math.max(s.last, e.created_at);
      s.tokens += tk;
    }
  }
  for (const s of spans.values()) {
    s.duration = s.last - s.first;
    s.ok = spawnStatus.get(s.key) !== "error";
  }
  return [...spans.values()];
}

// ---- usage profile: aggregates only, never raw contents ----

export interface UsageProfile {
  sessions: number;
  events: number;
  tokensIn: number;
  tokensOut: number;
  tools: Record<string, number>;
  mcpServers: Record<string, number>;
  failingCommands: Record<string, number>;
  files: Record<string, number>;
  folders: Record<string, number>;
  taskTypes: Record<string, { n: number; tokens: number; durationMs: number }>;
  subagents: Record<string, { n: number; failed: number }>;
  hours: number[];
}

export const emptyProfile = (): UsageProfile => ({
  sessions: 0,
  events: 0,
  tokensIn: 0,
  tokensOut: 0,
  tools: {},
  mcpServers: {},
  failingCommands: {},
  files: {},
  folders: {},
  taskTypes: {},
  subagents: {},
  hours: Array(24).fill(0),
});

const bump = (r: Record<string, number>, k: string, n = 1) => {
  if (k) r[k] = (r[k] ?? 0) + n;
};

/** Aggregates of one session's events. `hourOf` maps a timestamp to the local hour (0–23). */
export function sessionProfile(events: AgentEvent[], hourOf: (ts: number) => number): UsageProfile {
  const p = emptyProfile();
  p.sessions = events.length ? 1 : 0;
  p.events = events.length;
  const calls = new Map<string, AgentEvent>();
  for (const e of events) {
    p.tokensIn += e.input_tokens ?? 0;
    p.tokensOut += e.output_tokens ?? 0;
    p.hours[hourOf(e.created_at)]++;
    if (isCall(e) && e.tool_name) {
      if (e.tool_use_id) calls.set(e.tool_use_id, e);
      bump(p.tools, e.tool_name);
      const mcp = mcpParts(e.tool_name);
      if (mcp) bump(p.mcpServers, mcp.server);
      if (e.tool_name === "Read") {
        const path = str(e.payload.input?.file_path);
        bump(p.files, path);
        bump(p.folders, path.split(/[\\/]/).slice(0, -1).join("/"));
      }
    }
    if (e.event_type === "tool_result" && e.status === "error" && e.tool_use_id) {
      const c = calls.get(e.tool_use_id);
      if (c?.tool_name === "Bash") bump(p.failingCommands, clip(str(obj(c.payload.input).command).trim(), 120));
    }
  }
  for (const s of agentSpans(events)) {
    const type = s.key === "main" ? "main session" : s.name;
    const t = (p.taskTypes[type] ??= { n: 0, tokens: 0, durationMs: 0 });
    t.n++;
    t.tokens += s.tokens;
    t.durationMs += s.duration;
    if (s.key !== "main") {
      const sa = (p.subagents[s.name] ??= { n: 0, failed: 0 });
      sa.n++;
      if (!s.ok) sa.failed++;
    }
  }
  return p;
}

const top = (r: Record<string, number>, n = 50) =>
  Object.fromEntries(
    Object.entries(r)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n),
  );

export function mergeProfiles(a: UsageProfile, b: UsageProfile): UsageProfile {
  const m = (x: Record<string, number>, y: Record<string, number>) => {
    const r = { ...x };
    for (const [k, v] of Object.entries(y)) bump(r, k, v);
    return top(r, 200);
  };
  const taskTypes = { ...a.taskTypes };
  for (const [k, v] of Object.entries(b.taskTypes)) {
    const t = (taskTypes[k] = { ...(taskTypes[k] ?? { n: 0, tokens: 0, durationMs: 0 }) });
    t.n += v.n;
    t.tokens += v.tokens;
    t.durationMs += v.durationMs;
  }
  const subagents = { ...a.subagents };
  for (const [k, v] of Object.entries(b.subagents)) {
    const s = (subagents[k] = { ...(subagents[k] ?? { n: 0, failed: 0 }) });
    s.n += v.n;
    s.failed += v.failed;
  }
  return {
    sessions: a.sessions + b.sessions,
    events: a.events + b.events,
    tokensIn: a.tokensIn + b.tokensIn,
    tokensOut: a.tokensOut + b.tokensOut,
    tools: m(a.tools, b.tools),
    mcpServers: m(a.mcpServers, b.mcpServers),
    failingCommands: m(a.failingCommands, b.failingCommands),
    files: m(a.files, b.files),
    folders: m(a.folders, b.folders),
    taskTypes,
    subagents,
    hours: a.hours.map((h, i) => h + (b.hours[i] ?? 0)),
  };
}

/** The profile trimmed for storage and for the AI payload. */
export const compactProfile = (p: UsageProfile): UsageProfile => ({
  ...p,
  tools: top(p.tools, 25),
  mcpServers: top(p.mcpServers, 15),
  failingCommands: top(p.failingCommands, 15),
  files: top(p.files, 15),
  folders: top(p.folders, 15),
});

// ---- AI layer: payload and prompt (the call itself happens in the desktop app) ----

export interface SessionOutline {
  session_id: string;
  agents: { agent: string; durationMs: number; tools: Record<string, number>; steps: string[] }[];
}

/** Tool names, counts, durations and short summaries. No file contents, no tool outputs. */
export function sessionOutline(events: AgentEvent[]): SessionOutline {
  const agents = new Map<string, SessionOutline["agents"][number] & { first: number; last: number }>();
  for (const e of events) {
    let a = agents.get(e.agent_key);
    if (!a) {
      a = {
        agent: e.agent_key === "main" ? "main" : e.agent_name,
        durationMs: 0,
        tools: {},
        steps: [],
        first: e.created_at,
        last: e.created_at,
      };
      agents.set(e.agent_key, a);
    }
    a.last = Math.max(a.last, e.created_at);
    if (isCall(e) && e.tool_name) {
      bump(a.tools, e.tool_name);
      if (a.steps.length < 40) a.steps.push(clip(e.summary, 80) + (e.status === "error" ? " [failed]" : ""));
    } else if (e.event_type === "tool_result" && e.status === "error" && a.steps.length) {
      if (!a.steps[a.steps.length - 1].endsWith("[failed]")) a.steps[a.steps.length - 1] += " [failed]";
    }
  }
  return {
    session_id: events[0]?.session_id ?? "",
    agents: [...agents.values()].map(({ first, last, ...a }) => ({ ...a, durationMs: last - first })),
  };
}

export interface Vote {
  title: string;
  vote: 1 | -1;
}

export type AnalysisScope = "session" | "overall" | "prompts" | "files";

/** A file the user chose for prompt coaching: CLAUDE.md, an agent or command definition, a prompt template… */
export interface CoachFile {
  name: string;
  text: string;
}

/** One prompt as sent to the AI prompt coach: the text the user typed, the rule findings and what happened. */
export interface PromptSample {
  text: string;
  issues: string[];
  corrected: boolean;
  interrupted: boolean;
  steps: number;
  errors: number;
}

export interface AnalysisPayload {
  scope: AnalysisScope;
  signals: Omit<Signal, "id" | "session_id">[];
  profile: UsageProfile;
  outline?: SessionOutline;
  prompts?: PromptSample[];
  prompt_stats?: PromptStats;
  /** Files the user chose to have coached, with their contents. */
  files?: CoachFile[];
  /** The user's own notes and learnings file, as written in their notes folder. */
  user_notes?: string;
  past_feedback: Vote[];
}

export const promptSamples = (reviews: PromptReview[], max = 40): PromptSample[] =>
  reviews.slice(0, max).map((r) => ({
    text: clip(r.text, 500),
    issues: r.issues.map((i) => i.kind),
    corrected: r.outcome.corrected,
    interrupted: r.outcome.interrupted,
    steps: r.outcome.steps,
    errors: r.outcome.errors,
  }));

export function buildAnalysisPayload(
  scope: AnalysisScope,
  signals: Signal[],
  profile: UsageProfile,
  votes: Vote[],
  outline?: SessionOutline,
  extra: { prompts?: PromptReview[]; promptStats?: PromptStats; notes?: string; files?: CoachFile[] } = {},
): AnalysisPayload {
  return {
    scope,
    signals: signals.map(({ id: _id, session_id: _sid, ...s }) => s),
    profile: compactProfile(profile),
    ...(outline ? { outline } : {}),
    ...(extra.prompts?.length ? { prompts: promptSamples(extra.prompts) } : {}),
    ...(extra.promptStats ? { prompt_stats: extra.promptStats } : {}),
    ...(extra.files?.length ? { files: extra.files } : {}),
    ...(extra.notes ? { user_notes: extra.notes } : {}),
    past_feedback: votes.slice(-30),
  };
}

const SUGGESTION_SHAPE =
  '{"severity":"high|medium|low","title":"short title","why":"the reason, citing the numbers or quoting the prompt","fix_kind":"prompt|subagent|claude_md|settings_json|slash_command|usage","fix":"copyable text: a rewritten prompt, how to call a subagent, a CLAUDE.md line, a settings.json snippet or a slash command"}';

export function buildAnalysisPrompt(payload: AnalysisPayload): string {
  const notes = payload.user_notes
    ? [
        "user_notes are the developer's own notes (goals, preferences, lessons) and their learnings file: respect them and tailor the advice to them.",
      ]
    : [];
  if (payload.scope === "files")
    return [
      "You are a prompt coach for a developer who works with Claude Code (Anthropic's CLI coding agent) and its subagents.",
      "They chose the files below to be coached: instructions and prompts they give the agent, such as CLAUDE.md, agent or subagent definitions, slash commands, skills or prompt templates. The JSON also has their prompt statistics, rule-based signals and an aggregate usage profile.",
      ...notes,
      "past_feedback lists earlier suggestions the user rated: 1 = useful, -1 = not useful. Do more of what they liked, avoid repeating what they disliked.",
      "",
      "For each file, find what is unclear, contradictory, too vague, too long or missing for the agent (goals, scope, when the work is done, what not to touch, when to use which subagent), explain why it matters, and give a rewritten version of that part. Name the file in the title.",
      "Write title, why and fix in the same language the file is written in.",
      "",
      "Reply with ONLY a JSON array of 3 to 8 objects, no prose, each:",
      SUGGESTION_SHAPE,
      "",
      JSON.stringify(payload, null, 2),
    ].join("\n");
  if (payload.scope === "prompts")
    return [
      "You are a prompt coach for a developer who works with Claude Code (Anthropic's CLI coding agent) and its subagents.",
      "Below is JSON with their recent prompts (newest first), the issues local rules found in each (misread = the agent got it wrong and the user had to correct or stop it; vague; short-start; many-asks; no-done; wall), what happened after each prompt, prompt statistics, rule-based signals and an aggregate usage profile. There are no file contents or tool outputs.",
      ...notes,
      "past_feedback lists earlier suggestions the user rated: 1 = useful, -1 = not useful. Do more of what they liked, avoid repeating what they disliked.",
      "",
      "Find the patterns that make their prompts unclear to the agent, explain why, and show how to write them better. Also say which subagents they should run and when (for example Explore for searching, a code reviewer after big changes, a test runner for test-fix loops, parallel subagents for independent tasks), and how to use Claude Code more efficiently.",
      "Write title, why and fix in the same language the user writes their prompts in.",
      "For prompt problems, quote a short part of a real prompt in why and put a rewritten version of that prompt in fix.",
      "",
      "Reply with ONLY a JSON array of 4 to 8 objects, no prose, each:",
      SUGGESTION_SHAPE,
      "",
      JSON.stringify(payload, null, 2),
    ].join("\n");
  return [
    "You review how a developer uses Claude Code (Anthropic's CLI coding agent) and suggest concrete setup improvements.",
    "Below is JSON with rule-based signals, an aggregate usage profile" +
      (payload.outline ? ", and a compact outline of one session" : "") +
      ". It has no file contents or tool outputs.",
    ...notes,
    "past_feedback lists earlier suggestions the user rated: 1 = useful, -1 = not useful. Do more of what they liked, avoid repeating what they disliked.",
    "",
    "Reply with ONLY a JSON array of 3 to 6 objects, no prose, each:",
    SUGGESTION_SHAPE,
    "",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

// ---- learnings: the AI distills the user's notes and habits into a personal file ----

export interface LearnPayload {
  user_notes: string;
  prompt_stats: PromptStats;
  prompts: PromptSample[];
  profile: UsageProfile;
  signals: Omit<Signal, "id" | "session_id">[];
  past_feedback: Vote[];
}

export function buildLearnPayload(
  notes: string,
  stats: PromptStats,
  reviews: PromptReview[],
  profile: UsageProfile,
  signals: Signal[],
  votes: Vote[],
): LearnPayload {
  return {
    user_notes: notes,
    prompt_stats: stats,
    prompts: promptSamples(reviews, 25),
    profile: compactProfile(profile),
    signals: signals.slice(0, 30).map(({ id: _id, session_id: _sid, ...s }) => s),
    past_feedback: votes.slice(-30),
  };
}

export function buildLearnPrompt(payload: LearnPayload): string {
  return [
    "You keep a personal learnings file for one developer who works with Claude Code (Anthropic's CLI coding agent).",
    "Below is JSON with their own notes (and the previous learnings file, if any), statistics and samples of their prompts with the issues local rules found, an aggregate usage profile, rule-based signals, and the suggestions they rated (1 = useful, -1 = not useful).",
    "Write the new learnings file: keep what is still true from the previous one, add what the new data shows, drop what no longer applies.",
    'Write it in the first person ("I…") as the developer\'s own notes, in the language most of their notes and prompts are written in.',
    "Reply with ONLY Markdown, under 400 words, with these sections:",
    "## What I work on",
    "## How I like to work",
    "## Mistakes I keep making — with numbers from the data",
    "## My prompt checklist — 5 to 8 short bullets",
    "## Subagents that fit my work — which ones and when",
    "",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

export interface Suggestion {
  severity: Severity;
  title: string;
  why: string;
  fix_kind: string;
  fix: string;
}

/** Extracts the suggestions array from a model reply (tolerates code fences and surrounding prose). */
export function parseSuggestions(text: string): Suggestion[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("The model reply had no JSON array.");
  const arr = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new Error("The model reply was not a JSON array.");
  const sev = new Set(["high", "medium", "low"]);
  return arr
    .map((x) => obj(x))
    .filter((x) => str(x.title))
    .slice(0, 8)
    .map((x) => ({
      severity: (sev.has(x.severity) ? x.severity : "medium") as Severity,
      title: clip(str(x.title), 160),
      why: clip(str(x.why), 1000),
      fix_kind: str(x.fix_kind) || "prompt",
      fix: clip(str(x.fix), 4000),
    }));
}
