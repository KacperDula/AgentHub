// Runs the parser over anonymized real transcripts in fixtures/anon (see scripts/anonymize.mjs).
// Checks that "running" background work matches an independent, naive scan of the raw lines.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryStore, isWantedLine, parseLines, parseNotifications, type RawLine } from "../src";

// AGENTTRACE_FIXTURES=~/.claude/projects checks your own logs in place (read-only).
const ANON = process.env.AGENTTRACE_FIXTURES ?? path.resolve(__dirname, "../../../fixtures/anon");

function sessions(): { name: string; lines: RawLine[] }[] {
  if (!fs.existsSync(ANON)) return [];
  const out: { name: string; lines: RawLine[] }[] = [];
  for (const project of fs.readdirSync(ANON)) {
    const dir = path.join(ANON, project);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
      const sid = f.slice(0, -6);
      const files = [path.join(dir, f)];
      const sub = path.join(dir, sid, "subagents");
      if (fs.existsSync(sub)) files.push(...fs.readdirSync(sub).map((s) => path.join(sub, s)));
      const lines: RawLine[] = [];
      for (const file of files)
        for (const l of fs.readFileSync(file, "utf8").split("\n").filter(Boolean))
          lines.push({ file: file.split(path.sep).join("/"), line: JSON.parse(l) });
      // Files are read in listing order (main transcript first), like a backfill: the parser must cope.
      const wanted = lines.filter((l) => isWantedLine(l.line));
      out.push({ name: `${project}/${sid}`, lines: wanted });
    }
  }
  return out;
}

/** Naive: launched in the background and not yet notified or stopped. */
function naiveRunning(lines: RawLine[]): Set<string> {
  const launched = new Set<string>();
  const taskToCall = new Map<string, string>();
  const stopCalls = new Map<string, string>();
  const finished = new Set<string>();
  for (const { line } of lines as any[]) {
    for (const b of Array.isArray(line.message?.content) ? line.message.content : []) {
      if (b?.type === "tool_use" && b.name === "TaskStop") stopCalls.set(b.id, b.input?.task_id);
      if (b?.type === "tool_result") {
        const t = line.toolUseResult ?? {};
        if (!b.is_error && (t.isAsync === true || t.backgroundTaskId)) {
          launched.add(b.tool_use_id);
          taskToCall.set(t.backgroundTaskId ?? t.agentId, b.tool_use_id);
        }
        const stopped = stopCalls.get(b.tool_use_id);
        if (stopped && taskToCall.has(stopped)) finished.add(taskToCall.get(stopped)!);
      }
    }
    const texts = [
      typeof line.content === "string" ? line.content : "",
      typeof line.message?.content === "string" ? line.message.content : "",
    ];
    for (const b of Array.isArray(line.message?.content) ? line.message.content : [])
      if (b?.type === "text") texts.push(b.text);
    for (const n of texts.flatMap((t) => (t.includes("<task-notification>") ? parseNotifications(t) : []))) {
      if (n.toolUseId) finished.add(n.toolUseId);
      else if (taskToCall.has(n.taskId)) finished.add(taskToCall.get(n.taskId)!);
    }
  }
  return new Set([...launched].filter((id) => !finished.has(id)));
}

const found = sessions();

describe.skipIf(!found.length)("anonymized fixtures", () => {
  for (const s of found) {
    it(`${s.name}: background work running matches the raw logs at several points`, () => {
      const store = createMemoryStore();
      const checkpoints = [0.25, 0.5, 0.75, 1].map((f) => Math.floor(s.lines.length * f));
      let i = 0;
      for (const cp of checkpoints) {
        for (; i < cp; i += 200) store.apply(parseLines(s.lines.slice(i, Math.min(i + 200, cp)), store.ctx));
        i = cp;
        const running = store
          .events()
          .filter(
            (e) =>
              (e.event_type === "tool_call" || e.event_type === "subagent_spawn") &&
              e.status === "running" &&
              e.payload.background,
          )
          .map((e) => e.tool_use_id);
        expect(new Set(running)).toEqual(naiveRunning(s.lines.slice(0, cp)));
      }
      const spawns = store.events().filter((e) => e.event_type === "subagent_spawn").length;
      const subFiles = new Set(s.lines.filter((l) => l.file.includes("/subagents/")).map((l) => l.file)).size;
      expect(store.links().length).toBeGreaterThanOrEqual(Math.min(spawns, subFiles) - 1);
    });
  }
});
