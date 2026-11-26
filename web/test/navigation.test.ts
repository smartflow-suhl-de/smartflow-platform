import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { buildNavigation, groupNavigation, pageTitle, resolveAliasRedirect, utilityNavigation } =
  await import('../src/lib/navigation.ts');
const { getMessages } = await import('../src/lib/i18n.ts');

const messages = getMessages('de');

/** One plugin entry shaped exactly like the API returns it. */
type NavEntryShape = {
  plugin: string;
  label: string;
  path: string;
  group: 'work' | 'management';
  icon: string;
  order: number;
  roles: Array<'operator' | 'tenant_admin' | 'employee'>;
  createLabel: string | null;
  aliases: string[];
};

function pluginEntry(patch: Partial<NavEntryShape> = {}): NavEntryShape {
  return {
    plugin: 'invoices',
    label: 'Rechnungen',
    path: '/invoices',
    group: 'work',
    icon: 'file',
    order: 30,
    roles: ['operator'],
    createLabel: null,
    aliases: [],
    ...patch,
  };
}

describe('buildNavigation', () => {
  it('gives every role the overview entry', () => {
    for (const role of ['operator', 'tenant_admin', 'employee'] as const) {
      const items = buildNavigation(role, [], messages);
      assert.ok(
        items.some((item) => item.path === '/'),
        `${role} misses the overview`,
      );
    }
  });

  it('shows tenants to operators only', () => {
    const operator = buildNavigation('operator', [], messages).map((item) => item.path);
    const admin = buildNavigation('tenant_admin', [], messages).map((item) => item.path);
    const employee = buildNavigation('employee', [], messages).map((item) => item.path);

    assert.ok(operator.includes('/tenants'));
    assert.equal(admin.includes('/tenants'), false);
    assert.equal(employee.includes('/tenants'), false);
  });

  it('hides a plugin entry that names no role', () => {
    const entry = pluginEntry({ roles: [] });

    assert.equal(
      buildNavigation('operator', [entry], messages).some((i) => i.path === '/invoices'),
      false,
    );
    assert.equal(
      buildNavigation('employee', [entry], messages).some((i) => i.path === '/invoices'),
      false,
    );
  });

  it('filters a plugin entry that names roles by the current role', () => {
    const restricted = pluginEntry({ roles: ['operator'] });

    assert.ok(
      buildNavigation('operator', [restricted], messages).some((i) => i.path === '/invoices'),
    );
    assert.equal(
      buildNavigation('employee', [restricted], messages).some((i) => i.path === '/invoices'),
      false,
    );
  });

  it('lets a plugin entry override a core entry on the same path', () => {
    const items = buildNavigation(
      'operator',
      [pluginEntry({ path: '/tenants', label: 'Kunden' })],
      messages,
    );
    const tenants = items.filter((item) => item.path === '/tenants');

    assert.equal(tenants.length, 1);
    assert.equal(tenants[0]?.label, 'Kunden');
  });

  it('sorts by order and then by label', () => {
    const items = buildNavigation(
      'operator',
      [
        pluginEntry({ path: '/b', label: 'Beta', order: 10 }),
        pluginEntry({ path: '/a', label: 'Alpha', order: 10 }),
      ],
      messages,
    );
    const sameOrder = items.filter((item) => item.order === 10).map((item) => item.label);

    assert.deepEqual(
      sameOrder,
      [...sameOrder].sort((a, b) => a.localeCompare(b, 'de')),
    );
  });

  it('badges the tenants entry with the suspended count', () => {
    const items = buildNavigation('operator', [], messages, 3);
    const tenants = items.find((item) => item.path === '/tenants');

    assert.deepEqual(tenants?.badge, { value: 3, tone: 'bad' });
  });

  it('adds no badge without suspended tenants', () => {
    const items = buildNavigation('operator', [], messages, 0);
    assert.equal(items.find((item) => item.path === '/tenants')?.badge, undefined);
  });

  it('marks settings and help as utility entries', () => {
    const items = buildNavigation('operator', [], messages);
    const utility = utilityNavigation(items).map((item) => item.path);

    assert.deepEqual(utility.sort(), ['/help', '/settings']);
  });
});

describe('groupNavigation', () => {
  it('returns only non-empty groups and never utility entries', () => {
    const groups = groupNavigation(buildNavigation('operator', [], messages));

    assert.deepEqual(
      groups.map((group) => group.group),
      ['work', 'management'],
    );
    assert.equal(
      groups.some((group) => group.items.some((item) => item.path === '/help')),
      false,
    );
  });

  it('skips a group that has no entries', () => {
    const groups = groupNavigation([
      {
        id: 'x:/x',
        plugin: 'x',
        label: 'X',
        path: '/x',
        group: 'work',
        icon: 'file',
        order: 1,
        roles: [],
        createLabel: null,
        aliases: [],
      },
    ]);

    assert.deepEqual(
      groups.map((group) => group.group),
      ['work'],
    );
  });
});

describe('pageTitle', () => {
  it('labels the overview route', () => {
    const items = buildNavigation('operator', [], messages);
    assert.equal(pageTitle('/', items), 'Übersicht');
  });

  it('labels an exact route match', () => {
    const items = buildNavigation('operator', [], messages);
    assert.equal(pageTitle('/tenants', items), 'Mandanten');
  });

  it('labels a nested plugin route by its longest prefix', () => {
    const items = buildNavigation(
      'operator',
      [
        pluginEntry({ path: '/invoices', label: 'Rechnungen', order: 30 }),
        pluginEntry({ path: '/invoices/archive', label: 'Archiv', order: 31 }),
      ],
      messages,
    );

    assert.equal(pageTitle('/invoices/archive/2026', items), 'Archiv');
    assert.equal(pageTitle('/invoices/new', items), 'Rechnungen');
  });

  it('returns null for a path no entry covers', () => {
    const items = buildNavigation('operator', [], messages);
    assert.equal(pageTitle('/unbekannt', items), null);
    // `/` must not swallow every other route as a prefix.
    assert.equal(pageTitle('/nichts', items), null);
  });
});

describe('resolveAliasRedirect', () => {
  it('maps a German alias to the canonical path', () => {
    const items = buildNavigation('operator', [], messages);
    assert.equal(resolveAliasRedirect('/mandanten', items), '/tenants');
  });

  it('resolves aliases of plugin entries', () => {
    const items = buildNavigation(
      'operator',
      [pluginEntry({ aliases: ['/rechnungen'] })],
      messages,
    );
    assert.equal(resolveAliasRedirect('/rechnungen', items), '/invoices');
  });

  it('returns null for a path without an alias', () => {
    const items = buildNavigation('operator', [], messages);
    assert.equal(resolveAliasRedirect('/unbekannt', items), null);
  });

  it('does not redirect a path that is already canonical', () => {
    const items = buildNavigation('operator', [], messages);
    assert.equal(resolveAliasRedirect('/tenants', items), null);
  });
});
