import assert from 'node:assert/strict';
import test from 'node:test';
import { migrate, openDatabase } from '../../src/kernel/db.ts';
import { EventBus } from '../../src/kernel/event-bus.ts';
import { platformMigrations } from '../../src/kernel/platform-migrations.ts';

/**
 * The event log is read with `order by created_at`. A millisecond has room for
 * more than one event, so the writer has to make that key strict; otherwise two
 * events of one request can swap places between reads.
 */
function createBus(times: Date[]) {
  const db = openDatabase(':memory:');
  migrate(db, platformMigrations);
  let index = 0;
  const bus = new EventBus(
    db,
    () => times[Math.min(index++, times.length - 1)] as Date,
    () => {},
  );
  const read = () =>
    db.prepare('select name, created_at from events order by created_at').all() as {
      name: string;
      created_at: string;
    }[];
  return { bus, read, close: () => db.close() };
}

test('two events in the same millisecond keep the order they were emitted in', () => {
  const fixed = new Date('2026-11-25T12:00:00.000Z');
  const { bus, read, close } = createBus([fixed]);

  bus.emit('tenant.created', { tenantId: 'ten_a', name: 'Beispiel A', slug: 'beispiel-a' });
  bus.emit('tenant.suspended', { tenantId: 'ten_a' });

  const rows = read();
  assert.deepEqual(
    rows.map((row) => row.name),
    ['tenant.created', 'tenant.suspended'],
  );
  assert.ok(
    rows[0]?.created_at && rows[1]?.created_at && rows[0].created_at < rows[1].created_at,
    `expected strictly increasing timestamps, got ${rows.map((row) => row.created_at).join(' and ')}`,
  );
  close();
});

test('a clock that jumps backwards does not reorder events', () => {
  const late = new Date('2026-11-25T12:00:00.002Z');
  const early = new Date('2026-11-25T12:00:00.000Z');
  const { bus, read, close } = createBus([late, late, early, early]);

  bus.emit('tenant.created', { tenantId: 'ten_a', name: 'Beispiel A', slug: 'beispiel-a' });
  bus.emit('tenant.created', { tenantId: 'ten_b', name: 'Beispiel B', slug: 'beispiel-b' });
  bus.emit('tenant.suspended', { tenantId: 'ten_a' });
  bus.emit('tenant.suspended', { tenantId: 'ten_b' });

  const rows = read();
  assert.deepEqual(
    rows.map((row) => row.name),
    ['tenant.created', 'tenant.created', 'tenant.suspended', 'tenant.suspended'],
  );
  const stamps = rows.map((row) => row.created_at);
  assert.deepEqual([...stamps].sort(), stamps, 'timestamps stay in emission order');
  assert.equal(new Set(stamps).size, stamps.length, 'no two events share a timestamp');
  close();
});
