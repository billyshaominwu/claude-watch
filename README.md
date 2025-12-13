# Claude Watch

A VS Code extension that monitors your Claude Code CLI sessions. See what each terminal is working on at a glance.

## Features

- **Session Sidebar**: View all active Claude sessions in a dedicated panel
- **Real-time Status**: See which sessions are working vs waiting for input
- **Task Display**: Shows in-progress task from TodoWrite in the description
- **Agent Tracking**: Nested view of agent sub-sessions under parent sessions
- **Quick Navigation**: Click any session to jump to its terminal
- **Multi-Session Support**: Handles multiple Claude sessions in the same directory
- **Workspace Filtering**: Only shows sessions for the current VS Code workspace
- **Dynamic Title**: Panel title shows "X working, Y waiting" summary

## Installation

### From VSIX (Local)

```bash
# Build and install
npm install
npm run install-ext

# Or manually:
npm run compile
npm run package
code --install-extension claude-watch-0.1.0.vsix
```

### From Source

1. Clone this repository
2. Run `npm install`
3. Press F5 in VS Code to launch Extension Development Host

## Usage

1. Open the Claude Watch panel from the activity bar (chat bubble icon)
2. Start Claude sessions in your terminals - they'll appear automatically
3. Click a session to open its terminal
4. Use the refresh button to manually update the list

### Session Display

- **Label**: Shows the last user prompt (or "New session" for cleared sessions)
- **Description**: Shows the current in-progress task from TodoWrite
- **Tooltip**: Hover for details including status, project, path, and session ID

### Session Status Icons

- **Spinning sync icon**: Claude is working (executing tools)
- **Pause icon**: Claude is waiting for user input

### Tree View Actions

- **+ button**: Start a new Claude session
- **Refresh button**: Manually refresh session list
- **Terminal icon**: Open terminal for session
- **X button**: Remove session from list

## How It Works

Claude Watch monitors `~/.claude/projects/` for session transcript files (JSONL format). It uses system commands (`ps`, `lsof`) to detect running Claude processes and match them to VS Code terminals by TTY.

Sessions are considered "active" when:
- A Claude process is running in the session's working directory
- The session is one of the N most recently modified (where N = number of Claude processes in that directory)

Agent sessions (spawned via Task tool) are nested under their parent and only shown when:
- The parent session is active
- The agent has real activity (not just warmup messages)

## Requirements

- VS Code 1.85.0 or higher
- macOS or Linux (uses `ps` and `lsof` for process detection)
- Claude Code CLI installed

## Development

```bash
npm run compile   # Build TypeScript
npm run watch     # Watch mode for development
npm run package   # Create .vsix package
```

## License

MIT
