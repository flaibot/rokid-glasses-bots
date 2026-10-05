# Claude Bot

Browse the [Claude Code](https://claude.com/claude-code) sessions on your
Mac from Rokid Glasses, grouped by project folder (current and old ones),
read them, and reply by voice. You can also run slash commands, send quick
replies, stop a running reply, or start a new session.

Two parts:

- `claude-bot/`: the app on the glasses.
- `claude-bridge/`: a small server on your Mac (Node, no dependencies) that
  reads Claude Code's session files and runs your replies with the `claude`
  CLI.

See the [main README](../README.md) for requirements, installing on the
glasses, the key and Tailscale.

## Using it

Everything works with swipe and tap on the temple touchpad.

| Screen | Swipe | Tap | Double tap (Back) |
|---|---|---|---|
| Worktrees (projects) | move one row | open its sessions | close the app |
| Sessions | move one row | open the session | worktrees |
| Session (reading) | next / previous page, then message | open the menu | sessions |
| Menu | move one row | choose | close the menu |
| Listening | cancel | finish now | cancel |
| "Send to Claude?" | cancel | **send** | cancel |
| Claude working | read (follows the newest text) | menu | sessions |

- Lists show a few rows around the selection, with the position (`7/31`) top
  right. The worktrees list ends with **Refresh** and **Scan setup QR code**;
  the sessions list starts with **‹ Back** and **+ New session here**, so
  you never need the double tap.
- A session opens on Claude's latest reply. One screen is one page of one
  message (`81/83 · p2/7`); tool calls are folded into one line such as
  `▸ 3 steps: Bash, Edit`.
- **Menu** (kept short; the rest is in submenus): Reply by voice
  (preselected, so tap-tap starts a reply) · Latest reply · / Commands › ·
  Quick replies › · More › (first message, refresh, back to sessions).
  - **/ Commands ›**: Context usage (`/context`), Plan usage (`/usage`),
    Compact (`/compact`), **Review changes ›** (`/code-review`,
    `/simplify`, `/verify`, `/security-review`, whichever that folder has),
    then **Built-in ›** and **Skills ›** with everything else available in
    that folder, grouped by plugin or shared prefix and split A–Z when a
    list is long. Pick one, then **Send** it or **Send + details by
    voice**. Commands that only work in a terminal (such as `/config`,
    `/doctor`, `/clear`) are left out.
  - **Quick replies ›**: Continue · Yes, go ahead · What's left to do? ·
    Summarize where we are in a few lines · Stop here and wait for me.
  - Every submenu starts with **‹ Back**; double tap also goes up one level.
- **While Claude works**, the menu offers **■ Stop reply**.
- Speaking: short pauses are fine; it finishes after about 3 seconds of
  quiet, or tap to finish. You always see your words and confirm before
  anything is sent.
- Markers: **●** the session is busy on the Mac right now, **◆** a reply
  from the glasses is running.
- A mouse also works: click rows and the buttons along the bottom.

## Set up your Mac

1. **Check the requirements:** Node.js 20+ (`node -v`) and the Claude Code
   CLI signed in (`claude --version`, and run `claude` once to sign in).
2. **Install the bridge as a background service** (starts at login,
   restarts if it stops):

   ```bash
   rokid-utils/install-bridge-service
   ```

   It uses the newest Node it finds (nvm, then `node` on the PATH); set
   `CLAUDE_BRIDGE_NODE=/path/to/node` before running it to choose one. The
   first start creates `~/.claude-bridge/config.json` with a new random
   token. Logs: `~/.claude-bridge/bridge.log`.

3. **Make it reachable on your tailnet** (tailnet devices only, no internet):

   ```bash
   tailscale serve --bg --tcp=8463 tcp://127.0.0.1:8790
   ```

4. **Show the setup QR code** when the app asks for it:

   ```bash
   rokid-utils/claude-bot-qr
   ```

To stop and remove the service: `rokid-utils/install-bridge-service
--uninstall`. After changing `server.mjs`, run the installer again to
restart it.

### Bridge settings

`~/.claude-bridge/config.json` (created on first start, file mode 600):

| Setting | Default | Meaning |
|---|---|---|
| `token` | random | The key the glasses use. At least 32 characters; the bridge won't start without it. |
| `port` | `8790` | Local port (on `127.0.0.1` only). |
| `fallbackPermissionMode` | `auto` | Permission mode for a reply when the session has none recorded. |
| `claudePath` | `claude` | The `claude` CLI to run (found on the service's PATH, which the installer sets). |
| `excludeMcpServers` | `["browsermcp"]` | MCP servers left out of replies (see below). |

## What a reply can do

A reply from the glasses runs Claude Code on your Mac, in that session's
folder, so treat the bridge token like a password:

- It **continues the same session** (`claude -p --resume`), so it also shows
  up in the Claude Code app.
- It uses **the session's own permission mode** (for example `auto`), or
  `fallbackPermissionMode` if none is recorded. `bypassPermissions` is never
  used from the glasses; it is downgraded to `auto`. Actions the mode
  doesn't allow are refused and shown as "Blocked N action(s)".
- Your words go to `claude` on standard input, never as a command-line
  argument, so spoken text can't be read as a CLI option.
- The bridge won't reply in a session that is busy on the Mac right now, at
  most 3 replies run at once, and a reply is stopped after 30 minutes.

## Good to know

- **MCP servers in replies:** a reply loads your user and local MCP servers,
  and a project's `.mcp.json` servers only if you approved them in Claude
  Code, minus those in `excludeMcpServers`. Plugin and claude.ai connector
  servers are not loaded. The list is passed in a private temporary file, so
  server API keys don't appear in the process list. Browser MCP is excluded by default: it
  allows one server per port, so a reply that started its own would take the
  Chrome extension away from your open Claude Code session.
- **Don't ask a reply to restart the bridge.** A reply runs as a child of the
  bridge, so restarting the bridge from inside a reply kills that reply.
- Slash-command output (such as `/context`) isn't saved in Claude Code's
  session file, so it shows on the glasses until you leave the session.
  Commands with no output (such as `/compact`) show their status line
  ("Compacted") or "Done.".

## How it works

- The bridge reads `~/.claude/projects/*/*.jsonl` and serves a small JSON API
  on `127.0.0.1:8790` (bearer token required): projects, sessions,
  transcripts, replies, new sessions, stop, and the list of commands
  (taken from Claude Code's start-up event and cached for 10 minutes).
- Nothing scrolls from code on the glasses, so lists show a window of rows
  and transcripts are split into pages (`lib/ui.js`: `LINE_UNITS`,
  `PAGE_ROWS`, `LIST_ROWS`).

## Developing

- `npx @yodaos-pkg/aix-cli pack . -o /tmp/claude-bot.aix` builds a package;
  `npx @yodaos-pkg/aix-cli preview --dev .` runs Rokid's web simulator
  (layout and keys only; it can't reach the bridge).
- Rokid's runtime quirks met so far: `clearTimeout(null)` throws (use the
  `clear()` helper), and scroll views ignore positions set from code.
- The setup screen shows the last few touchpad keys, to see what your
  glasses send.
- Bump `version` in `app.json`, `lib/version.js` and `AGENTS.md` together
  (`rokid-utils/check-versions`).

## Not yet verified on the glasses

- Touchpad key codes come from another developer's device logs; tap, swipe
  and Back were confirmed on an RV101, other models may differ.
- Text size per page and row may need tuning on other models.
- Restarting recognition right after a pause (`lib/listen.js`).
