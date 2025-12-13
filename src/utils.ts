/**
 * Utility functions for the Claude Watch extension
 */

import { realpathSync } from "fs";

/**
 * Wraps a promise with a timeout. If the promise doesn't resolve within the
 * specified time, the returned promise will reject with a timeout error.
 *
 * @param promise The promise to wrap with a timeout
 * @param ms Timeout duration in milliseconds
 * @param errorMessage Error message to use when timeout occurs
 * @returns A promise that races between the original promise and the timeout
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  errorMessage: string
): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(errorMessage)), ms);
  });
  return Promise.race([promise, timeout]);
}

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
