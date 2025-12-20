import * as vscode from "vscode";
import * as path from "path";
import { SessionState, SessionStatus, TodoItem } from "./transcriptParser";
import { SessionRegistry } from "./sessionRegistry";

// Constants
const DESCRIPTION_TRUNCATE_LENGTH = 60; // Max length for session description

// Base type for all tree items
type TreeItemType = CategoryItem | SessionItem | OldSessionItem | ContextInfoItem | TodoListItem;

export class SessionTreeProvider implements vscode.TreeDataProvider<TreeItemType> {
  private _onDidChangeTreeData: vscode.EventEmitter<TreeItemType | undefined | null | void> =
    new vscode.EventEmitter<TreeItemType | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<TreeItemType | undefined | null | void> =
    this._onDidChangeTreeData.event;

  private sessions: SessionState[] = [];
  private inactiveSessions: SessionState[] = [];
  private registry: SessionRegistry;
  private workspaceState: vscode.Memento;
  private pinnedSessions: Set<string> = new Set();

  // Cache tree items by filePath to ensure stable object references across refreshes
  private sessionItemCache: Map<string, SessionItem> = new Map();
  private oldSessionItemCache: Map<string, OldSessionItem> = new Map();
  private contextItemCache: Map<string, ContextInfoItem> = new Map();

  // Category items (cached for stable references)
  private activeCategoryItem: CategoryItem | null = null;
  private oldCategoryItem: CategoryItem | null = null;

  constructor(
    registry: SessionRegistry,
    context: vscode.ExtensionContext
  ) {
    this.registry = registry;
    this.workspaceState = context.workspaceState;
    // Load pinned sessions from workspace state
    const savedPinned = this.workspaceState.get<string[]>('pinnedSessions', []);
    this.pinnedSessions = new Set(savedPinned);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  updateSessions(sessions: SessionState[]): void {
    this.sessions = sessions;
    // Clean up cache entries for sessions that no longer exist
    const activeFilePaths = new Set(sessions.map((s) => s.filePath));
    for (const filePath of this.sessionItemCache.keys()) {
      if (!activeFilePaths.has(filePath)) {
        this.sessionItemCache.delete(filePath);
        this.contextItemCache.delete(filePath);
      }
    }
    this.refresh();
  }

  updateInactiveSessions(sessions: SessionState[]): void {
    this.inactiveSessions = sessions;
    // Clean up cache entries for old sessions that no longer exist
    const inactiveFilePaths = new Set(sessions.map((s) => s.filePath));
    for (const filePath of this.oldSessionItemCache.keys()) {
      if (!inactiveFilePaths.has(filePath)) {
        this.oldSessionItemCache.delete(filePath);
      }
    }
    this.refresh();
  }

  getTreeItem(element: TreeItemType): vscode.TreeItem {
    return element;
  }

  private getMainSessions(): SessionState[] {
    return this.sessions.filter((s) => !s.isAgent);
  }

  private getAgentChildren(parentSessionId: string): SessionState[] {
    return this.sessions.filter(
      (s) => s.isAgent && s.parentSessionId === parentSessionId
    );
  }

  /**
   * Get or create a cached SessionItem, updating its properties from the session state
   */
  private getOrCreateSessionItem(session: SessionState, hasChildren: boolean): SessionItem {
    const isPinned = this.pinnedSessions.has(session.filePath);
    let item = this.sessionItemCache.get(session.filePath);
    if (item) {
      item.updateFromSession(session, hasChildren, isPinned);
    } else {
      item = new SessionItem(session, hasChildren, isPinned);
      this.sessionItemCache.set(session.filePath, item);
    }
    return item;
  }

  /**
   * Get or create a cached ContextInfoItem, updating its properties from the session state
   */
  private getOrCreateContextItem(session: SessionState): ContextInfoItem {
    let item = this.contextItemCache.get(session.filePath);
    if (item) {
      item.updateFromSession(session);
    } else {
      item = new ContextInfoItem(session);
      this.contextItemCache.set(session.filePath, item);
    }
    return item;
  }

  /**
   * Get or create a cached OldSessionItem
   */
  private getOrCreateOldSessionItem(session: SessionState): OldSessionItem {
    let item = this.oldSessionItemCache.get(session.filePath);
    if (item) {
      item.updateFromSession(session);
    } else {
      item = new OldSessionItem(session);
      this.oldSessionItemCache.set(session.filePath, item);
    }
    return item;
  }

  getChildren(element?: TreeItemType): Thenable<TreeItemType[]> {
    if (element) {
      // ContextInfoItem, TodoListItem, and OldSessionItem have no children
      if (element instanceof ContextInfoItem || element instanceof TodoListItem || element instanceof OldSessionItem) {
        return Promise.resolve([]);
      }

      // CategoryItem: return sessions in that category
      if (element instanceof CategoryItem) {
        if (element.category === 'active') {
          // Return active sessions
          const mainSessions = this.getMainSessions();
          // Sort: pinned sessions first, then by recency
          mainSessions.sort((a, b) => {
            const aPinned = this.pinnedSessions.has(a.filePath);
            const bPinned = this.pinnedSessions.has(b.filePath);
            if (aPinned !== bPinned) return aPinned ? -1 : 1;
            return b.lastModified - a.lastModified;
          });
          return Promise.resolve(
            mainSessions.map((session) => this.getOrCreateSessionItem(session, true))
          );
        } else {
          // Return old sessions
          const oldSessions = [...this.inactiveSessions].sort(
            (a, b) => b.lastModified - a.lastModified
          );
          return Promise.resolve(
            oldSessions.map((session) => this.getOrCreateOldSessionItem(session))
          );
        }
      }

      // SessionItem: return context info, todos, then agent children
      const session = element.session;
      const children: TreeItemType[] = [];

      // 1. Context info first
      children.push(this.getOrCreateContextItem(session));

      // 2. Todo items (sorted: in_progress, pending, then limited completed)
      if (session.todos && session.todos.length > 0) {
        const MAX_COMPLETED_SHOWN = 3; // Only show N most recent completed

        const inProgress = session.todos.filter(t => t.status === 'in_progress');
        const pending = session.todos.filter(t => t.status === 'pending');
        const completed = session.todos.filter(t => t.status === 'completed');

        // Take only the last N completed (most recent are at end of array)
        const recentCompleted = completed.slice(-MAX_COMPLETED_SHOWN);

        const displayTodos = [...inProgress, ...pending, ...recentCompleted];
        children.push(...displayTodos.map((t, i) => new TodoListItem(t, session.filePath, i)));
      }

      // 3. Agent children last
      const agents = this.getAgentChildren(session.sessionId);
      children.push(...agents.map((s) => this.getOrCreateSessionItem(s, false)));

      return Promise.resolve(children);
    }

    // Root level: return category items
    const mainSessions = this.getMainSessions();
    const categories: TreeItemType[] = [];

    // Active category
    if (!this.activeCategoryItem) {
      this.activeCategoryItem = new CategoryItem('active', 'Active', mainSessions.length);
    } else {
      this.activeCategoryItem.updateCount(mainSessions.length);
    }
    categories.push(this.activeCategoryItem);

    // Old category
    if (!this.oldCategoryItem) {
      this.oldCategoryItem = new CategoryItem('old', 'Old', this.inactiveSessions.length);
    } else {
      this.oldCategoryItem.updateCount(this.inactiveSessions.length);
    }
    categories.push(this.oldCategoryItem);

    return Promise.resolve(categories);
  }

  async openTerminalForSession(item: TreeItemType): Promise<void> {
    // ContextInfoItem, TodoListItem, CategoryItem, and OldSessionItem don't open terminal via this method
    if (item instanceof ContextInfoItem || item instanceof TodoListItem || item instanceof CategoryItem || item instanceof OldSessionItem) {
      return;
    }

    let session = item.session;

    // For agent sessions, find and use the parent session instead
    if (session.isAgent && session.parentSessionId) {
      const parentSession = this.registry.getParentSession(session);
      if (parentSession) {
        session = parentSession;
      } else {
        const cachedParent = this.sessions.find(
          (s) => s.sessionId === session.parentSessionId && !s.isAgent
        );
        if (cachedParent) {
          session = cachedParent;
        }
      }
    }

    // Use SessionRegistry to find the terminal (direct PPID lookup)
    const terminal = await this.registry.findTerminalForSessionState(session);
    if (terminal) {
      terminal.show();
    } else {
      // No terminal found - offer to create one
      const result = await vscode.window.showInformationMessage(
        `No terminal found for session in ${session.cwd}. Open new terminal?`,
        "Open"
      );
      if (result === "Open") {
        const newTerminal = vscode.window.createTerminal({
          name: `Claude: ${path.basename(session.cwd)}`,
          cwd: session.cwd,
        });
        newTerminal.show();
        newTerminal.sendText("claude");
      }
    }
  }

  pinSession(item: TreeItemType): void {
    // Only SessionItem can be pinned
    if (item instanceof ContextInfoItem || item instanceof TodoListItem || item instanceof CategoryItem || item instanceof OldSessionItem) {
      return;
    }

    const filePath = item.session.filePath;
    if (this.pinnedSessions.has(filePath)) {
      this.pinnedSessions.delete(filePath);
    } else {
      this.pinnedSessions.add(filePath);
    }

    // Persist to workspace state
    this.workspaceState.update('pinnedSessions', [...this.pinnedSessions]);
    this.refresh();
  }
}

/**
 * Tree item showing context window usage info with detailed stats
 */
class ContextInfoItem extends vscode.TreeItem {
  public session: SessionState;

  constructor(session: SessionState) {
    super("", vscode.TreeItemCollapsibleState.None);
    this.session = session;
    this.id = `${session.filePath}:context`;
    this.iconPath = new vscode.ThemeIcon("dashboard");
    this.contextValue = "contextInfo";
    this.applySessionData(session);
  }

  updateFromSession(session: SessionState): void {
    this.session = session;
    this.applySessionData(session);
  }

  private applySessionData(session: SessionState): void {
    const usage = session.tokenUsage;
    const contextK = Math.round(usage.contextTokens / 1000);
    const maxK = Math.round(usage.maxContextTokens / 1000);
    const percentage = usage.maxContextTokens > 0
      ? Math.round((usage.contextTokens / usage.maxContextTokens) * 100)
      : 0;

    // Calculate cache hit rate
    const totalInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    const cacheHitRate = totalInput > 0
      ? Math.round((usage.cacheReadTokens / totalInput) * 100)
      : 0;

    // Format numbers with K suffix
    const formatK = (n: number) => n >= 1000 ? `${Math.round(n / 1000)}K` : `${n}`;

    // Create a prettier progress bar
    const bar = contextProgressBar(usage.contextTokens, usage.maxContextTokens, 12);

    // Main label: progress bar with percentage
    this.label = `${bar}`;

    // Description: key stats inline
    this.description = `${contextK}K/${maxK}K  ·  Cache ${cacheHitRate}%  ·  Out ${formatK(usage.outputTokens)}`;

    // Rich tooltip with all details
    this.tooltip = new vscode.MarkdownString(
      `### Context Window\n\n` +
      `| Metric | Value |\n` +
      `|--------|-------|\n` +
      `| **Context Used** | ${formatK(usage.contextTokens)} / ${formatK(usage.maxContextTokens)} (${percentage}%) |\n` +
      `| **Cache Hit Rate** | ${cacheHitRate}% |\n` +
      `| **Input Tokens** | ${formatK(usage.inputTokens)} |\n` +
      `| **Cache Read** | ${formatK(usage.cacheReadTokens)} |\n` +
      `| **Cache Write** | ${formatK(usage.cacheWriteTokens)} |\n` +
      `| **Output Tokens** | ${formatK(usage.outputTokens)} |`
    );
  }
}

/**
 * Tree item representing a single todo from TodoWrite
 */
class TodoListItem extends vscode.TreeItem {
  constructor(todo: TodoItem, sessionFilePath: string, index: number) {
    super(truncate(todo.content, DESCRIPTION_TRUNCATE_LENGTH), vscode.TreeItemCollapsibleState.None);

    this.id = `${sessionFilePath}:todo:${index}`;

    // Status icons matching session status colors
    const icons: Record<string, { icon: string; color: string }> = {
      'completed': { icon: 'check', color: 'testing.iconPassed' },
      'in_progress': { icon: 'sync~spin', color: 'charts.blue' },
      'pending': { icon: 'circle-outline', color: 'descriptionForeground' }
    };
    const config = icons[todo.status] || icons['pending'];
    this.iconPath = new vscode.ThemeIcon(config.icon, new vscode.ThemeColor(config.color));

    this.contextValue = 'todoItem';
    this.tooltip = todo.content;
  }
}

class SessionItem extends vscode.TreeItem {
  public session: SessionState;

  constructor(session: SessionState, hasChildren: boolean = false, isPinned: boolean = false) {
    super("", vscode.TreeItemCollapsibleState.None);
    this.session = session;
    // Stable ID for consistent tree rendering across refreshes
    this.id = session.filePath;
    this.applySessionData(session, hasChildren, isPinned);
  }

  updateFromSession(session: SessionState, hasChildren: boolean, isPinned: boolean = false): void {
    this.session = session;
    this.applySessionData(session, hasChildren, isPinned);
  }

  private applySessionData(session: SessionState, hasChildren: boolean, isPinned: boolean = false): void {
    const isAgent = session.isAgent;

    // Label: prefer summary for stable context, fall back to firstUserMessage then lastUserPrompt
    // For sessions with no user activity yet:
    // - If very recent (< 60s), show "New session"
    // - If older, show summary (Claude loads previous context) or "Waiting for input..."
    // This prevents old unused sessions from showing as "New session" forever
    const hasUserActivity = session.firstUserMessage || session.lastUserPrompt;
    const isVeryRecent = (Date.now() - session.created) < 60000; // 60 seconds
    let baseLabel: string;
    if (hasUserActivity) {
      baseLabel = session.summary || session.firstUserMessage || session.lastUserPrompt || "New session";
    } else if (isVeryRecent) {
      baseLabel = "New session";
    } else {
      // Older session without user activity - show summary or waiting message
      baseLabel = session.summary || "Waiting for input...";
    }
    this.label = isPinned ? `📌 ${baseLabel}` : baseLabel;

    // Main sessions are always expandable (can have context info + agents), agents are not
    // Use Collapsed so users can expand when they want to see nested info
    this.collapsibleState = hasChildren
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;

    // Description: show in-progress task or last user prompt (dynamic activity)
    const completedCount = session.todos?.filter(t => t.status === 'completed').length ?? 0;
    const totalCount = session.todos?.length ?? 0;
    const progressText = totalCount > 0 ? ` (${completedCount}/${totalCount})` : '';

    this.description = session.inProgressTask
      ? truncate(session.inProgressTask, DESCRIPTION_TRUNCATE_LENGTH - progressText.length) + progressText
      : session.lastUserPrompt
        ? truncate(session.lastUserPrompt, DESCRIPTION_TRUNCATE_LENGTH - progressText.length) + progressText
        : (totalCount > 0 ? `${completedCount}/${totalCount} tasks` : "");

    // Map status to display text
    const statusTextMap: Record<SessionStatus, string> = {
      [SessionStatus.WORKING]: "Working",
      [SessionStatus.PAUSED]: "Paused",
      [SessionStatus.DONE]: "Done",
    };
    const statusText = statusTextMap[session.status] || "Unknown";
    const projectName = path.basename(session.cwd) || session.cwd;
    const tokenK = Math.round(session.tokenUsage.contextTokens / 1000);
    const maxTokenK = Math.round(session.tokenUsage.maxContextTokens / 1000);

    const summaryLine = session.summary ? `**Summary:** ${session.summary}\n\n` : "";
    const usage = session.tokenUsage;
    const contextPct = usage.maxContextTokens > 0
      ? Math.round((usage.contextTokens / usage.maxContextTokens) * 100)
      : 0;
    this.tooltip = new vscode.MarkdownString(
      `**${statusText}** in **${projectName}**\n\n` +
      summaryLine +
      `**Context:** ${tokenK}K / ${maxTokenK}K tokens (${contextPct}%)\n\n` +
      `**Last prompt:** ${session.lastUserPrompt || "(none)"}\n\n` +
      `**Current task:** ${session.inProgressTask || "(none)"}\n\n` +
      `**Path:** ${session.cwd}\n\n` +
      `**Session:** ${session.slug || session.sessionId.slice(0, 8)}`
    );

    // Map status to icon with color
    const statusConfig: Record<SessionStatus, { icon: string; color: string }> = {
      [SessionStatus.WORKING]: { icon: "sync~spin", color: "charts.blue" },
      [SessionStatus.PAUSED]: { icon: "debug-pause", color: "notificationsWarningIcon.foreground" },
      [SessionStatus.DONE]: { icon: "check", color: "testing.iconPassed" },
    };
    const config = statusConfig[session.status] || { icon: "circle", color: "foreground" };
    this.iconPath = new vscode.ThemeIcon(config.icon, new vscode.ThemeColor(config.color));

    // Include pinned state in contextValue for potential menu customization
    const pinnedSuffix = isPinned ? "Pinned" : "";
    this.contextValue = isAgent ? `claudeAgent${pinnedSuffix}` : `claudeSession${pinnedSuffix}`;

    // Click to open terminal
    this.command = {
      command: "claude-watch.openTerminal",
      title: "Open Terminal",
      arguments: [this],
    };
  }
}

/**
 * Category item for grouping active and old sessions
 */
class CategoryItem extends vscode.TreeItem {
  public readonly category: 'active' | 'old';

  constructor(category: 'active' | 'old', label: string, count: number) {
    // Active is expanded by default, Old is collapsed
    const collapsibleState = category === 'active'
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed;
    super(label, collapsibleState);
    this.category = category;
    this.id = `category:${category}`;
    this.contextValue = 'category';
    this.updateCount(count);
    this.iconPath = category === 'active'
      ? new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('charts.blue'))
      : new vscode.ThemeIcon('history', new vscode.ThemeColor('descriptionForeground'));
  }

  updateCount(count: number): void {
    this.description = `${count} session${count !== 1 ? 's' : ''}`;
  }
}

/**
 * Tree item for an old/inactive session
 */
class OldSessionItem extends vscode.TreeItem {
  public session: SessionState;

  constructor(session: SessionState) {
    super("", vscode.TreeItemCollapsibleState.None);
    this.session = session;
    this.id = `old:${session.filePath}`;
    this.applySessionData(session);
  }

  updateFromSession(session: SessionState): void {
    this.session = session;
    this.applySessionData(session);
  }

  private applySessionData(session: SessionState): void {
    // Label: prefer summary, fall back to first message, then last prompt
    // But only use summary if there's been real user activity
    const hasUserActivity = session.firstUserMessage || session.lastUserPrompt;
    this.label = hasUserActivity
      ? (session.summary || session.firstUserMessage || session.lastUserPrompt)
      : "Old session";

    // Description: relative time ago
    const ageMs = Date.now() - session.lastModified;
    const ageMinutes = Math.floor(ageMs / (1000 * 60));
    const ageHours = Math.floor(ageMs / (1000 * 60 * 60));
    const ageDays = Math.floor(ageHours / 24);

    if (ageDays > 0) {
      this.description = `${ageDays}d ago`;
    } else if (ageHours > 0) {
      this.description = `${ageHours}h ago`;
    } else if (ageMinutes > 0) {
      this.description = `${ageMinutes}m ago`;
    } else {
      this.description = "just now";
    }

    // Icon: history icon
    this.iconPath = new vscode.ThemeIcon("history");

    // Context value for menu filtering
    this.contextValue = "oldClaudeSession";

    // Tooltip with details
    const projectName = path.basename(session.cwd) || session.cwd;
    const summaryLine = session.summary ? `**Summary:** ${session.summary}\n\n` : "";
    this.tooltip = new vscode.MarkdownString(
      `**Old Session** in **${projectName}**\n\n` +
      summaryLine +
      `**First message:** ${session.firstUserMessage || "(none)"}\n\n` +
      `**Last prompt:** ${session.lastUserPrompt || "(none)"}\n\n` +
      `**Path:** ${session.cwd}\n\n` +
      `**Session ID:** ${session.sessionId}\n\n` +
      `Click to resume this session`
    );

    // Click command: resume session
    this.command = {
      command: "claude-watch.resumeSession",
      title: "Resume Session",
      arguments: [this],
    };
  }
}

function truncate(str: string, maxLength: number): string {
  if (str.length > maxLength) {
    return str.slice(0, maxLength - 1) + "…";
  }
  return str;
}

/**
 * Generate a visual progress bar for context window usage
 * @param current Current token count
 * @param max Max token count
 * @param width Number of characters for the bar
 */
function contextProgressBar(current: number, max: number, width: number = 8): string {
  if (max === 0) return "";
  const percentage = Math.min(current / max, 1);
  const filled = Math.round(percentage * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  const pct = Math.round(percentage * 100);
  return `${bar} ${pct}%`;
}
