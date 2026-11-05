// The "Load demo session" script.
//
// buildDemoScript(sessionId) returns about 80 raw Claude Code transcript lines, each with the delay before
// it should be sent. playDemo() hands them one by one to the local pipeline, so the demo exercises the same
// parser as a real CLI: a 5-step plan, two subagents (code-reviewer and test-runner) running in parallel
// with their own plans, `npm test` failing twice then passing, and an MCP call to mcp__github__create_pr.

export interface DemoStep {
  delayMs: number;
  file: string;
  line: Record<string, unknown>;
}

type Block = Record<string, unknown>;
type Who = "main" | "cr" | "tr";

const hex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

export function buildDemoScript(sessionId: string): DemoStep[] {
  const cwd = "/Users/demo/projects/acme-checkout";
  const branch = "fix/checkout-totals";
  const projDir = "/Users/demo/.claude/projects/-Users-demo-projects-acme-checkout";
  const CR = "a" + hex(8);
  const TR = "a" + hex(8);
  const agents: Record<Who, { file: string; agentId: string | null; model: string; tokens: number }> = {
    main: { file: `${projDir}/${sessionId}.jsonl`, agentId: null, model: "claude-opus-5-5", tokens: 18400 },
    cr: {
      file: `${projDir}/${sessionId}/subagents/agent-${CR}.jsonl`,
      agentId: CR,
      model: "claude-sonnet-5-5",
      tokens: 9100,
    },
    tr: {
      file: `${projDir}/${sessionId}/subagents/agent-${TR}.jsonl`,
      agentId: TR,
      model: "claude-sonnet-5-5",
      tokens: 8300,
    },
  };
  const parent: Record<Who, string | null> = { main: null, cr: null, tr: null };
  const steps: DemoStep[] = [];
  let n = 0;
  const toolId = () => "toolu_demo_" + String(++n).padStart(3, "0") + hex(4);

  const base = (who: Who, type: string): Record<string, unknown> => {
    const uuid = crypto.randomUUID();
    const a = agents[who];
    const line: Record<string, unknown> = {
      parentUuid: parent[who],
      isSidechain: who !== "main",
      ...(a.agentId ? { agentId: a.agentId } : {}),
      type,
      uuid,
      timestamp: null, // set by playDemo() when the line is sent
      cwd,
      sessionId,
      version: "2.1.0",
      gitBranch: branch,
      userType: "external",
    };
    parent[who] = uuid;
    return line;
  };
  const push = (delay: number, who: Who, line: Record<string, unknown>) =>
    steps.push({ delayMs: Math.round(delay * 1000), file: agents[who].file, line });

  const assistant = (delay: number, who: Who, blocks: Block[]) => {
    const a = agents[who];
    a.tokens += 600 + Math.floor(Math.random() * 1800);
    const line = base(who, "assistant");
    line.message = {
      id: "msg_demo_" + hex(6),
      type: "message",
      role: "assistant",
      model: a.model,
      content: blocks,
      stop_reason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
      usage: { input_tokens: a.tokens, output_tokens: 120 + Math.floor(Math.random() * 700) },
    };
    push(delay, who, line);
  };
  const userText = (delay: number, who: Who, text: string) => {
    const line = base(who, "user");
    line.message = { role: "user", content: text };
    push(delay, who, line);
  };
  const say = (delay: number, who: Who, text: string) => assistant(delay, who, [{ type: "text", text }]);
  const think = (delay: number, who: Who, thinking: string) =>
    assistant(delay, who, [{ type: "thinking", thinking, signature: "demo" }]);
  const call = (delay: number, who: Who, name: string, input: Record<string, unknown>) => {
    const id = toolId();
    assistant(delay, who, [{ type: "tool_use", id, name, input }]);
    return id;
  };
  const result = (
    delay: number,
    who: Who,
    id: string,
    content: string,
    isError = false,
    toolUseResult?: Record<string, unknown>,
  ) => {
    const line = base(who, "user");
    line.message = { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] };
    if (toolUseResult) line.toolUseResult = toolUseResult;
    push(delay, who, line);
  };
  const plan = (delay: number, who: Who, items: string[], statuses: string) => {
    const map: Record<string, string> = { c: "completed", i: "in_progress", p: "pending" };
    const todos = items.map((content, i) => ({
      content,
      status: map[statuses[i]],
      activeForm: content.replace(
        /^(\w+)/,
        (w) => (w === "Run" ? "Runn" : w.endsWith("e") ? w.slice(0, -1) : w) + "ing",
      ),
    }));
    const id = call(delay, who, "TodoWrite", { todos });
    result(
      0.3,
      who,
      id,
      "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress.",
    );
  };

  const MAIN = [
    "Read the checkout code",
    "Review and test in parallel",
    "Apply the review fixes",
    "Re-run the full test suite",
    "Open a pull request",
  ];
  const CRP = ["Read src/App.tsx", "Check state and effects", "Check error handling", "Write review notes"];
  const TRP = ["Install dependencies", "Run npm test", "Diagnose failures", "Confirm a green run"];
  const CR_PROMPT =
    "Review src/App.tsx in the acme-checkout project for bugs: stale state, missing effect dependencies and swallowed errors. Report concrete issues with line numbers. Do not edit files.";
  const TR_PROMPT =
    "Run the test suite for acme-checkout with npm test. If tests fail, find the cause, fix it in the source (not the tests) and re-run until everything passes.";

  // --- main agent: prompt and plan ---
  userText(
    0.3,
    "main",
    "Plan this as todos, then use two subagents in parallel, one to review src/App.tsx and one to run the tests, and fix what fails.",
  );
  think(
    1.6,
    "main",
    "The user wants a plan first. I'll read the checkout code, then fan out a reviewer and a test runner in parallel, apply what they find, re-run the tests and open a PR.",
  );
  plan(1.4, "main", MAIN, "ipppp");
  let id = call(1.2, "main", "Read", { file_path: `${cwd}/src/App.tsx` });
  result(
    1.4,
    "main",
    id,
    "1\timport { useEffect, useState } from 'react';\n2\timport { CartSummary } from './components/CartSummary';\n3\timport { applyDiscount, total } from './lib/cart';\n…",
  );
  id = call(1.0, "main", "Read", { file_path: `${cwd}/src/lib/cart.ts` });
  result(
    1.3,
    "main",
    id,
    "1\texport function applyDiscount(cart: Cart, pct: number) {\n2\t  const taxed = withTax(cart.subtotal);\n3\t  return taxed * (1 - pct / 100);\n…",
  );
  plan(1.2, "main", MAIN, "cippp");
  say(
    1.2,
    "main",
    "I'll launch two subagents in parallel: code-reviewer for src/App.tsx and test-runner for the test suite.",
  );
  const spCR = call(1.0, "main", "Agent", {
    description: "Review src/App.tsx",
    subagent_type: "code-reviewer",
    prompt: CR_PROMPT,
  });
  const spTR = call(0.3, "main", "Agent", {
    description: "Run and fix the tests",
    subagent_type: "test-runner",
    prompt: TR_PROMPT,
  });

  // --- two subagents running at the same time ---
  userText(1.0, "cr", CR_PROMPT);
  userText(0.6, "tr", TR_PROMPT);
  plan(1.1, "cr", CRP, "ippp");
  plan(0.9, "tr", TRP, "ippp");
  const cr1 = call(1.0, "cr", "Read", { file_path: `${cwd}/src/App.tsx` });
  const tr1 = call(0.9, "tr", "Bash", { command: "npm ci", description: "Install dependencies" });
  result(
    1.2,
    "cr",
    cr1,
    "1\timport { useEffect, useState } from 'react';\n…\n42\t  useEffect(() => { setTotal(total(cart)); }, []);\n…",
  );
  plan(1.0, "cr", CRP, "cipp");
  result(1.5, "tr", tr1, "added 812 packages, and audited 813 packages in 6s");
  plan(0.9, "tr", TRP, "cipp");
  const cr2 = call(1.0, "cr", "Grep", { pattern: "useEffect", path: "src" });
  const tr2 = call(1.0, "tr", "Bash", { command: "npm test", description: "Run the test suite" });
  result(
    1.2,
    "cr",
    cr2,
    "src/App.tsx:42:  useEffect(() => { setTotal(total(cart)); }, []);\nsrc/hooks/useCart.ts:18:  useEffect(() => {",
  );
  const cr3 = call(1.1, "cr", "WebFetch", {
    url: "https://react.dev/reference/react/useEffect",
    prompt: "Rules for the dependency array",
  });
  result(
    1.6,
    "tr",
    tr2,
    "FAIL src/lib/cart.test.ts\n  ● applyDiscount › applies the discount before tax\n    Expected: 90\n    Received: 100\n\nTests: 2 failed, 40 passed, 42 total",
    true,
  );
  plan(1.0, "tr", TRP, "ccip");
  result(
    1.1,
    "cr",
    cr3,
    "useEffect is a React Hook that lets you synchronize a component with an external system. Every reactive value used by the effect must be declared as a dependency.",
  );
  const tr3 = call(1.0, "tr", "Read", { file_path: `${cwd}/src/lib/cart.test.ts` });
  plan(1.0, "cr", CRP, "ccip");
  result(
    0.9,
    "tr",
    tr3,
    "12\t  it('applies the discount before tax', () => {\n13\t    expect(applyDiscount(cart, 10)).toBe(90);\n…",
  );
  const cr4 = call(1.0, "cr", "Read", { file_path: `${cwd}/src/components/CartSummary.tsx` });
  think(
    1.1,
    "tr",
    "applyDiscount() applies tax first and then the discount; the test expects the discount before tax. Fix the order in src/lib/cart.ts.",
  );
  result(
    1.0,
    "cr",
    cr4,
    "1\texport function CartSummary({ cart, onPay }: Props) {\n…\n31\t    try { await onPay(); } catch { /* ignore */ }\n…",
  );
  const tr4 = call(1.0, "tr", "Edit", {
    file_path: `${cwd}/src/lib/cart.ts`,
    old_string: "const taxed = withTax(cart.subtotal);\n  return taxed * (1 - pct / 100);",
    new_string: "const discounted = cart.subtotal * (1 - pct / 100);\n  return withTax(discounted);",
  });
  result(1.1, "tr", tr4, "The file src/lib/cart.ts has been updated.");
  think(
    0.9,
    "cr",
    "The effect on line 42 reads cart but has an empty dependency list, so the total goes stale when items change. CartSummary swallows payment errors.",
  );
  const tr5 = call(1.0, "tr", "Bash", { command: "npm test", description: "Re-run the tests" });
  plan(1.1, "cr", CRP, "ccci");
  result(
    1.6,
    "tr",
    tr5,
    "FAIL src/lib/cart.test.ts\n  ● total › rounds totals to 2 decimals\n    Expected: 19.99\n    Received: 19.990000000000002\n\nTests: 1 failed, 41 passed, 42 total",
    true,
  );
  const tr6 = call(1.0, "tr", "Edit", {
    file_path: `${cwd}/src/lib/cart.ts`,
    old_string: "return withTax(discounted);",
    new_string: "return Math.round(withTax(discounted) * 100) / 100;",
  });
  const review =
    "Review of src/App.tsx: 2 issues. (1) Line 42: useEffect is missing `cart` in its dependency list, so the total goes stale when the cart changes. (2) CartSummary.tsx line 31 swallows payment errors; show them to the user.";
  say(1.0, "cr", review);
  plan(0.6, "cr", CRP, "cccc");
  result(1.0, "tr", tr6, "The file src/lib/cart.ts has been updated.");
  result(0.8, "main", spCR, review, false, { status: "completed", agentId: CR, isAsync: false });
  const tr7 = call(1.0, "tr", "Bash", { command: "npm test", description: "Confirm a green run" });
  result(
    1.8,
    "tr",
    tr7,
    "PASS src/lib/cart.test.ts\nPASS src/App.test.tsx\nPASS src/components/CartSummary.test.tsx\n\nTests: 42 passed, 42 total",
  );
  plan(1.0, "tr", TRP, "cccc");
  const trDone =
    "All 42 tests pass. Fixed two bugs in src/lib/cart.ts: the discount now applies before tax, and totals are rounded to 2 decimals.";
  say(0.8, "tr", trDone);
  result(1.0, "main", spTR, trDone, false, { status: "completed", agentId: TR, isAsync: false });

  // --- main agent finishes the plan ---
  plan(1.2, "main", MAIN, "ccipp");
  id = call(1.0, "main", "Edit", {
    file_path: `${cwd}/src/App.tsx`,
    old_string: "useEffect(() => { setTotal(total(cart)); }, []);",
    new_string: "useEffect(() => { setTotal(total(cart)); }, [cart]);",
  });
  result(1.2, "main", id, "The file src/App.tsx has been updated.");
  id = call(1.0, "main", "Edit", {
    file_path: `${cwd}/src/components/CartSummary.tsx`,
    old_string: "try { await onPay(); } catch { /* ignore */ }",
    new_string: "try { await onPay(); } catch (e) { setError(messageOf(e)); }",
  });
  result(1.2, "main", id, "The file src/components/CartSummary.tsx has been updated.");
  plan(1.0, "main", MAIN, "cccip");
  id = call(1.0, "main", "Bash", { command: "npm test", description: "Run the full test suite" });
  result(2.0, "main", id, "Tests: 42 passed, 42 total\nTime: 3.12 s");
  plan(1.0, "main", MAIN, "cccci");
  id = call(1.0, "main", "mcp__github__create_pr", {
    owner: "acme",
    repo: "checkout",
    title: "Fix checkout totals and review issues",
    head: branch,
    base: "main",
  });
  result(
    2.0,
    "main",
    id,
    "Created pull request #128: Fix checkout totals and review issues\nhttps://github.com/acme/checkout/pull/128",
  );
  plan(1.0, "main", MAIN, "ccccc");
  say(
    1.2,
    "main",
    "Done. Fixed 2 failing tests in src/lib/cart.ts, applied 2 review fixes, all 42 tests pass, and opened PR #128.",
  );

  return steps;
}

/**
 * Plays the script: waits each step's delay, stamps the line with the current time and hands it to `send`.
 * Stops early when `signal` is aborted.
 */
export async function playDemo(
  steps: DemoStep[],
  send: (item: { file: string; line: Record<string, unknown> }) => Promise<void> | void,
  signal?: AbortSignal,
): Promise<void> {
  for (const step of steps) {
    await new Promise<void>((r) => setTimeout(r, step.delayMs));
    if (signal?.aborted) return;
    await send({ file: step.file, line: { ...step.line, timestamp: new Date().toISOString() } });
  }
}

/** Stamps every step with a synthetic clock instead of waiting (tests, instant replays). */
export function stampDemo(steps: DemoStep[], start: number): { file: string; line: Record<string, unknown> }[] {
  let t = start;
  return steps.map((s) => {
    t += s.delayMs;
    return { file: s.file, line: { ...s.line, timestamp: new Date(t).toISOString() } };
  });
}
