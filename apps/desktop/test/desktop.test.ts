import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildDemoScript,
  createMemoryStore,
  emptyProfile,
  parseLines,
  reviewPrompts,
  stampDemo,
  type RawLine,
} from "@agenttrace/core";
import { openStore } from "../src/main/db";
import { createServer, type Auth } from "../src/main/server";
import { Watcher } from "../src/main/watcher";
import { fileInfo, filesForAi, suggestFiles } from "../src/main/coachfiles";
import {
  addNote,
  listNotes,
  listUsers,
  notesForAi,
  readLearnings,
  safeUser,
  userDir,
  writeLearnings,
} from "../src/main/notes";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agenttrace-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const T0 = Date.parse("2026-11-04T12:00:00Z");

describe("SQLite store", () => {
  it("stores the demo exactly like the in-memory reference store", () => {
    const lines = stampDemo(buildDemoScript("demo-x"), T0);
    const store = openStore(path.join(tmp, "parity.db"));
    const mem = createMemoryStore();
    for (let i = 0; i < lines.length; i += 9) {
      store.apply(parseLines(lines.slice(i, i + 9), store.ctx));
      mem.apply(parseLines(lines.slice(i, i + 9), mem.ctx));
    }
    const norm = (es: any[]) => es.map((e) => ({ ...e })).sort((a, b) => a.source_uuid.localeCompare(b.source_uuid));
    expect(norm(store.events("demo-x"))).toEqual(norm(mem.events("demo-x")));
    const s = store.session("demo-x")!;
    const m = mem.sessions()[0];
    expect([s.event_count, s.total_input_tokens, s.total_output_tokens]).toEqual([
      m.event_count,
      m.total_input_tokens,
      m.total_output_tokens,
    ]);
    expect(store.todos("demo-x").length).toBe(mem.todos("demo-x").length);
    // replaying the same lines changes nothing
    store.apply(parseLines(lines, store.ctx));
    expect(store.session("demo-x")!.event_count).toBe(s.event_count);
    store.close();
  });

  it("deletes everything on request and keeps offsets so logs are not re-imported", () => {
    const store = openStore(path.join(tmp, "delete.db"));
    store.apply(parseLines(stampDemo(buildDemoScript("d"), T0), store.ctx), new Map([["/x.jsonl", 42]]));
    store.saveSessionInsights("d", [], emptyProfile(), T0, reviewPrompts(store.events("d")));
    store.saveExplanation("d", "## In short\nDone.", T0);
    store.deleteAll();
    expect(store.sessions()).toHaveLength(0);
    expect(store.promptReviews()).toHaveLength(0);
    expect(store.explanation("d")).toBeNull();
    expect(store.getOffset("/x.jsonl")).toBe(42);
    store.close();
  });

  it("stores prompt reviews, advice with its fix and explanations, and upgrades an older database", () => {
    const file = path.join(tmp, "upgrade.db");
    const old = new Database(file); // the first release's table, without the fix column
    old.exec(
      "CREATE TABLE insight_signals (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT, severity TEXT, title TEXT, detail TEXT, numbers TEXT, created_at INTEGER NOT NULL)",
    );
    old.close();
    const store = openStore(file);
    store.apply(parseLines(stampDemo(buildDemoScript("u"), T0), store.ctx));
    const reviews = reviewPrompts(store.events("u", 20000));
    const advice = {
      id: "u:subagent-explore:all",
      session_id: "u",
      kind: "subagent-explore",
      severity: "low" as const,
      title: "Use an Explore subagent",
      detail: "d",
      numbers: { searches: 20 },
      fix: "Use the Explore subagent to …",
    };
    store.saveSessionInsights("u", [advice], emptyProfile(), T0, reviews);
    expect(store.signals("u")).toEqual([{ ...advice }]);
    expect(store.promptReviews(10, "u")).toEqual(reviews);
    expect(store.promptStats().prompts).toBe(1);
    store.saveExplanation("u", "first", T0);
    store.saveExplanation("u", "second", T0 + 1);
    expect(store.explanation("u")).toEqual({ text: "second", created_at: T0 + 1 });
    store.deleteSessions(["u"]);
    expect(store.promptReviews()).toHaveLength(0);
    expect(store.explanation("u")).toBeNull();
    store.close();
  });
});

describe("files for prompt coaching", () => {
  const home = path.join(tmp, "claude-home");
  const proj = path.join(tmp, "proj");
  fs.mkdirSync(path.join(home, "agents"), { recursive: true });
  fs.mkdirSync(path.join(proj, ".claude", "commands"), { recursive: true });
  fs.writeFileSync(path.join(home, "CLAUDE.md"), "# Global\nAlways plan first.");
  fs.writeFileSync(path.join(home, "agents", "reviewer.md"), "Review the diff.");
  fs.writeFileSync(path.join(home, "agents", "notes.txt"), "not an agent");
  fs.writeFileSync(path.join(proj, "CLAUDE.md"), "Project rules ".repeat(2000));
  fs.writeFileSync(path.join(proj, ".claude", "commands", "ship.md"), "Ship it.");
  fs.writeFileSync(path.join(proj, "logo.md"), Buffer.from([0x89, 0x50, 0x00, 0x01]));

  it("suggests instruction files from the Claude folder and the session folders", () => {
    const found = suggestFiles(home, [proj, proj, path.join(tmp, "missing")]).map((p) => path.relative(tmp, p));
    expect(found).toEqual([
      path.join("claude-home", "CLAUDE.md"),
      path.join("claude-home", "agents", "reviewer.md"),
      path.join("proj", "CLAUDE.md"),
      path.join("proj", ".claude", "commands", "ship.md"),
    ]);
  });

  it("sends short names and bounded text, never binary files or full paths", () => {
    const files = filesForAi(
      [
        path.join(home, "CLAUDE.md"),
        path.join(proj, "logo.md"),
        path.join(proj, "CLAUDE.md"),
        path.join(tmp, "gone.md"),
      ],
      1000,
      1500,
    );
    const tmpName = path.basename(tmp);
    expect(files.map((f) => f.name)).toEqual([`${tmpName}/claude-home/CLAUDE.md`, `${tmpName}/proj/CLAUDE.md`]);
    expect(files[1].text.length).toBeLessThanOrEqual(1500 - files[0].text.length);
    expect(JSON.stringify(files)).not.toContain(tmp.replace(/\\/g, "\\\\"));
    const gone = fileInfo(path.join(tmp, "gone.md"));
    expect(gone.exists).toBe(false);
    expect(gone.name.endsWith("/gone.md")).toBe(true);
  });
});

describe("notes folder", () => {
  const root = path.join(tmp, "notes");

  it("keeps every user in their own folder and never escapes the root", () => {
    expect(safeUser("../../etc")).toBe("etc");
    expect(safeUser("..")).toBe("default");
    expect(safeUser("C:\\Windows\\System32")).toBe("CWindowsSystem32");
    expect(safeUser("  Άννα Π.  ")).toBe("Άννα Π");
    const dir = userDir(root, "../Maria");
    expect(path.dirname(dir)).toBe(root);
    userDir(root, "Nikos");
    expect(listUsers(root)).toEqual(["Maria", "Nikos"]);
  });

  it("writes notes as files, lists them by kind and gives the AI a bounded text with the learnings first", () => {
    const dir = userDir(root, "Maria");
    addNote(dir, "goal", "Ship the checkout redesign.", T0);
    addNote(dir, "goal", "Second goal in the same second.", T0);
    addNote(dir, "saved", "Use an Explore subagent.", T0 + 60_000, "Explore first");
    fs.writeFileSync(path.join(dir, "my-own.txt"), "Explain things to me in Greek.");
    fs.writeFileSync(path.join(dir, "image.png"), "not a note");
    expect(() => addNote(dir, "lesson", "   ", T0)).toThrow(/empty/);

    const notes = listNotes(dir);
    expect(notes.map((n) => n.kind).sort()).toEqual(["file", "goal", "goal", "saved"]);
    expect(notes.find((n) => n.kind === "saved")!.preview).toBe("Use an Explore subagent.");

    writeLearnings(dir, "## What I work on\nCheckout.", T0);
    writeLearnings(dir, "## What I work on\nCheckout and notes.", T0 + 1);
    expect(readLearnings(dir)!.text).toMatch(/Checkout and notes\./);
    expect(fs.readFileSync(path.join(dir, "_learnings.prev.md"), "utf8")).toMatch(/Checkout\.\n/);
    expect(listNotes(dir)).toHaveLength(4); // learnings files are not notes

    const text = notesForAi(dir);
    expect(text.indexOf("My learnings file")).toBe(4);
    expect(text).toContain("Explain things to me in Greek.");
    expect(text).not.toContain("not a note");
    expect(notesForAi(dir, 120).length).toBeLessThanOrEqual(120);
  });
});

describe("local server", () => {
  const store = openStore(path.join(tmp, "server.db"));
  store.apply(parseLines(stampDemo(buildDemoScript("srv"), T0), store.ctx));
  const ui = path.join(tmp, "ui");
  fs.mkdirSync(ui, { recursive: true });
  fs.writeFileSync(path.join(ui, "index.html"), "<!doctype html><title>ui</title>");
  let remote = false;
  const auth: Auth = {
    required: () => remote,
    token: () => "secret-token-0123456789abcdef0123456789",
    sessions: new Set(),
    persist: () => {},
  };
  const server = createServer({ store, uiDir: ui, auth, info: () => ({ ok: true }), insights: () => ({}) });
  let base = "";
  afterAll(() => {
    server.stop();
    store.close(); // an open database keeps the temp folder locked on Windows
  });

  it("is read-only by design: the only non-GET route is POST /login", () => {
    const writes = server.routes.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`);
    expect(writes).toEqual(["POST /login"]);
  });

  it("serves the API locally and refuses writes", async () => {
    const http = await import("node:http");
    const srv = http.createServer(server.handle);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(srv.address() as any).port}`;
    const sessions = await (await fetch(base + "/api/sessions")).json();
    expect(sessions[0].id).toBe("srv");
    const events = await (await fetch(base + "/api/sessions/srv/events")).json();
    expect(events.length).toBeGreaterThan(70);
    expect(await (await fetch(base + "/api/sessions/srv/explanation")).json()).toBeNull();
    store.saveExplanation("srv", "## In short\nAll green.", T0);
    expect((await (await fetch(base + "/api/sessions/srv/explanation")).json()).text).toMatch(/All green/);
    expect((await fetch(base + "/api/sessions", { method: "POST" })).status).toBe(405);
    expect((await fetch(base + "/api/sessions/srv/events", { method: "DELETE" })).status).toBe(405);
    // DNS-rebinding guard while local-only
    const status = await new Promise<number>((resolve) =>
      http.get(base + "/api/sessions", { headers: { Host: "evil.example:8787" } }, (r) => resolve(r.statusCode!)),
    );
    expect(status).toBe(401);
  });

  it("with remote viewing on, needs the token, then a cookie; revoking kicks browsers out", async () => {
    remote = true;
    expect((await fetch(base + "/api/sessions")).status).toBe(401);
    const page = await fetch(base + "/", { redirect: "manual" });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/login");
    expect((await fetch(base + "/login")).status).toBe(200);
    const bad = await fetch(base + "/login", { method: "POST", body: JSON.stringify({ token: "nope" }) });
    expect(bad.status).toBe(401);
    const ok = await fetch(base + "/login", { method: "POST", body: JSON.stringify({ token: auth.token() }) });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly; SameSite=Strict/);
    const at = cookie.split(";")[0];
    expect((await fetch(base + "/api/sessions", { headers: { cookie: at } })).status).toBe(200);
    auth.sessions.clear(); // "Revoke all browsers"
    expect((await fetch(base + "/api/sessions", { headers: { cookie: at } })).status).toBe(401);
  });

  it("rate-limits failed logins", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++)
      last = (await fetch(base + "/login", { method: "POST", body: '{"token":"x"}' })).status;
    expect(last).toBe(429);
    remote = false;
  });
});

describe("watcher", () => {
  it("reads only new complete lines and continues after a restart without duplicates", async () => {
    const root = path.join(tmp, "projects");
    const sid = "w-1";
    const file = path.join(root, "-proj", `${sid}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lines = stampDemo(buildDemoScript(sid), T0).filter((l) => !l.file.includes("/subagents/"));
    const write = (from: number, to: number, extra = "") =>
      fs.appendFileSync(
        file,
        lines
          .slice(from, to)
          .map((l) => JSON.stringify(l.line))
          .join("\n") +
          "\n" +
          extra,
      );

    const db = path.join(tmp, "watch.db");
    const run = () => {
      const store = openStore(db);
      const w = new Watcher({
        roots: () => [root],
        backfillHours: () => 24 * 365 * 10,
        getOffset: (f) => store.getOffset(f),
        ingest: (ls: RawLine[], offsets) => store.apply(parseLines(ls, store.ctx), offsets),
      });
      return { store, w };
    };

    write(0, 10, '{"type":"user","partial'); // a half-written line must wait
    let { store, w } = run();
    w.start();
    w.drain();
    w.stop();
    const first = store.session(sid)!.event_count;
    expect(first).toBeGreaterThan(0);
    store.close();

    fs.appendFileSync(file, '": 1}\n'); // the partial line completes (and is not a wanted line)
    write(10, lines.length);
    ({ store, w } = run());
    w.start();
    w.drain();
    w.stop();
    const all = createMemoryStore();
    all.apply(parseLines(lines, all.ctx));
    expect(store.session(sid)!.event_count).toBe(all.sessions()[0].event_count);
    store.close();
  });
});
