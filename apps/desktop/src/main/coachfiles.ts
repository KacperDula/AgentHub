import fs from "node:fs";
import path from "node:path";
import type { CoachFile } from "@agenttrace/core";

/**
 * Files the user picks for prompt coaching: CLAUDE.md, agent and subagent definitions, slash commands, skills,
 * prompt templates. Only files the user added are ever read for the AI, and only when they ask for coaching.
 */

export interface CoachFileInfo {
  path: string;
  /** Short name shown to the user and the AI: the last folders and the file name, never the full path. */
  name: string;
  size: number;
  words: number;
  modified: number;
  exists: boolean;
}

const MAX_READ = 400_000;
export const MAX_FILES = 30;

/** The last `parts` path segments, e.g. "agenthub/.claude/agents/reviewer.md". */
export const shortName = (p: string, parts = 3) => p.split(/[\\/]/).filter(Boolean).slice(-parts).join("/");

function readText(file: string, max = MAX_READ): string | null {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(Math.min(max, fs.fstatSync(fd).size));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const b = buf.subarray(0, n);
    if (b.subarray(0, 4096).includes(0)) return null; // binary
    return b.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export function fileInfo(p: string): CoachFileInfo {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) throw new Error("not a file");
    const text = readText(p) ?? "";
    return {
      path: p,
      name: shortName(p),
      size: st.size,
      words: text.split(/\s+/).filter(Boolean).length,
      modified: st.mtimeMs,
      exists: true,
    };
  } catch {
    return { path: p, name: shortName(p), size: 0, words: 0, modified: 0, exists: false };
  }
}

/** The chosen files' text for the AI: each clipped to `perFile` characters, `total` at most. */
export function filesForAi(paths: string[], perFile = 15_000, total = 60_000): CoachFile[] {
  const out: CoachFile[] = [];
  let used = 0;
  for (const p of paths) {
    if (used >= total) break;
    try {
      const text = readText(p);
      if (text == null || !text.trim()) continue;
      const room = Math.min(perFile, total - used);
      const clipped = text.length > room ? text.slice(0, room - 1) + "…" : text;
      out.push({ name: shortName(p), text: clipped });
      used += clipped.length;
    } catch {
      /* unreadable or gone: skip */
    }
  }
  return out;
}

const mdIn = (dir: string, max = 40): string[] => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && /\.md$/i.test(d.name))
      .slice(0, max)
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
};

/**
 * Instruction files found on this computer that are worth coaching: the user's own CLAUDE.md, agents and commands,
 * and the same in the folders of their recent sessions.
 */
export function suggestFiles(claudeHome: string, projectDirs: string[], max = 60): string[] {
  const found: string[] = [];
  const add = (p: string) => {
    try {
      if (!found.includes(p) && fs.statSync(p).isFile()) found.push(p);
    } catch {
      /* missing */
    }
  };
  add(path.join(claudeHome, "CLAUDE.md"));
  mdIn(path.join(claudeHome, "agents")).forEach(add);
  mdIn(path.join(claudeHome, "commands")).forEach(add);
  for (const dir of [...new Set(projectDirs)].slice(0, 30)) {
    add(path.join(dir, "CLAUDE.md"));
    add(path.join(dir, ".claude", "CLAUDE.md"));
    add(path.join(dir, "AGENTS.md"));
    mdIn(path.join(dir, ".claude", "agents")).forEach(add);
    mdIn(path.join(dir, ".claude", "commands")).forEach(add);
    if (found.length >= max) break;
  }
  return found.slice(0, max);
}
