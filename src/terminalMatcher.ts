import * as vscode from "vscode";
import * as path from "path";
import { TerminalTracker } from "./terminalTracker";
import { SessionState } from "./transcriptParser";
import { cwdEquals } from "./utils";

interface ClaudeProcess {
  pid: number;
  ppid: number;
  tty: string;
  cwd: string;
  startTime: number;
  sessionFile?: string;
}

// Callback to get session mapping from SessionManager
type GetSessionMappingFn = (filePath: string) => { tty: string; pid: number; startTime: number } | undefined;

/**
 * Matches Claude sessions to VSCode terminals.
 *
 * Uses the session→process mapping from SessionManager when available,
 * falling back to greedy temporal matching if needed.
 */
export class TerminalMatcher {
  private terminalTracker: TerminalTracker;
  private getSessionMapping: GetSessionMappingFn | null = null;

  constructor(terminalTracker: TerminalTracker) {
    this.terminalTracker = terminalTracker;
  }

  /**
   * Set the callback to get session mappings from SessionManager
   */
  public setGetSessionMapping(fn: GetSessionMappingFn): void {
    this.getSessionMapping = fn;
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    // No resources to dispose currently
  }

  /**
   * Find the terminal for a given session.
   *
   * Simple approach:
   * 1. Find Claude process(es) in the session's CWD
   * 2. If multiple, use greedy temporal matching to find the right process
   * 3. Find terminal by matching Claude's parent PID to terminal.processId
   *
   * @param session The session to find a terminal for
   * @param allSessions All known sessions (for matching multiple sessions in same CWD)
   */
  public findTerminalForSession(
    session: SessionState,
    allSessions: SessionState[] = []
  ): vscode.Terminal | undefined {
    if (!session.cwd) {
      return undefined;
    }

    // Strategy 1: Use session mapping from SessionManager (most reliable)
    if (this.getSessionMapping) {
      const mapping = this.getSessionMapping(session.filePath);
      if (mapping) {
        // Find the process by TTY
        const processes = this.terminalTracker.getClaudeProcessesWithTerminals();
        const mappedProcess = processes.find(
          (p) => p.tty === mapping.tty && p.pid === mapping.pid
        );
        if (mappedProcess) {
          const terminal = this.findTerminalByParentPid(mappedProcess);
          if (terminal) {
            return terminal;
          }
        }
      }
    }

    // Strategy 2: Find processes and match
    const processes = this.terminalTracker.getClaudeProcessesWithTerminals();
    const matchingProcesses = processes.filter((p) => cwdEquals(p.cwd, session.cwd));

    if (matchingProcesses.length === 0) {
      return undefined;
    }

    let targetProcess: ClaudeProcess;

    if (matchingProcesses.length === 1) {
      targetProcess = matchingProcesses[0];
    } else {
      // Multiple processes - use greedy temporal matching
      const sessionsInCwd = allSessions
        .filter((s) => !s.isAgent && cwdEquals(s.cwd, session.cwd) && s.lastUserPrompt)
        .sort((a, b) => a.created - b.created);

      const sessionToProcess = this.buildSessionToProcessMap(sessionsInCwd, matchingProcesses);
      targetProcess = sessionToProcess.get(session.filePath) || matchingProcesses[0];
    }

    return this.findTerminalByParentPid(targetProcess);
  }

  /**
   * Find a terminal by matching Claude's parent PID (the shell) to terminal.processId
   */
  private findTerminalByParentPid(proc: ClaudeProcess): vscode.Terminal | undefined {
    // Use cached PID->Terminal lookup (no async needed)
    return this.terminalTracker.getTerminalByPid(proc.ppid) || this.findTerminalByHeuristics(proc);
  }

  /**
   * Build a mapping from session file paths to processes using greedy temporal matching.
   * For each session (in creation order), find the unclaimed process with the closest start time.
   * This handles /clear correctly because newer sessions will match to remaining processes.
   */
  private buildSessionToProcessMap(
    sessions: SessionState[],
    processes: ClaudeProcess[]
  ): Map<string, ClaudeProcess> {
    const result = new Map<string, ClaudeProcess>();
    const claimedProcesses = new Set<string>(); // Track by TTY

    for (const session of sessions) {
      let bestProcess: ClaudeProcess | null = null;
      let bestDiff = Infinity;

      for (const proc of processes) {
        if (claimedProcesses.has(proc.tty)) {
          continue; // Already claimed
        }

        // Calculate time difference (prefer process that started before or at session creation)
        const diff = Math.abs(session.created - proc.startTime);

        // Prefer processes that started BEFORE the session was created
        // Add a penalty for processes that started AFTER (indicates /clear scenario)
        const adjustedDiff = proc.startTime <= session.created ? diff : diff + 1000000;

        if (adjustedDiff < bestDiff) {
          bestDiff = adjustedDiff;
          bestProcess = proc;
        }
      }

      if (bestProcess) {
        result.set(session.filePath, bestProcess);
        claimedProcesses.add(bestProcess.tty);
        console.log(`Claude Watch: Greedy match - session created=${session.created} -> process started=${bestProcess.startTime} (diff=${bestDiff})`);
      }
    }

    return result;
  }

  /**
   * Find a terminal by name heuristics when TTY matching fails
   */
  private findTerminalByHeuristics(proc: ClaudeProcess): vscode.Terminal | undefined {
    const terminals = vscode.window.terminals;
    const projectName = path.basename(proc.cwd).toLowerCase();

    // Try to match by terminal name
    for (const terminal of terminals) {
      const name = terminal.name.toLowerCase();
      // Prefer terminals with "claude" and the project name in their title
      if (name.includes("claude") && name.includes(projectName)) {
        return terminal;
      }
    }

    // Try just "claude" in the name
    for (const terminal of terminals) {
      if (terminal.name.toLowerCase().includes("claude")) {
        return terminal;
      }
    }

    return undefined;
  }

  /**
   * Show the terminal for a session
   * @param session The session to show the terminal for
   * @param allSessions All known sessions (for matching multiple sessions in same CWD)
   */
  public showTerminalForSession(
    session: SessionState,
    allSessions: SessionState[] = []
  ): boolean {
    const terminal = this.findTerminalForSession(session, allSessions);
    if (terminal) {
      terminal.show();
      return true;
    }
    return false;
  }
}
