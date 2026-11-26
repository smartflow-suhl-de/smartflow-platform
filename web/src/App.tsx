import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from './components/AppShell';
import { Button } from './components/ui';
import { PublicLayout, PublicUnavailable } from './components/PublicLayout';
import { ToastProvider } from './components/Toast';
import { api, isAbortError, setOutageHandler, setUnauthorizedHandler } from './lib/api';
import { sessionProbeOutcome } from './lib/auth-flow';
import { applyLocale, formatApiError, getMessages, storedLocale, type Locale } from './lib/i18n';
import { buildNavigation, pageTitle, resolveAliasRedirect } from './lib/navigation';
import { isPublicNamespace, matchPublicRoute } from './lib/public-routes';
import { navigate, normalizePath, useRoute } from './lib/router';
import type { AuthMe, HealthResponse, NavEntry, TenantStats } from './lib/types';
import { HelpPage } from './pages/Help';
import { LoginPage } from './pages/Login';
import { NotFoundPage } from './pages/NotFound';
import { OverviewPage } from './pages/Overview';
import { SettingsPage } from './pages/Settings';
import { TenantsPage } from './pages/Tenants';
import { applyMode, storedMode, type Mode } from './theme';

const PLATFORM_TITLE = 'SmartFlow Plattform';

type SessionState =
  | { kind: 'loading' }
  | { kind: 'signed_out' }
  | { kind: 'unavailable' }
  | { kind: 'signed_in'; auth: AuthMe };

/**
 * Public paths render before any session work: no probe, no health call, no
 * 401 handler. The signed-in app below only mounts for every other path.
 */
export function App() {
  const { pathname, search } = useRoute();
  const path = normalizePath(pathname);
  const match = matchPublicRoute(path);
  if (!match && !isPublicNamespace(path)) return <SessionApp pathname={pathname} search={search} />;

  const locale = storedLocale();
  return (
    <PublicLayout
      locale={locale}
      focusKey={path}
      unavailable={!match?.route}
      title={match?.route?.title?.(match.params)}
    >
      {match?.route ? match.route.render(match.params) : <PublicUnavailable locale={locale} />}
    </PublicLayout>
  );
}

function SessionApp({ pathname: rawPathname, search }: { pathname: string; search: string }) {
  // Route matching never sees a trailing or doubled slash, so `/tenants/`
  // resolves to the tenants view instead of the NotFound page.
  const pathname = normalizePath(rawPathname);
  const [session, setSession] = useState<SessionState>({ kind: 'loading' });
  const [probeVersion, setProbeVersion] = useState(0);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(() => storedMode());
  const [locale, setLocale] = useState<Locale>(() => storedLocale());
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState(false);
  const [healthProbe, setHealthProbe] = useState(0);
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
      // A 401 on a data route means the cookie is gone: drop the session and
      // tell the login page why its form is back, instead of failing silently.
      setSession({ kind: 'signed_out' });
      setSessionExpired(true);
      setStats(null);
      setApiNav([]);
    });
    // A failing data route latches the outage indicator so a later 2xx on a
    // different route cannot claim the platform is fine again.
    setOutageHandler(() => setHealthError(true));
    return () => {
      setUnauthorizedHandler(null);
      setOutageHandler(null);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    api
      .me(controller.signal)
      .then((auth) => {
        setSession({ kind: 'signed_in', auth });
      })
      .catch((error: unknown) => {
        const outcome = sessionProbeOutcome(error);
        if (outcome === 'aborted') return;
        setSession({ kind: outcome === 'signed_out' ? 'signed_out' : 'unavailable' });
      });

    return () => controller.abort();
  }, [probeVersion]);

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
        if (isAbortError(error)) return;
        setHealthError(true);
      });

    api
      .nav(controller.signal)
      .then((result) => {
        setApiNav(result.items);
      })
      .catch(() => undefined);

    return () => controller.abort();
  }, [session.kind, healthProbe]);

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
    const label = session.kind === 'signed_in' ? pageTitle(pathname, navItems) : null;
    document.title = label ? `${label} · ${PLATFORM_TITLE}` : PLATFORM_TITLE;
  }, [pathname, navItems, session.kind]);

  useEffect(() => {
    if (session.kind !== 'signed_in') return;
    if (pathname === '/login') {
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
    setSessionExpired(false);
    setLogoutError(null);
  }, []);

  const retrySession = useCallback(() => {
    setSession({ kind: 'loading' });
    setProbeVersion((v) => v + 1);
  }, []);

  // Re-runs the health probe. Only a successful probe clears a latched
  // `healthError`; a recovered data route no longer does it on its own.
  const retryHealth = useCallback(() => setHealthProbe((v) => v + 1), []);

  const handleLogout = useCallback(() => {
    setLoggingOut(true);
    setLogoutError(null);
    api
      .logout()
      .then(() => {
        setSession({ kind: 'signed_out' });
        setSessionExpired(false);
        setStats(null);
        setApiNav([]);
        navigate('/', { replace: true });
      })
      .catch((error: unknown) => {
        // The server session may still be alive, so stay signed in: pretending
        // to be logged out would silently sign the next reload back in.
        if (isAbortError(error)) return;
        setLogoutError(formatApiError(error, locale));
      })
      .finally(() => setLoggingOut(false));
  }, [locale]);

  if (session.kind === 'loading') {
    return (
      <div className="sf-center-load" role="status">
        <span className="label">{messages.common.loadingPlatform}</span>
      </div>
    );
  }

  if (session.kind === 'unavailable') {
    return (
      <div className="sf-center-load">
        <div className="sf-unavailable">
          {/* The alert carries only the text: the retry button must not be
              re-announced every time the probe fails again. */}
          <p className="sf-unavailable-text" role="alert">
            {messages.shell.systemUnavailable}
          </p>
          <Button variant="secondary" size="sm" onClick={retrySession}>
            {messages.common.retry}
          </Button>
        </div>
      </div>
    );
  }

  if (session.kind === 'signed_out') {
    return (
      <LoginPage
        mode={mode}
        locale={locale}
        messages={messages}
        notice={sessionExpired ? messages.login.sessionExpiredNotice : null}
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
    <ToastProvider>
      <AppShell
        user={auth.user}
        pathname={pathname}
        navItems={navItems}
        health={health}
        healthError={healthError}
        stats={stats}
        mode={mode}
        messages={messages}
        loggingOut={loggingOut}
        logoutError={logoutError}
        onModeChange={handleModeChange}
        onRetryHealth={retryHealth}
        onLogout={handleLogout}
      >
        {content}
      </AppShell>
    </ToastProvider>
  );
}
