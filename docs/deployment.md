# Deployment mit Docker

Die Plattform läuft als ein Container hinter Caddy: die API liefert die SPA unter `/`
selbst aus, deshalb gibt es nur einen Origin und kein CORS. Ein Host, ein Prozess —
mehr dazu unter [Grenzen](#grenzen).

## Voraussetzungen

- Docker mit Compose v2 (`docker compose version`)
- Ein Host, auf dem Port `80` und `443` frei sind
- Eine Domain, die auf den Host zeigt — für automatisches HTTPS. Das Caddyfile liegt
  unter `deploy/caddy/Caddyfile` und wird in ein eigenes Image gebacken: eine Änderung
  daran braucht `docker compose up -d --build caddy`. Ohne öffentliche
  Domain: `tls internal` in `deploy/caddy/Caddyfile` aktivieren (siehe Kommentar dort); Caddy
  stellt dann ein Zertifikat aus der eigenen CA aus, die Clients müssen deren
  Wurzelzertifikat einmalig importieren.

## Erststart

```bash
git clone <repository> smartflow-platform
cd smartflow-platform
cp .env.production.example .env
$EDITOR .env                      # SF_DOMAIN, SF_OPERATOR_EMAIL und SF_SMTP_HOST setzen
docker compose up -d --build
docker compose ps                 # STATUS muss "healthy" enthalten
```

`SF_DOMAIN`, `SF_OPERATOR_EMAIL` und `SF_SMTP_HOST` sind Pflicht: fehlen sie, bricht Compose
ab, bevor ein Container startet. `SF_PUBLIC_URL` wird in `compose.yaml` aus `SF_DOMAIN`
zusammengesetzt und deshalb nicht in `.env` gesetzt — die beiden Werte können so nicht
auseinanderlaufen. Warum der Mailversand Pflicht ist, steht unter
[Mailversand (SMTP)](#mailversand-smtp).

Das Image setzt bewusst **keinen** Default für `SF_PUBLIC_URL`: die Anwendung verlangt im
Produktivbetrieb eine `https://`-Origin und startet sonst nicht. Genau das soll beim Start
auffallen und nicht erst, wenn ein Einladungslink auf die falsche Adresse zeigt.

Daten liegen im benannten Volume `smartflow_data` (Pfad: `docker volume inspect
smartflow_data`), nicht im Image. Ein `docker compose down` ohne `-v` behält sie.

### Ohne öffentliche Domain ausprobieren

```bash
printf 'SF_DOMAIN=localhost\nSF_OPERATOR_EMAIL=ops@example.com\nSF_SMTP_HOST=<host-oder-ip-des-relays>\nSF_SMTP_PORT=587\n' > .env
# in deploy/caddy/Caddyfile zusätzlich "tls internal" in den Site-Block schreiben
docker compose up -d --build       # baut auch das Caddy-Image neu
curl -k https://localhost/api/v1/health
```

Selbstsignierte Zertifikate lassen `curl` ohne `-k` scheitern; das ist erwartet und kein
Fehler der Anwendung. Ein Testpostfach ohne TLS (Mailpit) läuft nur im Entwicklungsmodus,
weil `SF_SMTP_ALLOW_PLAINTEXT` in Produktion verboten ist — siehe
[Mailversand (SMTP)](#mailversand-smtp).

## Mailversand (SMTP)

Ohne Mailversand ist die Anmeldung im Container unmöglich: die Plattform verschickt den
Anmeldelink ausschließlich per E-Mail, im Produktivbetrieb gibt sie ihn nie in der Antwort
zurück. Deshalb ist `SF_SMTP_HOST` im Produktivbetrieb **Pflicht** — fehlt er, bricht der
Start mit einer klaren Meldung ab, statt einen Container hochzufahren, der niemanden
hineinlässt.

```bash
SF_SMTP_HOST=smtp.example.com      # Relay des Providers
SF_SMTP_PORT=587                   # Empfehlung: Submission mit STARTTLS
SF_SMTP_USER=smartflow
SF_SMTP_PASS_FILE=/run/secrets/smtp_pass   # Datei hat Vorrang vor SF_SMTP_PASS
SF_SMTP_FROM=noreply@example.com        # leer = SF_OPERATOR_EMAIL
SF_SMTP_REPLY_TO=                  # optional
```

- **Port 587, nicht 25.** Port 587 ist Submission mit STARTTLS und bei praktisch jedem
  Anbieter offen. Port 25 ist bei Cloud-Anbietern (Hetzner, AWS, GCP, Azure, viele VPS)
  ausgehend gesperrt; ein Versand darüber scheitert ohne verwertbare Fehlermeldung.
- **STARTTLS ist Pflicht.** Ohne implizites TLS (`SF_SMTP_SECURE` nicht gesetzt) verlangt
  der Versand eine TLS-Aushandlung; ein Relay, das kein STARTTLS anbietet, lässt den Versand
  scheitern, statt Zugangsdaten und Anmeldelink im Klartext zu übertragen.
- **Port 465** bedeutet implizites TLS und schaltet `secure` automatisch ein. `SF_SMTP_SECURE`
  überschreibt das, falls ein Relay es anders will.
- **Kein Klartext.** Die STARTTLS-Pflicht lässt sich nur über `SF_SMTP_ALLOW_PLAINTEXT=1`
  aufheben, ausschließlich für einen lokalen Test-Sink und nie in `NODE_ENV=production`
  (der Start bricht dort ab). Greift die Ausnahme, schreibt der Start eine Warnung ins Log.
- **Zugangsdaten** entweder über `SF_SMTP_USER` + `SF_SMTP_PASS` oder über
  `SF_SMTP_PASS_FILE`. Eine Datei ist die bessere Wahl: sie steht nicht in `docker inspect`
  und nicht in der Prozessumgebung. Eine halbe Kombination (Benutzer ohne Passwort,
  Passwort ohne Benutzer, unlesbare oder leere Datei) bricht den Start ab.
- **Absender** muss eine Adresse sein, die das Relay akzeptiert; die meisten Anbieter
  verlangen die eigene Domain. Ein Anzeigename ist erlaubt:
  `"SmartFlow <noreply@example.com>"`.

### Versand prüfen

Der schnellste Beleg ist ein lokaler Mailpit-Container. Mailpit bietet von Haus aus kein
STARTTLS; die Anwendung verlangt es aber, sobald nicht `secure` gilt — sonst könnte ein
Man-in-the-Middle `STARTTLS` aus der Begrüßung entfernen und Zugangsdaten samt Anmeldelink
im Klartext mitlesen. Für einen reinen Testlauf gibt es genau eine Ausnahme, und die gilt
nur außerhalb von `NODE_ENV=production`: `SF_SMTP_ALLOW_PLAINTEXT=1`.

Getestet wird deshalb mit dem Entwicklungsmodus, nicht mit dem Produktions-Image:

```bash
docker run -d --name mailpit -p 1025:1025 -p 8025:8025 axllent/mailpit
cd api
SF_DATA_DIR=/tmp/sf-mailtest \
SF_PUBLIC_URL=http://127.0.0.1:8790 \
SF_DEV_MAGIC_LINK=0 \
SF_OPERATOR_EMAIL=<SF_OPERATOR_EMAIL> \
SF_SMTP_HOST=127.0.0.1 SF_SMTP_PORT=1025 SF_SMTP_ALLOW_PLAINTEXT=1 \
  npm start
# zweites Terminal:
curl -X POST http://127.0.0.1:8790/api/v1/auth/magic-link \
  -H 'content-type: application/json' -d '{"email":"<SF_OPERATOR_EMAIL>"}'
# http://localhost:8025 öffnen: Betreff, Text und Link stehen dort.
```

Im Log steht dabei eine Warnung:

```
{"level":40,...,"msg":"SF_SMTP_ALLOW_PLAINTEXT is set: mail is sent without TLS"}
```

Dieselbe Instanz **ohne** `SF_SMTP_ALLOW_PLAINTEXT` verschickt an Mailpit nichts: der
Versuch scheitert an der STARTTLS-Pflicht und landet als
`magic link mail could not be sent` im Log. Genau das ist gewollt — ein Downgrade auf
Klartext darf nicht still passieren. `SF_SMTP_ALLOW_PLAINTEXT` in
`NODE_ENV=production` bricht den Start ab; im echten Betrieb ist die Variable also nicht
verwendbar.

Die Antwort ist immer `202` mit `{"sent":true,"expiresAt":"…"}` — unabhängig davon, ob die
Adresse bekannt ist. Ohne Transport lautet sie `{"sent":false,…}`, und die Anmeldeseite
sagt dann, dass nichts verschickt wurde, statt „prüfen Sie Ihr Postfach“ zu behaupten.

Ein Versandfehler (Relay lehnt ab, Zeitüberschreitung) ändert die Antwort nicht: der
Versand läuft nach der Antwort, der Fehler steht im Log mit einem Pseudonym des
Empfängers (HMAC mit dem Instanzschlüssel, nicht der Adresse), dem SMTP-Code und dem
Kommando — nie mit Adresse, Link oder Token.

```bash
grep 'magic link mail could not be sent' <logdatei>
```

### Grenzen des Versands

- **Keine Zustellgarantie.** SPF, DKIM und DMARC müssen beim Relay bzw. in der DNS-Zone
  der Absenderdomain eingerichtet sein, sonst landet die Mail im Spam oder wird abgewiesen.
  Das ist Aufgabe des Mailproviders, nicht dieser Anwendung.
- **Ein Versuch, kein Retry.** Schlägt der Versand fehl, wird nicht erneut versucht; die
  Person fordert einfach einen neuen Link an. Ein Mail-Queue-System gibt es nicht.

## Update

```bash
git pull
docker compose up -d --build
docker compose ps                 # wieder auf "healthy" warten
```

`app` und `caddy` werden nur neu erstellt, wenn sich ihr Image oder ihre Konfiguration
ändert. Die Volumes bleiben unangetastet; Datenbankmigrationen laufen beim Start.

## Backup

Alles, was gesichert werden muss, steht im Volume `data`: die Plattform-Datenbank, eine
Datenbank je Mandant und der Schlüssel für die Sitzungen.

Im laufenden Betrieb eine Datei zu **kopieren** ist riskant: die Datenbanken laufen im
WAL-Modus, eine Kopie ohne die `-wal`-Datei ist also unvollständig oder zerrissen. Nutze
deshalb die Backup-Schnittstelle von SQLite, die einen konsistenten Stand zieht:

```bash
# Konsistente Sicherung innerhalb des Containers: Plattform-DB und jede
# Mandanten-DB unter /data/tenants. Eine Kopie der laufenden Dateien wäre
# wegen WAL unvollständig, deshalb die Backup-Schnittstelle von SQLite.
docker compose exec app node --input-type=module -e "
import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const out = '/data/backup';
mkdirSync(out, { recursive: true });
const files = ['platform.sqlite'];
const tenantDir = '/data/tenants';
try {
  for (const f of readdirSync(tenantDir)) if (f.endsWith('.sqlite')) files.push(join('tenants', f));
} catch {}
for (const rel of files) {
  const src = '/data/' + rel;
  const dst = join(out, rel.replace(/\//g, '__'));
  const db = new Database(src, { readonly: true });
  await db.backup(dst);
  db.close();
  console.log('gesichert', rel, statSync(dst).size, 'Bytes');
}"

# Auf den Host holen
mkdir -p backups
docker compose cp app:/data/backup ./backups/$(date +%F)
docker compose exec app rm -rf /data/backup
```

Die Schleife deckt `platform.sqlite` **und** jede Mandanten-DB ab. Wer nur
`/data/*.sqlite` sichert, verliert alle Mandantendaten.

Wer `sqlite3` auf dem Host hat, kann dasselbe mit `sqlite3 <datei> ".backup <ziel>"`
gegen den Volume-Pfad tun. Ein Stopp der Dienste (`docker compose down`) vor dem Kopieren
ist die einfache, aber unterbrechende Variante.

Sitzungen liegen als Hashes in der Tabelle `sessions` in `platform.sqlite`; nach einem
Restore mit aktuellem Stand sind bestehende Anmeldungen also weiter gültig. Die
Schlüsseldatei `secrets.key` legt der Prozess im Datenverzeichnis an und nutzt sie als
HMAC-Schlüssel für das Empfänger-Pseudonym im Mail-Fehlerlog — ohne sie lassen sich alte
Logzeilen keinem Empfänger mehr zuordnen, für die Anmeldung selbst ist sie entbehrlich.
Die Zertifikate liegen getrennt im Volume `caddy_data`; ein Verlust kostet nur eine
Neuausstellung.

## Logs

```bash
docker compose logs -f app         # API, ein JSON-Objekt je Zeile
docker compose logs -f caddy       # TLS und Proxy
docker compose logs --tail=200 app
```

`SF_LOG_LEVEL` steuert die Ausführlichkeit (`info` als Default, `debug` bei der Fehlersuche).

## Health

```bash
curl -s https://<SF_DOMAIN>/api/v1/health    # {"status":"ok","version":"…","port":8790}
docker compose ps                               # Healthcheck-Status
docker inspect --format '{{json .State.Health}}' $(docker compose ps -q app)
```

Der Healthcheck im Image fragt `127.0.0.1:8790/api/v1/health` ab und ist damit unabhängig
von DNS und TLS. `start-period` ist 30 s: der erste Start legt die Datenbanken an, und der
Healthcheck soll erst danach greifen.

## Grenzen

- **Eine Instanz.** Jeder Mandant hat eine eigene SQLite-Datei, und SQLite erlaubt genau
  einen schreibenden Prozess. `docker compose up --scale app=2` ist kein Skalierungspfad,
  sondern Datenverlust. Für mehr Last braucht es zuerst einen Wechsel der Datenbank.
- **Kein Registry-Push.** `docker compose up --build` baut auf dem Zielhost. Ein
  Registry-Workflow (Push, Tag-Strategie, Rollback per Tag) ist nicht eingerichtet.
- **Kein Rollback-Kommando.** Ein Update zurückzudrehen heißt: alten Stand auschecken,
  `docker compose up -d --build`. Migrationen laufen nur vorwärts.
- **TLS-Endpunkt ist Caddy.** `SF_TRUST_PROXY=1` gilt nur in dieser Topologie. Wird die
  Anwendung direkt veröffentlicht, muss der Wert weg — sonst vertraut sie
  `X-Forwarded-*`-Headern, die jeder Client selbst setzen kann.
