import * as vscode from "vscode";
import * as path from "path";
import { HookServer } from "./hookServer";
import { SessionRegistry } from "./sessionRegistry";
import { SessionTreeProvider } from "./sessionTreeProvider";
import { configureHooks, areHooksConfigured } from "./hookConfig";

let hookServer: HookServer | null = null;
let sessionRegistry: SessionRegistry | null = null;
let sessionTreeProvider: SessionTreeProvider | null = null;
let outputChannel: vscode.OutputChannel | null = null;

function isDebugEnabled(): boolean {
  return vscode.workspace.getConfiguration('claudeWatch').get<boolean>('debug', false);
}

export function log(message: string): void {
  const timestamp = new Date().toISOString().slice(11, 23);
  const line = `[${timestamp}] ${message}`;
  // Only log to console when debug is enabled
  if (isDebugEnabled()) {
    console.log(`Claude Watch: ${message}`);
  }
  // Always log to output channel (user can view when needed)
  outputChannel?.appendLine(line);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Create output channel for debugging
  outputChannel = vscode.window.createOutputChannel("Claude Watch");
  context.subscriptions.push(outputChannel);

  log("Activating extension");

  // Configure hooks if not already configured
  if (!areHooksConfigured()) {
    log("Hooks not configured, setting up...");
    const result = await configureHooks();
    if (!result.success) {
      vscode.window.showErrorMessage(
        `Claude Watch: Failed to configure hooks: ${result.error}. The extension may not work correctly.`
      );
    } else {
      log("Hooks configured successfully");
    }
  } else {
    log("Hooks already configured");
  }

  // Start the hook server
  hookServer = new HookServer();
  try {
    const port = await hookServer.start();
    log(`Hook server started on port ${port}`);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(
      `Claude Watch: Failed to start hook server: ${error}`
    );
    return;
  }

  // Get the current workspace path to filter sessions
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // Initialize SessionRegistry with context for persistence
  sessionRegistry = new SessionRegistry(hookServer, workspacePath, context);

  // Initialize tree view
  sessionTreeProvider = new SessionTreeProvider(sessionRegistry, context);

  // Register the tree view
  const treeView = vscode.window.createTreeView("claudeSessions", {
    treeDataProvider: sessionTreeProvider,
    showCollapseAll: false,
  });

  // Connect registry updates to tree view
  sessionRegistry.onUpdate((sessions) => {
    if (sessionTreeProvider) {
      sessionTreeProvider.updateSessions(sessions);
    }
  });

  // Connect registry inactive updates to tree view
  sessionRegistry.onInactiveUpdate((sessions) => {
    if (sessionTreeProvider) {
      sessionTreeProvider.updateInactiveSessions(sessions);
    }
  });

  // Start watching for sessions (waits for persisted sessions to restore)
  await sessionRegistry.start();

  // Auto-detect any already running Claude sessions (runs after restore completes)
  sessionRegistry.refresh().catch((err) => {
    log(`Error during initial refresh: ${err}`);
  });

  // Register commands
  const newSessionCommand = vscode.commands.registerCommand(
    "claude-watch.newSession",
    () => {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!cwd) {
        vscode.window.showErrorMessage("No workspace folder open");
        return;
      }

      // Create terminal and track it
      const terminal = vscode.window.createTerminal({
        name: `Claude: ${path.basename(cwd)}`,
        cwd: cwd,
        iconPath: new vscode.ThemeIcon("comment-discussion"),
      });

      // Register as pending before Claude starts (will be linked when hook fires)
      if (sessionRegistry) {
        sessionRegistry.registerPendingTerminal(terminal);
      }

      terminal.show();
      const claudeCmd = vscode.workspace.getConfiguration("claudeWatch").get<string>("claudeCommand", "claude");
      terminal.sendText(claudeCmd);
    }
  );

  const refreshCommand = vscode.commands.registerCommand(
    "claude-watch.refreshSessions",
    async () => {
      if (sessionRegistry) {
        await sessionRegistry.refresh();
      }
      if (sessionTreeProvider) {
        sessionTreeProvider.refresh();
      }
    }
  );

  const openTerminalCommand = vscode.commands.registerCommand(
    "claude-watch.openTerminal",
    (item) => {
      if (sessionTreeProvider && item) {
        sessionTreeProvider.openTerminalForSession(item);
      }
    }
  );

  const pinSessionCommand = vscode.commands.registerCommand(
    "claude-watch.pinSession",
    (item) => {
      if (sessionTreeProvider && item) {
        sessionTreeProvider.pinSession(item);
      }
    }
  );

  const resumeSessionCommand = vscode.commands.registerCommand(
    "claude-watch.resumeSession",
    (item) => {
      if (!item || !item.session) {
        return;
      }
      const session = item.session;

      // Create terminal and resume the session
      const terminal = vscode.window.createTerminal({
        name: `Claude: ${path.basename(session.cwd)}`,
        cwd: session.cwd,
        iconPath: new vscode.ThemeIcon("comment-discussion"),
      });

      // Register as pending before Claude starts
      if (sessionRegistry) {
        sessionRegistry.registerPendingTerminal(terminal);
      }

      terminal.show();
      const claudeCmd = vscode.workspace.getConfiguration("claudeWatch").get<string>("claudeCommand", "claude");
      terminal.sendText(`${claudeCmd} --resume ${session.sessionId}`);
    }
  );

  const openSettingsCommand = vscode.commands.registerCommand(
    "claude-watch.openSettings",
    () => {
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "@ext:billywu.claude-watch"
      );
    }
  );

  const copyResumeCommand = vscode.commands.registerCommand(
    "claude-watch.copyResumeCommand",
    async (item) => {
      if (!item || !item.session) {
        return;
      }
      const sessionId = item.session.sessionId;
      const command = `claude --resume ${sessionId}`;
      await vscode.env.clipboard.writeText(command);
      vscode.window.showInformationMessage(`Copied: ${command}`);
    }
  );

  const viewTranscriptCommand = vscode.commands.registerCommand(
    "claude-watch.viewTranscript",
    async (item) => {
      if (!item || !item.session) {
        return;
      }
      const filePath = item.session.filePath;
      if (filePath) {
        const uri = vscode.Uri.file(filePath);
        await vscode.window.showTextDocument(uri);
      }
    }
  );

  const renameSessionCommand = vscode.commands.registerCommand(
    "claude-watch.renameSession",
    async (item) => {
      if (sessionTreeProvider && item) {
        await sessionTreeProvider.renameSession(item);
      }
    }
  );

  const expandAllCommand = vscode.commands.registerCommand(
    "claude-watch.expandAll",
    async () => {
      if (!sessionTreeProvider) return;

      // Ensure tree view is visible
      await vscode.commands.executeCommand("claudeSessions.focus");

      // Expand category items first - this populates parentMap for children
      const categoryItems = await sessionTreeProvider.getCategoryItems();
      for (const item of categoryItems) {
        try {
          // Reveal with expand to trigger getChildren and populate parentMap
          await treeView.reveal(item, { expand: 2, focus: false, select: false });
        } catch {
          // Item may not be in tree yet, ignore
        }
      }
      // Small delay to let VS Code process the reveals
      await new Promise(resolve => setTimeout(resolve, 100));
      // Then expand session items (now parentMap should be populated)
      for (const item of sessionTreeProvider.getAllSessionItems()) {
        try {
          await treeView.reveal(item, { expand: 2, focus: false, select: false });
        } catch {
          // Item may not be in tree yet, ignore
        }
      }
    }
  );

  const collapseAllCommand = vscode.commands.registerCommand(
    "claude-watch.collapseAll",
    () => {
      vscode.commands.executeCommand(
        "workbench.actions.treeView.claudeSessions.collapseAll"
      );
    }
  );

  const closeSessionCommand = vscode.commands.registerCommand(
    "claude-watch.closeSession",
    (item) => {
      if (!item || !item.session) {
        return;
      }

      const sessionId = item.session.sessionId;
      const terminal = sessionRegistry?.getLinkedTerminal(sessionId);

      if (terminal) {
        // Closing terminal triggers onDidCloseTerminal which cleans up the session
        terminal.dispose();
      } else {
        // No linked terminal - manually end session
        sessionRegistry?.endSession(sessionId);
      }
    }
  );

  context.subscriptions.push(
    treeView,
    newSessionCommand,
    refreshCommand,
    openTerminalCommand,
    pinSessionCommand,
    resumeSessionCommand,
    openSettingsCommand,
    copyResumeCommand,
    viewTranscriptCommand,
    renameSessionCommand,
    expandAllCommand,
    collapseAllCommand,
    closeSessionCommand
  );

  // Listen for terminal close events to clean up sessions
  // When a terminal is closed abruptly (not via /exit), the SessionEnd hook doesn't fire
  const terminalCloseListener = vscode.window.onDidCloseTerminal(async (terminal) => {
    try {
      // Clean up linked terminal tracking
      if (sessionRegistry) {
        sessionRegistry.handleTerminalClose(terminal);
      }

      // Small delay to allow process to fully terminate
      setTimeout(async () => {
        if (sessionRegistry) {
          const cleaned = await sessionRegistry.cleanupOrphanedSessions();
          if (cleaned > 0) {
            log(`Cleaned ${cleaned} orphaned sessions after terminal close`);
          }
        }
      }, 500);
    } catch (err) {
      log(`Error in terminal close handler: ${err}`);
    }
  });

  // Clean up on deactivation
  context.subscriptions.push({
    dispose: () => {
      if (sessionRegistry) {
        sessionRegistry.stop();
        sessionRegistry = null;
      }
      if (hookServer) {
        hookServer.stop();
        hookServer = null;
      }
      sessionTreeProvider = null;
    },
  });

  context.subscriptions.push(terminalCloseListener);

  log("Extension activated successfully");
}

export function deactivate(): void {
  log("Deactivating extension");

  if (sessionRegistry) {
    sessionRegistry.stop();
    sessionRegistry = null;
  }

  if (hookServer) {
    hookServer.stop();
    hookServer = null;
  }

  sessionTreeProvider = null;
}
