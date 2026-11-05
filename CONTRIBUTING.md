# Contributing

Thanks for helping! A few rules keep AgentTrace private and reliable.

## Setup

```bash
git clone https://github.com/KacperDula/AgentHub && cd AgentHub
npm install
npm run dev        # builds the UI, then starts the Electron app
npm run dev:ui     # UI with hot reload at http://localhost:5173 (needs the app running for the API)
npm test           # Vitest: core, ui, desktop
npm run lint       # ESLint + Prettier
npm run typecheck
```

`AGENTTRACE_DEMO=1 npm run dev` starts the demo session on launch (handy for screenshots).

## Ground rules

- **No real logs in the repo.** Put your own transcripts in `fixtures/raw/` (git-ignored) and run `npm run anonymize`
  to create `fixtures/anon/`. Check the output before committing it. Never paste real log lines into issues.
- **`packages/core` stays pure**: no `node:*`, `react` or Electron imports (ESLint enforces it).
- **The server stays read-only.** Don't add non-GET routes; a test fails if you do. Anything that changes state goes
  through the app window's IPC.
- **Nothing leaves the machine by default.** New network features must be opt-in, shown to the user before sending,
  and described in `docs/PRIVACY.md`.

## The Claude Code log format is not an official API

The parser reads Claude Code's transcript files, whose format is undocumented and can change between versions. When it
does, add an anonymized fixture or a synthetic test line that reproduces the new shape before changing the parser.

## Releases

Push a tag like `v0.1.0`. `.github/workflows/release.yml` runs the tests, builds `.dmg`, `.exe`, `.AppImage` and `.deb`
on GitHub's runners and uploads them to a draft release. Signing switches on when the `MAC_CSC_*`, `APPLE_*` and
`WIN_CSC_*` secrets exist.
