import fs from "node:fs";
import path from "node:path";

/**
 * The notes folder: one sub-folder per user. Each user drops their own .md / .txt files there or writes notes in the
 * app; the AI reads them (only when asked, and shown in the preview first) and keeps a learnings file next to them.
 * These files are private: they are never served over HTTP, only through the app window's IPC.
 */

export const LEARNINGS = "_learnings.md";
const PREVIOUS = "_learnings.prev.md";
const NOTE_EXT = /\.(md|markdown|txt)$/i;
export const NOTE_KINDS = ["goal", "preference", "lesson", "context", "saved"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export interface NoteFile {
  name: string;
  kind: NoteKind | "file";
  size: number;
  modified: number;
  preview: string;
}

export const defaultNotesRoot = (documents: string) => path.join(documents, "AgentTrace", "Notes");

/** A user name usable as a folder name: letters, digits, space, dot, dash, underscore; never "." or "..". */
export function safeUser(name: string): string {
  const s = String(name ?? "")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N} ._-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 40)
    .replace(/[. ]+$/, ""); // Windows drops trailing dots and spaces from folder names

  return s || "default";
}

export function userDir(root: string, user: string): string {
  const dir = path.join(root, safeUser(user));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function listUsers(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

const kindOf = (name: string): NoteFile["kind"] => {
  const m = /-(goal|preference|lesson|context|saved)\.md$/i.exec(name);
  return m ? (m[1].toLowerCase() as NoteKind) : "file";
};

const readText = (file: string, max: number) => {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
};

const body = (text: string) =>
  text
    .replace(/^---[\s\S]*?\n---\s*\n/, "")
    .replace(/^<!--[\s\S]*?-->\s*/, "")
    .replace(/^#[^\n]*\n+/, "")
    .trim();

/** The user's notes, newest first (the learnings files are returned separately). */
export function listNotes(dir: string): NoteFile[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((d) => d.isFile() && NOTE_EXT.test(d.name) && d.name !== LEARNINGS && d.name !== PREVIOUS)
    .map((d) => {
      const file = path.join(dir, d.name);
      const st = fs.statSync(file);
      return {
        name: d.name,
        kind: kindOf(d.name),
        size: st.size,
        modified: st.mtimeMs,
        preview: body(readText(file, 2000)).replace(/\s+/g, " ").slice(0, 280),
      };
    })
    .sort((a, b) => b.modified - a.modified)
    .slice(0, 300);
}

export function readLearnings(dir: string): { text: string; modified: number } | null {
  const file = path.join(dir, LEARNINGS);
  try {
    return { text: readText(file, 40_000), modified: fs.statSync(file).mtimeMs };
  } catch {
    return null;
  }
}

const TITLES: Record<NoteKind, string> = {
  goal: "Goal",
  preference: "How I like to work",
  lesson: "Lesson",
  context: "Project context",
  saved: "Saved suggestion",
};

const stamp = (now: number) => {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** Writes one note as its own Markdown file. Returns the file name. */
export function addNote(dir: string, kind: NoteKind, text: string, now: number, title?: string): string {
  const k: NoteKind = NOTE_KINDS.includes(kind) ? kind : "lesson";
  const clean = String(text ?? "")
    .trim()
    .slice(0, 20_000);
  if (!clean) throw new Error("The note is empty.");
  let name = `${stamp(now)}-${k}.md`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${stamp(now)}-${i}-${k}.md`;
  const heading = title ? `${TITLES[k]}: ${String(title).replace(/\s+/g, " ").slice(0, 160)}` : TITLES[k];
  fs.writeFileSync(path.join(dir, name), `# ${heading}\n\n${clean}\n`, "utf8");
  return name;
}

/** Replaces the learnings file and keeps the previous version next to it. */
export function writeLearnings(dir: string, markdown: string, now: number): void {
  const file = path.join(dir, LEARNINGS);
  if (fs.existsSync(file)) fs.copyFileSync(file, path.join(dir, PREVIOUS));
  const header = `<!-- Written by AgentTrace on ${new Date(now).toISOString().slice(0, 16).replace("T", " ")}. Edit it freely: it is used as context the next time. -->\n\n`;
  fs.writeFileSync(file, header + markdown.trim() + "\n", "utf8");
}

/**
 * The notes as one text for the AI: the learnings file first, then notes newest first, each clipped,
 * up to `max` characters in total.
 */
export function notesForAi(dir: string, max = 12_000): string {
  const parts: string[] = [];
  let used = 0;
  const push = (label: string, text: string) => {
    const t = body(text).slice(0, 3000);
    if (!t || used >= max) return;
    const chunk = `### ${label}\n${t}`.slice(0, max - used);
    parts.push(chunk);
    used += chunk.length + 2;
  };
  const learned = readLearnings(dir);
  if (learned) push("My learnings file", learned.text);
  for (const n of listNotes(dir)) {
    if (used >= max) break;
    try {
      push(n.name, readText(path.join(dir, n.name), 12_000));
    } catch {
      /* unreadable file: skip */
    }
  }
  return parts.join("\n\n");
}
