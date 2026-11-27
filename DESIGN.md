---
name: SmartFlow Plattform
description: Interne Operations- und Service-Plattform — ruhiges Instrument, kein Marketing.
colors:
  paper: "#f2efe7"
  paper-raised: "#faf8f2"
  surface: "#ffffff"
  ink: "#12161a"
  ink-soft: "#454c52"
  ink-muted: "#5f676d"
  line: "#ddd7c8"
  line-strong: "#b9b2a0"
  cobalt: "#1e3bff"
  cobalt-deep: "#1428b8"
  signal: "#ff5a1f"
  good: "#0b7a53"
  warn: "#7a4a00"
  bad: "#bb2d1e"
  dark-paper: "#0d1013"
  dark-paper-raised: "#14181c"
  dark-surface: "#171c21"
  dark-ink: "#eef0ea"
  dark-ink-soft: "#b5bcc2"
  dark-ink-muted: "#98a1a8"
  dark-line: "#262c31"
  dark-line-strong: "#3b434a"
  dark-cobalt: "#6d84ff"
  dark-cobalt-deep: "#4b62ff"
  dark-signal: "#ff7a45"
  dark-good: "#3ddb9f"
  dark-warn: "#f0b447"
  dark-bad: "#ff6b57"
typography:
  display:
    fontFamily: "Bricolage Grotesque, system-ui, sans-serif"
    fontSize: "36px"
    fontWeight: 600
    lineHeight: 1.05
    letterSpacing: "-0.03em"
  display-sm:
    fontFamily: "Bricolage Grotesque, system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 600
    lineHeight: 1.05
    letterSpacing: "-0.03em"
  metric:
    fontFamily: "Bricolage Grotesque, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "Bricolage Grotesque, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Bricolage Grotesque, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.2
  body:
    fontFamily: "Schibsted Grotesk, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  body-small:
    fontFamily: "Schibsted Grotesk, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Martian Mono, ui-monospace, monospace"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.08em"
  data:
    fontFamily: "Martian Mono, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "-0.01em"
rounded:
  badge: "2px"
  sm: "3px"
  card: "4px"
  overlay: "5px"
  lg: "8px"
spacing:
  hairline: "1px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  section: "32px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: "36px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: "36px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: "36px"
  button-danger:
    backgroundColor: "{colors.bad}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: "36px"
  badge:
    backgroundColor: "{colors.paper-raised}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.badge}"
    padding: "2px 6px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "16px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "36px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.sm}"
    padding: "0 8px"
    height: "28px"
---

# Design System: SmartFlow Plattform

## Overview

**Creative North Star: "Das Instrument"**

Die Plattform ist ein Messgerät, kein Schaufenster. Jede Fläche beantwortet eine Frage des Betreibers: Was läuft, was braucht Aufmerksamkeit, was ist zuletzt passiert. Dichte ist erwünscht, Unruhe nicht — deshalb trägt warmes Papier die Fläche, fast schwarze Tinte den Text, und Farbe erscheint nur dort, wo sie eine Bedeutung hat.

Die Anmutung ist präzise und trocken: 1-px-Haarlinien statt Schatten, 3-px-Kanten an Bedienelementen, Mono-Ziffern für alles Messbare. Es gibt keine Dekoration, keine Verläufe, keine Hero-Flächen. Ein Diagramm, eine Tabelle und eine Zahl sind die legitimen Hauptdarsteller.

Die Marke und das Designsystem sind direkt aus dem Vorgänger-Repository (SmartFlow Plattform) übernommen: dieselben Tokens, dieselben Schriften, dieselben Bausteine. Neue Plugins erfinden nichts, sie setzen das Instrument fort.

**Key Characteristics:**
- Warmes Papier als Grund, weiße Karten als Flächen, Haarlinien als Trennung (mit abgestimmtem Dunkelmodus).
- Kobalt ist Auswahl und Aktion, Signal-Orange ist Warnung, Grün/Gelb/Rot sind Zustände.
- Bricolage Grotesque für Überschriften und Kennzahlen, Schibsted Grotesk für Text, Martian Mono für Labels und Zahlen.
- Scharfe, kleine Radien (2–5 px); Schatten nur über Overlays.
- Feste Typo-Rampe ohne Zwischenstufen.

## Colors

Die Palette ist Papier und Tinte mit zwei lauten Akzenten, die sich ihre Seltenheit verdienen.

### Primary
- **Kobalt** (#1e3bff): Auswahl, aktiver Navigationszustand, Fokusring, Primär-Aktion in Ausnahmefällen. Im Dunkelmodus **Kobalt Hell** (#6d84ff). Tiefes Kobalt (#1428b8) nur als Druck-/Hover-Variante.
- **Signalorange** (#ff5a1f): ausschließlich Warnung und destruktive Aufmerksamkeit, nie Flächendekoration. Im Dunkelmodus **Signal Hell** (#ff7a45).

### Secondary
- **Grün** (#0b7a53) für „ok“, **Gelb-Ocker** (#7a4a00) für „wartet/eingeschränkt“, **Rot** (#bb2d1e) für „fehlgeschlagen/blockiert“. Im Dunkelmodus `dark-good`, `dark-warn` und `dark-bad`. Zustandsfarben erscheinen als Punkt, Badge oder Zahl — nicht als Seitenhintergrund.

### Neutral
- **Papier** (#f2efe7): Seitenhintergrund. **Papier erhöht** (#faf8f2): Sidebar, Ruheflächen, Code-Blöcke. **Fläche** (#ffffff): Karten und Felder, die über dem Papier liegen.
- **Tinte** (#12161a): Primärtext und der einzige dunkle Knopf. **Tinte weich** (#454c52): Fließtext zweiter Ordnung, Icons. **Tinte gedämpft** (#5f676d): Labels, Zeitstempel, Hinweise.
- **Linie** (#ddd7c8) und **Linie stark** (#b9b2a0): Haarlinien, Rahmen, Scrollbalken. Im Dunkelmodus Papier #0d1013, erhöht #14181c, Fläche #171c21, Tinte #eef0ea, Linien #262c31/#3b434a.

### Named Rules
**Die Ein-Stimme-Regel.** Kobalt und Signal teilen sich nie dieselbe Fläche. Kobalt markiert, wo man ist oder was man tun kann; Signal markiert, was schiefgeht. Zusammen decken sie höchstens ein Zehntel des Bildschirms.

**Die Papier-Regel.** Papier ist Grund, Fläche ist Karte. Eine Karte auf einer Karte gibt es nicht; was enger zusammengehört, wird durch eine Haarlinie getrennt.

## Typography

**Display Font:** Bricolage Grotesque (mit system-ui)
**Body Font:** Schibsted Grotesk (mit system-ui)
**Label/Mono Font:** Martian Mono (mit ui-monospace)

**Character:** Bricolage ist kompakt und leicht technisch, Schibsted liest sich nüchtern, Martian Mono macht Labels und Messwerte zu Instrumentenbeschriftung. Die Mischung wirkt wie ein Gerät mit guter Beschriftung, nicht wie ein Magazin.

### Hierarchy
- **Display** (600, 36 px / mobil 30 px, 1.05, −0.03 em): Seitentitel, eine pro Seite, maximal zwei Zeilen.
- **Metric** (600, 24 px, 1, −0.03 em): Kennzahlen in Kacheln und Karten.
- **Headline** (600, 17 px, 1.25, −0.015 em): Kartentitel.
- **Title** (600, 15 px): Listeneinträge, Dialogtitel, Plugin-Namen.
- **Body** (400, 13–14 px, 1.5): Fließtext, Tabellenzellen; Beschreibungen bleiben unter 65 Zeichen pro Zeile.
- **Label** (500, 11 px, 0.08 em, Großbuchstaben, Martian Mono): Rubriken, Spaltenköpfe, Statuswörter.
- **Data** (400, 12 px, tabellarische Ziffern, Martian Mono): Zeitstempel, IDs, Pfade, HTTP-Codes.

### Named Rules
**Die Rampen-Regel.** Es gibt genau diese Stufen: 11 · 12 · 13 · 14 · 15 · 17 · 24 · 30 · 36 px. Keine Zwischenstufe, nichts unter 12 px außer Labels. Wer eine neue Größe braucht, nimmt die nächste Stufe.

**Die Ziffern-Regel.** Alles, was sich ändert oder verglichen wird, steht in Martian Mono mit tabellarischen Ziffern (`numeric`). Fließtext bleibt Grotesk.

## Layout

Ein fester Rahmen mit ruhigem Innenraum. Links eine 230 px breite Sidebar (Papier erhöht, 1-px-Rand rechts), rechts der scrollende Inhalt. Der Inhalt ist auf 1500 px begrenzt und atmet mit 16 px Rand auf kleinen, 32 px auf großen Fenstern; oben und unten 24 bzw. 32 px.

Die Sidebar gliedert nach Tätigkeit in Gruppen aus dem Navigationsmanifest der Plugins (`/api/v1/nav`, im Kernel aktuell `work` und `management`) mit Mono-Labeln; Einträge sind 28 px hoch, Radius 3 px, Abstand 2 px. Der Kern filtert und sortiert nach Rolle und Reihenfolge; leere Gruppen entfallen.

Selten gebrauchte Betreiber-Ziele können hinter „Mehr“ gebündelt werden: der Knopf bleibt unter dem Scrollbereich fixiert, die Ziele selbst scrollen mit und bleiben über die Befehlspalette jederzeit erreichbar. Über der Navigation sitzt für Operatoren ein kompakter Betriebsblock (Zustand, Plugins, Laufzeit aus `/api/v1/health`), der bei Mandanten entfällt. Unten stehen Nutzername, Version und eine 28-px-Iconzeile mit Kernzielen (Einstellungen, Hilfe, Abmelden).

Einträge, die auf etwas Wartendes zeigen, tragen einen Zähler: 16 px hoch, 2-px-Radius, 1-px-Rahmen in 30 % der Tonfarbe, Fläche in 8 %, Zahl in Mono 12. Signalorange für „offen“, Rot für „fehlgeschlagen“; bei 0 entfällt der Zähler. Nur echte API-Zählwerte anzeigen, niemals geschätzte Zahlen.

Seiten folgen demselben Rhythmus: Kopfbereich mit Rubrik, Titel und einer Zeile Erklärung, darunter Kachelreihen (12 px Abstand) und Karten. Kennzahlen stehen in Reihen zu 2 (mobil) bis 4 (breit); Tabellen scrollen horizontal in ihrem eigenen Container.

**Breakpoints:** 640 px (zweispaltige Kacheln), 768 px (Seitenkopf zweispaltig, größere Ränder), 1024 px (vier Kacheln). Unter 768 px wird die Sidebar zum Drawer: von links eingeschoben, 230 px breit, Abdunkler in Tinte zu 25 %, Schließen-X im Kopf, Menü-Knopf in der Kopfleiste. Solange er offen ist, scrollt die Seite nicht; Escape schließt, der Fokus bleibt im Drawer und kehrt danach zum Menü-Knopf zurück. Geschlossen ist die Sidebar `inert`, damit ihre Links nicht unsichtbar im Tab-Lauf liegen.

**Dichte:** Tabellenzeilen 8 px oben/unten, Kartenköpfe 12 px, Karteninhalt 16 px. Ein Bildschirm darf viele Fakten zeigen, solange die Haarstriche die Ordnung tragen.

## Elevation & Depth

Das System ist flach. Tiefe entsteht durch Tonwert: Papier hinten, weiße Fläche vorn, Haarlinie als Kante. Karten und Kacheln haben keinen Schatten, auch nicht im Hover. Schatten existieren nur für Overlays, die über der Seite liegen und den Kontext verdecken — Modal, Sheet, Menü. Der Hintergrund wird dabei mit Tinte zu 25 % abgedunkelt und 1 px weichgezeichnet.

### Shadow Vocabulary
- **Overlay** (`box-shadow: 0 25px 50px -12px rgb(0 0 0 / 0.25)`): Modal, Sheet, Popover. Nie an Karten.
- **Menü** (`box-shadow: 0 20px 25px -5px rgb(0 0 0 / 0.1)`): Dropdown und Select-Liste.

### Named Rules
**Die Flach-Regel.** Flächen sind flach im Ruhezustand. Wer Tiefe braucht, ändert den Tonwert oder zieht eine Linie, nicht den Schatten.

## Shapes

Kleine, präzise Radien: 2 px an Badges, 3 px an Knöpfen, Feldern und Navigationseinträgen, 4 px an Karten und Kacheln, 5 px an Modals und Sheets, 8 px nur an großen Overlay-Flächen. Nichts ist pillenförmig; der Toggle ist die einzige Ausnahme, weil er ein Schalter ist.

Rahmen sind immer 1 px und kommen aus `line`; stärkere Rahmen (`line-strong`) nur als Hover an sekundären Knöpfen. Es gibt keine Verläufe, keine abgerundeten Bildmasken, keine dekorativen Formen. Statuspunkte sind 6 px groß und rund — das kleinste erlaubte Rund.

## Components

### Logo / Wort-Bild-Marke
- **Signet (`SF`):** Quadrat mit 3 px Radius, Fläche in `ink` (#12161a im Hellmodus, #eef0ea im Dunkelmodus), Buchstaben `SF` in `paper` (#f2efe7 bzw. #0d1013), gesetzt in Bricolage Grotesque Bold (700), zentriert. Keine weiteren Farben, kein Akzentpunkt, kein Verlauf.
- **Wortmarke (rechts neben dem Signet, 10 px Abstand):** zweizeilig linksbündig — obere Zeile `SMARTFLOW` in Martian Mono 12 px, Großbuchstaben, Laufweite `0.14em`, Farbe `ink-muted`; untere Zeile `Plattform` in Bricolage Grotesque SemiBold (600), `line-height: 1`, Farbe `ink`.
- **Größen:** Login und eigenständige Ansichten nutzen 32 × 32 px Signet (`SF` 14 px) mit `Plattform` in 17 px; die Sidebar nutzt 28 × 28 px Signet (`SF` 13 px) mit `Plattform` in 15 px.
- **Favicon:** `web/public/favicon.svg` zeigt ausschließlich das `SF`-Signet (Hell- und Dunkelmodus über `prefers-color-scheme`).

### Buttons
- **Shape:** scharf, 3 px Radius, 36 px hoch (`size="md"`), 32 px in Tabellen und Kopfzeilen (`size="sm"`), 13 px Schrift, 500.
- **Primary:** Tinte auf Papier (#12161a / #f2efe7; im Dunkelmodus #eef0ea / #0d1013), 1-px-Rahmen in Tinte. Der kontraststärkste Knopf ist der wichtigste — höchstens einer pro Fläche.
- **Secondary:** weiße Fläche (`surface`), 1-px-Linie, Hover wechselt auf `line-strong` und `paper-raised`.
- **Ghost:** transparent, Text weich; Hover legt Tinte zu 5 % darunter. Für Kopfzeilen und Schließen.
- **Danger / Signal:** Rot bzw. Orange als Fläche, weiße Schrift; nur für bestätigte, irreversible Aktionen.
- **Hover / Focus:** Farbwechsel in 150 ms, kein Verschieben, keine Schatten. Fokus ist ein 2-px-Kobalt-Ring mit 2 px Abstand; deaktiviert 50 % Deckkraft ohne Pointer.

### Chips / Badges
- **Style:** 2 px Radius, 1-px-Rahmen in 30 % der Tonfarbe, Fläche in 8 % derselben Farbe, Text in Vollton. Schrift Martian Mono 12 px, Großbuchstaben, 0.06 em.
- **State:** Tonwerte `good`, `warn`, `bad`, `neutral`, `accent`. Zustandswörter bleiben im Fließtext normal geschrieben; das Badge nutzt Großbuchstaben.

### Cards / Containers
- **Corner Style:** 4 px.
- **Background:** `surface`; Kartenhintergrund wechselt nie zu Papier, Papier bleibt außen.
- **Shadow Strategy:** keiner (siehe Flach-Regel).
- **Border:** 1 px `line`, volle Kante.
- **Internal Padding:** Kopf 12 px/16 px, Inhalt 16 px, Tabellenzeilen 8 px/16 px.

### Inputs / Fields
- **Style:** 36 px hoch, 3 px Radius, 1-px-Linie, `surface`-Fläche, 13 px Text, Platzhalter in `ink-muted`.
- **Focus:** Rahmen wird Kobalt, dazu ein 2-px-Ring in Kobalt zu 15 %.
- **Error / Disabled:** Fehlertext 12 px in Rot unter dem Feld; deaktiviert 50 % Deckkraft. Pflichtfelder werden benannt, nicht nur rot markiert.

### Navigation
- **Style:** 28-px-Zeilen, 3 px Radius, 13 px Text, Icon 15 px links, Gruppenlabels als 11-px-Mono in `ink-muted`. Rail und Befehlspalette lesen dieselbe Antwort von `/api/v1/nav`; Gruppennamen und Reihenfolge kommen aus den Manifesten und dem Kern.
- **States:** Ruhe `ink-soft`; Hover Tinte zu 5 % Fläche; aktiv Tinte als Fläche mit Papiertext — der aktive Eintrag ist der einzige kontrastierte Balken der Sidebar.
- **Zähler:** 16 px hoch, 2 px Radius, Mono 12, Rahmen 30 % / Fläche 8 % der Tonfarbe, rechts in der Zeile; Signal für „offen“, Rot für „fehlgeschlagen“, nichts bei 0.
- **Mobil:** unter 768 px Drawer mit Abdunkler, Schließen-X und Menü-Knopf; geschlossen `inert`, offen ohne Seitenscroll, Escape schließt, Fokus kehrt zum Menü-Knopf zurück.
- **Betriebsblock:** nur Operatoren, über der Navigation; Label, Zustandswort in der Tonfarbe, Plugin-Zahl und Laufzeit in Mono 12 aus `/api/v1/health`, keine erfundenen Werte.
- **Bottom (Sidebar-Fußzeile):** Über einer vollen 1-px-Haarlinie (`line`), Innenabstand 8 px, exakt zweizeilig und visuell zurückgenommen (kein Rollen-Untertitel, kein dunkler Sprach-Block):
  - *Zeile 1 (Identität & Version):* `baseline`-ausgerichtet mit 4 px / 8 px Innenabstand und 4 px Abstand nach unten — links Nutzername in 12 px `ink-soft` (`truncate`, E-Mail/Rolle nur im `title`-Tooltip), rechts Version (`v…` aus `/api/v1/health`) in Martian Mono 11 px, Gewicht 400, `ink-muted`.
  - *Zeile 2 (Utility-Iconleiste):* 28 × 28 px Ghost-Iconknöpfe (3 px Radius, 15-px-Icons in `ink-muted`, Hover Tinte zu 5 % + `ink`, aktiv `ink` + `paper`, alle mit `aria-label` und `title`); links **Einstellungen** (Zahnrad), **Darstellung** (Sonne/Mond) und **Hilfe** (Fragezeichen im Kreis) mit 4 px Abstand, rechts abgesetzt (`margin-left: auto`) **Abmelden** als Fehlklick-Schutz. Keine toten Icons ohne Zielseite.
    - **Darstellungsumschalter:** ein Klick schaltet genau einen Schritt weiter: Instrument hell → dunkel → Nordlicht hell → dunkel → Archiv hell → dunkel → Kontrast hell → dunkel → (nur wenn vorhanden) eigenes Theme hell → dunkel → zurück zu Instrument hell. Startpunkt ist das gespeicherte Paar aus `sf.theme` und `sf.mode`, nie ein fester Index; geschrieben wird über denselben Weg wie der Topbar-Schalter, also eine einzige Zustandsquelle. Das Icon zeigt den Zielzustand (Sonne für hell, Mond für dunkel), `aria-label` und `title` nennen beide Zustände („Darstellung: Nordlicht dunkel — wechseln zu Archiv hell“), kein `aria-pressed`, weil es mehr als zwei Zustände sind. Tastatur wie die Nachbarn: Enter/Space schalten, der Fokus bleibt auf dem Knopf, im mobilen Drawer identisch. Der Topbar-Knopf Hell/Dunkel bleibt unverändert.

### Metrics (KPI-Kacheln)
- Kennzahl 24 px Bricolage in der Tonfarbe des Zustands, Label darüber in Mono, Hinweis darunter 12 px in `ink-muted`. 1-px-Rahmen, 4 px Radius, 14/16 px Innenabstand.

### Overlays (Modal, Sheet, Confirm)
- Modal zentriert, maximal 512–672 px, 5 px Radius, Papier als Fläche, Kopf mit Titel 17 px und Schließen als Ghost-Icon.
- Sheet schiebt von rechts über die volle Höhe, 576–896 px breit, gleiche Kopfform.
- Confirm verlangt eine bewusste Entscheidung: Titel, ein Satz Risiko, Abbrechen links, Bestätigen rechts in Rot oder Tinte.

### Kopfleiste
- 56 px hoch, klebend, Haarlinie unten, Papier zu 95 % mit Backdrop. Der Inhalt darunter scrollt allein.
- Links die Suche als Feld (max 384 px, Lupe 14 px, ⌘K als Mono-Hinweis), rechts Systemzustand (6-px-Punkt plus Mono-Label), dezenter Sprachschalter (`DE`/`EN`, sekundärer Stil ohne dunkle Vollfläche — alternativ in den Einstellungen), Modusschalter (Hell/Dunkel) und die Primäraktion in Tinte.
- Unter 1024 px fällt der Systemzustand weg, unter 640 px bleiben nur die Icons. Es gibt keine zweite Navigation.

### Befehlspalette
- Overlay Tinte zu 25 %, Dialog ab 12 vh, maximal 576 px, 5 px Radius, Papier.
- Eingabezeile 48 px mit Lupe oder Plus (15 px), mono „Esc“ rechts.
- Zeilen 32 px, Icon 15 px, Gruppe als Mono 11 px rechts; aktiv Tinte als Fläche mit Papiertext.
- ⌘K/Strg+K öffnet die Suche; „Neu“ öffnet dieselbe Palette im Anlegen-Modus.

## Do's and Don'ts

### Do:
- **Do** nutze die Kopfleiste für Suche, Systemzustand und die nächste Aktion; baue keine zweite Navigation und keinen zweiten Suchweg.
- **Do** nutze die Tokens aus `web/src/index.css` (`paper`, `ink`, `surface`, `line`, `cobalt`, `signal`) und halte neue UI-Bausteine strikt im System. Ein neues Plugin erbt das Instrument, es gestaltet es nicht neu.
- **Do** trenne mit 1-px-Haarlinien und Tonwert, nicht mit Schatten oder Farbflächen.
- **Do** setze Zahlen, Zeiten und IDs in Martian Mono mit tabellarischen Ziffern.
- **Do** halte die Typo-Rampe ein (11/12/13/14/15/17/24/30/36) und beschränke dich auf einen Display-Titel pro Seite.
- **Do** nutze Kobalt für Auswahl und Fokus, Rot/Gelb/Grün nur für Zustände, Signal ausschließlich als Warnung.

### Don't:
- **Don't** führe neue Farben, Verläufe, Schatten an Karten oder große Radien ein.
- **Don't** baue Hero-Flächen, Marketing-Absätze oder dekorative Illustrationen; die Plattform ist ein Arbeitsgerät.
- **Don't** verschachtele Karten in Karten oder lege Karten auf farbige Flächen.
- **Don't** nutze Signalorange als Fläche für normale Aktionen oder als Akzent in Diagrammen ohne Warnbedeutung.
- **Don't** erfinde neue Schriftgrößen, Pillen-Buttons oder Icon-only-Aktionen ohne `aria-label`.
