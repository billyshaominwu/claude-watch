import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
import { HookServer, HookEvent, ToolHookEvent } from "./hookServer";
import { parseTranscript, SessionState, SessionStatus } from "./transcriptParser";
import { cwdEquals } from "./utils";
import { log } from "./extension";

// Constants
const DEBOUNCE_MS = 150;
const SCAN_INTERVAL_MS = 2000;
const MAX_INACTIVE_SESSIONS = 500; // Limit stored inactive sessions to prevent memory leak
const MAX_RECENT_TOOLS = 15; // Limit recent tools per session to prevent memory leak
const STALE_TOOL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes - clear currentTool if no PostToolUse
const MAX_PENDING_TERMINALS = 50; // Limit pending terminals to prevent memory leak
const ACTIVITY_THRESHOLD_MS = 10000; // 10 seconds - consider session active if modified recently

/**
 * Current tool being executed
 */
export interface CurrentTool {
  name: string;
  input: Record<string, unknown>;
  startTime: number;
  staleTimer?: NodeJS.Timeout; // Timer to clear stale tool
}

/**
 * Recently completed tool
 */
export interface RecentTool {
  name: string;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  duration: number;
  timestamp: number;
}

/**
 * Extended session info combining hook identity with parsed state
 */
export interface SessionRecord {
  // Identity from hooks
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  pid: number;
  ppid: number;
  tty: string;
  pidStartTime: string | null; // Process start time for PID validation (prevents PID reuse issues)
  // Parsed state from JSONL
  state: SessionState | null;
  // Tool execution state (from hooks)
  currentTool?: CurrentTool;
  recentTools: RecentTool[];
  // Activity tracking
  lastActivityTime: number; // Last time we saw activity (tool use, JSONL update)
}

/**
 * SessionRegistry - unified session management using Claude Code hooks.
 *
 * Replaces the previous architecture of:
 * - sessionManager.ts (JSONL watching + process matching)
 * - sessionProcessMap.ts (persistent TTY→session mapping)
 * - terminalTracker.ts (ps/lsof polling)
 * - terminalMatcher.ts (heuristic matching)
 *
 * Key insight: Hooks are executed BY the Claude process, so they provide
 * ground-truth session→process identity. No more heuristics needed.
 */
export class SessionRegistry {
  // Active sessions (have received SessionStart, not yet SessionEnd)
  private activeSessions: Map<string, SessionRecord> = new Map();

  // All known sessions (including inactive, for "Old Sessions" view)
  private allSessions: Map<string, SessionState> = new Map();

  // Fast lookup indexes
  private ppidIndex: Map<number, string> = new Map(); // ppid → sessionId
  private pidIndex: Map<number, string> = new Map(); // pid → sessionId (Claude process PID)
  private pathIndex: Map<string, string> = new Map(); // transcriptPath → sessionId

  // File watching
  private watcher: vscode.FileSystemWatcher | null = null;
  private scanInterval: NodeJS.Timeout | null = null;
  private fileLastModified: Map<string, number> = new Map();
  private parsingFiles: Set<string> = new Set();

  // Workspace filtering
  private workspacePath: string | undefined;

  // Callbacks
  private onUpdateCallback: ((sessions: SessionState[]) => void) | null = null;
  private onInactiveUpdateCallback: ((sessions: SessionState[]) => void) | null = null;

  // Debouncing
  private debounceTimer: NodeJS.Timeout | null = null;

  // Orphaned agents waiting for parent
  private orphanedAgents: Map<string, string> = new Map(); // filePath -> parentSessionId

  // Linked terminals - terminal references for sessions we can navigate to
  private linkedTerminals: Map<string, vscode.Terminal> = new Map(); // sessionId → Terminal
  private terminalToSession: WeakMap<vscode.Terminal, string> = new WeakMap(); // Terminal → sessionId (WeakMap for GC)
  private pendingTerminals: Map<string, vscode.Terminal> = new Map(); // terminalId → Terminal (waiting for hook)

  // Persistent storage
  private context: vscode.ExtensionContext | null = null;
  private static STORAGE_KEY = "claudeWatch.activeSessions";

  constructor(
    private hookServer: HookServer,
    workspacePath?: string,
    context?: vscode.ExtensionContext
  ) {
    this.workspacePath = workspacePath;
    this.context = context || null;

    // Listen for hook events
    hookServer.onSessionStart((event) => this.handleSessionStart(event));
    hookServer.onSessionEnd((event) => this.handleSessionEnd(event));
    hookServer.onPreToolUse((event) => this.handlePreToolUse(event));
    hookServer.onPostToolUse((event) => this.handlePostToolUse(event));
  }

  /**
   * Start watching for sessions
   * Returns a promise that resolves after persisted sessions are restored
   */
  public async start(): Promise<void> {
    const projectsPath = this.getClaudeProjectsPath();

    // Restore persisted sessions from previous VS Code session
    // This must complete before refresh() is called to avoid race conditions
    try {
      await this.restorePersistedSessions();
    } catch (err) {
      console.error("Claude Watch: Error restoring sessions:", err);
    }

    // Initial scan for transcript state (can run in background)
    this.scanAllProjects().catch((err) => {
      console.error("Claude Watch: Error in initial scan:", err);
    });

    // Watch for JSONL file changes
    const pattern = new vscode.RelativePattern(projectsPath, "**/*.jsonl");
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    this.watcher.onDidChange((uri) => this.handleFileChange(uri));
    this.watcher.onDidCreate((uri) => this.handleFileChange(uri));
    this.watcher.onDidDelete((uri) => this.handleFileDelete(uri));

    // Periodic scan for missed updates
    this.scanInterval = setInterval(() => {
      this.scanAllProjects().catch((err) => {
        console.error("Claude Watch: Error in periodic scan:", err);
      });
    }, SCAN_INTERVAL_MS);
  }

  /**
   * Persist active sessions to globalState (survives VS Code reload)
   */
  private persistSessions(): void {
    if (!this.context) return;

    const sessions: Array<{
      sessionId: string;
      transcriptPath: string;
      cwd: string;
      pid: number;
      ppid: number;
      tty: string;
      pidStartTime: string | null;
    }> = [];

    for (const [, record] of this.activeSessions) {
      sessions.push({
        sessionId: record.sessionId,
        transcriptPath: record.transcriptPath,
        cwd: record.cwd,
        pid: record.pid,
        ppid: record.ppid,
        tty: record.tty,
        pidStartTime: record.pidStartTime,
      });
    }

    this.context.globalState.update(SessionRegistry.STORAGE_KEY, sessions);
    log(`Persisted ${sessions.length} sessions`);
  }

  /**
   * Restore persisted sessions and verify they're still running
   */
  private async restorePersistedSessions(): Promise<void> {
    if (!this.context) return;

    // Clear mtime cache to force re-parsing of all transcripts after VS Code reload
    // This prevents stale session data from persisting
    this.fileLastModified.clear();

    const sessions = this.context.globalState.get<Array<{
      sessionId: string;
      transcriptPath: string;
      cwd: string;
      pid: number;
      ppid: number;
      tty: string;
      pidStartTime?: string | null; // Optional for backwards compat
    }>>(SessionRegistry.STORAGE_KEY, []);

    log(`Restoring ${sessions.length} persisted sessions`);

    let restoredCount = 0;
    for (const session of sessions) {
      // Validate process is still running AND matches stored start time (prevents PID reuse issues)
      const isValid = await this.isProcessValid(session.pid, session.pidStartTime || null);
      if (!isValid) {
        log(`Session ${session.sessionId} PID ${session.pid} no longer valid, skipping`);
        continue;
      }

      // Filter by workspace
      if (this.workspacePath && !cwdEquals(session.cwd, this.workspacePath)) {
        log(`Session ${session.sessionId} filtered out - cwd "${session.cwd}" doesn't match workspace "${this.workspacePath}"`);
        continue;
      }

      // Check if session can be linked to a VS Code terminal before restoring
      const canLink = await this.canLinkToVSCodeTerminal(session.pid, session.ppid);
      if (!canLink) {
        log(`Session ${session.sessionId} filtered out - not started in VS Code terminal`);
        continue;
      }

      log(`Restoring session ${session.sessionId} (pid=${session.pid})`);

      const record: SessionRecord = {
        sessionId: session.sessionId,
        transcriptPath: session.transcriptPath,
        cwd: session.cwd,
        pid: session.pid,
        ppid: session.ppid,
        tty: session.tty,
        pidStartTime: session.pidStartTime || null,
        state: null,
        recentTools: [],
        lastActivityTime: Date.now(), // Will be updated when transcript is parsed
      };

      this.activeSessions.set(session.sessionId, record);
      this.pidIndex.set(session.pid, session.sessionId);
      this.ppidIndex.set(session.ppid, session.sessionId);
      this.pathIndex.set(session.transcriptPath, session.sessionId);

      // Parse transcript for state
      this.parseAndUpdateSession(session.transcriptPath);

      // Try to link terminal for restored session
      await this.tryLazyLink(session.sessionId, session.ppid);

      restoredCount++;

      // Notify after each session to update tree incrementally (prevents race condition)
      this.notifyUpdate();
    }

    log(`Restored ${restoredCount} sessions`);
  }

  /**
   * Get the start time of a process (for PID validation)
   * Returns a string like "Fri Dec 20 10:30:00 2024" that uniquely identifies the process instance
   */
  private async getProcessStartTime(pid: number): Promise<string | null> {
    try {
      const { stdout } = await execAsync(`ps -p ${pid} -o lstart= 2>/dev/null`);
      const startTime = stdout.trim();
      return startTime.length > 0 ? startTime : null;
    } catch {
      return null;
    }
  }

  /**
   * Check if a process is still running AND matches the expected start time.
   * This prevents false positives from PID reuse.
   */
  private async isProcessValid(pid: number, expectedStartTime: string | null): Promise<boolean> {
    try {
      const currentStartTime = await this.getProcessStartTime(pid);
      if (!currentStartTime) {
        log(`isProcessValid: PID ${pid} - process not found`);
        return false; // Process doesn't exist
      }
      if (!expectedStartTime) {
        log(`isProcessValid: PID ${pid} - no expected start time, process exists (legacy mode)`);
        return true; // No expected start time stored, just check PID exists (legacy)
      }
      const matches = currentStartTime === expectedStartTime;
      if (!matches) {
        log(`isProcessValid: PID ${pid} - start time mismatch: expected="${expectedStartTime}", current="${currentStartTime}"`);
      } else {
        log(`isProcessValid: PID ${pid} - validated successfully`);
      }
      return matches;
    } catch (err) {
      log(`isProcessValid: PID ${pid} - error: ${err}`);
      return false;
    }
  }

  /**
   * Stop watching
   */
  public stop(): void {
    if (this.watcher) {
      this.watcher.dispose();
      this.watcher = null;
    }
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    // Clear stale tool timers to prevent leaks
    for (const record of this.activeSessions.values()) {
      if (record.currentTool?.staleTimer) {
        clearTimeout(record.currentTool.staleTimer);
      }
    }
    // Clear linked terminal references
    this.linkedTerminals.clear();
    this.pendingTerminals.clear();
    // WeakMap auto-cleans
  }

  /**
   * Handle SessionStart hook event
   */
  private handleSessionStart(event: HookEvent): void {
    log(`SessionStart: ${event.sessionId} (pid=${event.pid}, ppid=${event.ppid})`);

    // Clean up any existing session with this PID or PPID (in case restored session has wrong ID)
    const existingForPid = this.pidIndex.get(event.pid);
    const existingForPpid = this.ppidIndex.get(event.ppid);

    for (const existingId of [existingForPid, existingForPpid]) {
      if (existingId && existingId !== event.sessionId) {
        log(`Replacing session ${existingId} with hook session ${event.sessionId}`);
        const oldRecord = this.activeSessions.get(existingId);
        if (oldRecord) {
          this.pidIndex.delete(oldRecord.pid);
          this.ppidIndex.delete(oldRecord.ppid);
          this.pathIndex.delete(oldRecord.transcriptPath);
          this.activeSessions.delete(existingId);
        }
      }
    }

    // Create session record
    // Use existing state from allSessions if available (handles resumed sessions)
    const existingState = this.allSessions.get(event.sessionId) || null;
    const record: SessionRecord = {
      sessionId: event.sessionId,
      transcriptPath: event.transcriptPath,
      cwd: event.cwd,
      pid: event.pid,
      ppid: event.ppid,
      tty: event.tty,
      pidStartTime: null, // Will be captured async below
      state: existingState,
      recentTools: [],
      lastActivityTime: Date.now(),
    };

    // Store and index
    this.activeSessions.set(event.sessionId, record);
    this.pidIndex.set(event.pid, event.sessionId);
    this.ppidIndex.set(event.ppid, event.sessionId);
    this.pathIndex.set(event.transcriptPath, event.sessionId);

    // Capture process start time for PID validation (async, non-blocking)
    this.getProcessStartTime(event.pid).then((startTime) => {
      record.pidStartTime = startTime;
      this.persistSessions(); // Re-persist with start time
    });

    // Persist to survive VS Code reload (initial persist, will be updated with startTime)
    this.persistSessions();

    // Try to link pending terminal (from extension-created terminals)
    this.linkPendingTerminal(event.sessionId, event.ppid);

    // Clear mtime cache to force re-parse (handles resumed sessions where file may already be cached)
    this.fileLastModified.delete(event.transcriptPath);

    // Parse the transcript file for state
    this.parseAndUpdateSession(event.transcriptPath);
  }

  /**
   * Handle SessionEnd hook event
   */
  private handleSessionEnd(event: HookEvent): void {
    log(`SessionEnd: ${event.sessionId}`);

    const record = this.activeSessions.get(event.sessionId);
    if (record) {
      // Remove from indexes
      this.pidIndex.delete(record.pid);
      this.ppidIndex.delete(record.ppid);
      this.pathIndex.delete(record.transcriptPath);
      this.activeSessions.delete(event.sessionId);

      // Persist after removal
      this.persistSessions();

      // Ensure we have state for "Old Sessions" list - parse transcript if needed
      let state = record.state;
      if (!state && record.transcriptPath) {
        this.fileLastModified.delete(record.transcriptPath);
        state = parseTranscript(record.transcriptPath);
      }

      // Move to inactive (for "Old Sessions" view)
      if (state) {
        this.allSessions.set(event.sessionId, state);
      }
    }

    this.notifyUpdate();
  }

  /**
   * Handle PreToolUse hook event - tool is starting
   */
  private handlePreToolUse(event: ToolHookEvent): void {
    try {
      const record = this.activeSessions.get(event.sessionId);
      if (!record) {
        log(`PreToolUse for unknown session ${event.sessionId}, ignoring`);
        return;
      }

      log(`PreToolUse: ${event.toolName} for session ${event.sessionId}`);

      // Try lazy linking if session is not yet linked to a terminal
      if (!this.linkedTerminals.has(event.sessionId)) {
        this.tryLazyLink(event.sessionId, event.ppid);
      }

      // Clear any existing stale timer
      if (record.currentTool?.staleTimer) {
        clearTimeout(record.currentTool.staleTimer);
      }

      // Update activity time
      record.lastActivityTime = Date.now();

      // Set current tool with stale timer
      record.currentTool = {
        name: event.toolName,
        input: event.toolInput,
        startTime: event.timestamp || Date.now(),
        staleTimer: setTimeout(() => {
          // Clear stale tool if PostToolUse never arrives
          if (record.currentTool?.name === event.toolName) {
            log(`Clearing stale tool ${event.toolName} for session ${event.sessionId}`);
            delete record.currentTool;
            this.notifyUpdate();
          }
        }, STALE_TOOL_TIMEOUT_MS),
      };

      this.notifyUpdate();
    } catch (err) {
      console.error("Claude Watch: Error handling PreToolUse:", err);
    }
  }

  /**
   * Handle PostToolUse hook event - tool has completed
   */
  private handlePostToolUse(event: ToolHookEvent): void {
    try {
      const record = this.activeSessions.get(event.sessionId);
      if (!record) {
        log(`PostToolUse for unknown session ${event.sessionId}, ignoring`);
        return;
      }

      log(`PostToolUse: ${event.toolName} for session ${event.sessionId}`);

      // Update activity time
      record.lastActivityTime = Date.now();

      // Calculate duration
      const duration = record.currentTool
        ? (event.timestamp || Date.now()) - record.currentTool.startTime
        : 0;

      // Clear stale timer
      if (record.currentTool?.staleTimer) {
        clearTimeout(record.currentTool.staleTimer);
      }

      // Add to recent tools (most recent first)
      record.recentTools.unshift({
        name: event.toolName,
        input: event.toolInput,
        result: event.toolResult,
        duration,
        timestamp: event.timestamp || Date.now(),
      });

      // Enforce size limit to prevent memory leak
      if (record.recentTools.length > MAX_RECENT_TOOLS) {
        record.recentTools.pop();
      }

      // Clear current tool
      delete record.currentTool;

      this.notifyUpdate();
    } catch (err) {
      console.error("Claude Watch: Error handling PostToolUse:", err);
    }
  }

  /**
   * Get session record by ID (for tree provider to access tool state)
   */
  public getSessionRecord(sessionId: string): SessionRecord | undefined {
    return this.activeSessions.get(sessionId);
  }

  // --- Terminal Linking Methods ---

  /**
   * Register a pending terminal before hook fires.
   * Called when extension creates a terminal for "New Session" or "Resume Session".
   */
  public registerPendingTerminal(terminal: vscode.Terminal): void {
    // Generate a unique ID for this pending terminal
    const terminalId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Size limit per audit guide
    if (this.pendingTerminals.size >= MAX_PENDING_TERMINALS) {
      const firstKey = this.pendingTerminals.keys().next().value;
      if (firstKey) {
        this.pendingTerminals.delete(firstKey);
      }
    }
    this.pendingTerminals.set(terminalId, terminal);
    log(`Registered pending terminal ${terminalId}`);
  }

  /**
   * Get linked terminal for session (O(1) lookup, no process spawning)
   */
  public getLinkedTerminal(sessionId: string): vscode.Terminal | undefined {
    return this.linkedTerminals.get(sessionId);
  }

  /**
   * Clean up when terminal closes (called from extension.ts)
   */
  public handleTerminalClose(terminal: vscode.Terminal): void {
    const sessionId = this.terminalToSession.get(terminal);
    if (sessionId) {
      this.linkedTerminals.delete(sessionId);
      log(`Removed linked terminal for session ${sessionId}`);
      // WeakMap auto-cleans terminalToSession
    }
    // Also clean pending terminals
    for (const [id, t] of this.pendingTerminals) {
      if (t === terminal) {
        this.pendingTerminals.delete(id);
        log(`Removed pending terminal ${id}`);
        break;
      }
    }
  }

  /**
   * Link a pending terminal to a session when SessionStart hook fires.
   * Uses async processId check (not sync spawn).
   */
  private async linkPendingTerminal(sessionId: string, ppid: number): Promise<void> {
    // Check pending terminals for matching PPID
    for (const [terminalId, terminal] of this.pendingTerminals) {
      try {
        const terminalPid = await terminal.processId;
        if (terminalPid === ppid) {
          this.linkedTerminals.set(sessionId, terminal);
          this.terminalToSession.set(terminal, sessionId);
          this.pendingTerminals.delete(terminalId);
          log(`Linked terminal for session ${sessionId}`);
          return;
        }
      } catch {
        // Terminal may have closed, ignore
      }
    }
  }

  /**
   * Try to lazy-link a terminal for a session that missed initial linking.
   * Called when tool hooks fire for sessions started before extension activation,
   * or when restoring sessions after VS Code reload.
   */
  private async tryLazyLink(sessionId: string, ppid: number): Promise<void> {
    const record = this.activeSessions.get(sessionId);

    // Collect terminal PIDs for logging
    const terminalPids: number[] = [];
    for (const terminal of vscode.window.terminals) {
      try {
        const pid = await terminal.processId;
        if (pid) terminalPids.push(pid);
      } catch {
        // ignore
      }
    }

    // First, try direct PPID lookup
    for (const terminal of vscode.window.terminals) {
      try {
        const terminalPid = await terminal.processId;
        if (terminalPid === ppid) {
          this.linkedTerminals.set(sessionId, terminal);
          this.terminalToSession.set(terminal, sessionId);
          log(`Lazy-linked terminal for session ${sessionId} (direct PPID match)`);
          this.notifyUpdate();
          return;
        }
      } catch {
        // Terminal may have closed, ignore
      }
    }

    // Fallback: search for terminal that has Claude (record.pid) as a descendant
    // This handles cases where there's an intermediate shell between terminal and Claude
    if (record?.pid) {
      try {
        const ancestorPids = await this.getProcessAncestors(record.pid);

        for (const terminal of vscode.window.terminals) {
          try {
            const terminalPid = await terminal.processId;
            if (terminalPid && ancestorPids.has(terminalPid)) {
              // Update the record with the correct PPID for future lookups
              this.ppidIndex.delete(record.ppid);
              record.ppid = terminalPid;
              this.ppidIndex.set(terminalPid, sessionId);

              this.linkedTerminals.set(sessionId, terminal);
              this.terminalToSession.set(terminal, sessionId);
              log(`Lazy-linked terminal for session ${sessionId} (ancestor search)`);
              this.notifyUpdate();
              return;
            }
          } catch {
            // Terminal may have closed, ignore
          }
        }

        // Log failure with details
        log(`tryLazyLink FAILED for session ${sessionId}: ppid=${ppid}, pid=${record.pid}, ancestors=[${[...ancestorPids].join(',')}], terminalPids=[${terminalPids.join(',')}]`);
      } catch {
        // Ignore errors in fallback
      }
    } else {
      log(`tryLazyLink FAILED for session ${sessionId}: ppid=${ppid}, no pid in record, terminalPids=[${terminalPids.join(',')}]`);
    }
  }

  /**
   * Check if a session can be linked to a VS Code terminal.
   * Returns true if the session's PPID matches a terminal or if any ancestor is a terminal.
   */
  private async canLinkToVSCodeTerminal(pid: number, ppid: number): Promise<boolean> {
    // Check direct PPID match first
    for (const terminal of vscode.window.terminals) {
      try {
        const terminalPid = await terminal.processId;
        if (terminalPid === ppid) {
          return true;
        }
      } catch {
        // Terminal may have closed, ignore
      }
    }

    // Check if any ancestor is a VS Code terminal
    try {
      const ancestorPids = await this.getProcessAncestors(pid);
      for (const terminal of vscode.window.terminals) {
        try {
          const terminalPid = await terminal.processId;
          if (terminalPid && ancestorPids.has(terminalPid)) {
            return true;
          }
        } catch {
          // Terminal may have closed, ignore
        }
      }
    } catch {
      // Ignore errors
    }

    return false;
  }

  /**
   * Get active sessions for tree view
   */
  public getActiveSessions(): SessionState[] {
    const sessions: SessionState[] = [];

    console.log(`Claude Watch: getActiveSessions() - activeSessions has ${this.activeSessions.size} entries`);

    for (const [sessionId, record] of this.activeSessions) {
      if (!record.state) {
        console.log(`Claude Watch: Session ${sessionId} has no state, skipping`);
        continue;
      }

      // Filter by workspace
      if (this.workspacePath && !cwdEquals(record.state.cwd, this.workspacePath)) {
        console.log(`Claude Watch: Session ${sessionId} CWD ${record.state.cwd} doesn't match workspace ${this.workspacePath}`);
        continue;
      }

      // Check if agent's parent is active
      if (record.state.isAgent && record.state.parentSessionId) {
        const parentActive = this.activeSessions.has(record.state.parentSessionId);
        if (!parentActive) continue;
      }

      // Compute effective status using multiple signals
      let effectiveStatus = record.state.status;

      // Signal 1: Hook says tool is running → definitely WORKING
      if (record.currentTool) {
        effectiveStatus = SessionStatus.WORKING;
      }
      // Signal 2: In-progress todo → Claude is actively working
      else if (record.state.todos?.some(t => t.status === 'in_progress')) {
        effectiveStatus = SessionStatus.WORKING;
      }
      // Signal 3: Recent file modification → likely still working
      else if (Date.now() - record.state.lastModified < ACTIVITY_THRESHOLD_MS) {
        effectiveStatus = SessionStatus.WORKING;
      }
      // Otherwise: use transcript-derived status (DONE or PAUSED)

      // Push state with effective status
      sessions.push({ ...record.state, status: effectiveStatus });
    }

    console.log(`Claude Watch: getActiveSessions() returning ${sessions.length} sessions`);
    // Sort by created time (most recent first)
    return sessions.sort((a, b) => b.created - a.created);
  }

  /**
   * Get inactive sessions for "Old Sessions" view
   */
  public getInactiveSessions(): SessionState[] {
    const activeIds = new Set(this.activeSessions.keys());
    const sessions: SessionState[] = [];

    for (const [id, state] of this.allSessions) {
      if (activeIds.has(id)) continue;
      if (state.isAgent) continue;
      if (!state.lastUserPrompt) continue;

      // Filter by workspace
      if (this.workspacePath && !cwdEquals(state.cwd, this.workspacePath)) {
        continue;
      }

      sessions.push(state);
    }

    // Sort by last modified (most recent first)
    const config = vscode.workspace.getConfiguration('claudeWatch');
    const maxOldSessions = config.get<number>('maxOldSessions', 100);
    return sessions.sort((a, b) => b.lastModified - a.lastModified).slice(0, maxOldSessions);
  }

  /**
   * Trim allSessions map to prevent unbounded memory growth
   */
  private trimInactiveSessions(): void {
    // Get sessions not in active set
    const activeIds = new Set(this.activeSessions.keys());
    const inactiveSessions: Array<[string, SessionState]> = [];

    for (const [id, state] of this.allSessions) {
      if (!activeIds.has(id)) {
        inactiveSessions.push([id, state]);
      }
    }

    // If under limit, nothing to do
    if (inactiveSessions.length <= MAX_INACTIVE_SESSIONS) {
      return;
    }

    // Sort by lastModified (oldest first) and remove excess
    inactiveSessions.sort((a, b) => a[1].lastModified - b[1].lastModified);
    const toRemove = inactiveSessions.slice(0, inactiveSessions.length - MAX_INACTIVE_SESSIONS);

    for (const [id] of toRemove) {
      this.allSessions.delete(id);
    }

    log(`Trimmed ${toRemove.length} old sessions from cache`);
  }

  /**
   * Find terminal for a session.
   * First tries direct PPID lookup, then searches for terminals with Claude as descendant.
   */
  public async findTerminalForSession(sessionId: string): Promise<vscode.Terminal | undefined> {
    const record = this.activeSessions.get(sessionId);
    if (!record) {
      log(`findTerminalForSession: no record for session ${sessionId}`);
      return undefined;
    }

    // Collect terminal PIDs for logging
    const terminalPids: number[] = [];
    for (const terminal of vscode.window.terminals) {
      try {
        const pid = await terminal.processId;
        if (pid) terminalPids.push(pid);
      } catch {
        // ignore
      }
    }

    // First, try direct PPID lookup (works when hook registered the session)
    for (const terminal of vscode.window.terminals) {
      const terminalPid = await terminal.processId;
      if (terminalPid === record.ppid) {
        log(`findTerminalForSession: found via direct PPID match for session ${sessionId}`);
        return terminal;
      }
    }

    // Fallback: search for terminal that has Claude (record.pid) as a descendant
    // This handles VS Code reload case where terminal.processId changed
    if (record.pid) {
      try {
        // Get the full ancestor chain of the Claude process
        const ancestorPids = await this.getProcessAncestors(record.pid);

        for (const terminal of vscode.window.terminals) {
          const terminalPid = await terminal.processId;
          if (terminalPid && ancestorPids.has(terminalPid)) {
            // Update the record with the correct PPID for future lookups
            this.ppidIndex.delete(record.ppid);
            record.ppid = terminalPid;
            this.ppidIndex.set(terminalPid, sessionId);
            log(`findTerminalForSession: found via ancestor search for session ${sessionId}`);
            return terminal;
          }
        }

        // Log failure with details
        log(`findTerminalForSession FAILED for session ${sessionId}: ppid=${record.ppid}, pid=${record.pid}, ancestors=[${[...ancestorPids].join(',')}], terminalPids=[${terminalPids.join(',')}]`);
      } catch (err) {
        log(`findTerminalForSession error for session ${sessionId}: ${err}`);
      }
    } else {
      log(`findTerminalForSession FAILED for session ${sessionId}: ppid=${record.ppid}, no pid in record`);
    }

    return undefined;
  }

  /**
   * Get all ancestor PIDs of a process (non-blocking)
   */
  private async getProcessAncestors(pid: number): Promise<Set<number>> {
    const ancestors = new Set<number>();
    try {
      let currentPid = pid;
      for (let i = 0; i < 10; i++) { // Max 10 levels to avoid infinite loop
        const { stdout } = await execAsync(`ps -o ppid= -p ${currentPid} 2>/dev/null | tr -d ' '`);
        const ppid = stdout.trim();

        if (!ppid || ppid === "0" || ppid === "1") break;

        const ppidNum = parseInt(ppid, 10);
        if (isNaN(ppidNum) || ancestors.has(ppidNum)) break;

        ancestors.add(ppidNum);
        currentPid = ppidNum;
      }
    } catch {
      // Ignore errors
    }
    return ancestors;
  }

  /**
   * Find terminal for a session state
   */
  public async findTerminalForSessionState(state: SessionState): Promise<vscode.Terminal | undefined> {
    return this.findTerminalForSession(state.sessionId);
  }

  /**
   * Get parent session for an agent
   */
  public getParentSession(state: SessionState): SessionState | null {
    if (!state.parentSessionId) return null;

    // Check active sessions first
    const activeRecord = this.activeSessions.get(state.parentSessionId);
    if (activeRecord?.state) return activeRecord.state;

    // Check all sessions
    return this.allSessions.get(state.parentSessionId) || null;
  }

  /**
   * Clean up orphaned sessions whose Claude process is no longer running
   */
  public async cleanupOrphanedSessions(): Promise<number> {
    // Find sessions whose Claude process is no longer valid (not running or PID was reused)
    const orphanedSessionIds: string[] = [];
    for (const [sessionId, record] of this.activeSessions) {
      const isValid = await this.isProcessValid(record.pid, record.pidStartTime);
      if (!isValid) {
        orphanedSessionIds.push(sessionId);
      }
    }

    // Remove orphaned sessions
    for (const sessionId of orphanedSessionIds) {
      const record = this.activeSessions.get(sessionId);
      if (record) {
        log(`Cleanup: removing orphaned session ${sessionId} (pid=${record.pid} no longer running)`);
        this.pidIndex.delete(record.pid);
        this.ppidIndex.delete(record.ppid);
        this.pathIndex.delete(record.transcriptPath);
        this.activeSessions.delete(sessionId);

        // Ensure we have state for "Old Sessions" list - parse transcript if needed
        let state = record.state;
        if (!state && record.transcriptPath) {
          // Force re-parse by clearing mtime cache
          this.fileLastModified.delete(record.transcriptPath);
          state = parseTranscript(record.transcriptPath);
        }

        // Move to inactive (for "Old Sessions" view)
        if (state) {
          this.allSessions.set(sessionId, state);
        }
      }
    }

    if (orphanedSessionIds.length > 0) {
      this.persistSessions();
      this.notifyUpdate();
    }

    return orphanedSessionIds.length;
  }

  /**
   * Refresh: cleanup orphaned sessions and re-notify
   */
  public async refresh(): Promise<void> {
    const cleaned = await this.cleanupOrphanedSessions();
    log(`Refresh: cleaned ${cleaned} orphaned sessions, ${this.activeSessions.size} active`);
    this.notifyUpdate();
  }

  // --- Callbacks ---

  public onUpdate(callback: (sessions: SessionState[]) => void): void {
    this.onUpdateCallback = callback;
  }

  public onInactiveUpdate(callback: (sessions: SessionState[]) => void): void {
    this.onInactiveUpdateCallback = callback;
  }

  // --- Private Methods ---

  private getClaudeProjectsPath(): string {
    return path.join(os.homedir(), ".claude", "projects");
  }

  private notifyUpdate(): void {
    // Debounce updates
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      // Recheck orphaned agents
      this.recheckOrphanedAgents();

      // Prevent memory leak from unbounded inactive session storage
      this.trimInactiveSessions();

      if (this.onUpdateCallback) {
        this.onUpdateCallback(this.getActiveSessions());
      }
      if (this.onInactiveUpdateCallback) {
        this.onInactiveUpdateCallback(this.getInactiveSessions());
      }
    }, DEBOUNCE_MS);
  }

  private async handleFileChange(uri: vscode.Uri): Promise<void> {
    const filePath = uri.fsPath;

    // Skip if already parsing
    if (this.parsingFiles.has(filePath)) return;

    this.parseAndUpdateSession(filePath);
  }

  private handleFileDelete(uri: vscode.Uri): void {
    const filePath = uri.fsPath;
    const sessionId = this.pathIndex.get(filePath);

    if (sessionId) {
      const record = this.activeSessions.get(sessionId);
      if (record) {
        this.pidIndex.delete(record.pid);
        this.ppidIndex.delete(record.ppid);
        this.activeSessions.delete(sessionId);
      }
      this.pathIndex.delete(filePath);
      this.allSessions.delete(sessionId);
    }

    this.fileLastModified.delete(filePath);
    this.notifyUpdate();
  }

  private parseAndUpdateSession(filePath: string): void {
    // Check mtime to skip unchanged files
    try {
      const stats = fs.statSync(filePath);
      const lastMtime = this.fileLastModified.get(filePath);
      if (lastMtime && stats.mtimeMs <= lastMtime) {
        console.log(`Claude Watch: Skipping unchanged file ${filePath}`);
        return;
      }
      this.fileLastModified.set(filePath, stats.mtimeMs);
    } catch (err) {
      console.log(`Claude Watch: Error statting file ${filePath}:`, err);
      return;
    }

    // Mark as parsing
    this.parsingFiles.add(filePath);

    try {
      const state = parseTranscript(filePath);
      if (!state) {
        console.log(`Claude Watch: parseTranscript returned null for ${filePath}`);
        this.parsingFiles.delete(filePath);
        return;
      }

      console.log(`Claude Watch: Parsed ${filePath} -> sessionId=${state.sessionId}, isAgent=${state.isAgent}`);

      // Handle agent orphaning
      if (state.isAgent && state.parentSessionId) {
        const parentRecord = this.activeSessions.get(state.parentSessionId);
        if (!parentRecord) {
          this.orphanedAgents.set(filePath, state.parentSessionId);
        } else {
          this.orphanedAgents.delete(filePath);
        }
      }

      // Update session state
      // First try to find by path (handles detection case where filename sessionId might differ from JSONL sessionId)
      const sessionIdFromPath = this.pathIndex.get(filePath);
      const existingRecord = this.activeSessions.get(sessionIdFromPath || state.sessionId);

      if (existingRecord) {
        existingRecord.state = state;
      } else {
        // Session not yet registered via hook - store in allSessions
        this.allSessions.set(state.sessionId, state);
      }

      this.notifyUpdate();
    } finally {
      this.parsingFiles.delete(filePath);
    }
  }

  private recheckOrphanedAgents(): void {
    for (const [filePath, parentId] of this.orphanedAgents) {
      const parentRecord = this.activeSessions.get(parentId);
      if (parentRecord) {
        // Parent is now available, re-parse
        this.orphanedAgents.delete(filePath);
        this.parseAndUpdateSession(filePath);
      }
    }
  }

  private async scanAllProjects(): Promise<void> {
    const projectsPath = this.getClaudeProjectsPath();

    try {
      const projectDirs = await fs.promises.readdir(projectsPath);

      for (const projectDir of projectDirs) {
        const projectPath = path.join(projectsPath, projectDir);
        const stat = await fs.promises.stat(projectPath);
        if (!stat.isDirectory()) continue;

        const files = await fs.promises.readdir(projectPath);

        // Sort: main sessions before agents
        const sortedFiles = files.sort((a, b) => {
          const aIsAgent = a.startsWith("agent-");
          const bIsAgent = b.startsWith("agent-");
          if (aIsAgent && !bIsAgent) return 1;
          if (!aIsAgent && bIsAgent) return -1;
          return 0;
        });

        for (const file of sortedFiles) {
          if (!file.endsWith(".jsonl")) continue;
          const filePath = path.join(projectPath, file);
          this.parseAndUpdateSession(filePath);
        }
      }
    } catch (err) {
      // Projects directory may not exist yet
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("Claude Watch: Error scanning projects:", err);
      }
    }
  }
}
