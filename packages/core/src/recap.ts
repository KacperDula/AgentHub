import type { AgentEvent, Todo, TodoSnapshot } from "./types";
import { promptText, userPrompts } from "./prompts";
import { relPath } from "./summary";
import { clip, obj, oneLine, str } from "./util";

// ---- "Explain": what happened in a session, turn by turn, built from the logs only ----

export interface RecapCommand {
  cmd: string;
  ok: boolean | null;
}

export interface RecapTurn {
  at: number;
  prompt: string;
  durationMs: number;
  subagents: { name: string; task: string; durationMs: number | null; status: string | null }[];
  tools: Record<string, number>;
  edited: string[];
  created: string[];
  reads: number;
  searches: number;
  commands: RecapCommand[];
  web: string[];
  errors: number;
  /** The last thing the main agent said in this turn. */
  answer: string;
}

export interface SessionRecap {
  session_id: string;
  cwd: string;
  startedAt: number | null;
  endedAt: number | null;
  tokens: number;
  turns: RecapTurn[];
  totals: {
    prompts: number;
    steps: number;
    errors: number;
    subagents: number;
    edited: string[];
    commands: number;
    failedCommands: number;
  };
  plan: Todo[] | null;
}

const EDIT = new Set(["Edit", "MultiEdit", "NotebookEdit"]);

export function sessionRecap(events: AgentEvent[], todos: TodoSnapshot[] = [], cwd = ""): SessionRecap {
  const sorted = [...events].sort((a, b) => a.created_at - b.created_at);
  const prompts = userPrompts(sorted);
  const results = new Map(
    sorted.filter((e) => e.event_type === "tool_result" && e.tool_use_id).map((e) => [e.tool_use_id!, e]),
  );
  const rel = (p: string) => relPath(p.replace(/\\/g, "/"), cwd.replace(/\\/g, "/"));

  const turnFor = (from: number, to: number, prompt: string): RecapTurn => {
    const inTurn = sorted.filter((e) => e.created_at >= from && e.created_at < to);
    const t: RecapTurn = {
      at: from,
      prompt,
      durationMs: inTurn.length ? inTurn[inTurn.length - 1].created_at - from : 0,
      subagents: [],
      tools: {},
      edited: [],
      created: [],
      reads: 0,
      searches: 0,
      commands: [],
      web: [],
      errors: 0,
      answer: "",
    };
    const edited = new Set<string>();
    const created = new Set<string>();
    for (const e of inTurn) {
      if (e.event_type === "tool_result" && e.status === "error") t.errors++;
      if (e.event_type === "assistant_text" && e.agent_key === "main")
        t.answer = clip(str(e.payload.text) || e.summary, 700);
      if (e.event_type === "subagent_spawn")
        t.subagents.push({
          name: str(e.payload.subagent_name) || "subagent",
          task: oneLine(str(e.payload.description) || e.summary, 120),
          durationMs: e.duration_ms,
          status: e.status,
        });
      if (e.event_type !== "tool_call" || !e.tool_name) continue;
      t.tools[e.tool_name] = (t.tools[e.tool_name] ?? 0) + 1;
      const input = obj(e.payload.input);
      const file = str(input.file_path) || str(input.notebook_path);
      if (EDIT.has(e.tool_name) && file) edited.add(rel(file));
      else if (e.tool_name === "Write" && file) created.add(rel(file));
      else if (e.tool_name === "Read") t.reads++;
      else if (e.tool_name === "Grep" || e.tool_name === "Glob") t.searches++;
      else if (e.tool_name === "WebFetch" || e.tool_name === "WebSearch")
        t.web.push(oneLine(str(input.url) || str(input.query), 100));
      else if ((e.tool_name === "Bash" || e.tool_name === "PowerShell") && t.commands.length < 12) {
        const r = e.tool_use_id ? results.get(e.tool_use_id) : undefined;
        t.commands.push({
          cmd: oneLine(str(input.command), 140),
          ok: e.status === "running" ? null : r ? r.status !== "error" : e.status !== "error",
        });
      }
    }
    t.edited = [...edited];
    t.created = [...created].filter((f) => !edited.has(f));
    return t;
  };

  const turns: RecapTurn[] = [];
  const first = sorted[0]?.created_at ?? null;
  // Work logged before the first prompt we have (e.g. a resumed session).
  if (first != null && (!prompts.length || prompts[0].created_at > first)) {
    const t = turnFor(first, prompts[0]?.created_at ?? Infinity, "");
    if (Object.keys(t.tools).length || t.subagents.length || t.answer) turns.push(t);
  }
  prompts.forEach((p, i) =>
    turns.push(turnFor(p.created_at, prompts[i + 1]?.created_at ?? Infinity, clip(promptText(p).trim(), 1500))),
  );

  const main = todos.filter((t) => t.agent_key === "main").sort((a, b) => a.created_at - b.created_at);
  const allCommands = turns.flatMap((t) => t.commands);
  return {
    session_id: sorted[0]?.session_id ?? "",
    cwd,
    startedAt: first,
    endedAt: sorted.at(-1)?.created_at ?? null,
    tokens: sorted.reduce((n, e) => n + (e.input_tokens ?? 0) + (e.output_tokens ?? 0), 0),
    turns,
    totals: {
      prompts: prompts.length,
      steps: sorted.filter((e) => e.event_type === "tool_call" || e.event_type === "subagent_spawn").length,
      errors: turns.reduce((n, t) => n + t.errors, 0),
      subagents: turns.reduce((n, t) => n + t.subagents.length, 0),
      edited: [...new Set(turns.flatMap((t) => [...t.edited, ...t.created]))],
      commands: allCommands.length,
      failedCommands: allCommands.filter((c) => c.ok === false).length,
    },
    plan: main.at(-1)?.todos ?? null,
  };
}

/** The recap trimmed for the AI: prompts, actions, file paths and the agent's short answers. No tool outputs. */
export function explainPayload(recap: SessionRecap, notes?: string) {
  return {
    session: {
      duration_min: recap.startedAt && recap.endedAt ? Math.round((recap.endedAt - recap.startedAt) / 60_000) : 0,
      tokens: recap.tokens,
      totals: recap.totals,
      plan: recap.plan?.map((t) => `${t.status}: ${t.content}`) ?? null,
    },
    turns: recap.turns.slice(-25).map((t) => ({
      you_asked: clip(t.prompt, 800),
      subagents: t.subagents.map((s) => `${s.name}: ${s.task}${s.status === "error" ? " [failed]" : ""}`),
      tools: t.tools,
      edited: t.edited.slice(0, 20),
      created: t.created.slice(0, 20),
      commands: t.commands.map((c) => c.cmd + (c.ok === false ? " [failed]" : "")),
      errors: t.errors,
      agent_answer: clip(t.answer, 400),
    })),
    ...(notes ? { user_notes: notes } : {}),
  };
}

export function buildExplainPrompt(payload: ReturnType<typeof explainPayload>): string {
  return [
    "You explain to a developer, in plain language, what happened in one of their Claude Code sessions (Claude Code is Anthropic's CLI coding agent).",
    "Below is JSON built from the session logs: each turn has what the user asked, the subagents and tools the agent used, the files it edited, the commands it ran and its last answer. There are no file contents or tool outputs.",
    "user_notes, if present, are the developer's own notes about their goals and preferences: use them to make the explanation relevant to them.",
    "",
    "Write the explanation in the same language the user wrote their prompts in.",
    "Reply in Markdown, under 450 words, with these sections:",
    "## In short — 2 or 3 sentences: what you asked for and whether it got done.",
    "## Step by step — one bullet per turn: what you asked, what the agent did (name subagents and files), how it ended.",
    "## What went wrong — failed commands, errors, corrections, and the likely reason. Write 'Nothing major.' if so.",
    "## What to do next — 2 to 4 concrete next steps, including a better prompt if a turn was misunderstood.",
    "",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}
