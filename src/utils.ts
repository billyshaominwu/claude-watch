/**
 * Utility functions for the Claude Watch extension
 */

import { realpathSync } from "fs";

/**
 * Normalize a CWD path by resolving symlinks.
 * Returns the original path if resolution fails.
 */
export function normalizeCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

/**
 * Compare two CWD paths for equality.
 * Handles case sensitivity on macOS (case-insensitive by default).
 */
export function cwdEquals(a: string, b: string): boolean {
  const normalizedA = normalizeCwd(a);
  const normalizedB = normalizeCwd(b);

  if (process.platform === "darwin") {
    // macOS is case-insensitive by default
    return normalizedA.toLowerCase() === normalizedB.toLowerCase();
  }
  return normalizedA === normalizedB;
}
