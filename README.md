# AgentTrace Desktop

**See live what your Claude Code agents are doing.** An open source, local-first app for Windows, macOS and Linux that
turns Claude Code's own logs into a live map: your prompt, the main agent, its subagents, the tools they call and the
files they touch, with what is running in parallel, progress and an ETA. Your data never leaves your machine.

![The Live Map while two subagents run in parallel](docs/screenshot.png)

> The name "AgentTrace Desktop" is provisional.

## Why I built this

Hi, I'm **Kacper Dula**, a backend-focused developer from Athens, Greece. I build scalable systems and real-world web
applications.

I made AgentTrace for myself. A big part of my work now happens with Claude Code, and often not with one agent but with
a whole setup: an orchestrator, several regular agents and many subagents working on the same project at the same time.
Watching that in a few terminals, I kept losing track of the basics: what is each agent doing right now, what is still
running, where are we on the plan, and why did that last prompt go the wrong way?

So I built the tool I wanted next to my terminals: one live picture of everything that is running, a plain recap of
what happened, and honest feedback on how I write prompts and when to use subagents. Every choice in it follows my own
workflow and my own preferences. It is useful to me every day, and I am sharing it in case it is useful to you too.

## Open source, and yours to shape

AgentTrace is **open source under the [MIT license](LICENSE)**, and everyone is welcome to use it and to contribute.

- **Contributing.** Ideas, bug reports and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). I review,
  test and merge every contribution myself, so please be patient if it takes a little while.
- **Make it your own.** Because it is built around one person's workflow, it may not fit yours exactly, and that is
  completely fine. Fork it and change anything you like for your own work and preferences. Changes you keep in your fork
  stay yours: I won't pull them into this repository or update them here. If you think a change would help everyone,
  open a pull request and I'll take a look.

## What you can do with it

### Live Map: see what every agent is doing, right now

Your prompt → the main agent → its subagents → the tools they use → the files, commands and websites they touch, as a
tree that updates while the agents work. Running cards glow, a **Running now** bar lists everything working in
parallel, and each agent shows its plan, progress and an estimated time left.

- **Stays readable in big sessions.** Each agent's tools are grouped into one card (click it to open them, or press
  **Show all tools**), and finished subagents fold into one chip. **Collapse all** folds everything back.
- **Never moves on its own.** The map stays exactly where you leave it; **Center** brings everything back into view.
- **Shows what the session is for.** The prompt card shows the session's main prompt, not whatever you typed last
  (quick check-ins like "where are we?" are skipped), with your latest prompt underneath. You can pick a different main
  prompt in the side panel.
- **Background work done right.** Agents and commands that run in the background stay "running" until they really
  report back (or are stopped).
- **Replay.** A slider rebuilds the map at any earlier moment of the session.

### Several CLIs on one map

Running an orchestrator with several agents on one project? Open the session picker and press **+** next to the
sessions you want, or **Add … other sessions** to add every recent session of the same project folder. They appear side
by side under one project card, each with its own agents, subagents and tools, and **Running now** tells you which
session each task belongs to. A **Team Live Map** across people and machines is coming soon.

### Explain: what happened in a session

Any session, turn by turn: what you asked, which subagents and tools ran, which files changed, which commands passed or
failed, and how each turn ended. **Explain with AI** turns it into a short plain-language walkthrough: what got done,
what went wrong and what to do next.

### Insights: write better prompts, use subagents better

- **Prompts to improve.** Each prompt you typed is checked for what makes it hard for an agent to follow: unclear
  targets ("fix it", "it doesn't work"), several tasks in one message, no way to tell when the work is done, and
  prompts you had to correct or stop. You see why it was unclear, what to write instead, and a clearer structure to
  copy. Works for English and Greek.
- **Subagents to run.** Based on how your sessions actually ran: when an Explore subagent would have kept the main agent
  fast, when a reviewer or a test runner would have helped, and when independent work could have run in parallel.
- **Coach files.** Pick the instruction files you give your agents (`CLAUDE.md`, agent definitions, slash commands,
  prompt templates) and get them reviewed for what is unclear, contradictory or missing.
- **Usage signals and profile.** Repeated commands, error rates, huge steps, background work that never reported back,
  your most used tools and files, and your hours of use.
- **AI coach (optional).** Deeper advice from the AI model you choose, only when you press the button. It learns from
  your 👍/👎 ratings and your notes.

### Notes: advice that gets more personal over time

Every person gets their own notes folder (`Documents/AgentTrace/Notes/<name>`). Write down your goals, how you like to
work and lessons learned, in the app or as `.md`/`.txt` files in the folder, or press **Remember** on a suggestion you
liked. The AI coach reads your notes and keeps a `_learnings.md` file about you: what you work on, the mistakes you keep
making, your prompt checklist and the subagents that fit your work.

### Remote viewing

Read-only, token-protected access from your phone or another computer, ideally over Tailscale (see below).

## How it works

1. **Claude Code already writes a log of every session** (one file per session under `~/.claude/projects`).
   AgentTrace only reads these files; it never changes them and it does not change how you use Claude Code.
2. **A watcher reads only the new lines** as they are written and turns them into events: your prompts, the agent's
   replies, tool calls and their results, subagent launches, background tasks and plans.
3. **Everything is stored in a local SQLite database** on your computer. Sessions older than the retention setting (30
   days by default) are deleted automatically.
4. **A small local server** (`127.0.0.1:8787`, this computer only) serves the app's pages and a live stream of changes,
   so the map updates within a second.
5. **Insights rules run locally and for free**, every 15 minutes and when a session goes quiet.
6. **AI features run only when you press their button**, with the provider you chose, and always show you exactly what
   will be sent first.

More detail in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Install

Installers are published on the [Releases page](../../releases): `.exe` for Windows, `.dmg` for macOS, `.AppImage` and
`.deb` for Linux. If there is no release yet, or you want the latest code, build the installer yourself; it takes a few
minutes (see each platform below).

The builds are not code-signed yet, so the first launch needs one extra step on Windows and macOS.

### Windows

**From the Releases page**

1. Download `AgentTrace-<version>-win-x64-setup.exe` (or `-arm64-setup.exe` for ARM PCs).
2. Run it. SmartScreen may say "Windows protected your PC": click **More info** → **Run anyway**.
3. Choose where to install it and finish. AgentTrace opens and starts watching your Claude Code sessions.

**Build it yourself**

1. Install [Node.js](https://nodejs.org) 22.12 or newer and [Git](https://git-scm.com).
2. In PowerShell:

   ```powershell
   git clone https://github.com/KacperDula/AgentHub
   cd AgentHub
   npm install
   npm run dist
   ```

3. The installers are in `apps\desktop\release\` (`AgentTrace-<version>-win-x64-setup.exe` and the arm64 one).

Updates: when a new version is published, the app offers to download and install it for you.

### macOS

**From the Releases page**

1. Download `AgentTrace-<version>-mac-universal.dmg` (works on Apple Silicon and Intel).
2. Open it and drag **AgentTrace** to **Applications**.
3. The first time, right-click the app → **Open** → **Open**. (Or run
   `xattr -dr com.apple.quarantine /Applications/AgentTrace.app` in Terminal.)

**Build it yourself** (on a Mac)

1. Install Node.js 22.12 or newer (for example `brew install node`) and Git (`xcode-select --install`).
2. In Terminal:

   ```bash
   git clone https://github.com/KacperDula/AgentHub && cd AgentHub
   npm install
   CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist
   ```

3. The `.dmg` is in `apps/desktop/release/`.

Updates: unsigned macOS builds can't update themselves; the app tells you when a new version is out and links to the
download.

### Linux

**From the Releases page**

- **AppImage** (any distribution):

  ```bash
  chmod +x AgentTrace-*.AppImage
  ./AgentTrace-*.AppImage
  ```

  On Ubuntu 22.04 and newer you may first need `sudo apt install libfuse2`.

- **Debian / Ubuntu package**:

  ```bash
  sudo apt install ./AgentTrace-*.deb
  ```

**Build it yourself**

1. Install Node.js 22.12 or newer and Git.
2. In a terminal:

   ```bash
   git clone https://github.com/KacperDula/AgentHub && cd AgentHub
   npm install
   npm run dist
   ```

3. The `.AppImage` and `.deb` are in `apps/desktop/release/`.

Updates: the AppImage offers to download and install new versions for you; for the `.deb`, install the new version
the same way as the first one.

### Run from source (any platform)

```bash
git clone https://github.com/KacperDula/AgentHub && cd AgentHub
npm install
npm run dev
```

The app opens and starts watching `~/.claude/projects` (it imports the last 24 hours on first run). No sessions yet?
Click **Load demo session** for a scripted run with two parallel subagents, failing tests and an MCP call. `npm test`
runs the test suite; see [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### After installing

AgentTrace lives in the tray / menu bar: closing the window keeps it watching. Use **Pause watching** or **Quit** there.
It needs Claude Code on the same computer; sessions show up as soon as you use it in any terminal.

## Remote viewing with Tailscale

By default the local server listens on `127.0.0.1:8787` only. To watch from elsewhere:

1. Settings → **Remote viewing** → on. AgentTrace creates an access token and shows a QR code and the URLs that work.
2. Install [Tailscale](https://tailscale.com) on this computer and on your phone/laptop, logged in to the same account.
3. Open `http://<machine-name>:8787` (or scan the QR) and sign in with the token. For HTTPS run
   `tailscale serve 8787` and use the address it prints.

The browser view is read-only by design: no endpoint changes data or runs commands. **Revoke all browsers** makes a new
token and signs every browser out. Several computers? Run AgentTrace on each and add them under **Machines** in the
sidebar; each keeps its own data and login.

## AI features (optional)

Settings → **AI provider**: _None_ (default, local rules only), _Claude Code on this machine_ (`claude -p` with your
own login), _Anthropic API_ (your key and model) or an _OpenAI-compatible endpoint_ (OpenRouter, Ollama, LM Studio).
Keys are stored in your OS keychain.

Nothing is sent until you press an AI button, and you always see the exact payload first in **What will be sent?**.
Depending on the button, it contains rule signals, the aggregate usage profile, a compact outline of a session, your
recent prompts, your notes, or the instruction files you added to **Coach files**. Tool outputs are never sent, and no
file is read for the AI unless you added it yourself. Your 👍/👎 ratings feed into the next analysis.

## Privacy

- Everything is stored on your computer; nothing is sent anywhere unless you turn on remote viewing or use an AI
  feature.
- No accounts, no telemetry, no analytics.
- Retention (30 days by default) and **Delete all data** in Settings.

Details: [docs/PRIVACY.md](docs/PRIVACY.md).

## FAQ

**Does it change how I use Claude Code?** No. It only reads the log files Claude Code already writes.

**Agents that were running before I started AgentTrace are missing.** The first run imports the last 24 hours; change it
in Settings → Backfill. Files it has seen before continue where they stopped.

**Subagents show an id like "subagent a0a1e92".** Their launch happened before the imported window. They are linked as
soon as the launch or its result shows up.

**Why does the main agent say "taking longer than usual"?** ETAs are estimates from the plan's pace or from your past
subagents. While the main agent waits for subagents, its own plan doesn't advance.

**It stopped understanding my logs after a Claude Code update.** The Claude Code log format is **not an official API**
and can change between versions. Please open an issue with an anonymized example line (see the bug template).

**Can I change it to fit how I work?** Yes, that is the point of it being open source. Fork it and make it yours (see
[Open source, and yours to shape](#open-source-and-yours-to-shape)).

**Where is my data?** See [docs/PRIVACY.md](docs/PRIVACY.md#where-it-is-stored).

## License

[MIT](LICENSE). The software is provided "as is", without warranty.

Made by [Kacper Dula](https://github.com/KacperDula).
