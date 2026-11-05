import { Circle, CircleCheck, CircleDot, Pin, Wrench, X } from "lucide-react";
import type { AgentEvent, Card } from "@agenttrace/core";
import { clock, elapsed, tokens } from "../format";
import { STATE_COLOR, colorFor } from "./Cards";

const EV_COLOR: Record<string, string> = {
  user_prompt: "var(--sky)",
  assistant_text: "var(--text)",
  thinking: "var(--violet)",
  tool_call: "var(--teal)",
  subagent_spawn: "var(--violet)",
  tool_result: "var(--green)",
  other: "var(--dim)",
};
const EV_LABEL: Record<string, string> = {
  user_prompt: "PROMPT",
  assistant_text: "REPLY",
  thinking: "THINKING",
  tool_call: "TOOL CALL",
  subagent_spawn: "SUBAGENT",
  tool_result: "RESULT",
  other: "OTHER",
};

function Tile({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="tile">
      <div className="kicker">{k}</div>
      <div className="v">{v}</div>
    </div>
  );
}

export function SidePanel({
  card,
  events,
  now,
  onClose,
  onExpand,
  pins,
  onPin,
}: {
  card: Card;
  events: AgentEvent[];
  now: number;
  onClose: () => void;
  onExpand: (foldId: string) => void;
  /** Main prompt per session (source_uuid), and how to change it. */
  pins?: Record<string, string>;
  onPin?: (e: AgentEvent) => void;
}) {
  const color = colorFor(card);
  const ids = new Set(card.eventIds);
  const mine = events.filter((e) => ids.has(e.source_uuid)).slice(-300);
  const newestFirst = [...mine].reverse();
  const isAgent = card.kind === "agent" || card.kind === "subagent";
  const isTool = card.kind === "tool" || card.kind === "mcp";
  const calls = mine.filter((e) => e.event_type === "tool_call");
  const totalMs = calls.reduce((a, c) => a + (c.duration_ms ?? (c.status === "running" ? now - c.created_at : 0)), 0);
  const lastCall = calls.at(-1);

  return (
    <aside className="side" aria-label={`${card.label} details`}>
      <div className="side-head">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="kicker" style={{ color }}>
            {card.label}
          </span>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close panel">
            <X size={15} />
          </button>
        </div>
        <div style={{ fontWeight: 650, fontSize: 16, marginTop: 2, wordBreak: "break-word" }}>{card.title}</div>
        {card.subtitle && (
          <div className="muted" style={{ fontSize: 13 }}>
            {card.subtitle}
          </div>
        )}
      </div>
      <div className="side-body">
        {isAgent && (
          <div className="tiles">
            <Tile
              k="State"
              v={<span style={{ color: card.state ? STATE_COLOR[card.state] : undefined }}>{card.state}</span>}
            />
            <Tile k="Elapsed" v={elapsed(card.startedAt, card.endedAt ?? now) || "—"} />
            <Tile k="Tokens in / out" v={`${tokens(card.tokensIn ?? 0)} / ${tokens(card.tokensOut ?? 0)}`} />
            <Tile k="Events" v={card.eventCount ?? 0} />
          </div>
        )}
        {isTool && (
          <div className="tiles">
            <Tile k="Calls" v={card.calls} />
            <Tile k="Errors" v={<span style={card.errors ? { color: "var(--red)" } : undefined}>{card.errors}</span>} />
            <Tile
              k="Last call"
              v={
                lastCall
                  ? lastCall.status === "running"
                    ? "running"
                    : `${((lastCall.duration_ms ?? 0) / 1000).toFixed(1)}s`
                  : "—"
              }
            />
            <Tile k="Total time" v={`${(totalMs / 1000).toFixed(1)}s`} />
          </div>
        )}
        {card.progress && (
          <div>
            <div className="row" style={{ justifyContent: "space-between", fontSize: 12, marginBottom: 5 }}>
              <span className="muted">Progress (estimate)</span>
              <span style={card.progress.warn ? { color: "var(--amber)" } : undefined}>{card.progress.label}</span>
            </div>
            <div
              className={`bar ${card.progress.value == null ? "indeterminate" : ""} ${card.progress.warn ? "warn" : ""}`}
            >
              <i style={{ width: `${Math.round((card.progress.value ?? 0.35) * 100)}%` }} />
            </div>
          </div>
        )}
        {card.plan && (
          <div>
            <div className="kicker" style={{ marginBottom: 6 }}>
              Plan
            </div>
            <ul className="plan">
              {card.plan.map((t, i) => (
                <li key={i}>
                  {t.status === "completed" ? (
                    <CircleCheck size={15} color="var(--green)" style={{ flex: "none", marginTop: 2 }} />
                  ) : t.status === "in_progress" ? (
                    <CircleDot size={15} color="var(--teal)" style={{ flex: "none", marginTop: 2 }} />
                  ) : (
                    <Circle size={15} color="var(--dim)" style={{ flex: "none", marginTop: 2 }} />
                  )}
                  <span style={t.status === "completed" ? { color: "var(--muted)" } : undefined}>{t.content}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {card.kind === "resource" && card.items && (
          <div>
            <div className="kicker" style={{ marginBottom: 6 }}>
              Touched
            </div>
            <div className="code" style={{ maxHeight: 280, overflow: "auto" }}>
              {card.items.join("\n")}
            </div>
          </div>
        )}
        {card.kind === "fold" && card.folded && (
          <div>
            <ul className="plan">
              {card.folded.map((f) => (
                <li key={f.id}>
                  {card.foldKind === "tools" ? (
                    <Wrench size={15} color={color} style={{ flex: "none", marginTop: 2 }} />
                  ) : (
                    <CircleCheck size={15} color="var(--green)" style={{ flex: "none", marginTop: 2 }} />
                  )}{" "}
                  {f.title}
                </li>
              ))}
            </ul>
            <button className="btn" style={{ marginTop: 10 }} onClick={() => onExpand(card.id)}>
              Expand on the map
            </button>
          </div>
        )}
        {card.kind === "prompt" && onPin && (
          <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
            The card shows the prompt that asks for the session's main work; check-ins like “where are we?” are skipped.
            Press <Pin size={11} style={{ verticalAlign: -1 }} /> on a prompt below to choose it yourself.
          </p>
        )}
        {mine.length > 0 && (
          <div>
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
              <span className="kicker">{card.kind === "prompt" ? `Your prompts (${mine.length})` : "Events"}</span>
              <span className="dim" style={{ fontSize: 11 }}>
                newest at the top · click to expand
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {newestFirst.map((e) => {
                const c = e.status === "error" ? "var(--red)" : EV_COLOR[e.event_type];
                const pinned = pins?.[e.session_id] === e.source_uuid;
                return (
                  <details key={e.source_uuid} className="ev" style={{ borderLeftColor: c }}>
                    <summary>
                      <span className="meta">
                        <span className="mono">{clock(e.created_at)}</span>
                        <b style={{ color: c }}>{e.status === "error" ? "ERROR" : EV_LABEL[e.event_type]}</b>
                        {e.duration_ms != null && <span>{(e.duration_ms / 1000).toFixed(1)}s</span>}
                        {card.kind === "prompt" && onPin && e.event_type === "user_prompt" && (
                          <button
                            className="btn sm ghost pin"
                            aria-pressed={pinned}
                            title={pinned ? "Stop using this as the main prompt" : "Use as the session's main prompt"}
                            onClick={(ev) => {
                              ev.preventDefault();
                              onPin(e);
                            }}
                          >
                            <Pin size={12} /> {pinned ? "Main prompt" : "Set as main"}
                          </button>
                        )}
                      </span>
                      <span style={{ wordBreak: "break-word" }}>
                        {e.summary || <span className="dim">(empty)</span>}
                      </span>
                    </summary>
                    <pre className="code">{JSON.stringify(e.payload, null, 2)}</pre>
                  </details>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
