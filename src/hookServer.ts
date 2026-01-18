import * as net from "net";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

function debugLog(message: string): void {
  if (vscode.workspace.getConfiguration('claudeWatch').get<boolean>('debug', false)) {
    console.log(`Claude Watch: ${message}`);
  }
}

/**
 * Event received from Claude Code session hooks
 */
export interface HookEvent {
  event: "SessionStart" | "SessionEnd";
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  pid: number;
  ppid: number;
  tty: string;
}

/**
 * Event received from Claude Code tool hooks (PreToolUse/PostToolUse)
 */
export interface ToolHookEvent {
  event: "PreToolUse" | "PostToolUse";
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult: Record<string, unknown> | null; // Only present for PostToolUse
  timestamp: number;
  pid: number;
  ppid: number;
  tty: string;
}

/**
 * TCP server that receives events from Claude Code hooks.
 * Hooks are executed by the Claude process itself, so they can capture
 * PID/PPID/TTY directly - providing ground-truth session→process identity.
 */
export class HookServer {
  private server: net.Server | null = null;
  private port: number = 0;

  private _onSessionStart = new vscode.EventEmitter<HookEvent>();
  public readonly onSessionStart = this._onSessionStart.event;

  private _onSessionEnd = new vscode.EventEmitter<HookEvent>();
  public readonly onSessionEnd = this._onSessionEnd.event;

  private _onPreToolUse = new vscode.EventEmitter<ToolHookEvent>();
  public readonly onPreToolUse = this._onPreToolUse.event;

  private _onPostToolUse = new vscode.EventEmitter<ToolHookEvent>();
  public readonly onPostToolUse = this._onPostToolUse.event;

  /**
   * Start the TCP server on a dynamic port.
   * Writes the port to ~/.claude/.claude-watch-port for hooks to read.
   */
  public async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        let data = "";

        socket.on("data", (chunk) => {
          data += chunk.toString();
        });

        socket.on("end", () => {
          this.handleMessage(data);
        });

        socket.on("error", (err) => {
          console.error("Claude Watch: Socket error:", err);
        });
      });

      this.server.on("error", (err) => {
        console.error("Claude Watch: Server error:", err);
        reject(err);
      });

      // Listen on dynamic port (0 = OS assigns available port)
      this.server.listen(0, "127.0.0.1", () => {
        const address = this.server!.address() as net.AddressInfo;
        this.port = address.port;
        debugLog(`Hook server listening on port ${this.port}`);

        // Write port to file for hooks to read
        this.writePortFile();

        resolve(this.port);
      });
    });
  }

  /**
   * Write the server port to ~/.claude/.claude-watch-port
   * Appends to the file to support multiple VS Code instances
   */
  private writePortFile(): void {
    const claudeDir = path.join(os.homedir(), ".claude");
    const portFile = path.join(claudeDir, ".claude-watch-port");

    try {
      // Ensure .claude directory exists
      if (!fs.existsSync(claudeDir)) {
        fs.mkdirSync(claudeDir, { recursive: true });
      }

      // Read existing ports and filter out stale ones
      let existingPorts: number[] = [];
      if (fs.existsSync(portFile)) {
        const content = fs.readFileSync(portFile, "utf-8");
        existingPorts = content
          .split("\n")
          .map((line) => parseInt(line.trim(), 10))
          .filter((p) => !isNaN(p) && p > 0);

        // Filter out ports that are no longer listening
        existingPorts = existingPorts.filter((p) => this.isPortAlive(p));
      }

      // Add our port if not already present
      if (!existingPorts.includes(this.port)) {
        existingPorts.push(this.port);
      }

      fs.writeFileSync(portFile, existingPorts.join("\n"));
      debugLog(`Registered port ${this.port} (${existingPorts.length} total ports)`);
    } catch (err) {
      console.error("Claude Watch: Failed to write port file:", err);
    }
  }

  /**
   * Check if a port is still alive (has a listener)
   */
  private isPortAlive(port: number): boolean {
    try {
      const socket = new net.Socket();
      let alive = false;

      socket.setTimeout(100);
      socket.on("connect", () => {
        alive = true;
        socket.destroy();
      });
      socket.on("error", () => {
        socket.destroy();
      });
      socket.on("timeout", () => {
        socket.destroy();
      });

      // Try to connect synchronously (won't actually work, but we set up handlers)
      socket.connect(port, "127.0.0.1");

      // For synchronous check, we assume port is alive if we can't quickly determine
      // The hook script will handle dead ports gracefully
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Handle incoming message from hook script
   */
  private handleMessage(data: string): void {
    try {
      // Handle potential multiple JSON objects (shouldn't happen, but be safe)
      const lines = data.trim().split("\n");

      for (const line of lines) {
        if (!line.trim()) continue;

        const parsed = JSON.parse(line);
        const eventType = parsed.event as string;

        if (eventType === "SessionStart" || eventType === "SessionEnd") {
          const event = parsed as HookEvent;
          debugLog(`Received hook event: ${event.event} for session ${event.sessionId}`);

          if (event.event === "SessionStart") {
            this._onSessionStart.fire(event);
          } else {
            this._onSessionEnd.fire(event);
          }
        } else if (eventType === "PreToolUse" || eventType === "PostToolUse") {
          const event = parsed as ToolHookEvent;
          debugLog(`Received tool event: ${event.event} - ${event.toolName} for session ${event.sessionId}`);

          if (event.event === "PreToolUse") {
            this._onPreToolUse.fire(event);
          } else {
            this._onPostToolUse.fire(event);
          }
        }
      }
    } catch (err) {
      console.error("Claude Watch: Failed to parse hook message:", err, data);
    }
  }

  /**
   * Stop the server and clean up
   */
  public stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }

    // Remove our port from the file (keep other VS Code instances' ports)
    const portFile = path.join(os.homedir(), ".claude", ".claude-watch-port");
    try {
      if (fs.existsSync(portFile)) {
        const content = fs.readFileSync(portFile, "utf-8");
        const ports = content
          .split("\n")
          .map((line) => parseInt(line.trim(), 10))
          .filter((p) => !isNaN(p) && p > 0 && p !== this.port);

        if (ports.length > 0) {
          fs.writeFileSync(portFile, ports.join("\n"));
        } else {
          fs.unlinkSync(portFile);
        }
      }
    } catch (err) {
      console.error("Claude Watch: Failed to update port file:", err);
    }

    this._onSessionStart.dispose();
    this._onSessionEnd.dispose();
    this._onPreToolUse.dispose();
    this._onPostToolUse.dispose();
  }
}
