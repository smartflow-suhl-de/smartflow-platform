import { ApiError } from './api';
import type {
  Role,
  TenantStatus,
  WebsiteApprovalState,
  WebsiteBuildStatus,
  WebsitePageOrigin,
  WebsiteStatus,
} from './types';

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
    agent: string;
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
    appearanceSwitch: (current: string, next: string) => string;
    appearanceLight: string;
    appearanceDark: string;
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
  tenantSwitcher: {
    title: string;
    description: string;
    contextLabel: string;
    noTenant: string;
    chooseTenant: string;
    switchTenant: string;
    clearContext: string;
    clearContextAria: string;
    searchPlaceholder: string;
    searchAria: string;
    loadingTenants: string;
    emptyList: string;
    emptySearch: string;
    colName: string;
    colSlug: string;
    selectAction: string;
    activeBadge: string;
    switchedSuccess: (name: string) => string;
    clearedSuccess: string;
    prevPage: string;
    nextPage: string;
  };
  llm: {
    title: string;
    description: string;
    addProvider: string;
    providersTitle: string;
    providersMeta: (shown: number, total: number) => string;
    emptyTitle: string;
    emptyDescription: string;
    colProvider: string;
    colType: string;
    colModels: string;
    colAccess: string;
    colLastTest: string;
    colStatus: string;
    colCalls: string;
    colAction: string;
    retrySummary: (seconds: number, retries: number) => string;
    statusActive: string;
    statusDisabled: string;
    allPlugins: string;
    neverTested: string;
    kpiProviders: string;
    kpiProvidersHint: string;
    kpiModels: string;
    kpiModelsHint: string;
    kpiCalls: string;
    kpiCallsHint: string;
    kpiCost: string;
    kpiCostHint: string;
    purposesTitle: string;
    purposesMeta: string;
    purposeLabel: string;
    modelLabel: string;
    fallbackLabel: string;
    callsLabel: string;
    unmapped: string;
    save: string;
    saved: string;
    addPurpose: string;
    purposePlaceholder: string;
    usageTitle: string;
    usageMeta: (days: number) => string;
    usageCaller: string;
    usagePurpose: string;
    usageTokens: string;
    usageCost: string;
    usageWhen: string;
    usageEmpty: string;
    newTitle: string;
    newDescription: string;
    editTitle: string;
    nameLabel: string;
    namePlaceholder: string;
    presetLabel: string;
    presetCustom: string;
    baseUrlLabel: string;
    baseUrlHint: string;
    chatPathLabel: string;
    chatPathHint: string;
    apiVersionLabel: string;
    authStyleLabel: string;
    authBearer: string;
    authHeader: string;
    authNone: string;
    authHeaderLabel: string;
    apiKeyLabel: string;
    apiKeyHint: string;
    apiKeyKeep: string;
    extraHeadersLabel: string;
    extraHeadersHint: string;
    invalidJson: string;
    timeoutLabel: string;
    retriesLabel: string;
    rateLabel: string;
    dailyLabel: string;
    monthlyLabel: string;
    retentionLabel: string;
    allowedLabel: string;
    allowedHint: string;
    testButton: string;
    testing: string;
    testOk: (ms: number, models: number) => string;
    testFailed: string;
    testNoPrompt: string;
    saveProvider: string;
    saving: string;
    modelsTitle: string;
    modelsMeta: (count: number) => string;
    addModel: string;
    refreshModels: string;
    noModels: string;
    modelKeyLabel: string;
    modelLabelLabel: string;
    contextLabel: string;
    outputLabel: string;
    capabilitiesLabel: string;
    capTools: string;
    capJson: string;
    capVision: string;
    capEmbeddings: string;
    defaultLabel: string;
    makeDefault: string;
    deleteModel: string;
    deleteModelConfirm: string;
    discovered: string;
    manual: string;
    settingsTitle: string;
    statusLabel: string;
    saveSettings: string;
    deleteProvider: string;
    deleteProviderConfirm: string;
    backToList: string;
    notFoundTitle: string;
    notFoundDescription: string;
    factBaseUrl: string;
    factAuth: string;
    factTimeout: string;
    factAccess: string;
    factLastTest: string;
    keySet: (date: string) => string;
    keyNotSet: string;
    loaded: string;
    errorsLabel: string;
  };
  notFound: {
    title: string;
    description: string;
    back: string;
  };
  agent: {
    title: string;
    description: string;
    placeholder: string;
    textareaLabel: string;
    hint: string;
    send: string;
    thinking: string;
    examples: string;
    examplesHint: string;
    exampleTenantsTitle: string;
    exampleTenantsText: string;
    exampleEventsTitle: string;
    exampleEventsText: string;
    exampleSourcesTitle: string;
    exampleSourcesText: string;
    newQuestion: string;
    copy: string;
    copied: string;
    sources: string;
    steps: string;
    stepsSummary: (count: number, ms: number) => string;
    stepOk: string;
    stepError: string;
    ready: string;
    notConfigured: string;
    modelLabel: string;
    stand: (time: string) => string;
    retention: (days: number) => string;
    limit: (perMinute: number, perDay: number) => string;
    providerMissingTitle: string;
    providerMissingText: string;
    providerUnreachableTitle: string;
    providerUnreachableText: string;
    checkStatus: string;
    emptyAnswer: string;
    truncatedNotice: string;
    errorTitle: string;
    history: string;
    clearHistory: string;
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
    themeLabel: string;
    themeHint: string;
    themeCustomTitle: string;
    themeCustomHint: string;
    themeNameLabel: string;
    themeAccentLabel: string;
    themePaperLabel: string;
    themeApply: string;
    themeReset: string;
    themeJsonTitle: string;
    themeJsonHint: string;
    themeJsonLabel: string;
    themeJsonExport: string;
    themeJsonImport: string;
    themeJsonApplied: string;
    themeErrorJson: string;
    themeErrorShape: string;
    themeErrorVersion: string;
    themeErrorName: string;
    themeErrorColor: string;
    themeErrorPaperDark: string;
    themeErrorContrast: string;
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
  discovery: {
    title: string;
    description: string;
    createTitle: string;
    customerLabel: string;
    customerPlaceholder: string;
    emailLabel: string;
    emailPlaceholder: string;
    localeLabel: string;
    modeLabel: string;
    modeShort: string;
    modeStandard: string;
    modeFull: string;
    expiryLabel: string;
    expiryHint: string;
    tenantLabel: string;
    tenantNone: string;
    createSubmit: string;
    creating: string;
    linkTitle: string;
    linkNote: string;
    linkCopy: string;
    linkCopied: string;
    mailUnavailable: string;
    listTitle: string;
    listSummary: (shown: number, total: number) => string;
    searchLabel: string;
    searchPlaceholder: string;
    filterAll: string;
    colCustomer: string;
    colStatus: string;
    colProgress: string;
    colAiBudget: string;
    colAiStepBudget: string;
    aiBudgetSummary: (used: number, assessments: number) => string;
    aiStepBudget: (used: number, blocked: boolean) => string;
    colExpires: string;
    colActions: string;
    statusOpen: string;
    statusInProgress: string;
    statusCompleted: string;
    statusRevoked: string;
    statusExpired: string;
    actionOpen: string;
    actionRevoke: string;
    actionResend: string;
    back: string;
    detailTitle: string;
    answersTitle: string;
    noAnswers: string;
    reportTitle: string;
    reportSummary: string;
    reportClusters: string;
    reportOpportunities: string;
    reportQuickWins: string;
    reportOpenQuestions: string;
    reportNextStep: string;
    colBenefit: string;
    colEffort: string;
    colRisk: string;
    colData: string;
    reportUnavailable: string;
    revokeConfirmTitle: string;
    revokeConfirmBody: string;
    revokeButton: string;
    revokedToast: string;
    linkRotatedToast: string;
    emptyTitle: string;
    emptyDescription: string;
    prevPage: string;
    nextPage: string;
    pageStatus: (from: number, to: number, total: number) => string;
    kpiTotal: string;
    kpiOpen: string;
    kpiInProgress: string;
    kpiCompleted: string;
    overviewRecent: string;
    contactLabel: string;
    loadError: string;
    publicBrand: string;
    publicTitle: string;
    publicIntro: string;
    consentTitle: string;
    consentNote: string;
    start: string;
    next: string;
    finish: string;
    saving: string;
    saved: string;
    progressLabel: string;
    stepOf: (done: number, total: number) => string;
    hintTitle: string;
    examplesTitle: string;
    ideasTitle: string;
    ideasHint: string;
    contactTitle: string;
    contactQuestion: string;
    contactWay: string;
    contactWayHint: string;
    yes: string;
    no: string;
    optional: string;
    reportTitlePublic: string;
    reportIntro: string;
    benefit: string;
    effort: string;
    risk: string;
    dataMaturity: string;
    completedTitle: string;
    completedBody: string;
    expiredTitle: string;
    expiredBody: string;
    revokedTitle: string;
    revokedBody: string;
    invalidTitle: string;
    invalidBody: string;
    errorTitle: string;
    errorBody: string;
    retry: string;
    aiUnavailable: string;
    aiTruncated: string;
    aiLimitReached: string;
    aiFiltered: string;
    skipShort: string;
    skipShortHint: string;
    saveLater: string;
    saveLaterHint: string;
    requiredMark: string;
    fieldRequired: string;
    publicFooter: string;
    backToStart: string;
    moveUp: string;
    moveDown: string;
  };
  websites: {
    title: string;
    description: string;
    newAction: string;
    kpiTotal: string;
    kpiTotalHint: (own: number, client: number) => string;
    kpiLive: string;
    kpiDraft: string;
    kpiDraftHint: string;
    kpiAttention: string;
    kpiAttentionHint: string;
    createTitle: string;
    createHint: string;
    nameLabel: string;
    namePlaceholder: string;
    domainLabel: string;
    domainPlaceholder: string;
    clientLabel: string;
    clientNone: string;
    createSubmit: string;
    creating: string;
    formInvalid: string;
    created: (name: string) => string;
    listTitle: string;
    listSummary: (shown: number, total: number) => string;
    filterLabel: string;
    filterAll: string;
    filterOwn: string;
    filterClient: string;
    searchLabel: string;
    searchPlaceholder: string;
    emptyTitle: string;
    emptyFiltered: string;
    emptyInitial: string;
    colSite: string;
    colOwner: string;
    colStatus: string;
    colBuild: string;
    colAction: string;
    ownerOwn: string;
    noBuild: string;
    openAction: string;
    statusLabels: Record<WebsiteStatus, string>;
    buildStatusLabels: Record<WebsiteBuildStatus, string>;
    pageOriginLabels: Record<WebsitePageOrigin, string>;
    pageStatus: (from: number, to: number, total: number) => string;
    prevPage: string;
    nextPage: string;
    detailTitleFallback: string;
    backToAll: string;
    detailProject: string;
    projectRepo: string;
    projectBranch: string;
    projectAstro: string;
    projectNone: string;
    detailRelease: string;
    releaseVersion: (version: string) => string;
    releaseNone: string;
    detailClient: string;
    clientEmpty: string;
    clientEmptyHint: string;
    clientName: string;
    clientContact: string;
    clientEmail: string;
    detailPages: string;
    pagesEmpty: string;
    detailBuilds: string;
    buildsEmpty: string;
    buildDuration: (ms: number) => string;
    buildAction: string;
    buildStarting: string;
    buildQueued: string;
    detailApproval: string;
    approvalNone: string;
    approvalHint: string;
    approvalCreated: string;
    approvalLinkTitle: string;
    approvalLinkHint: string;
    approvalRequest: string;
    approvalRequesting: string;
    approvalNeedsBuild: string;
    approvalStateLabels: Record<WebsiteApprovalState, string>;
    approvalExpiresLabel: string;
    approvalRecipient: string;
    approvalComment: string;
    copyLink: string;
    copied: string;
    copyFailed: string;
    publishAction: string;
    publishing: string;
    publishBlocked: string;
    publishDone: (version: string) => string;
    aiTitle: string;
    aiHint: string;
    aiGoalLabel: string;
    aiGoalPlaceholder: string;
    aiPagesLabel: string;
    aiPagesHint: string;
    aiSubmit: string;
    aiSubmitting: string;
    aiQueued: string;
    aiBudget: string;
    aiRunnerNote: string;
    deleteAction: string;
    deleteTitle: (name: string) => string;
    deleteBody: string;
    deleteConfirm: string;
  };
  approval: {
    kicker: string;
    title: (name: string) => string;
    intro: string;
    changesTitle: string;
    noPages: string;
    stateOpen: string;
    stateApproved: string;
    stateChanges: string;
    decideTitle: string;
    commentLabel: string;
    commentHint: string;
    commentPlaceholder: string;
    commentRequired: string;
    approve: string;
    approving: string;
    requestChanges: string;
    requesting: string;
    approvedBody: string;
    changesBody: string;
    privacy: string;
    expiresAt: (date: string) => string;
    expiredTitle: string;
    expiredBody: string;
    missingTitle: string;
    missingBody: string;
    errorTitle: string;
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
    agent: 'Agent',
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
    appearanceSwitch: (current, next) => `Darstellung: ${current} — wechseln zu ${next}`,
    appearanceLight: 'hell',
    appearanceDark: 'dunkel',
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
  tenantSwitcher: {
    title: 'Mandantenkontext wählen',
    description: 'Wählen Sie einen aktiven Mandanten aus, um in dessen Kontext zu arbeiten.',
    contextLabel: 'Mandantenkontext',
    noTenant: 'Kein Mandant gewählt',
    chooseTenant: 'Mandant wählen …',
    switchTenant: 'Mandant wechseln …',
    clearContext: 'Kontext aufheben',
    clearContextAria: 'Mandantenkontext aufheben',
    searchPlaceholder: 'Mandanten suchen …',
    searchAria: 'Mandanten filtern',
    loadingTenants: 'Mandanten werden geladen …',
    emptyList: 'Keine aktiven Mandanten vorhanden.',
    emptySearch: 'Keine Mandanten gefunden.',
    colName: 'Firma',
    colSlug: 'Slug',
    selectAction: 'Auswählen',
    activeBadge: 'Aktiv',
    switchedSuccess: (name) => `Mandantenkontext aktiviert: ${name}`,
    clearedSuccess: 'Mandantenkontext aufgehoben.',
    prevPage: 'Zurück',
    nextPage: 'Weiter',
  },
  llm: {
    title: 'KI-Anbieter',
    description:
      'Provider und Modelle zentral verwalten. Plugins fragen einen Zweck an, nie einen Schlüssel.',
    addProvider: 'Provider verbinden',
    providersTitle: 'Provider',
    providersMeta: (shown, total) => `${shown} von ${total}`,
    emptyTitle: 'Noch kein Provider',
    emptyDescription:
      'Verbinden Sie ein OpenAI-kompatibles Gateway, damit Plugins Modelle nutzen können.',
    colProvider: 'Anbieter',
    colType: 'Typ',
    colModels: 'Modelle',
    colAccess: 'Freigabe',
    colLastTest: 'Letzter Test',
    colStatus: 'Status',
    colCalls: '30 T',
    colAction: 'Aktion',
    retrySummary: (seconds, retries) =>
      `${seconds} s · ${retries === 1 ? '1 Wiederholung' : `${retries} Wiederholungen`}`,
    statusActive: 'Aktiv',
    statusDisabled: 'Gesperrt',
    allPlugins: 'Alle Plugins',
    neverTested: 'Noch nicht getestet',
    kpiProviders: 'Provider',
    kpiProvidersHint: 'aktiv und gesperrt',
    kpiModels: 'Modelle',
    kpiModelsHint: 'über alle Provider',
    kpiCalls: 'Aufrufe · 30 T',
    kpiCallsHint: 'erfolgreich und Fehler',
    kpiCost: 'Kosten · 30 T',
    kpiCostHint: 'nach gepflegten Preisen',
    purposesTitle: 'Zwecke',
    purposesMeta:
      'Ein Zweck ist ein stabiler Name. Das Modell weisen Sie auf der Provider-Seite zu; ein Wechsel braucht kein Deployment.',
    purposeLabel: 'Zweck',
    modelLabel: 'Modell',
    fallbackLabel: 'Fallback',
    callsLabel: 'Aufrufe',
    unmapped: 'Nicht belegt',
    save: 'Speichern',
    saved: 'Gespeichert.',
    addPurpose: 'Zweck anlegen',
    purposePlaceholder: 'z. B. email.classify',
    usageTitle: 'Nutzung',
    usageMeta: (days) => `Letzte ${days} Tage`,
    usageCaller: 'Plugin',
    usagePurpose: 'Zweck',
    usageTokens: 'Tokens',
    usageCost: 'Kosten',
    usageWhen: 'Zeit',
    usageEmpty: 'Noch keine Aufrufe.',
    newTitle: 'Provider verbinden',
    newDescription:
      'OpenAI-kompatibel: vLLM, LiteLLM, Ollama, OpenRouter oder ein eigenes Gateway.',
    editTitle: 'Provider bearbeiten',
    nameLabel: 'Anzeigename',
    namePlaceholder: 'z. B. Internes Gateway',
    presetLabel: 'Vorlage',
    presetCustom: 'Eigene',
    baseUrlLabel: 'Basis-URL',
    baseUrlHint: 'Nur Origin und Pfad, keine Zugangsdaten in der URL.',
    chatPathLabel: 'Chat-Pfad',
    chatPathHint: '{model} wird ersetzt.',
    apiVersionLabel: 'API-Version',
    authStyleLabel: 'Authentifizierung',
    authBearer: 'Bearer',
    authHeader: 'Eigener Header',
    authNone: 'Keine',
    authHeaderLabel: 'Header-Name',
    apiKeyLabel: 'API-Schlüssel',
    apiKeyHint: 'Wird versiegelt gespeichert und nie zurückgegeben.',
    apiKeyKeep: 'Leer lassen, um den gespeicherten Schlüssel zu behalten.',
    extraHeadersLabel: 'Zusatz-Header (JSON)',
    extraHeadersHint: 'Werte werden versiegelt; die Oberfläche zeigt nur die Namen.',
    invalidJson: 'Die Zusatz-Header sind kein gültiges JSON.',
    timeoutLabel: 'Zeitlimit (Sekunden)',
    retriesLabel: 'Wiederholungen',
    rateLabel: 'Aufrufe je Minute',
    dailyLabel: 'Tageslimit Tokens (0 = aus)',
    monthlyLabel: 'Monatsbudget Euro (0 = aus)',
    retentionLabel: 'Aufbewahrung (Tage)',
    allowedLabel: 'Freigegeben für',
    allowedHint: 'Kommagetrennte Plugin-IDs; leer = alle aktiven Plugins.',
    testButton: 'Testen',
    testing: 'Teste …',
    testOk: (ms, models) => `Erreichbar · ${ms} ms · ${models} Modelle`,
    testFailed: 'Nicht erreichbar',
    testNoPrompt: 'Der Test ruft nur die Modellliste ab und sendet keinen Prompt.',
    saveProvider: 'Speichern',
    saving: 'Speichere …',
    modelsTitle: 'Modelle',
    modelsMeta: (count) => `${count} Modelle`,
    addModel: 'Modell hinzufügen',
    refreshModels: 'Modelle laden',
    noModels:
      'Noch kein Modell. Laden Sie die Liste des Anbieters oder legen Sie eines manuell an.',
    modelKeyLabel: 'Modell-ID',
    modelLabelLabel: 'Anzeigename',
    contextLabel: 'Kontext',
    outputLabel: 'Max. Ausgabe',
    capabilitiesLabel: 'Fähigkeiten',
    capTools: 'Tools',
    capJson: 'JSON',
    capVision: 'Vision',
    capEmbeddings: 'Embeddings',
    defaultLabel: 'Standard',
    makeDefault: 'Als Standard',
    deleteModel: 'Löschen',
    deleteModelConfirm: 'Modell löschen?',
    discovered: 'Erkannt',
    manual: 'Manuell',
    settingsTitle: 'Einstellungen',
    statusLabel: 'Status',
    saveSettings: 'Einstellungen speichern',
    deleteProvider: 'Provider löschen',
    deleteProviderConfirm: 'Provider und Konfiguration löschen?',
    backToList: 'Zurück zu KI-Anbieter',
    notFoundTitle: 'Provider nicht gefunden',
    notFoundDescription: 'Der Provider existiert nicht mehr.',
    factBaseUrl: 'Basis-URL',
    factAuth: 'Authentifizierung',
    factTimeout: 'Zeitlimit',
    factAccess: 'Freigabe',
    factLastTest: 'Letzter Test',
    keySet: (date) => `Schlüssel gesetzt · ${date}`,
    keyNotSet: 'Kein Schlüssel',
    loaded: 'Modelle geladen.',
    errorsLabel: 'Fehler',
  },
  agent: {
    title: 'Agent',
    description: 'Fragt die Plattform nach ihrem Zustand — liest nur, ändert nichts.',
    placeholder: 'Frag die Plattform …',
    textareaLabel: 'Frage an den Agenten',
    hint: 'Enter sendet · Shift+Enter neue Zeile · liest nur',
    send: 'Senden',
    thinking: 'Der Agent liest die Datenquellen …',
    examples: 'Beispiele',
    examplesHint: 'aus echten Datenquellen',
    exampleTenantsTitle: 'Wie viele Mandanten sind gesperrt?',
    exampleTenantsText: 'Zählt aktive und gesperrte Mandanten und nennt die betroffenen.',
    exampleEventsTitle: 'Was ist zuletzt passiert?',
    exampleEventsText: 'Liest das Ereignisprotokoll der letzten Stunden, ohne Nutzdaten.',
    exampleSourcesTitle: 'Welche Daten kann ich fragen?',
    exampleSourcesText: 'Zeigt die freigegebenen Quellen mit Zweck und Argumenten.',
    newQuestion: 'Neu fragen',
    copy: 'Kopieren',
    copied: 'Kopiert',
    sources: 'Quellen',
    steps: 'Abfrageprotokoll',
    stepsSummary: (count, ms) => `${count} ${count === 1 ? 'Abfrage' : 'Abfragen'} · ${ms} ms`,
    stepOk: 'OK',
    stepError: 'Fehler',
    ready: 'Bereit',
    notConfigured: 'Nicht konfiguriert',
    modelLabel: 'Modell',
    stand: (time) => `Stand ${time}`,
    retention: (days) => `Aufbewahrung ${days} Tage`,
    limit: (perMinute, perDay) => `${perMinute} pro Minute · ${perDay} pro Tag`,
    providerMissingTitle: 'Kein Modell hinterlegt',
    providerMissingText:
      'Der Agent beantwortet Fragen über ein Modell-Plugin. Es ist noch nicht eingerichtet; die Plattform selbst läuft normal weiter.',
    providerUnreachableTitle: 'Modell-Plugin antwortet nicht',
    providerUnreachableText:
      'Der Agent erreicht das Modell-Plugin gerade nicht. Prüfen Sie dessen Zustand; Fragen sind erst danach möglich.',
    checkStatus: 'Status prüfen',
    emptyAnswer: 'Die Antwort war leer. Bitte fragen Sie erneut.',
    truncatedNotice:
      'Die Datenquelle lieferte mehr, als in eine Antwort passt; die Antwort nutzt den Anfang.',
    errorTitle: 'Die Frage konnte nicht beantwortet werden.',
    history: 'Verlauf',
    clearHistory: 'Verlauf leeren',
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
    themeLabel: 'Farbschema',
    themeHint:
      'Farbschema für Hell- und Dunkelmodus. Es gilt sofort und wird in diesem Browser gespeichert.',
    themeCustomTitle: 'Eigenes Theme',
    themeCustomHint:
      'Aus Akzent- und Papierfarbe wird ein vollständiges Theme berechnet; Texte bleiben durch die Kontrastprüfung lesbar.',
    themeNameLabel: 'Name',
    themeAccentLabel: 'Akzentfarbe',
    themePaperLabel: 'Papierfarbe (hell)',
    themeApply: 'Theme anwenden',
    themeReset: 'Eigenes Theme löschen',
    themeJsonTitle: 'Theme als JSON',
    themeJsonHint:
      'Theme-Datei einfügen oder das aktuelle Theme exportieren. Erlaubt sind vollständige Farbwerte (light, dark) oder die Kurzform name, accent, paper.',
    themeJsonLabel: 'Theme-JSON',
    themeJsonExport: 'Aktuelles Theme exportieren',
    themeJsonImport: 'JSON übernehmen',
    themeJsonApplied: 'Theme übernommen.',
    themeErrorJson: 'Das ist kein gültiges JSON.',
    themeErrorShape:
      'Aufbau nicht erkannt: erwartet werden name mit accent und paper oder name mit light und dark.',
    themeErrorVersion: 'Unbekannte schemaVersion; unterstützt wird Version 1.',
    themeErrorName: 'Name fehlt oder ist länger als 40 Zeichen.',
    themeErrorColor: 'Jede Farbe muss ein Hex-Wert sein, zum Beispiel #1e3bff.',
    themeErrorPaperDark: 'Die Papierfarbe ist zu dunkel; sie gilt für den Hellmodus.',
    themeErrorContrast:
      'Zu wenig Kontrast: Text muss sich deutlich vom Hintergrund abheben (mindestens 4,5:1).',
    languageLabel: 'Sprache',
    localHint: 'Designmodus, Farbschema und Sprache werden lokal in diesem Browser gespeichert.',
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
  discovery: {
    title: 'Automatisierungs-Scout',
    description:
      'Einmal-Link pro Kunde, KI-Interview ohne Anmeldung und eine priorisierte Auswertung für das Erstgespräch.',
    createTitle: 'Neue Einladung',
    customerLabel: 'Kunde',
    customerPlaceholder: 'Firma oder Ansprechpartner',
    emailLabel: 'E-Mail des Ansprechpartners (optional)',
    emailPlaceholder: 'name@firma.de',
    localeLabel: 'Sprache des Interviews',
    modeLabel: 'Umfang',
    modeShort: 'Kurzcheck (nur Landkarte)',
    modeStandard: 'Standard (Landkarte + 3 Themen)',
    modeFull: 'Voll (Landkarte + 5 Themen)',
    expiryLabel: 'Gültigkeit in Tagen',
    expiryHint: '1 bis 30 Tage. Standard sind 14 Tage.',
    tenantLabel: 'Mandant (optional)',
    tenantNone: 'Kein Mandantenbezug',
    createSubmit: 'Einladung anlegen',
    creating: 'Wird angelegt …',
    linkTitle: 'Link für den Kunden',
    linkNote:
      'Dieser Link erscheint nur jetzt. Kopieren Sie ihn und senden Sie ihn selbst – dieser Stand hat keinen Mailversand.',
    linkCopy: 'Link kopieren',
    linkCopied: 'Link kopiert',
    mailUnavailable:
      'Kein Mailversand in diesem Stand. Der Link wurde nicht per E-Mail verschickt.',
    listTitle: 'Einladungen',
    listSummary: (shown: number, total: number) => `${shown} von ${total} Einladungen.`,
    searchLabel: 'Suchen',
    searchPlaceholder: 'Kunde oder E-Mail',
    filterAll: 'Alle',
    colCustomer: 'Kunde',
    colStatus: 'Status',
    colProgress: 'Fortschritt',
    colAiBudget: 'KI-Aufrufe',
    colAiStepBudget: 'KI-Aufrufe aktuelle Frage',
    aiBudgetSummary: (used, assessments) => `${used} gesamt, ${assessments} für die Auswertung`,
    aiStepBudget: (used, blocked) =>
      blocked
        ? `${used} für die aktuelle Frage — Limit erreicht, der Kunde sieht 429`
        : `${used} für die aktuelle Frage`,
    colExpires: 'Gültig bis',
    colActions: 'Aktionen',
    statusOpen: 'Offen',
    statusInProgress: 'Läuft',
    statusCompleted: 'Abgeschlossen',
    statusRevoked: 'Widerrufen',
    statusExpired: 'Abgelaufen',
    actionOpen: 'Öffnen',
    actionRevoke: 'Widerrufen',
    actionResend: 'Neuen Link erzeugen',
    back: 'Zurück zur Liste',
    detailTitle: 'Einladung',
    answersTitle: 'Antworten',
    noAnswers: 'Noch keine Antworten.',
    reportTitle: 'Auswertung',
    reportSummary: 'Zusammenfassung',
    reportClusters: 'Themen',
    reportOpportunities: 'Automatisierungsideen',
    reportQuickWins: 'Schnelle Erfolge',
    reportOpenQuestions: 'Offene Fragen',
    reportNextStep: 'Nächster Schritt',
    colBenefit: 'Nutzen',
    colEffort: 'Aufwand',
    colRisk: 'Risiko',
    colData: 'Datenreife',
    reportUnavailable: 'Noch keine Auswertung. Sie entsteht beim Abschluss des Interviews.',
    revokeConfirmTitle: 'Einladung widerrufen?',
    revokeConfirmBody:
      'Der Link funktioniert sofort nicht mehr. Bereits gespeicherte Antworten bleiben für Sie lesbar.',
    revokeButton: 'Widerrufen',
    revokedToast: 'Einladung widerrufen.',
    linkRotatedToast: 'Neuer Link erzeugt. Der alte Link ist ungültig.',
    emptyTitle: 'Noch keine Einladungen',
    emptyDescription: 'Legen Sie oben die erste Einladung an. Der Link erscheint genau einmal.',
    prevPage: 'Zurück',
    nextPage: 'Weiter',
    pageStatus: (from: number, to: number, total: number) => `${from}–${to} von ${total}`,
    kpiTotal: 'Einladungen',
    kpiOpen: 'Offen',
    kpiInProgress: 'Laufen',
    kpiCompleted: 'Abgeschlossen',
    overviewRecent: 'Letzte Aktivitäten',
    contactLabel: 'Kontakt',
    loadError: 'Die Einladungen konnten nicht geladen werden.',
    publicBrand: 'SmartFlow',
    publicTitle: 'Automatisierungs-Check',
    publicIntro:
      'Ein kurzes Interview zu Ihren Abläufen. Am Ende erhalten Sie eine Auswertung mit konkreten Automatisierungsideen.',
    consentTitle: 'Bevor es losgeht',
    consentNote:
      'Ihre Antworten werden zur Erstellung der Auswertung an einen KI-Dienst übermittelt. Wir speichern sie 90 Tage nach Abschluss und löschen sie danach. Es gibt kein Konto und kein Passwort.',
    start: 'Interview starten',
    next: 'Weiter',
    finish: 'Auswertung erstellen',
    saving: 'Wird gespeichert …',
    saved: 'Antwort gespeichert',
    progressLabel: 'Fortschritt',
    stepOf: (done: number, total: number) => `Schritt ${done} von ${total}`,
    hintTitle: 'Hinweis',
    examplesTitle: 'Beispiele',
    ideasTitle: 'Vorschlag, unverbindlich',
    ideasHint: 'Markieren Sie, was für Sie relevant ist.',
    contactTitle: 'Erstgespräch',
    contactQuestion: 'Möchten Sie ein Erstgespräch?',
    contactWay: 'Wie erreichen wir Sie am besten?',
    contactWayHint: 'Zum Beispiel Telefon am Vormittag oder eine E-Mail-Adresse.',
    yes: 'Ja',
    no: 'Nein',
    optional: 'optional',
    reportTitlePublic: 'Ihre Auswertung',
    reportIntro:
      'Die Auswertung ist ein Vorschlag, keine Zusage. Zahlen und Aufwände sind Schätzungen aus Ihren Angaben.',
    benefit: 'Nutzen',
    effort: 'Aufwand',
    risk: 'Risiko',
    dataMaturity: 'Datenreife',
    completedTitle: 'Vielen Dank',
    completedBody:
      'Das Interview ist abgeschlossen. Der Link ist jetzt schreibgeschützt; Sie können die Auswertung jederzeit erneut ansehen.',
    expiredTitle: 'Link abgelaufen',
    expiredBody:
      'Dieser Link ist nicht mehr gültig. Bitte wenden Sie sich an Ihren Ansprechpartner.',
    revokedTitle: 'Link widerrufen',
    revokedBody: 'Dieser Link wurde widerrufen. Bitte wenden Sie sich an Ihren Ansprechpartner.',
    invalidTitle: 'Link nicht gefunden',
    invalidBody:
      'Dieser Link ist unbekannt. Prüfen Sie die Adresse oder wenden Sie sich an Ihren Ansprechpartner.',
    errorTitle: 'Das hat nicht geklappt',
    errorBody: 'Bitte versuchen Sie es erneut. Ihre gespeicherten Antworten bleiben erhalten.',
    retry: 'Erneut versuchen',
    aiUnavailable:
      'Der KI-Dienst antwortet gerade nicht. Ihre Antworten sind gespeichert; bitte versuchen Sie es gleich noch einmal.',
    aiTruncated:
      'Die Auswertung war beim Erstellen zu lang und wurde abgeschnitten. Ihre Antworten sind gespeichert; bitte versuchen Sie es noch einmal.',
    aiLimitReached:
      'Für diesen Link wurde die Auswertung zu oft angefordert. Ihre Antworten sind gespeichert; bitte wenden Sie sich an Ihren Ansprechpartner.',
    aiFiltered:
      'Der KI-Dienst hat die Auswertung dieses Inhalts abgelehnt. Ihre Antworten sind gespeichert; bitte wenden Sie sich an Ihren Ansprechpartner.',
    skipShort: 'Abkürzen: ohne Vertiefung fortfahren',
    skipShortHint: 'Sie können nach der Landkarte direkt zur Auswertung.',
    saveLater: 'Speichern und später weiter',
    saveLaterHint: 'Ihr Fortschritt ist gespeichert. Öffnen Sie denselben Link später erneut.',
    requiredMark: 'Pflichtfeld',
    fieldRequired: 'Bitte beantworten Sie diese Frage.',
    publicFooter: 'Ihre Angaben werden vertraulich behandelt.',
    backToStart: 'Zurück',
    moveUp: 'Nach oben',
    moveDown: 'Nach unten',
  },
  websites: {
    title: 'Webseiten',
    description:
      'Eigene Seiten und Kundenprojekte an einer Stelle: Entwurf, Astro-Build, Vorschau, Freigabe und Livegang.',
    newAction: 'Neue Website',
    kpiTotal: 'Webseiten',
    kpiTotalHint: (own, client) => `${own} eigene · ${client} Kunden`,
    kpiLive: 'Live',
    kpiDraft: 'In Arbeit',
    kpiDraftHint: 'Entwürfe ohne Livegang',
    kpiAttention: 'Zu prüfen',
    kpiAttentionHint: 'Build-Fehler und offene Freigaben',
    createTitle: 'Website anlegen',
    createHint: 'Der Astro-Build entsteht erst mit einem Lauf.',
    nameLabel: 'Name',
    namePlaceholder: 'z. B. Hotel Zum Anker',
    domainLabel: 'Domain',
    domainPlaceholder: 'hotel-zum-anker.de',
    clientLabel: 'Kunde',
    clientNone: 'Eigene Website',
    createSubmit: 'Anlegen',
    creating: 'Wird angelegt …',
    formInvalid: 'Bitte prüfen Sie die markierten Felder.',
    created: (name) => `${name} wurde angelegt.`,
    listTitle: 'Portfolio',
    listSummary: (shown, total) => `${shown} von ${total}`,
    filterLabel: 'Auswahl filtern',
    filterAll: 'Alle',
    filterOwn: 'Eigene',
    filterClient: 'Kunden',
    searchLabel: 'Webseiten durchsuchen',
    searchPlaceholder: 'Name, Slug oder Domain …',
    emptyTitle: 'Keine Website gefunden',
    emptyFiltered: 'Keine Website passt zu Suche und Auswahl.',
    emptyInitial: 'Noch keine Website angelegt. Beginnen Sie oben mit einer neuen Website.',
    colSite: 'Webseite',
    colOwner: 'Kunde',
    colStatus: 'Status',
    colBuild: 'Letzter Build',
    colAction: 'Aktion',
    ownerOwn: 'Eigene',
    noBuild: 'Noch kein Build',
    openAction: 'Öffnen',
    statusLabels: {
      draft: 'Entwurf',
      live: 'Live',
      failed: 'Build-Fehler',
    },
    buildStatusLabels: {
      queued: 'In Warteschlange',
      running: 'Läuft',
      ok: 'Erfolgreich',
      failed: 'Fehlgeschlagen',
      cancelled: 'Abgebrochen',
    },
    pageOriginLabels: {
      ai: 'KI',
      manual: 'manuell',
      template: 'Vorlage',
    },
    pageStatus: (from, to, total) => `${from} bis ${to} von ${total}`,
    prevPage: 'Zurück',
    nextPage: 'Weiter',
    detailTitleFallback: 'Webseite',
    backToAll: 'Alle Webseiten',
    detailProject: 'Astro-Projekt',
    projectRepo: 'Repository',
    projectBranch: 'Branch',
    projectAstro: 'Stack',
    projectNone: 'nicht gesetzt',
    detailRelease: 'Veröffentlichung',
    releaseVersion: (version) => `${version} live`,
    releaseNone: 'Noch nicht veröffentlicht',
    detailClient: 'Kunde',
    clientEmpty: 'Eigene Website',
    clientEmptyHint:
      'Diese Website gehört zur Agentur selbst. Für Kundenprojekte legen Sie beim Anlegen einen Kunden an.',
    clientName: 'Firma',
    clientContact: 'Ansprechpartner',
    clientEmail: 'E-Mail',
    detailPages: 'Seiten',
    pagesEmpty: 'Noch keine Seite. Ein KI-Lauf oder eine manuelle Seite legt Routen an.',
    detailBuilds: 'Builds',
    buildsEmpty: 'Noch kein Build. Starten Sie einen Build, damit ein Runner ihn abarbeitet.',
    buildDuration: (ms) => `${(ms / 1000).toFixed(1)} s`,
    buildAction: 'Build starten',
    buildStarting: 'Wird gestartet …',
    buildQueued: 'Build eingereiht. Ein Runner arbeitet ihn ab.',
    detailApproval: 'Freigabe',
    approvalNone: 'Keine Freigabe angefordert.',
    approvalHint:
      'Der Link gilt 14 Tage und zeigt genau diesen Build. Nach einer Änderung entsteht ein neuer Build mit neuer Freigabe.',
    approvalCreated: 'Freigabe-Link erzeugt. Er wird nur jetzt vollständig angezeigt.',
    approvalLinkTitle: 'Freigabe-Link',
    approvalLinkHint: 'Einmalig sichtbar · nicht indexiert',
    approvalRequest: 'Freigabe anfordern',
    approvalRequesting: 'Wird erzeugt …',
    approvalNeedsBuild: 'Erst ein erfolgreicher Build kann zur Freigabe.',
    approvalStateLabels: {
      open: 'Offen',
      approved: 'Freigegeben',
      changes: 'Änderung gewünscht',
      expired: 'Abgelaufen',
    },
    approvalExpiresLabel: 'Gültig bis',
    approvalRecipient: 'Empfänger',
    approvalComment: 'Kommentar des Kunden',
    copyLink: 'Kopieren',
    copied: 'Kopiert',
    copyFailed: 'Kopieren nicht möglich. Markieren Sie den Link von Hand.',
    publishAction: 'Veröffentlichen',
    publishing: 'Wird veröffentlicht …',
    publishBlocked:
      'Veröffentlichen braucht einen erfolgreichen Build und die Freigabe des Kunden.',
    publishDone: (version) => `${version} ist live.`,
    aiTitle: 'KI-Entwurf',
    aiHint: 'Brief an einen Runner',
    aiGoalLabel: 'Zweck',
    aiGoalPlaceholder: 'Übernachtungen und Restaurant direkt buchbar machen.',
    aiPagesLabel: 'Seiten',
    aiPagesHint: 'kommagetrennt, mit / beginnend',
    aiSubmit: 'Auftrag einreihen',
    aiSubmitting: 'Wird eingereiht …',
    aiQueued: 'KI-Auftrag eingereiht. Ein Runner erzeugt Plan und Dateien.',
    aiBudget: 'Das Monatsbudget für KI-Läufe ist ausgeschöpft.',
    aiRunnerNote:
      'Der Auftrag liegt in der Warteschlange, bis ein Runner ihn abholt — die Plattform selbst ruft kein Modell auf.',
    deleteAction: 'Website löschen',
    deleteTitle: (name) => `${name} löschen?`,
    deleteBody:
      'Seiten, Builds und Freigaben dieser Website werden mitgelöscht. Veröffentlichte Websites lassen sich nicht löschen.',
    deleteConfirm: 'Website löschen',
  },
  approval: {
    kicker: 'Freigabe',
    title: (name) => `${name}: Entwurf zur Freigabe`,
    intro:
      'Bitte prüfen Sie die Seiten und geben Sie den Stand frei oder wünschen Sie eine Änderung. Es ist kein Konto nötig.',
    changesTitle: 'Seiten in diesem Entwurf',
    noPages: 'Dieser Entwurf enthält noch keine Seiten.',
    stateOpen: 'Offen',
    stateApproved: 'Freigegeben',
    stateChanges: 'Änderung gewünscht',
    decideTitle: 'Ihre Rückmeldung',
    commentLabel: 'Kommentar',
    commentHint: 'optional bei Freigabe, nötig bei Änderungswunsch',
    commentPlaceholder: 'z. B. Startseite: bitte das Bild vom Marktplatz.',
    commentRequired: 'Bitte beschreiben Sie kurz, was sich ändern soll.',
    approve: 'Freigeben',
    approving: 'Wird gespeichert …',
    requestChanges: 'Änderung wünschen',
    requesting: 'Wird gespeichert …',
    approvedBody:
      'Danke, die Freigabe ist gespeichert. Das Team kann die Website jetzt veröffentlichen.',
    changesBody:
      'Danke, Ihr Änderungswunsch ist gespeichert. Das Team meldet sich mit einem neuen Entwurf.',
    privacy:
      'Dieser Link ist persönlich und nicht in Suchmaschinen. Er zeigt nur diese eine Website und nur diesen Entwurf.',
    expiresAt: (date) => `Link gültig bis ${date}`,
    expiredTitle: 'Dieser Link ist abgelaufen',
    expiredBody:
      'Aus Sicherheitsgründen gilt jeder Freigabe-Link nur begrenzt. Bitte fordern Sie beim Team einen neuen Link an.',
    missingTitle: 'Freigabe nicht gefunden',
    missingBody: 'Der Link ist unvollständig oder nicht mehr gültig.',
    errorTitle: 'Freigabe nicht erreichbar',
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
    agent: 'Agent',
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
    appearanceSwitch: (current, next) => `Appearance: ${current} — switch to ${next}`,
    appearanceLight: 'light',
    appearanceDark: 'dark',
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
  tenantSwitcher: {
    title: 'Select tenant context',
    description: 'Choose an active tenant to work within their context.',
    contextLabel: 'Tenant context',
    noTenant: 'No tenant selected',
    chooseTenant: 'Select tenant …',
    switchTenant: 'Switch tenant …',
    clearContext: 'Clear context',
    clearContextAria: 'Clear tenant context',
    searchPlaceholder: 'Search tenants …',
    searchAria: 'Filter tenants',
    loadingTenants: 'Loading tenants …',
    emptyList: 'No active tenants available.',
    emptySearch: 'No tenants found.',
    colName: 'Company',
    colSlug: 'Slug',
    selectAction: 'Select',
    activeBadge: 'Active',
    switchedSuccess: (name) => `Tenant context activated: ${name}`,
    clearedSuccess: 'Tenant context cleared.',
    prevPage: 'Previous',
    nextPage: 'Next',
  },
  llm: {
    title: 'AI providers',
    description:
      'Manage providers and models in one place. Plugins ask for a purpose, never for a key.',
    addProvider: 'Connect provider',
    providersTitle: 'Providers',
    providersMeta: (shown, total) => `${shown} of ${total}`,
    emptyTitle: 'No provider yet',
    emptyDescription: 'Connect an OpenAI-compatible gateway so plugins can use models.',
    colProvider: 'Provider',
    colType: 'Type',
    colModels: 'Models',
    colAccess: 'Access',
    colLastTest: 'Last test',
    colStatus: 'Status',
    colCalls: '30 d',
    colAction: 'Action',
    retrySummary: (seconds, retries) =>
      `${seconds} s · ${retries === 1 ? '1 retry' : `${retries} retries`}`,
    statusActive: 'Active',
    statusDisabled: 'Disabled',
    allPlugins: 'All plugins',
    neverTested: 'Not tested yet',
    kpiProviders: 'Providers',
    kpiProvidersHint: 'active and disabled',
    kpiModels: 'Models',
    kpiModelsHint: 'across providers',
    kpiCalls: 'Calls · 30 d',
    kpiCallsHint: 'successful and failed',
    kpiCost: 'Cost · 30 d',
    kpiCostHint: 'from maintained prices',
    purposesTitle: 'Purposes',
    purposesMeta:
      'A purpose is a stable name. Assign its model on the provider page; changing it needs no deploy.',
    purposeLabel: 'Purpose',
    modelLabel: 'Model',
    fallbackLabel: 'Fallback',
    callsLabel: 'Calls',
    unmapped: 'Unmapped',
    save: 'Save',
    saved: 'Saved.',
    addPurpose: 'Create purpose',
    purposePlaceholder: 'e.g. email.classify',
    usageTitle: 'Usage',
    usageMeta: (days) => `Last ${days} days`,
    usageCaller: 'Plugin',
    usagePurpose: 'Purpose',
    usageTokens: 'Tokens',
    usageCost: 'Cost',
    usageWhen: 'Time',
    usageEmpty: 'No calls yet.',
    newTitle: 'Connect provider',
    newDescription: 'OpenAI-compatible: vLLM, LiteLLM, Ollama, OpenRouter or a custom gateway.',
    editTitle: 'Edit provider',
    nameLabel: 'Display name',
    namePlaceholder: 'e.g. Internal gateway',
    presetLabel: 'Preset',
    presetCustom: 'Custom',
    baseUrlLabel: 'Base URL',
    baseUrlHint: 'Origin and path only, no credentials in the URL.',
    chatPathLabel: 'Chat path',
    chatPathHint: '{model} is replaced.',
    apiVersionLabel: 'API version',
    authStyleLabel: 'Authentication',
    authBearer: 'Bearer',
    authHeader: 'Custom header',
    authNone: 'None',
    authHeaderLabel: 'Header name',
    apiKeyLabel: 'API key',
    apiKeyHint: 'Stored sealed and never returned.',
    apiKeyKeep: 'Leave empty to keep the stored key.',
    extraHeadersLabel: 'Extra headers (JSON)',
    extraHeadersHint: 'Values are sealed; the UI shows names only.',
    invalidJson: 'The extra headers are not valid JSON.',
    timeoutLabel: 'Timeout (seconds)',
    retriesLabel: 'Retries',
    rateLabel: 'Calls per minute',
    dailyLabel: 'Daily token limit (0 = off)',
    monthlyLabel: 'Monthly budget in euro (0 = off)',
    retentionLabel: 'Retention (days)',
    allowedLabel: 'Allowed for',
    allowedHint: 'Comma-separated plugin ids; empty = every active plugin.',
    testButton: 'Test',
    testing: 'Testing …',
    testOk: (ms, models) => `Reachable · ${ms} ms · ${models} models`,
    testFailed: 'Not reachable',
    testNoPrompt: 'The test only reads the model list and sends no prompt.',
    saveProvider: 'Save',
    saving: 'Saving …',
    modelsTitle: 'Models',
    modelsMeta: (count) => `${count} models`,
    addModel: 'Add model',
    refreshModels: 'Load models',
    noModels: 'No model yet. Load the provider list or add one manually.',
    modelKeyLabel: 'Model id',
    modelLabelLabel: 'Display name',
    contextLabel: 'Context',
    outputLabel: 'Max output',
    capabilitiesLabel: 'Capabilities',
    capTools: 'Tools',
    capJson: 'JSON',
    capVision: 'Vision',
    capEmbeddings: 'Embeddings',
    defaultLabel: 'Default',
    makeDefault: 'Make default',
    deleteModel: 'Delete',
    deleteModelConfirm: 'Delete model?',
    discovered: 'Discovered',
    manual: 'Manual',
    settingsTitle: 'Settings',
    statusLabel: 'Status',
    saveSettings: 'Save settings',
    deleteProvider: 'Delete provider',
    deleteProviderConfirm: 'Delete the provider and its configuration?',
    backToList: 'Back to AI providers',
    notFoundTitle: 'Provider not found',
    notFoundDescription: 'This provider no longer exists.',
    factBaseUrl: 'Base URL',
    factAuth: 'Authentication',
    factTimeout: 'Timeout',
    factAccess: 'Access',
    factLastTest: 'Last test',
    keySet: (date) => `Key set · ${date}`,
    keyNotSet: 'No key',
    loaded: 'Models loaded.',
    errorsLabel: 'Errors',
  },
  agent: {
    title: 'Agent',
    description: 'Asks the platform about itself — reads only, changes nothing.',
    placeholder: 'Ask the platform …',
    textareaLabel: 'Question for the agent',
    hint: 'Enter sends · Shift+Enter for a new line · read-only',
    send: 'Send',
    thinking: 'The agent is reading its sources …',
    examples: 'Examples',
    examplesHint: 'from real data sources',
    exampleTenantsTitle: 'How many tenants are suspended?',
    exampleTenantsText: 'Counts active and suspended tenants and names the affected ones.',
    exampleEventsTitle: 'What happened recently?',
    exampleEventsText: 'Reads the event log of the last hours, without payloads.',
    exampleSourcesTitle: 'What can I ask about?',
    exampleSourcesText: 'Lists the released sources with purpose and arguments.',
    newQuestion: 'Ask again',
    copy: 'Copy',
    copied: 'Copied',
    sources: 'Sources',
    steps: 'Query log',
    stepsSummary: (count, ms) => `${count} ${count === 1 ? 'query' : 'queries'} · ${ms} ms`,
    stepOk: 'OK',
    stepError: 'Error',
    ready: 'Ready',
    notConfigured: 'Not configured',
    modelLabel: 'Model',
    stand: (time) => `As of ${time}`,
    retention: (days) => `Retention ${days} days`,
    limit: (perMinute, perDay) => `${perMinute} per minute · ${perDay} per day`,
    providerMissingTitle: 'No model available',
    providerMissingText:
      'The agent answers through a model plugin. It is not set up yet; the platform itself keeps running normally.',
    providerUnreachableTitle: 'The model plugin is not responding',
    providerUnreachableText:
      'The agent cannot reach the model plugin right now. Check its state; questions are possible afterwards.',
    checkStatus: 'Check status',
    emptyAnswer: 'The answer was empty. Please ask again.',
    truncatedNotice:
      'The source returned more than fits into an answer; the answer uses the beginning.',
    errorTitle: 'The question could not be answered.',
    history: 'History',
    clearHistory: 'Clear history',
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
    themeLabel: 'Colour scheme',
    themeHint:
      'Colour scheme for light and dark mode. It applies immediately and is stored in this browser.',
    themeCustomTitle: 'Custom theme',
    themeCustomHint:
      'A complete theme is derived from an accent and a paper colour; the contrast check keeps text readable.',
    themeNameLabel: 'Name',
    themeAccentLabel: 'Accent colour',
    themePaperLabel: 'Paper colour (light)',
    themeApply: 'Apply theme',
    themeReset: 'Delete custom theme',
    themeJsonTitle: 'Theme as JSON',
    themeJsonHint:
      'Paste a theme file or export the current theme. Accepted are complete colour values (light, dark) or the short form name, accent, paper.',
    themeJsonLabel: 'Theme JSON',
    themeJsonExport: 'Export current theme',
    themeJsonImport: 'Apply JSON',
    themeJsonApplied: 'Theme applied.',
    themeErrorJson: 'That is not valid JSON.',
    themeErrorShape:
      'Structure not recognised: expected name with accent and paper, or name with light and dark.',
    themeErrorVersion: 'Unknown schemaVersion; version 1 is supported.',
    themeErrorName: 'Name is missing or longer than 40 characters.',
    themeErrorColor: 'Every colour must be a hex value, for example #1e3bff.',
    themeErrorPaperDark: 'The paper colour is too dark; it is the light-mode background.',
    themeErrorContrast:
      'Not enough contrast: text must stand out from the background (at least 4.5:1).',
    languageLabel: 'Language',
    localHint: 'Theme mode, colour scheme, and language are stored locally in this browser.',
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
  discovery: {
    title: 'Automation scout',
    description:
      'One link per customer, an AI interview without sign-in and a prioritised assessment for the first call.',
    createTitle: 'New invitation',
    customerLabel: 'Customer',
    customerPlaceholder: 'Company or contact',
    emailLabel: 'Contact email (optional)',
    emailPlaceholder: 'name@company.com',
    localeLabel: 'Interview language',
    modeLabel: 'Scope',
    modeShort: 'Short check (map only)',
    modeStandard: 'Standard (map + 3 topics)',
    modeFull: 'Full (map + 5 topics)',
    expiryLabel: 'Valid for days',
    expiryHint: '1 to 30 days. The default is 14.',
    tenantLabel: 'Tenant (optional)',
    tenantNone: 'No tenant',
    createSubmit: 'Create invitation',
    creating: 'Creating …',
    linkTitle: 'Link for the customer',
    linkNote:
      'This link is shown only now. Copy it and send it yourself – this build has no mail transport.',
    linkCopy: 'Copy link',
    linkCopied: 'Link copied',
    mailUnavailable: 'No mail transport in this build. The link was not sent by email.',
    listTitle: 'Invitations',
    listSummary: (shown: number, total: number) => `${shown} of ${total} invitations.`,
    searchLabel: 'Search',
    searchPlaceholder: 'Customer or email',
    filterAll: 'All',
    colCustomer: 'Customer',
    colStatus: 'Status',
    colProgress: 'Progress',
    colAiBudget: 'AI calls',
    colAiStepBudget: 'AI calls (current question)',
    aiBudgetSummary: (used, assessments) => `${used} in total, ${assessments} for the assessment`,
    aiStepBudget: (used, blocked) =>
      blocked
        ? `${used} for the current question — limit reached, the customer sees 429`
        : `${used} for the current question`,
    colExpires: 'Valid until',
    colActions: 'Actions',
    statusOpen: 'Open',
    statusInProgress: 'In progress',
    statusCompleted: 'Completed',
    statusRevoked: 'Revoked',
    statusExpired: 'Expired',
    actionOpen: 'Open',
    actionRevoke: 'Revoke',
    actionResend: 'Create new link',
    back: 'Back to the list',
    detailTitle: 'Invitation',
    answersTitle: 'Answers',
    noAnswers: 'No answers yet.',
    reportTitle: 'Assessment',
    reportSummary: 'Summary',
    reportClusters: 'Topics',
    reportOpportunities: 'Automation opportunities',
    reportQuickWins: 'Quick wins',
    reportOpenQuestions: 'Open questions',
    reportNextStep: 'Next step',
    colBenefit: 'Benefit',
    colEffort: 'Effort',
    colRisk: 'Risk',
    colData: 'Data maturity',
    reportUnavailable: 'No assessment yet. It is created when the interview is completed.',
    revokeConfirmTitle: 'Revoke the invitation?',
    revokeConfirmBody:
      'The link stops working immediately. Answers that were already saved stay readable for you.',
    revokeButton: 'Revoke',
    revokedToast: 'Invitation revoked.',
    linkRotatedToast: 'New link created. The old link is invalid.',
    emptyTitle: 'No invitations yet',
    emptyDescription: 'Create the first invitation above. The link is shown exactly once.',
    prevPage: 'Previous',
    nextPage: 'Next',
    pageStatus: (from: number, to: number, total: number) => `${from}–${to} of ${total}`,
    kpiTotal: 'Invitations',
    kpiOpen: 'Open',
    kpiInProgress: 'In progress',
    kpiCompleted: 'Completed',
    overviewRecent: 'Recent activity',
    contactLabel: 'Contact',
    loadError: 'The invitations could not be loaded.',
    publicBrand: 'SmartFlow',
    publicTitle: 'Automation check',
    publicIntro:
      'A short interview about your processes. At the end you receive an assessment with concrete automation ideas.',
    consentTitle: 'Before we start',
    consentNote:
      'Your answers are sent to an AI service to produce the assessment. We store them for 90 days after completion and delete them afterwards. There is no account and no password.',
    start: 'Start the interview',
    next: 'Continue',
    finish: 'Create assessment',
    saving: 'Saving …',
    saved: 'Answer saved',
    progressLabel: 'Progress',
    stepOf: (done: number, total: number) => `Step ${done} of ${total}`,
    hintTitle: 'Hint',
    examplesTitle: 'Examples',
    ideasTitle: 'Suggestion, not binding',
    ideasHint: 'Mark what is relevant for you.',
    contactTitle: 'Initial call',
    contactQuestion: 'Would you like an initial call?',
    contactWay: 'How can we best reach you?',
    contactWayHint: 'For example a phone call in the morning or an email address.',
    yes: 'Yes',
    no: 'No',
    optional: 'optional',
    reportTitlePublic: 'Your assessment',
    reportIntro:
      'This assessment is a proposal, not a promise. Figures and effort are estimates from your answers.',
    benefit: 'Benefit',
    effort: 'Effort',
    risk: 'Risk',
    dataMaturity: 'Data maturity',
    completedTitle: 'Thank you',
    completedBody:
      'The interview is complete. The link is now read-only; you can view the assessment again at any time.',
    expiredTitle: 'Link expired',
    expiredBody: 'This link is no longer valid. Please contact your SmartFlow contact.',
    revokedTitle: 'Link revoked',
    revokedBody: 'This link was revoked. Please contact your SmartFlow contact.',
    invalidTitle: 'Link not found',
    invalidBody: 'This link is unknown. Check the address or contact your SmartFlow contact.',
    errorTitle: 'That did not work',
    errorBody: 'Please try again. Your saved answers are kept.',
    retry: 'Try again',
    aiUnavailable:
      'The AI service is not answering right now. Your answers are saved; please try again shortly.',
    aiTruncated:
      'The assessment was too long to be written in one go and was cut off. Your answers are saved; please try again.',
    aiLimitReached:
      'The assessment was requested too often for this link. Your answers are saved; please contact the person who invited you.',
    aiFiltered:
      'The AI service declined to assess this content. Your answers are saved; please contact the person who invited you.',
    skipShort: 'Shortcut: continue without the deep dive',
    skipShortHint: 'After the map you can go straight to the assessment.',
    saveLater: 'Save and continue later',
    saveLaterHint: 'Your progress is saved. Open the same link again later.',
    requiredMark: 'Required',
    fieldRequired: 'Please answer this question.',
    publicFooter: 'Your answers are treated confidentially.',
    backToStart: 'Back',
    moveUp: 'Move up',
    moveDown: 'Move down',
  },
  websites: {
    title: 'Websites',
    description:
      'Own sites and client projects in one place: draft, Astro build, preview, approval and go-live.',
    newAction: 'New website',
    kpiTotal: 'Websites',
    kpiTotalHint: (own, client) => `${own} own · ${client} clients`,
    kpiLive: 'Live',
    kpiDraft: 'In progress',
    kpiDraftHint: 'Drafts not published yet',
    kpiAttention: 'Needs attention',
    kpiAttentionHint: 'Failed builds and open approvals',
    createTitle: 'Create website',
    createHint: 'The Astro build starts with a run, not here.',
    nameLabel: 'Name',
    namePlaceholder: 'e.g. Hotel Zum Anker',
    domainLabel: 'Domain',
    domainPlaceholder: 'hotel-zum-anker.de',
    clientLabel: 'Client',
    clientNone: 'Own website',
    createSubmit: 'Create',
    creating: 'Creating …',
    formInvalid: 'Please check the highlighted fields.',
    created: (name) => `${name} was created.`,
    listTitle: 'Portfolio',
    listSummary: (shown, total) => `${shown} of ${total}`,
    filterLabel: 'Filter portfolio',
    filterAll: 'All',
    filterOwn: 'Own',
    filterClient: 'Clients',
    searchLabel: 'Search websites',
    searchPlaceholder: 'Name, slug or domain …',
    emptyTitle: 'No website found',
    emptyFiltered: 'No website matches the search and filter.',
    emptyInitial: 'No website yet. Start with a new website above.',
    colSite: 'Website',
    colOwner: 'Client',
    colStatus: 'Status',
    colBuild: 'Last build',
    colAction: 'Action',
    ownerOwn: 'Own',
    noBuild: 'No build yet',
    openAction: 'Open',
    statusLabels: {
      draft: 'Draft',
      live: 'Live',
      failed: 'Build failed',
    },
    buildStatusLabels: {
      queued: 'Queued',
      running: 'Running',
      ok: 'Succeeded',
      failed: 'Failed',
      cancelled: 'Cancelled',
    },
    pageOriginLabels: {
      ai: 'AI',
      manual: 'manual',
      template: 'template',
    },
    pageStatus: (from, to, total) => `${from} to ${to} of ${total}`,
    prevPage: 'Previous',
    nextPage: 'Next',
    detailTitleFallback: 'Website',
    backToAll: 'All websites',
    detailProject: 'Astro project',
    projectRepo: 'Repository',
    projectBranch: 'Branch',
    projectAstro: 'Stack',
    projectNone: 'not set',
    detailRelease: 'Release',
    releaseVersion: (version) => `${version} live`,
    releaseNone: 'Not published yet',
    detailClient: 'Client',
    clientEmpty: 'Own website',
    clientEmptyHint:
      'This website belongs to the agency itself. Pick a client when creating a customer project.',
    clientName: 'Company',
    clientContact: 'Contact',
    clientEmail: 'Email',
    detailPages: 'Pages',
    pagesEmpty: 'No page yet. An AI run or a manual page creates routes.',
    detailBuilds: 'Builds',
    buildsEmpty: 'No build yet. Start one so a runner can pick it up.',
    buildDuration: (ms) => `${(ms / 1000).toFixed(1)} s`,
    buildAction: 'Start build',
    buildStarting: 'Starting …',
    buildQueued: 'Build queued. A runner will process it.',
    detailApproval: 'Approval',
    approvalNone: 'No approval requested.',
    approvalHint:
      'The link is valid for 14 days and covers exactly this build. Any change creates a new build with a new approval.',
    approvalCreated: 'Approval link created. It is shown in full only now.',
    approvalLinkTitle: 'Approval link',
    approvalLinkHint: 'shown once · not indexed',
    approvalRequest: 'Request approval',
    approvalRequesting: 'Creating …',
    approvalNeedsBuild: 'A successful build is required first.',
    approvalStateLabels: {
      open: 'Open',
      approved: 'Approved',
      changes: 'Changes requested',
      expired: 'Expired',
    },
    approvalExpiresLabel: 'Valid until',
    approvalRecipient: 'Recipient',
    approvalComment: 'Client comment',
    copyLink: 'Copy',
    copied: 'Copied',
    copyFailed: 'Copy failed. Select the link and copy it manually.',
    publishAction: 'Publish',
    publishing: 'Publishing …',
    publishBlocked: 'Publishing needs a successful build and the client approval.',
    publishDone: (version) => `${version} is live.`,
    aiTitle: 'AI draft',
    aiHint: 'brief for a runner',
    aiGoalLabel: 'Purpose',
    aiGoalPlaceholder: 'Make rooms and the restaurant directly bookable.',
    aiPagesLabel: 'Pages',
    aiPagesHint: 'comma-separated, starting with /',
    aiSubmit: 'Queue job',
    aiSubmitting: 'Queuing …',
    aiQueued: 'AI job queued. A runner produces plan and files.',
    aiBudget: 'The monthly AI budget is used up.',
    aiRunnerNote:
      'The job waits in the queue until a runner picks it up — the platform itself never calls a model.',
    deleteAction: 'Delete website',
    deleteTitle: (name) => `Delete ${name}?`,
    deleteBody:
      'Pages, builds and approvals of this website are deleted with it. Published websites cannot be deleted.',
    deleteConfirm: 'Delete website',
  },
  approval: {
    kicker: 'Approval',
    title: (name) => `${name}: draft for approval`,
    intro: 'Review the pages, then approve this version or ask for a change. No account is needed.',
    changesTitle: 'Pages in this draft',
    noPages: 'This draft has no pages yet.',
    stateOpen: 'Open',
    stateApproved: 'Approved',
    stateChanges: 'Changes requested',
    decideTitle: 'Your feedback',
    commentLabel: 'Comment',
    commentHint: 'optional when approving, required for a change request',
    commentPlaceholder: 'e.g. Home page: please use the market square photo.',
    commentRequired: 'Please describe briefly what should change.',
    approve: 'Approve',
    approving: 'Saving …',
    requestChanges: 'Request changes',
    requesting: 'Saving …',
    approvedBody: 'Thank you, the approval is saved. The team can publish the website now.',
    changesBody: 'Thank you, your change request is saved. The team will send a new draft.',
    privacy:
      'This link is personal and excluded from search engines. It shows only this website and only this draft.',
    expiresAt: (date) => `Link valid until ${date}`,
    expiredTitle: 'This link has expired',
    expiredBody:
      'For security, every approval link is time-limited. Please ask the team for a new link.',
    missingTitle: 'Approval not found',
    missingBody: 'The link is incomplete or no longer valid.',
    errorTitle: 'Approval unavailable',
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
      case 'tenant_suspended':
        return 'Der Mandant ist gesperrt.';
      case 'validation_failed':
        return 'Bitte prüfen Sie die markierten Eingaben.';
      case 'llm_provider_error':
        return 'Der Anbieter hat die Anfrage abgelehnt.';
      case 'llm_provider_timeout':
        return 'Der Anbieter hat zu lange gebraucht.';
      case 'llm_rate_limited':
        return 'Zu viele Aufrufe in kurzer Zeit.';
      case 'llm_budget_exceeded':
        return 'Das Budget des Providers ist ausgeschöpft.';
      case 'llm_purpose_unmapped':
        return 'Für diesen Zweck ist noch kein Modell hinterlegt.';
      case 'llm_caller_not_allowed':
        return 'Dieses Plugin darf den Provider nicht nutzen.';
      case 'llm_capability_unsupported':
        return 'Das Modell unterstützt diese Funktion nicht.';
      case 'llm_provider_in_use':
        return 'Der Provider wird noch verwendet.';
      case 'llm_model_in_use':
        return 'Das Modell wird noch von einem Zweck verwendet.';
      case 'llm_model_exists':
        return 'Dieses Modell existiert bereits.';
      case 'llm_purpose_exists':
        return 'Dieser Zweck existiert bereits.';
      case 'llm_secret_unreadable':
        return 'Der gespeicherte Schlüssel lässt sich nicht mehr öffnen.';
      case 'agent_not_configured':
        return 'Es ist kein Modell hinterlegt. Bitte den Modell-Provider einrichten.';
      case 'agent_rate_limited':
        return 'Zu viele Fragen in kurzer Zeit. Bitte einen Moment warten.';
      case 'agent_provider_failed':
        return 'Das Modell hat die Anfrage abgelehnt. Bitte erneut versuchen.';
      case 'agent_provider_timeout':
      case 'agent_budget_exceeded':
        return 'Die Antwort hat zu lange gedauert. Bitte enger fragen.';
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
    case 'tenant_suspended':
      return 'The tenant is suspended.';
    case 'validation_failed':
      return 'Please check the highlighted fields.';
    case 'llm_provider_error':
      return 'The provider rejected the request.';
    case 'llm_provider_timeout':
      return 'The provider took too long to answer.';
    case 'llm_rate_limited':
      return 'Too many calls in a short time.';
    case 'llm_budget_exceeded':
      return 'The provider budget is exhausted.';
    case 'llm_purpose_unmapped':
      return 'No model is assigned to this purpose yet.';
    case 'llm_caller_not_allowed':
      return 'This plugin may not use the provider.';
    case 'llm_capability_unsupported':
      return 'This model does not support that feature.';
    case 'llm_provider_in_use':
      return 'The provider is still in use.';
    case 'llm_model_in_use':
      return 'A purpose still uses this model.';
    case 'llm_model_exists':
      return 'This model already exists.';
    case 'llm_purpose_exists':
      return 'This purpose already exists.';
    case 'llm_secret_unreadable':
      return 'The stored key can no longer be opened.';
    case 'agent_not_configured':
      return 'No model is configured. Set up the model provider first.';
    case 'agent_rate_limited':
      return 'Too many questions in a short time. Please wait a moment.';
    case 'agent_provider_failed':
      return 'The model rejected the request. Please try again.';
    case 'agent_provider_timeout':
    case 'agent_budget_exceeded':
      return 'The answer took too long. Please ask a narrower question.';
    default:
      return error.message || m.common.unknownError;
  }
}

export function formatFieldError(
  field: 'email' | 'name' | 'slug' | 'password' | 'domain' | 'route' | 'comment',
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
  if (field === 'domain') {
    return 'Bitte eine Domain wie example.de eingeben, ohne http:// oder Pfad.';
  }
  if (field === 'route') {
    return 'Mit / beginnen, dann Kleinbuchstaben und Bindestriche, z. B. /zimmer/suite.';
  }
  if (field === 'comment') {
    return 'Bitte kurz beschreiben, was sich ändern soll.';
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
