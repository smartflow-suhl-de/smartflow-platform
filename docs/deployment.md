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
$EDITOR .env                      # SF_DOMAIN und SF_OPERATOR_EMAIL (ACME-Kontakt) setzen
docker compose up -d --build
docker compose ps                 # STATUS muss "healthy" enthalten
```

`SF_DOMAIN` und `SF_OPERATOR_EMAIL` sind Pflicht: fehlen sie, bricht Compose ab, bevor
ein Container startet. `SF_PUBLIC_URL` wird in `compose.yaml` aus `SF_DOMAIN`
zusammengesetzt und deshalb nicht in `.env` gesetzt — die beiden Werte können so nicht
auseinanderlaufen.

### Ersteinrichtung

Nach dem ersten Start hat die Plattform **kein Konto**. `https://<SF_DOMAIN>` öffnen, dann
fragt die Anmeldeseite nach E-Mail, Name und Passwort (mindestens 12 Zeichen) und legt den
ersten Operator an. Danach meldet man sich mit E-Mail und Passwort an; einen Mailversand
gibt es nicht mehr.

Die Ersteinrichtung ist so lange offen, bis sie einmal abgeschlossen ist — wer die Instanz
in dieser Zeit als Erster erreicht, wird Operator. Deshalb direkt nach `docker compose up`
einrichten und die Instanz vorher nicht öffentlich bewerben. Ist sie erledigt, antwortet
`POST /api/v1/auth/setup` mit `409 setup_complete`.

Das Image setzt bewusst **keinen** Default für `SF_PUBLIC_URL`: die Anwendung verlangt im
Produktivbetrieb eine `https://`-Origin und startet sonst nicht. Genau das soll beim Start
auffallen und nicht erst, wenn sich niemand anmelden kann.

Daten liegen im benannten Volume `smartflow_data` (Pfad: `docker volume inspect
smartflow_data`), nicht im Image. Ein `docker compose down` ohne `-v` behält sie.

### Ohne öffentliche Domain ausprobieren

```bash
printf 'SF_DOMAIN=localhost\nSF_OPERATOR_EMAIL=ops@example.com\n' > .env
# in deploy/caddy/Caddyfile zusätzlich "tls internal" in den Site-Block schreiben
docker compose up -d --build       # baut auch das Caddy-Image neu
curl -k https://localhost/api/v1/health
```

Selbstsignierte Zertifikate lassen `curl` ohne `-k` scheitern; das ist erwartet und kein
Fehler der Anwendung.

## Update

```bash
git pull
docker compose up -d --build
docker compose ps                 # wieder auf "healthy" warten
```

`app` und `caddy` werden nur neu erstellt, wenn sich ihr Image oder ihre Konfiguration
ändert. Die Volumes bleiben unangetastet; Datenbankmigrationen laufen beim Start.

> **Upgrade vom Magic-Link-Stand:** Ein vorhandener Operator ohne Passwort wird beim
> ersten Setup übernommen, und `/api/v1/auth/setup` ist bis dahin für jeden erreichbaren
> Client offen. Setup deshalb direkt nach dem Update selbst abschließen. Alte Sitzungen
> dieses Kontos werden dabei beendet.

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
Restore mit aktuellem Stand sind bestehende Anmeldungen also weiter gültig. Ein eigenes
Schlüsseldatei (`secrets.key`) legt der aktuelle Stand noch nicht an — die
Verschlüsselungshelfer in `api/src/kernel/secrets.ts` werden bisher von keiner Route
genutzt. Die Zertifikate liegen getrennt im
Volume `caddy_data`; ein Verlust kostet nur eine Neuausstellung.

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
- **Ersteinrichtung nur einmal, und offen bis dahin.** Solange kein Konto ein Passwort
  hat, kann jeder erreichbare Client den Operator anlegen. Nach dem ersten Setup ist die
  Route mit `409 setup_complete` geschlossen. Wer die Instanz zuerst erreicht, gewinnt —
  deshalb sofort nach dem Start einrichten.
- **Passwort ändern oder zurücksetzen gibt es noch nicht.** Das Passwort wird bei der
  Ersteinrichtung gesetzt. Bis eine eigene Route existiert, hilft nur ein neues
  Daten-Volume (Verlust aller Daten) — der Punkt steht in `PRODUCT.md` unter „Noch offen“.
- **Kein Registry-Push.** `docker compose up --build` baut auf dem Zielhost. Ein
  Registry-Workflow (Push, Tag-Strategie, Rollback per Tag) ist nicht eingerichtet.
- **Kein Rollback-Kommando.** Ein Update zurückzudrehen heißt: alten Stand auschecken,
  `docker compose up -d --build`. Migrationen laufen nur vorwärts.
- **TLS-Endpunkt ist Caddy.** `SF_TRUST_PROXY=1` gilt nur in dieser Topologie. Wird die
  Anwendung direkt veröffentlicht, muss der Wert weg — sonst vertraut sie
  `X-Forwarded-*`-Headern, die jeder Client selbst setzen kann.
