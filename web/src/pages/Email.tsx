import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmModal,
  EmptyState,
  Field,
  Input,
  KpiTile,
  PageHeader,
} from '../components/ui';
import { useToast } from '../components/useToast';
import { api, isAbortError } from '../lib/api';
import { formatApiError, formatDateTime, type Locale, type Messages } from '../lib/i18n';
import type {
  EmailDeliveryStatus,
  EmailInboxDetail,
  EmailInboxItem,
  EmailInboxStatus,
  EmailOutboxDetail,
  EmailOutboxItem,
  EmailSettings,
} from '../lib/types';

const PAGE_SIZE = 25;

type Tab = 'inbox' | 'outbox' | 'settings';

export interface EmailPageProps {
  locale: Locale;
  messages: Messages;
}

export function EmailPage({ locale, messages }: EmailPageProps) {
  const t = messages.email;
  const showToast = useToast();
  const [tab, setTab] = useState<Tab>('inbox');
  const [settings, setSettings] = useState<EmailSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const loadSettings = useCallback(
    (signal?: AbortSignal) => {
      api
        .emailSettings(signal)
        .then((next) => {
          setSettings(next);
          setSettingsError(null);
        })
        .catch((error: unknown) => {
          if (isAbortError(error)) return;
          setSettingsError(formatApiError(error, locale));
        });
    },
    [locale],
  );

  useEffect(() => {
    const controller = new AbortController();
    loadSettings(controller.signal);
    return () => controller.abort();
  }, [loadSettings]);

  const test = async () => {
    setTesting(true);
    try {
      await api.testEmail();
      showToast(t.testSent);
    } catch (error) {
      showToast(formatApiError(error, locale));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="sf-stack">
      <PageHeader
        title={t.title}
        description={t.description}
        actions={
          <>
            {settings ? (
              <Badge tone={settings.status === 'configured' ? 'good' : 'warn'}>
                {settings.status === 'configured' ? t.configured : t.unconfigured}
              </Badge>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              onClick={test}
              disabled={testing || settings?.status !== 'configured'}
            >
              {t.testMail}
            </Button>
          </>
        }
      />

      {settingsError ? (
        <div className="sf-alert sf-alert-bad" role="alert">
          {settingsError}
        </div>
      ) : null}

      <div className="sf-tabs" role="group" aria-label={t.title}>
        {(
          [
            ['inbox', t.tabs.inbox],
            ['outbox', t.tabs.outbox],
            ['settings', t.tabs.settings],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={tab === key ? 'sf-tab sf-tab-active' : 'sf-tab'}
            aria-pressed={tab === key}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'inbox' ? (
        <InboxPanel
          locale={locale}
          messages={messages}
          onOpenSettings={() => setTab('settings')}
        />
      ) : null}
      {tab === 'outbox' ? <OutboxPanel locale={locale} messages={messages} /> : null}
      {tab === 'settings' ? (
        <SettingsPanel
          locale={locale}
          messages={messages}
          settings={settings}
          onSaved={(next) => setSettings(next)}
        />
      ) : null}
    </div>
  );
}

function InboxPanel({
  locale,
  messages,
  onOpenSettings,
}: {
  locale: Locale;
  messages: Messages;
  onOpenSettings: () => void;
}) {
  const t = messages.email;
  const showToast = useToast();
  const [status, setStatus] = useState<EmailInboxStatus | null>(null);
  const [items, setItems] = useState<EmailInboxItem[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [selected, setSelected] = useState<EmailInboxDetail | null>(null);
  const [showHtml, setShowHtml] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cursor = cursorStack[cursorStack.length - 1] ?? null;

  const load = useCallback(
    (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      Promise.all([
        api.emailInbox(
          { unread: unreadOnly, q: appliedQuery, cursor, limit: PAGE_SIZE },
          signal,
        ),
        api.emailInboxStatus(signal),
      ])
        .then(([list, state]) => {
          setItems(list.items);
          setTotal(list.total);
          setNextCursor(list.nextCursor);
          setStatus(state);
        })
        .catch((reason: unknown) => {
          if (isAbortError(reason)) return;
          setError(formatApiError(reason, locale));
        })
        .finally(() => setLoading(false));
    },
    [appliedQuery, cursor, locale, unreadOnly],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const openMessage = async (id: string) => {
    setShowHtml(false);
    try {
      const detail = await api.emailInboxItem(id);
      setSelected(detail);
      if (detail.unread) {
        await api.markEmail(id, true);
        setItems((list) =>
          list.map((item) => (item.id === id ? { ...item, unread: false } : item)),
        );
        setStatus((state) => (state ? { ...state, unread: Math.max(0, state.unread - 1) } : state));
      }
    } catch (reason) {
      showToast(formatApiError(reason, locale));
    }
  };

  const toggleRead = async () => {
    if (!selected) return;
    try {
      await api.markEmail(selected.id, selected.unread);
      const read = selected.unread;
      setSelected({ ...selected, unread: !read });
      setItems((list) =>
        list.map((item) => (item.id === selected.id ? { ...item, unread: !read } : item)),
      );
      load();
    } catch (reason) {
      showToast(formatApiError(reason, locale));
    }
  };

  const sync = async () => {
    setBusy(true);
    try {
      const result = await api.syncInbox();
      showToast(t.synced(result.added));
      setCursorStack([]);
      load();
    } catch (reason) {
      showToast(formatApiError(reason, locale));
    } finally {
      setBusy(false);
    }
  };

  const connected = status?.connected === true;

  return (
    <div className="sf-stack">
      {!connected ? (
        <EmptyState
          title={t.emptyInboxTitle}
          description={t.emptyInboxDescription}
          action={
            <Button variant="primary" size="sm" onClick={onOpenSettings}>
              {t.emptyInboxAction}
            </Button>
          }
        />
      ) : null}

      {status && status.last_error_code ? (
        <div className="sf-alert sf-alert-warn" role="status">
          {t.errorSync} <code>{status.last_error_code}</code>
        </div>
      ) : null}

      <Card>
        <CardHeader
          title={t.inboxTitle}
          meta={t.inboxMeta(total, status?.unread ?? 0)}
          actions={
            <Button variant="primary" size="sm" onClick={sync} disabled={busy || !connected}>
              {busy ? t.syncing : t.sync}
            </Button>
          }
        />
        <div className="sf-card-body sf-stack">
          <form
            className="sf-toolbar"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              setCursorStack([]);
              setAppliedQuery(query.trim());
            }}
          >
            <div className="sf-search-wrap">
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t.searchPlaceholder}
                aria-label={t.searchPlaceholder}
              />
            </div>
            <label className="sf-check">
              <input
                type="checkbox"
                checked={unreadOnly}
                onChange={(event) => {
                  setUnreadOnly(event.target.checked);
                  setCursorStack([]);
                }}
              />
              {t.unreadOnly}
            </label>
            <Button type="submit" size="sm" variant="secondary">
              {messages.common.confirm}
            </Button>
          </form>

          {error ? (
            <div className="sf-alert sf-alert-bad" role="alert">
              {error}
            </div>
          ) : null}

          <div className="sf-email-grid">
            <div className="sf-email-list" aria-busy={loading}>
              {items.length === 0 && !loading ? (
                <EmptyState title={t.emptyListTitle} description={t.emptyListDescription} />
              ) : (
                items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={
                      selected?.id === item.id ? 'sf-email-row sf-email-row-active' : 'sf-email-row'
                    }
                    onClick={() => void openMessage(item.id)}
                  >
                    <div className="sf-email-row-top">
                      <span className="sf-email-from">
                        {item.unread ? <span className="sf-email-dot" aria-hidden="true" /> : null}
                        {item.from_name || item.from_address}
                      </span>
                      <span className="sf-email-date">{formatDateTime(item.received_at, locale)}</span>
                    </div>
                    <div className="sf-email-subject">{item.subject}</div>
                    <div className="sf-email-snippet">
                      {item.attachment_count > 0 ? `${t.attachments(item.attachment_count)} · ` : ''}
                      {item.snippet}
                    </div>
                  </button>
                ))
              )}
            </div>

            <div className="sf-email-detail">
              {selected ? (
                <>
                  <div className="sf-email-detail-head">
                    <div>
                      <h3 className="sf-card-title">{selected.subject}</h3>
                      <div className="sf-card-meta">
                        {selected.from_name
                          ? `${selected.from_name} · ${selected.from_address}`
                          : selected.from_address}{' '}
                        · {formatDateTime(selected.received_at, locale)}
                      </div>
                    </div>
                    <Button size="sm" variant="ghost" onClick={toggleRead}>
                      {selected.unread ? t.markRead : t.markUnread}
                    </Button>
                  </div>
                  {selected.attachment_count > 0 ? (
                    <p className="sf-card-meta">{t.attachments(selected.attachment_count)}</p>
                  ) : null}
                  {selected.html_body ? (
                    <div className="sf-email-body-actions">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setShowHtml((value) => !value)}
                      >
                        {showHtml ? t.showText : t.showHtml}
                      </Button>
                    </div>
                  ) : null}
                  {showHtml && selected.html_body ? (
                    <>
                      <p className="sf-card-meta">{t.htmlBlocked}</p>
                      <iframe
                        className="sf-email-html"
                        title={selected.subject}
                        sandbox=""
                        srcDoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"><body>${selected.html_body}</body>`}
                      />
                    </>
                  ) : (
                    <pre className="sf-email-text">{selected.text_body ?? selected.snippet}</pre>
                  )}
                </>
              ) : (
                <p className="sf-card-meta">{t.emptyListDescription}</p>
              )}
            </div>
          </div>

          <div className="sf-pagination">
            <span className="label">
              {cursorStack.length + 1} / {Math.max(1, Math.ceil(total / PAGE_SIZE))}
            </span>
            <div className="sf-pagination-buttons">
              <Button
                size="sm"
                variant="secondary"
                disabled={cursorStack.length === 0}
                onClick={() => setCursorStack((stack) => stack.slice(0, -1))}
              >
                {messages.tenants.prevPage}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={nextCursor === null}
                onClick={() => nextCursor && setCursorStack((stack) => [...stack, nextCursor])}
              >
                {messages.tenants.nextPage}
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

const STATUS_TONE: Record<EmailDeliveryStatus, 'good' | 'warn' | 'bad' | 'neutral'> = {
  queued: 'neutral',
  sending: 'warn',
  sent: 'good',
  failed: 'bad',
};

function OutboxPanel({ locale, messages }: { locale: Locale; messages: Messages }) {
  const t = messages.email;
  const showToast = useToast();
  const [items, setItems] = useState<EmailOutboxItem[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<EmailOutboxDetail | null>(null);

  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});

  const load = useCallback(
    (signal?: AbortSignal) => {
      setLoading(true);
      api
        .emailOutbox({ status: filter || undefined, limit: PAGE_SIZE }, signal)
        .then((list) => {
          setItems(list.items);
          setTotal(list.total);
          setError(null);
        })
        .catch((reason: unknown) => {
          if (isAbortError(reason)) return;
          setError(formatApiError(reason, locale));
        })
        .finally(() => setLoading(false));
    },
    [filter, locale],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    setSending(true);
    setFields({});
    try {
      await api.sendEmail({ to: to.trim(), subject: subject.trim(), text: body });
      setTo('');
      setSubject('');
      setBody('');
      showToast(t.queued);
      load();
    } catch (reason) {
      if (reason instanceof Error && 'fields' in reason) {
        setFields((reason as { fields: Record<string, string> }).fields ?? {});
      }
      showToast(formatApiError(reason, locale));
    } finally {
      setSending(false);
    }
  };

  const retry = async (id: string) => {
    try {
      await api.retryEmail(id);
      showToast(t.retried);
      load();
    } catch (reason) {
      showToast(formatApiError(reason, locale));
    }
  };

  return (
    <div className="sf-stack">
      <Card>
        <CardHeader title={t.composeTitle} meta={t.composeMeta} />
        <div className="sf-card-body">
          <form className="sf-form-grid" onSubmit={send}>
            <Field label={t.to} error={fields.to} htmlFor="email-to">
              <Input
                id="email-to"
                type="email"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                invalid={Boolean(fields.to)}
                required
              />
            </Field>
            <Field label={t.subject} error={fields.subject} htmlFor="email-subject">
              <Input
                id="email-subject"
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                invalid={Boolean(fields.subject)}
                maxLength={200}
                required
              />
            </Field>
            <Field label={t.body} error={fields.text} htmlFor="email-body">
              <textarea
                id="email-body"
                className="sf-input sf-textarea"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                rows={5}
                required
              />
            </Field>
            <div className="sf-form-actions">
              <Button type="submit" variant="primary" disabled={sending}>
                {t.send}
              </Button>
            </div>
          </form>
        </div>
      </Card>

      <Card>
        <CardHeader
          title={t.outboxTitle}
          meta={t.outboxMeta(total)}
          actions={
            <div className="sf-tabs" role="group" aria-label={t.outboxTitle}>
              {[
                ['', t.filterAll],
                ['queued', t.statusLabels.queued],
                ['sent', t.statusLabels.sent],
                ['failed', t.statusLabels.failed],
              ].map(([value, label]) => (
                <button
                  key={value || 'all'}
                  type="button"
                  className={filter === value ? 'sf-tab sf-tab-active' : 'sf-tab'}
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          }
        />
        <div className="sf-card-body sf-stack">
          {error ? (
            <div className="sf-alert sf-alert-bad" role="alert">
              {error}
            </div>
          ) : null}
          {items.length === 0 && !loading ? (
            <EmptyState title={t.emptyOutboxTitle} description={t.emptyOutboxDescription} />
          ) : (
            <div className="sf-table-wrap">
              <table className="sf-table">
                <thead>
                  <tr>
                    <th scope="col" className="label">
                      {t.colTo}
                    </th>
                    <th scope="col" className="label">
                      {t.colSubject}
                    </th>
                    <th scope="col" className="label">
                      {t.colStatus}
                    </th>
                    <th scope="col" className="label">
                      {t.colDate}
                    </th>
                    <th scope="col" className="label sf-table-actions">
                      {t.colAction}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id}>
                      <td>{item.to_address ?? '—'}</td>
                      <td>
                        <button
                          type="button"
                          className="sf-link-button"
                          onClick={() => void api.emailOutboxItem(item.id).then(setDetail).catch(() => undefined)}
                        >
                          {item.subject ?? '—'}
                        </button>
                      </td>
                      <td>
                        <Badge tone={STATUS_TONE[item.status]}>{t.statusLabels[item.status]}</Badge>
                        {item.permanent_failure ? (
                          <div className="sf-card-meta">{t.permanentFailure}</div>
                        ) : null}
                      </td>
                      <td>{formatDateTime(item.created_at, locale)}</td>
                      <td className="sf-table-actions">
                        {item.status === 'failed' && !item.permanent_failure ? (
                          <Button size="sm" variant="secondary" onClick={() => void retry(item.id)}>
                            {t.retry}
                          </Button>
                        ) : (
                          <span className="label">{t.attempts(item.attempts)}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {detail ? (
            <div className="sf-email-detail sf-email-detail-inline">
              <div className="sf-email-detail-head">
                <div>
                  <h3 className="sf-card-title">{detail.subject ?? '—'}</h3>
                  <div className="sf-card-meta">
                    {detail.to_address ?? '—'} · {formatDateTime(detail.created_at, locale)}
                    {detail.last_error_code ? ` · ${detail.last_error_code}` : ''}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setDetail(null)}>
                  {messages.common.close}
                </Button>
              </div>
              <pre className="sf-email-text">{detail.text_body ?? '—'}</pre>
            </div>
          ) : null}
        </div>
      </Card>
    </div>
  );
}

function SettingsPanel({
  locale,
  messages,
  settings,
  onSaved,
}: {
  locale: Locale;
  messages: Messages;
  settings: EmailSettings | null;
  onSaved: (settings: EmailSettings) => void;
}) {
  const t = messages.email;
  const showToast = useToast();
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('587');
  const [tls, setTls] = useState<'starttls' | 'tls'>('starttls');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [mailboxHost, setMailboxHost] = useState('');
  const [mailboxPort, setMailboxPort] = useState('993');
  const [mailboxTls, setMailboxTls] = useState<'starttls' | 'tls'>('tls');
  const [mailboxUser, setMailboxUser] = useState('');
  const [mailboxPassword, setMailboxPassword] = useState('');
  const [mailboxAddress, setMailboxAddress] = useState('');
  const [days, setDays] = useState('90');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [pendingShorten, setPendingShorten] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setName(settings.sender.name);
    setAddress(settings.sender.address);
    setReplyTo(settings.sender.reply_to ?? '');
    setHost(settings.transport.host);
    setPort(String(settings.transport.port));
    setTls(settings.transport.tls_mode);
    setUsername(settings.transport.username);
    setMailboxHost(settings.mailbox.host);
    setMailboxPort(String(settings.mailbox.port));
    setMailboxTls(settings.mailbox.tls_mode);
    setMailboxUser(settings.mailbox.username);
    setMailboxAddress(settings.mailbox.address);
    setDays(String(settings.retention.days));
  }, [settings]);

  const save = async (confirmShortening: boolean) => {
    setBusy(true);
    setFields({});
    try {
      const saved = await api.saveEmailSettings({
        sender: { name, address, reply_to: replyTo.trim() || null },
        transport: {
          host,
          port: Number.parseInt(port, 10),
          tls_mode: tls,
          username,
          ...(password ? { password } : {}),
        },
        mailbox: {
          host: mailboxHost,
          port: Number.parseInt(mailboxPort, 10),
          tls_mode: mailboxTls,
          username: mailboxUser,
          address: mailboxAddress,
          ...(mailboxPassword ? { password: mailboxPassword } : {}),
        },
        retention: { days: Number.parseInt(days, 10) },
        confirm_shortening: confirmShortening,
      });
      setPassword('');
      setMailboxPassword('');
      setPendingShorten(false);
      onSaved(saved);
      showToast(
        saved.retention_effect.shortened
          ? `${t.saved} ${t.retentionRunDone(saved.retention_effect.deleted)}`
          : t.saved,
      );
    } catch (reason) {
      if (reason instanceof Error && 'fields' in reason) {
        setFields((reason as { fields: Record<string, string> }).fields ?? {});
      }
      showToast(formatApiError(reason, locale));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const current = settings?.retention.days ?? 90;
    const next = Number.parseInt(days, 10);
    if (Number.isInteger(next) && next < current) {
      setPendingShorten(true);
      return;
    }
    void save(false);
  };

  const cleanUp = async () => {
    setBusy(true);
    try {
      const result = await api.runEmailRetention();
      showToast(t.retentionRunDone(result.deleted));
    } catch (reason) {
      showToast(formatApiError(reason, locale));
    } finally {
      setBusy(false);
    }
  };

  if (!settings) {
    return <p className="sf-card-meta">{messages.common.loadingPlatform}</p>;
  }

  return (
    <form className="sf-stack" onSubmit={submit}>
      <div className="sf-kpi-grid">
        <KpiTile
          label={t.retentionDays}
          value={settings.retention.days}
          hint={t.retentionHint(settings.retention.min_days, settings.retention.max_days)}
        />
        <KpiTile
          label={t.tabs.inbox}
          value={settings.mailbox.configured ? t.configured : t.unconfigured}
          tone={settings.mailbox.configured ? 'good' : 'warn'}
        />
        <KpiTile
          label={t.tabs.outbox}
          value={settings.status === 'configured' ? t.configured : t.unconfigured}
          tone={settings.status === 'configured' ? 'good' : 'warn'}
        />
      </div>

      <Card>
        <CardHeader
          title={t.senderTitle}
          meta={
            settings.updated_at
              ? t.updatedAt(formatDateTime(settings.updated_at, locale))
              : undefined
          }
        />
        <div className="sf-card-body sf-form-grid">
          <Field label={t.senderName} error={fields['sender.name']} htmlFor="email-name">
            <Input
              id="email-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              invalid={Boolean(fields['sender.name'])}
              maxLength={80}
            />
          </Field>
          <Field label={t.senderAddress} error={fields['sender.address']} htmlFor="email-address">
            <Input
              id="email-address"
              type="email"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              invalid={Boolean(fields['sender.address'])}
            />
          </Field>
          <Field
            label={`${t.replyTo} (${t.optional})`}
            error={fields['sender.reply_to']}
            htmlFor="email-reply"
          >
            <Input
              id="email-reply"
              type="email"
              value={replyTo}
              onChange={(event) => setReplyTo(event.target.value)}
              invalid={Boolean(fields['sender.reply_to'])}
            />
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader title={t.transportTitle} />
        <div className="sf-card-body sf-form-grid">
          <Field label={t.host} error={fields['transport.host']} htmlFor="smtp-host">
            <Input
              id="smtp-host"
              value={host}
              onChange={(event) => setHost(event.target.value)}
              invalid={Boolean(fields['transport.host'])}
            />
          </Field>
          <Field label={t.port} error={fields['transport.port']} htmlFor="smtp-port">
            <Input
              id="smtp-port"
              inputMode="numeric"
              value={port}
              onChange={(event) => setPort(event.target.value)}
              invalid={Boolean(fields['transport.port'])}
            />
          </Field>
          <Field label={t.tls} error={fields['transport.tls_mode']} htmlFor="smtp-tls">
            <select
              id="smtp-tls"
              className="sf-input"
              value={tls}
              onChange={(event) => setTls(event.target.value === 'tls' ? 'tls' : 'starttls')}
            >
              <option value="starttls">STARTTLS</option>
              <option value="tls">TLS</option>
            </select>
          </Field>
          <Field label={t.username} error={fields['transport.username']} htmlFor="smtp-user">
            <Input
              id="smtp-user"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              invalid={Boolean(fields['transport.username'])}
            />
          </Field>
          <Field
            label={t.password}
            hint={settings.transport.password_set ? t.passwordSet : t.passwordKeep}
            error={fields['transport.password']}
            htmlFor="smtp-password"
          >
            <Input
              id="smtp-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              invalid={Boolean(fields['transport.password'])}
              placeholder={settings.transport.password_set ? '••••••••' : ''}
            />
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader title={t.mailboxTitle} meta={t.mailboxHint} />
        <div className="sf-card-body sf-form-grid">
          <Field label={t.mailboxAddress} error={fields['mailbox.address']} htmlFor="imap-address">
            <Input
              id="imap-address"
              type="email"
              value={mailboxAddress}
              onChange={(event) => setMailboxAddress(event.target.value)}
              invalid={Boolean(fields['mailbox.address'])}
            />
          </Field>
          <Field label={t.host} error={fields['mailbox.host']} htmlFor="imap-host">
            <Input
              id="imap-host"
              value={mailboxHost}
              onChange={(event) => setMailboxHost(event.target.value)}
              invalid={Boolean(fields['mailbox.host'])}
            />
          </Field>
          <Field label={t.port} error={fields['mailbox.port']} htmlFor="imap-port">
            <Input
              id="imap-port"
              inputMode="numeric"
              value={mailboxPort}
              onChange={(event) => setMailboxPort(event.target.value)}
              invalid={Boolean(fields['mailbox.port'])}
            />
          </Field>
          <Field label={t.tls} error={fields['mailbox.tls_mode']} htmlFor="imap-tls">
            <select
              id="imap-tls"
              className="sf-input"
              value={mailboxTls}
              onChange={(event) => setMailboxTls(event.target.value === 'tls' ? 'tls' : 'starttls')}
            >
              <option value="tls">TLS</option>
              <option value="starttls">STARTTLS</option>
            </select>
          </Field>
          <Field label={t.username} error={fields['mailbox.username']} htmlFor="imap-user">
            <Input
              id="imap-user"
              value={mailboxUser}
              onChange={(event) => setMailboxUser(event.target.value)}
              invalid={Boolean(fields['mailbox.username'])}
            />
          </Field>
          <Field
            label={t.password}
            hint={settings.mailbox.password_set ? t.passwordSet : t.passwordKeep}
            error={fields['mailbox.password']}
            htmlFor="imap-password"
          >
            <Input
              id="imap-password"
              type="password"
              autoComplete="new-password"
              value={mailboxPassword}
              onChange={(event) => setMailboxPassword(event.target.value)}
              invalid={Boolean(fields['mailbox.password'])}
              placeholder={settings.mailbox.password_set ? '••••••••' : ''}
            />
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader
          title={t.retentionTitle}
          meta={t.retentionHint(settings.retention.min_days, settings.retention.max_days)}
          actions={
            <Button size="sm" variant="secondary" onClick={cleanUp} disabled={busy}>
              {t.runRetention}
            </Button>
          }
        />
        <div className="sf-card-body sf-form-grid">
          <Field label={t.retentionDays} error={fields['retention.days']} htmlFor="retention-days">
            <Input
              id="retention-days"
              inputMode="numeric"
              value={days}
              onChange={(event) => setDays(event.target.value)}
              invalid={Boolean(fields['retention.days'])}
            />
          </Field>
          {settings.retention.pending_rows > 0 ? (
            <p className="sf-card-meta">{t.retentionPending(settings.retention.pending_rows)}</p>
          ) : null}
        </div>
      </Card>

      <div className="sf-form-actions">
        <Button type="submit" variant="primary" disabled={busy}>
          {t.save}
        </Button>
      </div>

      <ConfirmModal
        open={pendingShorten}
        title={t.retentionShortenTitle}
        description={t.retentionShortenBody(
          settings.retention.days,
          Number.parseInt(days, 10) || settings.retention.days,
        )}
        confirmLabel={t.save}
        cancelLabel={messages.common.cancel}
        closeLabel={messages.common.close}
        danger
        busy={busy}
        onConfirm={() => void save(true)}
        onCancel={() => setPendingShorten(false)}
      />
    </form>
  );
}