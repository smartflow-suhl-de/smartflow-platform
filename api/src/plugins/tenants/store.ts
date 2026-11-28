import type { Tenant, TenantDetails, TenantStatus } from '../../shared/contract.ts';

/**
 * Master data captured per tenant, in display order. The column names are the
 * API field names, so a form can post them back untranslated.
 */
export const DETAIL_FIELDS = [
  'legal_name',
  'legal_form',
  'customer_number',
  'industry',
  'street',
  'address_extra',
  'postal_code',
  'city',
  'country',
  'contact_name',
  'contact_role',
  'contact_email',
  'contact_phone',
  'contact_mobile',
  'email',
  'phone',
  'website',
  'vat_id',
  'tax_number',
  'register_court',
  'register_number',
  'notes',
] as const;

export type DetailField = (typeof DETAIL_FIELDS)[number];

/** Selected in this order by every tenant query. */
export const DETAIL_SELECT = DETAIL_FIELDS.join(', ');

export function emptyDetails(): TenantDetails {
  return {
    legal_name: null,
    legal_form: null,
    customer_number: null,
    industry: null,
    street: null,
    address_extra: null,
    postal_code: null,
    city: null,
    country: null,
    contact_name: null,
    contact_role: null,
    contact_email: null,
    contact_phone: null,
    contact_mobile: null,
    email: null,
    phone: null,
    website: null,
    vat_id: null,
    tax_number: null,
    register_court: null,
    register_number: null,
    notes: null,
  };
}

/** A tenant as stored. `created_at` is the keyset cursor, with `id` as tiebreak. */
export type TenantRow = {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  created_at: string;
} & Record<DetailField, string | null>;

export function toTenant(row: TenantRow): Tenant {
  const details = emptyDetails();
  for (const field of DETAIL_FIELDS) details[field] = row[field] ?? null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    created_at: row.created_at,
    details,
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
