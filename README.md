# Claude Watch

A VS Code extension that monitors your Claude Code CLI sessions. See what each terminal is working on at a glance.

## Features

- **Session Sidebar**: View all active Claude sessions in a dedicated panel with Active/Old categories
- **Real-time Status**: Three states - Working (spinning), Paused (question asked), Done (task complete)
- **Context Window Display**: Visual progress bar showing token usage with cache hit rate
- **Task Tracking**: Shows in-progress tasks from TodoWrite with completion counts
- **Todo List View**: Expandable session nodes showing individual todo items
- **Agent Tracking**: Nested view of agent sub-sessions under parent sessions
- **Session Pinning**: Pin important sessions to keep them at the top
- **Session Resume**: Resume old sessions directly from the sidebar
- **Quick Navigation**: Click any session to jump to its terminal
- **Session Summaries**: Shows Claude-generated summaries when available
- **Workspace Filtering**: Only shows sessions for the current VS Code workspace

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
4. Expand a session to see context usage and todo items
5. Use the refresh button to manually update the list

### Session Display

- **Label**: Shows session summary, first user message, or last prompt
- **Description**: Current in-progress task with completion count (e.g., "3/5")
- **Tooltip**: Hover for details including status, project, context usage, path, and session ID

### Session Status Icons

- **Spinning sync icon** (blue): Claude is working (executing tools)
- **Pause icon** (yellow): Claude asked a question, waiting for input
- **Check icon** (green): Claude completed the task

### Context Info (Expandable)

- Visual progress bar with percentage
- Token usage: current/max with cache hit rate
- Output tokens count

### Tree View Actions

- **+ button**: Start a new Claude session
- **Refresh button**: Manually refresh session list
- **Terminal icon**: Open terminal for session (inline)
- **Pin icon**: Pin/unpin session to top (inline)
- **Play icon**: Resume old session (inline, on Old sessions)

## How It Works

Claude Watch monitors `~/.claude/projects/` for session transcript files (JSONL format). It uses system commands (`ps`, `lsof`) to detect running Claude processes and match them to VS Code terminals.

### Session-to-Process Mapping

Sessions are associated with Claude processes using multiple strategies:
1. **lsof lookup**: Find the process that has the session file open (most reliable)
2. **Single process match**: If only one Claude process in the CWD, use it
3. **Temporal matching**: Match by closest start time between session and process
4. **Pending retry**: Queue for later if no process found yet

Mappings are persisted to VS Code workspace state and validated against running processes.

### Active vs Old Sessions

**Active sessions** require:
- A Claude process running in the session's CWD
- The session must be among the N most recent (N = number of Claude processes in that directory)

**Old sessions** are inactive sessions that can be resumed:
- No running Claude process
- Have a displayable user prompt
- Click to resume with `claude --resume <sessionId>`

### Agent Sessions

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
