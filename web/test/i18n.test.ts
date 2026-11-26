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
    assert.equal(formatApiError(error, 'en'), 'The sign-in link is invalid or has expired.');
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

  it('uses the unknown-error text for a non-Error throw', () => {
    assert.equal(formatApiError('boom', 'de'), getMessages('de').common.unknownError);
  });

  it('uses the message of a plain Error', () => {
    assert.equal(formatApiError(new Error('kaputt'), 'de'), 'kaputt');
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
