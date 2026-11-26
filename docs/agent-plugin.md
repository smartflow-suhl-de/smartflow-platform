# Agent-Plugin

Der Agent beantwortet Fragen des Administrators aus **freigegebenen, rein lesenden
Datenquellen**. Er ändert nichts, schreibt nichts in Fachdaten und liest keine fremden
Tabellen. Erreichbar ist er unter `/agent`, nur für die Rolle `operator`.

## Aufbau

| Teil              | Ort                                                                     |
| ----------------- | ----------------------------------------------------------------------- |
| Quellen-Registry  | `api/src/kernel/context.ts` (`provideAgentSource`, `agentSources`)      |
| Kernel-Quellen    | `api/src/kernel/app.ts` (`platform.status`, `platform.events`)          |
| Mandanten-Quellen | `api/src/plugins/tenants/server.ts` (`tenants.summary`, `tenants.list`) |
| Agent             | `api/src/plugins/agent/`                                                |
| Seite             | `web/src/pages/Agent.tsx`                                               |

Der Agent ruft Quellen **im Prozess** auf. Ein Plugin liest weiterhin nur seine eigenen
Tabellen; der Agent bekommt nur das Ergebnis von `run`.

## Eine Quelle hinzufügen

```ts
ctx.provideAgentSource({
  id: 'tickets.summary', // punktiert, eindeutig
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

Das Modell kommt aus einem eigenen Plugin. Der Agent spricht es über einen internen
Aufruf an (`callInternal`, Header `x-internal-token`); der Browser erreicht diese Routen
nicht. Basis ist `SF_AGENT_PROVIDER_BASE` (Default `/api/v1/llm`).

### `GET {base}/status`

```json
{ "configured": true, "model": "…" }
```

`configured: false` heißt: kein Modell hinterlegt. Die Seite zeigt das statt einer Antwort.
Ein nicht erreichbarer Provider gilt ebenfalls als nicht konfiguriert.

### `POST {base}/complete`

```json
{
  "messages": [
    { "role": "system", "content": "…" },
    { "role": "user", "content": "…" },
    {
      "role": "assistant",
      "content": "",
      "toolCalls": [{ "id": "c1", "name": "tenants__summary", "arguments": "{}" }]
    },
    { "role": "tool", "content": "{\"total\":3}", "toolCallId": "c1" }
  ],
  "tools": [{ "name": "tenants__summary", "description": "…", "parameters": { "type": "object" } }],
  "maxOutputTokens": 800
}
```

Antwort:

```json
{
  "content": "Es sind drei Mandanten aktiv.",
  "toolCalls": [],
  "model": "…",
  "usage": { "inputTokens": 0, "outputTokens": 0 }
}
```

`usage` ist optional. Werkzeugnamen sind Quell-IDs mit `__` statt Sonderzeichen
(`tenants.summary` → `tenants__summary`). Der Provider muss Tool-Calling unterstützen.

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

- `agent_runs`: Frage, Antwort, Status, Fehlercode, Modell, Dauer, Zeitpunkte.
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
