# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Operatoren (`operator`):** Verwalten Mandantenplattform-übergreifend Kundenmandanten (Erstellen, Provisionieren, Sperren, Reaktivieren) und überwachen den Betrieb.
- **Mandanten-Administratoren (`tenant_admin`) & Mitarbeitende (`employee`):** Nutzen und steuern Vorgänge sowie Automatisierungen innerhalb ihres jeweiligen Mandantenbereichs (konkrete Fach-Workflows werden über Plugins ergänzt).

## Product Purpose

SmartFlow Plattform ist eine interne Operations- und Service-Plattform zur Steuerung von Kundenmandanten, Vorgängen und Automatisierungen durch Operatoren und Teams. Erfolg bedeutet verlässliche Mandantentrennung, nachvollziehbare Status- und Audit-Ereignisse sowie erweiterbare Fachmodule über das Kernel-Plugin-System.

## Positioning

Mandantenfähiger Plattform-Kernel mit strikter Datenisolation pro Mandant (`tenantDb` mit eigener SQLite-Datenbank je aktivem Mandanten), topologisch aufgelöstem Plugin-System (`work`- und `management`-Navigationsgruppen) und integriertem Append-only-Event-Audit-Bus (`events`-Tabelle), statt alles in einer gemeinsam genutzten Mandanten-DB zu mischen.

## Operating Context

- **Backend-API (`api/`):** Node.js (`>=22.18`), TypeScript, Fastify 5 unter `/api/v1` (OpenAPI unter `/api/openapi.json`), zentrale SQLite-DB (`platform.sqlite`) plus isolierte Tenant-SQLite-DBs, passwortloser Magic-Link-Login mit `sf_session`-Cookie und `x-internal-token` für In-Process-Plugin-Aufrufe.
- **Web-Frontend (`web/`):** React 19 + Vite 8 + TypeScript SPA (Dev-Server auf `127.0.0.1:5273` mit `/api`-Proxy auf `127.0.0.1:8790`).
- **Deployment:** Container-Build über `Dockerfile` (Node 22 slim, Port `8790`).

## Capabilities and Constraints

- **Vorhandene Funktionen:** Mandanten-Plugin (`tenants`: Liste mit Cursor-Pagination/Suche, Zähler-Statistiken, Erstellen inkl. Tenant-DB-Provisionierung, Detailabruf, idempotentes Sperren/Entsperren), Rollenmodell (`operator`, `tenant_admin`, `employee`), rollengefiltertes `/api/v1/nav`-Menü, Magic-Link-Auth (`/api/v1/auth/*`), Health-Endpunkt (`/api/v1/health`).
- **Technische & sprachliche Leitplanken:** Mehrsprachige Oberfläche (`DE`/`EN`) vorsehen; API-Fehlercodes und -Fehlermeldungen im Backend sind aktuell englisch (`ErrorBody`, `FieldError`), während einzelne Kernel-Meldungen deutsch sind — UI-Texte sauber i18n-fähig halten.
- **Strikte Mandantengrenze:** Zugriff auf `tenantDb(tenantId)` wird bei nicht existierenden (`404`) oder gesperrten (`403 tenant_suspended`) Mandanten zentral im Kernel blockiert.
- **Noch offen:** Konkrete Fach-Plugins über `tenants` hinaus, Authentifizierungs-UI-Flows für Endnutzer im Frontend sowie produktive Mail-Zustellung für Magic-Links.

## Brand Commitments

- **Name & Betreiber:** SmartFlow Plattform; Betreiber: SmartFlow. Personenbezogene Betreiberangaben stehen nicht im Repository.
- **Logo:** `SF`-Signet im abgerundeten Quadrat (3 px Radius, `ink`-Fläche mit `paper`-Schrift in Bricolage Grotesque Bold) neben zweizeiliger Wortmarke (`SMARTFLOW` in Martian Mono 12 px Versalien, `ink-muted` / `Plattform` in Bricolage Grotesque SemiBold, `ink`). Favicon in `web/public/favicon.svg` führt dasselbe `SF`-Signet.
- **Ton:** Ruhig, präzise, ohne Marketingfloskeln; die Oberfläche ist ein Arbeitsinstrument („Das Instrument“), kein Schaufenster.
- **Verbindliches Designsystem:** Übernommen aus `smartflow-suhl-de/smartflow-platform-old` (`DESIGN.md` und `.impeccable/design.json`): Papier/Tinte/Kobalt/Signal im Hell- und Dunkelmodus, Schriften Bricolage Grotesque / Schibsted Grotesk / Martian Mono, 1-px-Haarlinien, kleine Radien (2–5 px), flache Flächen ohne Kartenschatten.

## Evidence on Hand

- Verifizierter Kernel- und Plugin-Code in `src/kernel/`, `src/plugins/tenants/` und `src/shared/contract.ts` mit 27 Tests in `test/kernel/`.
- Übernommenes Designsystem aus `smartflow-suhl-de/smartflow-platform-old`: `DESIGN.md`, `.impeccable/design.json`, `.impeccable/config.json`, self-hosted Fonts (`web/public/fonts/`), `SF`-Favicon (`web/public/favicon.svg`), CSS-Design-Tokens (`web/src/index.css`) und Hell-/Dunkelmodus-Helfer (`web/src/theme.ts`).
- `web/src/App.tsx` rendert Login, Übersicht, Mandanten, Einstellungen und Hilfe hinter dem App-Shell; Kundenreferenzen, Kennzahlen und Preisangaben existieren nicht (nicht erfinden).

## Product Principles

1. **Mandantentrennung vor Bequemlichkeit:** Mandantendaten gehören strikt in die jeweilige Tenant-DB und dürfen niemals über Mandantengrenzen lecken.
2. **Erweiterbarkeit über den Plugin-Vertrag:** Neue Fachbereiche registrieren sich als Plugin mit Manifest, Migrationen, Events und rollenbasierter Navigation.
3. **Nachvollziehbarkeit im Betrieb:** Zustandswechsel (z. B. `tenant.created`, `tenant.suspended`, `tenant.resumed`) und Fehlerfälle werden strukturiert und prüfbar protokolliert.

## Accessibility & Inclusion

- Zielstandard **WCAG AA** für das gesamte Web-Frontend (`DE`/`EN`).
- Vollständige Tastaturbedienbarkeit, klare Fokusführung, ausreichende Kontraste in Hell- und Dunkelmodus, respektierte `prefers-reduced-motion`-Einstellung und semantische Struktur für operative Arbeitsabläufe.
