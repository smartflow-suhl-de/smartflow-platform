# SmartFlow Plattform

Interne, mandantenfähige Operations- und Service-Plattform.

- Mandantenverwaltung durch Operatoren, Vorgänge und Automatisierungen je Mandant
- Strikte Mandantentrennung: eigene SQLite-Datenbank je aktivem Mandanten
- Erweiterbarer Plugin-Kernel (Manifest, Migrationen, Events, rollenbasierte Navigation)
- Append-only-Event-Audit, Rollen `operator` / `tenant_admin` / `employee`
- Oberfläche zweisprachig (DE/EN), Zielstandard WCAG AA

## Stack

| Bereich     | Wahl                                                                         |
| ----------- | ---------------------------------------------------------------------------- |
| Runtime     | Node.js 22 LTS (`.nvmrc`), TypeScript 5.9 `strict`                           |
| API         | Fastify 5 unter `/api/v1`, better-sqlite3, OpenAPI unter `/api/openapi.json` |
| Web         | React 19, Vite 8, TypeScript SPA                                             |
| Tests       | `node:test` über `tsx`                                                       |
| Lint/Format | ESLint 9 (flat config), typescript-eslint, react-hooks, Prettier             |
| Pakete      | npm workspaces (`api/`, `web/`), ein Lockfile auf Repo-Ebene                 |
| Container   | `Dockerfile` (Node 22 slim, Port 8790)                                       |

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
| `npm test`             | Alle Tests: 27 Kernel-/Plugin-Tests plus 87 Web-Tests                  |
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

| Variable                   | Default                      | Bedeutung                                                                                                                                           |
| -------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SF_HOST`                  | `127.0.0.1`                  | Bind-Adresse der API                                                                                                                                |
| `SF_PORT`                  | `8790`                       | Port der API                                                                                                                                        |
| `SF_PUBLIC_URL`            | `http://127.0.0.1:5273`      | Öffentliche Origin; `https://` schaltet Secure-Cookies scharf                                                                                       |
| `SF_DATA_DIR`              | `./data`                     | Verzeichnis für `platform.sqlite`, Mandanten-DBs und Secret-Key; relativ zum Startverzeichnis (`api/data` bei Start über `npm run dev`/`npm start`) |
| `SF_OPERATOR_EMAIL`        | `operator@smartflow.local`   | Erster Operator-Account                                                                                                                             |
| `SF_OPERATOR_NAME`         | `Operator`                   | Anzeigename des Operators                                                                                                                           |
| `SF_DEV_MAGIC_LINK`        | `1` (außer Production)       | Magic-Link im Response zurückgeben statt zu mailen                                                                                                  |
| `SF_DEV_AUTO_LOGIN`        | `0`                          | Login-Seite konsumiert den Link selbst; nur mit `SF_DEV_MAGIC_LINK` und ohne `https://`                                                             |
| `SF_SECURE_COOKIES`        | abhängig von `SF_PUBLIC_URL` | `Secure`-Flag am Session-Cookie                                                                                                                     |
| `SF_LOG_LEVEL`             | `info` (`silent` in Tests)   | Fastify-Log-Level                                                                                                                                   |
| `SF_TRUST_PROXY`           | `0`                          | `X-Forwarded-*` vertrauen                                                                                                                           |
| `SF_BODY_LIMIT`            | `1048576`                    | Max. Request-Body in Bytes                                                                                                                          |
| `SF_RATE_LIMIT_ENABLED`    | `1`                          | Rate-Limit aktiv                                                                                                                                    |
| `SF_RATE_LIMIT_MAGIC_LINK` | `10`                         | Magic-Link-Anfragen pro Fenster                                                                                                                     |

Es gibt keinen produktiven Mail-Transport: Magic-Links werden im Dev-Modus im Response
ausgeliefert.

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
├── .impeccable/             Designsystem-Artefakte (config.json, design.json)
├── DESIGN.md                Designsystem
├── PRODUCT.md               Produktbeschreibung
├── Dockerfile               Container-Build, Port 8790
└── .env.example             Konfigurationsvorlage
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

```bash
docker build -t smartflow-platform:issue-1 .
docker run --rm -p 8790:8790 smartflow-platform:issue-1
```

Das Image setzt `SF_HOST=0.0.0.0` und `SF_DATA_DIR=/data`, läuft als `node`-User und
erwartet ein beschreibbares Volume auf `/data`. Ein Registry- oder Deployment-Ziel ist noch
nicht festgelegt.

## Arbeitsweise

- Branch-Präfixe: `feat/`, `fix/`, `chore/`, `docs/`
- Merge per Squash, nur nach Review
- Kein Merge oder Deploy ohne ausdrückliche Freigabe

Details in [CONTRIBUTING.md](CONTRIBUTING.md).
