import { useEffect, useState } from 'react';
import { BrandLogo } from '../components/BrandLogo';
import { Badge, Button, Card, CardHeader, Field } from '../components/ui';
import { ApiError, api, isAbortError } from '../lib/api';
import { formatApiError, formatDateTime, type Locale, type Messages } from '../lib/i18n';
import { approvalStateTone } from '../lib/websites';
import type { PublicApproval } from '../lib/types';

export interface PublicApprovalPageProps {
  tenantId: string;
  token: string;
  locale: Locale;
  messages: Messages;
}

type Failure = 'expired' | 'missing' | 'generic';

/**
 * One page, no session: the token in the URL is the whole credential. Nothing
 * here links back into the platform, and no other website is reachable.
 */
export function PublicApprovalPage({ tenantId, token, locale, messages }: PublicApprovalPageProps) {
  const [approval, setApproval] = useState<PublicApproval | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'approve' | 'changes' | null>(null);
  const [decided, setDecided] = useState<'approved' | 'changes' | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .publicApproval(tenantId, token, controller.signal)
      .then((result) => {
        setApproval(result);
        setDecided(result.state === 'approved' || result.state === 'changes' ? result.state : null);
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
        if (err instanceof ApiError && err.status === 410) setFailure('expired');
        else if (err instanceof ApiError && err.status === 404) setFailure('missing');
        else {
          setFailure('generic');
          setError(formatApiError(err, locale));
        }
      });
    return () => controller.abort();
  }, [tenantId, token, locale]);

  async function decide(decision: 'approve' | 'changes'): Promise<void> {
    setFieldError(null);
    setError(null);
    if (decision === 'changes' && comment.trim().length === 0) {
      setFieldError(messages.approval.commentRequired);
      return;
    }
    setBusy(decision);
    try {
      const result = await api.decidePublicApproval(
        tenantId,
        token,
        decision,
        comment.trim().length > 0 ? comment.trim() : undefined,
      );
      setDecided(result.state === 'approved' ? 'approved' : 'changes');
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) setFailure('expired');
      else setError(formatApiError(err, locale));
    } finally {
      setBusy(null);
    }
  }

  if (failure !== null) {
    return (
      <div className="sf-login-shell">
        <main className="sf-login-center">
          <div className="sf-login-box">
            <BrandLogo size="sm" />
            <Card>
              <div className="sf-card-body">
                <h1 className="sf-login-title">
                  {failure === 'expired'
                    ? messages.approval.expiredTitle
                    : failure === 'missing'
                      ? messages.approval.missingTitle
                      : messages.approval.errorTitle}
                </h1>
                <p className="sf-login-subtitle">
                  {failure === 'expired'
                    ? messages.approval.expiredBody
                    : failure === 'missing'
                      ? messages.approval.missingBody
                      : (error ?? messages.common.unknownError)}
                </p>
              </div>
            </Card>
          </div>
        </main>
      </div>
    );
  }

  if (approval === null) {
    return (
      <div className="sf-center-load" role="status">
        <span className="label">{messages.common.loadingPlatform}</span>
      </div>
    );
  }

  return (
    <div className="sf-login-shell">
      <div className="sf-login-bar">
        <span className="label">{messages.approval.kicker}</span>
      </div>
      <main className="sf-login-center">
        <div className="sf-login-box" style={{ maxWidth: '640px' }}>
          <BrandLogo size="sm" />
          <h1 className="sf-login-title" style={{ fontSize: '30px' }}>
            {messages.approval.title(approval.site.name)}
          </h1>
          <p className="sf-login-subtitle">{messages.approval.intro}</p>

          <div className="sf-stack" style={{ marginTop: 'var(--spacing-xl)' }}>
            <Card>
              <CardHeader
                title={messages.approval.changesTitle}
                meta={
                  approval.build ? formatDateTime(approval.build.created_at, locale) : undefined
                }
                actions={
                  <Badge
                    tone={
                      decided === 'approved' || decided === 'changes'
                        ? approvalStateTone(decided)
                        : approvalStateTone('open')
                    }
                  >
                    {decided === 'approved'
                      ? messages.approval.stateApproved
                      : decided === 'changes'
                        ? messages.approval.stateChanges
                        : messages.approval.stateOpen}
                  </Badge>
                }
              />
              <div className="sf-card-body">
                {approval.pages.length === 0 ? (
                  <p className="sf-card-text">{messages.approval.noPages}</p>
                ) : (
                  <dl className="sf-kv-list">
                    {approval.pages.map((page) => (
                      <div className="sf-kv-row" key={page.route}>
                        <dt className="numeric">{page.route}</dt>
                        <dd>{page.title}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            </Card>

            {decided === null ? (
              <Card>
                <CardHeader title={messages.approval.decideTitle} />
                <div className="sf-card-body">
                  {error ? (
                    <div className="sf-alert sf-alert-bad" role="alert">
                      <span>{error}</span>
                    </div>
                  ) : null}
                  <Field
                    label={messages.approval.commentLabel}
                    hint={messages.approval.commentHint}
                    error={fieldError ?? undefined}
                    htmlFor="sf-approval-comment"
                  >
                    <textarea
                      id="sf-approval-comment"
                      className="sf-input"
                      rows={4}
                      value={comment}
                      onChange={(event) => setComment(event.target.value)}
                      placeholder={messages.approval.commentPlaceholder}
                      aria-invalid={fieldError ? true : undefined}
                      maxLength={2_000}
                      disabled={busy !== null}
                    />
                  </Field>
                  <p className="sf-card-meta">{comment.length} / 2000</p>
                  <div className="sf-page-actions" style={{ marginTop: 'var(--spacing-lg)' }}>
                    <Button
                      variant="primary"
                      disabled={busy !== null}
                      onClick={() => void decide('approve')}
                    >
                      {busy === 'approve' ? messages.approval.approving : messages.approval.approve}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={busy !== null}
                      onClick={() => void decide('changes')}
                    >
                      {busy === 'changes'
                        ? messages.approval.requesting
                        : messages.approval.requestChanges}
                    </Button>
                  </div>
                </div>
              </Card>
            ) : (
              <Card>
                <div className="sf-card-body">
                  <p className="sf-card-text" role="status">
                    {decided === 'approved'
                      ? messages.approval.approvedBody
                      : messages.approval.changesBody}
                  </p>
                </div>
              </Card>
            )}

            <p className="sf-card-text">{messages.approval.privacy}</p>
            {approval.build ? (
              <p className="sf-login-footer">
                {messages.approval.expiresAt(formatDateTime(approval.expires_at, locale))}
              </p>
            ) : null}
          </div>
        </div>
      </main>
    </div>
  );
}
