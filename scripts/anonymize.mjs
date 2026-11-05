#!/usr/bin/env node
// Anonymizes Claude Code transcripts into fixtures/anon/ for tests.
//
//   npm run anonymize                      # every session in fixtures/raw/
//   npm run anonymize -- <main.jsonl> ...  # specific main transcripts (their subagents/ come along)
//
// Keeps structure and ids (uuids, sessionId, agentId, tool ids, tool names, statuses, timestamps, token
// counts) and replaces paths, prompts, file contents, commands and outputs with deterministic placeholders,
// so a subagent's first prompt still matches its spawn after anonymization.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const RAW = path.join(ROOT, "fixtures", "raw");
const OUT = path.join(ROOT, "fixtures", "anon");

const KEEP = new Set([
  "type",
  "uuid",
  "parentUuid",
  "sessionId",
  "timestamp",
  "agentId",
  "operation",
  "subtype",
  "id",
  "model",
  "role",
  "name",
  "tool_use_id",
  "status",
  "backgroundTaskId",
  "task_id",
  "shell_id",
  "subagent_type",
  "stop_reason",
  "version",
  "userType",
  "entrypoint",
  "level",
  "permissionMode",
  "promptId",
  "resolvedModel",
]);
const h = (s) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 8);

function anonText(s) {
  if (s.includes("<task-notification>")) {
    return s
      .split("<task-notification>")
      .map((part, i) => {
        if (i === 0) return part ? `text-${h(part)}` : "";
        const f = (tag) => new RegExp(`<${tag}>([^<]*)`).exec(part)?.[1];
        const keep = ["task-id", "tool-use-id", "status"].map((t) => (f(t) ? `<${t}>${f(t)}</${t}>` : "")).join("");
        const d = f("duration_ms");
        return `<task-notification>${keep}<summary>summary-${h(part)}</summary>${d ? `<usage><duration_ms>${d}</duration_ms></usage>` : ""}</task-notification>`;
      })
      .join("");
  }
  if (s.startsWith("<")) return `<redacted-${h(s)}>`;
  if (s.startsWith("Caveat:")) return "Caveat: redacted";
  return `text-${h(s)}`;
}

function anon(v, key, project) {
  if (Array.isArray(v)) return v.map((x) => anon(x, key, project));
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = anon(x, k, project);
    return o;
  }
  if (typeof v !== "string") return v;
  if (KEEP.has(key)) return v;
  switch (key) {
    case "cwd":
      return `/home/dev/${project}`;
    case "gitBranch":
      return "main";
    case "signature":
      return "";
    case "file_path":
    case "notebook_path":
    case "path":
      return `/home/dev/${project}/file-${h(v)}${path.extname(v)}`;
    case "command":
      return `cmd-${h(v)}`;
    case "url":
      return `https://example.com/${h(v)}`;
    case "pattern":
    case "query":
      return `pattern-${h(v)}`;
    case "description":
      return `desc-${h(v)}`;
    case "text":
    case "content":
    case "thinking":
    case "prompt":
    case "activeForm":
      return anonText(v);
    default:
      return `redacted-${h(v)}`;
  }
}

const wanted = (o) =>
  o &&
  (["user", "assistant", "system"].includes(o.type) ||
    (o.type === "queue-operation" && o.operation === "enqueue" && String(o.content).includes("<task-notification>")));

function anonFile(src, dest, project) {
  const lines = fs.readFileSync(src, "utf8").split("\n");
  const out = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    if (wanted(o)) out.push(JSON.stringify(anon(o, "", project)));
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, out.join("\n") + "\n");
  return out.length;
}

function mains(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && e.name !== "subagents") out.push(...mains(p));
    else if (e.name.endsWith(".jsonl") && !p.includes(`${path.sep}subagents${path.sep}`)) out.push(p);
  }
  return out;
}

const files = process.argv.slice(2).length ? process.argv.slice(2) : mains(RAW);
if (!files.length) {
  console.error("No transcripts found. Put some in fixtures/raw/ or pass paths to main <sessionId>.jsonl files.");
  process.exit(1);
}
const projects = new Map();
for (const f of files) {
  const projDir = path.dirname(f);
  if (!projects.has(projDir)) projects.set(projDir, `project-${projects.size + 1}`);
  const project = projects.get(projDir);
  const sid = path.basename(f, ".jsonl");
  let n = anonFile(f, path.join(OUT, project, `${sid}.jsonl`), project);
  const subDir = path.join(projDir, sid, "subagents");
  let subs = 0;
  if (fs.existsSync(subDir)) {
    for (const s of fs.readdirSync(subDir).filter((x) => x.endsWith(".jsonl"))) {
      n += anonFile(path.join(subDir, s), path.join(OUT, project, sid, "subagents", s), project);
      subs++;
    }
  }
  console.log(`${project}/${sid}: ${n} lines, ${subs} subagents`);
}
