# SmartFlow Plattform

Interne, mandantenfähige Operations- und Service-Plattform.

- Mandantenverwaltung durch Operatoren, Vorgänge und Automatisierungen je Mandant
- Strikte Mandantentrennung: eigene SQLite-Datenbank je aktivem Mandanten
- Erweiterbarer Plugin-Kernel (Manifest, Migrationen, Events, rollenbasierte Navigation)
- Append-only-Event-Audit, Rollen `operator` / `tenant_admin` / `employee`
- Oberfläche zweisprachig (DE/EN), Zielstandard WCAG AA

## Arbeitsweise

- Branch-Präfixe: `feat/`, `fix/`, `chore/`, `docs/`
- Merge per Squash, nur nach Review
- Kein Merge oder Deploy ohne ausdrückliche Freigabe

Die technische Basis (Stack, Befehle, CI) wird mit Issue #1 festgelegt.
