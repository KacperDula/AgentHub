import { useEffect, useState } from "react";
import { Copy, Eye, EyeOff, FolderOpen, ShieldCheck } from "lucide-react";
import { bridge, isApp } from "../api";
import { copy } from "../format";

interface AppSettings {
  extraFolder: string;
  backfillHours: number;
  retentionDays: number;
  paused: boolean;
  startAtLogin: boolean;
  projectsDir: string;
  version: string;
}
interface RemoteState {
  enabled: boolean;
  host: string;
  port: number;
  token: string | null;
  urls: { label: string; url: string }[];
  tailscale: { dnsName: string | null; hostName: string | null; ips: string[] } | null;
  interfaces: { name: string; address: string }[];
  qr: { url: string; image: string } | null;
  keychain: boolean;
}
interface AiState {
  config: { kind: "none" | "claude-cli" | "anthropic" | "openai"; model?: string; baseUrl?: string };
  hasKey: boolean;
  claudeCli: string | null;
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button className="toggle" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} />;
}

/** Two-step inline confirm (no browser dialogs). */
function Confirm({
  label,
  confirm,
  onConfirm,
  className = "btn danger",
}: {
  label: string;
  confirm: string;
  onConfirm: () => void;
  className?: string;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking)
    return (
      <button className={className} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  return (
    <span className="row">
      <span style={{ fontSize: 13 }}>{confirm}</span>
      <button
        className="btn danger sm"
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        Yes
      </button>
      <button className="btn sm" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </span>
  );
}

export function Settings() {
  if (!isApp)
    return (
      <div className="page-pad">
        <h2>Settings</h2>
        <p className="callout" style={{ maxWidth: 640 }}>
          This is a read-only view. Settings can only be changed in the AgentTrace app on the machine itself, and
          nothing in this browser can change data or run commands there.
        </p>
      </div>
    );
  return (
    <div className="page-pad">
      <h2>Settings</h2>
      <p className="lede">
        Everything stays on this computer unless you turn on remote viewing or an AI provider below.
      </p>
      <General />
      <Remote />
      <AiProvider />
    </div>
  );
}

function General() {
  const [s, setS] = useState<AppSettings | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => void bridge!.invoke<AppSettings>("settings:get").then(setS), []);
  const save = async (patch: Partial<AppSettings>) =>
    setS({ ...s!, ...(await bridge!.invoke<AppSettings>("settings:set", patch)) });
  if (!s) return null;
  return (
    <>
      <section className="panel">
        <h3>Watching</h3>
        <p className="sub">AgentTrace reads Claude Code's own log files. It never changes them.</p>
        <div className="field">
          <label>Claude Code logs</label>
          <span className="mono" style={{ fontSize: 12.5 }}>
            {s.projectsDir}
          </span>
        </div>
        <div className="field">
          <label>
            Extra folder<span className="hint">e.g. logs synced from another machine</span>
          </label>
          <span className="row">
            <span className="mono muted" style={{ fontSize: 12.5 }}>
              {s.extraFolder || "none"}
            </span>
            <button
              className="btn sm"
              onClick={async () => {
                const p = await bridge!.invoke<string | null>("folder:pick");
                if (p) save({ extraFolder: p });
              }}
            >
              <FolderOpen size={13} /> Choose…
            </button>
            {s.extraFolder && (
              <button className="btn sm ghost" onClick={() => save({ extraFolder: "" })}>
                Remove
              </button>
            )}
          </span>
        </div>
        <div className="field">
          <label>
            Backfill on first run<span className="hint">hours of history to import for files never seen before</span>
          </label>
          <input
            className="input"
            type="number"
            min={0}
            max={720}
            style={{ width: 110 }}
            defaultValue={s.backfillHours}
            onBlur={(e) => save({ backfillHours: Number(e.target.value) })}
          />
        </div>
        <div className="field">
          <label>Pause watching</label>
          <Toggle on={s.paused} onChange={(paused) => save({ paused })} label="Pause watching" />
        </div>
        <div className="field">
          <label>Start at login</label>
          <Toggle on={s.startAtLogin} onChange={(startAtLogin) => save({ startAtLogin })} label="Start at login" />
        </div>
      </section>
      <section className="panel">
        <h3>Data</h3>
        <p className="sub">Stored in a local SQLite database in your user data folder.</p>
        <div className="field">
          <label>
            Keep data for<span className="hint">older sessions are deleted automatically</span>
          </label>
          <span className="row">
            <input
              className="input"
              type="number"
              min={1}
              max={3650}
              style={{ width: 110 }}
              defaultValue={s.retentionDays}
              onBlur={(e) => save({ retentionDays: Number(e.target.value) })}
            />
            <span className="muted">days</span>
          </span>
        </div>
        <div className="field">
          <label>Demo data</label>
          <span>
            <button
              className="btn violet sm"
              onClick={() => bridge!.invoke("demo:clear").then(() => setDone("Demo data cleared."))}
            >
              Clear demo data
            </button>
          </span>
        </div>
        <div className="field">
          <label>
            Delete all data<span className="hint">sessions, events, insights and suggestions</span>
          </label>
          <span>
            <Confirm
              label="Delete all data"
              confirm="Delete everything AgentTrace has stored?"
              onConfirm={() => bridge!.invoke("data:deleteAll").then(() => setDone("All data deleted."))}
            />
          </span>
        </div>
        {done && (
          <p className="callout" role="status" style={{ marginBottom: 0 }}>
            {done}
          </p>
        )}
        <div className="field">
          <label>Version</label>
          <span className="muted">AgentTrace {s.version}</span>
        </div>
      </section>
    </>
  );
}

function Remote() {
  const [r, setR] = useState<RemoteState | null>(null);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => void bridge!.invoke<RemoteState>("remote:get").then(setR), []);
  const set = async (patch: Partial<RemoteState>) => {
    setBusy(true);
    try {
      setR(await bridge!.invoke<RemoteState>("remote:set", patch));
    } finally {
      setBusy(false);
    }
  };
  if (!r) return null;
  return (
    <section className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h3>Remote viewing</h3>
          <p className="sub" style={{ margin: 0 }}>
            Watch this machine's agents from a phone or another computer, read-only, locked with an access token.
          </p>
        </div>
        <Toggle on={r.enabled} onChange={(enabled) => set({ enabled })} label="Remote viewing" />
      </div>
      {!r.enabled ? (
        <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
          Off: the server listens on 127.0.0.1 only, so nothing else on the network can reach it.
        </p>
      ) : (
        <>
          {!r.keychain && (
            <p className="callout sev-high">
              The OS keychain is not available, so the access token can't be stored safely.
            </p>
          )}
          <div className="field" style={{ borderTop: "1px solid #18212b", marginTop: 12 }}>
            <label>Listen on</label>
            <select
              className="input"
              style={{ maxWidth: 320 }}
              disabled={busy}
              value={r.host}
              onChange={(e) => set({ host: e.target.value })}
            >
              <option value="0.0.0.0">All interfaces</option>
              {r.interfaces.map((i) => (
                <option key={i.address} value={i.address}>
                  {i.address} ({i.name})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>
              Access token<span className="hint">anyone with it can view, never change, your sessions</span>
            </label>
            <span className="row" style={{ flexWrap: "nowrap" }}>
              <input
                className="input mono"
                readOnly
                value={show ? (r.token ?? "") : "•".repeat(32)}
                aria-label="Access token"
              />
              <button
                className="btn sm ghost"
                onClick={() => setShow(!show)}
                aria-label={show ? "Hide token" : "Show token"}
              >
                {show ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
              <button className="btn sm" onClick={() => r.token && copy(r.token)}>
                <Copy size={13} /> Copy
              </button>
            </span>
          </div>
          <div className="field">
            <label>Open from</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {r.urls.map((u) => (
                <span key={u.url} className="row" style={{ gap: 8 }}>
                  <span className="mono" style={{ fontSize: 12.5 }}>
                    {u.url}
                  </span>
                  <span className="dim" style={{ fontSize: 12 }}>
                    {u.label}
                  </span>
                </span>
              ))}
            </div>
          </div>
          {r.qr && (
            <div className="field">
              <label>
                Scan with your phone<span className="hint">{r.qr.url} with the token in the link</span>
              </label>
              <img
                src={r.qr.image}
                width={180}
                height={180}
                alt="QR code with the address and access token"
                style={{ borderRadius: 10 }}
              />
            </div>
          )}
          <div className="field">
            <label>
              Revoke all browsers<span className="hint">makes a new token; every signed-in browser is logged out</span>
            </label>
            <span>
              <Confirm
                label="Revoke all browsers"
                confirm="Log out every browser?"
                onConfirm={async () => setR(await bridge!.invoke<RemoteState>("remote:revoke"))}
              />
            </span>
          </div>
        </>
      )}
      <div className="callout" style={{ marginTop: 14 }}>
        <div className="row" style={{ gap: 6, fontWeight: 600, marginBottom: 4 }}>
          <ShieldCheck size={15} /> From anywhere with Tailscale{" "}
          {r.tailscale ? (
            <span className="badge" style={{ color: "var(--green)" }}>
              detected
            </span>
          ) : null}
        </div>
        <ol style={{ margin: "4px 0 0", paddingLeft: 20 }}>
          <li>Install Tailscale on this computer and on your phone or other computer.</li>
          <li>Log in with the same account on both.</li>
          <li>
            Turn on remote viewing above, then open{" "}
            <span className="mono">
              http://{r.tailscale?.dnsName?.split(".")[0] ?? "<machine-name>"}:{r.port}
            </span>{" "}
            and sign in with the token (or scan the QR).
          </li>
        </ol>
        <p style={{ margin: "6px 0 0" }}>
          For HTTPS, run <span className="mono">tailscale serve {r.port}</span> on this computer and use the https
          address it prints.
        </p>
      </div>
    </section>
  );
}

function AiProvider() {
  const [a, setA] = useState<AiState | null>(null);
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => void bridge!.invoke<AiState>("ai:get").then(setA), []);
  if (!a) return null;
  const cfg = a.config;
  const patch = (p: Partial<AiState["config"]>) => setA({ ...a, config: { ...cfg, ...p } });
  const save = async (clearKey = false) => {
    const r = await bridge!.invoke<{ hasKey: boolean }>("ai:set", cfg, clearKey ? null : key ? key : undefined);
    setA({ ...a, hasKey: r.hasKey });
    setKey("");
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };
  const options: { kind: AiState["config"]["kind"]; title: string; hint: string }[] = [
    { kind: "none", title: "None", hint: "Rules only. No network calls." },
    {
      kind: "claude-cli",
      title: "Claude Code on this machine",
      hint: a.claudeCli
        ? `Uses your own login and model (${a.claudeCli}).`
        : "Claude Code was not found on this machine.",
    },
    { kind: "anthropic", title: "Anthropic API", hint: "Your API key and model." },
    { kind: "openai", title: "OpenAI-compatible endpoint", hint: "OpenRouter, Ollama, LM Studio…" },
  ];
  return (
    <section className="panel">
      <h3>AI provider</h3>
      <p className="sub">
        Used only when you ask: the AI coach on Insights, Explain with AI, and Learn from my notes. Keys are kept in the
        OS keychain, never in the database or logs.
      </p>
      <div role="radiogroup" aria-label="AI provider" style={{ display: "grid", gap: 6 }}>
        {options.map((o) => (
          <label
            key={o.kind}
            className="row"
            style={{
              gap: 10,
              padding: "6px 0",
              alignItems: "flex-start",
              opacity: o.kind === "claude-cli" && !a.claudeCli ? 0.55 : 1,
            }}
          >
            <input
              type="radio"
              name="provider"
              checked={cfg.kind === o.kind}
              disabled={o.kind === "claude-cli" && !a.claudeCli}
              onChange={() => patch({ kind: o.kind })}
              style={{ marginTop: 3, accentColor: "var(--teal)" }}
            />
            <span>
              <div>{o.title}</div>
              <div className="dim" style={{ fontSize: 12 }}>
                {o.hint}
              </div>
            </span>
          </label>
        ))}
      </div>
      {cfg.kind === "openai" && (
        <div className="field">
          <label>Base URL</label>
          <input
            className="input mono"
            placeholder="http://localhost:11434/v1"
            value={cfg.baseUrl ?? ""}
            onChange={(e) => patch({ baseUrl: e.target.value })}
          />
        </div>
      )}
      {(cfg.kind === "anthropic" || cfg.kind === "openai") && (
        <>
          <div className="field">
            <label>Model</label>
            <input
              className="input mono"
              placeholder={cfg.kind === "anthropic" ? "claude-opus-5-5" : "llama3.1"}
              value={cfg.model ?? ""}
              onChange={(e) => patch({ model: e.target.value })}
            />
          </div>
          <div className="field">
            <label>
              API key
              <span className="hint">
                {a.hasKey ? "a key is saved" : cfg.kind === "openai" ? "optional for local servers" : "required"}
              </span>
            </label>
            <span className="row" style={{ flexWrap: "nowrap" }}>
              <input
                className="input mono"
                type="password"
                autoComplete="off"
                placeholder={a.hasKey ? "•••••••• (saved)" : "paste key"}
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
              {a.hasKey && (
                <button className="btn sm ghost" onClick={() => save(true)}>
                  Forget key
                </button>
              )}
            </span>
          </div>
        </>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn primary" onClick={() => save()}>
          Save
        </button>
        {saved && (
          <span className="muted" role="status">
            Saved.
          </span>
        )}
      </div>
    </section>
  );
}
