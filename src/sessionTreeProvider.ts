import * as vscode from "vscode";
import * as path from "path";
import { SessionState, SessionStatus, TodoItem } from "./transcriptParser";
import { SessionRegistry, CurrentTool, RecentTool } from "./sessionRegistry";
import { formatToolLabel, formatToolDescription, formatElapsedTime, getToolIcon } from "./toolFormatters";

// Constants
const DESCRIPTION_TRUNCATE_LENGTH = 60; // Max length for session description
const MAX_VISIBLE_TOOLS = 5; // Number of recent tools to show before collapsing
const MAX_VISIBLE_TODOS = 5; // Number of todos to show before collapsing

// Base type for all tree items
type TreeItemType = CategoryItem | SessionItem | OldSessionItem | ContextInfoItem | TodoListItem | CurrentToolItem | ToolHistoryItem | ToolHistoryGroupItem | FileGroupItem | ToolsSectionItem | TasksSectionItem;

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
      // Leaf nodes: no children
      if (element instanceof ContextInfoItem ||
          element instanceof TodoListItem ||
          element instanceof OldSessionItem ||
          element instanceof CurrentToolItem ||
          element instanceof ToolHistoryItem) {
        return Promise.resolve([]);
      }

      // ToolHistoryGroupItem: return its tools as ToolHistoryItems
      if (element instanceof ToolHistoryGroupItem) {
        return Promise.resolve(
          element.tools.map((tool, i) =>
            new ToolHistoryItem(tool, element.sessionFilePath, MAX_VISIBLE_TOOLS + i)
          )
        );
      }

      // FileGroupItem: return tools for that file
      if (element instanceof FileGroupItem) {
        return Promise.resolve(
          element.tools.map((tool, i) =>
            new ToolHistoryItem(tool, element.sessionFilePath, i)
          )
        );
      }

      // ToolsSectionItem: return tool children (file groups, tool items, overflow group)
      if (element instanceof ToolsSectionItem) {
        const children: TreeItemType[] = [];
        const tools = element.tools;
        const sessionFilePath = element.sessionFilePath;

        // Group tools by file (for file operations)
        const fileGroups = new Map<string, RecentTool[]>();
        const nonFileTools: RecentTool[] = [];

        for (const tool of tools) {
          const filePath = getToolFilePath(tool);
          if (filePath) {
            const existing = fileGroups.get(filePath) || [];
            existing.push(tool);
            fileGroups.set(filePath, existing);
          } else {
            nonFileTools.push(tool);
          }
        }

        // Show file groups (files with multiple operations get grouped)
        let displayedCount = 0;
        let fileGroupIndex = 0;
        for (const [filePath, fileTools] of fileGroups) {
          if (displayedCount >= MAX_VISIBLE_TOOLS) break;
          if (fileTools.length > 1) {
            children.push(new FileGroupItem(filePath, fileTools, sessionFilePath, fileGroupIndex++));
            displayedCount++;
          } else {
            children.push(new ToolHistoryItem(fileTools[0], sessionFilePath, displayedCount));
            displayedCount++;
          }
        }

        // Show non-file tools (Bash, etc.)
        for (const tool of nonFileTools) {
          if (displayedCount >= MAX_VISIBLE_TOOLS) break;
          children.push(new ToolHistoryItem(tool, sessionFilePath, displayedCount));
          displayedCount++;
        }

        // Collapsed group for the rest
        if (tools.length > MAX_VISIBLE_TOOLS) {
          const hiddenTools = tools.slice(MAX_VISIBLE_TOOLS);
          children.push(new ToolHistoryGroupItem(hiddenTools, sessionFilePath));
        }

        return Promise.resolve(children);
      }

      // TasksSectionItem: return todo children
      if (element instanceof TasksSectionItem) {
        const children: TreeItemType[] = [];
        const todos = element.todos;
        const sessionFilePath = element.sessionFilePath;

        const MAX_COMPLETED_SHOWN = 3;
        const inProgress = todos.filter(t => t.status === 'in_progress');
        const pending = todos.filter(t => t.status === 'pending');
        const completed = todos.filter(t => t.status === 'completed');

        // Take only the last N completed (most recent are at end of array)
        const recentCompleted = completed.slice(-MAX_COMPLETED_SHOWN);
        const displayTodos = [...inProgress, ...pending, ...recentCompleted];

        // Show all todos (no limit inside the section)
        children.push(...displayTodos.map((t, i) => new TodoListItem(t, sessionFilePath, i)));

        return Promise.resolve(children);
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

      // SessionItem: return context info, tools section, tasks section, then agent children
      const session = element.session;
      const children: TreeItemType[] = [];

      // Get tool state from registry
      const record = this.registry.getSessionRecord(session.sessionId);

      // 1. Current tool (if in progress) - most urgent, at top
      if (record?.currentTool) {
        children.push(new CurrentToolItem(record.currentTool, session.filePath));
      }

      // 2. Context info (always show)
      children.push(this.getOrCreateContextItem(session));

      // 3. Tools section (collapsible)
      if (record?.recentTools && record.recentTools.length > 0) {
        children.push(new ToolsSectionItem(record.recentTools, session.filePath));
      }

      // 4. Tasks section (collapsible)
      if (session.todos && session.todos.length > 0) {
        const completedCount = session.todos.filter(t => t.status === 'completed').length;
        children.push(new TasksSectionItem(session.todos, session.filePath, completedCount));
      }

      // 5. Agent children last
      const agents = this.getAgentChildren(session.sessionId);
      children.push(...agents.map((s) => this.getOrCreateSessionItem(s, false)));

      return Promise.resolve(children);
    }

    // Root level: return category items
    const mainSessions = this.getMainSessions();
    const categories: TreeItemType[] = [];

    // Calculate status counts for active sessions
    const statusCounts: StatusCounts = { working: 0, paused: 0, done: 0 };
    for (const session of mainSessions) {
      if (session.status === SessionStatus.WORKING) {
        statusCounts.working++;
      } else if (session.status === SessionStatus.PAUSED) {
        statusCounts.paused++;
      } else if (session.status === SessionStatus.DONE) {
        statusCounts.done++;
      }
    }

    // Active category
    if (!this.activeCategoryItem) {
      this.activeCategoryItem = new CategoryItem('active', 'Active', mainSessions.length, statusCounts);
    } else {
      this.activeCategoryItem.updateCount(mainSessions.length, statusCounts);
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
    // Non-session items don't open terminal via this method
    if (item instanceof ContextInfoItem ||
        item instanceof TodoListItem ||
        item instanceof CategoryItem ||
        item instanceof OldSessionItem ||
        item instanceof CurrentToolItem ||
        item instanceof ToolHistoryItem ||
        item instanceof ToolHistoryGroupItem ||
        item instanceof FileGroupItem ||
        item instanceof ToolsSectionItem ||
        item instanceof TasksSectionItem) {
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

    // Check for linked terminal first (fast O(1) lookup)
    const linkedTerminal = this.registry.getLinkedTerminal(session.sessionId);
    if (linkedTerminal) {
      linkedTerminal.show();
      return;
    }

    // Fallback: search for terminal by PID ancestry (handles cases where lazy linking failed)
    const foundTerminal = await this.registry.findTerminalForSession(session.sessionId);
    if (foundTerminal) {
      foundTerminal.show();
      return;
    }

    // Terminal not found - may have been closed or started outside VS Code
    vscode.window.showInformationMessage(
      "Terminal not found. The session may have been started in another window or the terminal was closed.",
      "OK"
    );
  }

  pinSession(item: TreeItemType): void {
    // Only SessionItem can be pinned
    if (item instanceof ContextInfoItem ||
        item instanceof TodoListItem ||
        item instanceof CategoryItem ||
        item instanceof OldSessionItem ||
        item instanceof CurrentToolItem ||
        item instanceof ToolHistoryItem ||
        item instanceof ToolHistoryGroupItem ||
        item instanceof FileGroupItem ||
        item instanceof ToolsSectionItem ||
        item instanceof TasksSectionItem) {
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
 * Status counts for active sessions
 */
interface StatusCounts {
  working: number;
  paused: number;
  done: number;
}

/**
 * Category item for grouping active and old sessions
 */
class CategoryItem extends vscode.TreeItem {
  public readonly category: 'active' | 'old';

  constructor(category: 'active' | 'old', label: string, count: number, statusCounts?: StatusCounts) {
    // Active is expanded by default, Old is collapsed
    const collapsibleState = category === 'active'
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed;
    super(label, collapsibleState);
    this.category = category;
    this.id = `category:${category}`;
    this.contextValue = 'category';
    this.updateCount(count, statusCounts);
    this.iconPath = category === 'active'
      ? new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('charts.blue'))
      : new vscode.ThemeIcon('history', new vscode.ThemeColor('descriptionForeground'));
  }

  updateCount(count: number, statusCounts?: StatusCounts): void {
    if (this.category === 'active' && statusCounts && count > 0) {
      // Show status breakdown for active sessions
      const parts: string[] = [];
      if (statusCounts.working > 0) {
        parts.push(`${statusCounts.working} working`);
      }
      if (statusCounts.paused > 0) {
        parts.push(`${statusCounts.paused} paused`);
      }
      if (statusCounts.done > 0) {
        parts.push(`${statusCounts.done} done`);
      }
      this.description = parts.length > 0 ? parts.join(' · ') : `${count} session${count !== 1 ? 's' : ''}`;
    } else {
      this.description = `${count} session${count !== 1 ? 's' : ''}`;
    }
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

/**
 * Tree item showing currently executing tool with spinning icon
 */
class CurrentToolItem extends vscode.TreeItem {
  public readonly sessionFilePath: string;

  constructor(tool: CurrentTool, sessionFilePath: string) {
    const label = formatToolLabel(tool.name, tool.input);
    super(label, vscode.TreeItemCollapsibleState.None);

    this.sessionFilePath = sessionFilePath;
    this.id = `${sessionFilePath}:current-tool`;
    this.contextValue = "currentTool";

    // Use tool-specific icon with spinning animation
    const iconConfig = getToolIcon(tool.name);
    this.iconPath = new vscode.ThemeIcon(
      `${iconConfig.icon}~spin`,
      new vscode.ThemeColor(iconConfig.color || "charts.blue")
    );

    // Show elapsed time
    this.description = formatElapsedTime(tool.startTime);

    // Tooltip with full details
    this.tooltip = new vscode.MarkdownString(
      `**${tool.name}** (in progress)\n\n` +
      `\`\`\`json\n${JSON.stringify(tool.input, null, 2)}\n\`\`\``
    );
  }
}

/**
 * Tree item showing a completed tool execution
 */
class ToolHistoryItem extends vscode.TreeItem {
  public readonly sessionFilePath: string;
  public readonly tool: RecentTool;

  constructor(tool: RecentTool, sessionFilePath: string, index: number) {
    const label = formatToolLabel(tool.name, tool.input);
    super(label, vscode.TreeItemCollapsibleState.None);

    this.tool = tool;
    this.sessionFilePath = sessionFilePath;
    this.id = `${sessionFilePath}:tool:${index}`;
    this.contextValue = "toolHistory";

    // Use tool-specific icon (faded color for completed)
    const iconConfig = getToolIcon(tool.name);
    this.iconPath = new vscode.ThemeIcon(
      iconConfig.icon,
      new vscode.ThemeColor("descriptionForeground")
    );

    // Show duration
    this.description = formatToolDescription(tool.name, tool.input, tool.result, tool.duration);

    // Tooltip with full details
    const resultStr = tool.result ? `\n\n**Result:**\n\`\`\`json\n${JSON.stringify(tool.result, null, 2).slice(0, 500)}...\n\`\`\`` : "";
    this.tooltip = new vscode.MarkdownString(
      `**${tool.name}** completed in ${this.description}\n\n` +
      `**Input:**\n\`\`\`json\n${JSON.stringify(tool.input, null, 2)}\n\`\`\`` +
      resultStr
    );
  }
}

/**
 * Tree item showing collapsed group of older tool executions
 */
class ToolHistoryGroupItem extends vscode.TreeItem {
  public readonly sessionFilePath: string;
  public readonly tools: RecentTool[];

  constructor(tools: RecentTool[], sessionFilePath: string) {
    super(`+${tools.length} more tool uses`, vscode.TreeItemCollapsibleState.Collapsed);

    this.tools = tools;
    this.sessionFilePath = sessionFilePath;
    this.id = `${sessionFilePath}:tool-group`;
    this.contextValue = "toolHistoryGroup";

    // History icon
    this.iconPath = new vscode.ThemeIcon("history", new vscode.ThemeColor("descriptionForeground"));

    this.description = "(expand to see)";
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

/**
 * Extract file path from tool input if it's a file operation
 */
function getToolFilePath(tool: RecentTool): string | null {
  const input = tool.input as Record<string, unknown>;
  if (tool.name === "Read" || tool.name === "Write" || tool.name === "Edit") {
    return input.file_path as string || null;
  }
  if (tool.name === "NotebookEdit") {
    return input.notebook_path as string || null;
  }
  return null;
}

/**
 * Collapsible section containing all tool operations
 */
class ToolsSectionItem extends vscode.TreeItem {
  public readonly tools: RecentTool[];
  public readonly sessionFilePath: string;

  constructor(tools: RecentTool[], sessionFilePath: string) {
    super("Tools", vscode.TreeItemCollapsibleState.Collapsed);

    this.tools = tools;
    this.sessionFilePath = sessionFilePath;
    this.id = `${sessionFilePath}:tools-section`;
    this.contextValue = "toolsSection";

    this.iconPath = new vscode.ThemeIcon("tools", new vscode.ThemeColor("descriptionForeground"));
    this.description = `${tools.length} recent`;
    this.tooltip = `${tools.length} tool operations in this session (click to expand)`;
  }
}

/**
 * Collapsible section containing all tasks/todos
 */
class TasksSectionItem extends vscode.TreeItem {
  public readonly todos: TodoItem[];
  public readonly sessionFilePath: string;

  constructor(todos: TodoItem[], sessionFilePath: string, completedCount: number) {
    super("Tasks", vscode.TreeItemCollapsibleState.Collapsed);

    this.todos = todos;
    this.sessionFilePath = sessionFilePath;
    this.id = `${sessionFilePath}:tasks-section`;
    this.contextValue = "tasksSection";

    this.iconPath = new vscode.ThemeIcon("checklist", new vscode.ThemeColor("descriptionForeground"));
    this.description = `${completedCount}/${todos.length} done`;
    this.tooltip = `${todos.length} tasks (${completedCount} completed) - click to expand`;
  }
}

/**
 * Tree item grouping multiple operations on the same file
 */
class FileGroupItem extends vscode.TreeItem {
  public readonly tools: RecentTool[];
  public readonly sessionFilePath: string;
  public readonly filePath: string;

  constructor(filePath: string, tools: RecentTool[], sessionFilePath: string, index: number) {
    const fileName = path.basename(filePath);
    const toolNames = [...new Set(tools.map(t => t.name))].join(', ');
    super(fileName, vscode.TreeItemCollapsibleState.Collapsed);

    this.filePath = filePath;
    this.tools = tools;
    this.sessionFilePath = sessionFilePath;
    // Use index-based ID to avoid issues with long file paths
    this.id = `${sessionFilePath}:filegroup:${index}`;
    this.contextValue = "fileGroup";

    // File icon
    this.iconPath = new vscode.ThemeIcon("file-code", new vscode.ThemeColor("charts.blue"));

    // Description shows tool types
    this.description = `${tools.length}× (${toolNames})`;

    // Tooltip with full path
    this.tooltip = new vscode.MarkdownString(
      `**${fileName}**\n\n` +
      `${tools.length} operations: ${toolNames}\n\n` +
      `\`${filePath}\``
    );
  }
}

