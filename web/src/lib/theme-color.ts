/**
 * Small colour helpers for themes. Values are plain sRGB hex strings, so a
 * theme definition can travel as JSON without a colour library.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const WHITE = '#ffffff';
const BLACK = '#000000';

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_PATTERN.test(value.trim());
}

export function parseHex(value: string): Rgb | null {
  if (!isHexColor(value)) return null;
  const digits = value.trim().slice(1);
  const full =
    digits.length === 3
      ? digits
          .split('')
          .map((part) => part + part)
          .join('')
      : digits;
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

export function toHex(rgb: Rgb): string {
  const part = (value: number): string => clampChannel(value).toString(16).padStart(2, '0');
  return `#${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}`;
}

/** Normalises a valid hex colour to lowercase `#rrggbb`. */
export function normalizeHex(value: string): string {
  const rgb = parseHex(value);
  if (!rgb) throw new Error(`not a hex colour: ${value}`);
  return toHex(rgb);
}

/** Blends two colours; `weightB` is the share of `b` (0..1). */
export function mix(a: string, b: string, weightB: number): string {
  const left = parseHex(a);
  const right = parseHex(b);
  if (!left || !right) throw new Error('mix needs hex colours');
  const weight = Math.max(0, Math.min(1, weightB));
  return toHex({
    r: left.r + (right.r - left.r) * weight,
    g: left.g + (right.g - left.g) * weight,
    b: left.b + (right.b - left.b) * weight,
  });
}

function linearChannel(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance, 0 (black) .. 1 (white). */
export function relativeLuminance(color: string): number {
  const rgb = parseHex(color);
  if (!rgb) return 0;
  return (
    0.2126 * linearChannel(rgb.r) + 0.7152 * linearChannel(rgb.g) + 0.0722 * linearChannel(rgb.b)
  );
}

/** WCAG contrast ratio, 1 .. 21. */
export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Returns `color`, moved as little as possible towards black or white, until it
 * reaches `target` contrast against `background`. A colour that already passes
 * comes back unchanged, so hand-picked palettes keep their exact values.
 */
export function ensureContrast(color: string, background: string, target: number): string {
  const start = normalizeHex(color);
  if (contrastRatio(start, background) >= target) return start;

  const towards = relativeLuminance(background) < 0.5 ? WHITE : BLACK;
  let low = 0;
  let high = 1;
  let best = towards;
  for (let step = 0; step < 24; step += 1) {
    const middle = (low + high) / 2;
    const candidate = mix(start, towards, middle);
    if (contrastRatio(candidate, background) >= target) {
      best = candidate;
      high = middle;
    } else {
      low = middle;
    }
  }
  return best;
}
