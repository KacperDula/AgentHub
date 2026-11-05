import { useState } from "react";
import {
  Activity,
  BookOpen,
  History,
  Lightbulb,
  Monitor,
  NotebookPen,
  Plus,
  Settings as Cog,
  Trash2,
  Users,
} from "lucide-react";
import { api, isApp, useConnected, useLoad, useRoute } from "./api";
import { LiveMap } from "./pages/LiveMap";
import { Sessions } from "./pages/Sessions";
import { Explain } from "./pages/Explain";
import { Insights } from "./pages/Insights";
import { Notes } from "./pages/Notes";
import { Settings } from "./pages/Settings";

const PAGES: { id: string; title: string; icon: typeof Activity; soon?: boolean }[] = [
  { id: "map", title: "Live Map", icon: Activity },
  { id: "team", title: "Team Live Map", icon: Users, soon: true },
  { id: "sessions", title: "Sessions", icon: History },
  { id: "explain", title: "Explain", icon: BookOpen },
  { id: "insights", title: "Insights", icon: Lightbulb },
  { id: "notes", title: "Notes", icon: NotebookPen },
  { id: "settings", title: "Settings", icon: Cog },
];

function TeamSoon() {
  return (
    <div className="empty">
      <div style={{ maxWidth: 520 }}>
        <Users size={34} color="var(--violet)" />
        <h2>
          Team Live Map <span className="badge soon">COMING SOON</span>
        </h2>
        <p className="muted" style={{ margin: "0 auto 14px" }}>
          One live map for a whole team: every teammate's and every machine's Claude Code agents, orchestrators and
          subagents working on the same project, side by side.
        </p>
        <p className="dim" style={{ fontSize: 13, margin: 0 }}>
          Today you can already put several CLI sessions of this machine on one map: open the Live Map, click the
          session picker and press + next to the sessions you want, or “Add … other sessions”.
        </p>
      </div>
    </div>
  );
}

export function App() {
  const route = useRoute();
  const page = PAGES.find((p) => p.id === route.page) ?? PAGES[0];
  const connected = useConnected();
  const { data: info } = useLoad(api.info, ["info", "reset", "open"]);
  const { data: sessions } = useLoad(api.sessions, ["reset"]);
  const watching =
    info?.watching[0]?.replace(/^\/(Users|home)\/[^/]+/, "~").replace(/^[A-Z]:\\Users\\[^\\]+/i, "~") ??
    "~/.claude/projects";

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="logo">
          <img src="/favicon.svg" width={22} height={22} alt="" />
          <span>
            AgentTrace <b>Desktop</b>
          </span>
        </div>
        {PAGES.map((p) => (
          <a
            key={p.id}
            href={`#/${p.id}`}
            className={`nav ${p.id === page.id ? "active" : ""}`}
            aria-current={p.id === page.id ? "page" : undefined}
          >
            <p.icon size={16} /> {p.title}
            {p.soon && <span className="badge soon">SOON</span>}
          </a>
        ))}
        <div className="spacer" />
        <Machines hostname={info?.hostname} />
        <div className="sidebar-foot">
          <span className="row" style={{ gap: 8 }}>
            <span className={`status-dot ${connected ? "on" : ""}`} />{" "}
            {connected ? "Live updates connected" : "Reconnecting…"}
          </span>
          {!isApp && <span className="dim">Read-only browser view</span>}
        </div>
      </nav>
      <main className="main">
        <header className="topbar">
          <h1>{page.title}</h1>
          {info &&
            (info.paused ? (
              <span className="pill">
                <span className="status-dot" /> Paused · {watching}
              </span>
            ) : (
              <span className="pill green" title={info.watching.join("\n")}>
                <span className="status-dot on" /> Watching {watching} · {sessions?.length ?? info.sessions} sessions
              </span>
            ))}
        </header>
        <div className="page">
          {page.id === "map" && (
            <LiveMap sessionParam={route.params.get("session")} withParam={route.params.get("with")} />
          )}
          {page.id === "team" && <TeamSoon />}
          {page.id === "sessions" && <Sessions />}
          {page.id === "explain" && <Explain sessionParam={route.params.get("session")} />}
          {page.id === "insights" && <Insights />}
          {page.id === "notes" && <Notes />}
          {page.id === "settings" && <Settings />}
        </div>
      </main>
    </div>
  );
}

interface Machine {
  name: string;
  url: string;
}
const KEY = "agenttrace.machines";
const loadMachines = (): Machine[] => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
};

/** Other machines running AgentTrace. Picking one opens its own URL (its own login), so nothing is fetched across machines. */
function Machines({ hostname }: { hostname?: string }) {
  const [list, setList] = useState(loadMachines);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const save = (l: Machine[]) => {
    setList(l);
    try {
      localStorage.setItem(KEY, JSON.stringify(l));
    } catch {
      /* storage blocked: keep in memory */
    }
  };
  const valid = /^https?:\/\/[^\s/]+/.test(url.trim());
  return (
    <div className="sidebar-foot" style={{ gap: 4, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
      <span className="kicker">Machines</span>
      <span className="row" style={{ gap: 8, color: "var(--text)" }}>
        <Monitor size={14} color="var(--teal)" /> {hostname ?? "This machine"}
      </span>
      {list.map((m, i) => (
        <span key={m.url} className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
          <a
            href={m.url}
            style={{
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--muted)",
            }}
            title={m.url}
          >
            <Monitor size={13} style={{ verticalAlign: -2 }} /> {m.name}
          </a>
          <button
            className="btn ghost sm"
            style={{ padding: 2 }}
            aria-label={`Remove ${m.name}`}
            onClick={() => save(list.filter((_, j) => j !== i))}
          >
            <Trash2 size={12} />
          </button>
        </span>
      ))}
      {adding ? (
        <form
          style={{ display: "grid", gap: 5 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            save([...list, { name: name.trim() || url.trim(), url: url.trim().replace(/\/+$/, "") }]);
            setAdding(false);
            setName("");
            setUrl("");
          }}
        >
          <input
            className="input"
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Machine name"
          />
          <input
            className="input"
            placeholder="http://office-pc:8787"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-label="Machine URL"
          />
          <span className="row" style={{ gap: 6 }}>
            <button className="btn sm primary" disabled={!valid}>
              Add
            </button>
            <button type="button" className="btn sm ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </span>
        </form>
      ) : (
        <button
          className="btn ghost sm"
          style={{ justifyContent: "flex-start", padding: "3px 0" }}
          onClick={() => setAdding(true)}
        >
          <Plus size={13} /> Add machine
        </button>
      )}
    </div>
  );
}
