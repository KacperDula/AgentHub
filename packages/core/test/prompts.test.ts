import { describe, expect, it } from "vitest";
import {
  buildAnalysisPayload,
  buildAnalysisPrompt,
  countAsks,
  emptyProfile,
  explainPayload,
  promptStats,
  reviewPrompts,
  sessionRecap,
  subagentAdvice,
} from "../src";
import { T0, demoLines, ingest, raw } from "./helpers";

const SID = "p-1";
const file = raw.file(SID);
const say = (ts: number, text: string) => ({
  file,
  line: raw.line(SID, "user", ts, { message: { role: "user", content: text } }),
});
const answer = (ts: number, text: string) => ({
  file,
  line: raw.line(SID, "assistant", ts, { message: { id: `m-${ts}`, content: [{ type: "text", text }] } }),
});
const tool = (ts: number, id: string, name: string, input: Record<string, unknown>, out = "ok", err = false) => [
  { file, line: raw.call(SID, ts, id, name, input) },
  { file, line: raw.result(SID, ts + 50, id, out, undefined, err) },
];

const MANY =
  "Add a Center button to the map so it stops moving on its own. Also add a notes folder per user that the AI reads. Also add a new tab that explains each session, and make Insights tell me what is wrong with my prompts.";

describe("prompt coach", () => {
  const lines = [
    say(T0, "fix it, it doesn't work"),
    ...tool(T0 + 1000, "t1", "Read", { file_path: "/w/app/src/App.tsx" }),
    answer(T0 + 2000, "I changed the button color."),
    say(T0 + 5000, "no"),
    say(T0 + 6000, 'The checkout total in src/lib/cart.ts is 0 when a discount is applied. Expected "90".'),
    ...tool(T0 + 7000, "t2", "Bash", { command: "npm test" }, "1 failed", true),
    say(T0 + 9000, "[Request interrupted by user]"),
    say(T0 + 12_000, MANY),
  ];
  const { store } = ingest(lines);
  const reviews = reviewPrompts(store.events());

  it("reviews only what the user typed into the main agent", () => {
    expect(reviews.map((r) => r.text.slice(0, 12))).toEqual(["fix it, it d", "no", "The checkout", "Add a Center"]);
  });

  it("flags a vague first prompt that was then corrected", () => {
    const r = reviews[0];
    expect(r.issues.map((i) => i.kind)).toEqual(["misread", "vague", "short-start"]);
    expect(r.severity).toBe("high");
    expect(r.outcome).toMatchObject({ steps: 1, corrected: true, interrupted: false });
    expect(r.better).toMatch(/^Goal: fix it, it doesn't work/);
  });

  it("leaves short replies and anchored prompts alone, but notices interruptions", () => {
    expect(reviews[1].issues).toEqual([]);
    expect(reviews[2].issues.map((i) => i.kind)).toEqual(["misread"]);
    expect(reviews[2].issues[0].title).toBe("You had to stop the agent");
    expect(reviews[2].outcome).toMatchObject({ interrupted: true, errors: 1 });
  });

  it("notices several tasks in one prompt", () => {
    expect(countAsks(MANY)).toBe(3);
    expect(reviews[3].issues.map((i) => i.kind)).toContain("many-asks");
  });

  it("understands Greek prompts", () => {
    const { store: s } = ingest([say(T0, "φτιάξε το γιατί δεν δουλεύει"), say(T0 + 1000, "λάθος")]);
    const [r] = reviewPrompts(s.events());
    expect(r.issues.map((i) => i.kind)).toEqual(["misread", "vague", "short-start"]);
    // "\b" only knows Latin letters: the Greek rules must still see where a word ends.
    const { store: g } = ingest([say(T0, "ok"), say(T0 + 1000, "φτιάξε το κουμπί στη σελίδα, βελτίωσε το λίγο")]);
    expect(reviewPrompts(g.events())[1].issues.map((i) => i.kind)).toEqual(["vague"]);
  });

  it("skips what a program wrote in the user's place, and does not ask questions for a 'done when'", () => {
    const { store: s } = ingest([
      say(T0, "This session is being continued from a previous conversation that ran out of context. Summary: …"),
      say(T0 + 1000, "Another session says: <agent-message from='x'>report</agent-message>"),
      say(T0 + 2000, "You are a prompt coach for a developer who works with Claude Code and its subagents."),
      say(
        T0 + 3000,
        "Be honest: would it make sense to add a tokens dashboard and an insights page to my app, and what would it take to build and sell it to other teams?",
      ),
    ]);
    const r = reviewPrompts(s.events());
    expect(r).toHaveLength(1);
    expect(r[0].issues).toEqual([]);
  });

  it("sums up the statistics and sends prompts to the AI coach only in its payload", () => {
    const st = promptStats(reviews);
    expect(st).toMatchObject({ prompts: 4, withIssues: 3, corrected: 1, interrupted: 1 });
    expect(st.issues.misread).toBe(2);
    const payload = buildAnalysisPayload("prompts", [], emptyProfile(), [], undefined, {
      prompts: reviews,
      promptStats: st,
      notes: "### goal\nShip it",
    });
    expect(payload.prompts![0]).toEqual({
      text: "fix it, it doesn't work",
      issues: ["misread", "vague", "short-start"],
      corrected: true,
      interrupted: false,
      steps: 1,
      errors: 0,
    });
    const prompt = buildAnalysisPrompt(payload);
    expect(prompt).toMatch(/prompt coach/);
    expect(prompt).toMatch(/user_notes are the developer's own notes/);
    expect(buildAnalysisPrompt(buildAnalysisPayload("overall", [], emptyProfile(), []))).not.toMatch(/user_notes/);
  });
});

describe("subagent advice", () => {
  it("suggests an Explore subagent when the main agent searched a lot itself", () => {
    const lines = [say(T0, "where is the cart total computed?")];
    for (let i = 0; i < 16; i++)
      lines.push(...tool(T0 + 1000 * (i + 1), `r${i}`, "Read", { file_path: `/w/app/f${i}.ts` }));
    const { store } = ingest(lines);
    const kinds = subagentAdvice(store.events(), T0 + 60_000).map((s) => s.kind);
    expect(kinds).toEqual(["subagent-explore"]);
  });

  it("suggests running independent subagents in parallel", () => {
    const lines = [say(T0, "review, test and document the checkout")];
    for (let i = 0; i < 3; i++)
      lines.push(
        ...tool(T0 + 1000 * (i + 1), `a${i}`, "Agent", {
          description: `job ${i}`,
          subagent_type: "general",
          prompt: `p${i}`,
        }),
      );
    const { store } = ingest(lines);
    const advice = subagentAdvice(store.events(), T0 + 60_000);
    expect(advice.map((s) => s.kind)).toEqual(["subagent-parallel"]);
    expect(advice[0].fix).toMatch(/parallel subagents/);
  });

  it("has nothing to say about the demo, which already runs its subagents in parallel", () => {
    const { store } = ingest(demoLines());
    expect(subagentAdvice(store.events(), T0 + 3_600_000)).toEqual([]);
  });
});

describe("explain", () => {
  it("tells the demo session turn by turn without tool outputs", () => {
    const { store } = ingest(demoLines());
    const recap = sessionRecap(store.events(), store.todos(), "/Users/demo/acme-checkout");
    expect(recap.totals.prompts).toBe(1);
    expect(recap.turns).toHaveLength(1);
    const t = recap.turns[0];
    expect(t.prompt).toMatch(/^Plan this as todos/);
    expect(t.subagents.map((s) => s.name).sort()).toEqual(["code-reviewer", "test-runner"]);
    expect(t.commands.some((c) => c.cmd === "npm test" && c.ok === false)).toBe(true);
    expect(recap.plan?.length).toBe(5);
    const payload = JSON.stringify(explainPayload(recap));
    expect(payload).not.toContain("Expected: 90"); // a tool output from the demo
  });
});
