import { ApiError } from './api';
import type { Role, TenantStatus } from './types';

export type Locale = 'de' | 'en';

const LOCALE_KEY = 'sf.locale';

export function storedLocale(): Locale {
  try {
    const value = localStorage.getItem(LOCALE_KEY);
    if (value === 'de' || value === 'en') return value;
  } catch {
    /* private mode */
  }
  return 'de';
}

export function applyLocale(locale: Locale): void {
  document.documentElement.lang = locale;
  try {
    localStorage.setItem(LOCALE_KEY, locale);
  } catch {
    /* private mode */
  }
}

export function formatDateTime(iso: string, locale: Locale): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale === 'de' ? 'de-DE' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function formatDateShort(iso: string, locale: Locale): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale === 'de' ? 'de-DE' : 'en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}

export interface Messages {
  common: {
    loadingPlatform: string;
    lightMode: string;
    darkMode: string;
    languageLabel: string;
    cancel: string;
    close: string;
    dismiss: string;
    confirm: string;
    retry: string;
    unknownError: string;
    noTenant: string;
    platformUnavailable: string;
  };
  roles: Record<Role, string>;
  navGroups: {
    work: string;
    management: string;
  };
  navItems: {
    overview: string;
    overviewCreate: string;
    tenants: string;
    tenantsCreate: string;
    settings: string;
    help: string;
  };
  shell: {
    navAria: string;
    mainNavAria: string;
    skipToContent: string;
    openMenu: string;
    closeMenu: string;
    searchPlaceholder: string;
    searchAria: string;
    quickCreate: string;
    quickTenants: string;
    systemOk: string;
    systemDegraded: string;
    systemUnavailable: string;
    opsBlockTitle: string;
    opsRunning: string;
    opsDegraded: string;
    opsOffline: string;
    opsTenantsLine: (active: number, total: number) => string;
    logout: string;
    paletteTitleSearch: string;
    palettePlaceholderSearch: string;
    paletteEmpty: string;
  };
  login: {
    title: string;
    subtitle: string;
    setupTitle: string;
    setupSubtitle: string;
    setupLoading: string;
    setupCheckFailed: string;
    setupCompleteNotice: string;
    emailLabel: string;
    emailRequiredHint: string;
    emailPlaceholder: string;
    nameLabel: string;
    namePlaceholder: string;
    nameRequired: string;
    passwordLabel: string;
    passwordHint: string;
    passwordPlaceholder: string;
    passwordRepeatLabel: string;
    passwordBlank: string;
    passwordTooShort: (min: number) => string;
    passwordTooLong: (max: number) => string;
    passwordMismatch: string;
    submit: string;
    submitting: string;
    setupSubmit: string;
    setupSubmitting: string;
    sessionExpiredNotice: string;
    footerNote: string;
  };
  overview: {
    title: string;
    operatorDescription: string;
    tenantDescription: string;
    kpiTotal: string;
    kpiTotalHint: string;
    kpiActive: string;
    kpiActiveHint: string;
    kpiSuspended: string;
    kpiSuspendedHint: string;
    kpiApi: string;
    kpiApiHint: (version: string) => string;
    recentTenantsTitle: string;
    manageTenantsLink: string;
    emptyTenantsTitle: string;
    emptyTenantsDescription: string;
    emptyTenantsAction: string;
    tenantCardTitle: string;
    tenantLabel: string;
    roleLabel: string;
    accountLabel: string;
    modulesTitle: string;
    modulesEmptyTitle: string;
    modulesEmptyDescription: string;
  };
  tenants: {
    title: string;
    description: string;
    createTitle: string;
    nameLabel: string;
    namePlaceholder: string;
    slugLabel: string;
    slugHint: string;
    slugPlaceholder: string;
    createSubmit: string;
    creating: string;
    formInvalid: string;
    createdSuccess: (name: string) => string;
    suspendedSuccess: (name: string) => string;
    resumedSuccess: (name: string) => string;
    listTitle: string;
    listSummary: (shown: number, total: number) => string;
    searchLabel: string;
    searchPlaceholder: string;
    filterAll: string;
    filterActive: string;
    filterSuspended: string;
    colTenant: string;
    colId: string;
    colStatus: string;
    colCreated: string;
    colAction: string;
    statusLabels: Record<TenantStatus, string>;
    actionSuspend: string;
    actionResume: string;
    emptyTitle: string;
    emptyFilteredDescription: string;
    emptyInitialDescription: string;
    prevPage: string;
    nextPage: string;
    pageStatus: (from: number, to: number, total: number) => string;
    confirmSuspendTitle: (name: string) => string;
    confirmSuspendBody: string;
    confirmSuspendButton: string;
  };
  notFound: {
    title: string;
    description: string;
    back: string;
  };
  settingsPage: {
    title: string;
    description: string;
    accountTitle: string;
    nameLabel: string;
    emailLabel: string;
    roleLabel: string;
    tenantLabel: string;
    appearanceTitle: string;
    modeLabel: string;
    lightLabel: string;
    darkLabel: string;
    languageLabel: string;
    localHint: string;
    sessionTitle: string;
    sessionText: string;
    apiVersionLabel: string;
  };
  helpPage: {
    title: string;
    description: string;
    searchTitle: string;
    searchText: string;
    navTitle: string;
    navText: string;
    displayTitle: string;
    displayText: string;
    settingsLink: string;
    apiTitle: string;
    apiText: string;
    openApiLink: string;
  };
}

const DE: Messages = {
  common: {
    loadingPlatform: 'Plattform wird geladen',
    lightMode: 'Helles Design aktivieren',
    darkMode: 'Dunkles Design aktivieren',
    languageLabel: 'Sprache wechseln',
    cancel: 'Abbrechen',
    close: 'Schließen',
    dismiss: 'Meldung schließen',
    confirm: 'Bestätigen',
    retry: 'Erneut versuchen',
    unknownError: 'Die Anfrage konnte nicht verarbeitet werden.',
    noTenant: 'Plattformebene',
    platformUnavailable: 'Die Plattform antwortet nicht. Bitte später erneut versuchen.',
  },
  roles: {
    operator: 'Operator',
    tenant_admin: 'Mandanten-Admin',
    employee: 'Mitarbeitende',
  },
  navGroups: {
    work: 'Arbeit',
    management: 'Verwaltung',
  },
  navItems: {
    overview: 'Übersicht',
    overviewCreate: 'Zur Übersicht',
    tenants: 'Mandanten',
    tenantsCreate: 'Mandant anlegen',
    settings: 'Einstellungen',
    help: 'Hilfe',
  },
  shell: {
    navAria: 'Navigation',
    mainNavAria: 'Hauptnavigation',
    skipToContent: 'Zum Inhalt springen',
    openMenu: 'Navigation öffnen',
    closeMenu: 'Navigation schließen',
    searchPlaceholder: 'Suchen, springen, anlegen …',
    searchAria: 'Befehlspalette öffnen',
    quickCreate: 'Mandant anlegen',
    quickTenants: 'Mandanten',
    systemOk: 'System nominal',
    systemDegraded: 'Eingeschränkt',
    systemUnavailable: 'Keine Antwort',
    opsBlockTitle: 'Betrieb',
    opsRunning: 'läuft',
    opsDegraded: 'gestört',
    opsOffline: 'offline',
    opsTenantsLine: (active, total) =>
      `${active} / ${total} ${total === 1 ? 'Mandant' : 'Mandanten'} aktiv`,
    logout: 'Abmelden',
    paletteTitleSearch: 'Suchen und springen',
    palettePlaceholderSearch: 'Bereich oder Aktion suchen …',
    paletteEmpty: 'Kein passender Eintrag gefunden.',
  },
  login: {
    title: 'Anmelden',
    subtitle: 'Melden Sie sich mit Ihrer E-Mail-Adresse und Ihrem Passwort an.',
    setupTitle: 'Ersteinrichtung',
    setupSubtitle:
      'Diese Installation hat noch kein Konto mit Passwort. Legen Sie jetzt das erste Operator-Konto an.',
    setupLoading: 'Anmeldung wird vorbereitet …',
    setupCheckFailed:
      'Der Anmeldedienst antwortet nicht. Prüfen Sie die Verbindung und versuchen Sie es erneut.',
    setupCompleteNotice:
      'Die Ersteinrichtung ist bereits abgeschlossen. Bitte melden Sie sich mit Ihrem Passwort an.',
    emailLabel: 'E-Mail',
    emailRequiredHint: 'Pflichtfeld',
    emailPlaceholder: 'operator@example.com',
    nameLabel: 'Name',
    namePlaceholder: 'Vor- und Nachname',
    nameRequired: 'Bitte einen Namen eingeben.',
    passwordLabel: 'Passwort',
    passwordHint: 'Mindestens 12 Zeichen.',
    passwordPlaceholder: 'Passwort eingeben',
    passwordRepeatLabel: 'Passwort wiederholen',
    passwordBlank: 'Das Passwort darf nicht nur aus Leerzeichen bestehen.',
    passwordTooShort: (min) => `Das Passwort muss mindestens ${min} Zeichen lang sein.`,
    passwordTooLong: (max) => `Das Passwort darf höchstens ${max} Zeichen lang sein.`,
    passwordMismatch: 'Die Passwörter stimmen nicht überein.',
    submit: 'Anmelden',
    submitting: 'Anmeldung läuft …',
    setupSubmit: 'Konto anlegen und anmelden',
    setupSubmitting: 'Konto wird angelegt …',
    sessionExpiredNotice:
      'Die Sitzung ist abgelaufen. Bitte melden Sie sich erneut an — Ihre Eingaben wurden nicht gespeichert.',
    footerNote: 'SmartFlow · Suhl · Interne Plattform',
  },
  overview: {
    title: 'Übersicht',
    operatorDescription:
      'Betriebszustand und Mandantenbestand auf einen Blick. Alle Werte kommen direkt aus der API.',
    tenantDescription: 'Zugewiesener Mandant und aktuelle Sitzungsdaten.',
    kpiTotal: 'Mandanten',
    kpiTotalHint: 'Gesamt im Verzeichnis',
    kpiActive: 'Aktiv',
    kpiActiveHint: 'Datenbank freigegeben',
    kpiSuspended: 'Gesperrt',
    kpiSuspendedHint: 'Zugriff zentral blockiert',
    kpiApi: 'Kernel-API',
    kpiApiHint: (version) => `Version ${version}`,
    recentTenantsTitle: 'Mandanten im Verzeichnis',
    manageTenantsLink: 'Alle verwalten',
    emptyTenantsTitle: 'Noch keine Mandanten',
    emptyTenantsDescription:
      'Legen Sie den ersten Mandanten an. Dabei wird automatisch eine eigene SQLite-Datenbank provisioniert.',
    emptyTenantsAction: 'Mandant anlegen',
    tenantCardTitle: 'Sitzung & Mandant',
    tenantLabel: 'Mandant',
    roleLabel: 'Rolle',
    accountLabel: 'Konto',
    modulesTitle: 'Freigeschaltete Module',
    modulesEmptyTitle: 'Noch keine Fach-Plugins aktiv',
    modulesEmptyDescription:
      'Für Ihre Rolle sind aktuell keine zusätzlichen Navigationsmodule registriert.',
  },
  tenants: {
    title: 'Mandanten',
    description:
      'Jeder Mandant besitzt eine eigene SQLite-Datenbank. Das Sperren blockiert den Datenbankzugriff im Kernel sofort und reversibel.',
    createTitle: 'Neuen Mandanten anlegen',
    nameLabel: 'Firma',
    namePlaceholder: 'z. B. Nordwind Logistik GmbH',
    slugLabel: 'Slug',
    slugHint: 'optional, sonst aus dem Namen',
    slugPlaceholder: 'nordwind-logistik',
    createSubmit: 'Mandant anlegen',
    creating: 'Wird angelegt …',
    formInvalid: 'Bitte prüfen Sie die Eingaben im Formular.',
    createdSuccess: (name) => `${name} wurde angelegt und provisioniert.`,
    suspendedSuccess: (name) => `${name} wurde gesperrt.`,
    resumedSuccess: (name) => `${name} wurde reaktiviert.`,
    listTitle: 'Verzeichnis',
    listSummary: (shown, total) => `${shown} von ${total} Treffern`,
    searchLabel: 'Mandanten durchsuchen',
    searchPlaceholder: 'Name oder Slug suchen …',
    filterAll: 'Alle',
    filterActive: 'Aktiv',
    filterSuspended: 'Gesperrt',
    colTenant: 'Mandant',
    colId: 'ID',
    colStatus: 'Status',
    colCreated: 'Angelegt',
    colAction: 'Aktion',
    statusLabels: {
      active: 'Aktiv',
      suspended: 'Gesperrt',
    },
    actionSuspend: 'Sperren',
    actionResume: 'Reaktivieren',
    emptyTitle: 'Keine Mandanten gefunden',
    emptyFilteredDescription: 'Kein Mandant passt zur aktuellen Suche oder zum Statusfilter.',
    emptyInitialDescription:
      'Noch kein Mandant vorhanden. Nutzen Sie das Formular oben zum Anlegen.',
    prevPage: 'Zurück',
    nextPage: 'Weiter',
    pageStatus: (from, to, total) => `${from} bis ${to} von ${total}`,
    confirmSuspendTitle: (name) => `${name} sperren?`,
    confirmSuspendBody:
      'Der Zugriff auf die Mandantendatenbank wird im Kernel sofort mit 403 blockiert. Der Vorgang lässt sich jederzeit rückgängig machen.',
    confirmSuspendButton: 'Mandant sperren',
  },
  notFound: {
    title: 'Seite nicht gefunden',
    description:
      'Diese Adresse gehört zu keiner sichtbaren Ansicht oder Sie haben dafür keine Berechtigung.',
    back: 'Zur Übersicht',
  },
  settingsPage: {
    title: 'Einstellungen',
    description:
      'Konto, Darstellung und Spracheinstellungen für dieses Gerät. Alle Kontodaten stammen direkt aus der aktiven Sitzung.',
    accountTitle: 'Konto',
    nameLabel: 'Name',
    emailLabel: 'E-Mail',
    roleLabel: 'Rolle',
    tenantLabel: 'Mandant',
    appearanceTitle: 'Darstellung & Sprache',
    modeLabel: 'Designmodus',
    lightLabel: 'Hell',
    darkLabel: 'Dunkel',
    languageLabel: 'Sprache',
    localHint: 'Designmodus und Sprache werden lokal in diesem Browser gespeichert.',
    sessionTitle: 'Sitzung & Anmeldung',
    sessionText:
      'Die Anmeldung erfolgt mit E-Mail-Adresse und Passwort über ein HttpOnly-Cookie (sf_session). Abmelden beendet die Sitzung auf dem Server.',
    apiVersionLabel: 'API-Version',
  },
  helpPage: {
    title: 'Hilfe',
    description:
      'Kurze Übersicht zur Bedienung der Plattform. Alle Hinweise beschreiben ausschließlich vorhandene Funktionen.',
    searchTitle: 'Suchen und springen',
    searchText:
      'Mit Strg+K oder ⌘K öffnet sich die Befehlspalette in der Kopfleiste. Sie zeigt alle Bereiche, die für Ihre Rolle freigeschaltet sind.',
    navTitle: 'Navigation',
    navText:
      'Die linke Leiste gliedert nach Tätigkeit. Unter 768 px öffnet der Menü-Knopf die Navigation als Schublade; Escape schließt sie wieder.',
    displayTitle: 'Darstellung, Sprache und Abmelden',
    displayText:
      'Den Designmodus wechseln Sie in der Kopfleiste oder unter Einstellungen. Die Sprache (DE/EN) steht dort ebenfalls bereit; Abmelden in der Fußzeile beendet die Sitzung.',
    settingsLink: 'Einstellungen öffnen',
    apiTitle: 'Schnittstelle & Vertrag',
    apiText:
      'Alle Endpunkte der Plattform liegen unter /api/v1. Die laufende Spezifikation steht als OpenAPI-Dokument bereit.',
    openApiLink: 'OpenAPI-Spezifikation öffnen',
  },
};

const EN: Messages = {
  common: {
    loadingPlatform: 'Loading platform',
    lightMode: 'Switch to light mode',
    darkMode: 'Switch to dark mode',
    languageLabel: 'Switch language',
    cancel: 'Cancel',
    close: 'Close',
    dismiss: 'Dismiss message',
    confirm: 'Confirm',
    retry: 'Try again',
    unknownError: 'The request could not be completed.',
    noTenant: 'Platform scope',
    platformUnavailable: 'The platform is not responding. Please try again later.',
  },
  roles: {
    operator: 'Operator',
    tenant_admin: 'Tenant Admin',
    employee: 'Employee',
  },
  navGroups: {
    work: 'Work',
    management: 'Management',
  },
  navItems: {
    overview: 'Overview',
    overviewCreate: 'Go to overview',
    tenants: 'Tenants',
    tenantsCreate: 'Create tenant',
    settings: 'Settings',
    help: 'Help',
  },
  shell: {
    navAria: 'Navigation',
    mainNavAria: 'Main navigation',
    skipToContent: 'Skip to content',
    openMenu: 'Open navigation',
    closeMenu: 'Close navigation',
    searchPlaceholder: 'Search, jump, create …',
    searchAria: 'Open command palette',
    quickCreate: 'New tenant',
    quickTenants: 'Tenants',
    systemOk: 'System nominal',
    systemDegraded: 'Degraded',
    systemUnavailable: 'No response',
    opsBlockTitle: 'Operations',
    opsRunning: 'online',
    opsDegraded: 'degraded',
    opsOffline: 'offline',
    opsTenantsLine: (active, total) =>
      `${active} / ${total} ${total === 1 ? 'tenant' : 'tenants'} active`,
    logout: 'Sign out',
    paletteTitleSearch: 'Search and jump',
    palettePlaceholderSearch: 'Search views or actions …',
    paletteEmpty: 'No matching entries found.',
  },
  login: {
    title: 'Sign in',
    subtitle: 'Sign in with your email address and password.',
    setupTitle: 'First-time setup',
    setupSubtitle:
      'This installation has no account with a password yet. Create the first operator account now.',
    setupLoading: 'Preparing sign-in …',
    setupCheckFailed: 'The sign-in service is not responding. Check the connection and try again.',
    setupCompleteNotice: 'Setup is already complete. Please sign in with your password.',
    emailLabel: 'Email',
    emailRequiredHint: 'Required',
    emailPlaceholder: 'operator@example.com',
    nameLabel: 'Name',
    namePlaceholder: 'First and last name',
    nameRequired: 'Please enter a name.',
    passwordLabel: 'Password',
    passwordHint: 'At least 12 characters.',
    passwordPlaceholder: 'Enter your password',
    passwordRepeatLabel: 'Repeat password',
    passwordBlank: 'The password must not consist only of spaces.',
    passwordTooShort: (min) => `The password must be at least ${min} characters long.`,
    passwordTooLong: (max) => `The password must be at most ${max} characters long.`,
    passwordMismatch: 'The passwords do not match.',
    submit: 'Sign in',
    submitting: 'Signing in …',
    setupSubmit: 'Create account and sign in',
    setupSubmitting: 'Creating account …',
    sessionExpiredNotice:
      'Your session has expired. Please sign in again — your input was not saved.',
    footerNote: 'SmartFlow · Suhl · Internal Platform',
  },
  overview: {
    title: 'Overview',
    operatorDescription:
      'Operational health and tenant directory at a glance. Every metric comes directly from the API.',
    tenantDescription: 'Assigned tenant and current session details.',
    kpiTotal: 'Tenants',
    kpiTotalHint: 'Total in directory',
    kpiActive: 'Active',
    kpiActiveHint: 'Database accessible',
    kpiSuspended: 'Suspended',
    kpiSuspendedHint: 'Kernel access blocked',
    kpiApi: 'Kernel API',
    kpiApiHint: (version) => `Version ${version}`,
    recentTenantsTitle: 'Directory entries',
    manageTenantsLink: 'Manage all',
    emptyTenantsTitle: 'No tenants yet',
    emptyTenantsDescription: 'Create the first tenant to provision an isolated SQLite database.',
    emptyTenantsAction: 'Create tenant',
    tenantCardTitle: 'Session & Tenant',
    tenantLabel: 'Tenant',
    roleLabel: 'Role',
    accountLabel: 'Account',
    modulesTitle: 'Available modules',
    modulesEmptyTitle: 'No domain plugins active yet',
    modulesEmptyDescription: 'No additional navigation modules are registered for your role.',
  },
  tenants: {
    title: 'Tenants',
    description:
      'Each tenant runs on an isolated SQLite database. Suspending blocks database access at the kernel boundary and is reversible.',
    createTitle: 'Create tenant',
    nameLabel: 'Company name',
    namePlaceholder: 'e.g. Northwind Logistics Ltd.',
    slugLabel: 'Slug',
    slugHint: 'optional, derived from name',
    slugPlaceholder: 'northwind-logistics',
    createSubmit: 'Create tenant',
    creating: 'Creating …',
    formInvalid: 'Please check the form input.',
    createdSuccess: (name) => `${name} was created and provisioned.`,
    suspendedSuccess: (name) => `${name} has been suspended.`,
    resumedSuccess: (name) => `${name} has been resumed.`,
    listTitle: 'Directory',
    listSummary: (shown, total) => `${shown} of ${total} matching`,
    searchLabel: 'Search tenants',
    searchPlaceholder: 'Search by name or slug …',
    filterAll: 'All',
    filterActive: 'Active',
    filterSuspended: 'Suspended',
    colTenant: 'Tenant',
    colId: 'ID',
    colStatus: 'Status',
    colCreated: 'Created',
    colAction: 'Action',
    statusLabels: {
      active: 'Active',
      suspended: 'Suspended',
    },
    actionSuspend: 'Suspend',
    actionResume: 'Resume',
    emptyTitle: 'No tenants found',
    emptyFilteredDescription: 'No tenant matches the current search query or status filter.',
    emptyInitialDescription: 'No tenants exist yet. Use the form above to create one.',
    prevPage: 'Previous',
    nextPage: 'Next',
    pageStatus: (from, to, total) => `${from} to ${to} of ${total}`,
    confirmSuspendTitle: (name) => `Suspend ${name}?`,
    confirmSuspendBody:
      'Database access for this tenant will immediately return HTTP 403. You can resume the tenant at any time.',
    confirmSuspendButton: 'Suspend tenant',
  },
  notFound: {
    title: 'Page not found',
    description: 'This address does not match an available view or your role cannot access it.',
    back: 'Back to overview',
  },
  settingsPage: {
    title: 'Settings',
    description:
      'Account details, theme mode, and interface language for this device. All account details reflect the active server session.',
    accountTitle: 'Account',
    nameLabel: 'Name',
    emailLabel: 'Email',
    roleLabel: 'Role',
    tenantLabel: 'Tenant',
    appearanceTitle: 'Appearance & Language',
    modeLabel: 'Theme mode',
    lightLabel: 'Light',
    darkLabel: 'Dark',
    languageLabel: 'Language',
    localHint: 'Theme mode and interface language are stored locally in this browser.',
    sessionTitle: 'Session & Authentication',
    sessionText:
      'Authentication uses an email address and password with an HttpOnly session cookie (sf_session). Signing out invalidates the session on the server.',
    apiVersionLabel: 'API version',
  },
  helpPage: {
    title: 'Help',
    description:
      'Concise reference for navigating and operating the platform. Every item reflects implemented behavior.',
    searchTitle: 'Search and jump',
    searchText:
      'Press Ctrl+K or ⌘K to open the command palette in the top bar. It lists every section accessible to your role.',
    navTitle: 'Navigation',
    navText:
      'The sidebar groups views by task. Below 768 px, the menu button opens a keyboard-accessible drawer that closes with Escape.',
    displayTitle: 'Appearance, language, and sign-out',
    displayText:
      'Switch between light and dark mode in the top bar or under Settings, where you can also switch between DE and EN. Sign out in the sidebar footer ends the server session.',
    settingsLink: 'Open settings',
    apiTitle: 'API contract',
    apiText:
      'All platform routes are served under /api/v1. The live contract is published as an OpenAPI document.',
    openApiLink: 'Open OpenAPI specification',
  },
};

export function getMessages(locale: Locale): Messages {
  return locale === 'en' ? EN : DE;
}

/**
 * True for the codes the API client invents when a response carries no usable
 * error body: `http_<status>`. A 5xx (or the status-0 placeholder) means the
 * platform itself failed, not the request, so its raw `message` ("HTTP 502") is
 * operator noise rather than an explanation.
 */
function isPlatformOutageCode(code: string): boolean {
  return code === 'http_0' || /^http_5\d\d$/.test(code);
}

export function formatApiError(error: unknown, locale: Locale): string {
  const m = getMessages(locale);
  if (!(error instanceof ApiError)) {
    return error instanceof Error && error.message ? error.message : m.common.unknownError;
  }

  if (isPlatformOutageCode(error.code)) {
    return m.common.platformUnavailable;
  }

  if (locale === 'de') {
    switch (error.code) {
      case 'network_error':
        return 'Keine Verbindung zur Plattform-API.';
      case 'unauthorized':
        return 'Sitzung abgelaufen. Bitte erneut anmelden.';
      case 'forbidden':
        return 'Für diese Aktion fehlt die erforderliche Berechtigung.';
      case 'invalid_credentials':
        return 'E-Mail oder Passwort ist falsch.';
      case 'setup_complete':
        return 'Die Ersteinrichtung ist bereits abgeschlossen. Bitte melden Sie sich an.';
      case 'busy':
        return 'Der Anmeldedienst ist gerade ausgelastet. Bitte in einem Moment erneut versuchen.';
      case 'rate_limited':
        return 'Zu viele Anmeldeversuche. Bitte später erneut versuchen.';
      case 'slug_taken':
        return 'Dieser Slug ist bereits vergeben.';
      case 'tenant_not_found':
        return 'Der Mandant wurde nicht gefunden.';
      case 'validation_failed':
        return 'Bitte prüfen Sie die markierten Eingaben.';
      default:
        return error.message || m.common.unknownError;
    }
  }

  // The server speaks English, so an unmapped code can fall back to its own
  // message; the mapped ones exist because the raw text is operator-facing
  // noise ("Please check the highlighted fields.") or leaks HTTP wording.
  switch (error.code) {
    case 'network_error':
      return 'Cannot reach the platform API.';
    case 'unauthorized':
      return 'Your session has expired. Please sign in again.';
    case 'forbidden':
      return 'You do not have permission for this action.';
    case 'invalid_credentials':
      return 'Email or password is incorrect.';
    case 'setup_complete':
      return 'Setup is already complete. Please sign in.';
    case 'busy':
      return 'The sign-in service is busy. Please try again in a moment.';
    case 'rate_limited':
      return 'Too many sign-in attempts. Please try again later.';
    case 'slug_taken':
      return 'That slug is already taken.';
    case 'tenant_not_found':
      return 'This tenant was not found.';
    case 'validation_failed':
      return 'Please check the highlighted fields.';
    default:
      return error.message || m.common.unknownError;
  }
}

export function formatFieldError(
  field: 'email' | 'name' | 'slug' | 'password',
  rawMessage: string | undefined,
  locale: Locale,
): string | undefined {
  if (!rawMessage) return undefined;
  if (locale === 'en') return rawMessage;

  if (field === 'email') {
    return rawMessage.includes('already in use')
      ? 'Diese E-Mail-Adresse wird bereits verwendet.'
      : 'Bitte eine gültige E-Mail-Adresse eingeben.';
  }
  if (field === 'name') {
    return 'Bitte einen Namen mit 2 bis 80 Zeichen eingeben.';
  }
  if (field === 'password') {
    return rawMessage.includes('at least')
      ? 'Bitte mindestens 12 Zeichen eingeben.'
      : 'Bitte das Passwort eingeben.';
  }
  if (rawMessage.includes('already taken')) {
    return 'Dieser Slug ist bereits vergeben.';
  }
  if (rawMessage.includes('does not yield')) {
    return 'Aus dem Namen lässt sich kein gültiger Slug ableiten. Bitte manuell angeben.';
  }
  return 'Nur Kleinbuchstaben, Ziffern und Bindestriche (2 bis 48 Zeichen).';
}
