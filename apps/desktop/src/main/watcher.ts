import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isWantedLine, type RawLine } from "@agenttrace/core";

const MAX_STR = 2000; // trim long strings (privacy + size), like forwarder v2
const POLL_MS = 5000;
const BATCH = 1000;

/** ~/.claude/projects on macOS, Windows and Linux (honours CLAUDE_CONFIG_DIR). */
export function defaultProjectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(base, "projects");
}

export function trim(v: unknown): unknown {
  if (typeof v === "string") return v.length > MAX_STR ? v.slice(0, MAX_STR) + "...[trimmed]" : v;
  if (Array.isArray(v)) return v.map(trim);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k in v as Record<string, unknown>) o[k] = trim((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}

export function listJsonl(dir: string): string[] {
  let out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(listJsonl(p));
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

export interface WatcherOptions {
  roots: () => string[];
  backfillHours: () => number;
  getOffset: (file: string) => number | undefined;
  /** Parses and stores lines; offsets are saved in the same transaction. */
  ingest: (lines: RawLine[], offsets: Map<string, number>) => void;
  log?: (msg: string) => void;
}

/**
 * Watches Claude Code transcripts and feeds new complete lines to `ingest`. Reads only new bytes per file;
 * offsets live in SQLite so a restart continues where it stopped. Files never seen before are backfilled
 * when modified within `backfillHours`, otherwise read from their current end.
 */
export class Watcher {
  private offsets = new Map<string, number>();
  private dirty = new Set<string>();
  private watchers: fs.FSWatcher[] = [];
  private timers: NodeJS.Timeout[] = [];
  private busy = false;
  paused = false;

  constructor(private opts: WatcherOptions) {}

  start() {
    const cutoff = Date.now() - this.opts.backfillHours() * 3600_000;
    for (const root of this.opts.roots()) {
      for (const f of listJsonl(root)) {
        const stored = this.opts.getOffset(f);
        if (stored != null) this.offsets.set(f, stored);
        else {
          let st: fs.Stats;
          try {
            st = fs.statSync(f);
          } catch {
            continue;
          }
          this.offsets.set(f, st.mtimeMs >= cutoff ? 0 : st.size);
        }
        this.dirty.add(f);
      }
      try {
        this.watchers.push(
          fs.watch(root, { recursive: true }, (_e, name) => {
            if (name && String(name).endsWith(".jsonl")) {
              this.dirty.add(path.join(root, String(name)));
              this.schedule();
            }
          }),
        );
      } catch (e) {
        this.opts.log?.(`fs.watch failed for ${root}, polling only: ${(e as Error).message}`);
      }
    }
    // Catch anything fs.watch missed (new folders, network drives).
    this.timers.push(
      setInterval(() => {
        for (const root of this.opts.roots()) for (const f of listJsonl(root)) this.dirty.add(f);
        this.schedule();
      }, POLL_MS),
    );
    this.schedule();
  }

  stop() {
    for (const w of this.watchers) w.close();
    for (const t of this.timers) clearInterval(t);
    this.watchers = [];
    this.timers = [];
  }

  restart() {
    this.stop();
    this.offsets.clear();
    this.dirty.clear();
    this.start();
  }

  private scheduled = false;
  private schedule() {
    if (this.scheduled || this.paused) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      this.drain();
    }, 300);
  }

  /** Reads new bytes of every dirty file, then ingests them in time order, in chunks. */
  drain() {
    if (this.busy || this.paused) return;
    this.busy = true;
    try {
      const lines: (RawLine & { ts: number; i: number })[] = [];
      const offsets = new Map<string, number>();
      for (const f of this.dirty) {
        const r = this.readNew(f);
        if (!r) continue;
        offsets.set(f, r.offset);
        for (const line of r.lines) {
          const ts = Date.parse((line as any).timestamp);
          lines.push({ file: f.split(path.sep).join("/"), line, ts: Number.isFinite(ts) ? ts : 0, i: lines.length });
        }
      }
      this.dirty.clear();
      if (!offsets.size) return;
      // Several files change at once (main transcript + subagents): process lines in time order.
      lines.sort((a, b) => a.ts - b.ts || a.i - b.i);
      if (!lines.length) return this.opts.ingest([], offsets);
      for (let i = 0; i < lines.length; i += BATCH) {
        const last = i + BATCH >= lines.length;
        this.opts.ingest(
          lines.slice(i, i + BATCH).map(({ file, line }) => ({ file, line })),
          last ? offsets : new Map(),
        );
      }
      for (const [f, o] of offsets) this.offsets.set(f, o);
    } catch (e) {
      this.opts.log?.(`ingest failed: ${(e as Error).stack}`);
    } finally {
      this.busy = false;
    }
  }

  private readNew(file: string): { offset: number; lines: unknown[] } | null {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return null;
    }
    let start = this.offsets.get(file) ?? 0; // a file seen for the first time after start is new: read it all
    if (size < start) start = 0; // rewritten
    if (size === start) return null;
    const buf = Buffer.alloc(size - start);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally {
      fs.closeSync(fd);
    }
    const lastNl = buf.lastIndexOf(10);
    if (lastNl === -1) return null; // no complete line yet
    const lines: unknown[] = [];
    for (const l of buf.subarray(0, lastNl).toString("utf8").split("\n")) {
      if (!l.trim()) continue;
      try {
        const o = JSON.parse(l);
        if (isWantedLine(o)) lines.push(trim(o));
      } catch {
        /* partial or corrupt line: skip */
      }
    }
    return { offset: start + lastNl + 1, lines };
  }
}
