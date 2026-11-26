/**
 * Keyset cursors for `{ items, total, nextCursor }` lists.
 *
 * A cursor is the sort key of the last row — `created_at` plus `id` as the
 * tiebreak — encoded as base64url so clients cannot build or reason about one.
 * The kernel owns the shape; every plugin list uses it.
 */
export interface KeysetCursor {
  created_at: string;
  id: string;
}

export function encodeCursor(cursor: KeysetCursor): string {
  return Buffer.from(
    JSON.stringify({ created_at: cursor.created_at, id: cursor.id }),
    'utf8',
  ).toString('base64url');
}

export function decodeCursor(value: string): KeysetCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const candidate = parsed as Partial<KeysetCursor>;
    if (typeof candidate.created_at !== 'string' || typeof candidate.id !== 'string') return null;
    return { created_at: candidate.created_at, id: candidate.id };
  } catch {
    return null;
  }
}
