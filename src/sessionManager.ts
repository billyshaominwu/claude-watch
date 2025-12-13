import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { parseTranscript, SessionState } from "./transcriptParser";
import { TerminalTracker } from "./terminalTracker";
import { SessionProcessMap } from "./sessionProcessMap";
import { cwdEquals } from "./utils";

// Constants
const SCAN_INTERVAL_MS = 2000; // Interval for periodic session scanning
const DEBOUNCE_MS = 150; // Debounce delay for update notifications
const NEW_PROCESS_GRACE_PERIOD_MS = 5000; // Don't use fallback for very new processes

export class SessionManager {
  private sessions: Map<string, SessionState> = new Map();
  private fileLastModified: Map<string, number> = new Map(); // Track file mtimes to skip unchanged files
  private watcher: vscode.FileSystemWatcher | null = null;
  private scanInterval: NodeJS.Timeout | null = null;
  private onUpdateCallback: ((sessions: SessionState[]) => void) | null = null;
  private onInactiveUpdateCallback: ((sessions: SessionState[]) => void) | null = null;
  private terminalTracker: TerminalTracker;
  private workspacePath: string | undefined;
  private debounceTimer: NodeJS.Timeout | null = null;
  // Track files currently being parsed to prevent concurrent parsing (Issue 6)
  private parsingFiles: Set<string> = new Set();
  // Track orphaned agents that need parent re-validation (Issue 1)
  private orphanedAgents: Map<string, string> = new Map(); // filePath -> parentSessionId
  // Persistent session-to-process mapping
  private sessionMap: SessionProcessMap;
  // Sessions awaiting process association (file created before process detected)
  private pendingAssociations: Set<string> = new Set();

  constructor(terminalTracker: TerminalTracker, sessionMap: SessionProcessMap, workspacePath?: string) {
    this.terminalTracker = terminalTracker;
    this.sessionMap = sessionMap;
    this.workspacePath = workspacePath;

    // When a terminal closes, remove sessions in that cwd
    this.terminalTracker.onTerminalClosed((cwd) => {
      this.removeSessionsByCwd(cwd);
    });

    // When terminal cwds are updated, refresh the session list and retry pending associations
    this.terminalTracker.onCwdsUpdated(() => {
      this.retryPendingAssociations();
      this.validateSessionMappings();
      this.notifyUpdate();
    });
  }

  private getClaudeProjectsPath(): string {
    return path.join(os.homedir(), ".claude", "projects");
  }

  public start(): void {
    const projectsPath = this.getClaudeProjectsPath();

    // Initial scan, then run recovery to fix any stale mappings
    this.scanAllProjects()
      .then(() => {
        // Run recovery after initial scan completes
        this.recoverMappings();
      })
      .catch((err) => {
        console.error("Error in initial scan:", err);
      });

    // Watch for changes to JSONL files
    const pattern = new vscode.RelativePattern(projectsPath, "**/*.jsonl");
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    this.watcher.onDidChange((uri) => this.handleFileChange(uri));
    this.watcher.onDidCreate((uri) => this.handleFileChange(uri));
    this.watcher.onDidDelete((uri) => this.handleFileDelete(uri));

    // Periodic scan to catch any missed updates, clean stale sessions, and run health checks
    this.scanInterval = setInterval(() => {
      this.scanAllProjects()
        .then(() => {
          // Run recovery periodically to self-heal any inconsistent state
          this.recoverMappings();
        })
        .catch((err) => {
          console.error("Error in periodic scan:", err);
        });
    }, SCAN_INTERVAL_MS);
  }

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
    // Flush any pending saves
    this.sessionMap.flush();
  }

  public onUpdate(callback: (sessions: SessionState[]) => void): void {
    this.onUpdateCallback = callback;
  }

  public onInactiveUpdate(callback: (sessions: SessionState[]) => void): void {
    this.onInactiveUpdateCallback = callback;
  }

  public getActiveSessions(): SessionState[] {
    const allSessions = Array.from(this.sessions.values());
    console.log(`Claude Watch: Total sessions found: ${allSessions.length}`);

    // Filter to only sessions in the current workspace
    // Use cwdEquals for proper path comparison (handles trailing slashes, case sensitivity on macOS)
    const workspaceSessions = this.workspacePath
      ? allSessions.filter((s) => cwdEquals(s.cwd, this.workspacePath!))
      : allSessions;
    console.log(`Claude Watch: Sessions in workspace: ${workspaceSessions.length}`);

    const activeSessions = workspaceSessions.filter((s) => this.isSessionActive(s));
    console.log(`Claude Watch: Active sessions: ${activeSessions.length}`);

    // Sort by created (most recent first) for stable display order
    // Note: terminalMatcher uses lastModified internally for accurate process matching,
    // so display order and matching order are intentionally decoupled
    return activeSessions.sort((a, b) => b.created - a.created);
  }

  /**
   * Get inactive sessions (sessions without a running Claude process).
   * Used by the "Old Sessions" tree view.
   */
  public getInactiveSessions(): SessionState[] {
    const allSessions = Array.from(this.sessions.values());

    // Filter to only sessions in the current workspace
    const workspaceSessions = this.workspacePath
      ? allSessions.filter((s) => cwdEquals(s.cwd, this.workspacePath!))
      : allSessions;

    // Filter to inactive, non-agent sessions with displayable content
    // Exclude phantom sessions and sessions without user prompts
    const inactiveSessions = workspaceSessions.filter(
      (s) => !s.isAgent && s.lastUserPrompt && !this.isSessionActive(s)
    );

    // Sort by lastModified (most recent first)
    return inactiveSessions.sort((a, b) => b.lastModified - a.lastModified);
  }

  /**
   * Issue 2: Allow tree provider to query current sessions directly
   * This prevents stale state issues when the tree provider's cached sessions
   * lag behind the session manager's current state
   */
  public findSessionBySessionId(sessionId: string, excludeAgents: boolean = false): SessionState | undefined {
    return Array.from(this.sessions.values()).find(
      (s) => s.sessionId === sessionId && (!excludeAgents || !s.isAgent)
    );
  }

  /**
   * Get the TTY mapping for a session file (for TerminalMatcher).
   */
  public getSessionTty(filePath: string): string | undefined {
    return this.sessionMap.getTty(filePath);
  }

  /**
   * Get the full process mapping for a session file (for TerminalMatcher validation).
   */
  public getSessionMapping(filePath: string): { tty: string; pid: number; startTime: number } | undefined {
    return this.sessionMap.get(filePath);
  }

  /**
   * Get all sessions (for internal use).
   */
  public getAllSessions(): Map<string, SessionState> {
    return this.sessions;
  }

  /**
   * Check if a session is active based on terminal state and process mapping.
   * This is a READ-ONLY check - it does not modify state.
   * Association/mapping is handled by associateSession() called from file handlers and recovery.
   */
  private isSessionActive(state: SessionState): boolean {
    // Agents are active if their parent session is active AND they have real activity
    if (state.isAgent) {
      if (!state.parentSessionId || !state.hasRealActivity) {
        return false;
      }
      const parentSession = Array.from(this.sessions.values()).find(
        (s) => s.sessionId === state.parentSessionId && !s.isAgent
      );
      if (!parentSession) {
        this.orphanedAgents.set(state.filePath, state.parentSessionId);
        return false;
      }
      this.orphanedAgents.delete(state.filePath);
      return this.isSessionActive(parentSession);
    }

    // Main sessions must have displayable content (a real user prompt)
    if (!state.lastUserPrompt) {
      return false;
    }

    // Main sessions require a Claude process in their CWD that is connected to a VS Code terminal
    // Using getClaudeProcessesWithTerminals() filters out stale processes from closed terminals
    const allProcesses = this.terminalTracker.getClaudeProcessesWithTerminals();
    const processesInCwd = allProcesses.filter((p) => cwdEquals(p.cwd, state.cwd));
    const processCount = processesInCwd.length;

    if (processCount === 0) {
      return false;
    }

    // Simple rule: show the N most recent sessions where N = number of processes
    // This handles all cases: new sessions, old sessions, /clear scenarios
    const sessionsInCwd = Array.from(this.sessions.values())
      .filter((s) => !s.isAgent && cwdEquals(s.cwd, state.cwd) && s.lastUserPrompt)
      .sort((a, b) => b.lastModified - a.lastModified)
      .slice(0, processCount);

    return sessionsInCwd.some((s) => s.filePath === state.filePath);
  }

  /**
   * Remove all sessions in a given working directory
   */
  public removeSessionsByCwd(cwd: string): void {
    let removed = false;
    for (const [filePath, session] of this.sessions) {
      if (cwdEquals(session.cwd, cwd)) {
        this.sessions.delete(filePath);
        this.fileLastModified.delete(filePath);
        this.sessionMap.delete(filePath);
        this.pendingAssociations.delete(filePath);
        removed = true;
      }
    }
    if (removed) {
      this.notifyUpdate();
    }
  }

  /**
   * Retry associating sessions that were created before their process was detected.
   */
  private retryPendingAssociations(): void {
    if (this.pendingAssociations.size === 0) return;

    const toRetry = Array.from(this.pendingAssociations);
    for (const filePath of toRetry) {
      const state = this.sessions.get(filePath);
      if (!state || state.isAgent) {
        this.pendingAssociations.delete(filePath);
        continue;
      }

      // associateSession will either succeed or re-add to pending
      this.pendingAssociations.delete(filePath);
      this.associateSession(filePath, state);
    }
  }

  /**
   * Validate session mappings against current processes.
   * Removes stale mappings for processes that no longer exist.
   */
  private validateSessionMappings(): void {
    const processes = this.terminalTracker.getClaudeProcessesWithTerminals();
    this.sessionMap.validateAgainstProcesses(processes);
  }

  /**
   * Recovery: Clean up stale mappings and re-establish correct session-to-process associations.
   * Called on startup to fix any inconsistent state from /clear or crashes.
   */
  public recoverMappings(): void {
    console.log("Claude Watch: Running mapping recovery...");

    // Step 1: Validate against current processes (remove dead mappings)
    this.validateSessionMappings();

    // Step 2: Find TTYs with multiple sessions mapped (stale /clear scenarios)
    const allMappings = this.sessionMap.getAllMappings();
    const ttyToSessions = new Map<string, { filePath: string; created: number }[]>();

    for (const [filePath, mapping] of allMappings) {
      const session = this.sessions.get(filePath);
      if (!session || session.isAgent) continue;

      const existing = ttyToSessions.get(mapping.tty) || [];
      existing.push({ filePath, created: session.created });
      ttyToSessions.set(mapping.tty, existing);
    }

    // Step 3: For TTYs with multiple sessions, keep only the most recent
    const sessionsToKeep = new Map<string, string>(); // TTY -> filePath to keep
    for (const [tty, sessions] of ttyToSessions) {
      if (sessions.length > 1) {
        // Sort by created DESC (most recent first)
        sessions.sort((a, b) => b.created - a.created);
        sessionsToKeep.set(tty, sessions[0].filePath);
        console.log(`Claude Watch: Recovery - TTY ${tty} has ${sessions.length} sessions, keeping most recent`);
      }
    }

    if (sessionsToKeep.size > 0) {
      const removed = this.sessionMap.deduplicateByTty(sessionsToKeep);
      console.log(`Claude Watch: Recovery - removed ${removed} duplicate mapping(s)`);
    }

    // Step 4: Try to associate unmapped sessions, but only if they're recent
    // This prevents historical sessions from being incorrectly associated with current processes
    const processes = this.terminalTracker.getClaudeProcessesWithTerminals();
    for (const [filePath, session] of this.sessions) {
      if (session.isAgent) continue;
      if (this.sessionMap.get(filePath)) continue; // Already mapped
      if (this.workspacePath && session.cwd !== this.workspacePath) continue; // Not in workspace

      // Only associate sessions that were created/modified after the oldest running process started
      // This prevents historical sessions from stealing mappings from current sessions
      const processesInCwd = processes.filter((p) => cwdEquals(p.cwd, session.cwd));
      if (processesInCwd.length === 0) continue;

      const oldestProcessStart = Math.min(...processesInCwd.map((p) => p.startTime));
      // Session must have been modified after the process started (with some buffer for timing)
      const TIMING_BUFFER_MS = 60000; // 1 minute buffer
      if (session.lastModified < oldestProcessStart - TIMING_BUFFER_MS) {
        // This is a historical session - don't associate it
        continue;
      }

      this.associateSession(filePath, session);
    }

    console.log("Claude Watch: Mapping recovery complete");
  }

  private handleFileChange(uri: vscode.Uri): void {
    const filePath = uri.fsPath;

    // Only process .jsonl files that look like session transcripts (UUID format)
    const fileName = path.basename(filePath, ".jsonl");
    if (!this.isUUID(fileName) && !fileName.startsWith("agent-")) {
      return;
    }

    // Issue 6: Prevent concurrent parsing of the same file
    if (this.parsingFiles.has(filePath)) {
      return;
    }

    const isNewFile = !this.sessions.has(filePath);

    this.parsingFiles.add(filePath);
    try {
      const state = parseTranscript(filePath);
      if (state) {
        this.sessions.set(filePath, state);
        // Update mtime cache so periodic scan doesn't re-parse unnecessarily
        this.fileLastModified.set(filePath, state.lastModified);

        // Try to establish process mapping for non-agent sessions
        if (!state.isAgent) {
          // Single entry point for all session-to-process association
          this.associateSession(filePath, state);

          // Issue 1: Re-validate orphaned agents
          this.revalidateOrphanedAgents(state.sessionId);
        }

        // Remove from pending if it was waiting
        this.pendingAssociations.delete(filePath);

        this.notifyUpdate();
      }
    } finally {
      this.parsingFiles.delete(filePath);
    }
  }

  /**
   * Single entry point for associating a session file with a process.
   * Consolidates all mapping logic to ensure consistent behavior.
   *
   * Strategy (in order of reliability):
   * 1. Try lsof to find process with this exact session file open
   * 2. If single process in CWD, use it
   * 3. If multiple processes, match by closest start time to session creation
   * 4. If no processes found, queue for retry
   */
  private associateSession(filePath: string, state: SessionState): void {
    const cwd = state.cwd;
    if (!cwd) return;

    // Skip if already has a valid mapping
    const existingMapping = this.sessionMap.get(filePath);
    if (existingMapping) {
      const processes = this.terminalTracker.getClaudeProcessesWithTerminals();
      const mappingValid = processes.some(
        (p) => p.tty === existingMapping.tty && p.pid === existingMapping.pid && p.startTime === existingMapping.startTime
      );
      if (mappingValid) {
        return; // Current mapping is still valid
      }
      // Mapping is stale, will be replaced below
    }

    // Strategy 1: Try lsof to find process with this session file open (most reliable)
    const procWithFile = this.terminalTracker.getClaudeProcessBySessionFile(filePath);
    if (procWithFile) {
      this.sessionMap.set(filePath, procWithFile.tty, procWithFile.pid, procWithFile.startTime);
      console.log(`Claude Watch: Associated session via lsof -> TTY ${procWithFile.tty}`);
      return;
    }

    // Get all Claude processes in this CWD (only those connected to VS Code terminals)
    const processesInCwd = this.terminalTracker.getClaudeProcessesWithTerminals()
      .filter((p) => cwdEquals(p.cwd, cwd));

    // Strategy 2: No processes - queue for retry
    if (processesInCwd.length === 0) {
      this.pendingAssociations.add(filePath);
      console.log(`Claude Watch: No process found for session, queuing for retry`);
      return;
    }

    // Strategy 3: Single process - confident match
    if (processesInCwd.length === 1) {
      const proc = processesInCwd[0];
      this.sessionMap.set(filePath, proc.tty, proc.pid, proc.startTime);
      return;
    }

    // Strategy 4: Multiple processes - find best match
    // First try unassigned processes
    const unassignedProcesses = processesInCwd.filter((p) => !this.sessionMap.hasTty(p.tty));
    const candidateProcesses = unassignedProcesses.length > 0 ? unassignedProcesses : processesInCwd;

    // Match to process with closest start time to session file creation
    const fileCreated = state.created;
    const bestMatch = candidateProcesses.reduce((best, proc) => {
      const diff = Math.abs(proc.startTime - fileCreated);
      const bestDiff = Math.abs(best.startTime - fileCreated);
      return diff < bestDiff ? proc : best;
    });

    // Note: set() automatically enforces one-session-per-TTY invariant
    this.sessionMap.set(filePath, bestMatch.tty, bestMatch.pid, bestMatch.startTime);
  }

  /**
   * Issue 1: Re-validate orphaned agents when their parent becomes available
   */
  private revalidateOrphanedAgents(parentSessionId: string): void {
    const agentsToRevalidate: string[] = [];
    for (const [filePath, orphanParentId] of this.orphanedAgents) {
      if (orphanParentId === parentSessionId) {
        agentsToRevalidate.push(filePath);
      }
    }

    for (const filePath of agentsToRevalidate) {
      this.orphanedAgents.delete(filePath);
      // Re-parse the agent file now that parent exists
      if (this.sessions.has(filePath)) {
        // Already in sessions, just need to trigger update
        console.log(`Claude Watch: Re-validating orphaned agent for parent ${parentSessionId.slice(0, 8)}`);
      }
    }
  }

  private handleFileDelete(uri: vscode.Uri): void {
    const filePath = uri.fsPath;

    // Check if process still exists before cleaning up mapping
    const mapping = this.sessionMap.get(filePath);
    if (mapping) {
      const proc = this.terminalTracker.getClaudeProcessesWithTerminals()
        .find((p) => p.tty === mapping.tty && p.pid === mapping.pid);
      if (proc) {
        console.log(`Claude Watch: Session file deleted but process alive, awaiting new session`);
      }
      this.sessionMap.delete(filePath);
    }

    this.sessions.delete(filePath);
    this.fileLastModified.delete(filePath);
    this.pendingAssociations.delete(filePath);
    this.notifyUpdate();
  }

  public removeSession(filePath: string): void {
    const session = this.sessions.get(filePath);
    this.sessions.delete(filePath);
    this.fileLastModified.delete(filePath);
    this.sessionMap.delete(filePath);
    this.pendingAssociations.delete(filePath);

    // If this is a main session, also remove its child agents
    if (session && !session.isAgent) {
      for (const [agentPath, s] of this.sessions) {
        if (s.isAgent && s.parentSessionId === session.sessionId) {
          this.sessions.delete(agentPath);
          this.fileLastModified.delete(agentPath);
        }
      }
    }

    this.notifyUpdate();
  }

  private async scanAllProjects(): Promise<void> {
    const projectsPath = this.getClaudeProjectsPath();

    // Check if projects path exists
    try {
      await fs.promises.access(projectsPath);
    } catch {
      return; // Path doesn't exist
    }

    try {
      const projectDirs = await fs.promises.readdir(projectsPath);

      for (const projectDir of projectDirs) {
        try {
          const projectPath = path.join(projectsPath, projectDir);
          const stat = await fs.promises.stat(projectPath);

          if (!stat.isDirectory()) {
            continue;
          }

          const files = await fs.promises.readdir(projectPath);
          for (const file of files) {
            if (!file.endsWith(".jsonl")) {
              continue;
            }

            const fileName = path.basename(file, ".jsonl");
            // Only process UUID-named files or agent files
            if (!this.isUUID(fileName) && !fileName.startsWith("agent-")) {
              continue;
            }

            try {
              const filePath = path.join(projectPath, file);
              const fileStat = await fs.promises.stat(filePath);
              const lastMtime = this.fileLastModified.get(filePath);

              // Skip re-parsing if file hasn't changed
              if (lastMtime && lastMtime === fileStat.mtimeMs) {
                continue;
              }

              // Issue 6: Skip if file is currently being parsed by file watcher
              if (this.parsingFiles.has(filePath)) {
                continue;
              }

              this.parsingFiles.add(filePath);
              try {
                const state = parseTranscript(filePath);

                if (state) {
                  this.sessions.set(filePath, state);
                  this.fileLastModified.set(filePath, fileStat.mtimeMs);

                  // Issue 1: If this is a new parent session, re-validate orphaned agents
                  if (!state.isAgent) {
                    this.revalidateOrphanedAgents(state.sessionId);
                  }
                }
              } finally {
                this.parsingFiles.delete(filePath);
              }
            } catch (fileErr) {
              // Skip individual file errors, continue with other files
              console.warn(`Error parsing transcript ${file}:`, fileErr);
            }
          }
        } catch (dirErr) {
          // Skip individual directory errors, continue with other directories
          console.warn(`Error scanning project directory ${projectDir}:`, dirErr);
        }
      }

      // Notify update (will debounce and check for meaningful changes)
      this.notifyUpdate();
    } catch (err) {
      console.error("Error scanning Claude projects:", err);
    }
  }

  private lastSessionHash: string = "";

  private hashSessions(sessions: SessionState[]): string {
    return sessions
      .map((s) => `${s.filePath}:${s.currentTask}:${s.status}:${s.inProgressTask}:${s.lastUserPrompt}:${s.contextTokens}:${s.tokenUsage.outputTokens}:${s.tokenUsage.cacheReadTokens}`)
      .join("|");
  }

  private isUUID(str: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(str);
  }

  private notifyUpdate(): void {
    // Debounce updates to prevent flickering from rapid file changes
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      // Issue 5: After debounce, re-check orphaned agents one more time
      // This handles the case where parent was added during debounce window
      this.recheckAllOrphanedAgents();
      this.doNotifyUpdate();
    }, DEBOUNCE_MS);
  }

  /**
   * Issue 5: Re-check all orphaned agents after debounce completes
   * This catches agents whose parents were added during the debounce window
   */
  private recheckAllOrphanedAgents(): void {
    if (this.orphanedAgents.size === 0) {
      return;
    }

    const stillOrphaned = new Map<string, string>();
    for (const [filePath, parentSessionId] of this.orphanedAgents) {
      const parentExists = Array.from(this.sessions.values()).some(
        (s) => s.sessionId === parentSessionId && !s.isAgent
      );
      if (!parentExists) {
        stillOrphaned.set(filePath, parentSessionId);
      } else {
        console.log(`Claude Watch: Orphaned agent at ${path.basename(filePath)} now has parent ${parentSessionId.slice(0, 8)}`);
      }
    }
    this.orphanedAgents = stillOrphaned;
  }

  private doNotifyUpdate(): void {
    // Notify active sessions callback
    if (this.onUpdateCallback) {
      const activeSessions = this.getActiveSessions();
      const newHash = this.hashSessions(activeSessions);
      if (newHash !== this.lastSessionHash) {
        this.lastSessionHash = newHash;
        this.onUpdateCallback(activeSessions);
      }
    }

    // Notify inactive sessions callback
    if (this.onInactiveUpdateCallback) {
      const inactiveSessions = this.getInactiveSessions();
      this.onInactiveUpdateCallback(inactiveSessions);
    }
  }
}
