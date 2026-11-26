# Contributing

## Branches

- Präfixe: `feat/`, `fix/`, `chore/`, `docs/`
- Ein Issue, ein Branch, ein Worktree. Keine zwei Arbeiten auf demselben Branch.
- `main` ist geschützt: kein direkter Commit, kein Force-Push.

Beispiel: `feat/issue-12-tenant-export`

## Commits

Konventionelle Commit-Messages: `feat:`, `fix:`, `chore:`, `build:`, `ci:`, `docs:`,
`refactor:`, `test:`.

Trailer setzen:

```
Co-authored-by: OpenBot <335604065+openbotgit[bot]@users.noreply.github.com>
```

## Vor dem Push

Das CI-Gate läuft genau diese Befehle. Lokal dieselben, ungepipet und mit echtem Exit-Code:

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

Zusätzlich, wenn Dokumentation oder Formatierung angefasst wurde:

```bash
npm run format:check
```

Nichts durch `tail`, `head` oder `|| true` schleusen: ein geschluckter Exit-Code ist ein
grüner Test, der nichts geprüft hat.

## Pull Requests

- Kleiner, thematischer Diff. Formatierungs-, Umbenennungs- und Funktionsänderungen nicht
  im selben PR mischen.
- Merge per Squash. Der PR-Titel wird die Commit-Message auf `main`, also konventionell
  formulieren.
- Review ist Pflicht. Unser Code-Review und Security-Review sind das Gate; Kommentare statt
  Approval/Request-Changes.
- Kein Merge, Deploy oder Publish ohne ausdrückliche Freigabe.

## Code-Regeln

- TypeScript `strict`; neue Dateien ohne `any`. `@typescript-eslint/no-explicit-any` ist als
  Warnung konfiguriert, nicht als Freibrief.
- Die Mandantengrenze läuft über `tenantDb(tenantId)` im Kernel. Plugins öffnen niemals selbst
  eine Mandanten-DB und prüfen den Status nicht selbst.
- Neue Plugins liegen unter `api/src/plugins/<id>/` mit `manifest.ts` und `server.ts`. Der
  Registry-Generator validiert IDs, Navigationspfade und Abhängigkeiten; die generierte Datei
  wird nicht committet.
- API-Fehler nutzen die gemeinsame Form `{ error: { code, message, fields? } }`.
- Kommentare nur für nicht offensichtliche Invarianten, nie als Erzählung des Codes.

## Tests

- `npm test` führt `api/test/**/*.test.ts` über `node:test` und `tsx` aus.
- Jeder Test bekommt über `createTestApp()` ein eigenes temporäres Datenverzeichnis; nichts
  schreibt in `data/`.
- Tests nicht löschen oder abschwächen, um einen roten Lauf grün zu bekommen.

## Sicherheit

- Keine Secrets committen. Konfiguration ausschließlich über `SF_*`-Umgebungsvariablen,
  Vorlage ist `.env.example`.
- `.env`, `data/` und `*.sqlite*` bleiben lokal.
