# AI Monitor

Electron + Vue 3 desktop monitor for local Codex and Claude activity. The app is read-only: it discovers local installations, checks related processes, and parses local session metadata without uploading conversation content.

## Features

- Separate Codex Desktop and Claude Desktop work areas
- Automatic macOS and Windows install-path discovery
- Desktop, CLI, and local data-directory health
- Related-process detection
- Recent local sessions, current model, status, working directory, and token totals
- Click-through to matching Codex or Claude Code sessions when supported by the desktop client
- Claude Code activity detection through CLI agents, processes, transcript events, and recent writes
- Claude Desktop five-hour and seven-day plan usage from its read-only local usage history
- Claude aggregate session/model/cost statistics from `stats-cache.json`
- Three-second data refresh with independent one-second relative-time updates
- All-session and active-session filters
- Always-on-top activity window with latest-message previews and completion/approval alerts
- Light/dark appearance and responsive narrow-window layout

## Data sources

| Provider | Sources |
| --- | --- |
| Codex | `$CODEX_HOME` or `~/.codex`, `sessions/**/*.jsonl`, running processes |
| Claude | `$CLAUDE_CONFIG_DIR` or `~/.claude`, `projects/**/*.jsonl`, `stats-cache.json`, Claude Desktop `plan-usage-history.json`, `claude agents --json`, running processes |

Codex Desktop runtime state is process-local, so a session is marked active using persisted lifecycle events plus recent file activity. Claude Code combines the CLI's JSON status with process and transcript activity because interactive sessions are not always returned by `claude agents --json`. Claude subscription limits are dynamic, so the monitor reports the same remaining percentages exposed by Claude Desktop rather than inventing a token count.

## Development

Requirements: Node.js 20 or later.

```bash
npm install
npm run dev
```

For a browser-only UI preview with fixture data:

```bash
npm run dev:web
```

To print a real local collection snapshot without opening the monitor window:

```bash
npm run snapshot
```

## Build

```bash
npm run build
npm run dist:mac
npm run dist:win
```

Windows packages should normally be built on Windows, and macOS packages on macOS, so native signing and installer tooling are available.

## Security

- Renderer process uses context isolation, sandboxing, and no Node.js integration.
- Filesystem and process access stays in the Electron main process.
- Renderer access is limited to a small preload bridge.
- The app does not alter Codex or Claude settings.
- No session content is sent to a remote service.
