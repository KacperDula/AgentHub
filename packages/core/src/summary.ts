import { obj, oneLine, str } from "./util";

/** "mcp__github__create_pr" -> { server: "github", tool: "create_pr" } */
export function mcpParts(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const parts = name.split("__");
  if (parts.length < 3) return null;
  return { server: parts[1], tool: parts.slice(2).join("__") };
}

export function relPath(p: string, cwd: string): string {
  if (cwd && p.startsWith(cwd.endsWith("/") ? cwd : cwd + "/")) return p.slice(cwd.length).replace(/^\/+/, "");
  return p;
}

const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "NotebookRead"]);

/** Readable one-liners: "Bash: npm test", "Edit: src/App.tsx", "github · create_pr: <title>". */
export function summarizeCall(name: string, rawInput: unknown, cwd = ""): string {
  const input = obj(rawInput);
  const mcp = mcpParts(name);
  if (mcp) {
    const detail = str(input.title) || str(input.query) || str(input.description) || str(input.url) || str(input.path);
    return oneLine(`${mcp.server} · ${mcp.tool}${detail ? ": " + detail : ""}`, 300);
  }
  let detail: string;
  if (name === "Bash" || name === "PowerShell") detail = str(input.command) || str(input.description);
  else if (FILE_TOOLS.has(name))
    detail = relPath(str(input.file_path) || str(input.notebook_path) || str(input.path), cwd);
  else if (name === "Grep" || name === "Glob") detail = str(input.pattern);
  else if (name === "WebFetch") detail = str(input.url);
  else if (name === "WebSearch") detail = str(input.query);
  else if (name === "Task" || name === "Agent") detail = str(input.description) || str(input.subagent_type);
  else if (name === "TodoWrite") detail = `${Array.isArray(input.todos) ? input.todos.length : 0} todos`;
  else if (name === "TaskStop") detail = str(input.task_id) || str(input.shell_id);
  else detail = Object.values(input).find((v): v is string => typeof v === "string") ?? "";
  return oneLine(detail ? `${name}: ${detail}` : name, 300);
}

/** The summary without its "Tool: " prefix, as shown inside tool cards. */
export const stripToolPrefix = (summary: string, name: string): string =>
  summary.startsWith(name + ": ") ? summary.slice(name.length + 2) : summary;
