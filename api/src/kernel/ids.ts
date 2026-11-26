import { randomBytes } from 'node:crypto';

/**
 * Short, meaningless, prefixed identifiers. The prefix makes a stray id
 * recognisable in a log or a URL; the random part carries no meaning.
 */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function newId(prefix: string): string {
  const bytes = randomBytes(8);
  let body = '';
  for (const byte of bytes) body += ALPHABET[byte % ALPHABET.length];
  return `${prefix}_${body}`;
}

export function token(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Slugs: lowercase, hyphen-separated, 2–48 characters. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugFrom(name: string): string {
  return name
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
}

export interface ResolvedSlug {
  slug: string;
  /** True when the slug came from the name because the input was empty. */
  derived: boolean;
  valid: boolean;
}

/**
 * The slug rule in one place: a given slug must already be well formed, a
 * derived one is cleaned from the name. An invalid result is the caller's field
 * error — there is deliberately no silent fallback value.
 */
export function resolveSlug(name: string, rawSlug: string): ResolvedSlug {
  const given = rawSlug.trim();
  const slug = given.length > 0 ? given : slugFrom(name);
  return {
    slug,
    derived: given.length === 0,
    valid: SLUG_PATTERN.test(slug) && slug.length >= 2 && slug.length <= 48,
  };
}
