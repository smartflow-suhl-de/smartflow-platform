# Agent-Plugin

Der Agent beantwortet Fragen des Administrators aus **freigegebenen, rein lesenden
Datenquellen**. Er ändert nichts, schreibt nichts in Fachdaten und liest keine fremden
Tabellen. Erreichbar ist er unter `/agent`, nur für die Rolle `operator`.

## Aufbau

| Teil              | Ort                                                                                |
| ----------------- | ---------------------------------------------------------------------------------- |
| Quellen-Registry  | `api/src/kernel/context.ts` (`provideAgentSource`, `agentSources`)                 |
| Kernel-Quellen    | `api/src/kernel/app.ts` (`platform.status`, `platform.plugins`, `platform.events`) |
| Mandanten-Quellen | `api/src/plugins/tenants/server.ts` (`tenants.summary`, `tenants.list`)            |
| Agent             | `api/src/plugins/agent/`                                                           |
| Seite             | `web/src/pages/Agent.tsx`                                                          |

Plugins sehen Quellen nur als Info-Sicht ohne `run` (`ctx.agentSources()`); ausgeführt
wird eine Quelle ausschließlich über `ctx.runAgentSource(id, args)`, und der Kernel prüft
die Argumente vorher gegen das Schema. Jede Quelle muss `readOnly: true` angeben, sonst
bricht die Registrierung ab. Das ist ein Vertrag: `run` liest nur.

Der Agent ruft Quellen **im Prozess** auf. Ein Plugin liest weiterhin nur seine eigenen
Tabellen; der Agent bekommt nur das Ergebnis von `run`.

## Eine Quelle hinzufügen

```ts
ctx.provideAgentSource({
  id: 'tickets.summary', // punktiert, eindeutig
  readOnly: true, // Vertrag: nur lesen
  label: 'Tickets',
  description: 'Offene und geschlossene Tickets, optional je Mandant.',
  args: {
    type: 'object',
    additionalProperties: false,
    properties: { status: { type: 'string', enum: ['open', 'closed'] } },
  },
  href: '/tickets', // wo der Operator die Zahl prüfen kann
  run: async (args) => {
    // nur lesen, kleine Rückgabe, keine Secrets, keine Nutzerdaten
    return { open: 3, closed: 12 };
  },
});
```

Regeln:

- `id` darf nur einmal vorkommen; der Start bricht bei Dopplung ab.
- `args` ist ein enges JSON-Schema (Objekt, `additionalProperties: false`). Unterstützt
  werden `string` (mit `enum`, `maxLength`), `integer`/`number` (mit `minimum`/`maximum`),
  `boolean` und Arrays von Strings. Unbekannte Schlüssel werden abgelehnt.
- Rückgaben werden bei 4 KB gekürzt; die Antwort enthält dann `truncated: true`.
- Keine Schreibfunktionen, keine Sitzungen, keine Magic-Links, keine SMTP- oder
  Schlüsselwerte.

## Provider-Vertrag

Das Modell kommt aus dem Plugin `llm-providers`. Der Agent spricht dessen interne Routen
über `callInternal` an (Header `x-internal-token`, Aufrufer `agent`); der Browser erreicht
sie nicht. Basis ist `SF_AGENT_PROVIDER_BASE` (Default `/api/v1/llm`, erlaubt nur
`/api/v1/<plugin>` mit Kleinbuchstaben, Ziffern und `-`).

Voraussetzung im Provider: Zweck **`agent`** ist einem Modell mit Tool-Calling zugeordnet,
und der Provider erlaubt den Aufrufer `agent` (`allowed_plugins`, sonst
`llm_caller_not_allowed`). Der Agent gilt nur dann als konfiguriert, wenn genau dieser
Zweck ein Modell hat — ein anderer konfigurierter Zweck genügt nicht.

### `GET {base}/internal/status`

Der Agent liest den Eintrag mit `purpose: "agent"` aus `purposes[]`:

```json
{
  "configured": true,
  "providers": 1,
  "purposes": [{ "purpose": "agent", "configured": true, "model": { "modelKey": "…" } }]
}
```

Ohne Modell oder bei nicht erreichbarem Provider zeigt die Seite `configured: false`.

### `POST {base}/internal/complete`

Der Agent sendet die Form der Provider-Route (Adapter: `plugins/agent/provider.ts`):

```json
{
  "purpose": "agent",
  "messages": [
    { "role": "system", "content": "…" },
    { "role": "user", "content": "…" },
    {
      "role": "assistant",
      "content": "",
      "tool_calls": [
        {
          "id": "c1",
          "type": "function",
          "function": { "name": "tenants__summary", "arguments": "{}" }
        }
      ]
    },
    { "role": "tool", "content": "{\"total\":3}", "tool_call_id": "c1" }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "tenants__summary",
        "description": "…",
        "parameters": { "type": "object" }
      }
    }
  ],
  "maxTokens": 800,
  "timeoutMs": 30000
}
```

Antwort (gelesen werden `message` und `model.modelKey`):

```json
{
  "message": { "role": "assistant", "content": "…", "toolCalls": [] },
  "model": { "modelKey": "…" }
}
```

Werkzeugnamen sind Quell-IDs mit `__` statt Sonderzeichen (`tenants.summary` →
`tenants__summary`).

Fehler: gemeinsame Form `{ "error": { "code", "message" } }` mit 4xx/5xx. Der Agent macht
daraus `502 agent_provider_failed`; ein Zeitlimit `504 agent_provider_timeout`.

## Konfiguration

| Variable                   | Default       | Bedeutung                             |
| -------------------------- | ------------- | ------------------------------------- |
| `SF_AGENT_PROVIDER_BASE`   | `/api/v1/llm` | API-Pfad des Provider-Plugins         |
| `SF_AGENT_MAX_STEPS`       | `4`           | Modellrunden je Frage (1–8)           |
| `SF_AGENT_TIMEOUT_MS`      | `30000`       | Zeitlimit je Provider-Aufruf          |
| `SF_AGENT_BUDGET_MS`       | `45000`       | Gesamtbudget je Frage                 |
| `SF_AGENT_RETENTION_DAYS`  | `90`          | Aufbewahrung von Fragen und Antworten |
| `SF_AGENT_RATE_PER_MINUTE` | `10`          | Fragen je Operator und Minute         |
| `SF_AGENT_RATE_PER_DAY`    | `200`         | Fragen je Operator und Tag            |

Kein Schlüssel liegt im Agenten: Endpunkt, Modell und Credential gehören dem Provider.

## Speicherung

Plattform-DB, plugin-eigene Tabellen:

- `agent_runs`: Frage, Antwort, Status, Fehlercode, Modell, Dauer, Zeitpunkte. Fragen und
  Antworten sind Klartext und können Personenbezug enthalten; sie werden nach
  `SF_AGENT_RETENTION_DAYS` gelöscht.
- `agent_steps`: je Quellenaufruf Nummer, Quelle, Argumente, Status, Dauer, Größe,
  Kürzung, Fehlercode.

Ein Lauf wird beim Start als `error`/`agent_incomplete` angelegt und erst bei einer Antwort
auf `ok` gesetzt — ein abgebrochener Prozess hinterlässt keinen scheinbar guten Lauf. Ein
täglicher Lauf löscht Einträge älter als `SF_AGENT_RETENTION_DAYS`.

## Grenzen und Sicherheit

- Frage und Antwort werden gespeichert, aber **nicht** protokolliert; Logs enthalten nur
  Lauf-ID, Quelle, Dauer und Status.
- Quelltexte sind Daten, keine Anweisungen; der Systemprompt sagt das ausdrücklich.
- Werkzeuge sind fest, Argumente schema-geprüft, Aufrufe auf 8 je Frage begrenzt.
- Antworten sind Text; die Oberfläche rendert kein HTML aus dem Modell.
- Quellen-Chips und Links stammen aus der Registry, nicht aus dem Modell.
