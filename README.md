# Claude Code Multi-Instance Manager

A browser-based management dashboard for Claude Code, communicating with CLI processes via PTY in full-duplex mode. Run and manage multiple AI coding sessions simultaneously.

## Features

- **Concurrent Instances**: Launch multiple Claude Code / Codex / Gemini CLI instances at once, each in its own window
- **Live Terminal**: xterm.js renders PTY output with full ANSI escape sequence support
- **Task Queue**: Each instance has a dedicated task queue for sequential or batch execution
- **Worktree Support**: Automatically creates an isolated Git worktree per instance; one-click merge and push
- **MCP Orchestrator**: Built-in MCP server lets one Claude instance dispatch tasks to others via tool calls
- **AI Explain**: Send conversation content to OpenAI / Anthropic for analysis with one click
- **Chinese / English UI**: Toggle language via the `EN / 中` button in the header; preference is persisted
- **PWA**: Installable to the desktop with Service Worker offline caching
- **Background Image**: Upload a local image or enter a URL; stored in IndexedDB (no size limit)
- **Page Textures**: Dots, grid, diagonal, cross, and noise texture options
- **Password Protection**: An access password is auto-generated on first launch; can be changed in settings

## Installation & Setup

**Requirements**: Node.js 18+, `claude` (or `codex` / `gemini`) installed globally

```bash
# Install dependencies (node-pty requires native compilation)
npm run install-rebuild

# Start the server
npm start
```

Open `http://localhost:3000` in your browser. The auto-generated access password is printed to the terminal on first launch.

Custom port:

```bash
PORT=8080 npm start
```

## Project Structure

```
├── server.js          # Express + WebSocket backend, PTY management
├── index.html         # Single-file frontend (HTML / CSS / JS)
├── mcp-server.mjs     # MCP tool server (orchestrator mode)
├── sw.js              # Service Worker (PWA offline cache)
├── manifest.json      # PWA manifest
├── ai-settings.json   # AI provider config (generated at runtime)
└── auth-settings.json # Access password hash (generated at runtime)
```

## WebSocket Message Protocol

The frontend communicates with the backend over WebSocket. Key actions:

| action | Description |
|---|---|
| `subscribe` | Subscribe to a PTY instance's output stream |
| `pty_input` | Send keyboard input to the PTY |
| `pty_resize` | Notify the PTY of terminal size changes |

Backend push events include: `pty_output`, `instance_update`, `instances_list`, and others.

## Notes

- `node-pty` contains a native module. After upgrading Node.js, run `npm rebuild node-pty`
- Background images are stored in the browser's IndexedDB; clearing browser data will remove them
- The Worktree feature requires the project directory to be a Git repository
