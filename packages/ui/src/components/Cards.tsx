import { memo } from "react";
import {
  BaseEdge,
  Handle,
  Position,
  getBezierPath,
  type EdgeProps,
  type NodeProps,
  type Node,
  type Edge,
} from "@xyflow/react";
import {
  Bot,
  Check,
  ChevronUp,
  CircleCheck,
  FileText,
  Globe,
  MessageSquare,
  PenLine,
  Plug,
  Search,
  Server,
  Terminal,
  Users,
  Wrench,
  X,
  FolderKanban,
  FolderOpen,
  Link,
} from "lucide-react";
import type { AgentState, Card } from "@agenttrace/core";
import { elapsed } from "../format";

export const KIND_COLOR: Record<string, string> = {
  group: "#e6edf3",
  prompt: "#38bdf8",
  agent: "#2dd4bf",
  subagent: "#a78bfa",
  tool: "#60a5fa",
  mcp: "#f472b6",
  resource: "#fbbf24",
  fold: "#4ade80",
};

export const STATE_COLOR: Record<AgentState, string> = {
  Thinking: "#a78bfa",
  "Running tool": "#2dd4bf",
  "Background work": "#38bdf8",
  Working: "#5eead4",
  Starting: "#2dd4bf",
  "Waiting for you": "#fbbf24",
  Done: "#4ade80",
  Error: "#fb7185",
  Idle: "#8b98a8",
};

const TOOL_ICON: Record<string, typeof Terminal> = {
  Bash: Terminal,
  PowerShell: Terminal,
  Read: FileText,
  NotebookRead: FileText,
  Edit: PenLine,
  MultiEdit: PenLine,
  Write: PenLine,
  NotebookEdit: PenLine,
  Grep: Search,
  Glob: Search,
  WebFetch: Globe,
  WebSearch: Globe,
};

const RESOURCE_ICON: Record<string, typeof Terminal> = {
  FILES: FolderOpen,
  COMMAND: Terminal,
  WEB: Link,
  SEARCH: Search,
  "MCP SERVER": Server,
};

/** A tools chip takes the tool colour; everything else its kind's colour. */
export const colorFor = (card: Card) =>
  card.kind === "fold" && card.foldKind === "tools" ? KIND_COLOR.tool : KIND_COLOR[card.kind];

export function iconFor(card: Card) {
  switch (card.kind) {
    case "group":
      return FolderKanban;
    case "prompt":
      return MessageSquare;
    case "agent":
      return Bot;
    case "subagent":
      return Users;
    case "mcp":
      return Plug;
    case "resource":
      return RESOURCE_ICON[card.label] ?? FolderOpen;
    case "fold":
      return card.foldKind === "tools" ? Wrench : CircleCheck;
    default:
      return TOOL_ICON[card.toolName ?? ""] ?? Wrench;
  }
}

export type CardNodeData = {
  card: Card;
  now: number;
  selected: boolean;
  onCollapse?: (foldId: string) => void;
};
export type CardNode = Node<CardNodeData, "card">;

function ProgressLine({ card }: { card: Card }) {
  const p = card.progress;
  if (!p) return null;
  const cls = `bar ${p.value == null ? "indeterminate" : ""} ${p.warn ? "warn" : ""}`;
  return (
    <div>
      <div
        className={cls}
        role="progressbar"
        aria-label="Progress (estimate)"
        aria-valuenow={p.value == null ? undefined : Math.round(p.value * 100)}
      >
        <i style={{ width: `${Math.round((p.value ?? 0.35) * 100)}%` }} />
      </div>
      <div className="prog-row">
        <span style={p.warn ? { color: "var(--amber)" } : undefined}>{p.label}</span>
        {p.etaMs != null || p.value == null || p.warn ? <em>EST.</em> : null}
      </div>
    </div>
  );
}

export const CardView = memo(function CardView({ data }: NodeProps<CardNode>) {
  const { card, now, selected } = data;
  const color = colorFor(card);
  const Icon = iconFor(card);
  const running = card.look === "running";
  const timer = running ? elapsed(card.startedAt, now) : null;
  return (
    <div className={`card ${card.look} ${selected ? "selected" : ""}`} title={card.title}>
      <Handle type="target" position={Position.Top} />
      <div className="card-top">
        <div className="icon-sq" style={{ color, background: color + "14", borderColor: color + "40" }}>
          {running ? <span className="spin" aria-label="running" /> : <Icon size={19} strokeWidth={2} aria-hidden />}
          {card.look === "done" && card.kind !== "fold" && (
            <span className="icon-badge" style={{ background: "var(--green)" }} aria-label="done">
              <Check size={9} strokeWidth={4} color="#062b14" />
            </span>
          )}
          {card.look === "error" && (
            <span className="icon-badge" style={{ background: "var(--red)" }} aria-label="error">
              <X size={9} strokeWidth={4} color="#2b0610" />
            </span>
          )}
        </div>
        <div className="card-head">
          <div className="card-label">
            <span className="k" style={{ color }}>
              {card.label}
            </span>
            <span className="badges">
              {card.server && (
                <span className="badge" style={{ color: "var(--pink)" }}>
                  {card.server}
                </span>
              )}
              {card.calls != null && card.calls > 1 && (
                <span className="badge" style={{ color: "var(--muted)" }}>
                  ×{card.calls}
                </span>
              )}
              {!!card.errors && (
                <span className="badge" style={{ color: "var(--red)" }}>
                  {card.errors} err
                </span>
              )}
              {card.state && (
                <span
                  className="state"
                  style={{ color: STATE_COLOR[card.state], borderColor: STATE_COLOR[card.state] + "55" }}
                >
                  {card.state}
                </span>
              )}
              {timer && card.kind !== "agent" && card.kind !== "subagent" && (
                <span className="mono dim" style={{ fontSize: 10.5 }}>
                  {timer}
                </span>
              )}
              {card.foldId && data.onCollapse && (
                <button
                  className="fold-btn nodrag"
                  aria-label={card.kind === "subagent" ? "Collapse finished subagents" : "Collapse tools"}
                  title="Collapse"
                  onClick={(e) => {
                    e.stopPropagation();
                    data.onCollapse!(card.foldId!);
                  }}
                >
                  <ChevronUp size={12} />
                </button>
              )}
            </span>
          </div>
          <div className="card-title">{card.title}</div>
          {card.subtitle && <div className="card-sub">{card.subtitle}</div>}
        </div>
      </div>
      <Inner card={card} now={now} />
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
});

function Inner({ card, now }: { card: Card; now: number }) {
  if (card.kind === "fold" || card.kind === "group")
    return (
      <div className="card-inner">
        <div className="l">{card.lines[0]}</div>
      </div>
    );
  if (card.kind === "prompt")
    return (
      <div className="card-inner clamp">
        <div className="l" style={{ color: "var(--text)" }}>
          {card.lines[0]}
        </div>
        {card.lines[1] && (
          <div className="l one" title={card.lines[1]}>
            <span className="dim">latest:</span> {card.lines[1]}
          </div>
        )}
        {card.startedAt != null && (
          <div className="l dim one">
            sent{" "}
            {now - card.startedAt > 20 * 3600_000
              ? new Date(card.startedAt).toLocaleString([], {
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                })
              : new Date(card.startedAt).toLocaleTimeString([], { hour12: false })}
            {card.look === "running" ? ` · ${elapsed(card.startedAt, now)}` : ""}
          </div>
        )}
      </div>
    );
  if (card.kind === "agent" || card.kind === "subagent")
    return (
      <div className="card-inner">
        <div className="l">
          {[
            card.model,
            card.tokensIn != null ? `${fmtK(card.tokensIn + (card.tokensOut ?? 0))} tokens` : null,
            card.look === "running" ? elapsed(card.startedAt, now) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
        <div className="l" style={{ color: "var(--text)" }}>
          {card.lines[0]}
        </div>
        <ProgressLine card={card} />
      </div>
    );
  if (card.kind === "resource")
    return (
      <div className="card-inner">
        {card.lines.length ? (
          card.lines.map((l, i) => (
            <div key={i} className="l mono">
              {l}
            </div>
          ))
        ) : (
          <div className="l dim">—</div>
        )}
      </div>
    );
  return (
    <div className="card-inner">
      <div className="l mono">{card.lines[0]}</div>
      {card.look === "running" ? (
        <div className="l" style={{ color: "var(--teal)" }}>
          running · {elapsed(card.startedAt, now)}
        </div>
      ) : (
        <div className="l" style={card.look === "error" ? { color: "var(--red)" } : undefined}>
          {card.lines[1]}
        </div>
      )}
    </div>
  );
}

const fmtK = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

export type LiveEdge = Edge<{ running: boolean }, "live">;

/** Curved connector; while the child runs it turns teal and three dots travel along it. */
export function LiveEdgeView({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<LiveEdge>) {
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const running = !!data?.running;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{ stroke: running ? "#2dd4bf" : "#2a3644", strokeWidth: running ? 1.8 : 1.3 }}
      />
      {running &&
        [0, 0.5, 1].map((delay) => (
          <circle key={delay} r={2.6} fill="#5eead4">
            <animateMotion dur="1.5s" repeatCount="indefinite" begin={`${delay}s`} path={path} />
          </circle>
        ))}
    </>
  );
}
