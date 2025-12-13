# Claude Watch Development Guide

## Project Overview

VS Code extension that monitors Claude Code CLI sessions, displaying active sessions in a sidebar tree view with real-time status updates.

## Architecture

```
src/
├── extension.ts          # Entry point, command registration, tree view setup
├── sessionManager.ts     # Watches ~/.claude/projects/*.jsonl for sessions
├── sessionTreeProvider.ts # Tree view data provider for sidebar
├── terminalTracker.ts    # Detects Claude processes via ps/lsof
├── terminalMatcher.ts    # Matches sessions to VS Code terminals by TTY
├── transcriptParser.ts   # Parses JSONL transcript files
└── utils.ts              # Utility: withTimeout promise wrapper
```

## Key Concepts

- **Session Detection**: Monitors `~/.claude/projects/**/*.jsonl` files for Claude sessions
- **Process Matching**: Uses `ps -eo pid,tty,lstart,comm` and `lsof -p <pid>` to detect Claude processes and their CWDs
- **Status Tracking**: Parses transcript entries to determine if session is "working" (tool use) or "waiting" (assistant finished)
- **Agent Support**: Child agents (agent-*.jsonl) are nested under parent sessions
- **Context Tracking**: Tracks token usage (input + cache tokens) per session with model-specific context window limits
- **Workspace Filtering**: Only shows sessions matching the current VS Code workspace path

## Commands

```
npm run compile     # Build TypeScript
npm run watch       # Watch mode
npm run package     # Create .vsix package
npm run install-ext # Compile, package, and install
```

## VS Code Commands (package.json)

- `claude-watch.newSession` - Create new Claude terminal (runs `claude` command)
- `claude-watch.refreshSessions` - Refresh session list
- `claude-watch.openTerminal` - Open terminal for session (matches by TTY or heuristics)
- `claude-watch.killSession` - Remove session from list (confirmation required)

## Session State Logic (sessionManager.ts:97-136)

- Main sessions require a Claude process in their CWD to be "active"
- Most recent N sessions (N = Claude terminal count) in a CWD are shown
- Handles `/clear` command creating new session files (old ones become stale)
- Agents only shown if parent is active AND hasRealActivity is true

## Transcript Parsing (transcriptParser.ts)

- Extracts: sessionId, slug, cwd, currentTask, inProgressTask, lastUserPrompt, isWaiting, contextTokens, maxContextTokens
- Large files (>5MB): Samples first 100KB + last 100KB chunks
- Detects `/clear` commands and tracks "isCleared" state
- TodoWrite tool calls determine in-progress task display
- Filters "Warmup" messages for agents (hasRealActivity tracking)
- Token usage extracted from assistant message `usage` field
- Model context windows: 200K tokens for Claude 3.5/4 models

## Tree View Display (sessionTreeProvider.ts)

- Label: lastUserPrompt or "New session" for cleared/empty sessions
- Description: Current in-progress task from TodoWrite (truncated to 60 chars)
- Icons: `sync~spin` (working) or `debug-pause` (waiting)
- Title bar: Shows "X working, Y waiting" summary
- Tooltip: Markdown with status, project, prompt, task, path, session ID

## Terminal Matching (terminalMatcher.ts)

- Primary: TTY matching via shell PID lookup
- Fallback: Terminal name heuristics (looks for "claude" + project name)
- Multi-session support: Matches most recent session to most recent process by start time

## Testing Locally

1. Open project in VS Code
2. Press F5 to launch Extension Development Host
3. New window shows "Claude Watch" in activity bar (comment-discussion icon)
