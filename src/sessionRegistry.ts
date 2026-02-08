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
import { TerminalLinker } from "./terminalLinker";

// Constants
const DEBOUNCE_MS = 150;
const FILE_CHANGE_DEBOUNCE_MS = 100; // Debounce rapid file system events
const SCAN_INTERVAL_MS = 5000; // Scan every 5 seconds (performance: was 2s)
const MAX_INACTIVE_SESSIONS = 500; // Limit stored inactive sessions to prevent memory leak
const MAX_RECENT_TOOLS = 15; // Limit recent tools per session to prevent memory leak
const STALE_TOOL_TIMEOUT_MS = 30 * 1000; // 30 seconds - clear currentTool if no PostToolUse

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
 * - sessionProcessMap.ts (persistent TTY->session mapping)
 * - terminalTracker.ts (ps/lsof polling)
 * - terminalMatcher.ts (heuristic matching)
 *
 * Key insight: Hooks are executed BY the Claude process, so they provide
 * ground-truth session->process identity. No more heuristics needed.
 */
export class SessionRegistry {
  // Active sessions (have received SessionStart, not yet SessionEnd)
  private activeSessions: Map<string, SessionRecord> = new Map();

  // All known sessions (including inactive, for "Old Sessions" view)
  private allSessions: Map<string, SessionState> = new Map();

  // Fast lookup indexes
  private ppidIndex: Map<number, string> = new Map(); // ppid -> sessionId
  private pidIndex: Map<number, string> = new Map(); // pid -> sessionId (Claude process PID)
  private pathIndex: Map<string, string> = new Map(); // transcriptPath -> sessionId

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
  private fileChangeTimers: Map<string, NodeJS.Timeout> = new Map(); // Per-file debounce for file watcher

  // Orphaned agents waiting for parent
  private orphanedAgents: Map<string, string> = new Map(); // filePath -> parentSessionId

  // Terminal linking (delegated to TerminalLinker)
  private terminalLinker: TerminalLinker;

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

    // Initialize terminal linker
    this.terminalLinker = new TerminalLinker();
    this.terminalLinker.onUpdate(() => this.notifyUpdate());

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
      log(`Error restoring sessions: ${err}`);
    }

    // Initial scan for transcript state (can run in background)
    this.scanAllProjects().catch((err) => {
      log(`Error in initial scan: ${err}`);
    });

    // Watch for JSONL file changes
    const pattern = new vscode.RelativePattern(projectsPath, "**/*.jsonl");
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    // Debounce file change events - rapid file system events are coalesced per-file
    this.watcher.onDidChange((uri) => this.debouncedFileChange(uri));
    this.watcher.onDidCreate((uri) => this.debouncedFileChange(uri));
    this.watcher.onDidDelete((uri) => this.handleFileDelete(uri));

    // Periodic scan for missed updates
    this.scanInterval = setInterval(() => {
      this.scanAllProjects().catch((err) => {
        log(`Error in periodic scan: ${err}`);
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
      recentTools: RecentTool[];
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
        recentTools: record.recentTools,
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
      recentTools?: RecentTool[]; // Optional for backwards compat
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
      const canLink = await this.terminalLinker.canLinkToVSCodeTerminal(session.pid, session.ppid);
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
        recentTools: session.recentTools || [], // Restore persisted tool history
        lastActivityTime: Date.now(), // Will be updated when transcript is parsed
      };

      this.activeSessions.set(session.sessionId, record);
      this.pidIndex.set(session.pid, session.sessionId);
      this.ppidIndex.set(session.ppid, session.sessionId);
      this.pathIndex.set(session.transcriptPath, session.sessionId);

      // Parse transcript for state
      await this.parseAndUpdateSession(session.transcriptPath);

      // Try to link terminal for restored session
      await this.terminalLinker.tryLazyLink(
        session.sessionId,
        session.ppid,
        session.pid,
        (newPpid) => {
          this.ppidIndex.delete(record.ppid);
          record.ppid = newPpid;
          this.ppidIndex.set(newPpid, session.sessionId);
        }
      );

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
    // Clear file change debounce timers
    for (const timer of this.fileChangeTimers.values()) {
      clearTimeout(timer);
    }
    this.fileChangeTimers.clear();
    // Clear stale tool timers to prevent leaks
    for (const record of this.activeSessions.values()) {
      if (record.currentTool?.staleTimer) {
        clearTimeout(record.currentTool.staleTimer);
      }
    }
    // Clean up terminal linker
    this.terminalLinker.dispose();
  }

  /**
   * Handle SessionStart hook event
   */
  private async handleSessionStart(event: HookEvent): Promise<void> {
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
    await this.terminalLinker.linkPendingTerminal(event.sessionId, event.ppid);

    // Clear mtime cache to force re-parse (handles resumed sessions where file may already be cached)
    this.fileLastModified.delete(event.transcriptPath);

    // Parse the transcript file for state
    await this.parseAndUpdateSession(event.transcriptPath);
  }

  /**
   * Handle SessionEnd hook event
   */
  private async handleSessionEnd(event: HookEvent): Promise<void> {
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
        state = await parseTranscript(record.transcriptPath);
      }

      // Move to inactive (for "Old Sessions" view)
      if (state) {
        this.allSessions.set(event.sessionId, state);
      }
    }

    this.notifyUpdate();
  }

  /**
   * Manually end a session (for close button when no linked terminal)
   */
  public async endSession(sessionId: string): Promise<void> {
    log(`Manually ending session: ${sessionId}`);

    const record = this.activeSessions.get(sessionId);
    if (!record) {
      return;
    }

    // Remove from indexes
    this.pidIndex.delete(record.pid);
    this.ppidIndex.delete(record.ppid);
    this.pathIndex.delete(record.transcriptPath);
    this.activeSessions.delete(sessionId);

    // Remove from linked terminals if present
    this.terminalLinker.removeLinkedTerminal(sessionId);

    // Persist after removal
    this.persistSessions();

    // Ensure we have state for "Old Sessions" list
    let state = record.state;
    if (!state && record.transcriptPath) {
      this.fileLastModified.delete(record.transcriptPath);
      state = await parseTranscript(record.transcriptPath);
    }

    // Move to inactive (for "Old Sessions" view)
    if (state) {
      this.allSessions.set(sessionId, state);
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
      if (!this.terminalLinker.hasLinkedTerminal(event.sessionId)) {
        this.terminalLinker.tryLazyLink(
          event.sessionId,
          event.ppid,
          record.pid,
          (newPpid) => {
            this.ppidIndex.delete(record.ppid);
            record.ppid = newPpid;
            this.ppidIndex.set(newPpid, event.sessionId);
          }
        );
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
      log(`Error handling PreToolUse: ${err}`);
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
      log(`Error handling PostToolUse: ${err}`);
    }
  }

  /**
   * Get session record by ID (for tree provider to access tool state)
   */
  public getSessionRecord(sessionId: string): SessionRecord | undefined {
    return this.activeSessions.get(sessionId);
  }

  // --- Terminal Linking Methods (delegated to TerminalLinker) ---

  /**
   * Register a pending terminal before hook fires.
   * Called when extension creates a terminal for "New Session" or "Resume Session".
   */
  public registerPendingTerminal(terminal: vscode.Terminal): void {
    this.terminalLinker.registerPendingTerminal(terminal);
  }

  /**
   * Get linked terminal for session (O(1) lookup, no process spawning)
   */
  public getLinkedTerminal(sessionId: string): vscode.Terminal | undefined {
    return this.terminalLinker.getLinkedTerminal(sessionId);
  }

  /**
   * Clean up when terminal closes (called from extension.ts)
   */
  public handleTerminalClose(terminal: vscode.Terminal): void {
    this.terminalLinker.handleTerminalClose(terminal);
  }

  /**
   * Get active sessions for tree view
   */
  public getActiveSessions(): SessionState[] {
    const sessions: SessionState[] = [];

    log(`getActiveSessions() - activeSessions has ${this.activeSessions.size} entries`);

    for (const [sessionId, record] of this.activeSessions) {
      if (!record.state) {
        log(`Session ${sessionId} has no state, skipping`);
        continue;
      }

      // Filter by workspace
      if (this.workspacePath && !cwdEquals(record.state.cwd, this.workspacePath)) {
        log(`Session ${sessionId} CWD ${record.state.cwd} doesn't match workspace ${this.workspacePath}`);
        continue;
      }

      // Check if agent's parent is active
      if (record.state.isAgent && record.state.parentSessionId) {
        const parentActive = this.activeSessions.has(record.state.parentSessionId);
        if (!parentActive) continue;
      }

      // Compute effective status using multiple signals
      let effectiveStatus = record.state.status;

      // Signal 1: Hook says tool is running -> definitely WORKING
      if (record.currentTool) {
        effectiveStatus = SessionStatus.WORKING;
      }
      // Signal 2: In-progress todo -> Claude is actively working (only if transcript isn't explicitly DONE)
      else if (record.state.status !== SessionStatus.DONE &&
               record.state.todos?.some(t => t.status === 'in_progress')) {
        effectiveStatus = SessionStatus.WORKING;
      }
      // Otherwise: use transcript-derived status (DONE or PAUSED)

      // Push state with effective status
      // Use the map key (real sessionId from hook) instead of record.state.sessionId
      // This handles empty files where parseTranscript returns filename as sessionId
      sessions.push({ ...record.state, sessionId, status: effectiveStatus });
    }

    log(`getActiveSessions() returning ${sessions.length} sessions`);
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

    const terminal = await this.terminalLinker.findTerminalByPid(
      record.ppid,
      record.pid,
      (newPpid) => {
        this.ppidIndex.delete(record.ppid);
        record.ppid = newPpid;
        this.ppidIndex.set(newPpid, sessionId);
        log(`findTerminalForSession: updated PPID for session ${sessionId}`);
      }
    );

    if (terminal) {
      log(`findTerminalForSession: found terminal for session ${sessionId}`);
    }

    return terminal;
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
          state = await parseTranscript(record.transcriptPath);
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
      // Recheck orphaned agents (fire-and-forget async)
      this.recheckOrphanedAgents().catch((err) => {
        log(`Error rechecking orphaned agents: ${err}`);
      });

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

  /**
   * Debounced file change handler - coalesces rapid file system events per-file
   */
  private debouncedFileChange(uri: vscode.Uri): void {
    const filePath = uri.fsPath;

    // Clear existing timer for this file
    const existingTimer = this.fileChangeTimers.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new debounced timer
    const timer = setTimeout(() => {
      this.fileChangeTimers.delete(filePath);
      this.handleFileChange(uri).catch((err) => {
        log(`Error handling file change for ${filePath}: ${err}`);
      });
    }, FILE_CHANGE_DEBOUNCE_MS);

    this.fileChangeTimers.set(filePath, timer);
  }

  private async handleFileChange(uri: vscode.Uri): Promise<void> {
    const filePath = uri.fsPath;

    // Skip if already parsing
    if (this.parsingFiles.has(filePath)) return;

    await this.parseAndUpdateSession(filePath);
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

  private async parseAndUpdateSession(filePath: string): Promise<void> {
    // Check mtime to skip unchanged files
    try {
      const stats = await fs.promises.stat(filePath);
      const lastMtime = this.fileLastModified.get(filePath);
      if (lastMtime && stats.mtimeMs <= lastMtime) {
        log(`Skipping unchanged file ${filePath}`);
        return;
      }
      this.fileLastModified.set(filePath, stats.mtimeMs);
    } catch (err) {
      log(`Error statting file ${filePath}: ${err}`);
      return;
    }

    // Mark as parsing
    this.parsingFiles.add(filePath);

    try {
      const state = await parseTranscript(filePath);
      if (!state) {
        log(`parseTranscript returned null for ${filePath}`);
        this.parsingFiles.delete(filePath);
        return;
      }

      log(`Parsed ${filePath} -> sessionId=${state.sessionId}, isAgent=${state.isAgent}`);

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

  private async recheckOrphanedAgents(): Promise<void> {
    for (const [filePath, parentId] of this.orphanedAgents) {
      const parentRecord = this.activeSessions.get(parentId);
      if (parentRecord) {
        // Parent is now available, re-parse
        this.orphanedAgents.delete(filePath);
        await this.parseAndUpdateSession(filePath);
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
          await this.parseAndUpdateSession(filePath);
        }
      }
    } catch (err) {
      // Projects directory may not exist yet
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log(`Error scanning projects: ${err}`);
      }
    }
  }
}
