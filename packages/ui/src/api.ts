import { useEffect, useRef, useState } from "react";
import type {
  AgentEvent,
  PromptReview,
  PromptStats,
  Session,
  Signal,
  TodoSnapshot,
  UsageProfile,
} from "@agenttrace/core";

export type SessionRow = Session & { plan_progress: number | null };
export interface Info {
  version: string;
  watching: string[];
  sessions: number;
  paused: boolean;
  remote: boolean;
  hostname: string;
}
export interface SuggestionRow {
  id: number;
  scope: string;
  session_id: string | null;
  severity: "high" | "medium" | "low";
  title: string;
  why: string;
  fix_kind: string;
  fix: string;
  vote: 1 | -1 | null;
  created_at: number;
}
export interface InsightsData {
  signals: Signal[];
  profile: UsageProfile;
  suggestions: SuggestionRow[];
  prompts: PromptReview[];
  promptStats: PromptStats;
}
export interface Explanation {
  text: string;
  created_at: number;
}

declare global {
  interface Window {
    agenttrace?: { invoke<T = any>(channel: string, ...args: unknown[]): Promise<T> };
  }
}

/** Present only inside the desktop window. The browser view is read-only and never gets it. */
export const bridge = typeof window !== "undefined" ? (window.agenttrace ?? null) : null;
export const isApp = !!bridge;

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "same-origin" });
  if (r.status === 401) {
    location.href = "/login";
    throw new Error("unauthorized");
  }
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json() as Promise<T>;
}

const enc = encodeURIComponent;
export const api = {
  info: () => get<Info>("/api/info"),
  sessions: () => get<SessionRow[]>("/api/sessions"),
  events: (sid: string) => get<AgentEvent[]>(`/api/sessions/${enc(sid)}/events`),
  todos: (sid: string) => get<TodoSnapshot[]>(`/api/sessions/${enc(sid)}/todos`),
  prompts: (sid: string) => get<AgentEvent[]>(`/api/sessions/${enc(sid)}/prompts`),
  explanation: (sid: string) => get<Explanation | null>(`/api/sessions/${enc(sid)}/explanation`),
  averages: () => get<Record<string, number>>("/api/averages"),
  insights: () => get<InsightsData>("/api/insights"),
};

// ---- one shared SSE stream ----
export interface Changes {
  sessions: Session[];
  events: AgentEvent[];
  todos: TodoSnapshot[];
  relinked: string[];
}
type Listener = (type: string, data: any) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;
let connected = false;

function ensureStream() {
  if (source) return;
  source = new EventSource("/api/stream");
  const emit = (t: string, d: unknown) => listeners.forEach((l) => l(t, d));
  for (const t of ["changes", "reset", "insights", "info", "explain"])
    source.addEventListener(t, (e) => emit(t, JSON.parse((e as MessageEvent).data)));
  source.onopen = () => {
    connected = true;
    emit("open", null);
  };
  source.onerror = () => {
    connected = false;
    emit("error", null);
    // A revoked browser gets 401 on reconnect: send it back to the login page.
    fetch("/api/info", { credentials: "same-origin" })
      .then((r) => r.status === 401 && (location.href = "/login"))
      .catch(() => {});
  };
}

export function useStream(fn: Listener) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const l: Listener = (t, d) => ref.current(t, d);
    listeners.add(l);
    ensureStream();
    return () => void listeners.delete(l);
  }, []);
}

export function useConnected() {
  const [ok, setOk] = useState(connected);
  useStream((t) => {
    if (t === "open") setOk(true);
    if (t === "error") setOk(false);
  });
  return ok;
}

export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** Loads a value and reloads it on the given stream events. */
export function useLoad<T>(load: () => Promise<T>, reloadOn: string[], deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useRef(load);
  run.current = load;
  const reload = () =>
    run
      .current()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(String(e.message ?? e)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void reload(), deps);
  useStream((t) => {
    if (reloadOn.includes(t)) reload();
  });
  return { data, error, reload, setData };
}

// ---- hash routing: #/map?session=…, #/sessions, #/explain?session=…, #/insights, #/notes, #/settings ----
export function useRoute() {
  const parse = () => {
    const [p, q] = location.hash.replace(/^#\/?/, "").split("?");
    return { page: p || "map", params: new URLSearchParams(q ?? "") };
  };
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function navigate(page: string, params: Record<string, string | null | undefined> = {}, replace = false) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const hash = `#/${page}${q.toString() ? "?" + q : ""}`;
  if (replace) history.replaceState(null, "", hash);
  else location.hash = hash;
  if (replace) window.dispatchEvent(new HashChangeEvent("hashchange"));
}
