import * as path from "path";

// Constants
const TOOL_LABEL_MAX_LENGTH = 60;

/**
 * Get the appropriate VS Code icon for a tool type.
 * Returns icon name and optional color.
 */
export function getToolIcon(name: string): { icon: string; color?: string } {
  switch (name) {
    // File operations
    case "Read":
      return { icon: "file", color: "charts.blue" };
    case "Write":
      return { icon: "new-file", color: "charts.green" };
    case "Edit":
      return { icon: "edit", color: "charts.yellow" };
    case "NotebookEdit":
      return { icon: "notebook", color: "charts.yellow" };

    // Search operations
    case "Grep":
      return { icon: "search", color: "charts.purple" };
    case "Glob":
      return { icon: "file-submodule", color: "charts.purple" };

    // Shell operations
    case "Bash":
      return { icon: "terminal", color: "charts.orange" };

    // Web operations
    case "WebFetch":
      return { icon: "globe", color: "charts.blue" };
    case "WebSearch":
      return { icon: "search", color: "charts.blue" };

    // Task/Agent operations
    case "Task":
      return { icon: "rocket", color: "charts.blue" };

    // Todo operations
    case "TodoWrite":
      return { icon: "checklist", color: "charts.green" };

    // User interaction
    case "AskUserQuestion":
      return { icon: "comment-discussion", color: "charts.yellow" };

    default:
      return { icon: "circle-outline" };
  }
}

/**
 * Format a tool name and input for display as a tree item label.
 * Examples:
 *   Read(config.ts)
 *   Grep('TODO')
 *   Bash: npm run test
 *   Edit(auth.ts)
 */
export function formatToolLabel(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Read":
      if (input.file_path) {
        const fileName = path.basename(String(input.file_path));
        return `Read(${fileName})`;
      }
      return "Read";

    case "Write":
      if (input.file_path) {
        const fileName = path.basename(String(input.file_path));
        return `Write(${fileName})`;
      }
      return "Write";

    case "Edit":
      if (input.file_path) {
        const fileName = path.basename(String(input.file_path));
        return `Edit(${fileName})`;
      }
      return "Edit";

    case "Bash":
      if (input.command) {
        const cmd = truncate(String(input.command), 40);
        return `Bash: ${cmd}`;
      }
      return "Bash";

    case "Grep":
      if (input.pattern) {
        const pattern = truncate(String(input.pattern), 30);
        return `Grep('${pattern}')`;
      }
      return "Grep";

    case "Glob":
      if (input.pattern) {
        return `Glob(${truncate(String(input.pattern), 30)})`;
      }
      return "Glob";

    case "WebFetch":
      if (input.url) {
        try {
          const url = new URL(String(input.url));
          return `WebFetch(${url.hostname})`;
        } catch {
          return `WebFetch(${truncate(String(input.url), 30)})`;
        }
      }
      return "WebFetch";

    case "WebSearch":
      if (input.query) {
        return `WebSearch('${truncate(String(input.query), 30)}')`;
      }
      return "WebSearch";

    case "Task":
      if (input.description) {
        return `Task: ${truncate(String(input.description), 40)}`;
      }
      if (input.prompt) {
        return `Task: ${truncate(String(input.prompt), 40)}`;
      }
      return "Task";

    case "TodoWrite":
      const todos = input.todos;
      if (Array.isArray(todos)) {
        return `TodoWrite(${todos.length} items)`;
      }
      return "TodoWrite";

    case "AskUserQuestion":
      return "AskUserQuestion";

    case "NotebookEdit":
      if (input.notebook_path) {
        const fileName = path.basename(String(input.notebook_path));
        return `NotebookEdit(${fileName})`;
      }
      return "NotebookEdit";

    default:
      return name;
  }
}

/**
 * Format a tool result for display as a tree item description.
 * Examples:
 *   "206 lines" (Read result)
 *   "5 matches" (Grep result)
 *   "120ms" (duration)
 */
export function formatToolDescription(
  name: string,
  input: Record<string, unknown>,
  result: Record<string, unknown> | null,
  duration: number
): string {
  const durationStr = formatDuration(duration);

  // Try to extract useful info from result
  if (result) {
    if (name === "Read" && typeof result === "object") {
      // Result is the file content, count lines
      const content = result as { content?: string } | string;
      if (typeof content === "string") {
        const lines = content.split("\n").length;
        return `${lines} lines (${durationStr})`;
      }
    }

    if (name === "Grep" && typeof result === "object") {
      // Result may have matches count
      const matches = (result as Record<string, unknown>).matches;
      if (Array.isArray(matches)) {
        return `${matches.length} matches (${durationStr})`;
      }
    }
  }

  // Default: just show duration
  return durationStr;
}

/**
 * Format duration in human-readable form
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Format elapsed time since start
 */
export function formatElapsedTime(startTime: number): string {
  const elapsed = Date.now() - startTime;
  return formatDuration(elapsed);
}

/**
 * Truncate a string with ellipsis
 */
function truncate(str: string, maxLength: number): string {
  // Remove newlines and extra whitespace
  const cleaned = str.replace(/\s+/g, " ").trim();
  if (cleaned.length > maxLength) {
    return cleaned.slice(0, maxLength - 1) + "…";
  }
  return cleaned;
}
