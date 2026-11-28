/**
 * The interview catalogue: questions, clusters and confirmation steps.
 *
 * The catalogue is data, not logic. The server validates answers against these
 * definitions, the SPA renders them, and the AI prompts are built from the same
 * text. Keys are stable: they are the identity of an answer across resume and
 * report generation.
 */

export type Locale = 'de' | 'en';

export interface Localized {
  de: string;
  en: string;
}

export type FieldKind = 'text' | 'single' | 'multi' | 'rank' | 'number' | 'scale' | 'yesno';

export interface FieldOption {
  value: string;
  label: Localized;
}

export interface Field {
  key: string;
  kind: FieldKind;
  label: Localized;
  help?: Localized;
  required: boolean;
  options?: FieldOption[];
  /** Free-text cap, in characters. Defaults to 4000. */
  maxLength?: number;
  maxSelections?: number;
  minSelections?: number;
  min?: number;
  max?: number;
}

export type Phase = 'consent' | 'map' | 'clusters' | 'deepen' | 'confirm';

export interface StepDef {
  key: string;
  phase: Phase;
  cluster?: string;
  fields: Field[];
}

const option = (value: string, de: string, en: string): FieldOption => ({
  value,
  label: { de, en },
});

const ROLES: FieldOption[] = [
  option('owner', 'Inhaber/in oder Geschäftsführung', 'Owner or management'),
  option('sales', 'Vertrieb', 'Sales'),
  option('operations', 'Operations oder Verwaltung', 'Operations or administration'),
  option('finance', 'Finanzen', 'Finance'),
  option('people', 'Personal', 'People'),
  option('it', 'IT', 'IT'),
  option('other', 'Sonstiges', 'Other'),
];

const PAIN_CATEGORIES: FieldOption[] = [
  option('email', 'E-Mail-Flut', 'Email overload'),
  option('data_entry', 'Daten doppelt erfassen', 'Duplicate data entry'),
  option('search', 'Informationen suchen', 'Searching for information'),
  option('approvals', 'Freigaben und Absprachen', 'Approvals and sign-off'),
  option('invoicing', 'Rechnungen und Mahnwesen', 'Invoices and dunning'),
  option('quotes', 'Angebote und Nachfassen', 'Quotes and follow-up'),
  option('scheduling', 'Termine und Disposition', 'Scheduling and dispatch'),
  option('documents', 'Dokumente ablegen und finden', 'Filing and finding documents'),
  option('reporting', 'Reporte zusammenstellen', 'Assembling reports'),
  option('support', 'Support und Reklamationen', 'Support and complaints'),
  option('onboarding', 'Einarbeitung und Personal', 'Onboarding and people'),
  option('other', 'Sonstiges', 'Other'),
];

const SYSTEMS: FieldOption[] = [
  option('erp', 'ERP', 'ERP'),
  option('crm', 'CRM', 'CRM'),
  option('email', 'E-Mail', 'Email'),
  option('excel', 'Excel', 'Excel'),
  option('industry', 'Branchensoftware', 'Industry software'),
  option('phone', 'Telefon', 'Phone'),
  option('paper', 'Papier', 'Paper'),
  option('form', 'Webformular', 'Web form'),
  option('shop', 'Shop', 'Shop'),
  option('dms', 'DMS', 'DMS'),
  option('other', 'Sonstiges', 'Other'),
];

const PRIORITIES: FieldOption[] = [
  option('time', 'Zeit sparen', 'Save time'),
  option('errors', 'Fehlerquote senken', 'Reduce errors'),
  option('revenue', 'Umsatz steigern', 'Grow revenue'),
  option('compliance', 'Compliance sichern', 'Ensure compliance'),
  option('scale', 'Skalierung', 'Scale'),
];

const GUIDELINES: FieldOption[] = [
  option('gdpr', 'DSGVO und Datenschutz', 'GDPR and privacy'),
  option('retention', 'Aufbewahrungsfristen', 'Retention periods'),
  option('four_eyes', 'Vier-Augen-Prinzip', 'Four-eyes principle'),
  option('approvals', 'Freigaben', 'Approvals'),
  option('works_council', 'Betriebsrat', 'Works council'),
  option('none', 'Keine besonderen Vorgaben', 'No special rules'),
];

const CONSENT: StepDef = {
  key: 'consent',
  phase: 'consent',
  fields: [
    {
      key: 'consent',
      kind: 'yesno',
      required: true,
      label: {
        de: 'Ich bin einverstanden, dass meine Antworten zur Erstellung einer Automatisierungs-Auswertung an einen KI-Dienst übermittelt und 90 Tage nach Abschluss gespeichert werden.',
        en: 'I agree that my answers are sent to an AI service to produce an automation assessment and are stored for 90 days after completion.',
      },
    },
  ],
};

export const MAP_STEPS: StepDef[] = [
  CONSENT,
  {
    key: 'map.q1',
    phase: 'map',
    fields: [
      {
        key: 'map.q1',
        kind: 'text',
        required: true,
        maxLength: 600,
        label: { de: 'Branche und Kerngeschäft', en: 'Industry and core business' },
        help: {
          de: 'Ein bis zwei Sätze genügen.',
          en: 'One or two sentences are enough.',
        },
      },
    ],
  },
  {
    key: 'map.q2',
    phase: 'map',
    fields: [
      {
        key: 'map.q2',
        kind: 'single',
        required: true,
        options: ROLES,
        label: { de: 'Ihre Rolle im Unternehmen', en: 'Your role in the company' },
      },
    ],
  },
  {
    key: 'map.q3',
    phase: 'map',
    fields: [
      {
        key: 'map.q3.count',
        kind: 'number',
        required: true,
        min: 1,
        max: 100_000,
        label: {
          de: 'Wie viele Mitarbeitende hat das Unternehmen?',
          en: 'How many people work there?',
        },
      },
      {
        key: 'map.q3.locations',
        kind: 'single',
        required: true,
        options: [
          option('one', 'Ein Standort', 'One location'),
          option('few', 'Zwei bis fünf Standorte', 'Two to five locations'),
          option('many', 'Mehr als fünf Standorte', 'More than five locations'),
        ],
        label: { de: 'Standorte', en: 'Locations' },
      },
    ],
  },
  {
    key: 'map.q4',
    phase: 'map',
    fields: [
      {
        key: 'map.q4.a',
        kind: 'text',
        required: true,
        maxLength: 600,
        label: { de: 'Wiederkehrender Ablauf 1', en: 'Recurring process 1' },
      },
      {
        key: 'map.q4.b',
        kind: 'text',
        required: false,
        maxLength: 600,
        label: { de: 'Ablauf 2 (optional)', en: 'Process 2 (optional)' },
      },
      {
        key: 'map.q4.c',
        kind: 'text',
        required: false,
        maxLength: 600,
        label: { de: 'Ablauf 3 (optional)', en: 'Process 3 (optional)' },
      },
    ],
  },
  {
    key: 'map.q5',
    phase: 'map',
    fields: [
      {
        key: 'map.q5.categories',
        kind: 'multi',
        required: true,
        minSelections: 1,
        maxSelections: 12,
        options: PAIN_CATEGORIES,
        label: {
          de: 'Wo geht heute die meiste Zeit verloren?',
          en: 'Where does most time get lost today?',
        },
      },
      {
        key: 'map.q5.other',
        kind: 'text',
        required: false,
        maxLength: 600,
        label: { de: 'Ergänzung (optional)', en: 'Anything else (optional)' },
      },
    ],
  },
  {
    key: 'map.q6',
    phase: 'map',
    fields: [
      {
        key: 'map.q6',
        kind: 'single',
        required: true,
        options: [
          option('daily', 'Täglich', 'Daily'),
          option('weekly', 'Mehrmals pro Woche', 'Several times a week'),
          option('monthly', 'Mehrmals pro Monat', 'Several times a month'),
          option('rarely', 'Selten', 'Rarely'),
        ],
        label: {
          de: 'Wie oft tritt der wichtigste Schmerz auf?',
          en: 'How often does the main pain point occur?',
        },
      },
    ],
  },
  {
    key: 'map.q7',
    phase: 'map',
    fields: [
      {
        key: 'map.q7',
        kind: 'number',
        required: true,
        min: 1,
        max: 100_000,
        label: {
          de: 'Wie viele Personen sind daran beteiligt?',
          en: 'How many people are involved?',
        },
      },
    ],
  },
  {
    key: 'map.q8',
    phase: 'map',
    fields: [
      {
        key: 'map.q8',
        kind: 'multi',
        required: true,
        minSelections: 1,
        maxSelections: 11,
        options: SYSTEMS,
        label: { de: 'Welche Systeme sind im Spiel?', en: 'Which systems are involved?' },
      },
    ],
  },
  {
    key: 'map.q9',
    phase: 'map',
    fields: [
      {
        key: 'map.q9.level',
        kind: 'scale',
        required: true,
        options: [
          option('none', 'Nichts', 'Nothing'),
          option('little', 'Wenig', 'A little'),
          option('some', 'Teilweise', 'Some'),
          option('much', 'Viel', 'A lot'),
          option('full', 'Weitgehend', 'Mostly'),
        ],
        label: { de: 'Was ist heute bereits automatisiert?', en: 'What is automated today?' },
      },
      {
        key: 'map.q9.note',
        kind: 'text',
        required: false,
        maxLength: 600,
        label: { de: 'Kurzbeschreibung (optional)', en: 'Short description (optional)' },
      },
    ],
  },
  {
    key: 'map.q10',
    phase: 'map',
    fields: [
      {
        key: 'map.q10',
        kind: 'rank',
        required: true,
        options: PRIORITIES,
        label: {
          de: 'Was hat Vorrang? Bitte in Reihenfolge bringen.',
          en: 'What comes first? Please put these in order.',
        },
      },
    ],
  },
  {
    key: 'map.q11',
    phase: 'map',
    fields: [
      {
        key: 'map.q11',
        kind: 'multi',
        required: true,
        minSelections: 1,
        maxSelections: 6,
        options: GUIDELINES,
        label: {
          de: 'Vorgaben und Leitplanken',
          en: 'Policies and guard rails',
        },
      },
    ],
  },
  {
    key: 'map.q12',
    phase: 'map',
    fields: [
      {
        key: 'map.q12',
        kind: 'text',
        required: true,
        maxLength: 2000,
        label: {
          de: 'Was wäre in drei Monaten ein sichtbarer Erfolg?',
          en: 'What would be a visible success in three months?',
        },
      },
    ],
  },
];

export interface ClusterDef {
  id: string;
  label: Localized;
  description: Localized;
}

export const CLUSTERS: ClusterDef[] = [
  {
    id: 'A',
    label: { de: 'Vertrieb & Angebote', en: 'Sales & quotes' },
    description: {
      de: 'Lead-Qualifizierung, Angebotserstellung, Nachfassen, Auftragsanlage.',
      en: 'Lead qualification, quotes, follow-up, order entry.',
    },
  },
  {
    id: 'B',
    label: { de: 'Auftrag & Rechnung', en: 'Orders & invoicing' },
    description: {
      de: 'Auftragsabwicklung, Rechnungsstellung, Mahnwesen, Zahlungsabgleich.',
      en: 'Order handling, invoicing, dunning, payment matching.',
    },
  },
  {
    id: 'C',
    label: { de: 'E-Mail & Kommunikation', en: 'Email & communication' },
    description: {
      de: 'Triage, Entwürfe, Terminabsprachen, Standardantworten.',
      en: 'Triage, drafts, scheduling, standard replies.',
    },
  },
  {
    id: 'D',
    label: { de: 'Dokumente & Daten', en: 'Documents & data' },
    description: {
      de: 'Belegerfassung, Vertragsextraktion, Archivierung, Datenübernahme.',
      en: 'Document capture, contract extraction, archiving, data migration.',
    },
  },
  {
    id: 'E',
    label: { de: 'Termine & Disposition', en: 'Scheduling & dispatch' },
    description: {
      de: 'Touren, Einsatzplanung, Ressourcen, Kapazität.',
      en: 'Routes, staffing, resources, capacity.',
    },
  },
  {
    id: 'F',
    label: { de: 'Personal & Onboarding', en: 'People & onboarding' },
    description: {
      de: 'Bewerbungen, Zeugnisse, Einarbeitung, Zeiterfassung.',
      en: 'Applications, references, onboarding, time tracking.',
    },
  },
  {
    id: 'G',
    label: { de: 'Reporting & Controlling', en: 'Reporting & controlling' },
    description: {
      de: 'Kennzahlen, Exporte, Forecast, Monatsabschluss.',
      en: 'Metrics, exports, forecasts, month-end close.',
    },
  },
  {
    id: 'H',
    label: { de: 'Support & Reklamation', en: 'Support & complaints' },
    description: {
      de: 'Tickets, Wissensbasis, Antwortvorschläge, Eskalation.',
      en: 'Tickets, knowledge base, reply drafts, escalation.',
    },
  },
  {
    id: 'I',
    label: { de: 'Einkauf & Lieferanten', en: 'Purchasing & suppliers' },
    description: {
      de: 'Bestellanforderung, Lieferantenkommunikation, Rechnungsprüfung.',
      en: 'Purchase requests, supplier communication, invoice checks.',
    },
  },
  {
    id: 'J',
    label: { de: 'Marketing & Content', en: 'Marketing & content' },
    description: {
      de: 'Content-Produktion, Kampagnen, Social, Newsletter.',
      en: 'Content production, campaigns, social, newsletters.',
    },
  },
  {
    id: 'K',
    label: { de: 'IT & Betrieb', en: 'IT & operations' },
    description: {
      de: 'Monitoring, Zugänge, Backups, Änderungsanträge.',
      en: 'Monitoring, access, backups, change requests.',
    },
  },
  {
    id: 'L',
    label: { de: 'Individuell', en: 'Custom' },
    description: {
      de: 'Ein freier Ablauf, den der Kunde selbst beschreibt.',
      en: 'A custom process the customer describes.',
    },
  },
];

export const CLUSTERS_BY_ID = new Map(CLUSTERS.map((cluster) => [cluster.id, cluster]));

const DEEP_PROMPTS: Array<{ label: Localized; key: string }> = [
  {
    key: 'q1',
    label: {
      de: 'Wo startet der Ablauf, was löst ihn aus?',
      en: 'Where does the process start, what triggers it?',
    },
  },
  {
    key: 'q2',
    label: {
      de: 'Welche Schritte macht heute jemand von Hand?',
      en: 'Which steps are done by hand today?',
    },
  },
  {
    key: 'q3',
    label: {
      de: 'Wie häufig und in welchem Volumen (pro Monat)?',
      en: 'How often and at what volume (per month)?',
    },
  },
  {
    key: 'q4',
    label: {
      de: 'Wer ist beteiligt, wer muss freigeben?',
      en: 'Who is involved, who has to approve?',
    },
  },
  {
    key: 'q5',
    label: {
      de: 'Welche Systeme und Datenquellen sind beteiligt (API, Export, manuell)?',
      en: 'Which systems and data sources are involved (API, export, manual)?',
    },
  },
  {
    key: 'q6',
    label: {
      de: 'Welche Ausnahmen und Fehlerfälle gibt es?',
      en: 'Which exceptions and failure cases exist?',
    },
  },
  {
    key: 'q7',
    label: {
      de: 'Woran messen Sie, dass es besser läuft?',
      en: 'How would you measure that it works better?',
    },
  },
];

/**
 * How many questions one cluster asks, and how many steps that phase costs.
 *
 * The step count is the questions plus the idea card that closes the cluster.
 * Both numbers are derived from the catalogue, not written down at the place
 * that walks the phase: a further question must not silently fold two cluster
 * steps onto one slot.
 */
export const DEEP_QUESTIONS_PER_CLUSTER = DEEP_PROMPTS.length;
export const DEEPEN_STEPS_PER_CLUSTER = DEEP_QUESTIONS_PER_CLUSTER + 1;

/** The seven standard questions of one cluster. */
export function clusterSteps(clusterId: string): StepDef[] {
  return DEEP_PROMPTS.map((prompt) => ({
    key: `deep.${clusterId}.${prompt.key}`,
    phase: 'deepen' as const,
    cluster: clusterId,
    fields: [
      {
        key: `deep.${clusterId}.${prompt.key}`,
        kind: 'text' as const,
        required: true,
        maxLength: 4000,
        label: prompt.label,
      },
    ],
  }));
}

/** The idea card after a cluster: the customer marks what is relevant. */
export function clusterIdeasStep(clusterId: string): StepDef {
  return {
    key: `deep.${clusterId}.ideas`,
    phase: 'deepen',
    cluster: clusterId,
    fields: [
      {
        key: `deep.${clusterId}.ideas.relevant`,
        kind: 'multi',
        required: false,
        options: [],
        maxSelections: 3,
        label: {
          de: 'Welche dieser Vorschläge sind für Sie relevant?',
          en: 'Which of these suggestions are relevant for you?',
        },
      },
    ],
  };
}

export function clusterSelectionStep(): StepDef {
  return {
    key: 'clusters.selected',
    phase: 'clusters',
    fields: [
      {
        key: 'clusters.selected',
        kind: 'multi',
        required: true,
        minSelections: 1,
        maxSelections: 5,
        options: CLUSTERS.map((cluster) => ({
          value: cluster.id,
          label: { de: `Thema ${cluster.id}`, en: `Cluster ${cluster.id}` },
        })),
        label: {
          de: 'Welche Themen möchten Sie vertiefen? Wählen Sie bis zu fünf.',
          en: 'Which topics do you want to explore? Choose up to five.',
        },
      },
    ],
  };
}

export const CONFIRM_STEPS: StepDef[] = [
  {
    key: 'confirm.summary',
    phase: 'confirm',
    fields: [
      {
        key: 'confirm.summary.ok',
        kind: 'yesno',
        required: true,
        label: {
          de: 'Ist die Zusammenfassung korrekt?',
          en: 'Is the summary correct?',
        },
      },
      {
        key: 'confirm.summary.correction',
        kind: 'text',
        required: false,
        maxLength: 2000,
        label: {
          de: 'Was möchten Sie korrigieren? (optional)',
          en: 'What should be corrected? (optional)',
        },
      },
    ],
  },
  {
    key: 'confirm.priority',
    phase: 'confirm',
    fields: [
      {
        key: 'confirm.priority',
        kind: 'rank',
        required: false,
        options: [],
        label: {
          de: 'Passt die vorgeschlagene Priorisierung? Bringen Sie die Themen bei Bedarf in Ihre Reihenfolge.',
          en: 'Does the suggested priority fit? Reorder the topics if needed.',
        },
      },
    ],
  },
  {
    key: 'confirm.contact',
    phase: 'confirm',
    fields: [
      {
        key: 'confirm.contact.wanted',
        kind: 'yesno',
        required: true,
        label: { de: 'Möchten Sie ein Erstgespräch?', en: 'Would you like an initial call?' },
      },
      {
        key: 'confirm.contact.way',
        kind: 'text',
        required: false,
        maxLength: 300,
        label: {
          de: 'Wie erreichen wir Sie am besten? (optional)',
          en: 'How can we best reach you? (optional)',
        },
      },
    ],
  },
];

/** Fields whose answer is free text and therefore capped. */
export const MAX_TEXT_LENGTH = 4000;

export function stepFields(step: StepDef): Field[] {
  return step.fields;
}

export function localized(value: Localized, locale: Locale): string {
  return locale === 'en' ? value.en : value.de;
}
