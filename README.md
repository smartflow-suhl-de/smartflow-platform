# SmartFlow Plattform

Interne, mandantenfähige Operations- und Service-Plattform.

- Mandantenverwaltung durch Operatoren, Vorgänge und Automatisierungen je Mandant
- Strikte Mandantentrennung: eigene SQLite-Datenbank je aktivem Mandanten
- Erweiterbarer Plugin-Kernel (Manifest, Migrationen, Events, rollenbasierte Navigation)
- Append-only-Event-Audit, Rollen `operator` / `tenant_admin` / `employee`
- Oberfläche zweisprachig (DE/EN), Zielstandard WCAG AA

## Stack

| Bereich     | Wahl                                                                              |
| ----------- | --------------------------------------------------------------------------------- |
| Runtime     | Node.js 22 LTS (`.nvmrc`), TypeScript 5.9 `strict`                                |
| API         | Fastify 5 unter `/api/v1`, better-sqlite3, OpenAPI unter `/api/openapi.json`      |
| Web         | React 19, Vite 8, TypeScript SPA                                                  |
| Tests       | `node:test` über `tsx`                                                            |
| Lint/Format | ESLint 9 (flat config), typescript-eslint, react-hooks, Prettier                  |
| Pakete      | npm workspaces (`api/`, `web/`), ein Lockfile auf Repo-Ebene                      |
| Container   | Mehrstufiges `Dockerfile` (Node 22 slim, Port 8790), `compose.yaml` mit Tailscale |

## Voraussetzungen

- Node.js `>= 22.18` (empfohlen: 22 LTS, siehe `.nvmrc`) — als Minimum, weil der Plugin-Generator `manifest.ts` direkt importiert und Vite 8 mindestens 22.12 verlangt
- npm 10+
- Docker – nur für den Container-Build

`better-sqlite3` bringt Prebuilds für Node 22 mit; ein zusätzlicher Compiler ist auf den
unterstützten Plattformen nicht nötig.

## Installation

```bash
npm ci
```

Ein `npm ci` an der Wurzel installiert beide Workspaces und erzeugt `node_modules/` an der
Wurzel. Unterordner haben bewusst kein eigenes Lockfile.

## Befehle

Alle Befehle laufen an der Repo-Wurzel.

| Befehl                 | Wirkung                                                                |
| ---------------------- | ---------------------------------------------------------------------- |
| `npm run dev`          | API im Watch-Modus auf `127.0.0.1:8790`                                |
| `npm run dev:web`      | Vite-Dev-Server auf `127.0.0.1:5273`, `/api` wird auf `:8790` geproxyt |
| `npm run build`        | API-Typecheck + Web-Produktionsbuild nach `web/dist/`                  |
| `npm start`            | API ohne Watch-Modus starten                                           |
| `npm test`             | Alle Tests: Kernel-/Plugin-Tests und Web-Tests                         |
| `npm run test:api`     | Nur die Kernel-/Plugin-Tests (`api/test/kernel/`)                      |
| `npm run test:web`     | Nur die Web-Tests (`web/test/`)                                        |
| `npm run typecheck`    | `tsc --noEmit` für API und Web                                         |
| `npm run lint`         | ESLint über das ganze Repo                                             |
| `npm run format`       | Prettier schreibt das ganze Repo                                       |
| `npm run format:check` | Prettier prüft ohne zu schreiben                                       |

Der Plugin-Registry-Generator (`api/scripts/build-plugin-registry.mjs`) läuft vor `dev`,
`start`, `typecheck` und `test` und schreibt `api/src/kernel/plugin-registry.generated.ts`.
Die Datei ist generiert und wird nicht committet.

## Konfiguration

Die API liest ausschließlich `SF_*`-Variablen mit entwicklungsfreundlichen Defaults. Eine
`.env` an der Repo-Wurzel wird automatisch geladen (`--env-file-if-exists`); Vorlage ist
`.env.example`:

| Variable                   | Default                      | Bedeutung                                                                                                                                               |
| -------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SF_HOST`                  | `127.0.0.1`                  | Bind-Adresse der API                                                                                                                                    |
| `SF_PORT`                  | `8790`                       | Port der API                                                                                                                                            |
| `SF_PUBLIC_URL`            | `http://127.0.0.1:5273`      | Öffentliche Origin. In `NODE_ENV=production` **Pflicht** und muss `https://` sein, sonst bricht der Start ab; `https://` schaltet Secure-Cookies scharf |
| `SF_DATA_DIR`              | `./data`                     | Verzeichnis für `platform.sqlite`, Mandanten-DBs und Secret-Key; relativ zum Startverzeichnis (`api/data` bei Start über `npm run dev`/`npm start`)     |
| `SF_WEB_DIR`               | leer                         | Gebautes SPA, das die API unter `/` ausliefert. Leer = reine API; im Container `/app/web/dist`                                                          |
| `SF_SECURE_COOKIES`        | abhängig von `SF_PUBLIC_URL` | `Secure`-Flag am Session-Cookie; in `NODE_ENV=production` darf es nicht `0` sein, sonst bricht der Start ab                                             |
| `SF_LOG_LEVEL`             | `info` (`silent` in Tests)   | Fastify-Log-Level                                                                                                                                       |
| `SF_TRUST_PROXY`           | `0`                          | `X-Forwarded-*` vertrauen                                                                                                                               |
| `SF_BODY_LIMIT`            | `1048576`                    | Max. Request-Body in Bytes                                                                                                                              |
| `SF_RATE_LIMIT_ENABLED`    | `1`                          | Rate-Limit aktiv                                                                                                                                        |
| `SF_RATE_LIMIT_LOGIN`      | `10`                         | Anmeldeversuche pro Minute und Absender; je Adresse das Dreifache pro 15 Minuten                                                                        |
| `SF_AGENT_PROVIDER_BASE`   | `/api/v1/llm`                | API-Pfad des Provider-Plugins, das der Agent für Antworten aufruft                                                                                      |
| `SF_AGENT_MAX_STEPS`       | `4`                          | Modellrunden je Frage (1–8)                                                                                                                             |
| `SF_AGENT_TIMEOUT_MS`      | `30000`                      | Zeitlimit je Provider-Aufruf                                                                                                                            |
| `SF_AGENT_BUDGET_MS`       | `45000`                      | Gesamtbudget je Frage                                                                                                                                   |
| `SF_AGENT_RETENTION_DAYS`  | `90`                         | Aufbewahrung von Agent-Fragen und -Antworten                                                                                                            |
| `SF_AGENT_RATE_PER_MINUTE` | `10`                         | Agent-Fragen je Operator und Minute                                                                                                                     |
| `SF_AGENT_RATE_PER_DAY`    | `200`                        | Agent-Fragen je Operator und Tag                                                                                                                        |

Es gibt keinen Mailversand mehr: die Ersteinrichtung legt den ersten Operator direkt im
Browser an (E-Mail, Name, Passwort), danach meldet man sich mit E-Mail und Passwort an.
Die Passwörter liegen als scrypt-Hash in der Datenbank.

Der Agent (`/agent`, nur Operatoren) beantwortet Fragen aus freigegebenen Datenquellen.
Das Modell liefert ein eigenes Provider-Plugin über eine interne Route; Vertrag, Quellen
und Grenzen stehen in [`docs/agent-plugin.md`](docs/agent-plugin.md).

## Verzeichnisstruktur

```
.
├── api/                     Fastify-API (früher das Wurzel-Paket des Prototyps)
│   ├── scripts/             serve-api.ts, build-plugin-registry.mjs
│   ├── src/
│   │   ├── kernel/          App, Auth, DB, Events, Routen, Konfiguration
│   │   ├── plugins/         Fach-Plugins, je Ordner ein Manifest + Server
│   │   └── shared/          Verträge, Events, Version
│   ├── test/kernel/         Kernel-Tests
│   └── tsconfig.json
├── web/                     React-SPA
│   ├── public/              Fonts, Favicon
│   ├── src/                 Komponenten, Seiten, Lib, Theme, index.css
│   ├── test/                Web-Tests plus Browser-Stub (helpers/browser.ts)
│   ├── tsconfig.test.json   Typecheck der Testdateien
│   ├── index.html
│   └── vite.config.ts
├── .github/workflows/ci.yml CI-Gate
├── templates/astro-site/    Vorlage, aus der jede Website ohne eigenes Repo gebaut wird
├── docs/deployment.md       Betriebsanleitung für den Docker-Betrieb
├── .impeccable/             Designsystem-Artefakte (config.json, design.json)
├── DESIGN.md                Designsystem
├── PRODUCT.md               Produktbeschreibung
├── compose.yaml             App plus Tailscale-Knoten, keine Host-Ports
├── deploy/tailscale/        Image mit Serve-Konfiguration für den Tailnet-Knoten
├── Dockerfile               Mehrstufiger Container-Build, Port 8790
├── .env.example             Konfigurationsvorlage (lokal)
└── .env.production.example  Konfigurationsvorlage (Docker/Compose)
```

Laufzeitdaten (`data/`, `*.sqlite*`), Builds (`dist/`) und `.env` sind nicht versioniert.

## CI-Gate

`.github/workflows/ci.yml` läuft bei Push auf `main` und bei jedem Pull Request auf
`ubuntu-latest` mit Node aus `.nvmrc` und npm-Cache. Die Schritte sind strikt sequenziell
und ohne Toleranz:

1. `npm ci`
2. `npm run lint`
3. `npm run typecheck`
4. `npm test`
5. `npm run build`

Ein roter Schritt blockiert den Merge. Vor dem Push lokal dieselben fünf Befehle ausführen.

## Container

Deployment-Ziel ist Docker: ein Container, in dem die API auch die gebaute SPA ausliefert,
erreichbar über einen eigenen Tailscale-Knoten (nur im Tailnet). Die vollständige Anleitung inklusive Backup, Update und Grenzen steht
in [`docs/deployment.md`](docs/deployment.md).

```bash
cp .env.production.example .env   # SF_TAILNET_DOMAIN setzen
docker compose up -d --build
docker compose ps                 # auf "healthy" warten
```

Danach die Seite öffnen und die Ersteinrichtung ausfüllen (E-Mail, Name, Passwort ab 12
Zeichen). Ohne diesen Schritt gibt es kein Konto, und die Anmeldung antwortet mit 401.

Das Image setzt `NODE_ENV=production`, `SF_HOST=0.0.0.0`, `SF_DATA_DIR=/data` und
`SF_WEB_DIR=/app/web/dist`, läuft als `node`-User und erwartet ein beschreibbares Volume
auf `/data`. `SF_PUBLIC_URL` hat bewusst keinen Default: im Produktivbetrieb muss sie
`https://` sein, sonst bricht der Start ab.

Ein einzelner Container, kein Autoscaling: je Mandant liegt eine eigene SQLite-Datei, und
die verträgt genau einen schreibenden Prozess.

## Arbeitsweise

- Branch-Präfixe: `feat/`, `fix/`, `chore/`, `docs/`
- Merge per Squash, nur nach Review
- Kein Merge oder Deploy ohne ausdrückliche Freigabe

Details in [CONTRIBUTING.md](CONTRIBUTING.md).
