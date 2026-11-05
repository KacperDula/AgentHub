// Shared types for events, sessions, cards and states. Timestamps are epoch milliseconds.

export type EventType =
  "user_prompt" | "assistant_text" | "thinking" | "tool_call" | "tool_result" | "subagent_spawn" | "other";

export type CallStatus = "running" | "done" | "error";

export interface AgentEvent {
  source_uuid: string;
  session_id: string;
  parent_uuid: string | null;
  /** 'main', the spawning tool_use_id, or 'agent:<agentId>' while unlinked. */
  agent_key: string;
  agent_name: string;
  agent_id: string | null;
  is_subagent: boolean;
  event_type: EventType;
  tool_name: string | null;
  tool_use_id: string | null;
  status: CallStatus | null;
  summary: string;
  payload: Record<string, any>;
  input_tokens: number | null;
  output_tokens: number | null;
  message_id: string | null;
  created_at: number;
  ended_at: number | null;
  duration_ms: number | null;
}

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export interface TodoSnapshot {
  source_uuid: string;
  session_id: string;
  agent_key: string;
  agent_name: string;
  agent_id: string | null;
  todos: Todo[];
  created_at: number;
}

export interface SubagentLink {
  session_id: string;
  agent_id: string;
  tool_use_id: string;
  name: string;
}

/** Moves every event and todo snapshot of `agent_id` to a newly linked key. */
export interface Relink {
  session_id: string;
  agent_id: string;
  agent_key: string;
  agent_name: string;
}

export interface SessionMeta {
  id: string;
  project_path: string | null;
  git_branch: string | null;
  model: string | null;
  started_at: number;
  last_event_at: number;
}

export interface Session extends SessionMeta {
  event_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  is_demo?: boolean;
}

export interface RawLine {
  file: string;
  line: unknown;
}

/** Read access to what earlier batches stored, so batches can be processed incrementally. */
export interface ParseContext {
  /** The tool_call or subagent_spawn event with this tool_use_id. */
  getCall(sessionId: string, toolUseId: string): AgentEvent | undefined;
  /** An unlinked subagent_spawn whose input.prompt matches (compared on the first 1000 chars). */
  findSpawnByPrompt(sessionId: string, promptHead: string): AgentEvent | undefined;
  getLink(sessionId: string, agentId: string): SubagentLink | undefined;
  runningCalls(sessionId: string): AgentEvent[];
  messageHasTokens(sessionId: string, messageId: string): boolean;
  /** A stored completion notice for this call ("notify:" row), when it arrived before the call itself. */
  getNotification(sessionId: string, toolUseId: string): AgentEvent | undefined;
}

export interface ParseResult {
  /** New rows, insert-or-ignore on source_uuid. */
  events: AgentEvent[];
  /** Full rows of already-stored calls whose status / ended_at / duration_ms / payload changed. */
  updates: AgentEvent[];
  todoSnapshots: TodoSnapshot[];
  subagentLinks: SubagentLink[];
  relinks: Relink[];
  sessionUpdates: SessionMeta[];
  skipped: number;
}

// ---- Live Map model ----

export type AgentState =
  | "Thinking"
  | "Running tool"
  | "Background work"
  | "Working"
  | "Starting"
  | "Waiting for you"
  | "Done"
  | "Error"
  | "Idle";

export type Look = "running" | "done" | "error" | "idle" | "waiting";

export type CardKind = "group" | "prompt" | "agent" | "subagent" | "tool" | "mcp" | "resource" | "fold";

export interface Progress {
  /** 0..1, or null for an indeterminate "estimating…" bar. */
  value: number | null;
  label: string;
  /** Remaining milliseconds when an ETA is known. */
  etaMs?: number;
  warn?: boolean;
}

export interface Card {
  id: string;
  kind: CardKind;
  parentId: string | null;
  /** Small uppercase type label: PROMPT, AGENT, SUBAGENT, BUILT-IN TOOL, MCP TOOL, FILES, … */
  label: string;
  title: string;
  subtitle?: string;
  look: Look;
  state?: AgentState;
  startedAt: number | null;
  endedAt: number | null;
  lines: string[];
  progress?: Progress;
  calls?: number;
  errors?: number;
  toolName?: string;
  server?: string;
  agentKey?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  eventCount?: number;
  plan?: Todo[];
  items?: string[];
  /** source_uuids of the events shown in the side panel. */
  eventIds: string[];
  /** fold chips: the folded card ids; expanded cards: the id of the chip that folds them again. */
  folded?: { id: string; title: string }[];
  foldId?: string;
  /** What a fold chip holds: finished subagents, or an agent's tool cards. */
  foldKind?: "subagents" | "tools";
  /** Combined map: the session this card belongs to. */
  sessionId?: string;
}

export interface Edge {
  id: string;
  source: string;
  target: string;
  running: boolean;
}

export interface RunningChip {
  cardId: string;
  kind: "subagent" | "tool" | "thinking";
  label: string;
  startedAt: number;
}

export interface LiveModel {
  cards: Card[];
  edges: Edge[];
  running: RunningChip[];
  mainState: AgentState;
  session: { progress: Progress; model: string | null; tokens: number; events: number; startedAt: number | null };
  now: number;
}

export interface TreeOptions {
  /** Replay: only what was known at this time, calls ending later still count as running. */
  asOf?: number;
  /** Fold chip ids the user expanded. */
  expanded?: ReadonlySet<string>;
  /** Show every tool card instead of one "tools" chip per agent. */
  showTools?: boolean;
  /** Every prompt of the session, for the prompt card (the events passed in may be only the latest ones). */
  allPrompts?: AgentEvent[];
  /** The prompt the user marked as the session's main one (source_uuid). */
  mainPromptId?: string;
  /** Average duration (ms) of earlier subagents, by name. */
  subagentAverages?: Record<string, number>;
  /** Fold finished subagents after this long (ms). */
  foldAfterMs?: number;
}
