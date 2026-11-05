import { useEffect, useMemo, useRef } from "react";
import { BookOpen, Check, CircleAlert, Clock, FilePen, FilePlus, Map as MapIcon, Sparkles, X } from "lucide-react";
import { mcpParts, sessionRecap, type RecapTurn } from "@agenttrace/core";
import { api, bridge, isApp, navigate, useLoad, useStream, type Changes } from "../api";
import { useAi, PROVIDER_NAME, type AiAction } from "../ai";
import { clock, dateTime, fmtDuration, folderName, tokens } from "../format";
import { Markdown } from "../components/Markdown";

export function Explain({ sessionParam }: { sessionParam: string | null }) {
  const { data: sessions } = useLoad(api.sessions, ["reset"]);
  const sid = sessionParam ?? sessions?.[0]?.id ?? null;
  const session = sessions?.find((s) => s.id === sid) ?? null;

  useEffect(() => {
    if (!sessionParam && sid) navigate("explain", { session: sid }, true);
  }, [sessionParam, sid]);

  const empty = async () => [] as never[];
  const { data: events, reload: reloadEvents } = useLoad(
    () => (sid ? api.events(sid) : empty()),
    ["reset", "open"],
    [sid],
  );
  const { data: todos, reload: reloadTodos } = useLoad(() => (sid ? api.todos(sid) : empty()), ["reset"], [sid]);
  const { data: explanation, reload: reloadExplanation } = useLoad(
    () => (sid ? api.explanation(sid) : Promise.resolve(null)),
    ["reset"],
    [sid],
  );

  // Live sessions: refresh at most every 3 seconds while new events arrive.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useStream((t, d: Changes | { session_id?: string }) => {
    if (t === "explain" && (d as { session_id?: string }).session_id === sid) reloadExplanation();
    if (t !== "changes" || !sid || timer.current) return;
    if (!(d as Changes).events.some((e) => e.session_id === sid)) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      reloadEvents();
      reloadTodos();
    }, 3000);
  });
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const recap = useMemo(
    () => sessionRecap(events ?? [], todos ?? [], session?.project_path ?? ""),
    [events, todos, session?.project_path],
  );
  const { ai, busy, msg, request, show, modal } = useAi();

  const explain = (sid: string): AiAction => ({
    kind: "explain",
    sid,
    go: () => bridge!.invoke("ai:explain", sid),
    done: () => "Explanation ready.",
  });

  if (sessions && !sessions.length)
    return (
      <div className="page-pad">
        <h2>Explain</h2>
        <p className="muted">No sessions yet. Use Claude Code on this machine and come back here.</p>
      </div>
    );

  const t = recap.totals;
  const duration = recap.startedAt && recap.endedAt ? recap.endedAt - recap.startedAt : 0;
  return (
    <div className="page-pad">
      <h2>Explain</h2>
      <p className="lede">
        What happened in a session, turn by turn: what you asked, what Claude and its subagents did, which files changed
        and how each turn ended. Built from the logs on this computer. <b>Explain with AI</b> turns it into a
        plain-language walkthrough with what went wrong and what to do next.
      </p>

      <div className="row" style={{ marginBottom: 16 }}>
        <select
          className="input"
          style={{ width: 360 }}
          value={sid ?? ""}
          onChange={(e) => navigate("explain", { session: e.target.value })}
          aria-label="Session to explain"
        >
          {(sessions ?? []).slice(0, 100).map((s) => (
            <option key={s.id} value={s.id}>
              {folderName(s.project_path)} · {dateTime(s.last_event_at)}
              {s.is_demo ? " · demo" : ""}
            </option>
          ))}
        </select>
        {sid && (
          <a className="btn sm ghost" href={`#/map?session=${encodeURIComponent(sid)}`}>
            <MapIcon size={13} /> Open in Live Map
          </a>
        )}
      </div>

      <div className="stats-row">
        <Stat label="Duration" value={fmtDuration(duration)} />
        <Stat label="Your prompts" value={t.prompts} />
        <Stat label="Steps" value={t.steps} />
        <Stat label="Subagents" value={t.subagents} />
        <Stat label="Files changed" value={t.edited.length} />
        <Stat label="Failed commands" value={t.failedCommands} warn={t.failedCommands > 0} />
        <Stat label="Tokens" value={tokens(recap.tokens)} />
      </div>

      <section className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h3>
              <Sparkles size={15} style={{ verticalAlign: -2 }} color="var(--violet)" /> Plain-language explanation
            </h3>
            <p className="sub" style={{ margin: 0 }}>
              {isApp
                ? `Uses ${ai ? PROVIDER_NAME[ai.config.kind] : "…"}${ai?.config.model ? ` · ${ai.config.model}` : ""}. Sends your prompts, the actions and file names, never file contents or tool outputs.`
                : "Explanations are made in the app on the machine itself."}
            </p>
          </div>
          {isApp && sid && (
            <div className="row">
              <button className="btn primary" disabled={!!busy} onClick={() => request(explain(sid))}>
                {busy === "explain" ? <span className="spin" /> : <BookOpen size={14} />}
                {explanation ? "Explain again" : "Explain with AI"}
              </button>
              <button className="btn ghost sm" onClick={() => show(explain(sid))}>
                What will be sent?
              </button>
            </div>
          )}
        </div>
        {msg && (
          <p className="callout" style={{ marginTop: 12, marginBottom: 0 }} role="status">
            {msg}
          </p>
        )}
        {explanation && (
          <div className="explanation">
            <div className="dim" style={{ fontSize: 11.5, marginBottom: 6 }}>
              Written {dateTime(explanation.created_at)}
            </div>
            <Markdown text={explanation.text} />
          </div>
        )}
      </section>

      {recap.plan && recap.plan.length > 0 && (
        <section className="panel">
          <h3>Plan</h3>
          <p className="sub">The main agent's last todo list</p>
          <ul className="plan-list">
            {recap.plan.map((p, i) => (
              <li key={i} className={p.status}>
                {p.status === "completed" ? (
                  <Check size={13} />
                ) : p.status === "in_progress" ? (
                  <span className="spin" />
                ) : (
                  <span className="dot" />
                )}
                {p.content}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="kicker" style={{ margin: "6px 0 10px" }}>
        Turn by turn ({recap.turns.length})
      </div>
      {events && !recap.turns.length && <p className="muted">Nothing to explain in this session yet.</p>}
      {recap.turns.map((turn, i) => (
        <TurnCard key={turn.at + ":" + i} turn={turn} n={i + 1} />
      ))}
      {modal}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <div className="stat">
      <div className="v" style={warn ? { color: "var(--amber)" } : undefined}>
        {value}
      </div>
      <div className="l">{label}</div>
    </div>
  );
}

const OTHER_TOOLS = new Set([
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "Read",
  "Grep",
  "Glob",
  "Bash",
  "PowerShell",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
]);

function TurnCard({ turn, n }: { turn: RecapTurn; n: number }) {
  const other = Object.entries(turn.tools).filter(([k]) => !OTHER_TOOLS.has(k));
  const quiet =
    !turn.subagents.length &&
    !turn.edited.length &&
    !turn.created.length &&
    !turn.commands.length &&
    !turn.reads &&
    !turn.searches &&
    !turn.web.length &&
    !other.length;
  return (
    <section className="panel turn">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="kicker">
          Turn {n} · {clock(turn.at)}
        </span>
        <span className="row" style={{ gap: 6 }}>
          {turn.errors > 0 && (
            <span className="badge sev-high">
              <CircleAlert size={11} /> {turn.errors} error{turn.errors > 1 ? "s" : ""}
            </span>
          )}
          <span className="badge" style={{ color: "var(--muted)" }}>
            <Clock size={11} /> {fmtDuration(turn.durationMs)}
          </span>
        </span>
      </div>

      <div className="asked">
        <div className="lbl">{turn.prompt ? "You asked" : "Before your first prompt in this log"}</div>
        {turn.prompt && <div className="txt">{turn.prompt}</div>}
      </div>

      <div className="lbl">What happened</div>
      {quiet && (
        <p className="muted" style={{ margin: "2px 0 8px", fontSize: 13 }}>
          Claude answered without using tools.
        </p>
      )}
      <ul className="did">
        {turn.subagents.map((s, i) => (
          <li key={"s" + i}>
            <span
              className={`badge ${s.status === "error" ? "sev-high" : ""}`}
              style={{ color: s.status === "error" ? undefined : "var(--violet)" }}
            >
              SUBAGENT
            </span>{" "}
            <b>{s.name}</b> — {s.task}
            {s.durationMs != null && <span className="dim"> · {fmtDuration(s.durationMs)}</span>}
            {s.status === "running" && <span className="dim"> · still running</span>}
          </li>
        ))}
        {turn.edited.length > 0 && (
          <li>
            <FilePen size={13} className="muted" /> Edited {turn.edited.length} file{turn.edited.length > 1 ? "s" : ""}:{" "}
            <span className="mono files">{turn.edited.join(", ")}</span>
          </li>
        )}
        {turn.created.length > 0 && (
          <li>
            <FilePlus size={13} className="muted" /> Created / rewrote:{" "}
            <span className="mono files">{turn.created.join(", ")}</span>
          </li>
        )}
        {(turn.reads > 0 || turn.searches > 0) && (
          <li className="muted">
            {[
              turn.reads ? `Read ${turn.reads} file${turn.reads === 1 ? "" : "s"}` : "",
              turn.searches ? `searched the code ${turn.searches} time${turn.searches === 1 ? "" : "s"}` : "",
            ]
              .filter(Boolean)
              .join(" and ")
              .replace(/^s/, "S")}
          </li>
        )}
        {turn.web.length > 0 && <li className="muted">Looked up on the web: {turn.web.slice(0, 4).join(" · ")}</li>}
        {other.length > 0 && (
          <li className="muted">
            Other tools:{" "}
            {other
              .map(([k, v]) => {
                const m = mcpParts(k);
                return `${m ? `${m.server} · ${m.tool}` : k}${v > 1 ? ` ×${v}` : ""}`;
              })
              .join(", ")}
          </li>
        )}
      </ul>
      {turn.commands.length > 0 && (
        <div className="cmds">
          {turn.commands.map((c, i) => (
            <div key={i} className="cmd">
              {c.ok === false ? (
                <X size={13} color="var(--red)" aria-label="failed" />
              ) : c.ok ? (
                <Check size={13} color="var(--green)" aria-label="succeeded" />
              ) : (
                <span className="spin" />
              )}
              <span className="mono">{c.cmd}</span>
            </div>
          ))}
        </div>
      )}

      {turn.answer && (
        <>
          <div className="lbl">How it ended</div>
          <div className="answer">
            <Markdown text={turn.answer} />
          </div>
        </>
      )}
    </section>
  );
}
