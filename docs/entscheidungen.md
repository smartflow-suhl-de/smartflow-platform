# Entscheidungen & Arbeitskonventionen

Kurzlog. Neueste Einträge unten. Jeder Eintrag: Datum, Entscheidung, Grund, Alternative.

## Statuskonvention (`smartflow_tasks`)

| Status        | Bedeutung                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------- |
| `todo`        | Formuliert, Akzeptanzkriterien und Evidenzpflicht stehen, nicht begonnen.                    |
| `in_progress` | In Arbeit. Maximal **eine** Aufgabe pro Owner gleichzeitig (Lead, Dev, Security).            |
| `review`      | Ergebnis und Evidenz liegen vor, Abnahme offen. Nur Lead setzt auf `done`.                   |
| `done`        | Alle Akzeptanzkriterien erfüllt, Evidenz vorhanden, abgenommen.                              |
| `blocked`     | Kommt ohne User-Entscheidung oder fremde Vorleistung nicht weiter; Blocker steht in `notes`. |

Regeln:

- Owner ist immer `Lead`, `Dev` oder `Security`. Keine anderen Werte.
- Eine Aufgabe pro Nachricht an Dev/Security, mit Kontext, Akzeptanzkriterien, erlaubten Pfaden und Verboten.
- Security prüft nie die eigene Arbeit, Dev nie die eigene Sicherheitsfreigabe.
- Statuswechsel nur in der Tabelle, nicht nur im Chat.

## Definition of Done

Eine Aufgabe ist `done`, wenn **alle** Punkte erfüllt sind:

1. Jedes Akzeptanzkriterium ist prüfbar erfüllt (nicht „angefangen", nicht „sollte gehen").
2. Evidenz liegt vor: **Befehl + Ergebnis** (Test-/Build-Ausgabe, HTTP-Status, Screenshot, Logzeile) in `notes` oder als Datei unter `reports/`.
3. Nur erlaubte Pfade geändert; `git diff` gegen die Baseline zeigt nichts anderes. (Bis SF-002: Dateiliste der Änderung in `notes`.)
4. `npm test` und `npm run typecheck` grün; neue Logik hat einen Test, der ohne den Fix fehlschlägt.
5. Keine Dev-Flags, Testkonten oder Secrets im Produktionspfad; `.env.example` und `PRODUCT.md` sind bei Verhaltens-/Env-Änderungen nachgezogen.
6. Bei Sicherheitsbezug: unabhängige Nachprüfung durch Security mit eigenem Reproduktionsversuch (Angriff schlägt fehl).
7. Abnahme durch Lead; bei Deploy, Löschen, Mailversand oder Zahlungen zusätzlich ausdrückliche User-Freigabe.

## Entscheidungen

### 2026-11-26 · D1 · Bestehende Zeilen migriert

Entscheidung: Owner `Coder` → `Dev`; Status `completed` → `done`. Inhalte der `notes` unverändert, `updated_at` bleibt der historische Abschlusszeitpunkt.
Grund: Owner- und Statuswerte sind ab jetzt geschlossen; die Historie bleibt lesbar.
Alternative: Zeilen löschen und neu anlegen — verworfen, weil Evidenz verloren ginge.

### 2026-11-26 · D2 · Statuskonvention und DoD oben sind verbindlich

Grund: Ohne Evidenzpflicht ist `done` nicht überprüfbar und Abnahme wird zur Behauptung.
Alternative: Freitext-Status — verworfen, nicht auswertbar.

### 2026-11-26 · D3 · Reihenfolge: Blocker → Sicherheit → Robustheit → Produkt

Entscheidung: Git-Repo, dann H1, Container, M1, M4, dann H2/M2/M3/N*, dann Mail-Zustellung und Produktumfang, zuletzt Qualität/Kapazität.
Grund: Ohne Repo gibt es keine Baseline, keinen Diff und keine CI, also auch keine belastbare Abnahme; H1 ist ein Login-Takeover, der Container ist der Auslieferungsweg.
Alternative: Features zuerst — verworfen, jedes weitere Feature vergrößert die unsichere Fläche.

### 2026-11-26 · D4 · Kein Git-Init ohne User (durch D7 abgelöst)

Entscheidung: Repo-Anlage ist als Aufgabe formuliert (SF-002), aber `blocked` bis der User freigibt; Lead initialisiert nicht selbst.
Grund: Neue Versionierungshoheit im shared-Verzeichnis ist eine Strukturentscheidung des Users; parallele Schreibaufträge bleiben bis dahin gesperrt.
Alternative: Lead legt Repo an — verworfen, widerspricht der Rollengrenze.

### 2026-11-26 · D5 · Mail-Zustellung ist Produktentscheidung, kein Bugfix

Entscheidung: Erst Anbieter/Weg entscheiden (SMTP-Relay, API-Dienst, interner Versand), dann implementieren (SF-016 `blocked`, durch D8 gelöst).
Grund: Betrieb, Kosten, Datenschutz und Absenderdomain sind User-Entscheidungen; die Implementierung hängt davon ab.
Alternative: Sofort SMTP hart kodieren — verworfen, würde eine Infrastrukturwahl vorwegnehmen.

### 2026-11-26 · D6 · Ein Fix-Ticket pro Sicherheitsbefund

Entscheidung: H1, H2, M1–M4, N1–N7 werden einzeln geführt; eine gemeinsame Security-Nachprüfung (SF-007 für die P1-Fixes, je Befund eigener Nachweis).
Grund: Befunde haben unterschiedliche Risiken und Abhängigkeiten; Sammeltickets verdecken, was noch offen ist.
Alternative: Ein „Security-Fixes"-Ticket — verworfen, nicht abnehmbar.

### 2026-11-26 · D7 · Git-Repo wird angelegt

Entscheidung: Der User hat der Repo-Anlage ausdrücklich zugestimmt. SF-001 `done`, SF-002 an Dev beauftragt (git init, Baseline-Commit, kein Remote, kein Push, kein Force). Lead initialisiert weiterhin nicht selbst.
Grund: Ohne Baseline gibt es keinen Diff, keine CI und keine belastbare Abnahme; parallele Dev-Schreibaufträge bleiben ohne Repo gesperrt.
Alternative: Weiter ohne Versionierung — verworfen, blockiert jede weitere Abnahme.

### 2026-11-26 · D8 · Mailweg: SMTP-Relay

Entscheidung: Der User hat SMTP-Relay gewählt. SF-015 `done`. SF-016 bleibt `blocked`, jetzt nur wegen fehlender Zugangsdaten (Host, Port, TLS-Modus, Benutzer, Passwort, Absenderadresse, Absendername).
Grund: Der Weg ist entschieden, die Zugangsdaten gehören nicht in Chat oder Tabelle; sie werden über die sichere Schlüssel-Anforderung geholt, wenn Dev an SF-016 geht.
Alternative: API-Dienst oder eigener MX — vom User verworfen.

### 2026-11-26 · D9 · Backlog nach Datenverlust neu aufgebaut

Entscheidung: `smartflow_tasks` war beim Zugriff nicht mehr vorhanden (leere Tabellenliste). Die 21 Aufgaben SF-001 bis SF-021 wurden aus Sicherheitsreview, PRODUCT.md und den Entscheidungen neu angelegt; die drei ursprünglichen Legacy-Zeilen (Owner `Coder`) sind nicht rekonstruierbar und fehlen. Inhalte der alten Zeilen sind nicht erfunden worden.
Grund: Ohne Tabelle gibt es keine Arbeitsliste; Neuanlage ist dem Arbeiten auf Vermutungen vorzuziehen.
Alternative: Legacy-Inhalte aus dem Gedächtnis nachbauen — verworfen, wäre Erfindung.

### 2026-11-26 · D10 · Reihenfolge ab Freigabe

Entscheidung: Genau eine Dev-Aufgabe gleichzeitig: SF-002 → SF-003 → SF-004 → SF-005 → SF-006; danach SF-007 an Security. SF-016 erst nach Vorliegen der SMTP-Zugangsdaten.
Grund: Ohne Baseline ist kein Fix abnehmbar; nach der Baseline zuerst der Login-Takeover, dann der Auslieferungsweg.
Alternative: Fixes parallel — verworfen, solange kein Repo und kein Diff existiert.

### 2026-11-26 · D13 · Anmeldung: Ersteinrichtung und Passwort statt Magic-Link, Operator-Seed und SMTP (durch den User angeordnet)

Entscheidung: `SF_OPERATOR_EMAIL`/`SF_OPERATOR_NAME` erzeugen kein Konto mehr; es gibt keinen Mailversand und keinen Magic-Link. `GET /api/v1/auth/setup` meldet den Bedarf, `POST /api/v1/auth/setup` legt einmalig den ersten Operator an (E-Mail, Name, Passwort ab 12 Zeichen) und öffnet dessen Session. Danach meldet man sich über `POST /api/v1/auth/login` mit E-Mail und Passwort an. Passwörter liegen als scrypt-Hash (`scrypt$N$r$p$salt$hash`, N=2^16, r=8, p=1) in `users.password_hash` (Migration 2). Die Tabelle `magic_links` bleibt ungenutzt stehen, weil Migration 1 unveränderlich ist; es werden keine Zeilen gelöscht.
Grund: Die Anmeldung muss ohne Mail-Transport und ohne vorab gesetzte Konto-Variablen funktionieren; ein Seed-Konto ohne Passwort war ohne die Links ohnehin nicht erreichbar.
Alternative: SMTP-Transport nachrüsten — verworfen, die Zugangsdaten fehlen und der User hat den Weg ersetzt. Setup-Token aus der Umgebung — verworfen, ein weiteres Geheimnis vor dem ersten Start.
Grenze: Solange kein Konto ein Passwort hat, ist die Ersteinrichtung für jeden erreichbaren Client offen (Rate-Limit, einmalig, danach `409 setup_complete`). Passwort ändern oder zurücksetzen ist nicht Teil dieser Änderung.
