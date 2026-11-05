import { useEffect, useState } from "react";
import { bridge } from "./api";

/** What an AI request is about. The desktop app builds the payload; the preview shows it exactly. */
export type AiKind = "session" | "overall" | "prompts" | "files" | "explain" | "learn";

export interface AiState {
  config: { kind: string; model?: string };
  previewAck: boolean;
}

export const PROVIDER_NAME: Record<string, string> = {
  none: "None (rules only)",
  "claude-cli": "Claude Code on this machine",
  anthropic: "Anthropic API",
  openai: "OpenAI-compatible endpoint",
};

type Result = { ok: boolean; error?: string } & Record<string, any>;

/** One AI request: what it is about, the IPC call that runs it, and the status line for a success. */
export interface AiAction {
  kind: AiKind;
  sid?: string;
  go: () => Promise<Result>;
  done: (r: Result) => string;
}
interface Pending {
  action: AiAction;
  text: string;
}

/**
 * Shared AI flow for Insights, Explain and Notes: checks the provider, shows "What will be sent" before the first
 * send, runs the request and reports the outcome. Render `modal` once in the page.
 */
export function useAi() {
  const [ai, setAi] = useState<AiState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState<Pending | null>(null);

  useEffect(() => {
    bridge?.invoke<AiState>("ai:get").then(setAi);
  }, []);

  const payloadText = async (kind: AiKind, sid?: string) => {
    const r = await bridge!.invoke<{ payload: unknown }>("ai:payload", kind, sid);
    return JSON.stringify(r.payload, null, 2);
  };

  /** Runs the action, after the one-time "What will be sent" preview. */
  async function request(action: AiAction, confirmed = false) {
    if (!bridge || !ai) return;
    if (ai.config.kind === "none")
      return setMsg("Pick an AI provider in Settings to use this. The local rules always run, for free.");
    try {
      if (!ai.previewAck && !confirmed) return setPreview({ action, text: await payloadText(action.kind, action.sid) });
      setPreview(null);
      setBusy(action.kind);
      setMsg(null);
      const r = await action.go();
      if (r.ok) {
        setAi((a) => (a ? { ...a, previewAck: true } : a));
        setMsg(action.done(r));
      } else setMsg(r.error ?? "The request failed.");
    } catch (e) {
      setMsg((e as Error).message ?? "The request failed.");
    } finally {
      setBusy(null);
    }
  }

  /** Shows the exact payload; "Send and analyze" then runs the action. */
  async function show(action: AiAction) {
    if (!bridge) return;
    try {
      setPreview({ action, text: await payloadText(action.kind, action.sid) });
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  const modal = preview && (
    <div
      className="modal-back"
      role="dialog"
      aria-modal="true"
      aria-label="What will be sent"
      onClick={() => setPreview(null)}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <b>What will be sent</b>
          <span className="muted" style={{ fontSize: 12 }}>
            to {ai ? PROVIDER_NAME[ai.config.kind] : "your provider"} · no file contents, no tool outputs
          </span>
        </header>
        <div className="body">
          <pre className="code">{preview.text}</pre>
        </div>
        <footer>
          <button className="btn ghost" onClick={() => setPreview(null)}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!ai || ai.config.kind === "none"}
            onClick={() => void request(preview.action, true)}
          >
            Send and analyze
          </button>
        </footer>
      </div>
    </div>
  );

  return { ai, busy, msg, setMsg, request, show, modal };
}
