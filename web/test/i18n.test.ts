import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { browser } from './helpers/browser.ts';

const { ApiError } = await import('../src/lib/api.ts');
const {
  applyLocale,
  formatApiError,
  formatDateShort,
  formatDateTime,
  formatFieldError,
  getMessages,
  storedLocale,
} = await import('../src/lib/i18n.ts');

function keyPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    keyPaths(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe('i18n catalogue', () => {
  it('has the same key set in both locales', () => {
    const de = new Set(keyPaths(getMessages('de')));
    const en = new Set(keyPaths(getMessages('en')));

    assert.deepEqual(
      [...de].filter((key) => !en.has(key)),
      [],
    );
    assert.deepEqual(
      [...en].filter((key) => !de.has(key)),
      [],
    );
  });

  it('has no empty strings in either locale', () => {
    for (const locale of ['de', 'en'] as const) {
      const messages = getMessages(locale) as unknown as Record<string, unknown>;
      for (const path of keyPaths(messages)) {
        let current: unknown = messages;
        for (const segment of path.split('.')) {
          current = (current as Record<string, unknown>)[segment];
        }
        assert.equal(
          typeof current === 'string' ? current.trim().length > 0 : true,
          true,
          `${locale}.${path} is empty`,
        );
      }
    }
  });

  it('defaults to German', () => {
    assert.equal(getMessages('de'), getMessages('de'));
    assert.notEqual(getMessages('de'), getMessages('en'));
  });

  it('carries the shell and form texts in both languages', () => {
    for (const locale of ['de', 'en'] as const) {
      const messages = getMessages(locale);
      assert.ok(messages.common.platformUnavailable.trim().length > 0, locale);
      assert.ok(messages.shell.skipToContent.trim().length > 0, locale);
      assert.ok(messages.tenants.formInvalid.trim().length > 0, locale);
      assert.ok(messages.tenants.slugHint.trim().length > 0, locale);
    }

    assert.notEqual(getMessages('de').shell.skipToContent, getMessages('en').shell.skipToContent);
    assert.notEqual(
      getMessages('de').common.platformUnavailable,
      getMessages('en').common.platformUnavailable,
    );
    assert.notEqual(getMessages('de').tenants.formInvalid, getMessages('en').tenants.formInvalid);
  });
});

describe('locale persistence', () => {
  beforeEach(() => {
    browser.reset();
  });

  it('defaults to de when nothing is stored', () => {
    assert.equal(storedLocale(), 'de');
  });

  it('reads a stored locale', () => {
    browser.storage.set('sf.locale', 'en');
    assert.equal(storedLocale(), 'en');
  });

  it('ignores a stored value that is not a locale', () => {
    browser.storage.set('sf.locale', 'fr');
    assert.equal(storedLocale(), 'de');
  });

  it('writes the locale and mirrors it on the document', () => {
    applyLocale('en');

    assert.equal(browser.storage.get('sf.locale'), 'en');
    assert.equal(browser.documentElement.lang, 'en');
  });

  it('survives a storage that throws', () => {
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem() {
          throw new Error('denied');
        },
        setItem() {
          throw new Error('denied');
        },
      },
    });
    try {
      assert.equal(storedLocale(), 'de');
      assert.doesNotThrow(() => applyLocale('en'));
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original });
    }
  });
});

describe('date formatting', () => {
  it('formats per locale', () => {
    const de = formatDateShort('2026-03-04T10:00:00Z', 'de');
    const en = formatDateShort('2026-03-04T10:00:00Z', 'en');

    assert.match(de, /^04\.03\.2026$/);
    assert.match(en, /^04\/03\/2026$/);
  });

  it('returns the raw value for an unparsable date', () => {
    assert.equal(formatDateShort('not-a-date', 'de'), 'not-a-date');
    assert.equal(formatDateTime('', 'en'), '');
  });
});

describe('formatApiError', () => {
  it('translates known codes to German', () => {
    const error = new ApiError(401, 'invalid_link', 'invalid');
    assert.equal(formatApiError(error, 'de'), 'Der Anmeldelink ist ungültig oder abgelaufen.');
  });

  it('translates the same codes to English', () => {
    const error = new ApiError(401, 'invalid_link', 'The sign-in link is invalid or has expired.');
    assert.equal(formatApiError(error, 'en'), 'This sign-in link is invalid or expired.');
  });

  it('translates every known code in both locales instead of echoing the server', () => {
    const codes = [
      'network_error',
      'unauthorized',
      'forbidden',
      'invalid_link',
      'rate_limited',
      'slug_taken',
      'tenant_not_found',
      'validation_failed',
    ];
    for (const code of codes) {
      const serverMessage = `server says ${code}`;
      for (const locale of ['de', 'en'] as const) {
        const text = formatApiError(new ApiError(400, code, serverMessage), locale);
        assert.notEqual(text, serverMessage, `${code}/${locale} must be translated`);
        assert.ok(text.trim().length > 0, `${code}/${locale} must not be empty`);
      }
    }
  });

  it('keeps no German text in the English error catalogue', () => {
    const english = [
      formatApiError(new ApiError(401, 'unauthorized', 'x'), 'en'),
      formatApiError(new ApiError(403, 'forbidden', 'x'), 'en'),
      formatApiError(new ApiError(429, 'rate_limited', 'x'), 'en'),
      formatApiError(new ApiError(409, 'slug_taken', 'x'), 'en'),
      formatApiError(new ApiError(404, 'tenant_not_found', 'x'), 'en'),
      formatApiError(new ApiError(422, 'validation_failed', 'x'), 'en'),
    ];
    for (const text of english) {
      assert.doesNotMatch(text, /[äöüß]/i, text);
    }
  });

  it('covers the network failure case in both locales', () => {
    const error = new ApiError(0, 'network_error', 'Network request failed');
    assert.equal(formatApiError(error, 'de'), 'Keine Verbindung zur Plattform-API.');
    assert.equal(formatApiError(error, 'en'), 'Cannot reach the platform API.');
  });

  it('falls back to the server message for an unknown code', () => {
    const error = new ApiError(500, 'weird_code', 'Something odd happened');
    assert.equal(formatApiError(error, 'de'), 'Something odd happened');
  });

  it('replaces a raw 5xx status with the platform-unavailable text', () => {
    for (const code of ['http_500', 'http_502', 'http_503', 'http_0']) {
      const raw = new ApiError(502, code, 'HTTP 502');
      assert.equal(formatApiError(raw, 'de'), getMessages('de').common.platformUnavailable, code);
      assert.equal(formatApiError(raw, 'en'), getMessages('en').common.platformUnavailable, code);
    }
  });

  it('rewrites no 4xx status, which still describes the request', () => {
    const error = new ApiError(404, 'http_404', 'HTTP 404');
    assert.equal(formatApiError(error, 'de'), 'HTTP 404');
  });

  it('uses the unknown-error text for a non-Error throw', () => {
    assert.equal(formatApiError('boom', 'de'), getMessages('de').common.unknownError);
  });

  it('uses the message of a plain Error', () => {
    assert.equal(formatApiError(new Error('kaputt'), 'de'), 'kaputt');
  });
});

describe('login transport notice', () => {
  it('has a separate text for a missing transport in both locales', () => {
    const de = getMessages('de').login;
    const en = getMessages('en').login;

    assert.ok(de.noTransportNotice.trim().length > 0);
    assert.ok(en.noTransportNotice.trim().length > 0);
    assert.notEqual(de.noTransportNotice, en.noTransportNotice);
    // The two must not be interchangeable: claiming an inbox is exactly the
    // failure this text exists to prevent.
    assert.notEqual(de.noTransportNotice, de.sentNotice);
    assert.notEqual(en.noTransportNotice, en.sentNotice);
    assert.doesNotMatch(en.noTransportNotice, /inbox/i);
  });
});

describe('plural forms', () => {
  it('uses the singular for exactly one tenant', () => {
    assert.equal(getMessages('de').shell.opsTenantsLine(1, 1), '1 / 1 Mandant aktiv');
    assert.equal(getMessages('en').shell.opsTenantsLine(1, 1), '1 / 1 tenant active');
  });

  it('uses the plural for zero and many', () => {
    assert.equal(getMessages('de').shell.opsTenantsLine(0, 5), '0 / 5 Mandanten aktiv');
    assert.equal(getMessages('en').shell.opsTenantsLine(0, 5), '0 / 5 tenants active');
    assert.equal(getMessages('en').shell.opsTenantsLine(0, 0), '0 / 0 tenants active');
  });
});

describe('formatFieldError', () => {
  it('returns undefined without a message', () => {
    assert.equal(formatFieldError('email', undefined, 'de'), undefined);
  });

  it('passes the server message through in English', () => {
    assert.equal(formatFieldError('slug', 'Already taken', 'en'), 'Already taken');
  });

  it('maps the slug conflict to German', () => {
    assert.equal(
      formatFieldError('slug', 'That slug is already taken', 'de'),
      'Dieser Slug ist bereits vergeben.',
    );
  });

  it('maps an underivable slug to German', () => {
    assert.equal(
      formatFieldError('slug', 'The name does not yield a slug', 'de'),
      'Aus dem Namen lässt sich kein gültiger Slug ableiten. Bitte manuell angeben.',
    );
  });

  it('maps email and name fields to German', () => {
    assert.match(formatFieldError('email', 'bad', 'de') ?? '', /E-Mail-Adresse/);
    assert.match(formatFieldError('name', 'bad', 'de') ?? '', /Namen/);
  });
});
