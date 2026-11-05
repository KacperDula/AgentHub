import { api, navigate, useLoad, useNow, type SessionRow } from "../api";
import { ago, dateTime, elapsed, folderName } from "../format";

const GROUPS: { title: string; hint: string; test: (s: SessionRow, now: number) => boolean }[] = [
  { title: "Active", hint: "event in the last 2 minutes", test: (s, now) => now - s.last_event_at < 2 * 60_000 },
  { title: "Idle", hint: "last 30 minutes", test: (s, now) => now - s.last_event_at < 30 * 60_000 },
  { title: "Ended", hint: "older", test: () => true },
];

export function Sessions() {
  const now = useNow(10_000);
  const { data, error } = useLoad(api.sessions, ["changes", "reset"]);
  const sessions = [...(data ?? [])].sort((a, b) => b.last_event_at - a.last_event_at);
  const seen = new Set<string>();
  return (
    <div className="page-pad">
      <h2>Sessions</h2>
      <p className="lede">
        Every Claude Code session on this machine. Open one in the Live Map, then use the replay slider to scrub through
        it.
      </p>
      {error && <p className="sev-high">Could not load sessions: {error}</p>}
      {GROUPS.map((g) => {
        const rows = sessions.filter((s) => !seen.has(s.id) && g.test(s, now));
        rows.forEach((s) => seen.add(s.id));
        if (!rows.length) return null;
        return (
          <section key={g.title} className="panel" style={{ padding: "12px 8px" }}>
            <div className="row" style={{ padding: "0 10px 6px" }}>
              <span className="kicker" style={{ color: g.title === "Active" ? "var(--green)" : undefined }}>
                {g.title}
              </span>
              <span className="dim" style={{ fontSize: 12 }}>
                {g.hint} · {rows.length}
              </span>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="list" style={{ tableLayout: "fixed", minWidth: 640 }}>
                <colgroup>
                  <col style={{ width: "32%" }} />
                  <col style={{ width: "22%" }} />
                  <col style={{ width: "14%" }} />
                  <col style={{ width: "12%" }} />
                  <col style={{ width: "20%" }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Started</th>
                    <th>Duration</th>
                    <th>Events</th>
                    <th>Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => (
                    <tr
                      key={s.id}
                      onClick={() => navigate("map", { session: s.id })}
                      tabIndex={0}
                      onKeyDown={(e) => e.key === "Enter" && navigate("map", { session: s.id })}
                    >
                      <td>
                        <div style={{ fontWeight: 600 }}>
                          {folderName(s.project_path)}{" "}
                          {s.is_demo && (
                            <span className="badge" style={{ color: "var(--violet)" }}>
                              DEMO
                            </span>
                          )}
                        </div>
                        <div className="muted mono" style={{ fontSize: 11.5 }}>
                          {s.git_branch ?? "no branch"}
                        </div>
                      </td>
                      <td>
                        <div>{dateTime(s.started_at)}</div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {ago(s.started_at, now)}
                        </div>
                      </td>
                      <td>{elapsed(s.started_at, s.last_event_at)}</td>
                      <td>{s.event_count}</td>
                      <td>
                        {s.plan_progress == null ? (
                          <span className="dim">no plan</span>
                        ) : (
                          <div className="row" style={{ flexWrap: "nowrap" }}>
                            <div className="bar" style={{ flex: 1 }}>
                              <i style={{ width: `${Math.round(s.plan_progress * 100)}%` }} />
                            </div>
                            <span style={{ fontSize: 12, width: 36, textAlign: "right" }}>
                              {Math.round(s.plan_progress * 100)}%
                            </span>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
      {data && !data.length && <p className="muted">No sessions yet.</p>}
    </div>
  );
}
