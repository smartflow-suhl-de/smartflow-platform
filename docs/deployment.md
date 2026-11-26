# Deployment mit Docker

Die Plattform läuft als ein Container, erreichbar über einen eigenen Tailnet-Knoten: die API liefert die SPA unter `/`
selbst aus, deshalb gibt es nur einen Origin und kein CORS. Ein Host, ein Prozess —
mehr dazu unter [Grenzen](#grenzen).

## Voraussetzungen

- Docker mit Compose v2 (`docker compose version`)
- Ein Tailnet (Tailscale-Konto) mit aktiviertem MagicDNS und HTTPS-Zertifikaten
  (Admin-Konsole → DNS → _Enable HTTPS_). Die Tailnet-Domain (`<name>.ts.net`) steht dort.
- Ausgehender Internetzugang des Hosts (Tailscale-Koordination); eingehend sind **keine**
  Ports nötig, der Stack veröffentlicht keine.

## Erststart

```bash
git clone <repository> smartflow-platform
cd smartflow-platform
cp .env.production.example .env
$EDITOR .env                      # SF_TAILNET_DOMAIN setzen; beim ersten Start SF_TS_AUTHKEY
docker compose up -d --build
docker compose ps                 # app muss "healthy" sein, tailscale "running"
```

`SF_TAILNET_DOMAIN` ist Pflicht: fehlt der Wert, bricht Compose ab, bevor ein Container
startet. `SF_PUBLIC_URL` wird in `compose.yaml` aus `SF_TS_NODE_NAME` (Standard
`smartflow-platform`) und `SF_TAILNET_DOMAIN` zusammengesetzt und deshalb nicht in `.env`
gesetzt — Knotenadresse und Anwendungs-Origin können so nicht auseinanderlaufen.

### Knoten-Anmeldung

Beim ersten Start meldet sich der Knoten im Tailnet an:

- **Mit Auth-Key:** in der Admin-Konsole einen **einmaligen, kurzlebigen** Key erzeugen und
  als `SF_TS_AUTHKEY` in `.env` setzen. Nach der ersten Anmeldung den Wert wieder aus `.env`
  entfernen; der Knoten-Zustand liegt im Volume `smartflow-ts-state`.
- **Ohne Auth-Key:** `docker compose logs tailscale` zeigt eine Anmelde-URL; im Browser
  öffnen und den Knoten freigeben.
- Ein bereits autorisiertes Volume (`SF_TS_STATE_VOLUME`, Standard `smartflow-ts-state`)
  braucht keinen Key.

Danach ist die Plattform unter `https://<SF_TS_NODE_NAME>.<SF_TAILNET_DOMAIN>/` erreichbar.
TLS terminiert Tailscale mit einem echten Zertifikat; Clients importieren nichts.

Zwei Fehlerquellen bei diesem zusammengesetzten Wert:

- `SF_TAILNET_DOMAIN` ist nur der Domain-Rest, ohne Schema und ohne führenden Punkt
  (`example-tailnet.ts.net`, nicht `https://example-tailnet.ts.net`). Der Start bricht ab,
  wenn daraus keine reine Origin wird.
- Ist der Knotenname im Tailnet schon vergeben, hängt Tailscale ein `-1` an
  (`smartflow-platform-1`). Dann zeigt die Origin auf einen Namen, den es nicht gibt:
  `SF_TS_NODE_NAME` anpassen, Volume `smartflow-ts-state` löschen und neu anmelden.

### Erreichbarkeit und Sicherheit

- **Nur im Tailnet.** Ohne Caddy und ohne veröffentlichte Ports gibt es **keinen**
  öffentlichen Zugang. Ein späterer öffentlicher Betrieb bräuchte entweder einen
  Reverse Proxy (z. B. Caddy) zurück oder Tailscale Funnel — beides ist bewusst nicht
  Teil dieses Stands. `AllowFunnel` ist in `deploy/tailscale/serve.json` `false`.
- **Zugangsgrenze ist die Tailnet-ACL, nicht der Container:** ohne restriktive ACL erreicht
  jedes Gerät im Tailnet Port 443, auch eine noch offene Ersteinrichtung
  (`POST /api/v1/auth/setup`). ACL einschränken und Setup vorher abschließen.
- Nur `SF_*` aus `.env` gelten; globale `TS_*`-Variablen des Hosts werden nicht gelesen.
- Das Tailscale-Image ist auf Version und Digest gepinnt (`deploy/tailscale/Dockerfile`);
  ein Update ist eine bewusste Änderung.

### Ersteinrichtung

Nach dem ersten Start hat die Plattform **kein Konto**. `https://<SF_TS_NODE_NAME>.<SF_TAILNET_DOMAIN>` öffnen, dann
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

## Update

```bash
git pull
docker compose up -d --build
docker compose ps                 # wieder auf "healthy" warten
```

`app` und `tailscale` werden nur neu erstellt, wenn sich ihr Image oder ihre Konfiguration
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
genutzt. Die Knoten-Identität liegt getrennt im
Volume `smartflow-ts-state`; ein Verlust kostet nur eine Neuanmeldung des Knotens.

## Logs

```bash
docker compose logs -f app         # API, ein JSON-Objekt je Zeile
docker compose logs -f tailscale   # Knoten-Anmeldung und Serve
docker compose logs --tail=200 app
```

`SF_LOG_LEVEL` steuert die Ausführlichkeit (`info` als Default, `debug` bei der Fehlersuche).

## Health

```bash
curl -s https://<SF_TS_NODE_NAME>.<SF_TAILNET_DOMAIN>/api/v1/health    # nur im Tailnet; {"status":"ok","version":"…","port":8790}
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
- **TLS-Endpunkt ist Tailscale Serve.** `SF_TRUST_PROXY=1` gilt nur in dieser Topologie. Wird die
  Anwendung direkt veröffentlicht, muss der Wert weg — sonst vertraut sie
  `X-Forwarded-*`-Headern, die jeder Client selbst setzen kann.
