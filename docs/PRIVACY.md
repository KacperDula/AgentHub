# Privacy

AgentTrace is local-first. The project has no server and never receives your data.

## What is read

Claude Code's own transcript files in `~/.claude/projects/` (or `$CLAUDE_CONFIG_DIR/projects/`) and, if you set one, an
extra folder. AgentTrace only reads these files; it never changes them. It keeps prompts, assistant replies, tool calls
and results, subagent links, plans (TodoWrite) and background-task notices. Long strings are cut to 2,000 characters.
Other lines (attachments, raw API request copies, file snapshots) are skipped.

## Where it is stored

In a SQLite database in your user data folder:

- macOS: `~/Library/Application Support/AgentTrace/agenttrace.db`
- Windows: `%APPDATA%\AgentTrace\agenttrace.db`
- Linux: `~/.config/AgentTrace/agenttrace.db`

Data older than the retention setting (30 days by default) is deleted automatically. The usage profile used by Insights
stores aggregates only (counts, averages, top tools and files), never contents.

API keys and the remote-access token are encrypted with your OS keychain (Electron `safeStorage`) in `secrets.json` next
to the database. They are never written to the database, logs or error messages.

## What leaves the machine

Nothing, unless you turn one of these on:

1. **Remote viewing** (Settings, off by default). The local server then also listens on your network. Every request
   needs your access token, exchanged once for an HttpOnly cookie. The browser view is read-only: no endpoint changes
   data or runs commands. Use Tailscale to reach it from other networks.
2. **An AI provider** (Settings, "None" by default). Only when you press one of the AI buttons, AgentTrace sends:
   - **Analyze** (Insights): rule signals, the aggregate usage profile and, for one session, a compact outline (tool
     names, counts, durations, short summaries).
   - **Coach my prompts** (Insights): the same, plus up to 40 of your recent prompts (cut to 500 characters each) with
     the issues the local rules found and what happened after each one.
   - **Explain with AI** (Explain): for one session, your prompts, the subagents and tools used, the names of edited
     files, the commands run and the agent's short final answers.
   - **Learn from my notes** (Notes): your notes, prompt statistics and samples, the usage profile and your ratings.
   - **Coach these files** (Insights → Coach files): the contents of the files _you_ added there (up to 15,000
     characters each, 60,000 in total), named by their last folders only. No other file is ever read for the AI;
     files "found on this computer" are only listed until you add them.
   - Your notes (see below) are added to the first three too, unless you turn off "Use my notes in AI analyses".

   Apart from the files you add to Coach files, it never sends file contents, and it never sends tool outputs. You
   see the exact payload in "What will be sent" before the first send
   (and any time after). "Claude Code on this machine" uses your existing `claude` login; "Anthropic API" and
   "OpenAI-compatible" use your own key and endpoint.

## Notes

Notes are plain Markdown/text files in `Documents/AgentTrace/Notes/<user>/` (the folder can be changed on the Notes
page), one folder per user. AgentTrace writes a file there when you save a note or press **Remember** on a suggestion,
and keeps an AI-written `_learnings.md` (with the previous version in `_learnings.prev.md`). Notes are never served by
the local server, so remote browsers can't see them. Delete or edit them in the folder at any time.

Update checks contact GitHub Releases to see whether a newer version exists. There is no telemetry or analytics. If that
ever changes, it will be opt-in and described here.

## How to delete everything

- In the app: Settings → Data → **Delete all data** (and **Clear demo data** for the demo).
- Completely: quit AgentTrace and delete the user data folder listed above.
