# Claude Watch Development Guide

## Project Overview

VS Code extension that monitors Claude Code CLI sessions, displaying active sessions in a sidebar tree view with real-time status updates, context window tracking, and todo list display.

## Architecture

Uses Claude Code hooks for direct session→process identity. No polling or heuristics.

```
src/
├── extension.ts           # Entry point, hook setup, tree view registration
├── hookServer.ts          # TCP server receiving hook events from Claude
├── hookConfig.ts          # Auto-configures Claude Code hooks
├── sessionRegistry.ts     # Unified session management (identity + state)
├── sessionTreeProvider.ts # Tree view data provider with categories
├── transcriptParser.ts    # Parses JSONL transcript files for state
└── utils.ts               # Utilities: cwdEquals, normalizeCwd
```

## Key Concepts

- **Hooks-Based Architecture**: Claude Code hooks execute inside the Claude process, providing direct PID/PPID/TTY identity
- **Session Identity**: Hooks provide ground-truth session→process mapping (no heuristics)
- **Session State**: JSONL parsing provides todos, tokens, status, summary
- **Terminal Matching**: Direct PPID→terminal.processId lookup
- **Agent Support**: Child agents (agent-*.jsonl) nested under parent sessions
- **Workspace Filtering**: Only shows sessions matching current VS Code workspace

## How It Works

1. **Extension Activation**: Auto-configures Claude Code hooks if not present
2. **Hook Server**: TCP server listens for events from hooks
3. **SessionStart Hook**: Claude sends session_id, transcript_path, cwd, PID, PPID, TTY
4. **SessionEnd Hook**: Claude signals session termination
5. **JSONL Watching**: File watcher parses transcripts for session state
6. **Tree View**: Combines hook identity with parsed state for display

## Commands

```bash
npm run compile     # Build TypeScript
npm run watch       # Watch mode
npm run package     # Create .vsix package
npm run install-ext # Compile, package, and install
```

## VS Code Commands (package.json)

- `claude-watch.newSession` - Create new Claude terminal (runs `claude` command)
- `claude-watch.refreshSessions` - Refresh session list
- `claude-watch.openTerminal` - Open terminal for session (direct PPID lookup)
- `claude-watch.pinSession` - Pin/unpin session to keep at top of list
- `claude-watch.resumeSession` - Resume old session (runs `claude --resume <sessionId>`)

## Hook Configuration

Auto-installed to `~/.claude/hooks/claude-watch.sh` and registered in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [{ "type": "command", "command": "~/.claude/hooks/claude-watch.sh" }]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [{ "type": "command", "command": "~/.claude/hooks/claude-watch.sh" }]
      }
    ]
  }
}
```

Note: Lifecycle hooks (SessionStart/SessionEnd) don't use the `matcher` field - that's only for tool hooks (PreToolUse/PostToolUse).

The hook captures `$$` (PID), `$PPID`, and `$(tty)` from within the Claude process and sends to VS Code via TCP.

## Session Registry (sessionRegistry.ts)

Unified session management:

### SessionRecord
- Identity from hooks: `sessionId`, `transcriptPath`, `cwd`, `pid`, `ppid`, `tty`
- State from JSONL: `SessionState` with todos, tokens, status

### Key Methods
- `handleSessionStart(event)` - Register new session with hook identity
- `handleSessionEnd(event)` - Mark session as inactive
- `findTerminalForSession(sessionId)` - Direct PPID→terminal lookup
- `getActiveSessions()` - Sessions with active hook registrations
- `getInactiveSessions()` - Past sessions for "Old Sessions" view

## Transcript Parsing (transcriptParser.ts)

### SessionState Fields
- `sessionId`, `slug`, `cwd`, `filePath`
- `firstUserMessage`, `lastUserPrompt`, `summary`, `inProgressTask`
- `status`: SessionStatus enum (WORKING, PAUSED, DONE)
- `isAgent`, `parentSessionId`
- `tokenUsage`: Token stats (contextTokens, maxContextTokens, input, cacheRead, cacheWrite, output)
- `todos`: Full TodoItem array from last TodoWrite

### Status Detection
- WORKING: Last entry is tool use
- PAUSED: Assistant asked question (AskUserQuestion or ends with ?)
- DONE: Assistant finished without question

### Large File Handling
- Files > 5MB: Sample first 100KB + last 100KB
- Re-stats file after open for accurate size during writes

## Tree View Display (sessionTreeProvider.ts)

### Tree Item Types
- **CategoryItem**: "Active" (expanded) / "Old" (collapsed) with session counts
- **SessionItem**: Main sessions with status icons, todos, context children
- **ContextInfoItem**: Progress bar, token stats, cache hit rate
- **TodoListItem**: Individual todos with status icons
- **OldSessionItem**: Inactive sessions with age display, click to resume

### Session Label Priority
1. Claude-generated summary
2. First user message
3. Last user prompt
4. "New session" fallback

## Testing Locally

1. Open project in VS Code
2. Press F5 to launch Extension Development Host
3. New window shows "Claude Watch" in activity bar (comment-discussion icon)
4. Start Claude sessions in terminals to see them appear
5. Hooks are auto-configured on first activation

## Troubleshooting

### Hooks Not Working
1. Check `~/.claude/settings.json` has hooks configured
2. Check `~/.claude/hooks/claude-watch.sh` exists and is executable
3. Check `~/.claude/.claude-watch-port` contains the server port
4. Verify `nc` (netcat) and `jq` are installed

### Sessions Not Appearing
1. Check extension output for hook server startup
2. Verify Claude Code is using the same `~/.claude` directory
3. Check the Extension Development Host console for errors
