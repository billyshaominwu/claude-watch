import * as net from "net";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Event received from Claude Code hooks
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
        console.log(`Claude Watch: Hook server listening on port ${this.port}`);

        // Write port to file for hooks to read
        this.writePortFile();

        resolve(this.port);
      });
    });
  }

  /**
   * Write the server port to ~/.claude/.claude-watch-port
   */
  private writePortFile(): void {
    const claudeDir = path.join(os.homedir(), ".claude");
    const portFile = path.join(claudeDir, ".claude-watch-port");

    try {
      // Ensure .claude directory exists
      if (!fs.existsSync(claudeDir)) {
        fs.mkdirSync(claudeDir, { recursive: true });
      }

      fs.writeFileSync(portFile, String(this.port));
      console.log(`Claude Watch: Wrote port ${this.port} to ${portFile}`);
    } catch (err) {
      console.error("Claude Watch: Failed to write port file:", err);
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

        const event = JSON.parse(line) as HookEvent;
        console.log(`Claude Watch: Received hook event: ${event.event} for session ${event.sessionId}`);

        if (event.event === "SessionStart") {
          this._onSessionStart.fire(event);
        } else if (event.event === "SessionEnd") {
          this._onSessionEnd.fire(event);
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

    // Remove port file
    const portFile = path.join(os.homedir(), ".claude", ".claude-watch-port");
    try {
      if (fs.existsSync(portFile)) {
        fs.unlinkSync(portFile);
      }
    } catch (err) {
      console.error("Claude Watch: Failed to remove port file:", err);
    }

    this._onSessionStart.dispose();
    this._onSessionEnd.dispose();
  }
}
