// The empty pane's Recent list (design spec section 12.5): which notes
// populate it, in what order, and the batched file-stat fallback used when
// the vault has no recorded open history yet. Pure selection logic is kept
// separate from the IPC stat calls so it is testable without a vault.

export const RECENT_NOTES_LIMIT = 5;

/**
 * Chooses the Recent list's rows: the vault's own most-recently-opened
 * record first, excluding notes already open in a tab in this window; the
 * vault's remaining notes by file modification time, most recent first,
 * when that record yields nothing. Capped at five.
 */
export function selectRecentPaths(
  recentlyOpened: readonly string[],
  notePaths: readonly string[],
  openInWindow: ReadonlySet<string>,
  fallbackByModifiedDesc: readonly string[],
): string[] {
  const known = new Set(notePaths);
  const fromHistory = recentlyOpened.filter(
    (path) => known.has(path) && !openInWindow.has(path),
  );
  const source =
    fromHistory.length > 0
      ? fromHistory
      : fallbackByModifiedDesc.filter(
          (path) => known.has(path) && !openInWindow.has(path),
        );
  return source.slice(0, RECENT_NOTES_LIMIT);
}

/**
 * Ranks every candidate path by file modification time, most recent first,
 * stat-ing in bounded batches (mirroring the tree-title loader) so a large
 * vault's fallback ranking never fires one request per file at once. A path
 * whose stat fails or reports no modification time drops out: it has
 * nothing to rank by.
 */
export async function rankByModifiedTime(
  paths: readonly string[],
  statModifiedMs: (path: string) => Promise<number | null>,
  batchSize = 16,
): Promise<string[]> {
  const ranked: { path: string; modifiedMs: number }[] = [];
  for (let start = 0; start < paths.length; start += batchSize) {
    const batch = paths.slice(start, start + batchSize);
    const stats = await Promise.all(
      batch.map(async (path) => {
        try {
          return { path, modifiedMs: await statModifiedMs(path) };
        } catch {
          return { path, modifiedMs: null };
        }
      }),
    );
    for (const stat of stats) {
      if (stat.modifiedMs !== null) {
        ranked.push({ path: stat.path, modifiedMs: stat.modifiedMs });
      }
    }
  }
  return ranked
    .sort((left, right) => right.modifiedMs - left.modifiedMs)
    .map((entry) => entry.path);
}
