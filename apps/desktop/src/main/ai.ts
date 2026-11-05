import { execFile, spawn } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";

export type ProviderKind = "none" | "claude-cli" | "anthropic" | "openai";

export interface ProviderConfig {
  kind: ProviderKind;
  model?: string;
  baseUrl?: string;
}

/** One interface for every provider: send a prompt, get the reply text. */
export interface Provider {
  complete(prompt: string): Promise<string>;
}

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";
// Models that accept server-side refusal fallbacks (`fallbacks: "default"`).
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

const CLAUDE_BINS = process.platform === "win32" ? ["claude.cmd", "claude.exe", "claude"] : ["claude"];

/** Finds the Claude Code CLI on PATH (and the usual install spots, since GUI apps get a short PATH on macOS). */
export async function detectClaudeCli(): Promise<string | null> {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const candidates = [
    ...CLAUDE_BINS,
    `${home}/.claude/local/claude`,
    `${home}/.local/bin/claude`,
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const bin of candidates) {
    const ok = await new Promise<boolean>((resolve) =>
      execFile(bin, ["--version"], { timeout: 5000, windowsHide: true, shell: process.platform === "win32" }, (err) =>
        resolve(!err),
      ),
    );
    if (ok) return bin;
  }
  return null;
}

/** `claude -p` with the prompt on stdin and --output-format json, using the user's own login and model. */
function claudeCli(bin: string): Provider {
  return {
    complete: (prompt) =>
      new Promise((resolve, reject) => {
        const child = spawn(bin, ["-p", "--output-format", "json"], {
          windowsHide: true,
          shell: process.platform === "win32",
          stdio: ["pipe", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("Claude Code took longer than 5 minutes."));
        }, 5 * 60_000);
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("error", (e) => reject(e));
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0) return reject(new Error(`claude exited with ${code}: ${err.slice(0, 300)}`));
          try {
            const j = JSON.parse(out);
            if (j.is_error) return reject(new Error(String(j.result ?? "Claude Code returned an error.")));
            resolve(typeof j.result === "string" ? j.result : out);
          } catch {
            resolve(out);
          }
        });
        child.stdin.end(prompt);
      }),
  };
}

function anthropicApi(apiKey: string, model: string): Provider {
  const client = new Anthropic({ apiKey });
  return {
    async complete(prompt) {
      const response = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        messages: [{ role: "user", content: prompt }],
        // On a safety decline, let the API re-run the request on a suitable model (Claude API only).
        ...(FALLBACK_MODELS.has(model)
          ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
          : {}),
      });
      if (response.stop_reason === "refusal") throw new Error("The model declined this request.");
      return response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
    },
  };
}

/** OpenAI-compatible chat completions: OpenRouter, Ollama, LM Studio, … */
function openAiCompatible(baseUrl: string, apiKey: string | null, model: string): Provider {
  return {
    async complete(prompt) {
      const res = await fetch(baseUrl.replace(/\/+$/, "") + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(5 * 60_000),
      });
      if (!res.ok) throw new Error(`The endpoint answered ${res.status} ${res.statusText}.`);
      const j = (await res.json()) as any;
      return String(j.choices?.[0]?.message?.content ?? "");
    },
  };
}

export async function createProvider(cfg: ProviderConfig, apiKey: string | null): Promise<Provider | null> {
  switch (cfg.kind) {
    case "claude-cli": {
      const bin = await detectClaudeCli();
      if (!bin) throw new Error("Claude Code was not found on this machine.");
      return claudeCli(bin);
    }
    case "anthropic":
      if (!apiKey) throw new Error("Add your Anthropic API key first.");
      return anthropicApi(apiKey, cfg.model || DEFAULT_ANTHROPIC_MODEL);
    case "openai":
      if (!cfg.baseUrl || !cfg.model) throw new Error("Set the endpoint URL and model first.");
      return openAiCompatible(cfg.baseUrl, apiKey, cfg.model);
    default:
      return null;
  }
}

/** Error text safe to show or log: never echoes a key. */
export function safeError(e: unknown, secrets: (string | null)[]): string {
  let msg = e instanceof Error ? e.message : String(e);
  for (const s of secrets) if (s) msg = msg.split(s).join("[redacted]");
  return msg.slice(0, 500);
}
