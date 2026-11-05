import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  getViewportForBounds,
  useReactFlow,
  type NodeTypes,
  type EdgeTypes,
  type Viewport,
} from "@xyflow/react";
import {
  Activity,
  BookOpen,
  Check,
  ChevronDown,
  ChevronsDownUp,
  Layers,
  LocateFixed,
  Pause,
  Play,
  PlayCircle,
  Plus,
  Radio,
  Wrench,
} from "lucide-react";
import { SESSION_SEP, buildTree, combineModels, type AgentEvent, type TodoSnapshot } from "@agenttrace/core";
import { api, bridge, isApp, navigate, useLoad, useNow, useStream, type Changes, type SessionRow } from "../api";
import { ago, clock, elapsed, folderName, tokens } from "../format";
import { CARD_H, CARD_W, layoutCards } from "../layout";
import { CardView, LiveEdgeView, type CardNode, type LiveEdge } from "../components/Cards";
import { SidePanel } from "../components/SidePanel";

const ACTIVE_MS = 2 * 60_000;
/** "Add this project's sessions" picks sessions of the same folder active within this window. */
const PROJECT_WINDOW_MS = 6 * 3600_000;
const MAX_COMBINED = 12;
const nodeTypes: NodeTypes = { card: CardView };
const edgeTypes: EdgeTypes = { live: LiveEdgeView };

// ---- small per-viewer memories (browser storage, never required) ----
const VIEWS_KEY = "agenttrace.viewports";
const TOOLS_KEY = "agenttrace.showTools";
const store = {
  get<T>(k: string, fallback: T, s: () => Storage = () => sessionStorage): T {
    try {
      return (JSON.parse(s().getItem(k) ?? "null") as T) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(k: string, v: unknown, s: () => Storage = () => sessionStorage) {
    try {
      s().setItem(k, JSON.stringify(v));
    } catch {
      /* storage blocked: keep it in memory */
    }
  },
};

/** Where the user left each map (pan and zoom), kept while the app runs and across reloads. */
const viewports = new Map<string, Viewport>(Object.entries(store.get<Record<string, Viewport>>(VIEWS_KEY, {})));
function saveViewport(key: string, v: Viewport) {
  viewports.delete(key);
  viewports.set(key, v);
  while (viewports.size > 50) viewports.delete(viewports.keys().next().value!);
  store.set(VIEWS_KEY, Object.fromEntries(viewports));
}

function mergeEvents(prev: AgentEvent[], incoming: AgentEvent[]) {
  const byId = new Map(prev.map((e) => [e.source_uuid, e]));
  for (const e of incoming) byId.set(e.source_uuid, e);
  const all = [...byId.values()].sort((a, b) => a.created_at - b.created_at);
  return all.length > 5000 ? all.slice(-5000) : all;
}

type SessionData = Record<
  string,
  { events: AgentEvent[]; todos: TodoSnapshot[]; prompts: AgentEvent[]; loaded: boolean }
>;

/** The prompt each viewer marked as a session's main one (kept in this browser only). */
const PINS_KEY = "agenttrace.mainPrompts";

/** Events and plans of one or more sessions, kept live from the shared stream. */
function useSessionsData(sids: string[]): SessionData {
  const key = sids.join(",");
  const [data, setData] = useState<SessionData>({});
  const loadOne = useCallback((sid: string) => {
    Promise.all([api.events(sid), api.todos(sid), api.prompts(sid).catch(() => [] as AgentEvent[])])
      .then(([events, todos, prompts]) => setData((d) => ({ ...d, [sid]: { events, todos, prompts, loaded: true } })))
      .catch(() => {});
  }, []);
  const loadAll = useCallback(() => {
    for (const sid of key ? key.split(",") : []) loadOne(sid);
  }, [key, loadOne]);
  useEffect(() => {
    setData({});
    loadAll();
  }, [loadAll]);
  useStream((t, d: Changes) => {
    if (t === "reset" || t === "open") return loadAll(); // "open": reconnected, catch up on anything missed
    if (t !== "changes" || !key) return;
    const mine = new Set(key.split(","));
    for (const sid of d.relinked) if (mine.has(sid)) loadOne(sid);
    const take = (sid: string) => mine.has(sid) && !d.relinked.includes(sid);
    const evs = d.events.filter((e) => take(e.session_id));
    const tds = d.todos.filter((x) => take(x.session_id));
    if (!evs.length && !tds.length) return;
    setData((prev) => {
      const next = { ...prev };
      for (const sid of mine) {
        const e = evs.filter((x) => x.session_id === sid);
        const t2 = tds.filter((x) => x.session_id === sid);
        if (!e.length && !t2.length) continue;
        const cur = next[sid] ?? { events: [], todos: [], prompts: [], loaded: false };
        next[sid] = {
          ...cur,
          events: e.length ? mergeEvents(cur.events, e) : cur.events,
          todos: t2.length ? [...cur.todos, ...t2] : cur.todos,
        };
      }
      return next;
    });
  });
  return data;
}

async function loadDemo() {
  const sid = await bridge!.invoke<string>("demo:load");
  navigate("map", { session: sid });
}

/** Opens the map for a session, optionally with more sessions combined into it. */
const openMap = (sid: string, more: string[] = [], replace = false) =>
  navigate("map", { session: sid, with: more.filter((x) => x !== sid).join(",") || null }, replace);

export function LiveMap({ sessionParam, withParam }: { sessionParam: string | null; withParam: string | null }) {
  const now = useNow(1000);
  const { data: sessions, setData: setSessions } = useLoad(api.sessions, ["reset", "open"]);
  const { data: averages } = useLoad(api.averages, ["insights"]);
  const [toast, setToast] = useState<SessionRow | null>(null);

  const ordered = useMemo(() => {
    const list = [...(sessions ?? [])];
    const active = (s: SessionRow) => now - s.last_event_at < ACTIVE_MS;
    return list.sort((a, b) => Number(active(b)) - Number(active(a)) || b.last_event_at - a.last_event_at);
  }, [sessions, now]);
  const current = ordered.find((s) => s.id === sessionParam) ?? (sessionParam ? null : ordered[0]) ?? null;
  const sid = current?.id ?? sessionParam;
  const extra = useMemo(
    () => [...new Set((withParam ?? "").split(",").filter((x) => x && x !== sid))].slice(0, MAX_COMBINED - 1),
    [withParam, sid],
  );
  const sids = useMemo(() => (sid ? [sid, ...extra] : []), [sid, extra]);

  useEffect(() => {
    if (!sessionParam && current) openMap(current.id, extra, true);
  }, [sessionParam, current, extra]);

  const stateRef = useRef({ current, sids });
  stateRef.current = { current, sids };
  useStream((t, d: Changes) => {
    if (t !== "changes" || !d.sessions.length) return;
    setSessions((prev) => {
      const list = [...(prev ?? [])];
      for (const s of d.sessions) {
        const i = list.findIndex((x) => x.id === s.id);
        if (i >= 0) list[i] = { ...list[i], ...s };
        else {
          list.push({ ...s, plan_progress: null });
          if (!s.is_demo) {
            const { current: cur, sids: open } = stateRef.current;
            // A combined map never jumps away on its own: offer the new session instead.
            if (open.length < 2 && (!cur || Date.now() - cur.last_event_at > ACTIVE_MS)) openMap(s.id, [], true);
            else setToast({ ...s, plan_progress: null });
          }
        }
      }
      return list;
    });
  });

  if (sessions && !sessions.length) return <EmptyState />;
  return (
    <ReactFlowProvider>
      <MapView
        key={sids.join(",") || "none"}
        sids={sids}
        sessions={ordered}
        current={current}
        now={now}
        averages={averages ?? {}}
      />
      {toast && (
        <div className="toast" role="status">
          <Activity size={16} color="var(--teal)" />
          <span>
            New session: <b>{folderName(toast.project_path)}</b>
          </span>
          {sid && (
            <button
              className="btn sm"
              onClick={() => {
                openMap(sid, [...extra, toast.id]);
                setToast(null);
              }}
            >
              <Plus size={13} /> Add to this map
            </button>
          )}
          <button
            className="btn sm primary"
            onClick={() => {
              openMap(toast.id);
              setToast(null);
            }}
          >
            Open
          </button>
          <button className="btn sm ghost" onClick={() => setToast(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
    </ReactFlowProvider>
  );
}

function EmptyState() {
  return (
    <div className="empty">
      <div>
        <Radio size={34} color="var(--teal)" />
        <h2>No sessions yet</h2>
        <p className="muted" style={{ maxWidth: 440, margin: "0 auto 18px" }}>
          Use Claude Code in any terminal on this machine. Its sessions show up here live, with every subagent and tool
          call.
        </p>
        {isApp && (
          <button className="btn violet" onClick={loadDemo}>
            <PlayCircle size={15} /> Load demo session
          </button>
        )}
      </div>
    </div>
  );
}

/** Same folder, active within a few hours of the current session: the other CLIs of one project. */
const projectMates = (sessions: SessionRow[], cur: SessionRow) =>
  sessions
    .filter(
      (s) =>
        s.id !== cur.id &&
        !!s.project_path &&
        folderName(s.project_path) === folderName(cur.project_path) &&
        Math.abs(s.last_event_at - cur.last_event_at) < PROJECT_WINDOW_MS,
    )
    .slice(0, MAX_COMBINED - 1);

function SessionPicker({
  sessions,
  current,
  sids,
  now,
}: {
  sessions: SessionRow[];
  current: SessionRow | null;
  sids: string[];
  now: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const active = (s: SessionRow) => now - s.last_event_at < ACTIVE_MS;
  const combined = sids.length > 1;
  const onMap = new Set(sids);
  const mates = current ? projectMates(sessions, current).filter((s) => !onMap.has(s.id)) : [];
  const toggle = (id: string) => {
    if (!current) return;
    const rest = sids.slice(1);
    openMap(current.id, onMap.has(id) ? rest.filter((x) => x !== id) : [...rest, id].slice(0, MAX_COMBINED - 1));
  };
  return (
    <div className="picker" ref={ref}>
      <button className="picker-btn" onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open}>
        {combined ? (
          <Layers size={15} color="var(--teal)" />
        ) : (
          <span className={`status-dot ${current && active(current) ? "on" : ""}`} />
        )}
        <span style={{ minWidth: 0, flex: 1 }}>
          <div className="t" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {current ? folderName(current.project_path) : "Pick a session"}
            {combined ? ` + ${sids.length - 1} more` : ""}
          </div>
          <div className="s" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {combined
              ? `${sids.length} sessions on one map`
              : current
                ? [current.is_demo ? "Demo" : null, current.git_branch].filter(Boolean).join(" · ") || "no branch"
                : ""}
          </div>
        </span>
        <ChevronDown size={15} className="muted" />
      </button>
      {open && (
        <div className="picker-menu" role="listbox" aria-label="Sessions">
          <div className="picker-actions">
            {mates.length > 0 && current && (
              <button
                className="btn sm"
                onClick={() => {
                  openMap(current.id, [...sids.slice(1), ...mates.map((m) => m.id)].slice(0, MAX_COMBINED - 1));
                  setOpen(false);
                }}
              >
                <Layers size={13} /> Add {folderName(current.project_path)}'s other sessions ({mates.length})
              </button>
            )}
            {combined && current && (
              <button
                className="btn sm ghost"
                onClick={() => {
                  openMap(current.id);
                  setOpen(false);
                }}
              >
                Show only {folderName(current.project_path)}
              </button>
            )}
            <span className="dim" style={{ fontSize: 11.5 }}>
              Click a session to open it, or <Plus size={11} style={{ verticalAlign: -1 }} /> to put several CLIs on one
              map.
            </span>
          </div>
          {sessions.map((s) => (
            <div key={s.id} className={`picker-row ${onMap.has(s.id) ? "on" : ""}`}>
              <button
                className="picker-item"
                role="option"
                aria-selected={s.id === current?.id}
                onClick={() => {
                  openMap(s.id);
                  setOpen(false);
                }}
              >
                <span className={`status-dot ${active(s) ? "on" : ""}`} style={{ marginTop: 6 }} />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>
                    {folderName(s.project_path)}{" "}
                    {s.is_demo && (
                      <span className="badge" style={{ color: "var(--violet)" }}>
                        DEMO
                      </span>
                    )}
                  </div>
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    {[
                      s.git_branch,
                      `started ${clock(s.started_at).slice(0, 5)}`,
                      `${s.event_count} events`,
                      active(s) ? "active" : ago(s.last_event_at, now),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </span>
              </button>
              {current && s.id !== current.id && (
                <button
                  className="btn sm ghost add"
                  aria-pressed={onMap.has(s.id)}
                  aria-label={onMap.has(s.id) ? "Remove from this map" : "Add to this map"}
                  title={onMap.has(s.id) ? "Remove from this map" : "Add to this map"}
                  onClick={() => toggle(s.id)}
                >
                  {onMap.has(s.id) ? <Check size={14} /> : <Plus size={14} />}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MapView({
  sids,
  sessions,
  current,
  now,
  averages,
}: {
  sids: string[];
  sessions: SessionRow[];
  current: SessionRow | null;
  now: number;
  averages: Record<string, number>;
}) {
  const sid = sids[0] ?? null;
  const combined = sids.length > 1;
  const viewKey = sids.join(",");
  const data = useSessionsData(sids);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showTools, setShowToolsState] = useState(() => store.get(TOOLS_KEY, false, () => localStorage));
  const setShowTools = (v: boolean) => {
    setShowToolsState(v);
    store.set(TOOLS_KEY, v, () => localStorage);
  };
  const [pins, setPinsState] = useState<Record<string, string>>(() => store.get(PINS_KEY, {}, () => localStorage));
  const pin = (e: AgentEvent) => {
    const next = { ...pins };
    if (next[e.session_id] === e.source_uuid) delete next[e.session_id];
    else next[e.session_id] = e.source_uuid;
    setPinsState(next);
    store.set(PINS_KEY, next, () => localStorage);
  };
  const [selected, setSelected] = useState<string | null>(null);
  const [replayAt, setReplayAt] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const flow = useReactFlow();
  const canvasRef = useRef<HTMLDivElement>(null);

  const events = useMemo(
    () => sids.flatMap((s) => data[s]?.events ?? []).sort((a, b) => a.created_at - b.created_at),
    [sids, data],
  );
  // The side panel also lists older prompts that are not among the loaded events.
  const panelEvents = useMemo(() => {
    const byId = new Map(events.map((e) => [e.source_uuid, e]));
    for (const s of sids)
      for (const e of data[s]?.prompts ?? []) if (!byId.has(e.source_uuid)) byId.set(e.source_uuid, e);
    return [...byId.values()].sort((a, b) => a.created_at - b.created_at);
  }, [events, sids, data]);
  const loaded = sids.length > 0 && sids.every((s) => data[s]?.loaded);
  const first = events[0]?.created_at ?? null;
  const last = events.at(-1)?.created_at ?? null;

  const rows = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const model = useMemo(() => {
    const opts = { asOf: replayAt ?? undefined, subagentAverages: averages, showTools };
    const forSession = (s: string) => ({ allPrompts: data[s]?.prompts, mainPromptId: pins[s] });
    if (!combined) {
      const d = sid ? data[sid] : undefined;
      return buildTree(d?.events ?? [], d?.todos ?? [], now, { ...opts, ...(sid ? forSession(sid) : {}), expanded });
    }
    const names = sids.map((s) => folderName(rows.get(s)?.project_path ?? null));
    const parts = sids.map((s, i) => {
      const row = rows.get(s);
      const dup = names.filter((n) => n === names[i]).length > 1;
      const prefix = s + SESSION_SEP;
      const mine = new Set([...expanded].filter((x) => x.startsWith(prefix)).map((x) => x.slice(prefix.length)));
      return {
        sessionId: s,
        label: dup && row ? `${names[i]} · ${clock(row.started_at).slice(0, 5)}` : names[i],
        model: buildTree(data[s]?.events ?? [], data[s]?.todos ?? [], now, {
          ...opts,
          ...forSession(s),
          expanded: mine,
        }),
      };
    });
    const title = new Set(names).size === 1 ? names[0] : `${new Set(names).size} projects`;
    return combineModels(parts, { title, now: replayAt ?? now });
  }, [combined, sid, sids, data, rows, now, replayAt, expanded, averages, showTools, pins]);

  // Replay playback.
  useEffect(() => {
    if (!playing || last == null) return;
    const id = setInterval(() => {
      setReplayAt((t) => {
        const next = (t ?? first ?? 0) + 200 * speed;
        if (next >= last) {
          setPlaying(false);
          return last;
        }
        return next;
      });
    }, 200);
    return () => clearInterval(id);
  }, [playing, speed, first, last]);

  const layoutKey = model.cards.map((c) => c.id).join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const positions = useMemo(() => layoutCards(model.cards), [layoutKey]);
  const collapse = useCallback((foldId: string) => setExpanded((s) => new Set([...s].filter((x) => x !== foldId))), []);
  const nodes: CardNode[] = model.cards.map((c) => ({
    id: c.id,
    type: "card",
    position: positions.get(c.id) ?? { x: 0, y: 0 },
    data: { card: c, now: model.now, selected: c.id === selected, onCollapse: collapse },
    draggable: false,
    selectable: false,
  }));
  const edges: LiveEdge[] = model.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: "live",
    data: { running: e.running },
  }));

  // Card sizes are fixed, so fitting is computed from the layout instead of waiting for DOM measurement.
  const cardsRef = useRef(model.cards);
  cardsRef.current = model.cards;
  const fit = useCallback(
    (ids: string[] | null, maxZoom: number, padding: number, duration: number): boolean => {
      const el = canvasRef.current;
      const sel = cardsRef.current.filter((c) => !ids || ids.includes(c.id));
      if (!el || !el.clientWidth || !el.clientHeight || !sel.length) return false;
      const boxes = sel.map((c) => ({ ...(positions.get(c.id) ?? { x: 0, y: 0 }), h: CARD_H[c.kind] }));
      const x = Math.min(...boxes.map((b) => b.x));
      const y = Math.min(...boxes.map((b) => b.y));
      const width = Math.max(...boxes.map((b) => b.x + CARD_W)) - x;
      const height = Math.max(...boxes.map((b) => b.y + b.h)) - y;
      flow.setViewport(
        getViewportForBounds({ x, y, width, height }, el.clientWidth, el.clientHeight, 0.08, maxZoom, padding),
        { duration },
      );
      return true;
    },
    [flow, positions],
  );

  // The view never moves on its own: once React Flow is ready and the sessions have loaded, it is centered once
  // (or restored to where the user left it); after that only the user pans and zooms, and "Center" resets it.
  const [ready, setReady] = useState(false);
  const placed = useRef(false);
  const hasCards = loaded && events.length > 0 && model.cards.length > 0;
  useEffect(() => {
    if (placed.current || !hasCards || !ready) return;
    const saved = viewKey ? viewports.get(viewKey) : undefined;
    if (saved) {
      flow.setViewport(saved);
      placed.current = true;
    } else placed.current = fit(null, 1, 0.12, 0);
  }, [hasCards, ready, viewKey, flow, fit]);
  const center = () => fit(null, 1.2, 0.12, 400);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSelected(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const selectedCard = model.cards.find((c) => c.id === selected) ?? null;
  const p = model.session.progress;
  const replaying = replayAt != null;
  const pos = replayAt ?? last ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="map-head">
        <SessionPicker sessions={sessions} current={current} sids={sids} now={now} />
        <div className="stats">
          {model.session.model && <span className="pill mono">{model.session.model}</span>}
          <span>{tokens(model.session.tokens)} tokens</span>
          <span className="dim">·</span>
          <span>{model.session.events} events</span>
          {model.session.startedAt && (
            <>
              <span className="dim">·</span>
              <span>started {clock(model.session.startedAt)}</span>
            </>
          )}
        </div>
        <div className="right">
          <div className="session-progress">
            <div className="label">
              <span className="kicker">{combined ? "Sessions" : "Session"}</span>
              <span style={p.warn ? { color: "var(--amber)" } : undefined}>
                {p.label}{" "}
                {p.etaMs != null && (
                  <span className="dim" style={{ fontSize: 9, letterSpacing: "0.08em" }}>
                    EST.
                  </span>
                )}
              </span>
            </div>
            <div className={`bar ${p.value == null ? "indeterminate" : ""} ${p.warn ? "warn" : ""}`}>
              <i style={{ width: `${Math.round((p.value ?? 0.35) * 100)}%` }} />
            </div>
          </div>
          <button className="btn sm" onClick={center} title="Center the whole map in view">
            <LocateFixed size={13} /> Center
          </button>
          <button
            className="btn sm ghost"
            aria-pressed={showTools}
            onClick={() => setShowTools(!showTools)}
            title={
              showTools
                ? "Group each agent's tools into one card again"
                : "Show every tool card (each agent's tools are grouped into one card)"
            }
            style={showTools ? { color: "var(--blue)" } : undefined}
          >
            <Wrench size={13} /> {showTools ? "All tools shown" : "Show all tools"}
          </button>
          {expanded.size > 0 && (
            <button className="btn sm ghost" onClick={() => setExpanded(new Set())} title="Fold everything you opened">
              <ChevronsDownUp size={13} /> Collapse all
            </button>
          )}
          {sid && !combined && (
            <button
              className="btn sm ghost"
              onClick={() => navigate("explain", { session: sid })}
              title="Explain what happened in this session"
            >
              <BookOpen size={13} /> Explain
            </button>
          )}
          {isApp && (
            <button className="btn sm ghost" onClick={loadDemo} title="Play the demo session">
              <PlayCircle size={14} /> Demo
            </button>
          )}
        </div>
      </div>
      <div className="running-bar" aria-live="polite">
        <span className="lbl">
          <Activity size={13} /> RUNNING NOW
        </span>
        {model.running.length ? (
          <>
            <span>{model.running.length} running in parallel:</span>
            {model.running.map((r, i) => (
              <button
                key={r.cardId + i}
                className={`chip ${r.kind === "tool" ? "" : "violet"}`}
                onClick={() => setSelected(r.cardId)}
              >
                <span className="spin" />
                <span className="t">{r.label}</span>
                <em>{elapsed(r.startedAt, model.now)}</em>
              </button>
            ))}
          </>
        ) : (
          <span>
            Nothing running ·{" "}
            {model.mainState === "Idle" ? "idle" : combined ? "waiting for you" : "main agent waiting for you"}
          </span>
        )}
      </div>
      <div className="canvas" ref={canvasRef}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={(_e, n) => {
            const card = model.cards.find((c) => c.id === n.id);
            if (card?.kind === "fold") setExpanded((s) => new Set([...s, card.id]));
            setSelected(n.id);
          }}
          onPaneClick={() => setSelected(null)}
          onInit={() => setReady(true)}
          onMoveEnd={(_e, v) => viewKey && placed.current && saveViewport(viewKey, v)}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          minZoom={0.05}
          maxZoom={1.6}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#1b2530" />
          <Controls showInteractive={false} position="bottom-left" />
        </ReactFlow>
        {first != null && last != null && (
          <div className="replay">
            <button
              className="btn ghost sm"
              onClick={() => {
                if (!playing && (replayAt == null || replayAt >= last)) setReplayAt(first);
                setPlaying(!playing);
              }}
              aria-label={playing ? "Pause replay" : "Play replay"}
            >
              {playing ? <Pause size={15} /> : <Play size={15} />}
            </button>
            <div className="speed" role="group" aria-label="Replay speed">
              {[1, 4, 16].map((s) => (
                <button key={s} aria-pressed={speed === s} onClick={() => setSpeed(s)}>
                  {s}x
                </button>
              ))}
            </div>
            <input
              type="range"
              min={first}
              max={last}
              step={100}
              value={pos}
              aria-label="Replay position"
              onChange={(e) => {
                setPlaying(false);
                setReplayAt(Number(e.target.value));
              }}
            />
            <span className="mono dim" style={{ fontSize: 11 }}>
              {clock(pos)} · {elapsed(first, pos)}
            </span>
            {replaying ? (
              <button
                className="live-badge replaying"
                onClick={() => {
                  setReplayAt(null);
                  setPlaying(false);
                }}
              >
                REPLAY · go live
              </button>
            ) : (
              <span className="live-badge">
                <Radio size={12} /> LIVE
              </span>
            )}
          </div>
        )}
        {selectedCard && (
          <SidePanel
            card={selectedCard}
            events={panelEvents}
            pins={pins}
            onPin={pin}
            now={model.now}
            onClose={() => setSelected(null)}
            onExpand={(id) => {
              setExpanded((s) => new Set([...s, id]));
              setSelected(null);
            }}
          />
        )}
      </div>
    </div>
  );
}
