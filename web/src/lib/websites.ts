import type { WebsiteApproval, WebsiteBuildStatus, WebsiteStatus } from './types';

/**
 * Presentation rules for the website views, kept out of the components so they
 * can be tested without a render pass.
 */

export function siteStatusTone(status: WebsiteStatus): 'good' | 'warn' | 'bad' {
  if (status === 'live') return 'good';
  if (status === 'failed') return 'bad';
  return 'warn';
}

export function approvalStateTone(
  state: WebsiteApproval['state'],
): 'good' | 'warn' | 'bad' | 'neutral' {
  if (state === 'approved') return 'good';
  if (state === 'open') return 'warn';
  if (state === 'changes') return 'bad';
  return 'neutral';
}

export function formatBuildDuration(ms: number, locale: 'de' | 'en' = 'de'): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) {
    const seconds = (ms / 1000).toFixed(1).replace('.', locale === 'de' ? ',' : '.');
    return `${seconds} s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}:${String(seconds).padStart(2, '0')} min`;
}

/**
 * A build may go live only when it succeeded and the client approved exactly
 * that build. The server enforces the same rule; this is what the button shows.
 */
export function buildApproved(build: { id: string } | null, approvals: WebsiteApproval[]): boolean {
  if (!build) return false;
  return approvals.some((entry) => entry.build_id === build.id && entry.state === 'approved');
}

export function canPublish(
  role: string,
  build: { id: string; status: WebsiteBuildStatus } | null,
  approvals: WebsiteApproval[],
  options: { requireApproval?: boolean; released?: boolean } = {},
): boolean {
  if (role !== 'tenant_admin') return false;
  if (!build || build.status !== 'ok') return false;
  // A build that already has a release would hit the unique index on re-publish.
  if (options.released === true) return false;
  if (options.requireApproval === false) return true;
  return buildApproved(build, approvals);
}
