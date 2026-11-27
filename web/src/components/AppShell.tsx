import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Messages } from '../lib/i18n';
import { groupNavigation, utilityNavigation, type ResolvedNavItem } from '../lib/navigation';
import { AppLink, navigate } from '../lib/router';
import type { HealthResponse, SessionTenant, SessionUser, TenantStats } from '../lib/types';
import type { Mode } from '../theme';
import { BrandLogo } from './BrandLogo';
import { CommandPalette } from './CommandPalette';
import { TenantSwitcher } from './TenantSwitcher';
import {
  BuildingIcon,
  CloseIcon,
  LogOutIcon,
  MenuIcon,
  MoonIcon,
  PlusIcon,
  SearchIcon,
  SunIcon,
  navIconByName,
} from './icons';
import { Button } from './ui';
import { ToastRegion } from './Toast';

function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(min-width: 768px)').matches
      : true,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(min-width: 768px)');
    const sync = () => setDesktop(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  return desktop;
}

export interface AppShellProps {
  user: SessionUser;
  pathname: string;
  navItems: ResolvedNavItem[];
  health: HealthResponse | null;
  healthError: boolean;
  stats: TenantStats | null;
  mode: Mode;
  messages: Messages;
  loggingOut: boolean;
  logoutError: string | null;
  activeTenant?: SessionTenant | null;
  onOpenTenantSwitcher?: () => void;
  onClearTenantContext?: () => void;
  onModeChange: (mode: Mode) => void;
  onRetryHealth: () => void;
  onLogout: () => void;
  children: ReactNode;
}

export function AppShell({
  user,
  pathname,
  navItems,
  health,
  healthError,
  stats,
  mode,
  messages,
  loggingOut,
  logoutError,
  activeTenant = null,
  onOpenTenantSwitcher,
  onClearTenantContext,
  onModeChange,
  onRetryHealth,
  onLogout,
  children,
}: AppShellProps) {
  const desktop = useIsDesktop();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const asideRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  const drawerVisible = drawerOpen && !desktop;
  const navHidden = !desktop && !drawerVisible;
  const isOperator = user.role === 'operator';
  const groups = useMemo(() => groupNavigation(navItems), [navItems]);
  const utilityItems = useMemo(() => utilityNavigation(navItems), [navItems]);

  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    // A route change replaces the page content, which drops keyboard focus to
    // `<body>`: the next Tab would start at the sidebar again. Move it to the
    // content instead, but only when nothing else claimed focus — a sidebar
    // click keeps its own focus, and `?create=1` focuses the form field.
    if (document.activeElement === document.body) {
      mainRef.current?.focus();
    }
  }, [pathname]);

  useEffect(() => {
    if (desktop) setDrawerOpen(false);
  }, [desktop]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!drawerVisible) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeBtnRef.current?.focus();

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        setDrawerOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = asideRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled])',
      );
      const visible = focusable
        ? [...focusable].filter((el) => el.getClientRects().length > 0)
        : [];
      const first = visible[0];
      const last = visible[visible.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
      menuBtnRef.current?.focus();
    };
  }, [drawerVisible]);

  const systemHealth = healthError
    ? {
        dot: 'sf-dot-bad',
        textClass: 'sf-status-bad',
        word: messages.shell.opsOffline,
        label: messages.shell.systemUnavailable,
      }
    : health?.status === 'ok'
      ? {
          dot: 'sf-dot-good',
          textClass: 'sf-status-good',
          word: messages.shell.opsRunning,
          label: messages.shell.systemOk,
        }
      : {
          dot: 'sf-dot-warn',
          textClass: 'sf-status-warn',
          word: messages.shell.opsDegraded,
          label: messages.shell.systemDegraded,
        };

  return (
    <div className="sf-shell">
      {/* First stop for keyboard users and the first thing a screen reader
          reads: it jumps over the sidebar straight to the page content. */}
      <a href="#sf-main" className="sf-skip-link">
        {messages.shell.skipToContent}
      </a>

      <aside
        id="sf-main-sidebar"
        ref={asideRef}
        aria-label={messages.shell.navAria}
        inert={navHidden}
        className={drawerVisible ? 'sf-sidebar sf-sidebar-open' : 'sf-sidebar'}
      >
        <div className="sf-sidebar-head">
          <AppLink to="/" className="sf-brand">
            <BrandLogo size="sm" />
          </AppLink>
          <Button
            ref={closeBtnRef}
            variant="ghost"
            size="icon"
            className="sf-mobile-only"
            aria-label={messages.shell.closeMenu}
            onClick={() => setDrawerOpen(false)}
          >
            <CloseIcon size={16} />
          </Button>
        </div>

        {isOperator ? (
          <div className="sf-ops-box">
            <div className="sf-ops-row">
              <span className="label">{messages.shell.opsBlockTitle}</span>
              <span className={`sf-ops-status ${systemHealth.textClass}`}>{systemHealth.word}</span>
            </div>
            <div className="sf-ops-meta">
              <span className={`sf-dot ${systemHealth.dot}`} aria-hidden="true" />
              <span className="numeric">
                {stats
                  ? messages.shell.opsTenantsLine(stats.active, stats.total)
                  : systemHealth.label}
              </span>
            </div>
          </div>
        ) : null}

        {isOperator && onOpenTenantSwitcher && onClearTenantContext ? (
          <TenantSwitcher
            activeTenant={activeTenant}
            messages={messages}
            onOpenModal={onOpenTenantSwitcher}
            onClearContext={onClearTenantContext}
          />
        ) : null}

        <nav aria-label={messages.shell.mainNavAria} className="sf-nav scroll-thin">
          {groups.map((group) => (
            <div key={group.group} className="sf-nav-group">
              <div className="label sf-nav-group-label">{messages.navGroups[group.group]}</div>
              <div className="sf-nav-list">
                {group.items.map((item) => {
                  const active =
                    item.path === '/'
                      ? pathname === '/'
                      : pathname === item.path || pathname.startsWith(`${item.path}/`);
                  return (
                    <AppLink
                      key={item.id}
                      to={item.path}
                      aria-current={active ? 'page' : undefined}
                      className={active ? 'sf-nav-item sf-nav-item-active' : 'sf-nav-item'}
                    >
                      {navIconByName(item.icon, 15)}
                      <span className="sf-nav-label">{item.label}</span>
                      {item.badge ? (
                        <span
                          className={[
                            'sf-nav-count',
                            `sf-nav-count-${item.badge.tone}`,
                            active ? 'sf-nav-count-active' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                        >
                          {item.badge.value}
                        </span>
                      ) : null}
                    </AppLink>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="sf-sidebar-foot">
          <div className="sf-foot-meta">
            <span className="sf-foot-user" title={user.email}>
              {user.name}
            </span>
            {health?.version ? <span className="sf-foot-version">v{health.version}</span> : null}
          </div>
          <div className="sf-foot-actions">
            {utilityItems.map((item) => {
              const active = pathname === item.path || pathname.startsWith(`${item.path}/`);
              return (
                <AppLink
                  key={item.id}
                  to={item.path}
                  aria-label={item.label}
                  title={item.label}
                  aria-current={active ? 'page' : undefined}
                  className={
                    active ? 'sf-foot-icon-btn sf-foot-icon-btn-active' : 'sf-foot-icon-btn'
                  }
                >
                  {navIconByName(item.icon, 15)}
                </AppLink>
              );
            })}
            <button
              type="button"
              onClick={onLogout}
              disabled={loggingOut}
              aria-label={messages.shell.logout}
              title={messages.shell.logout}
              className="sf-foot-icon-btn sf-foot-logout"
            >
              <LogOutIcon size={15} />
            </button>
          </div>
          {logoutError ? (
            <div className="sf-foot-error" role="alert">
              {logoutError}
            </div>
          ) : null}
        </div>
      </aside>

      {drawerVisible ? (
        <div
          className="sf-drawer-backdrop"
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
      ) : null}

      <div className="sf-main">
        <header className="sf-topbar">
          <div className="sf-topbar-inner">
            <Button
              ref={menuBtnRef}
              variant="ghost"
              size="icon"
              className="sf-mobile-only"
              aria-label={messages.shell.openMenu}
              aria-expanded={drawerVisible}
              aria-controls="sf-main-sidebar"
              onClick={() => setDrawerOpen(true)}
            >
              <MenuIcon size={17} />
            </Button>

            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label={messages.shell.searchAria}
              className="sf-search-trigger"
            >
              <SearchIcon size={14} />
              <span className="sf-search-placeholder">{messages.shell.searchPlaceholder}</span>
              <span className="sf-kbd">⌘K</span>
            </button>

            {isOperator && onOpenTenantSwitcher ? (
              <div className="sf-topbar-tenant">
                <button
                  type="button"
                  className={
                    activeTenant
                      ? 'sf-topbar-tenant-btn sf-topbar-tenant-active'
                      : 'sf-topbar-tenant-btn'
                  }
                  onClick={onOpenTenantSwitcher}
                  title={
                    activeTenant
                      ? `${messages.tenantSwitcher.contextLabel}: ${activeTenant.name} (${activeTenant.slug})`
                      : messages.tenantSwitcher.noTenant
                  }
                  aria-label={
                    activeTenant
                      ? `${messages.tenantSwitcher.contextLabel}: ${activeTenant.name}`
                      : messages.tenantSwitcher.chooseTenant
                  }
                >
                  <BuildingIcon size={14} />
                  <span className="sf-topbar-tenant-name">
                    {activeTenant ? activeTenant.name : messages.tenantSwitcher.noTenant}
                  </span>
                </button>
              </div>
            ) : null}

            <div className="sf-topbar-right">
              <div className="sf-topbar-health">
                <span className={`sf-dot ${systemHealth.dot}`} aria-hidden="true" />
                <span className="label">{systemHealth.label}</span>
                {/* The indicator otherwise only resets once another request
                    answers; this lets the operator ask again without a reload. */}
                {healthError ? (
                  <Button variant="ghost" size="sm" onClick={onRetryHealth}>
                    {messages.common.retry}
                  </Button>
                ) : null}
              </div>
              <Button
                variant="secondary"
                size="icon"
                aria-label={mode === 'dark' ? messages.common.lightMode : messages.common.darkMode}
                aria-pressed={mode === 'dark'}
                title={mode === 'dark' ? messages.common.lightMode : messages.common.darkMode}
                onClick={() => onModeChange(mode === 'dark' ? 'light' : 'dark')}
              >
                {mode === 'dark' ? <SunIcon size={15} /> : <MoonIcon size={15} />}
              </Button>
              {isOperator && pathname !== '/tenants' ? (
                <Button variant="primary" size="sm" onClick={() => navigate('/tenants?create=1')}>
                  <PlusIcon size={14} />
                  <span>{messages.shell.quickCreate}</span>
                </Button>
              ) : null}
            </div>
          </div>
        </header>

        <main id="sf-main" ref={mainRef} tabIndex={-1} className="sf-content">
          {children}
        </main>

        <CommandPalette
          open={paletteOpen}
          items={navItems}
          messages={messages}
          onClose={() => setPaletteOpen(false)}
        />
      </div>

      <ToastRegion dismissLabel={messages.common.dismiss} />
    </div>
  );
}
