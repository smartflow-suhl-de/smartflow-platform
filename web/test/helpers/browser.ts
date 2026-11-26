/**
 * Minimal browser stand-in for the web workspace tests.
 *
 * The SPA talks to a small, well-known slice of the browser API: `location`,
 * `history`, `localStorage`, `matchMedia`, a theme-colour meta tag and
 * `documentElement`. Rather than pull in a full DOM emulator, this module
 * installs exactly that slice on `globalThis` and resets it between tests.
 *
 * Anything a test needs beyond this slice belongs in QA against a real browser.
 */

interface Listener {
  type: string;
  handler: (event: unknown) => void;
}

const listeners = new Set<Listener>();

class FakeLocation {
  origin = 'http://127.0.0.1:5273';
  pathname = '/';
  search = '';
  href = 'http://127.0.0.1:5273/';

  private sync(href: string): void {
    const url = new URL(href, this.origin);
    this.pathname = url.pathname;
    this.search = url.search;
    this.href = `${this.origin}${url.pathname}${url.search}`;
  }

  assign(href: string): void {
    this.sync(href);
  }

  pushStateCalls: Array<{ state: unknown; url: string }> = [];
  replaceStateCalls: Array<{ state: unknown; url: string }> = [];
}

class FakeHistory {
  constructor(private readonly location: FakeLocation) {}

  pushState(state: unknown, _title: string, url: string): void {
    this.location.pushStateCalls.push({ state, url });
    this.location.assign(url);
  }

  replaceState(state: unknown, _title: string, url: string): void {
    this.location.replaceStateCalls.push({ state, url });
    this.location.assign(url);
  }
}

class FakeClassList {
  private readonly values = new Set<string>();

  add(...names: string[]): void {
    for (const name of names) this.values.add(name);
  }

  remove(...names: string[]): void {
    for (const name of names) this.values.delete(name);
  }

  contains(name: string): boolean {
    return this.values.has(name);
  }

  toggle(name: string, force?: boolean): boolean {
    const next = force ?? !this.values.has(name);
    if (next) this.values.add(name);
    else this.values.delete(name);
    return next;
  }

  get value(): string {
    return [...this.values].join(' ');
  }
}

class FakeElement {
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  classList = new FakeClassList();
  attributes = new Map<string, string>();
  lang = '';

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

export interface BrowserStub {
  location: FakeLocation;
  history: FakeHistory;
  documentElement: FakeElement;
  metaThemeColor: FakeElement | null;
  storage: Map<string, string>;
  mediaQueries: Map<string, boolean>;
  eventTypes(): string[];
  reset(): void;
}

let storage = new Map<string, string>();
let mediaQueries = new Map<string, boolean>();
let metaThemeColor: FakeElement | null = null;

function createDocumentElement(): FakeElement {
  return new FakeElement();
}

let documentElement = createDocumentElement();

const location = new FakeLocation();
const history = new FakeHistory(location);

function makeStorage(): Storage {
  return {
    get length() {
      return storage.size;
    },
    clear() {
      storage.clear();
    },
    getItem(key: string) {
      return storage.has(key) ? (storage.get(key) as string) : null;
    },
    key(index: number) {
      return [...storage.keys()][index] ?? null;
    },
    removeItem(key: string) {
      storage.delete(key);
    },
    setItem(key: string, value: string) {
      storage.set(key, String(value));
    },
  };
}

function install(): void {
  const win = {
    location,
    history,
    addEventListener(type: string, handler: (event: unknown) => void) {
      listeners.add({ type, handler });
    },
    removeEventListener(type: string, handler: (event: unknown) => void) {
      for (const entry of listeners) {
        if (entry.type === type && entry.handler === handler) listeners.delete(entry);
      }
    },
    matchMedia(query: string) {
      return {
        matches: mediaQueries.get(query) ?? false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
      };
    },
  };

  const doc = {
    documentElement,
    querySelector(selector: string) {
      return selector.includes('theme-color') ? metaThemeColor : null;
    },
    setAttribute() {},
  };

  Object.assign(globalThis, {
    window: win,
    document: doc,
    localStorage: makeStorage(),
    getComputedStyle: () => ({
      getPropertyValue: (name: string) => (name === '--color-paper' ? ' #f2efe7' : ''),
    }),
  });
}

install();

export const browser: BrowserStub = {
  location,
  history,
  get documentElement() {
    return documentElement;
  },
  get metaThemeColor() {
    return metaThemeColor;
  },
  get storage() {
    return storage;
  },
  get mediaQueries() {
    return mediaQueries;
  },
  eventTypes() {
    return [...new Set([...listeners].map((entry) => entry.type))];
  },
  reset() {
    listeners.clear();
    storage = new Map();
    mediaQueries = new Map();
    documentElement = createDocumentElement();
    location.pathname = '/';
    location.search = '';
    location.pushStateCalls = [];
    location.replaceStateCalls = [];
    metaThemeColor = null;
    install();
  },
};

/** Add a `<meta name="theme-color">` the theme helper can write to. */
export function addThemeColorMeta(): FakeElement {
  metaThemeColor = new FakeElement();
  return metaThemeColor;
}

/** Dispatch a window event to the listeners the SPA registered. */
export function dispatchWindowEvent(type: string, event: unknown = {}): void {
  for (const entry of [...listeners]) {
    if (entry.type === type) entry.handler(event);
  }
}

/** Point the fake browser at a URL before the module under test runs. */
export function setLocation(path: string): void {
  location.assign(path);
  location.pushStateCalls = [];
  location.replaceStateCalls = [];
}
