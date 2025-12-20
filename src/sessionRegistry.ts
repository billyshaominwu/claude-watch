import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
import { HookServer, HookEvent } from "./hookServer";
import { parseTranscript, SessionState } from "./transcriptParser";
import { cwdEquals } from "./utils";
import { log } from "./extension";

// Constants
const DEBOUNCE_MS = 150;
const SCAN_INTERVAL_MS = 2000;
const MAX_INACTIVE_SESSIONS = 100; // Limit stored inactive sessions to prevent memory leak

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
  // Parsed state from JSONL
  state: SessionState | null;
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
  }

  /**
   * Start watching for sessions
   */
  public start(): void {
    const projectsPath = this.getClaudeProjectsPath();

    // Restore persisted sessions from previous VS Code session (async, non-blocking)
    this.restorePersistedSessions().catch((err) => {
      console.error("Claude Watch: Error restoring sessions:", err);
    });

    // Initial scan for transcript state
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
    }> = [];

    for (const [, record] of this.activeSessions) {
      sessions.push({
        sessionId: record.sessionId,
        transcriptPath: record.transcriptPath,
        cwd: record.cwd,
        pid: record.pid,
        ppid: record.ppid,
        tty: record.tty,
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
    }>>(SessionRegistry.STORAGE_KEY, []);

    log(`Restoring ${sessions.length} persisted sessions`);

    // Get running Claude PIDs (async to avoid blocking UI)
    const runningClaudePids = await this.getRunningClaudePids();
    if (runningClaudePids === null) {
      log("Could not get running Claude PIDs");
      return;
    }

    let restoredCount = 0;
    for (const session of sessions) {
      // Only restore if Claude process is still running
      if (!runningClaudePids.has(session.pid)) {
        log(`Session ${session.sessionId} PID ${session.pid} no longer running, skipping`);
        continue;
      }

      // Filter by workspace
      if (this.workspacePath && !cwdEquals(session.cwd, this.workspacePath)) {
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
        state: null,
      };

      this.activeSessions.set(session.sessionId, record);
      this.pidIndex.set(session.pid, session.sessionId);
      this.ppidIndex.set(session.ppid, session.sessionId);
      this.pathIndex.set(session.transcriptPath, session.sessionId);

      // Parse transcript for state
      this.parseAndUpdateSession(session.transcriptPath);
      restoredCount++;
    }

    log(`Restored ${restoredCount} sessions`);
    if (restoredCount > 0) {
      this.notifyUpdate();
    }
  }

  /**
   * Get PIDs of running Claude processes (non-blocking)
   */
  private async getRunningClaudePids(): Promise<Set<number> | null> {
    try {
      const { stdout } = await execAsync(
        "ps -eo pid,comm | grep -E '[c]laude$' | awk '{print $1}' || true"
      );
      const pids = new Set<number>();
      for (const line of stdout.trim().split("\n")) {
        const pid = parseInt(line.trim(), 10);
        if (!isNaN(pid)) {
          pids.add(pid);
        }
      }
      return pids;
    } catch {
      return null;
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
    const record: SessionRecord = {
      sessionId: event.sessionId,
      transcriptPath: event.transcriptPath,
      cwd: event.cwd,
      pid: event.pid,
      ppid: event.ppid,
      tty: event.tty,
      state: null,
    };

    // Store and index
    this.activeSessions.set(event.sessionId, record);
    this.pidIndex.set(event.pid, event.sessionId);
    this.ppidIndex.set(event.ppid, event.sessionId);
    this.pathIndex.set(event.transcriptPath, event.sessionId);

    // Persist to survive VS Code reload
    this.persistSessions();

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

      sessions.push(record.state);
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
    return sessions.sort((a, b) => b.lastModified - a.lastModified).slice(0, 20);
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
    if (!record) return undefined;

    // First, try direct PPID lookup (works when hook registered the session)
    for (const terminal of vscode.window.terminals) {
      const terminalPid = await terminal.processId;
      if (terminalPid === record.ppid) {
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
            return terminal;
          }
        }
      } catch {
        // Ignore errors in fallback
      }
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
    // Get running Claude PIDs (async to avoid blocking UI)
    const runningClaudePids = await this.getRunningClaudePids();
    if (runningClaudePids === null) {
      // If we can't check, don't clean anything
      return 0;
    }

    // Find sessions whose Claude process is no longer running
    const orphanedSessionIds: string[] = [];
    for (const [sessionId, record] of this.activeSessions) {
      if (!runningClaudePids.has(record.pid)) {
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
