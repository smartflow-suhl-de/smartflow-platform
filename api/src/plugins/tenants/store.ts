import type { Tenant, TenantStatus } from '../../shared/contract.ts';

/** A tenant as stored. `created_at` is the keyset cursor, with `id` as tiebreak. */
export interface TenantRow {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  created_at: string;
}

export function toTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    created_at: row.created_at,
  };
}

export interface TenantListQuery {
  status?: TenantStatus;
  /** Case-insensitive match on name and slug. */
  q?: string;
  limit: number;
  cursor?: string;
}

export interface Cursor {
  created_at: string;
  id: string;
}

/** Cursors are opaque to the client: base64url JSON of the last row's key. */
export function encodeCursor(row: Cursor): string {
  return Buffer.from(JSON.stringify({ created_at: row.created_at, id: row.id }), 'utf8').toString(
    'base64url',
  );
}

export function decodeCursor(value: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const candidate = parsed as Partial<Cursor>;
    if (typeof candidate.created_at !== 'string' || typeof candidate.id !== 'string') return null;
    return { created_at: candidate.created_at, id: candidate.id };
  } catch {
    return null;
  }
}
