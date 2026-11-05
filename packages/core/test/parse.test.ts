import { describe, expect, it } from "vitest";
import { createMemoryStore, parseLines, parseNotifications, summarizeCall } from "../src";
import { T0, demoLines, ingest, raw } from "./helpers";

const S = "s-1";

describe("demo session", () => {
  const lines = demoLines();
  const { store, skipped } = ingest(lines, 7);
  const events = store.events();

  it("parses every line", () => {
    expect(lines.length).toBeGreaterThan(70);
    expect(skipped).toBe(0);
  });

  it("has two spawns linked to code-reviewer and test-runner", () => {
    expect(events.filter((e) => e.event_type === "subagent_spawn")).toHaveLength(2);
    expect(
      store
        .links()
        .map((l) => l.name)
        .sort(),
    ).toEqual(["code-reviewer", "test-runner"]);
    const keys = new Set(events.filter((e) => e.is_subagent).map((e) => e.agent_key));
    expect([...keys].every((k) => k.startsWith("toolu_demo_"))).toBe(true);
  });

  it("has two failed Bash calls and nothing left running", () => {
    expect(
      events.filter((e) => e.tool_name === "Bash" && e.event_type === "tool_call" && e.status === "error"),
    ).toHaveLength(2);
    expect(events.filter((e) => e.status === "running")).toHaveLength(0);
  });

  it("counts tokens once per message, whatever the batching", () => {
    const perMessage = new Map<string, number>();
    for (const { line } of lines) {
      const m = (line as any).message;
      if (m?.id && m.usage) perMessage.set(m.id, m.usage.input_tokens + m.usage.output_tokens);
    }
    const expected = [...perMessage.values()].reduce((a, b) => a + b, 0);
    const sum = (evs: typeof events) => evs.reduce((a, e) => a + (e.input_tokens ?? 0) + (e.output_tokens ?? 0), 0);
    expect(sum(events)).toBe(expected);
    expect(sum(ingest(lines, 1).store.events())).toBe(expected);
    expect(sum(ingest(lines, 1000).store.events())).toBe(expected);
  });

  it("gives the same rows for any batch size", () => {
    const a = ingest(lines, 1).store.events();
    const b = ingest(lines, 1000).store.events();
    const strip = (es: typeof a) => es.map(({ payload: _p, ...e }) => e);
    expect(strip(a)).toEqual(strip(b));
  });

  it("ignores lines sent twice", () => {
    const again = ingest(lines, 50, store);
    expect(again.inserted).toBe(0);
    expect(store.sessions()[0].event_count).toBe(events.length);
  });
});

describe("background work", () => {
  it("keeps an async subagent running until its notification (trimmed, no closing tag)", () => {
    const store = createMemoryStore();
    const step = (...ls: unknown[]) =>
      store.apply(
        parseLines(
          ls.map((l: any) => ({ file: l.agentId ? raw.file(S, l.agentId) : raw.file(S), line: l })),
          store.ctx,
        ),
      );
    step(
      raw.call(S, T0, "t1", "Agent", {
        description: "Review",
        subagent_type: "reviewer",
        prompt: "Review the app",
        run_in_background: true,
      }),
    );
    step(
      raw.result(S, T0 + 100, "t1", "Async agent launched", { isAsync: true, status: "async_launched", agentId: "a1" }),
    );
    const spawn = () => store.events().find((e) => e.tool_use_id === "t1" && e.event_type === "subagent_spawn")!;
    expect(spawn().status).toBe("running");
    expect(spawn().payload.background).toBe(true);
    // the subagent's own transcript arrives, linked by agentId
    step({
      ...raw.line(S, "user", T0 + 200, { message: { role: "user", content: "Review the app" } }),
      parentUuid: null,
      isSidechain: true,
      agentId: "a1",
    });
    expect(store.events().find((e) => e.is_subagent)!.agent_key).toBe("t1");
    expect(spawn().status).toBe("running");
    step(raw.notify(S, T0 + 5000, "a1", "t1", "completed", false));
    expect(spawn().status).toBe("done");
    expect(spawn().duration_ms).toBe(5000);
  });

  it("keeps a background Bash running until TaskStop", () => {
    const store = createMemoryStore();
    const step = (...ls: unknown[]) =>
      store.apply(
        parseLines(
          ls.map((line) => ({ file: raw.file(S), line })),
          store.ctx,
        ),
      );
    step(raw.call(S, T0, "b1", "Bash", { command: "npm run dev" }));
    step(raw.result(S, T0 + 50, "b1", "Command running in background", { backgroundTaskId: "bx1" }));
    const bash = () => store.events().find((e) => e.tool_use_id === "b1" && e.event_type === "tool_call")!;
    expect(bash().status).toBe("running");
    step(raw.call(S, T0 + 1000, "k1", "TaskStop", { task_id: "bx1" }), raw.result(S, T0 + 1100, "k1", "stopped"));
    expect(bash().status).toBe("done");
    expect(bash().payload.stopped).toBe(true);
  });

  it("closes a failed notification as error", () => {
    const store = createMemoryStore();
    store.apply(
      parseLines(
        [
          { file: raw.file(S), line: raw.call(S, T0, "b2", "Bash", { command: "x" }) },
          { file: raw.file(S), line: raw.result(S, T0 + 1, "b2", "bg", { backgroundTaskId: "bx2" }) },
        ],
        store.ctx,
      ),
    );
    store.apply(parseLines([{ file: raw.file(S), line: raw.notify(S, T0 + 10, "bx2", "b2", "failed") }], store.ctx));
    expect(store.events().find((e) => e.tool_use_id === "b2" && e.event_type === "tool_call")!.status).toBe("error");
  });

  it("closes a call whose notification was read first (backfill reads the main transcript before subagents')", () => {
    const store = createMemoryStore();
    store.apply(parseLines([{ file: raw.file(S), line: raw.notify(S, T0 + 9000, "bx7", "b7") }], store.ctx));
    const sub = (l: any) => ({ file: raw.file(S, "a7"), line: { ...l, isSidechain: true, agentId: "a7" } });
    store.apply(
      parseLines(
        [
          sub(raw.call(S, T0, "b7", "Bash", { command: "sleep 9" })),
          sub(raw.result(S, T0 + 10, "b7", "bg", { backgroundTaskId: "bx7" })),
        ],
        store.ctx,
      ),
    );
    const bash = store.events().find((e) => e.tool_use_id === "b7" && e.event_type === "tool_call")!;
    expect(bash.status).toBe("done");
    expect(bash.duration_ms).toBe(9000);
  });

  it("relinks events of a subagent that arrived before its spawn's result", () => {
    const store = createMemoryStore();
    const step = (...ls: any[]) =>
      store.apply(
        parseLines(
          ls.map((l) => ({ file: l.agentId ? raw.file(S, l.agentId) : raw.file(S), line: l })),
          store.ctx,
        ),
      );
    step(raw.call(S, T0, "t9", "Agent", { description: "Explore", prompt: "A" }));
    step({
      ...raw.line(S, "user", T0 + 1, { message: { role: "user", content: "different prompt" } }),
      parentUuid: null,
      isSidechain: true,
      agentId: "a9",
    });
    expect(store.events().find((e) => e.is_subagent)!.agent_key).toBe("agent:a9");
    step(raw.result(S, T0 + 2, "t9", "done", { status: "completed", agentId: "a9" }));
    expect(store.events().find((e) => e.is_subagent)!.agent_key).toBe("t9");
    expect(store.events().find((e) => e.is_subagent)!.agent_name).toBe("Explore");
  });
});

describe("robustness", () => {
  it("a bad line never breaks a batch", () => {
    const store = createMemoryStore();
    const evil = {
      get type(): string {
        throw new Error("boom");
      },
      sessionId: S,
    };
    const r = parseLines(
      [
        { file: raw.file(S), line: null },
        { file: raw.file(S), line: "not json" },
        { file: raw.file(S), line: { type: "assistant" } },
        { file: raw.file(S), line: evil },
        { file: raw.file(S), line: { type: "attachment", sessionId: S } },
        { file: raw.file(S), line: raw.line(S, "user", T0, { message: { role: "user", content: "hello" } }) },
        {
          file: raw.file(S),
          line: raw.line(S, "assistant", T0 + 1, {
            message: { id: "m", content: [{ type: "tool_use" }, null, { type: "text", text: "hi" }] },
          }),
        },
      ],
      store.ctx,
    );
    expect(r.skipped).toBe(5);
    expect(r.events.map((e) => e.event_type)).toEqual(["user_prompt", "tool_call", "assistant_text"]);
  });

  it("classifies meta and command lines", () => {
    const r = parseLines(
      [
        { file: raw.file(S), line: raw.line(S, "user", T0, { isMeta: true, message: { content: "meta" } }) },
        {
          file: raw.file(S),
          line: raw.line(S, "user", T0, { message: { content: "<command-name>/clear</command-name>" } }),
        },
        { file: raw.file(S), line: raw.line(S, "user", T0, { message: { content: "Caveat: x" } }) },
      ],
      createMemoryStore().ctx,
    );
    expect(r.events.map((e) => e.event_type)).toEqual(["other", "other"]);
  });
});

describe("notifications and summaries", () => {
  it("parses fields without the closing tag", () => {
    const n = parseNotifications(
      "x<task-notification><task-id>a1</task-id><tool-use-id>toolu_1</tool-use-id><status>killed</status><summary>long…",
    );
    expect(n).toEqual([{ taskId: "a1", toolUseId: "toolu_1", status: "killed", summary: "long…", durationMs: null }]);
  });

  it("writes readable summaries", () => {
    expect(summarizeCall("Bash", { command: "npm test" })).toBe("Bash: npm test");
    expect(summarizeCall("Edit", { file_path: "/w/app/src/App.tsx" }, "/w/app")).toBe("Edit: src/App.tsx");
    expect(summarizeCall("mcp__github__create_pr", { title: "Fix totals" })).toBe("github · create_pr: Fix totals");
  });
});
