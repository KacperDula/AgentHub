import { describe, expect, it } from "vitest";
import {
  buildTree,
  combineModels,
  planProgress,
  sessionPrompt,
  sessionSignals,
  splitCardId,
  isCorrection,
  sessionProfile,
  sessionOutline,
} from "../src";
import { T0, demoLines, ingest, raw } from "./helpers";

describe("buildTree on the demo", () => {
  const lines = demoLines();
  const { store } = ingest(lines);
  const events = store.events();
  const todos = store.todos();
  const end = events.at(-1)!.created_at;
  const tsOf = (i: number) => Date.parse((lines[i].line as any).timestamp);

  it("shows both subagents and their tools running in parallel mid-way", () => {
    const i = lines.findIndex((l) => JSON.stringify(l.line).includes(`"description":"Run the test suite"`));
    const m = buildTree(events, todos, end, { asOf: tsOf(i), showTools: true });
    const subs = m.running
      .filter((r) => r.kind === "subagent")
      .map((r) => r.label)
      .sort();
    expect(subs).toEqual(["code-reviewer", "test-runner"]);
    expect(m.running.some((r) => r.kind === "tool" && r.label.startsWith("Bash"))).toBe(true);
    expect(m.cards.filter((c) => c.kind === "resource").length).toBeGreaterThan(0);
    expect(m.mainState).toBe("Running tool");
  });

  it("builds prompt → main → subagents → tools → resources, with errors on test-runner's Bash", () => {
    const m = buildTree(events, todos, end + 1000, { showTools: true });
    const byId = new Map(m.cards.map((c) => [c.id, c]));
    expect(byId.get("prompt")!.parentId).toBeNull();
    expect(byId.get("agent:main")!.parentId).toBe("prompt");
    const tr = m.cards.find((c) => c.title === "test-runner")!;
    expect(tr.parentId).toBe("agent:main");
    const bash = m.cards.find((c) => c.parentId === tr.id && c.toolName === "Bash")!;
    expect(bash.errors).toBe(2);
    expect(m.cards.find((c) => c.kind === "mcp")!.server).toBe("github");
    expect(m.mainState).toBe("Waiting for you");
    expect(m.session.progress.label).toBe("Waiting for you · 100%");
  });

  it("folds finished subagents after 30 s and expands on request", () => {
    const m = buildTree(events, todos, end + 60_000);
    const fold = m.cards.find((c) => c.foldKind === "subagents")!;
    expect(fold.title).toBe("2 finished subagents");
    expect(m.cards.some((c) => c.kind === "subagent")).toBe(false);
    const open = buildTree(events, todos, end + 60_000, { expanded: new Set([fold.id]) });
    expect(open.cards.filter((c) => c.kind === "subagent").every((c) => c.foldId === fold.id)).toBe(true);
  });

  it("groups each agent's tools into one card that opens per agent, and keeps running tools in Running now", () => {
    const i = lines.findIndex((l) => JSON.stringify(l.line).includes(`"description":"Run the test suite"`));
    const mid = buildTree(events, todos, end, { asOf: tsOf(i) });
    expect(mid.cards.some((c) => c.kind === "tool" || c.kind === "resource")).toBe(false);
    const chips = mid.cards.filter((c) => c.foldKind === "tools");
    expect(chips.length).toBeGreaterThan(0);
    const running = mid.running.find((r) => r.kind === "tool")!;
    expect(chips.map((c) => c.id)).toContain(running.cardId);
    expect(mid.cards.find((c) => c.id === running.cardId)!.look).toBe("running");

    const done = buildTree(events, todos, end + 1000);
    const mainChip = done.cards.find((c) => c.id === "tools:agent:main")!;
    expect(mainChip.parentId).toBe("agent:main");
    expect(mainChip.title).toMatch(/^\d+ tools? · \d+ calls?$/);
    const open = buildTree(events, todos, end + 1000, { expanded: new Set([mainChip.id]) });
    const mainTools = open.cards.filter((c) => c.parentId === "agent:main" && (c.kind === "tool" || c.kind === "mcp"));
    expect(mainTools.length).toBe(mainChip.folded!.length);
    expect(mainTools.every((c) => c.foldId === mainChip.id)).toBe(true);
    expect(open.cards.some((c) => c.id === mainChip.id)).toBe(false);
  });

  it("shows the session's first prompt on the prompt card, with the latest one below", () => {
    const say = (ts: number, text: string) => ({
      file: raw.file("p"),
      line: raw.line("p", "user", ts, { message: { role: "user", content: text } }),
    });
    const { store: s } = ingest([
      say(T0, "Build the whole Logistis accounting module with myDATA and E3 support, step by step with subagents."),
      say(T0 + 60_000, "εχουμε τελειωσε με το project? που βρισκομαστε?"),
    ]);
    const card = buildTree(s.events(), [], T0 + 120_000).cards.find((c) => c.kind === "prompt")!;
    expect(card.lines[0]).toMatch(/^Build the whole Logistis/);
    expect(card.lines[1]).toBe("εχουμε τελειωσε με το project? που βρισκομαστε?");
    expect(card.startedAt).toBe(T0);
  });

  it("never leaves a chip without its parent when a subagent of a subagent is folded too", () => {
    const sid = "nest";
    const main = raw.file(sid);
    const a = raw.file(sid, "A1");
    const b = raw.file(sid, "B1");
    const sub = (id: string) => ({ isSidechain: true, agentId: id });
    const lines = [
      { file: main, line: raw.line(sid, "user", T0, { message: { role: "user", content: "Do the outer job" } }) },
      { file: main, line: raw.call(sid, T0 + 1000, "a1", "Agent", { description: "outer", prompt: "pa" }) },
      { file: a, line: raw.call(sid, T0 + 2000, "b1", "Agent", { description: "inner", prompt: "pb" }, sub("A1")) },
      { file: b, line: raw.call(sid, T0 + 3000, "r1", "Read", { file_path: "/w/app/x.ts" }, sub("B1")) },
      { file: b, line: raw.result(sid, T0 + 3500, "r1", "ok", undefined, false, sub("B1")) },
      { file: a, line: raw.result(sid, T0 + 4000, "b1", "done", { agentId: "B1" }, false, sub("A1")) },
      { file: main, line: raw.result(sid, T0 + 5000, "a1", "done", { agentId: "A1" }) },
    ];
    const { store: s } = ingest(lines);
    const m = buildTree(s.events(), [], T0 + 120_000);
    const ids = new Set(m.cards.map((c) => c.id));
    expect(m.cards.filter((c) => c.parentId && !ids.has(c.parentId))).toEqual([]);
    expect(m.cards.filter((c) => c.foldKind === "subagents").map((c) => c.title)).toEqual(["1 finished subagent"]);
  });

  it("skips check-ins, uses prompts older than the loaded events, and honours a pinned main prompt", () => {
    const say = (ts: number, text: string) => ({
      file: raw.file("q"),
      line: raw.line("q", "user", ts, { message: { role: "user", content: text } }),
    });
    const { store: s } = ingest([
      say(T0, "θελουμε να μου πεις που βρισκομαστε στο project τι εχει μεινει"),
      say(T0 + 1000, "συνεχισε και ολοκληρωσε το εδω με εναν βασικο agent και subagents με τους κανονες"),
      say(T0 + 2000, "status?"),
    ]);
    const all = s.events();
    const card = (opts = {}) =>
      buildTree(all.slice(-1), [], T0 + 10_000, { allPrompts: all, ...opts }).cards.find((c) => c.kind === "prompt")!;
    expect(card().lines[0]).toMatch(/^συνεχισε και ολοκληρωσε/);
    expect(card().lines[1]).toBe("status?");
    const pinned = card({ mainPromptId: all[0].source_uuid });
    expect(pinned.title).toBe("Your main prompt");
    expect(pinned.lines[0]).toMatch(/^θελουμε να μου πεις/);
    expect(card().eventIds).toHaveLength(3);
  });

  it("takes the goal from Claude's summary when the log starts after the context ran out", () => {
    const summary =
      "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request and Intent:\n   - Finish the Logistis project as the main orchestrator with subagents.\n   - Use the rules set earlier.\n\n2. Key Technical Concepts:\n   - .NET";
    const sp = sessionPrompt([
      { ...events[0], event_type: "user_prompt", payload: { text: summary }, created_at: T0 },
      { ...events[0], event_type: "user_prompt", payload: { text: "status?" }, created_at: T0 + 1 },
    ]);
    expect(sp.fromSummary).toBe(true);
    expect(sp.goalText).toBe(
      "Finish the Logistis project as the main orchestrator with subagents. Use the rules set earlier.",
    );
    expect(sp.latest?.payload.text).toBe("status?");
  });

  it("puts several sessions on one map under a project card, with prefixed ids", () => {
    const { store: s2 } = ingest(demoLines("demo-2"));
    const a = buildTree(events, todos, end + 1000);
    const b = buildTree(s2.events(), s2.todos(), end + 1000);
    const m = combineModels(
      [
        { sessionId: "demo-1", label: "orchestrator", model: a },
        { sessionId: "demo-2", label: "worker", model: b },
      ],
      { title: "acme-checkout", now: end + 1000 },
    );
    expect(m.cards[0]).toMatchObject({ id: "group", kind: "group", title: "acme-checkout" });
    expect(m.cards.length).toBe(1 + a.cards.length + b.cards.length);
    const prompts = m.cards.filter((c) => c.kind === "prompt");
    expect(prompts.map((c) => [c.parentId, c.label])).toEqual([
      ["group", "PROMPT · orchestrator"],
      ["group", "PROMPT · worker"],
    ]);
    expect(splitCardId(prompts[1].id)).toEqual({ sessionId: "demo-2", cardId: "prompt" });
    const ids = new Set(m.cards.map((c) => c.id));
    expect(m.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);
    expect(m.session.events).toBe(a.session.events + b.session.events);
  });

  it("replays: earlier moments have fewer cards and calls ending later still run", () => {
    const early = buildTree(events, todos, end, { asOf: tsOf(5) });
    expect(early.cards.length).toBeLessThan(buildTree(events, todos, end).cards.length);
    expect(early.cards.find((c) => c.id === "agent:main")!.look).toBe("running");
  });
});

describe("plan progress", () => {
  const snap = (t: number, s: string) => ({
    source_uuid: String(t),
    session_id: "s",
    agent_key: "main",
    agent_name: "main",
    agent_id: null,
    created_at: t,
    todos: [...s].map(
      (c) => ({ content: c, status: c === "c" ? "completed" : c === "i" ? "in_progress" : "pending" }) as any,
    ),
  });
  it("estimates from the pace of completed todos", () => {
    const p = planProgress([snap(0, "ipp"), snap(60_000, "cip")], 60_000)!;
    expect(p.value).toBeCloseTo(0.5);
    expect(p.label).toBe("~2 min left · 50%");
  });
  it("says estimating before the first completion and complete at the end", () => {
    expect(planProgress([snap(0, "ip")], 1)!.value).toBeNull();
    expect(planProgress([snap(0, "cc")], 1)!.label).toBe("Plan complete · 100%");
  });
  it("never shows a negative ETA", () => {
    expect(planProgress([snap(0, "ipp"), snap(1000, "cip")], 999_999)!.label).toMatch(/^taking longer than usual/);
  });
});

describe("insights", () => {
  it("detects corrections in English and Greek", () => {
    expect(["no", "Stop!", "wrong file", "όχι", "λάθος", "σταμάτα"].every(isCorrection)).toBe(true);
    expect(isCorrection("nothing to add")).toBe(false);
  });
  it("flags the demo's failures, and the profile holds aggregates only", () => {
    const { store } = ingest(demoLines());
    const events = store.events();
    const signals = sessionSignals(events, events.at(-1)!.created_at);
    expect(signals.every((s) => s.session_id === "demo-1")).toBe(true);
    const p = sessionProfile(events, () => 12);
    expect(p.tools.Bash).toBe(5);
    expect(p.mcpServers.github).toBe(1);
    expect(p.subagents["test-runner"]).toEqual({ n: 1, failed: 0 });
    expect(Object.keys(p.failingCommands)).toEqual(["npm test"]);
    const outline = sessionOutline(events);
    expect(JSON.stringify(outline)).not.toContain("Expected: 90");
  });
});
