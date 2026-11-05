import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, session, shell, Tray } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildAnalysisPayload,
  buildAnalysisPrompt,
  buildDemoScript,
  buildExplainPrompt,
  buildLearnPayload,
  buildLearnPrompt,
  explainPayload,
  parseLines,
  parseSuggestions,
  playDemo,
  reviewPrompts,
  sessionOutline,
  sessionProfile,
  sessionRecap,
  sessionSignals,
  subagentAdvice,
  type AnalysisScope,
  type RawLine,
} from "@agenttrace/core";
import { openStore } from "./db";
import { MAX_FILES, fileInfo, filesForAi, suggestFiles } from "./coachfiles";
import {
  addNote,
  defaultNotesRoot,
  listNotes,
  listUsers,
  notesForAi,
  readLearnings,
  safeUser,
  userDir,
  writeLearnings,
  NOTE_KINDS,
  type NoteKind,
} from "./notes";
import { createServer, type Auth } from "./server";
import { Watcher, defaultProjectsDir } from "./watcher";
import { createSecrets } from "./secrets";
import { lanAddresses, newToken, qrFor, remoteUrls } from "./remote";
import { createProvider, detectClaudeCli, safeError, type ProviderConfig } from "./ai";
import { setupUpdater } from "./updater";

const DEFAULT_PORT = 8787;

interface Settings {
  extraFolder: string;
  backfillHours: number;
  retentionDays: number;
  paused: boolean;
  startAtLogin: boolean;
  remote: { enabled: boolean; host: string; port: number };
  ai: ProviderConfig;
  aiPreviewAck: boolean;
  /** Folder that holds one notes folder per user ("" = Documents/AgentTrace/Notes). */
  notesRoot: string;
  /** Whose notes are active ("" = the OS user name). */
  notesUser: string;
  /** Send the active user's notes along with AI analyses (always shown in the preview). */
  notesInAi: boolean;
  /** Files the user chose for prompt coaching (absolute paths). */
  coachFiles: string[];
}
const DEFAULTS: Settings = {
  extraFolder: "",
  backfillHours: 24,
  retentionDays: 30,
  paused: false,
  startAtLogin: false,
  remote: { enabled: false, host: "0.0.0.0", port: DEFAULT_PORT },
  ai: { kind: "none" },
  aiPreviewAck: false,
  notesRoot: "",
  notesUser: "",
  notesInAi: true,
  coachFiles: [],
};
/** Bump when the insights rules change, so every stored session is analyzed again once. */
const INSIGHTS_VERSION = 2;
type AiKind = AnalysisScope | "explain" | "learn";

if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(main);

async function main() {
  const userData = app.getPath("userData");
  const logFile = path.join(userData, "main.log");
  const log = (m: string) => {
    console.log(m);
    fs.appendFile(logFile, `${new Date().toISOString()} ${m}\n`, () => {});
  };
  const resource = (...p: string[]) =>
    app.isPackaged ? path.join(process.resourcesPath, ...p) : path.join(__dirname, "../../build", ...p);
  const uiDir = app.isPackaged
    ? path.join(process.resourcesPath, "ui")
    : path.resolve(__dirname, "../../../../packages/ui/dist");

  const store = openStore(path.join(userData, "agenttrace.db"));
  const secrets = await createSecrets(path.join(userData, "secrets.json"), safeStorage);
  const settings = (): Settings => {
    const s = store.getSetting<Partial<Settings>>("settings", {});
    return { ...DEFAULTS, ...s, remote: { ...DEFAULTS.remote, ...s.remote }, ai: { ...DEFAULTS.ai, ...s.ai } };
  };
  const saveSettings = (patch: Partial<Settings>) => store.setSetting("settings", { ...settings(), ...patch });

  // ---- pipeline: watcher and demo both feed parseLines → SQLite → SSE ----
  const ingest = (lines: RawLine[], offsets = new Map<string, number>()) => {
    const changes = store.apply(parseLines(lines, store.ctx), offsets);
    if (changes.events.length || changes.todos.length || changes.relinked.length) server.broadcast("changes", changes);
  };
  const roots = () => [defaultProjectsDir(), settings().extraFolder].filter((d) => d && fs.existsSync(d));
  const watcher = new Watcher({
    roots,
    backfillHours: () => settings().backfillHours,
    getOffset: (f) => store.getOffset(f),
    ingest,
    log,
  });

  // ---- server and remote-viewing auth ----
  const auth: Auth = {
    required: () => settings().remote.enabled,
    token: () => secrets.get("remoteToken"),
    sessions: new Set(store.getSetting<string[]>("remoteSessions", [])),
    persist: () => store.setSetting("remoteSessions", [...auth.sessions]),
  };
  const server = createServer({
    store,
    uiDir,
    auth,
    log,
    info: () => ({
      version: app.getVersion(),
      watching: roots(),
      sessions: store.sessions().length,
      paused: watcher.paused,
      remote: settings().remote.enabled,
      hostname: os.hostname(),
    }),
    insights: () => ({
      signals: store.signals(),
      profile: store.profile(),
      suggestions: store.suggestions(),
      prompts: store.promptReviews(150),
      promptStats: store.promptStats(),
    }),
  });

  let port = DEFAULT_PORT;
  const listen = async () => {
    const r = settings().remote;
    const hosts = r.enabled ? (r.host === "0.0.0.0" ? ["0.0.0.0"] : ["127.0.0.1", r.host]) : ["127.0.0.1"];
    for (let p = r.port; p < r.port + 10; p++) {
      try {
        port = await server.listen(hosts, p);
        log(`listening on ${hosts.join(", ")}:${port}`);
        return;
      } catch (e) {
        log(`port ${p} unavailable: ${(e as Error).message}`);
      }
    }
    throw new Error("No free port for the local server.");
  };
  const origin = () => `http://127.0.0.1:${port}`;
  /** The app window is always signed in: give it its own session cookie. */
  const signInWindow = async () => {
    if (!settings().remote.enabled) return;
    const value = crypto.randomBytes(32).toString("base64url");
    auth.sessions.add(crypto.createHash("sha256").update(value).digest("hex"));
    auth.persist();
    await session.defaultSession.cookies.set({
      url: origin(),
      name: "at_session",
      value,
      httpOnly: true,
      sameSite: "strict",
    });
  };

  await listen();
  await signInWindow();
  if (!settings().paused) watcher.start();
  else watcher.paused = true;

  // ---- window and tray ----
  let win: BrowserWindow | null = null;
  let quitting = false;
  const showWindow = () => {
    if (win) {
      win.show();
      win.focus();
      return;
    }
    win = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 960,
      minHeight: 600,
      backgroundColor: "#080b10",
      title: "AgentTrace",
      icon: resource("icon.png"),
      webPreferences: { preload: path.join(__dirname, "../preload/index.js"), contextIsolation: true, sandbox: true },
    });
    const isOurs = (url: string) => {
      try {
        const o = new URL(url).origin;
        return o === origin() || o === process.env.AGENTTRACE_UI_URL?.replace(/\/$/, "");
      } catch {
        return false;
      }
    };
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (e, url) => {
      if (!isOurs(url)) {
        e.preventDefault();
        if (/^https?:/.test(url)) shell.openExternal(url);
      }
    });
    win.on("close", (e) => {
      if (!quitting) {
        e.preventDefault();
        win?.hide();
      }
    });
    win.on("closed", () => (win = null));
    win.loadURL(process.env.AGENTTRACE_UI_URL || origin());
  };

  const trayImg = nativeImage.createFromPath(resource(process.platform === "darwin" ? "trayTemplate.png" : "tray.png"));
  if (process.platform === "darwin") trayImg.setTemplateImage(true);
  const tray = new Tray(trayImg);
  tray.setToolTip("AgentTrace");
  const refreshTray = () =>
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open AgentTrace", click: showWindow },
        {
          label: "Pause watching",
          type: "checkbox",
          checked: watcher.paused,
          click: (item) => setPaused(item.checked),
        },
        { type: "separator" },
        { label: "Quit", click: () => app.quit() },
      ]),
    );
  const setPaused = (paused: boolean) => {
    saveSettings({ paused });
    watcher.paused = paused;
    if (paused) watcher.stop();
    else watcher.restart();
    refreshTray();
    server.broadcast("info", {});
  };
  refreshTray();
  tray.on("click", () => (process.platform === "win32" ? showWindow() : undefined));

  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app.on("window-all-closed", () => {}); // keep running in the tray
  app.on("before-quit", () => {
    quitting = true;
    watcher.stop();
    server.stop();
    server.close();
    store.close();
  });

  // ---- insights: rules every 15 min and when a session goes quiet ----
  const analyze = (idleOnly: boolean, all = false) => {
    try {
      const now = Date.now();
      const stale = all ? store.sessionIds(0) : store.staleSessions(now, idleOnly);
      if (!stale.length) return;
      const averages = store.subagentAverages(now);
      for (const sid of stale) {
        const events = store.events(sid, 20000);
        store.saveSessionInsights(
          sid,
          [...sessionSignals(events, now, averages), ...subagentAdvice(events, now)],
          sessionProfile(events, (t) => new Date(t).getHours()),
          now,
          reviewPrompts(events),
        );
      }
      server.broadcast("insights", {});
    } catch (e) {
      log(`insights failed: ${(e as Error).message}`);
    }
  };
  setTimeout(() => {
    const upgrade = store.getSetting<number>("insightsVersion", 1) < INSIGHTS_VERSION;
    analyze(false, upgrade);
    if (upgrade) store.setSetting("insightsVersion", INSIGHTS_VERSION);
  }, 15_000);
  setInterval(() => analyze(true), 60_000);
  setInterval(() => analyze(false), 15 * 60_000);
  const retain = () => store.retain(settings().retentionDays, Date.now());
  retain();
  setInterval(retain, 6 * 3600_000);

  // ---- IPC (app window only) ----
  const handle = (channel: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(channel, (e, ...args) => {
      const url = e.senderFrame?.url ?? "";
      const allowed = [origin(), process.env.AGENTTRACE_UI_URL].filter(Boolean).some((o) => url.startsWith(o!));
      if (!allowed) throw new Error("Not allowed from this page.");
      return fn(...args);
    });

  handle("settings:get", () => ({ ...settings(), projectsDir: defaultProjectsDir(), version: app.getVersion() }));
  handle("settings:set", (patch: Partial<Settings>) => {
    const before = settings();
    const allowed: Partial<Settings> = {};
    if (typeof patch.extraFolder === "string") allowed.extraFolder = patch.extraFolder;
    if (Number.isFinite(patch.backfillHours))
      allowed.backfillHours = Math.max(0, Math.min(24 * 30, Number(patch.backfillHours)));
    if (Number.isFinite(patch.retentionDays))
      allowed.retentionDays = Math.max(1, Math.min(3650, Number(patch.retentionDays)));
    if (typeof patch.startAtLogin === "boolean") {
      allowed.startAtLogin = patch.startAtLogin;
      app.setLoginItemSettings({ openAtLogin: patch.startAtLogin });
    }
    saveSettings(allowed);
    if (typeof patch.paused === "boolean" && patch.paused !== before.paused) setPaused(patch.paused);
    if (allowed.extraFolder !== undefined && allowed.extraFolder !== before.extraFolder && !watcher.paused)
      watcher.restart();
    if (allowed.retentionDays !== undefined) retain();
    return settings();
  });
  handle("folder:pick", async () => {
    const r = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return r.canceled ? null : r.filePaths[0];
  });

  let demo: AbortController | null = null;
  const startDemo = () => {
    demo?.abort();
    demo = new AbortController();
    const sid = "demo-" + crypto.randomUUID();
    store.markDemo(sid, Date.now());
    playDemo(buildDemoScript(sid), (item) => ingest([item]), demo.signal).catch((e) =>
      log(`demo failed: ${e.message}`),
    );
    return sid;
  };
  handle("demo:load", startDemo);
  if (process.env.AGENTTRACE_DEMO) startDemo(); // screenshots / README GIF
  handle("demo:clear", () => {
    demo?.abort();
    store.deleteSessions(store.demoSessionIds());
    server.broadcast("reset", {});
  });
  handle("data:deleteAll", () => {
    demo?.abort();
    store.deleteAll();
    server.broadcast("reset", {});
  });

  // remote viewing
  const remoteState = async () => {
    const r = settings().remote;
    const token = r.enabled ? secrets.get("remoteToken") : null;
    const { urls, tailscale } = r.enabled ? await remoteUrls(port, r.host) : { urls: [], tailscale: null };
    const best = urls.find((u) => u.label === "Tailscale") ?? urls.find((u) => u.label.startsWith("LAN")) ?? urls[0];
    return {
      ...r,
      port,
      token,
      urls,
      tailscale,
      interfaces: lanAddresses(),
      qr: token && best ? { url: best.url, image: await qrFor(best.url, token) } : null,
      keychain: await secrets.available(),
    };
  };
  const relisten = async () => {
    await server.close();
    await listen();
    await signInWindow();
    win?.loadURL(origin());
  };
  handle("remote:get", remoteState);
  handle("remote:set", async (patch: { enabled?: boolean; host?: string }) => {
    const r = settings().remote;
    const next = {
      ...r,
      ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
      ...(typeof patch.host === "string" && /^[\d.:a-f]+$/i.test(patch.host) ? { host: patch.host } : {}),
    };
    if (next.enabled && !secrets.get("remoteToken")) await secrets.set("remoteToken", newToken());
    saveSettings({ remote: next });
    await relisten();
    return remoteState();
  });
  handle("remote:revoke", async () => {
    await secrets.set("remoteToken", newToken());
    auth.sessions.clear();
    auth.persist();
    server.kickAll();
    await signInWindow();
    win?.webContents.reload();
    return remoteState();
  });

  // AI provider
  const aiKey = () => secrets.get("aiKey");
  handle("ai:get", async () => ({
    config: settings().ai,
    hasKey: !!aiKey(),
    claudeCli: await detectClaudeCli(),
    previewAck: settings().aiPreviewAck,
  }));
  handle("ai:set", async (cfg: ProviderConfig, apiKey?: string | null) => {
    const kinds = ["none", "claude-cli", "anthropic", "openai"];
    if (!kinds.includes(cfg.kind)) throw new Error("Unknown provider.");
    saveSettings({
      ai: {
        kind: cfg.kind,
        model: String(cfg.model ?? "").slice(0, 200),
        baseUrl: String(cfg.baseUrl ?? "").slice(0, 500),
      },
    });
    if (apiKey !== undefined) await secrets.set("aiKey", apiKey ? String(apiKey) : null);
    return { config: settings().ai, hasKey: !!aiKey() };
  });
  // ---- notes: one folder per user, read by the AI only when asked ----
  const notesRoot = () => settings().notesRoot || defaultNotesRoot(app.getPath("documents"));
  const osUser = () => {
    try {
      return os.userInfo().username;
    } catch {
      return "me";
    }
  };
  const notesUser = () => safeUser(settings().notesUser || osUser());
  const notesDir = () => userDir(notesRoot(), notesUser());
  const aiNotes = () => (settings().notesInAi ? notesForAi(notesDir()) : "");
  const notesState = () => {
    const dir = notesDir();
    const users = listUsers(notesRoot());
    return {
      root: notesRoot(),
      customRoot: !!settings().notesRoot,
      user: notesUser(),
      dir,
      users: users.includes(notesUser()) ? users : [...users, notesUser()].sort(),
      inAi: settings().notesInAi,
      notes: listNotes(dir),
      learnings: readLearnings(dir),
      kinds: NOTE_KINDS,
    };
  };
  handle("notes:get", notesState);
  handle("notes:add", (kind: NoteKind, text: string) => {
    addNote(notesDir(), kind, String(text ?? ""), Date.now());
    return notesState();
  });
  handle("notes:user", (name: string) => {
    saveSettings({ notesUser: safeUser(String(name ?? "")) });
    return notesState();
  });
  handle("notes:inAi", (on: boolean) => {
    saveSettings({ notesInAi: on === true });
    return notesState();
  });
  handle("notes:open", async () => {
    const err = await shell.openPath(notesDir());
    if (err) throw new Error(err);
  });
  handle("notes:pickRoot", async () => {
    const r = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    if (!r.canceled && r.filePaths[0]) saveSettings({ notesRoot: r.filePaths[0] });
    return notesState();
  });
  handle("notes:resetRoot", () => {
    saveSettings({ notesRoot: "" });
    return notesState();
  });
  handle("notes:remember", (id: number) => {
    const s = store.suggestion(Number(id));
    if (!s) throw new Error("That suggestion no longer exists.");
    addNote(notesDir(), "saved", `${s.why}\n\n${s.fix_kind.replace(/_/g, " ")}:\n\n${s.fix}`, Date.now(), s.title);
    return notesState();
  });

  // ---- files for prompt coaching: only files the user adds here are read, and only when they ask ----
  let suggested = new Set<string>();
  const coachState = () => {
    const chosen = settings().coachFiles;
    const projects = store
      .sessions()
      .map((s) => s.project_path)
      .filter((p): p is string => !!p);
    const found = suggestFiles(path.dirname(defaultProjectsDir()), projects).filter((p) => !chosen.includes(p));
    suggested = new Set(found);
    return { files: chosen.map(fileInfo), suggestions: found.map(fileInfo), max: MAX_FILES };
  };
  const addCoachFiles = (paths: string[]) => {
    const chosen = settings().coachFiles;
    saveSettings({ coachFiles: [...new Set([...chosen, ...paths])].slice(0, MAX_FILES) });
  };
  handle("coach:get", coachState);
  handle("coach:pick", async () => {
    const r = await dialog.showOpenDialog({
      title: "Choose files to coach",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Prompts and instructions",
          extensions: ["md", "markdown", "txt", "prompt", "yaml", "yml", "json", "toml"],
        },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (!r.canceled) addCoachFiles(r.filePaths);
    return coachState();
  });
  handle("coach:add", (p: string) => {
    if (!suggested.has(String(p))) throw new Error("Pick that file with “Add files…” instead.");
    addCoachFiles([String(p)]);
    return coachState();
  });
  handle("coach:remove", (p: string) => {
    saveSettings({ coachFiles: settings().coachFiles.filter((x) => x !== String(p)) });
    return coachState();
  });

  // ---- AI: every request is built here, and the exact payload can be previewed first ----
  const payloadFor = (kind: AiKind, sid?: string) => {
    const notes = aiNotes();
    if (kind === "explain") {
      if (!sid) throw new Error("Pick a session first.");
      const recap = sessionRecap(store.events(sid, 20000), store.todos(sid), store.session(sid)?.project_path ?? "");
      const payload = explainPayload(recap, notes || undefined);
      return { payload, prompt: buildExplainPrompt(payload) };
    }
    if (kind === "learn") {
      const payload = buildLearnPayload(
        notes || notesForAi(notesDir()),
        store.promptStats(),
        store.promptReviews(60),
        store.profile(),
        store.signals(),
        store.votes(),
      );
      return { payload, prompt: buildLearnPrompt(payload) };
    }
    if (kind === "files") {
      const files = filesForAi(settings().coachFiles);
      if (!files.length) throw new Error("Add the files you want coached first.");
      const payload = buildAnalysisPayload(
        "files",
        store.signals().slice(0, 20),
        store.profile(),
        store.votes(),
        undefined,
        {
          notes: notes || undefined,
          promptStats: store.promptStats(),
          files,
        },
      );
      return { payload, prompt: buildAnalysisPrompt(payload) };
    }
    const events = kind === "session" && sid ? store.events(sid, 20000) : [];
    const signals = kind === "session" && sid ? store.signals(sid) : store.signals().slice(0, 50);
    const payload = buildAnalysisPayload(
      kind,
      signals,
      store.profile(),
      store.votes(),
      kind === "session" ? sessionOutline(events) : undefined,
      {
        notes: notes || undefined,
        ...(kind === "prompts" ? { prompts: store.promptReviews(40), promptStats: store.promptStats() } : {}),
        ...(kind === "session" && sid ? { prompts: store.promptReviews(20, sid) } : {}),
      },
    );
    return { payload, prompt: buildAnalysisPrompt(payload) };
  };
  const runAi = async <T>(label: string, work: (complete: (prompt: string) => Promise<string>) => Promise<T>) => {
    try {
      const provider = await createProvider(settings().ai, aiKey());
      if (!provider) throw new Error("Pick an AI provider in Settings first.");
      const result = await work((p) => provider.complete(p));
      saveSettings({ aiPreviewAck: true });
      return { ok: true as const, ...result };
    } catch (e) {
      const msg = safeError(e, [aiKey()]);
      log(`${label} failed: ${msg}`);
      return { ok: false as const, error: msg };
    }
  };
  const markdownReply = (text: string) =>
    text
      .trim()
      .replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i, "$1")
      .trim();

  handle("ai:payload", (kind: AiKind, sid?: string) => payloadFor(kind, sid));
  handle("ai:analyze", (scope: AnalysisScope, sid?: string) =>
    runAi("analyze", async (complete) => {
      if (!["session", "overall", "prompts", "files"].includes(scope)) throw new Error("Unknown analysis.");
      if (scope === "session" && sid) analyze(false);
      const list = parseSuggestions(await complete(payloadFor(scope, sid).prompt));
      store.saveSuggestions(scope, scope === "session" ? (sid ?? null) : null, list, Date.now());
      server.broadcast("insights", {});
      return { count: list.length };
    }),
  );
  handle("ai:explain", (sid: string) =>
    runAi("explain", async (complete) => {
      const text = markdownReply(await complete(payloadFor("explain", String(sid)).prompt));
      if (!text) throw new Error("The model returned an empty explanation.");
      store.saveExplanation(String(sid), text.slice(0, 20_000), Date.now());
      server.broadcast("explain", { session_id: sid });
      return {};
    }),
  );
  handle("ai:learn", () =>
    runAi("learn", async (complete) => {
      const { payload, prompt } = payloadFor("learn");
      if (!(payload as { user_notes: string }).user_notes && !store.promptStats().prompts)
        throw new Error("Add a few notes first, or use Claude Code for a while, so there is something to learn from.");
      const text = markdownReply(await complete(prompt));
      if (!text) throw new Error("The model returned an empty reply.");
      writeLearnings(notesDir(), text.slice(0, 20_000), Date.now());
      return {};
    }),
  );
  handle("ai:vote", (id: number, vote: 1 | -1 | null) => {
    store.vote(Number(id), vote === 1 || vote === -1 ? vote : null);
    server.broadcast("insights", {});
  });
  handle("insights:run", () => analyze(false));
  handle("open:external", (url: string) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });

  showWindow();
  setupUpdater(log);
}
