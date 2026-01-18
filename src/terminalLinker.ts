import * as vscode from "vscode";
import { exec } from "child_process";
import { promisify } from "util";
import { log } from "./extension";

const execAsync = promisify(exec);

// Constants
const MAX_PENDING_TERMINALS = 50; // Limit pending terminals to prevent memory leak

/**
 * TerminalLinker - manages terminal-to-session linking.
 *
 * Handles:
 * - Pending terminal registration (before hook fires)
 * - Linked terminal storage and lookup
 * - Terminal cleanup on close
 * - Lazy linking for sessions started before extension activation
 * - Process ancestry lookup for terminal matching
 */
export class TerminalLinker {
  // Linked terminals - terminal references for sessions we can navigate to
  private linkedTerminals: Map<string, vscode.Terminal> = new Map(); // sessionId -> Terminal
  private terminalToSession: WeakMap<vscode.Terminal, string> = new WeakMap(); // Terminal -> sessionId (WeakMap for GC)
  private pendingTerminals: Map<string, vscode.Terminal> = new Map(); // terminalId -> Terminal (waiting for hook)

  // Callback to notify registry of updates
  private onUpdateCallback: (() => void) | null = null;

  /**
   * Set callback for when terminal linking changes require a tree refresh
   */
  public onUpdate(callback: () => void): void {
    this.onUpdateCallback = callback;
  }

  private notifyUpdate(): void {
    if (this.onUpdateCallback) {
      this.onUpdateCallback();
    }
  }

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
   * Check if a session has a linked terminal
   */
  public hasLinkedTerminal(sessionId: string): boolean {
    return this.linkedTerminals.has(sessionId);
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
   * Remove linked terminal for a session (for session cleanup)
   */
  public removeLinkedTerminal(sessionId: string): void {
    this.linkedTerminals.delete(sessionId);
  }

  /**
   * Link a pending terminal to a session when SessionStart hook fires.
   * Uses async processId check (not sync spawn).
   */
  public async linkPendingTerminal(sessionId: string, ppid: number): Promise<void> {
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
   *
   * @param sessionId - The session ID to link
   * @param ppid - The parent PID from the hook
   * @param pid - The Claude process PID (optional, for ancestor search)
   * @param updatePpidCallback - Callback to update the session's PPID if ancestor match found
   */
  public async tryLazyLink(
    sessionId: string,
    ppid: number,
    pid?: number,
    updatePpidCallback?: (newPpid: number) => void
  ): Promise<void> {
    // Collect terminal PIDs for logging
    const terminalPids: number[] = [];
    for (const terminal of vscode.window.terminals) {
      try {
        const termPid = await terminal.processId;
        if (termPid) terminalPids.push(termPid);
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

    // Fallback: search for terminal that has Claude (pid) as a descendant
    // This handles cases where there's an intermediate shell between terminal and Claude
    if (pid) {
      try {
        const ancestorPids = await this.getProcessAncestors(pid);

        for (const terminal of vscode.window.terminals) {
          try {
            const terminalPid = await terminal.processId;
            if (terminalPid && ancestorPids.has(terminalPid)) {
              // Update the record with the correct PPID for future lookups
              if (updatePpidCallback) {
                updatePpidCallback(terminalPid);
              }

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
        log(`tryLazyLink FAILED for session ${sessionId}: ppid=${ppid}, pid=${pid}, ancestors=[${[...ancestorPids].join(',')}], terminalPids=[${terminalPids.join(',')}]`);
      } catch {
        // Ignore errors in fallback
      }
    } else {
      log(`tryLazyLink FAILED for session ${sessionId}: ppid=${ppid}, no pid provided, terminalPids=[${terminalPids.join(',')}]`);
    }
  }

  /**
   * Check if a session can be linked to a VS Code terminal.
   * Returns true if the session's PPID matches a terminal or if any ancestor is a terminal.
   */
  public async canLinkToVSCodeTerminal(pid: number, ppid: number): Promise<boolean> {
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
   * Find terminal for a session by searching all terminals.
   * First tries direct PPID lookup, then searches for terminals with Claude as descendant.
   *
   * @param ppid - The parent PID to match
   * @param pid - The Claude process PID (optional, for ancestor search)
   * @param updatePpidCallback - Callback to update the session's PPID if ancestor match found
   */
  public async findTerminalByPid(
    ppid: number,
    pid?: number,
    updatePpidCallback?: (newPpid: number) => void
  ): Promise<vscode.Terminal | undefined> {
    // Collect terminal PIDs for logging
    const terminalPids: number[] = [];
    for (const terminal of vscode.window.terminals) {
      try {
        const termPid = await terminal.processId;
        if (termPid) terminalPids.push(termPid);
      } catch {
        // ignore
      }
    }

    // First, try direct PPID lookup (works when hook registered the session)
    for (const terminal of vscode.window.terminals) {
      const terminalPid = await terminal.processId;
      if (terminalPid === ppid) {
        return terminal;
      }
    }

    // Fallback: search for terminal that has Claude (pid) as a descendant
    // This handles VS Code reload case where terminal.processId changed
    if (pid) {
      try {
        // Get the full ancestor chain of the Claude process
        const ancestorPids = await this.getProcessAncestors(pid);

        for (const terminal of vscode.window.terminals) {
          const terminalPid = await terminal.processId;
          if (terminalPid && ancestorPids.has(terminalPid)) {
            // Update the PPID for future lookups
            if (updatePpidCallback) {
              updatePpidCallback(terminalPid);
            }
            return terminal;
          }
        }

        // Log failure with details
        log(`findTerminalByPid FAILED: ppid=${ppid}, pid=${pid}, ancestors=[${[...ancestorPids].join(',')}], terminalPids=[${terminalPids.join(',')}]`);
      } catch (err) {
        log(`findTerminalByPid error: ${err}`);
      }
    } else {
      log(`findTerminalByPid FAILED: ppid=${ppid}, no pid provided`);
    }

    return undefined;
  }

  /**
   * Get all ancestor PIDs of a process (non-blocking)
   */
  public async getProcessAncestors(pid: number): Promise<Set<number>> {
    const ancestors = new Set<number>();
    try {
      let currentPid = pid;
      for (let i = 0; i < 10; i++) { // Max 10 levels to avoid infinite loop
        const { stdout } = await execAsync(`ps -o ppid= -p ${currentPid} 2>/dev/null | tr -d ' '`);
        const ppidStr = stdout.trim();

        if (!ppidStr || ppidStr === "0" || ppidStr === "1") break;

        const ppidNum = parseInt(ppidStr, 10);
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
   * Clean up all resources
   */
  public dispose(): void {
    this.linkedTerminals.clear();
    this.pendingTerminals.clear();
    // WeakMap auto-cleans
  }
}
