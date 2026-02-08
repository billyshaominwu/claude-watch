import * as vscode from "vscode";
import { SessionState, SessionStatus } from "./transcriptParser";
import { SessionRegistry, RecentTool } from "./sessionRegistry";
import {
  TreeItemType,
  CategoryItem,
  SessionItem,
  OldSessionItem,
  ContextInfoItem,
  TodoListItem,
  CurrentToolItem,
  ToolHistoryItem,
  ToolHistoryGroupItem,
  FileGroupItem,
  ToolsSectionItem,
  TasksSectionItem,
  StatusCounts,
  HistoryStats,
  getToolFilePath,
} from "./treeItems";

// Constants
const MAX_VISIBLE_TOOLS = 3; // Number of recent tools to show before collapsing

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
  private sessionAliases: Map<string, string> = new Map(); // sessionId -> alias

  // Cache tree items by filePath to ensure stable object references across refreshes
  private sessionItemCache: Map<string, SessionItem> = new Map();
  private oldSessionItemCache: Map<string, OldSessionItem> = new Map();
  private contextItemCache: Map<string, ContextInfoItem> = new Map();

  // Category items (cached for stable references)
  private activeCategoryItem: CategoryItem | null = null;
  private oldCategoryItem: CategoryItem | null = null;

  // Parent tracking for getParent() - needed for reveal() to work
  private parentMap: Map<TreeItemType, TreeItemType> = new Map();

  constructor(
    registry: SessionRegistry,
    context: vscode.ExtensionContext
  ) {
    this.registry = registry;
    this.workspaceState = context.workspaceState;
    // Load pinned sessions from workspace state
    const savedPinned = this.workspaceState.get<string[]>('pinnedSessions', []);
    this.pinnedSessions = new Set(savedPinned);
    // Load session aliases from workspace state
    const savedAliases = this.workspaceState.get<Record<string, string>>('sessionAliases', {});
    this.sessionAliases = new Map(Object.entries(savedAliases));
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
    // Clear parent map - will be rebuilt on getChildren
    this.parentMap.clear();
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
    // Clear parent map - will be rebuilt on getChildren
    this.parentMap.clear();
    this.refresh();
  }

  getTreeItem(element: TreeItemType): vscode.TreeItem {
    return element;
  }

  getParent(element: TreeItemType): TreeItemType | undefined {
    return this.parentMap.get(element);
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
   * Compute aggregate stats for history/inactive sessions
   */
  private computeHistoryStats(): HistoryStats {
    let totalTokens = 0;
    for (const session of this.inactiveSessions) {
      totalTokens += session.tokenUsage.totalOutputTokens;
    }
    return {
      sessionCount: this.inactiveSessions.length,
      totalTokens
    };
  }

  /**
   * Compute aggregate token count for active sessions
   */
  private computeActiveTokens(): number {
    let totalTokens = 0;
    for (const session of this.sessions) {
      totalTokens += session.tokenUsage.contextTokens;
    }
    return totalTokens;
  }

  /**
   * Get or create a cached SessionItem, updating its properties from the session state
   */
  private getOrCreateSessionItem(session: SessionState, hasChildren: boolean): SessionItem {
    const isPinned = this.pinnedSessions.has(session.filePath);
    const alias = this.sessionAliases.get(session.sessionId);
    let item = this.sessionItemCache.get(session.filePath);
    if (item) {
      item.updateFromSession(session, hasChildren, isPinned, alias);
    } else {
      item = new SessionItem(session, hasChildren, isPinned, alias);
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

  /**
   * Get all cached session items (for expand all functionality)
   */
  getAllSessionItems(): SessionItem[] {
    return Array.from(this.sessionItemCache.values());
  }

  /**
   * Get category items (for expand all functionality)
   * Forces initialization if needed by calling getChildren
   */
  async getCategoryItems(): Promise<CategoryItem[]> {
    // Ensure categories are initialized by calling getChildren at root
    if (!this.activeCategoryItem || !this.oldCategoryItem) {
      await this.getChildren(undefined);
    }
    const items: CategoryItem[] = [];
    if (this.activeCategoryItem) items.push(this.activeCategoryItem);
    if (this.oldCategoryItem) items.push(this.oldCategoryItem);
    return items;
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
            new ToolHistoryItem(tool, element.sessionFilePath, MAX_VISIBLE_TOOLS + i, "overflow")
          )
        );
      }

      // FileGroupItem: return tools for that file
      if (element instanceof FileGroupItem) {
        return Promise.resolve(
          element.tools.map((tool, i) =>
            new ToolHistoryItem(tool, element.sessionFilePath, i, "file")
          )
        );
      }

      // ToolsSectionItem: return tool children (file groups, tool items, overflow group)
      if (element instanceof ToolsSectionItem) {
        const children: TreeItemType[] = [];
        const tools = element.tools;
        const sessionFilePath = element.sessionFilePath;

        // Track which tools have been displayed
        const displayedTools = new Set<RecentTool>();

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
            fileTools.forEach(t => displayedTools.add(t));
          } else {
            children.push(new ToolHistoryItem(fileTools[0], sessionFilePath, displayedCount, "section"));
            displayedTools.add(fileTools[0]);
          }
          displayedCount++;
        }

        // Show non-file tools (Bash, etc.)
        for (const tool of nonFileTools) {
          if (displayedCount >= MAX_VISIBLE_TOOLS) break;
          children.push(new ToolHistoryItem(tool, sessionFilePath, displayedCount, "section"));
          displayedTools.add(tool);
          displayedCount++;
        }

        // Collapsed group for tools NOT yet displayed
        const hiddenTools = tools.filter(t => !displayedTools.has(t));
        if (hiddenTools.length > 0) {
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
          // Sort: pinned sessions first, then by creation time (stable, doesn't change during session)
          mainSessions.sort((a, b) => {
            const aPinned = this.pinnedSessions.has(a.filePath);
            const bPinned = this.pinnedSessions.has(b.filePath);
            if (aPinned !== bPinned) return aPinned ? -1 : 1;
            return b.created - a.created;
          });
          const items = mainSessions.map((session) => this.getOrCreateSessionItem(session, true));
          // Track parent for reveal() to work
          items.forEach(item => this.parentMap.set(item, element));
          return Promise.resolve(items);
        } else {
          // Return old sessions sorted by creation time (most recent first)
          const oldSessions = [...this.inactiveSessions].sort(
            (a, b) => b.created - a.created
          );
          const items = oldSessions.map((session) => this.getOrCreateOldSessionItem(session));
          // Track parent for reveal() to work
          items.forEach(item => this.parentMap.set(item, element));
          return Promise.resolve(items);
        }
      }

      // SessionItem: return tools, tasks section, then agent children
      // (Context info is now inlined in the session description)
      const session = element.session;
      const children: TreeItemType[] = [];

      // Get tool state from registry
      const record = this.registry.getSessionRecord(session.sessionId);

      // 1. Current tool (if in progress)
      if (record?.currentTool) {
        children.push(new CurrentToolItem(record.currentTool, session.filePath));
      }

      // 2. Recent tools (show first 3 directly, rest in "More tools..." section)
      if (record?.recentTools && record.recentTools.length > 0) {
        const visibleTools = record.recentTools.slice(0, MAX_VISIBLE_TOOLS);
        const overflowTools = record.recentTools.slice(MAX_VISIBLE_TOOLS);

        // Group visible tools by file (for file operations)
        const fileGroups = new Map<string, RecentTool[]>();
        const nonFileTools: RecentTool[] = [];

        for (const tool of visibleTools) {
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
          if (fileTools.length > 1) {
            children.push(new FileGroupItem(filePath, fileTools, session.filePath, fileGroupIndex++));
          } else {
            children.push(new ToolHistoryItem(fileTools[0], session.filePath, displayedCount));
          }
          displayedCount++;
        }

        // Show non-file tools (Bash, etc.)
        for (const tool of nonFileTools) {
          children.push(new ToolHistoryItem(tool, session.filePath, displayedCount));
          displayedCount++;
        }

        // Put remaining tools in a collapsed "More tools..." section
        if (overflowTools.length > 0) {
          children.push(new ToolsSectionItem(overflowTools, session.filePath));
        }
      }

      // 3. Tasks section (collapsible)
      if (session.todos && session.todos.length > 0) {
        const completedCount = session.todos.filter(t => t.status === 'completed').length;
        children.push(new TasksSectionItem(session.todos, session.filePath, completedCount));
      }

      // 4. Agent children last, sorted by creation time for stable ordering
      const agents = this.getAgentChildren(session.sessionId);
      agents.sort((a, b) => b.created - a.created);
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
    const activeTokens = this.computeActiveTokens();
    if (!this.activeCategoryItem) {
      this.activeCategoryItem = new CategoryItem('active', 'Active', mainSessions.length, statusCounts, undefined, activeTokens);
    } else {
      this.activeCategoryItem.updateCount(mainSessions.length, statusCounts, undefined, activeTokens);
    }
    categories.push(this.activeCategoryItem);

    // History category (old/inactive sessions)
    const historyStats = this.computeHistoryStats();
    if (!this.oldCategoryItem) {
      this.oldCategoryItem = new CategoryItem('old', 'History', this.inactiveSessions.length, undefined, historyStats);
    } else {
      this.oldCategoryItem.updateCount(this.inactiveSessions.length, undefined, historyStats);
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

  async renameSession(item: TreeItemType): Promise<void> {
    // Only SessionItem can be renamed
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

    const sessionId = item.session.sessionId;
    const currentAlias = this.sessionAliases.get(sessionId) || '';

    const newAlias = await vscode.window.showInputBox({
      prompt: 'Enter a custom name for this session (leave empty to clear)',
      value: currentAlias,
      placeHolder: 'e.g., "Auth refactor" or "Bug fix #123"'
    });

    if (newAlias === undefined) {
      return; // User cancelled
    }

    if (newAlias === '') {
      this.sessionAliases.delete(sessionId);
    } else {
      this.sessionAliases.set(sessionId, newAlias);
    }

    // Persist to workspace state
    this.workspaceState.update('sessionAliases', Object.fromEntries(this.sessionAliases));
    this.refresh();
  }

  getSessionAlias(sessionId: string): string | undefined {
    return this.sessionAliases.get(sessionId);
  }
}
