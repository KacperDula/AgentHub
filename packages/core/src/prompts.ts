import type { AgentEvent } from "./types";
import { isCorrection, type Severity, type Signal } from "./insights";
import { clip, obj, oneLine, str } from "./util";

// ---- prompt coach: what makes a prompt hard for the agent to follow (local rules, free) ----

export interface PromptIssue {
  kind: string;
  severity: Severity;
  title: string;
  /** Why the agent finds this unclear. */
  why: string;
  /** How to write it better. */
  how: string;
}

export interface PromptOutcome {
  /** Tool calls and subagent launches until the next prompt. */
  steps: number;
  errors: number;
  subagents: number;
  /** The next message was a short correction ("no", "wrong", "όχι"…). */
  corrected: boolean;
  /** The user stopped the agent while it worked on this prompt. */
  interrupted: boolean;
  durationMs: number;
}

export interface PromptReview {
  /** source_uuid of the prompt event. */
  id: string;
  session_id: string;
  created_at: number;
  text: string;
  words: number;
  severity: Severity | null;
  issues: PromptIssue[];
  outcome: PromptOutcome;
  /** A fill-in structure for a clearer version, when there are issues. */
  better: string | null;
}

export interface PromptStats {
  prompts: number;
  withIssues: number;
  corrected: number;
  interrupted: number;
  avgWords: number;
  issues: Record<string, number>;
}

const INTERRUPTED = /^\[Request interrupted by user/;
const MISREAD =
  /^(no|nope|wrong|not that|that'?s not|that is not|i said|i meant|undo|revert|όχι|οχι|λάθος|λαθος|δεν εννοούσα|δεν εννοουσα|είπα|ειπα|ξαναδιάβασε)(?!\p{L})/iu;
const VAGUE =
  // (?!\p{L}) instead of \b in the Greek part: \b only knows Latin letters.
  /\b(fix (it|this|that)|make it (work|better|nicer|good)|does ?n[o']?t work|not working|is broken|improve (it|this|that)|clean (it |this )?up|do the (rest|thing)|something like that|whatever works)\b|(φτι[άα]ξ[εέ]? ?τ[οα](?!\p{L})|δεν δουλε[υύ]ει|δε δουλε[υύ]ει|δεν λειτουργε[ίι]|χαλασμ[εέ]ν|βελτ[ίι]ωσ[εέ] ?τ[οα](?!\p{L})|κ[άα]ν[εέ]? ?τ[οα] (καλ[υύ]τερ|ωρα[ίι]|να δουλε)|κ[άα]τι τ[έε]τοιο|διορθ[ωώ]σ[εέ] ?τ[οα](?!\p{L}))/iu;
const ANCHOR = [
  /`[^`]+`/, // code in backticks
  /\b[\w-]+\.(tsx?|jsx?|mjs|cjs|py|rb|go|rs|java|kt|cs|cpp|c|h|swift|php|md|json|ya?ml|toml|css|scss|html|sql|sh|ps1|xml|env|lock)\b/i,
  /[\\/][\w.-]+[\\/]/, // a path
  /https?:\/\//,
  /\b(error|exception|traceback|stack trace|exit code|line \d+|TypeError|ReferenceError|undefined is not)\b/i,
  /\b[a-z]+[A-Z][A-Za-z0-9]+\b/, // camelCase identifier
  /\b[a-z0-9]+_[a-z0-9_]+\b/, // snake_case identifier
  /"[^"]{3,}"|«[^»]{3,}»|“[^”]{3,}”/, // a quoted message or label
];
const ACTION =
  /\b(add|implement|build|create|make|refactor|change|update|write|fix|redesign|migrate|remove|replace)\b|(πρ[οό]σθεσ|φτι[άα]ξ|υλοπο[ίι]ησ|δημιο[υύ]ργησ|[άα]λλαξ|γρ[άα]ψ|θ[έε]λω (να|ν'|και)|θ[έε]λουμε|κ[άα]νε |βγ[άα]λε|αφα[ίι]ρεσ|ξαναφτι[άα]ξ)/iu;
const CRITERIA =
  /\b(should|must|so that|expect(ed)?|tests?|passes|pass|until|acceptance|done when|make sure|ensure|verify|check that|without breaking|keep)\b|(πρ[έε]πει|[ώω]στε|να δουλε[υύ]ει [όο]ταν|να περν[άα]|τεστ|[έε]λεγξε|σιγουρ[έε]ψου|βεβαι[ώω]σου|χωρ[ίι]ς να|να μ[έε]νει|μ[όο]νο)/iu;
const MORE_ASKS =
  /\b(also|and then|additionally|as well as|plus|another thing)\b|(επ[ίι]σης|επιπλ[έε]ον|ακ[όο]μα|και μετ[άα]|και [άα]λλο)/giu;

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
const hasAnchor = (t: string) => ANCHOR.some((r) => r.test(t));
const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/**
 * Messages in the user's slot that a program wrote, not the user: Claude Code's own summary after the context ran
 * out, messages from other sessions or tools, and AgentTrace's own AI requests (when it uses `claude -p`).
 */
const MACHINE_PREFIX = [
  "This session is being continued from a previous conversation",
  "Below is a conversation log from a Claude Code",
  "You review how a developer uses Claude Code",
  "You are a prompt coach for a developer",
  "You explain to a developer, in plain language",
  "You keep a personal learnings file",
];
const MACHINE_TAG = /<(system-reminder|agent-message|task-notification|local-command-stdout|command-name)\b/;
export const isMachinePrompt = (text: string): boolean => {
  const t = text.trimStart();
  return INTERRUPTED.test(t) || MACHINE_PREFIX.some((p) => t.startsWith(p)) || MACHINE_TAG.test(t);
};

/** Prompts the user typed into the main agent (not subagent prompts, notices, summaries or interrupt markers). */
export function userPrompts(events: AgentEvent[]): AgentEvent[] {
  return events.filter((e) => e.event_type === "user_prompt" && !e.is_subagent && !isMachinePrompt(promptText(e)));
}

export const promptText = (e: AgentEvent): string => str(e.payload.text) || e.summary;

/** How many separate requests a prompt holds: list items plus "also / επίσης" joins. */
export function countAsks(text: string): number {
  const items = text.split("\n").filter((l) => /^\s*([-*•]|\d+[.)])\s+\S/.test(l)).length;
  const joins = (text.match(MORE_ASKS) ?? []).length;
  return Math.max(items, 0) + joins + (items ? 0 : 1);
}

/** Rule-based review of each prompt the user typed, with what happened next. */
export function reviewPrompts(events: AgentEvent[]): PromptReview[] {
  const sorted = [...events].sort((a, b) => a.created_at - b.created_at);
  const prompts = userPrompts(sorted);
  const interrupts = sorted.filter(
    (e) => e.event_type === "user_prompt" && !e.is_subagent && INTERRUPTED.test(promptText(e).trim()),
  );
  const out: PromptReview[] = [];

  prompts.forEach((p, i) => {
    const text = promptText(p).trim();
    const next = prompts[i + 1];
    const end = next?.created_at ?? Infinity;
    const inTurn = sorted.filter((e) => e.created_at > p.created_at && e.created_at < end);
    const nextText = next ? promptText(next).trim() : "";
    const corrected = !!next && (isCorrection(nextText) || (MISREAD.test(nextText) && words(nextText) <= 25));
    const interrupted = interrupts.some((x) => x.created_at > p.created_at && x.created_at < end);
    const outcome: PromptOutcome = {
      steps: inTurn.filter((e) => e.event_type === "tool_call" || e.event_type === "subagent_spawn").length,
      errors: inTurn.filter((e) => e.event_type === "tool_result" && e.status === "error").length,
      subagents: inTurn.filter((e) => e.event_type === "subagent_spawn").length,
      corrected,
      interrupted,
      durationMs: inTurn.length ? inTurn[inTurn.length - 1].created_at - p.created_at : 0,
    };

    const n = words(text);
    const issues: PromptIssue[] = [];
    const anchored = hasAnchor(text);
    const isReply = isCorrection(text) || n <= 3; // "yes", "go on", "run the build": replies, not new tasks

    if (corrected || interrupted)
      issues.push({
        kind: "misread",
        severity: "high",
        title: interrupted ? "You had to stop the agent" : "The agent misunderstood this",
        why: interrupted
          ? "You interrupted the agent while it worked on this, so it was heading the wrong way. Usually the goal, the place to work or the limits were not stated."
          : `Your next message was a correction ("${clip(nextText, 60)}"), so the agent did something you didn't want. Usually the goal, the place to work or the limits were not stated.`,
        how: "Say what you want changed, where, and what must stay as it is. If the task is open-ended, ask for a short plan first and approve it before any edits.",
      });

    if (!isReply && VAGUE.test(text) && !anchored)
      issues.push({
        kind: "vague",
        severity: "medium",
        title: "Unclear target",
        why: 'Words like "fix it", "doesn\'t work" or "make it better" without a file, screen, error message or example make the agent guess what is wrong and what "better" means.',
        how: "Name the file or screen, paste the exact error or output, and say what you expected to happen versus what happened.",
      });

    if (i === 0 && !isReply && n < 8 && !anchored)
      issues.push({
        kind: "short-start",
        severity: "low",
        title: "Very short first prompt",
        why: `The first prompt sets the context for the whole session. ${n} words leave the agent to guess the goal and the scope.`,
        how: "Start with the goal, where to work (folder, files, feature) and how you will check that it's done.",
      });

    const asks = countAsks(text);
    if (asks >= 3 && n >= 30)
      issues.push({
        kind: "many-asks",
        severity: "medium",
        title: `About ${asks} tasks in one prompt`,
        why: "When one message asks for several different things, the agent tends to do them in one pass, drop one, or mix them up, and it is hard to review the result.",
        how: "Number the tasks and ask for a plan first, or send them one at a time. Independent tasks can run as parallel subagents.",
      });

    // Questions are done when they are answered; this is about tasks.
    if (!isReply && n >= 25 && !text.includes("?") && ACTION.test(text) && !CRITERIA.test(text))
      issues.push({
        kind: "no-done",
        severity: "low",
        title: "No way to tell when it's done",
        why: "There is no expected result, test or check, so the agent decides on its own when to stop and may stop early or keep going.",
        how: 'Add a "Done when:" line: a test that passes, a command that succeeds, or what you should see on screen.',
      });

    if (n > 200 && !/\n\s*\n|\n\s*([-*•]|\d+[.)])\s/.test(text))
      issues.push({
        kind: "wall",
        severity: "low",
        title: "Long prompt without structure",
        why: `${n} words in one block hide the main ask among the details.`,
        how: "Put the main ask in the first line, then the context as short bullets.",
      });

    issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
    out.push({
      id: p.source_uuid,
      session_id: p.session_id,
      created_at: p.created_at,
      text: clip(text, 1200),
      words: n,
      severity: issues[0]?.severity ?? null,
      issues,
      outcome,
      better: issues.length ? betterPrompt(text) : null,
    });
  });
  return out;
}

/** A fill-in structure that keeps the user's own goal sentence. */
export function betterPrompt(text: string): string {
  const goal = oneLine(text.split(/(?<=[.!?;·])\s|\n/)[0] ?? text, 180);
  return [
    `Goal: ${goal}`,
    "Where: <files, screen or command — e.g. src/pages/Insights.tsx>",
    "Done when: <a test passes / what you should see>",
    "Don't touch: <what must stay as it is>",
    "First: show me a short plan before editing.",
  ].join("\n");
}

export function promptStats(reviews: Pick<PromptReview, "words" | "issues" | "outcome">[]): PromptStats {
  const issues: Record<string, number> = {};
  let total = 0;
  for (const r of reviews) {
    total += r.words;
    for (const i of r.issues) issues[i.kind] = (issues[i.kind] ?? 0) + 1;
  }
  return {
    prompts: reviews.length,
    withIssues: reviews.filter((r) => r.issues.length).length,
    corrected: reviews.filter((r) => r.outcome.corrected).length,
    interrupted: reviews.filter((r) => r.outcome.interrupted).length,
    avgWords: reviews.length ? Math.round(total / reviews.length) : 0,
    issues,
  };
}

// ---- which subagents to run (local rules, free) ----

const SEARCH_TOOLS = new Set(["Read", "Grep", "Glob", "LS"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const TEST_CMD =
  /\b(npm (run )?test|pnpm (run )?test|yarn test|vitest|jest|pytest|mocha|go test|cargo test|dotnet test|mvn test|gradle test|phpunit|rspec)\b/i;

/** Advice on subagents, from how the session actually ran. Kinds start with "subagent-". */
export function subagentAdvice(events: AgentEvent[], now: number): Signal[] {
  const sid = events[0]?.session_id ?? "";
  const out: Signal[] = [];
  const add = (kind: string, s: Omit<Signal, "id" | "session_id" | "kind">) =>
    out.push({ id: `${sid}:${kind}:all`, session_id: sid, kind, ...s });

  const main = events.filter((e) => e.agent_key === "main");
  const spawns = events.filter((e) => e.event_type === "subagent_spawn");
  const spawnNames = spawns.map((e) => str(e.payload.subagent_name) + " " + str(e.payload.description));
  const used = (re: RegExp) => spawnNames.some((n) => re.test(n));

  // The main agent did the searching itself.
  const searches = main.filter((e) => e.event_type === "tool_call" && SEARCH_TOOLS.has(e.tool_name ?? "")).length;
  if (searches >= 15 && !used(/explore|search|research/i))
    add("subagent-explore", {
      severity: searches >= 40 ? "medium" : "low",
      title: "Use an Explore subagent for searching",
      detail: `The main agent made ${searches} read/search calls itself. Each one stays in its context and makes every later step slower and more expensive. An Explore subagent searches in its own context and returns only the answer.`,
      numbers: { searches },
      fix: "Use the Explore subagent to find where <feature> is implemented. Report the files and line numbers, don't edit anything.",
    });

  // Several subagents, never at the same time.
  if (spawns.length >= 3) {
    const spans = spawns.map((s) => [s.created_at, s.ended_at ?? (s.status === "running" ? now : s.created_at)]);
    const overlap = spans.some(([a0, a1], i) => spans.some(([b0, b1], j) => i !== j && a0 < b1 && b0 < a1));
    if (!overlap)
      add("subagent-parallel", {
        severity: "low",
        title: "Run independent subagents in parallel",
        detail: `${spawns.length} subagents ran one after another. When their work does not depend on each other, start them in one message so they run at the same time.`,
        numbers: { subagents: spawns.length },
        fix: "In one message, start these as parallel subagents: 1) <task A> 2) <task B> 3) <task C>. Wait for all of them, then summarize.",
      });
  }

  // Lots of edits and nobody reviewed them.
  const edits = events.filter((e) => e.event_type === "tool_call" && EDIT_TOOLS.has(e.tool_name ?? ""));
  const files = new Set(
    edits.map((e) => str(obj(e.payload.input).file_path) || str(obj(e.payload.input).notebook_path)),
  );
  if (edits.length >= 8 && files.size >= 3 && !used(/review/i))
    add("subagent-review", {
      severity: "low",
      title: "Add a review pass after big changes",
      detail: `${edits.length} edits across ${files.size} files and no reviewer subagent. A reviewer with a fresh context catches bugs the agent that wrote the code tends to miss.`,
      numbers: { edits: edits.length, files: files.size },
      fix: "When the change is done, run a code-reviewer subagent on the changed files, then fix what it reports.",
    });

  // Test-fix loop inside the main agent.
  const calls = new Map(main.filter((e) => e.tool_use_id).map((e) => [e.tool_use_id!, e]));
  const failedTests = main.filter((e) => {
    if (e.event_type !== "tool_result" || e.status !== "error" || !e.tool_use_id) return false;
    const c = calls.get(e.tool_use_id);
    return !!c && /^(Bash|PowerShell)$/.test(c.tool_name ?? "") && TEST_CMD.test(str(obj(c.payload.input).command));
  }).length;
  if (failedTests >= 3 && !used(/test/i))
    add("subagent-tests", {
      severity: "medium",
      title: "Hand the test-fix loop to a subagent",
      detail: `Tests failed ${failedTests} times inside the main agent, and every failure's output stayed in its context. A test subagent can run, fix and re-run in its own context and report back a short summary.`,
      numbers: { failed_runs: failedTests },
      fix: "Use a subagent to run the tests, fix the source (not the tests) until they pass, and report only what it changed.",
    });

  // Main context grew very large while little was delegated.
  const huge = main.filter((e) => (e.input_tokens ?? 0) > 100_000).length;
  if (huge >= 3 && spawns.length <= 1)
    add("subagent-context", {
      severity: "medium",
      title: "Delegate to keep the main context small",
      detail: `${huge} steps of the main agent read more than 100k tokens of context, with ${spawns.length} subagent${spawns.length === 1 ? "" : "s"} used. Side tasks (research, logs, test output) handed to subagents return only a summary.`,
      numbers: { large_steps: huge, subagents: spawns.length },
      fix: "Use a subagent to <research / read the logs / check the docs> and return a 10-line summary. Keep working on the main task here.",
    });

  return out;
}
