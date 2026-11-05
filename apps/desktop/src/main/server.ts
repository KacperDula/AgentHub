import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { Store } from "./db";

export interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  params: string[];
  url: URL;
}
export interface Route {
  method: "GET" | "POST";
  path: string | RegExp;
  handler: (c: Ctx) => void | Promise<void>;
}

export interface Auth {
  /** Remote viewing on: every request except the login page needs a session cookie. */
  required: () => boolean;
  token: () => string | null;
  sessions: Set<string>; // sha256 of cookie values
  persist: () => void;
}

export interface ServerDeps {
  store: Store;
  uiDir: string;
  auth: Auth;
  info: () => Record<string, unknown>;
  insights: () => unknown;
  log?: (msg: string) => void;
}

const COOKIE = "at_session";
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

function cookieOf(req: http.IncomingMessage): string | null {
  const m = /(?:^|;\s*)at_session=([^;]+)/.exec(req.headers.cookie ?? "");
  return m ? m[1] : null;
}

const LOGIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentTrace · Sign in</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080b10;color:#e6edf3;font:15px/1.5 Inter,system-ui,sans-serif}
form{background:#121921;border:1px solid #1f2935;border-radius:16px;padding:28px;width:min(360px,calc(100vw - 32px));box-sizing:border-box}
h1{font-size:18px;margin:0 0 4px}p{color:#9aa7b6;margin:0 0 18px;font-size:13px}
input{width:100%;box-sizing:border-box;background:#0b1016;border:1px solid #1f2935;border-radius:10px;color:#e6edf3;padding:10px 12px;font:13px ui-monospace,monospace}
button{margin-top:12px;width:100%;background:#2dd4bf;color:#04201c;border:0;border-radius:10px;padding:10px;font-weight:600;cursor:pointer}
#err{color:#fb7185;font-size:13px;min-height:20px;margin-top:8px}</style></head><body>
<form id="f"><h1>AgentTrace</h1><p>Paste the access token from Settings → Remote viewing on the machine you want to watch, or scan its QR code.</p>
<input id="t" autocomplete="off" placeholder="Access token" aria-label="Access token"><button>Open</button><div id="err" role="alert"></div></form>
<script>
const go=async t=>{const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t})});
if(r.ok){history.replaceState(null,'','/');location.replace('/');}else{document.getElementById('err').textContent=r.status===429?'Too many attempts, wait a few minutes.':'That token is not valid (it may have been revoked).';}};
const h=new URLSearchParams(location.hash.slice(1)).get('token');if(h){history.replaceState(null,'','/login');go(h);}
document.getElementById('f').onsubmit=e=>{e.preventDefault();go(document.getElementById('t').value.trim());};
</script></body></html>`;

/**
 * The local HTTP server: the built UI, a read-only JSON API and an SSE stream. No endpoint writes data or runs
 * a command; the only non-GET route is POST /login, which exchanges the access token for a session cookie.
 */
export function createServer(deps: ServerDeps) {
  const { store, auth } = deps;
  const clients = new Set<http.ServerResponse>();
  const failures = new Map<string, number[]>();

  const routes: Route[] = [
    { method: "GET", path: "/api/info", handler: ({ res }) => json(res, 200, deps.info()) },
    { method: "GET", path: "/api/sessions", handler: ({ res }) => json(res, 200, store.sessions()) },
    {
      method: "GET",
      path: /^\/api\/sessions\/([^/]+)\/events$/,
      handler: ({ res, params, url }) => {
        const limit = Math.min(Number(url.searchParams.get("limit")) || 5000, 20000);
        json(res, 200, store.events(params[0], limit));
      },
    },
    {
      method: "GET",
      path: /^\/api\/sessions\/([^/]+)\/todos$/,
      handler: ({ res, params }) => json(res, 200, store.todos(params[0])),
    },
    {
      method: "GET",
      path: /^\/api\/sessions\/([^/]+)\/prompts$/,
      handler: ({ res, params }) => json(res, 200, store.prompts(params[0])),
    },
    {
      method: "GET",
      path: /^\/api\/sessions\/([^/]+)\/explanation$/,
      handler: ({ res, params }) => json(res, 200, store.explanation(params[0])),
    },
    { method: "GET", path: "/api/averages", handler: ({ res }) => json(res, 200, store.subagentAverages(Date.now())) },
    { method: "GET", path: "/api/insights", handler: ({ res }) => json(res, 200, deps.insights()) },
    {
      method: "GET",
      path: "/api/stream",
      handler: ({ req, res }) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        res.write("retry: 2000\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
      },
    },
    {
      method: "GET",
      path: "/login",
      handler: ({ res }) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(LOGIN_PAGE);
      },
    },
    {
      method: "POST",
      path: "/login",
      handler: async ({ req, res }) => {
        const ip = req.socket.remoteAddress ?? "?";
        const now = Date.now();
        const recent = (failures.get(ip) ?? []).filter((t) => now - t < 10 * 60_000);
        if (recent.length >= 10) return json(res, 429, { error: "too many attempts" });
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 4096) return json(res, 413, { error: "too large" });
        }
        let token = "";
        try {
          token = String(JSON.parse(body).token ?? "");
        } catch {
          /* empty */
        }
        const expected = auth.token();
        const ok =
          !!expected &&
          token.length > 0 &&
          crypto.timingSafeEqual(Buffer.from(sha(token), "hex"), Buffer.from(sha(expected), "hex"));
        if (!ok) {
          failures.set(ip, [...recent, now]);
          return json(res, 401, { error: "invalid token" });
        }
        failures.delete(ip);
        const value = crypto.randomBytes(32).toString("base64url");
        auth.sessions.add(sha(value));
        auth.persist();
        res.setHeader(
          "Set-Cookie",
          `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 30}`,
        );
        json(res, 200, { ok: true });
      },
    },
  ];

  const isLocalHost = (host: string | undefined) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host ?? "");
  const authorized = (req: http.IncomingMessage) => {
    if (!auth.required()) return isLocalHost(req.headers.host); // DNS-rebinding guard while local-only
    const c = cookieOf(req);
    return !!c && auth.sessions.has(sha(c));
  };

  function serveStatic(url: URL, res: http.ServerResponse) {
    const root = path.resolve(deps.uiDir);
    let file = path.resolve(root, "." + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory())
      file = path.join(root, "index.html");
    if (!fs.existsSync(file)) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      return res.end("UI not built. Run `npm run build -w @agenttrace/ui`.");
    }
    const immutable = file.includes(`${path.sep}assets${path.sep}`);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
    fs.createReadStream(file).pipe(res);
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'",
    );
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const isLogin = url.pathname === "/login";
    for (const r of routes) {
      if (r.method !== method) continue;
      const m =
        typeof r.path === "string" ? (r.path === url.pathname ? [] : null) : r.path.exec(url.pathname)?.slice(1);
      if (!m) continue;
      if (!isLogin && !authorized(req)) return json(res, 401, { error: "unauthorized" });
      return r.handler({ req, res, params: m.map(decodeURIComponent), url });
    }
    if (method !== "GET" && method !== "HEAD") return json(res, 405, { error: "read-only" });
    if (url.pathname.startsWith("/api/")) return json(res, authorized(req) ? 404 : 401, { error: "not found" });
    if (!authorized(req)) {
      if (!auth.required()) return json(res, 403, { error: "forbidden host" });
      res.writeHead(302, { Location: "/login" }); // the browser keeps a #token=… fragment across the redirect
      return res.end();
    }
    serveStatic(url, res);
  }

  const onRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
    handle(req, res).catch((e) => {
      deps.log?.(`request failed: ${(e as Error).stack}`);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
      else res.end();
    });
  };
  let servers: http.Server[] = [];

  const ping = setInterval(() => {
    for (const c of clients) c.write(": ping\n\n");
  }, 20_000);

  return {
    routes,
    handle: onRequest,
    /** Listens on each host (e.g. 127.0.0.1 plus a chosen interface). Resolves with the port. */
    async listen(hosts: string[], port: number): Promise<number> {
      for (const host of hosts) {
        const server = http.createServer(onRequest);
        server.keepAliveTimeout = 65_000;
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, host, () => {
            server.off("error", reject);
            resolve();
          });
        }).catch(async (e) => {
          await this.close();
          throw e;
        });
        servers.push(server);
      }
      return port;
    },
    async close(): Promise<void> {
      for (const c of clients) c.end();
      clients.clear();
      await Promise.all(
        servers.map(
          (s) =>
            new Promise<void>((r) => {
              s.close(() => r());
              s.closeAllConnections();
            }),
        ),
      );
      servers = [];
    },
    stop() {
      clearInterval(ping);
    },
    broadcast(type: string, data: unknown) {
      const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const c of clients) c.write(msg);
    },
    /** Drops every open stream (after "Revoke all browsers"); clients reconnect and must log in again. */
    kickAll() {
      for (const c of clients) c.end();
      clients.clear();
      for (const s of servers) s.closeAllConnections();
    },
  };
}

export type AppServer = ReturnType<typeof createServer>;
