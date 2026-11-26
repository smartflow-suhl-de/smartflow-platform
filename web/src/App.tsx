import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from './components/AppShell';
import { api, setUnauthorizedHandler } from './lib/api';
import { applyLocale, getMessages, storedLocale, type Locale } from './lib/i18n';
import { buildNavigation, resolveAliasRedirect } from './lib/navigation';
import { navigate, useRoute } from './lib/router';
import type { AuthMe, HealthResponse, NavEntry, TenantStats } from './lib/types';
import { HelpPage } from './pages/Help';
import { LoginPage } from './pages/Login';
import { NotFoundPage } from './pages/NotFound';
import { OverviewPage } from './pages/Overview';
import { SettingsPage } from './pages/Settings';
import { TenantsPage } from './pages/Tenants';
import { applyMode, storedMode, type Mode } from './theme';

type SessionState =
  { kind: 'loading' } | { kind: 'signed_out' } | { kind: 'signed_in'; auth: AuthMe };

export function App() {
  const { pathname, search } = useRoute();
  const [session, setSession] = useState<SessionState>({ kind: 'loading' });
  const [mode, setMode] = useState<Mode>(() => storedMode());
  const [locale, setLocale] = useState<Locale>(() => storedLocale());
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState(false);
  const [apiNav, setApiNav] = useState<NavEntry[]>([]);
  const [stats, setStats] = useState<TenantStats | null>(null);
  const [statsVersion, setStatsVersion] = useState(0);

  const messages = useMemo(() => getMessages(locale), [locale]);

  const handleModeChange = useCallback((next: Mode) => {
    setMode(next);
    applyMode(next);
  }, []);

  const handleLocaleChange = useCallback((next: Locale) => {
    setLocale(next);
    applyLocale(next);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setSession({ kind: 'signed_out' });
      setStats(null);
      setApiNav([]);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    api
      .me(controller.signal)
      .then((auth) => {
        setSession({ kind: 'signed_in', auth });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setSession({ kind: 'signed_out' });
      });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (session.kind !== 'signed_in') return;
    const controller = new AbortController();

    api
      .health(controller.signal)
      .then((result) => {
        setHealth(result);
        setHealthError(false);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setHealthError(true);
      });

    api
      .nav(controller.signal)
      .then((result) => {
        setApiNav(result.items);
      })
      .catch(() => undefined);

    return () => controller.abort();
  }, [session.kind]);

  const role = session.kind === 'signed_in' ? session.auth.user.role : null;

  useEffect(() => {
    if (role !== 'operator') {
      setStats(null);
      return;
    }
    const controller = new AbortController();

    api
      .tenantStats(controller.signal)
      .then((result) => setStats(result))
      .catch(() => undefined);

    return () => controller.abort();
  }, [role, statsVersion]);

  const navItems = useMemo(() => {
    if (!role) return [];
    return buildNavigation(role, apiNav, messages, stats?.suspended ?? 0);
  }, [role, apiNav, messages, stats?.suspended]);

  useEffect(() => {
    if (session.kind !== 'signed_in') return;
    if (pathname === '/login' || pathname === '/login/confirm') {
      navigate('/', { replace: true });
      return;
    }
    const target = resolveAliasRedirect(pathname, navItems);
    if (target) {
      navigate(target, { replace: true });
    }
  }, [session.kind, pathname, navItems]);

  const refreshStats = useCallback(() => {
    setStatsVersion((v) => v + 1);
  }, []);

  const handleSignedIn = useCallback((auth: AuthMe) => {
    setSession({ kind: 'signed_in', auth });
  }, []);

  const handleLogout = useCallback(() => {
    void api.logout().finally(() => {
      setSession({ kind: 'signed_out' });
      setStats(null);
      setApiNav([]);
      navigate('/', { replace: true });
    });
  }, []);

  if (session.kind === 'loading') {
    return (
      <div className="sf-center-load" role="status">
        <span className="label">{messages.common.loadingPlatform}</span>
      </div>
    );
  }

  if (session.kind === 'signed_out') {
    return (
      <LoginPage
        pathname={pathname}
        search={search}
        mode={mode}
        locale={locale}
        messages={messages}
        onModeChange={handleModeChange}
        onLocaleChange={handleLocaleChange}
        onSignedIn={handleSignedIn}
      />
    );
  }

  const { auth } = session;
  let content;
  if (pathname === '/') {
    content = (
      <OverviewPage
        user={auth.user}
        tenant={auth.tenant}
        health={health}
        healthError={healthError}
        stats={stats}
        locale={locale}
        messages={messages}
      />
    );
  } else if (pathname === '/tenants' && auth.user.role === 'operator') {
    content = (
      <TenantsPage
        search={search}
        stats={stats}
        locale={locale}
        messages={messages}
        onStatsChange={refreshStats}
      />
    );
  } else if (pathname === '/settings') {
    content = (
      <SettingsPage
        user={auth.user}
        tenant={auth.tenant}
        health={health}
        mode={mode}
        locale={locale}
        messages={messages}
        onModeChange={handleModeChange}
        onLocaleChange={handleLocaleChange}
      />
    );
  } else if (pathname === '/help') {
    content = <HelpPage messages={messages} />;
  } else {
    content = <NotFoundPage messages={messages} />;
  }

  return (
    <AppShell
      user={auth.user}
      pathname={pathname}
      navItems={navItems}
      health={health}
      healthError={healthError}
      stats={stats}
      mode={mode}
      messages={messages}
      onModeChange={handleModeChange}
      onLogout={handleLogout}
    >
      {content}
    </AppShell>
  );
}
