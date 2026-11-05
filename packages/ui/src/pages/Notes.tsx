import { useCallback, useEffect, useState } from "react";
import { Brain, FolderOpen, NotebookPen, Plus, RefreshCw, UserRound } from "lucide-react";
import { bridge, isApp } from "../api";
import { useAi, PROVIDER_NAME, type AiAction } from "../ai";
import { ago, dateTime } from "../format";
import { Markdown } from "../components/Markdown";

interface NoteFile {
  name: string;
  kind: "goal" | "preference" | "lesson" | "context" | "saved" | "file";
  size: number;
  modified: number;
  preview: string;
}
interface NotesState {
  root: string;
  customRoot: boolean;
  user: string;
  dir: string;
  users: string[];
  inAi: boolean;
  notes: NoteFile[];
  learnings: { text: string; modified: number } | null;
}

const KINDS: { id: Exclude<NoteFile["kind"], "saved" | "file">; label: string; hint: string }[] = [
  {
    id: "goal",
    label: "Goal",
    hint: "What are you building or trying to get better at? e.g. “Ship the checkout redesign this month; learn to use subagents for reviews.”",
  },
  {
    id: "preference",
    label: "How I like to work",
    hint: "e.g. “Always show me a plan before editing. Keep changes small. Explain in Greek, code comments in English.”",
  },
  {
    id: "lesson",
    label: "Lesson",
    hint: "Something that went wrong or worked well. e.g. “When I say ‘fix it’ without the error message, Claude guesses wrong.”",
  },
  {
    id: "context",
    label: "Project context",
    hint: "Facts about your projects the coach should know. e.g. “AgentHub is an Electron app; core must stay pure TypeScript.”",
  },
];
const KIND_COLOR: Record<NoteFile["kind"], string> = {
  goal: "var(--teal)",
  preference: "var(--sky)",
  lesson: "var(--amber)",
  context: "var(--violet)",
  saved: "var(--pink)",
  file: "var(--muted)",
};
const KIND_NAME: Record<NoteFile["kind"], string> = {
  goal: "GOAL",
  preference: "HOW I WORK",
  lesson: "LESSON",
  context: "CONTEXT",
  saved: "SAVED SUGGESTION",
  file: "FILE",
};

export function Notes() {
  if (!isApp)
    return (
      <div className="page-pad">
        <h2>Notes</h2>
        <p className="callout" style={{ maxWidth: 640 }}>
          Notes are private: they live in a folder on the machine running AgentTrace and are only shown in the app
          there, never in a browser.
        </p>
      </div>
    );
  return <NotesApp />;
}

function NotesApp() {
  const [s, setS] = useState<NotesState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [kind, setKind] = useState<(typeof KINDS)[number]["id"]>("goal");
  const [text, setText] = useState("");
  const [newUser, setNewUser] = useState<string | null>(null);
  const { ai, busy, msg, request, show, modal } = useAi();

  const call = useCallback(async (channel: string, ...args: unknown[]) => {
    try {
      setS(await bridge!.invoke<NotesState>(channel, ...args));
      setErr(null);
      return true;
    } catch (e) {
      setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
      return false;
    }
  }, []);
  const reload = useCallback(() => void call("notes:get"), [call]);

  // Files can be added straight into the folder: refresh when the window gets focus again.
  useEffect(() => {
    reload();
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);

  const learn: AiAction = {
    kind: "learn",
    go: () => bridge!.invoke("ai:learn"),
    done: () => {
      reload();
      return "Your learnings file is updated.";
    },
  };

  if (!s)
    return (
      <div className="page-pad">
        <h2>Notes</h2>
        {err && <p className="callout sev-high">{err}</p>}
      </div>
    );
  const current = KINDS.find((k) => k.id === kind)!;

  return (
    <div className="page-pad">
      <h2>Notes</h2>
      <p className="lede">
        Your own notes folder that AgentTrace learns from. Write down your goals, how you like to work and lessons
        learned, here or as <span className="mono">.md</span> / <span className="mono">.txt</span> files in the folder.
        Every person has a separate folder. The AI reads them only when you run an analysis (you see them in the preview
        first), uses them in Insights and Explain, and keeps a learnings file about you.
      </p>
      {err && (
        <p className="callout sev-high" role="alert">
          {err}
        </p>
      )}

      <section className="panel">
        <h3>
          <UserRound size={15} style={{ verticalAlign: -2 }} /> Whose notes
        </h3>
        <p className="sub">Switching user switches the folder, the notes and the learnings the AI uses.</p>
        <div className="field">
          <label>User</label>
          {newUser == null ? (
            <span className="row">
              <select
                className="input"
                style={{ width: 240 }}
                value={s.user}
                onChange={(e) => call("notes:user", e.target.value)}
                aria-label="User"
              >
                {s.users.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
              <button className="btn sm" onClick={() => setNewUser("")}>
                <Plus size={13} /> New user
              </button>
            </span>
          ) : (
            <form
              className="row"
              onSubmit={async (e) => {
                e.preventDefault();
                if (newUser.trim() && (await call("notes:user", newUser.trim()))) setNewUser(null);
              }}
            >
              <input
                className="input"
                style={{ width: 240 }}
                autoFocus
                placeholder="Name"
                value={newUser}
                maxLength={40}
                onChange={(e) => setNewUser(e.target.value)}
                aria-label="New user name"
              />
              <button className="btn sm primary" disabled={!newUser.trim()}>
                Create
              </button>
              <button type="button" className="btn sm ghost" onClick={() => setNewUser(null)}>
                Cancel
              </button>
            </form>
          )}
        </div>
        <div className="field">
          <label>
            Folder<span className="hint">one sub-folder per user inside it</span>
          </label>
          <span className="row">
            <span className="mono muted" style={{ fontSize: 12.5, wordBreak: "break-all" }}>
              {s.dir}
            </span>
            <button
              className="btn sm"
              onClick={() => bridge!.invoke("notes:open").catch((e: Error) => setErr(e.message))}
            >
              <FolderOpen size={13} /> Open folder
            </button>
            <button className="btn sm ghost" onClick={() => call("notes:pickRoot")}>
              Change…
            </button>
            {s.customRoot && (
              <button className="btn sm ghost" onClick={() => call("notes:resetRoot")}>
                Use default
              </button>
            )}
          </span>
        </div>
        <div className="field">
          <label>
            Use my notes in AI analyses
            <span className="hint">Insights coach and Explain; always shown in “What will be sent”</span>
          </label>
          <button
            className="toggle"
            role="switch"
            aria-checked={s.inAi}
            aria-label="Use my notes in AI analyses"
            onClick={() => call("notes:inAi", !s.inAi)}
          />
        </div>
      </section>

      <section className="panel">
        <h3>
          <NotebookPen size={15} style={{ verticalAlign: -2 }} /> Add a note
        </h3>
        <div className="seg" role="tablist" aria-label="Kind of note" style={{ margin: "8px 0 10px" }}>
          {KINDS.map((k) => (
            <button key={k.id} role="tab" aria-selected={kind === k.id} onClick={() => setKind(k.id)}>
              {k.label}
            </button>
          ))}
        </div>
        <textarea
          className="input"
          rows={4}
          placeholder={current.hint}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Note"
          style={{ resize: "vertical", minHeight: 90 }}
        />
        <div className="row" style={{ marginTop: 10 }}>
          <button
            className="btn primary"
            disabled={!text.trim()}
            onClick={async () => {
              if (await call("notes:add", kind, text)) setText("");
            }}
          >
            Save note
          </button>
          <span className="dim" style={{ fontSize: 12 }}>
            Saved as its own Markdown file in your folder. Edit or delete it there any time.
          </span>
        </div>
      </section>

      <section className="panel">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h3>
              <Brain size={15} style={{ verticalAlign: -2 }} color="var(--violet)" /> What the AI learned about you
            </h3>
            <p className="sub" style={{ margin: 0 }}>
              Built from your notes, your prompt statistics and the suggestions you rated, with{" "}
              {ai ? PROVIDER_NAME[ai.config.kind] : "…"}. Saved as <span className="mono">_learnings.md</span> in your
              folder; the previous version is kept next to it.
            </p>
          </div>
          <div className="row">
            <button className="btn primary" disabled={!!busy} onClick={() => request(learn)}>
              {busy === "learn" ? <span className="spin" /> : <Brain size={14} />}
              {s.learnings ? "Update my learnings" : "Learn from my notes"}
            </button>
            <button className="btn ghost sm" onClick={() => show(learn)}>
              What will be sent?
            </button>
          </div>
        </div>
        {msg && (
          <p className="callout" style={{ marginTop: 12, marginBottom: 0 }} role="status">
            {msg}
          </p>
        )}
        {s.learnings ? (
          <div className="explanation">
            <div className="dim" style={{ fontSize: 11.5, marginBottom: 6 }}>
              Updated {dateTime(s.learnings.modified)}
            </div>
            <Markdown text={s.learnings.text} />
          </div>
        ) : (
          <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
            Nothing learned yet. Add a few notes (or just keep using Claude Code), then press <b>Learn from my notes</b>
            .
          </p>
        )}
      </section>

      <div className="row" style={{ justifyContent: "space-between", margin: "6px 0 10px" }}>
        <span className="kicker">Your notes ({s.notes.length})</span>
        <button className="btn ghost sm" onClick={reload}>
          <RefreshCw size={13} /> Refresh
        </button>
      </div>
      {!s.notes.length && (
        <p className="muted">
          No notes yet. Add one above, or drop <span className="mono">.md</span> / <span className="mono">.txt</span>{" "}
          files into the folder.
        </p>
      )}
      <div className="grid2">
        {s.notes.map((n) => (
          <section key={n.name} className="panel" style={{ marginBottom: 0 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="badge" style={{ color: KIND_COLOR[n.kind] }}>
                {KIND_NAME[n.kind]}
              </span>
              <span className="dim" style={{ fontSize: 11.5 }} title={dateTime(n.modified)}>
                {ago(n.modified)}
              </span>
            </div>
            <p style={{ fontSize: 13, margin: "8px 0 6px", wordBreak: "break-word" }}>{n.preview || "(empty)"}</p>
            <div className="mono dim" style={{ fontSize: 11 }}>
              {n.name}
            </div>
          </section>
        ))}
      </div>
      {modal}
    </div>
  );
}
