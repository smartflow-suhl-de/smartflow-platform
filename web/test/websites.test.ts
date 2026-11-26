import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildApproved,
  canPublish,
  formatBuildDuration,
  approvalStateTone,
  siteStatusTone,
} from '../src/lib/websites.ts';
import type { WebsiteApproval } from '../src/lib/types.ts';

function approval(overrides: Partial<WebsiteApproval> = {}): WebsiteApproval {
  return {
    id: 'apr_1',
    site_id: 'site_1',
    build_id: 'bld_1',
    recipient: null,
    state: 'open',
    comment: null,
    expires_at: '2026-12-10T00:00:00.000Z',
    decided_at: null,
    created_at: '2026-11-26T00:00:00.000Z',
    ...overrides,
  };
}

describe('website presentation rules', () => {
  it('maps statuses to badge tones', () => {
    assert.equal(siteStatusTone('live'), 'good');
    assert.equal(siteStatusTone('draft'), 'warn');
    assert.equal(siteStatusTone('failed'), 'bad');
    assert.equal(approvalStateTone('approved'), 'good');
    assert.equal(approvalStateTone('open'), 'warn');
    assert.equal(approvalStateTone('changes'), 'bad');
    assert.equal(approvalStateTone('expired'), 'neutral');
  });

  it('formats the build duration in seconds and minutes', () => {
    assert.equal(formatBuildDuration(8_400), '8,4 s');
    assert.equal(formatBuildDuration(8_400, 'en'), '8.4 s');
    assert.equal(formatBuildDuration(64_000), '1:04 min');
    assert.equal(formatBuildDuration(-1), '—');
  });

  it('only accepts an approval for the very build that should go live', () => {
    const build = { id: 'bld_1', status: 'ok' as const };
    assert.equal(buildApproved(build, []), false);
    assert.equal(buildApproved(build, [approval()]), false, 'an open approval is not enough');
    assert.equal(buildApproved(build, [approval({ state: 'changes' })]), false);
    assert.equal(buildApproved(build, [approval({ state: 'approved' })]), true);
    assert.equal(
      buildApproved(build, [approval({ state: 'approved', build_id: 'bld_0' })]),
      false,
      'an approval of an older build does not count',
    );
  });

  it('lets only a tenant admin publish an approved build', () => {
    const build = { id: 'bld_1', status: 'ok' as const };
    const approved = [approval({ state: 'approved' })];
    assert.equal(canPublish('tenant_admin', build, approved), true);
    assert.equal(canPublish('employee', build, approved), false);
    assert.equal(canPublish('operator', build, approved), false);
    assert.equal(canPublish('tenant_admin', { id: 'bld_1', status: 'failed' }, approved), false);
    assert.equal(canPublish('tenant_admin', null, approved), false);
    assert.equal(canPublish('tenant_admin', build, []), false);
  });
});
