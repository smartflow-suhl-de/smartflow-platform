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

/**
 * The smallest element the focus-trap helpers touch: query a selector, report
 * whether something in the tree contains a node, and take focus.
 *
 * It is deliberately not a DOM emulator. Selector matching is limited to the
 * class tokens and `[disabled]`/`[tabindex]` attributes a test sets explicitly,
 * which is exactly what a focus-ring test needs to distinguish.
 */
export class FakeNode {
  readonly tagName: string;
  readonly children: FakeNode[] = [];
  readonly attributes = new Map<string, string>();
  private focusHandler: (() => void) | null = null;

  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
  }

  append(...nodes: FakeNode[]): this {
    for (const node of nodes) this.children.push(node);
    return this;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  getClientRects(): unknown[] {
    return [{}];
  }

  onFocus(handler: () => void): this {
    this.focusHandler = handler;
    return this;
  }

  focus(): void {
    // A disabled control refuses focus, exactly like the browser.
    if (this.attributes.has('disabled')) return;
    // `document` is the stub from this module, whose `activeElement` is a
    // plain field; the DOM lib types it as read-only.
    (document as unknown as { activeElement: unknown }).activeElement = this;
    this.focusHandler?.();
  }

  contains(node: FakeNode | null): boolean {
    if (!node) return false;
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }

  /** Matches only the handful of tokens the focus-trap selector uses. */
  matchesSelector(selector: string): boolean {
    return selector.split(',').some((part) => this.matchesToken(part.trim()));
  }

  private matchesToken(token: string): boolean {
    if (token.startsWith('[tabindex]')) {
      return this.attributes.has('tabindex') && this.attributes.get('tabindex') !== '-1';
    }

    const tag = token
      .replace(/:not\(\[disabled\]\)/, '')
      .replace('[href]', '')
      .trim();
    if (this.tagName !== tag.toUpperCase()) return false;
    if (token.includes(':not([disabled])') && this.attributes.has('disabled')) return false;
    if (token.includes('[href]') && !this.attributes.has('href')) return false;
    return true;
  }

  querySelectorAll<T = FakeNode>(selector: string): T[] {
    const found: FakeNode[] = [];
    const walk = (node: FakeNode): void => {
      for (const child of node.children) {
        if (child.matchesSelector(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found as unknown as T[];
  }
}

export interface BrowserStub {
  location: FakeLocation;
  history: FakeHistory;
  documentElement: FakeElement;
  metaThemeColor: FakeElement | null;
  storage: Map<string, string>;
  mediaQueries: Map<string, boolean>;
  scrollCalls: Array<{ x: number; y: number }>;
  /** Root of the fake tree `document.contains` answers against. */
  documentRoot: FakeNode;
  eventTypes(): string[];
  reset(): void;
}

let storage = new Map<string, string>();
let mediaQueries = new Map<string, boolean>();
let metaThemeColor: FakeElement | null = null;
let scrollCalls: Array<{ x: number; y: number }> = [];
let documentRoot = new FakeNode('html');

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
    scrollTo(x: number, y: number) {
      scrollCalls.push({ x, y });
    },
  };

  const doc = {
    documentElement,
    querySelector(selector: string) {
      return selector.includes('theme-color') ? metaThemeColor : null;
    },
    setAttribute() {},
    activeElement: documentRoot as unknown,
    contains(node: unknown) {
      return node === documentRoot || documentRoot.contains(node as never);
    },
    addEventListener(type: string, handler: (event: unknown) => void) {
      listeners.add({ type, handler });
    },
    removeEventListener(type: string, handler: (event: unknown) => void) {
      for (const entry of listeners) {
        if (entry.type === type && entry.handler === handler) listeners.delete(entry);
      }
    },
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
  get scrollCalls() {
    return scrollCalls;
  },
  get documentRoot() {
    return documentRoot;
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
    scrollCalls = [];
    documentRoot = new FakeNode('html');
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
