import * as vscode from "vscode";
import { execSync } from "child_process";

/**
 * Information about a Claude process
 */
interface ClaudeProcess {
  pid: number;
  ppid: number; // Parent PID (the shell)
  tty: string;
  cwd: string;
  startTime: number;
  sessionFile?: string; // The .jsonl session file this process has open
}

/**
 * Tracks VSCode terminals and detects which ones are running Claude.
 * Uses ps/lsof to find Claude processes and match them to terminals.
 */
export class TerminalTracker {
  private terminalCwds: Map<vscode.Terminal, string> = new Map();
  private claudeProcesses: Map<string, ClaudeProcess> = new Map(); // tty -> process
  private terminalPids: Set<number> = new Set(); // PIDs of all VS Code terminal shells
  private pidToTerminal: Map<number, vscode.Terminal> = new Map(); // PID -> Terminal for fast lookup
  private refreshInterval: NodeJS.Timeout | null = null;

  private _onTerminalClosed = new vscode.EventEmitter<string>();
  public readonly onTerminalClosed = this._onTerminalClosed.event;

  private _onCwdsUpdated = new vscode.EventEmitter<void>();
  public readonly onCwdsUpdated = this._onCwdsUpdated.event;

  // Issue 8: Event to notify when a terminal's TTY cache should be invalidated
  private _onTerminalTtyInvalidated = new vscode.EventEmitter<vscode.Terminal>();
  public readonly onTerminalTtyInvalidated = this._onTerminalTtyInvalidated.event;

  private disposables: vscode.Disposable[] = [];

  constructor() {
    // Track terminal open/close events
    this.disposables.push(
      vscode.window.onDidOpenTerminal((terminal) => {
        this.refreshClaudeProcesses();
      })
    );

    this.disposables.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        const cwd = this.terminalCwds.get(terminal);
        this.terminalCwds.delete(terminal);
        // Issue 8: Notify that terminal's TTY cache should be invalidated
        this._onTerminalTtyInvalidated.fire(terminal);
        if (cwd) {
          this._onTerminalClosed.fire(cwd);
        }
      })
    );

    // Periodically refresh Claude process info and terminal PIDs
    this.refreshInterval = setInterval(() => {
      this.refreshTerminalPids().then(() => {
        this.refreshClaudeProcesses();
      });
    }, 2000);

    // Initial refresh - await terminal PIDs before process detection
    this.refreshTerminalPids().then(() => {
      this.refreshClaudeProcesses();
    });
  }

  /**
   * Refresh the set of VS Code terminal shell PIDs
   */
  private async refreshTerminalPids(): Promise<void> {
    // Collect all PIDs and build PID->Terminal map
    const newPids = new Set<number>();
    const newPidToTerminal = new Map<number, vscode.Terminal>();
    const terminals = vscode.window.terminals;
    const pids = await Promise.all(terminals.map((t) => t.processId));

    for (let i = 0; i < terminals.length; i++) {
      const pid = pids[i];
      if (pid !== undefined) {
        newPids.add(pid);
        newPidToTerminal.set(pid, terminals[i]);
      }
    }

    this.terminalPids = newPids;
    this.pidToTerminal = newPidToTerminal;
  }

  /**
   * Get the parent PID of a process
   */
  private getParentPid(pid: number): number | undefined {
    try {
      const output = execSync(`ps -p ${pid} -o ppid= 2>/dev/null`, {
        encoding: "utf-8",
        timeout: 1000,
      }).trim();
      return output ? parseInt(output, 10) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Refresh the list of Claude processes by querying the system
   */
  private refreshClaudeProcesses(): void {
    try {
      // Find all Claude CLI processes (include PPID for terminal matching)
      const psOutput = execSync(
        "ps -eo pid,ppid,tty,lstart,comm 2>/dev/null | grep -E 'claude$' || true",
        { encoding: "utf-8", timeout: 5000 }
      ).trim();

      const newProcesses = new Map<string, ClaudeProcess>();

      if (psOutput) {
        const lines = psOutput.split("\n").filter((l) => l.trim());
        console.log(`Claude Watch: Found ${lines.length} Claude process(es)`);
        for (const line of lines) {
          const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s+claude$/);
          if (match) {
            const pid = parseInt(match[1], 10);
            const ppid = parseInt(match[2], 10);
            const tty = match[3];
            const startTimeStr = match[4];

            // Get CWD and session file for this process using lsof
            let cwd = "";
            let sessionFile: string | undefined;
            try {
              // Get full lsof output to find both cwd and session file
              const lsofOutput = execSync(
                `lsof -p ${pid} 2>/dev/null`,
                { encoding: "utf-8", timeout: 5000 }
              ).trim();

              if (lsofOutput) {
                // Extract CWD - look for line with "cwd" and capture the last field (path)
                const cwdMatch = lsofOutput.match(/\bcwd\b.*\s(\/\S+)$/m);
                if (cwdMatch) {
                  cwd = cwdMatch[1];
                }
                // Extract session file - look for .jsonl files in ~/.claude/projects anywhere in output
                // Match paths like /Users/xxx/.claude/projects/xxx/uuid.jsonl
                const sessionMatch = lsofOutput.match(/(\/[^\s]+\/\.claude\/projects\/[^\s]+\.jsonl)/m);
                if (sessionMatch) {
                  sessionFile = sessionMatch[1];
                }
              }
            } catch {
              // Ignore lsof errors
            }

            if (tty !== "??" && cwd) {
              console.log(`Claude Watch: Detected Claude process pid=${pid} ppid=${ppid} tty=${tty} cwd=${cwd} session=${sessionFile || "(none)"}`);
              newProcesses.set(tty, {
                pid,
                ppid,
                tty,
                cwd,
                startTime: new Date(startTimeStr).getTime(),
                sessionFile,
              });
            } else {
              console.log(`Claude Watch: Skipping process pid=${pid} tty=${tty} cwd=${cwd || "(empty)"}`);
            }
          }
        }
      }

      // Check if anything changed
      const changed = this.hasProcessesChanged(newProcesses);
      this.claudeProcesses = newProcesses;

      // Update terminal CWDs based on Claude processes
      this.updateTerminalCwds();

      if (changed) {
        this._onCwdsUpdated.fire();
      }
    } catch (error) {
      console.error("Claude Watch: Error refreshing Claude processes:", error);
    }
  }

  /**
   * Check if the process map has changed
   */
  private hasProcessesChanged(newProcesses: Map<string, ClaudeProcess>): boolean {
    if (this.claudeProcesses.size !== newProcesses.size) {
      return true;
    }
    for (const [tty, proc] of newProcesses) {
      const existing = this.claudeProcesses.get(tty);
      if (!existing || existing.pid !== proc.pid || existing.cwd !== proc.cwd || existing.sessionFile !== proc.sessionFile) {
        return true;
      }
    }
    return false;
  }

  /**
   * Update terminal CWDs based on detected Claude processes
   */
  private updateTerminalCwds(): void {
    // For each terminal, try to match it to a Claude process
    for (const terminal of vscode.window.terminals) {
      // We can't directly get terminal TTY from VSCode API
      // So we match by checking if there's a Claude process that could belong to this terminal
      // This is a heuristic approach

      // For now, associate terminals with Claude processes based on available info
      // In practice, we'll use the TerminalMatcher for more precise matching
    }
  }

  /**
   * Get the CWD for a terminal (if known)
   */
  public getTerminalCwd(terminal: vscode.Terminal): string | undefined {
    return this.terminalCwds.get(terminal);
  }

  /**
   * Get all Claude processes
   */
  public getClaudeProcesses(): ClaudeProcess[] {
    return Array.from(this.claudeProcesses.values());
  }

  /**
   * Get Claude processes that are connected to VS Code terminals.
   * Filters to only processes whose parent shell PID is a known terminal PID.
   * This excludes stale processes from closed terminals.
   */
  public getClaudeProcessesWithTerminals(): ClaudeProcess[] {
    const allProcesses = Array.from(this.claudeProcesses.values());
    return allProcesses.filter((proc) => this.terminalPids.has(proc.ppid));
  }

  /**
   * Get terminal by shell PID (fast cached lookup, no async)
   */
  public getTerminalByPid(pid: number): vscode.Terminal | undefined {
    return this.pidToTerminal.get(pid);
  }

  /**
   * Count how many Claude terminals are in a given CWD
   */
  public countClaudeTerminalsInCwd(cwd: string): number {
    let count = 0;
    for (const proc of this.claudeProcesses.values()) {
      if (proc.cwd === cwd) {
        count++;
      }
    }
    // Log once to help debug
    if (this.claudeProcesses.size > 0 && count === 0) {
      const knownCwds = Array.from(this.claudeProcesses.values()).map(p => p.cwd);
      console.log(`Claude Watch: No match for cwd="${cwd}", known cwds: ${JSON.stringify(knownCwds)}`);
    }
    return count;
  }

  /**
   * Find a terminal running Claude in the given CWD
   */
  public findTerminalByCwd(cwd: string): vscode.Terminal | undefined {
    // First check if we have a Claude process in this CWD
    const claudeProc = Array.from(this.claudeProcesses.values()).find(
      (p) => p.cwd === cwd
    );

    if (!claudeProc) {
      return undefined;
    }

    // Try to find the terminal - this is approximate since we can't get TTY from VSCode
    // Return the first terminal as a fallback
    for (const terminal of vscode.window.terminals) {
      // Check terminal name for hints
      if (terminal.name.toLowerCase().includes("claude")) {
        return terminal;
      }
    }

    // Fallback: return any terminal (user can at least see terminal panel)
    return vscode.window.terminals[0];
  }

  /**
   * Get the TTY for a shell process by PID
   * This is used to match VS Code terminals to Claude processes
   */
  public getTtyForPid(pid: number): string | undefined {
    try {
      const output = execSync(`ps -p ${pid} -o tty= 2>/dev/null`, {
        encoding: "utf-8",
        timeout: 1000,
      }).trim();
      return output || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Find the Claude process running in a specific TTY
   */
  public getClaudeProcessByTty(tty: string): ClaudeProcess | undefined {
    return this.claudeProcesses.get(tty);
  }

  /**
   * Find the Claude process that has a specific session file open
   */
  public getClaudeProcessBySessionFile(sessionFilePath: string): ClaudeProcess | undefined {
    for (const proc of this.claudeProcesses.values()) {
      if (proc.sessionFile === sessionFilePath) {
        return proc;
      }
    }
    return undefined;
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];

    this._onTerminalClosed.dispose();
    this._onCwdsUpdated.dispose();
    this._onTerminalTtyInvalidated.dispose();
  }
}
