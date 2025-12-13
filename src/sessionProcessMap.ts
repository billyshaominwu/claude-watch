import * as vscode from "vscode";

/**
 * Represents the identity of a Claude process.
 * All three fields must match for a mapping to be considered valid.
 */
export interface ProcessMapping {
  tty: string;
  pid: number;
  startTime: number;
}

/**
 * Versioned storage format for persistence.
 */
interface StoredData {
  version: number;
  mappings: Record<string, ProcessMapping>;
}

const CURRENT_VERSION = 1;
const MAX_STORED_MAPPINGS = 100;

/**
 * Manages persistent session→process mapping.
 * Uses VS Code's globalState for storage (per-window isolated).
 */
export class SessionProcessMap {
  private map: Map<string, ProcessMapping> = new Map();
  private storage: vscode.Memento;
  private saveDebounceTimer: NodeJS.Timeout | null = null;

  constructor(context: vscode.ExtensionContext) {
    this.storage = context.globalState;
    this.load();
  }

  /**
   * Associate a session file with a process.
   * Automatically enforces one-session-per-TTY invariant by removing any existing mapping for this TTY.
   */
  set(filePath: string, tty: string, pid: number, startTime: number): void {
    // Enforce invariant: only one session per TTY
    // Remove any existing session mapped to this TTY (handles /clear scenarios automatically)
    for (const [existingPath, mapping] of this.map) {
      if (mapping.tty === tty && existingPath !== filePath) {
        this.map.delete(existingPath);
        console.log(`Claude Watch: Auto-removed stale mapping for ${existingPath.split("/").pop()} (TTY ${tty} reassigned)`);
      }
    }
    this.map.set(filePath, { tty, pid, startTime });
    this.debouncedSave();
    console.log(`Claude Watch: Mapped session ${filePath.split("/").pop()} → TTY ${tty} PID ${pid}`);
  }

  /**
   * Get the process mapping for a session file.
   */
  get(filePath: string): ProcessMapping | undefined {
    return this.map.get(filePath);
  }

  /**
   * Get the TTY for a session file (convenience method).
   */
  getTty(filePath: string): string | undefined {
    return this.map.get(filePath)?.tty;
  }

  /**
   * Check if a TTY has any session mapped to it.
   */
  hasTty(tty: string): boolean {
    for (const mapping of this.map.values()) {
      if (mapping.tty === tty) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get all TTYs that have mappings for sessions in a specific CWD.
   */
  getMappedTtysForCwd(cwd: string, sessions: Map<string, { cwd: string }>): Set<string> {
    const ttys = new Set<string>();
    for (const [filePath, mapping] of this.map) {
      const session = sessions.get(filePath);
      if (session && session.cwd === cwd) {
        ttys.add(mapping.tty);
      }
    }
    return ttys;
  }

  /**
   * Remove mapping for a session file.
   */
  delete(filePath: string): void {
    if (this.map.delete(filePath)) {
      this.debouncedSave();
      console.log(`Claude Watch: Removed mapping for ${filePath.split("/").pop()}`);
    }
  }

  /**
   * Remove all session mappings that use a specific TTY.
   * Used when /clear creates a new session file for the same terminal.
   * Returns the file paths that were removed.
   */
  deleteByTty(tty: string): string[] {
    const removed: string[] = [];
    for (const [filePath, mapping] of this.map) {
      if (mapping.tty === tty) {
        this.map.delete(filePath);
        removed.push(filePath);
      }
    }
    if (removed.length > 0) {
      this.debouncedSave();
      console.log(`Claude Watch: Removed ${removed.length} mapping(s) for TTY ${tty}`);
    }
    return removed;
  }

  /**
   * Validate mappings against current processes.
   * Removes mappings that don't match any running process.
   */
  validateAgainstProcesses(processes: { tty: string; pid: number; startTime: number }[]): void {
    let removed = 0;
    for (const [filePath, mapping] of this.map) {
      const matchingProcess = processes.find(
        (p) =>
          p.tty === mapping.tty &&
          p.pid === mapping.pid &&
          p.startTime === mapping.startTime
      );
      if (!matchingProcess) {
        this.map.delete(filePath);
        removed++;
      }
    }
    if (removed > 0) {
      console.log(`Claude Watch: Validated mappings, removed ${removed} stale entries`);
      this.debouncedSave();
    }
  }

  /**
   * Get the number of stored mappings.
   */
  get size(): number {
    return this.map.size;
  }

  /**
   * Get all mappings (for recovery/deduplication).
   */
  getAllMappings(): Map<string, ProcessMapping> {
    return new Map(this.map);
  }

  /**
   * Remove duplicate TTY mappings, keeping only specified sessions.
   * Used during recovery to clean up stale /clear scenarios.
   */
  deduplicateByTty(sessionsToKeep: Map<string, string>): number {
    // sessionsToKeep: TTY -> filePath to keep
    let removed = 0;
    for (const [filePath, mapping] of Array.from(this.map.entries())) {
      const keepFilePath = sessionsToKeep.get(mapping.tty);
      if (keepFilePath && keepFilePath !== filePath) {
        // This TTY has a designated session to keep, and it's not this one
        this.map.delete(filePath);
        removed++;
        console.log(`Claude Watch: Recovery - removed stale mapping for ${filePath.split("/").pop()}`);
      }
    }
    if (removed > 0) {
      this.debouncedSave();
    }
    return removed;
  }

  /**
   * Load mappings from storage.
   */
  private load(): void {
    try {
      const data = this.storage.get<StoredData>("sessionProcessMap");
      if (!data) {
        console.log("Claude Watch: No stored session mappings found");
        return;
      }
      if (data.version !== CURRENT_VERSION) {
        console.log(`Claude Watch: Session mapping version mismatch (${data.version} vs ${CURRENT_VERSION}), starting fresh`);
        return;
      }
      this.map = new Map(Object.entries(data.mappings));
      console.log(`Claude Watch: Loaded ${this.map.size} session mappings from storage`);
    } catch (error) {
      console.error("Claude Watch: Failed to load session mappings:", error);
    }
  }

  /**
   * Save mappings to storage with debouncing.
   */
  private debouncedSave(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = setTimeout(() => {
      this.save();
      this.saveDebounceTimer = null;
    }, 500);
  }

  /**
   * Save mappings to storage immediately.
   */
  private save(): void {
    try {
      // Prune if too many mappings
      if (this.map.size > MAX_STORED_MAPPINGS) {
        const entries = Array.from(this.map.entries());
        // Keep most recent entries (those at the end of insertion order)
        const toKeep = entries.slice(-MAX_STORED_MAPPINGS);
        this.map = new Map(toKeep);
        console.log(`Claude Watch: Pruned session mappings to ${MAX_STORED_MAPPINGS}`);
      }

      const data: StoredData = {
        version: CURRENT_VERSION,
        mappings: Object.fromEntries(this.map),
      };
      this.storage.update("sessionProcessMap", data);
    } catch (error) {
      console.error("Claude Watch: Failed to save session mappings:", error);
    }
  }

  /**
   * Force immediate save (for cleanup).
   */
  public flush(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
    this.save();
  }
}
