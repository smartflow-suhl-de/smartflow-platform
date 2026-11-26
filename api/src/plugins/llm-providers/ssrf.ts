/**
 * Target validation for operator-configured provider URLs.
 *
 * Two layers:
 * - `validateBaseUrl` is synchronous and runs when a provider is saved. It
 *   rejects schemes, credentials, query/fragment and literal addresses that are
 *   metadata, link-local, unspecified or loopback (loopback needs an explicit
 *   opt-in).
 * - `assertResolvedTarget` runs immediately before every request and resolves
 *   the hostname, so a name that points at a blocked address is refused even
 *   though the literal check passed.
 *
 * Private RFC 1918 ranges stay allowed on purpose: the plugin exists to connect
 * internal gateways. The blocked ranges are the ones that are never a gateway.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface BaseUrlOptions {
  allowHttp: boolean;
  /** Operator opt-in for a gateway on this host, e.g. a local sidecar. */
  allowLoopback: boolean;
}

const BLOCKED_HOSTNAMES = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
  'metadata.azure.internal',
  'metadata.azure.com',
]);

const BLOCKED_SUFFIXES = ['.metadata.google.internal', '.internal.cloudapp.net', '.localhost'];

export function loopbackAllowed(): boolean {
  return process.env.SF_LLM_ALLOW_LOOPBACK === '1';
}

/** Tests stub `fetch`, so they skip the DNS resolver but keep every literal rule. */
function skipDnsCheck(): boolean {
  return process.env.NODE_ENV === 'test' && process.env.SF_LLM_SKIP_DNS_CHECK === '1';
}

function ipv4ToInt(address: string): number {
  const parts = address.split('.').map((part) => Number.parseInt(part, 10));
  return (
    ((parts[0] ?? 0) << 24) + ((parts[1] ?? 0) << 16) + ((parts[2] ?? 0) << 8) + (parts[3] ?? 0)
  );
}

function inIpv4Range(value: number, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number.parseInt(bitsRaw ?? '32', 10);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (ipv4ToInt(base ?? '0.0.0.0') & mask);
}

const BLOCKED_IPV4 = [
  '0.0.0.0/8',
  '169.254.0.0/16',
  // Alibaba Cloud instance metadata. CGNAT (100.64.0.0/10) stays allowed
  // because internal gateways may live there; only the metadata address is out.
  '100.100.100.200/32',
  '192.0.0.0/24',
  '198.18.0.0/15',
  '224.0.0.0/4',
  '240.0.0.0/4',
];

function blockedIpv4(address: string, allowLoopback: boolean): string | null {
  const value = ipv4ToInt(address);
  if (inIpv4Range(value, '127.0.0.0/8') && !allowLoopback) return 'loopback';
  for (const range of BLOCKED_IPV4) {
    if (inIpv4Range(value, range)) return range;
  }
  return null;
}

/** Expands an IPv6 literal into eight 16-bit groups, or null when invalid. */
function ipv6Groups(address: string): number[] | null {
  let value = address.toLowerCase();
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  const embedded = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (embedded) {
    const octets = (embedded[2] ?? '').split('.').map((part) => Number.parseInt(part, 10));
    if (octets.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) return null;
    value = `${embedded[1]}${(((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16)}:${(
      ((octets[2] ?? 0) << 8) |
      (octets[3] ?? 0)
    ).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  const numbers = groups.map((group) => Number.parseInt(group, 16));
  if (numbers.some((number) => !Number.isFinite(number) || number < 0 || number > 0xffff)) {
    return null;
  }
  return numbers;
}

function blockedIpv6(address: string, allowLoopback: boolean): string | null {
  const groups = ipv6Groups(address);
  if (!groups) return 'invalid';
  const [first, second] = groups;
  const allZero = groups.every((group) => group === 0);
  if (allZero) return 'unspecified';
  const loopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  if (loopback && !allowLoopback) return 'loopback';
  if (((first ?? 0) & 0xffc0) === 0xfe80) return 'link-local';
  if (((first ?? 0) & 0xff00) === 0xff00) return 'multicast';
  // IPv4-mapped ::ffff:a.b.c.d
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const v4 = `${(groups[6] ?? 0) >> 8}.${(groups[6] ?? 0) & 0xff}.${(groups[7] ?? 0) >> 8}.${
      (groups[7] ?? 0) & 0xff
    }`;
    const blocked = blockedIpv4(v4, allowLoopback);
    if (blocked) return `ipv4-mapped ${blocked}`;
  }
  // AWS instance metadata (IPv6 ULA endpoint).
  if ((first ?? 0) === 0xfd00 && second === 0xec2) return 'metadata';
  return null;
}

function normalizeHost(raw: string): string {
  return raw.replace(/^\[/, '').replace(/\]$/, '').replace(/\.+$/, '').toLowerCase();
}

function literalBlock(host: string, allowLoopback: boolean): string | null {
  const kind = isIP(host);
  if (kind === 4) return blockedIpv4(host, allowLoopback);
  if (kind === 6) return blockedIpv6(host, allowLoopback);
  return null;
}

export function validateBaseUrl(raw: string, options: BaseUrlOptions): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('invalid-url');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && options.allowHttp)) {
    throw new Error('scheme');
  }
  if (url.username || url.password) throw new Error('credentials');
  if (url.search || url.hash) throw new Error('query');

  const host = normalizeHost(url.hostname);
  if (host.length === 0) throw new Error('host');
  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new Error('host');
  }
  if (host === 'localhost' && !options.allowLoopback) throw new Error('loopback');
  if (literalBlock(host, options.allowLoopback)) throw new Error('address');

  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path === '/' ? '' : path}`;
}

/** Refuses a hostname that resolves to a blocked address. */
export async function assertResolvedTarget(url: URL, allowLoopback: boolean): Promise<void> {
  const host = normalizeHost(url.hostname);
  if (isIP(host) !== 0) {
    // A literal never reaches the resolver, so the pre-flight has to check it here.
    if (literalBlock(host, allowLoopback)) throw new Error('blocked-target');
    return;
  }
  if (skipDnsCheck()) return;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error('unresolvable');
  }
  for (const entry of addresses) {
    if (literalBlock(entry.address, allowLoopback)) throw new Error('blocked-target');
  }
}

export const CHAT_PATH_PATTERN = /^\/(?:[A-Za-z0-9._~!$&'()*+,;=:@%/-]|%[0-9A-Fa-f]{2})*$/;

/**
 * Provider paths may carry a model placeholder such as Azure's
 * `/openai/deployments/{model}/chat/completions` or Gemini's
 * `/models/{model}:generateContent`. Only that exact shape is allowed; a stray
 * brace elsewhere still fails the character check.
 */
const CHAT_PATH_PLACEHOLDER = /\{[A-Za-z0-9_-]+\}/g;

export function isValidChatPath(value: string): boolean {
  if (!value.startsWith('/') || value.length > 200) return false;
  if (!CHAT_PATH_PATTERN.test(value.replace(CHAT_PATH_PLACEHOLDER, ''))) return false;
  if (value.includes('..') || value.includes('?') || value.includes('#')) return false;
  if (value.includes('//')) return false;
  return true;
}

const BLOCKED_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'cookie2',
  'set-cookie',
  'x-api-key',
  'api-key',
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'te',
  'upgrade',
]);

export function isBlockedExtraHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    BLOCKED_HEADERS.has(lower) ||
    lower.startsWith('proxy-') ||
    lower === 'x-forwarded-for' ||
    lower === 'x-real-ip'
  );
}
