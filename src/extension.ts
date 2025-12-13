import * as vscode from "vscode";
import * as path from "path";
import { SessionManager } from "./sessionManager";
import { SessionTreeProvider } from "./sessionTreeProvider";
import { TerminalTracker } from "./terminalTracker";
import { TerminalMatcher } from "./terminalMatcher";
import { SessionProcessMap } from "./sessionProcessMap";

let terminalTracker: TerminalTracker | null = null;
let sessionManager: SessionManager | null = null;
let sessionTreeProvider: SessionTreeProvider | null = null;
let terminalMatcher: TerminalMatcher | null = null;
let sessionProcessMap: SessionProcessMap | null = null;

export function activate(context: vscode.ExtensionContext): void {
  console.log("Claude Watch: Activating extension");

  // Initialize TerminalTracker (monitors terminals and Claude processes)
  terminalTracker = new TerminalTracker();

  // Initialize TerminalMatcher (matches sessions to terminals)
  terminalMatcher = new TerminalMatcher(terminalTracker);

  // Get the current workspace path to filter sessions
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // Initialize SessionProcessMap (persistent session→process mapping)
  sessionProcessMap = new SessionProcessMap(context);

  // Initialize SessionManager (watches session files)
  sessionManager = new SessionManager(terminalTracker, sessionProcessMap, workspacePath);

  // Connect terminalMatcher to sessionManager's mapping
  terminalMatcher.setGetSessionMapping((filePath) => sessionManager?.getSessionMapping(filePath));

  // Initialize tree view
  sessionTreeProvider = new SessionTreeProvider(sessionManager, context, terminalMatcher);

  // Register the tree view
  const treeView = vscode.window.createTreeView("claudeSessions", {
    treeDataProvider: sessionTreeProvider,
    showCollapseAll: false,
  });

  // Connect session manager updates to tree view
  sessionManager.onUpdate((sessions) => {
    if (sessionTreeProvider) {
      sessionTreeProvider.updateSessions(sessions);
    }
  });

  // Connect session manager inactive updates to tree view
  sessionManager.onInactiveUpdate((sessions) => {
    if (sessionTreeProvider) {
      sessionTreeProvider.updateInactiveSessions(sessions);
    }
  });

  // Start watching for sessions
  sessionManager.start();

  // Register commands
  const newSessionCommand = vscode.commands.registerCommand(
    "claude-watch.newSession",
    () => {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!cwd) {
        vscode.window.showErrorMessage("No workspace folder open");
        return;
      }

      // Create new terminal and start Claude
      const terminal = vscode.window.createTerminal({
        name: `Claude: ${path.basename(cwd)}`,
        cwd: cwd,
        iconPath: new vscode.ThemeIcon("comment-discussion"),
      });
      terminal.show();
      terminal.sendText("claude");
    }
  );

  const refreshCommand = vscode.commands.registerCommand(
    "claude-watch.refreshSessions",
    () => {
      if (sessionTreeProvider) {
        sessionTreeProvider.refresh();
      }
    }
  );

  const openTerminalCommand = vscode.commands.registerCommand(
    "claude-watch.openTerminal",
    (item) => {
      console.log("Claude Watch: openTerminal command triggered", item);
      if (sessionTreeProvider && item) {
        sessionTreeProvider.openTerminalForSession(item);
      } else {
        console.log("Claude Watch: No sessionTreeProvider or item", { sessionTreeProvider: !!sessionTreeProvider, item: !!item });
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

      // Create new terminal and resume the session
      const terminal = vscode.window.createTerminal({
        name: `Claude: ${path.basename(session.cwd)}`,
        cwd: session.cwd,
        iconPath: new vscode.ThemeIcon("comment-discussion"),
      });
      terminal.show();
      terminal.sendText(`claude --resume ${session.sessionId}`);
    }
  );

  context.subscriptions.push(
    treeView,
    newSessionCommand,
    refreshCommand,
    openTerminalCommand,
    pinSessionCommand,
    resumeSessionCommand
  );

  // Clean up on deactivation
  context.subscriptions.push({
    dispose: () => {
      if (sessionManager) {
        sessionManager.stop();
        sessionManager = null;
      }
      if (sessionProcessMap) {
        sessionProcessMap.flush();
        sessionProcessMap = null;
      }
      if (terminalMatcher) {
        terminalMatcher.dispose();
        terminalMatcher = null;
      }
      if (terminalTracker) {
        terminalTracker.dispose();
        terminalTracker = null;
      }
      sessionTreeProvider = null;
    },
  });

  console.log("Claude Watch: Extension activated successfully");
}

export function deactivate(): void {
  console.log("Claude Watch: Deactivating extension");

  if (sessionManager) {
    sessionManager.stop();
    sessionManager = null;
  }

  if (sessionProcessMap) {
    sessionProcessMap.flush();
    sessionProcessMap = null;
  }

  if (terminalMatcher) {
    terminalMatcher.dispose();
    terminalMatcher = null;
  }

  if (terminalTracker) {
    terminalTracker.dispose();
    terminalTracker = null;
  }

  sessionTreeProvider = null;
}
