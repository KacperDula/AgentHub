import { useCallback, useEffect, useState } from "react";
import {
  BookmarkPlus,
  Copy,
  FilePlus,
  FileText,
  GraduationCap,
  Lightbulb,
  MessageSquareText,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Users,
  X,
} from "lucide-react";
import type { PromptReview, Signal } from "@agenttrace/core";
import { api, bridge, isApp, navigate, useLoad, type SuggestionRow } from "../api";
import { useAi, PROVIDER_NAME, type AiAction } from "../ai";
import { copy, dateTime, fmtDuration, folderName, tokens } from "../format";

type Tab = "prompts" | "files" | "subagents" | "signals" | "profile";

const ISSUE_NAMES: Record<string, string> = {
  misread: "misunderstood",
  vague: "unclear target",
  "short-start": "short first prompt",
  "many-asks": "many tasks at once",
  "no-done": "no 'done when'",
  wall: "wall of text",
};

export function Insights() {
  const { data } = useLoad(api.insights, ["insights", "reset"]);
  const { data: sessions } = useLoad(api.sessions, ["reset"]);
  const [scopeSid, setScopeSid] = useState("");
  const [tab, setTab] = useState<Tab>("prompts");
  const [onlyIssues, setOnlyIssues] = useState(true);
  const { ai, busy, msg, request, show, modal } = useAi();

  const names = new Map((sessions ?? []).map((s) => [s.id, folderName(s.project_path)]));
  const signals = data?.signals ?? [];
  const advice = signals.filter((s) => s.kind.startsWith("subagent-"));
  const usage = signals.filter((s) => !s.kind.startsWith("subagent-"));
  const prompts = data?.prompts ?? [];
  const shown = onlyIssues ? prompts.filter((p) => p.issues.length) : prompts;
  const stats = data?.promptStats;
  const profile = data?.profile;
  const topIssue = stats && Object.entries(stats.issues).sort((a, b) => b[1] - a[1])[0];

  const suggest = (scope: "overall" | "session" | "prompts" | "files", sid?: string): AiAction => ({
    kind: scope,
    sid,
    go: () => bridge!.invoke("ai:analyze", scope, sid),
    done: (r) => `${r.count} new suggestion${r.count === 1 ? "" : "s"}.`,
  });

  return (
    <div className="page-pad">
      <h2>Insights</h2>
      <p className="lede">
        What to change in how you prompt and use Claude Code: which of your prompts the agent found unclear and why, how
        to write them better, and which subagents to run. Local rules check every session for free. The AI coach uses
        the model you picked in Settings, only when you ask, with the preview shown first; it also reads your Notes and
        your 👍/👎 ratings, so it learns what helps you.
      </p>

      {stats && stats.prompts > 0 && (
        <div className="stats-row">
          <Stat label="Prompts reviewed" value={stats.prompts} />
          <Stat
            label="Clear (no issues)"
            value={`${Math.round(((stats.prompts - stats.withIssues) / stats.prompts) * 100)}%`}
          />
          <Stat
            label="Misunderstood"
            value={stats.corrected + stats.interrupted}
            warn={stats.corrected + stats.interrupted > 0}
          />
          <Stat label="Avg. words per prompt" value={stats.avgWords} />
          <Stat label="Most common issue" value={topIssue ? (ISSUE_NAMES[topIssue[0]] ?? topIssue[0]) : "none"} small />
        </div>
      )}

      {isApp && (
        <section className="panel">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <h3>
                <GraduationCap size={16} style={{ verticalAlign: -3 }} color="var(--violet)" /> AI coach
              </h3>
              <p className="sub" style={{ margin: 0 }}>
                Provider: {ai ? PROVIDER_NAME[ai.config.kind] : "…"}
                {ai?.config.model ? ` · ${ai.config.model}` : ""} ·{" "}
                <a href="#/settings" onClick={() => navigate("settings")}>
                  change
                </a>{" "}
                · uses your{" "}
                <a href="#/notes" onClick={() => navigate("notes")}>
                  notes
                </a>
              </p>
            </div>
            <div className="row">
              <button className="btn primary" disabled={!!busy} onClick={() => request(suggest("prompts"))}>
                {busy === "prompts" ? <span className="spin" /> : <MessageSquareText size={14} />} Coach my prompts
              </button>
              <button className="btn" disabled={!!busy} onClick={() => request(suggest("overall"))}>
                {busy === "overall" ? <span className="spin" /> : <Lightbulb size={14} />} Analyze my overall usage
              </button>
              <button
                className="btn ghost sm"
                onClick={() => show(scopeSid ? suggest("session", scopeSid) : suggest("prompts"))}
              >
                What will be sent?
              </button>
            </div>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <select
              className="input"
              style={{ width: 280 }}
              value={scopeSid}
              onChange={(e) => setScopeSid(e.target.value)}
              aria-label="Session to analyze"
            >
              <option value="">Or pick one session…</option>
              {(sessions ?? []).slice(0, 50).map((s) => (
                <option key={s.id} value={s.id}>
                  {folderName(s.project_path)} · {dateTime(s.last_event_at)}
                </option>
              ))}
            </select>
            <button
              className="btn"
              disabled={!scopeSid || !!busy}
              onClick={() => request(suggest("session", scopeSid))}
            >
              {busy === "session" ? <span className="spin" /> : null} Analyze this session
            </button>
          </div>
          {msg && (
            <p className="callout" style={{ marginTop: 12, marginBottom: 0 }} role="status">
              {msg}
            </p>
          )}
        </section>
      )}

      {!!data?.suggestions.length && (
        <section style={{ marginBottom: 22 }}>
          <div className="kicker" style={{ margin: "6px 0 10px" }}>
            <Sparkles size={12} style={{ verticalAlign: -2 }} /> From the AI coach
          </div>
          <div className="grid2">
            {data.suggestions.map((s) => (
              <SuggestionCard key={s.id} s={s} sessionName={s.session_id ? names.get(s.session_id) : undefined} />
            ))}
          </div>
        </section>
      )}

      <div className="seg" role="tablist" aria-label="Insights sections">
        {(
          [
            ["prompts", `Prompts to improve (${prompts.filter((p) => p.issues.length).length})`],
            ["files", "Coach files"],
            ["subagents", `Subagents to run (${advice.length})`],
            ["signals", `Usage signals (${usage.length})`],
            ["profile", "Usage profile"],
          ] as [Tab, string][]
        )
          .filter(([id]) => id !== "files" || isApp)
          .map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
      </div>

      {tab === "prompts" && (
        <>
          <div className="row" style={{ justifyContent: "space-between", margin: "4px 0 12px" }}>
            <span className="muted" style={{ fontSize: 13 }}>
              Your most recent prompts, newest first, with what the agent did after each one.
            </span>
            <label className="row" style={{ gap: 7, fontSize: 12.5 }}>
              Only prompts with issues
              <button
                className="toggle"
                role="switch"
                aria-checked={onlyIssues}
                aria-label="Only prompts with issues"
                onClick={() => setOnlyIssues(!onlyIssues)}
              />
            </label>
          </div>
          {!prompts.length && (
            <p className="muted">
              No prompts reviewed yet. They appear a couple of minutes after a session goes quiet (and every 15
              minutes).
            </p>
          )}
          {!!prompts.length && !shown.length && (
            <p className="callout">No issues found in your recent prompts. Nice and clear.</p>
          )}
          {shown.slice(0, 60).map((p) => (
            <PromptCard key={p.id} p={p} name={names.get(p.session_id)} />
          ))}
        </>
      )}

      {tab === "files" && isApp && (
        <CoachFiles busy={busy} onCoach={() => request(suggest("files"))} onPreview={() => show(suggest("files"))} />
      )}

      {tab === "subagents" && (
        <>
          <p className="muted" style={{ fontSize: 13, margin: "4px 0 12px" }}>
            Based on how your sessions actually ran: where a subagent would have kept the main agent fast and focused.
          </p>
          {!advice.length && (
            <p className="muted">No subagent advice yet: your sessions use subagents well, or are short.</p>
          )}
          <div className="grid2" style={{ marginBottom: 22 }}>
            {advice.slice(0, 40).map((g) => (
              <SignalCard key={g.id} g={g} name={names.get(g.session_id)} />
            ))}
          </div>
        </>
      )}

      {tab === "signals" && (
        <>
          {!usage.length && (
            <p className="muted">
              No signals yet. They appear after sessions are analyzed (every 15 minutes and when a session ends).
            </p>
          )}
          <div className="grid2" style={{ marginBottom: 22 }}>
            {usage.slice(0, 60).map((g) => (
              <SignalCard key={g.id} g={g} name={names.get(g.session_id)} />
            ))}
          </div>
        </>
      )}

      {tab === "profile" && profile && profile.sessions > 0 && (
        <>
          <div className="kicker" style={{ margin: "6px 0 10px" }}>
            {profile.sessions} sessions · {tokens(profile.tokensIn + profile.tokensOut)} tokens
          </div>
          <div className="grid2">
            <Bars title="Most used tools" data={profile.tools} />
            <Bars title="MCP servers" data={profile.mcpServers} empty="No MCP tools used." />
            <Bars title="Recurring failing commands" data={profile.failingCommands} mono empty="No failing commands." />
            <Bars title="Files read most" data={profile.files} mono short />
            <Bars title="Folders read most" data={profile.folders} mono short />
            <section className="panel">
              <h3>Subagents</h3>
              <p className="sub">Runs and success rate per type</p>
              {Object.entries(profile.subagents)
                .sort((a, b) => b[1].n - a[1].n)
                .slice(0, 10)
                .map(([k, v]) => (
                  <div key={k} className="hbar">
                    <span className="name">{k}</span>
                    <span className="dim" style={{ textAlign: "right" }}>
                      {Math.round(((v.n - v.failed) / v.n) * 100)}%
                    </span>
                    <div className="bar">
                      <i style={{ width: `${((v.n - v.failed) / v.n) * 100}%` }} />
                    </div>
                  </div>
                ))}
              {!Object.keys(profile.subagents).length && <p className="dim">No subagents yet.</p>}
            </section>
            <section className="panel">
              <h3>Average per task type</h3>
              <p className="sub">Tokens and duration</p>
              <table className="list">
                <tbody>
                  {Object.entries(profile.taskTypes)
                    .sort((a, b) => b[1].n - a[1].n)
                    .slice(0, 10)
                    .map(([k, v]) => (
                      <tr key={k} style={{ cursor: "default" }}>
                        <td>{k}</td>
                        <td className="muted">{tokens(Math.round(v.tokens / v.n))}</td>
                        <td className="muted">{fmtDuration(v.durationMs / v.n)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </section>
            <section className="panel">
              <h3>Hours of use</h3>
              <p className="sub">Events by hour of day</p>
              <div className="hours" aria-label="Events by hour of day">
                {profile.hours.map((h, i) => (
                  <i
                    key={i}
                    title={`${i}:00 · ${h} events`}
                    style={{ height: `${(h / Math.max(1, ...profile.hours)) * 100}%` }}
                  />
                ))}
              </div>
              <div className="row dim" style={{ justifyContent: "space-between", fontSize: 11, marginTop: 4 }}>
                <span>0h</span>
                <span>12h</span>
                <span>23h</span>
              </div>
            </section>
          </div>
        </>
      )}
      {tab === "profile" && !(profile && profile.sessions > 0) && <p className="muted">No usage profile yet.</p>}

      {modal}
    </div>
  );
}

function Stat({
  label,
  value,
  warn,
  small,
}: {
  label: string;
  value: string | number;
  warn?: boolean;
  small?: boolean;
}) {
  return (
    <div className="stat">
      <div className="v" style={{ ...(warn ? { color: "var(--amber)" } : {}), ...(small ? { fontSize: 15 } : {}) }}>
        {value}
      </div>
      <div className="l">{label}</div>
    </div>
  );
}

function PromptCard({ p, name }: { p: PromptReview; name?: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const long = p.text.length > 420;
  const o = p.outcome;
  return (
    <section className="panel prompt-card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="row" style={{ gap: 6 }}>
          {p.severity ? (
            <span className={`badge sev-${p.severity}`}>
              {p.issues.length} ISSUE{p.issues.length > 1 ? "S" : ""}
            </span>
          ) : (
            <span className="badge" style={{ color: "var(--green)" }}>
              CLEAR
            </span>
          )}
          <span className="dim" style={{ fontSize: 11.5 }}>
            {dateTime(p.created_at)} · {p.words} words
          </span>
        </span>
        <span className="row" style={{ gap: 10, fontSize: 12 }}>
          <a href={`#/explain?session=${encodeURIComponent(p.session_id)}`}>{name ?? "session"} · explain →</a>
        </span>
      </div>
      <blockquote className={`prompt-text ${open || !long ? "" : "clamp"}`}>{p.text}</blockquote>
      {long && (
        <button className="btn ghost sm" style={{ padding: "0 4px", marginTop: -6 }} onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show all"}
        </button>
      )}
      <div className="row outcome" style={{ gap: 6 }}>
        <span className="pill">{o.steps} steps</span>
        {o.subagents > 0 && <span className="pill">{o.subagents} subagents</span>}
        {o.errors > 0 && (
          <span className="pill" style={{ color: "var(--red)" }}>
            {o.errors} errors
          </span>
        )}
        {o.durationMs > 0 && <span className="pill">{fmtDuration(o.durationMs)}</span>}
        {o.corrected && (
          <span className="pill" style={{ color: "var(--amber)" }}>
            you corrected it
          </span>
        )}
        {o.interrupted && (
          <span className="pill" style={{ color: "var(--amber)" }}>
            you stopped it
          </span>
        )}
      </div>
      {p.issues.map((i) => (
        <div key={i.kind} className="issue">
          <div className="row" style={{ gap: 8 }}>
            <span className={`badge sev-${i.severity}`}>{i.severity.toUpperCase()}</span>
            <b>{i.title}</b>
          </div>
          <p>
            <span className="dim">Why it's unclear: </span>
            {i.why}
          </p>
          <p>
            <span className="dim">Do this instead: </span>
            {i.how}
          </p>
        </div>
      ))}
      {p.better && (
        <>
          <div className="kicker" style={{ margin: "10px 0 4px" }}>
            A clearer structure for this prompt
          </div>
          <pre className="code">{p.better}</pre>
          <button
            className="btn sm"
            style={{ marginTop: 8 }}
            onClick={async () => {
              setCopied(await copy(p.better!));
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            <Copy size={13} /> {copied ? "Copied" : "Copy"}
          </button>
        </>
      )}
    </section>
  );
}

function SignalCard({ g, name }: { g: Signal; name?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="panel" style={{ marginBottom: 0 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className={`badge sev-${g.severity}`}>
          {g.kind.startsWith("subagent-") && <Users size={11} />} {g.severity.toUpperCase()}
        </span>
        <a href={`#/map?session=${encodeURIComponent(g.session_id)}`} style={{ fontSize: 12 }}>
          {name ?? "session"} →
        </a>
      </div>
      <h3 style={{ marginTop: 8 }}>{g.title}</h3>
      <p
        className={g.fix ? "muted" : "muted mono"}
        style={{ fontSize: g.fix ? 13 : 12, margin: "4px 0 8px", wordBreak: "break-word" }}
      >
        {g.detail}
      </p>
      {g.fix && (
        <>
          <div className="kicker" style={{ marginBottom: 4 }}>
            Try saying
          </div>
          <pre className="code">{g.fix}</pre>
          <button
            className="btn sm"
            style={{ margin: "8px 0" }}
            onClick={async () => {
              setCopied(await copy(g.fix!));
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            <Copy size={13} /> {copied ? "Copied" : "Copy"}
          </button>
        </>
      )}
      <div className="row" style={{ gap: 6 }}>
        {Object.entries(g.numbers).map(([k, v]) => (
          <span key={k} className="pill" style={{ fontSize: 11 }}>
            {k.replace(/_/g, " ")}: <b style={{ color: "var(--text)" }}>{v}</b>
          </span>
        ))}
      </div>
    </section>
  );
}

const SCOPE_NAME: Record<string, string> = {
  overall: "overall usage",
  prompts: "your prompts",
  files: "your files",
};

interface CoachFileInfo {
  path: string;
  name: string;
  size: number;
  words: number;
  exists: boolean;
}
interface CoachState {
  files: CoachFileInfo[];
  suggestions: CoachFileInfo[];
  max: number;
}

/** Files the user picks (CLAUDE.md, agents, commands, prompt templates) for the AI coach. App window only. */
function CoachFiles({ busy, onCoach, onPreview }: { busy: string | null; onCoach: () => void; onPreview: () => void }) {
  const [s, setS] = useState<CoachState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const call = useCallback(async (channel: string, ...args: unknown[]) => {
    try {
      setS(await bridge!.invoke<CoachState>(channel, ...args));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  }, []);
  useEffect(() => void call("coach:get"), [call]);
  if (!s) return err ? <p className="callout sev-high">{err}</p> : null;
  const full = s.files.length >= s.max;
  return (
    <>
      <p className="muted" style={{ fontSize: 13, margin: "4px 0 12px", maxWidth: "80ch" }}>
        Pick the files you give Claude as instructions: <span className="mono">CLAUDE.md</span>, agent and subagent
        definitions, slash commands, prompt templates. The AI coach checks what is unclear, contradictory or missing and
        rewrites those parts. It runs with your own model; only the files you add here are sent, and you see them in
        “What will be sent?” first.
      </p>
      <section className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3 style={{ margin: 0 }}>
            <FileText size={15} style={{ verticalAlign: -2 }} /> Files to coach ({s.files.length})
          </h3>
          <div className="row">
            <button className="btn" disabled={full} onClick={() => call("coach:pick")}>
              <FilePlus size={14} /> Add files…
            </button>
            <button className="btn primary" disabled={!s.files.length || !!busy} onClick={onCoach}>
              {busy === "files" ? <span className="spin" /> : <GraduationCap size={14} />} Coach these files
            </button>
            <button className="btn ghost sm" disabled={!s.files.length} onClick={onPreview}>
              What will be sent?
            </button>
          </div>
        </div>
        {err && (
          <p className="callout sev-high" role="alert" style={{ marginBottom: 0 }}>
            {err}
          </p>
        )}
        {!s.files.length ? (
          <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
            No files yet. Use <b>Add files…</b>, or add one of the files found below.
          </p>
        ) : (
          <table className="list" style={{ marginTop: 10 }}>
            <tbody>
              {s.files.map((f) => (
                <tr key={f.path} style={{ cursor: "default" }}>
                  <td>
                    <div className="mono" style={{ fontSize: 12.5 }}>
                      {f.name}
                    </div>
                    <div className="dim" style={{ fontSize: 11, wordBreak: "break-all" }}>
                      {f.path}
                    </div>
                  </td>
                  <td className="muted" style={{ whiteSpace: "nowrap" }}>
                    {f.exists ? `${f.words} words` : <span style={{ color: "var(--red)" }}>missing</span>}
                  </td>
                  <td style={{ width: 40 }}>
                    <button
                      className="btn sm ghost"
                      aria-label={`Remove ${f.name}`}
                      onClick={() => call("coach:remove", f.path)}
                    >
                      <X size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {s.suggestions.length > 0 && (
        <section className="panel">
          <h3>Found on this computer</h3>
          <p className="sub">
            Instruction files in your Claude folder and in the folders of your recent sessions. Nothing is read until
            you add it.
          </p>
          <table className="list">
            <tbody>
              {s.suggestions.map((f) => (
                <tr key={f.path} style={{ cursor: "default" }}>
                  <td>
                    <div className="mono" style={{ fontSize: 12.5 }}>
                      {f.name}
                    </div>
                    <div className="dim" style={{ fontSize: 11, wordBreak: "break-all" }}>
                      {f.path}
                    </div>
                  </td>
                  <td className="muted" style={{ whiteSpace: "nowrap" }}>
                    {f.words} words
                  </td>
                  <td style={{ width: 80 }}>
                    <button className="btn sm" disabled={full} onClick={() => call("coach:add", f.path)}>
                      <FilePlus size={13} /> Add
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

function SuggestionCard({ s, sessionName }: { s: SuggestionRow; sessionName?: string }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const vote = (v: 1 | -1) => bridge?.invoke("ai:vote", s.id, s.vote === v ? null : v);
  return (
    <section className="panel" style={{ marginBottom: 0 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className={`badge sev-${s.severity}`}>{s.severity.toUpperCase()}</span>
        <span className="dim" style={{ fontSize: 11.5 }}>
          {SCOPE_NAME[s.scope] ?? sessionName ?? "session"} · {dateTime(s.created_at)}
        </span>
      </div>
      <h3 style={{ marginTop: 8 }}>{s.title}</h3>
      <p className="muted" style={{ fontSize: 13, margin: "4px 0 10px" }}>
        {s.why}
      </p>
      <div className="kicker" style={{ marginBottom: 4 }}>
        Fix · {s.fix_kind.replace(/_/g, " ")}
      </div>
      <pre className="code">{s.fix}</pre>
      <div className="row" style={{ marginTop: 10 }}>
        <button
          className="btn sm"
          onClick={async () => {
            setCopied(await copy(s.fix));
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          <Copy size={13} /> {copied ? "Copied" : "Copy fix"}
        </button>
        {isApp && (
          <>
            <button
              className="btn sm ghost"
              title="Save this to your notes, so the coach builds on it next time"
              onClick={() =>
                bridge!
                  .invoke("notes:remember", s.id)
                  .then(() => setSaved("Saved to your notes"))
                  .catch((e: Error) => setSaved(e.message))
              }
            >
              <BookmarkPlus size={14} /> {saved ?? "Remember"}
            </button>
            <button
              className="btn sm ghost"
              aria-pressed={s.vote === 1}
              aria-label="Useful"
              onClick={() => vote(1)}
              style={s.vote === 1 ? { color: "var(--green)" } : undefined}
            >
              <ThumbsUp size={14} />
            </button>
            <button
              className="btn sm ghost"
              aria-pressed={s.vote === -1}
              aria-label="Not useful"
              onClick={() => vote(-1)}
              style={s.vote === -1 ? { color: "var(--red)" } : undefined}
            >
              <ThumbsDown size={14} />
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function Bars({
  title,
  data,
  mono,
  short,
  empty,
}: {
  title: string;
  data: Record<string, number>;
  mono?: boolean;
  short?: boolean;
  empty?: string;
}) {
  const rows = Object.entries(data)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const max = Math.max(1, ...rows.map((r) => r[1]));
  return (
    <section className="panel" style={{ marginBottom: 0 }}>
      <h3>{title}</h3>
      {!rows.length && <p className="dim">{empty ?? "Nothing yet."}</p>}
      {rows.map(([k, v]) => (
        <div key={k} className="hbar" title={k}>
          <span className={`name ${mono ? "mono" : ""}`} style={mono ? { fontSize: 11.5 } : undefined}>
            {short ? k.split(/[\\/]/).slice(-2).join("/") : k}
          </span>
          <span className="dim" style={{ textAlign: "right" }}>
            {v}
          </span>
          <div className="bar">
            <i style={{ width: `${(v / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </section>
  );
}
