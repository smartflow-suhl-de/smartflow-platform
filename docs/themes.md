# Farbschemata (Themes)

Die Oberfläche kann zwischen mehreren Farbschemata wechseln. Ein Theme ist
reine Daten: 14 Farbwerte je Modus (hell/dunkel), alle als `#rrggbb`. Es gibt
keine Serverkomponente und keine Migration — die Auswahl liegt in diesem
Browser (`localStorage`, Schlüssel `sf.theme`, eigenes Theme
`sf.theme.custom`), genau wie der Hell-/Dunkelmodus (`sf.mode`).

## Mitgelieferte Themes

| ID           | Name       | Charakter                                  |
| ------------ | ---------- | ------------------------------------------ |
| `instrument` | Instrument | Papier, Tinte, Kobalt — das Standarddesign |
| `nordlicht`  | Nordlicht  | Kühles Graublau, tiefer Blau-Akzent        |
| `archiv`     | Archiv     | Warmes Papier, gedämpftes Rotbraun         |
| `kontrast`   | Kontrast   | Schwarz auf Weiß, maximale Lesbarkeit      |

Einstellungen → Darstellung → Farbschema. Die Auswahl gilt sofort für Hell- und
Dunkelmodus.

## Eigenes Theme

Zwei Wege führen zu einem eigenen Theme:

1. **Akzent- und Papierfarbe** im Theme-Editor. Daraus werden alle Tokens
   abgeleitet; jede Textfarbe wird so weit verschoben, bis die Kontrastregeln
   erfüllt sind.
2. **Theme-JSON** einfügen. Zwei Formen sind erlaubt, beide optional mit
   `"schemaVersion": 1`:

```json
{ "name": "Moor", "accent": "#0f766e", "paper": "#f1f5f2" }
```

```json
{
  "schemaVersion": 1,
  "name": "Moor",
  "light": {
    "paper": "#f1f5f2",
    "paperRaised": "#f8faf8",
    "surface": "#ffffff",
    "ink": "#0f1512",
    "inkSoft": "#46534d",
    "inkMuted": "#5d6a63",
    "line": "#d9e2dd",
    "lineStrong": "#adb9b3",
    "cobalt": "#0f766e",
    "cobaltDeep": "#0a5a54",
    "signal": "#c2410c",
    "good": "#2f6b46",
    "warn": "#7a4a00",
    "bad": "#a32015"
  },
  "dark": {
    "paper": "#0c1210",
    "paperRaised": "#111814",
    "surface": "#151d18",
    "ink": "#e9f0ec",
    "inkSoft": "#b8c5be",
    "inkMuted": "#9aa8a1",
    "line": "#24302a",
    "lineStrong": "#37453d",
    "cobalt": "#5fd6b4",
    "cobaltDeep": "#3fbf9d",
    "signal": "#ff9a5c",
    "good": "#5fd6a4",
    "warn": "#f0b447",
    "bad": "#ff8b7a"
  }
}
```

Unbekannte Schlüssel, fehlende Tokens, Nicht-Hex-Werte oder ein zu dunkles
Papier werden abgelehnt. Vollständige Tokens müssen die Kontrastregeln unten
erfüllen, sonst wird die Datei mit „zu wenig Kontrast" zurückgewiesen — ein
importiertes Theme kann die Oberfläche also nicht unlesbar machen. Der Export
schreibt immer die vollständige Form.

## Neues mitgeliefertes Theme

`web/src/lib/themes.ts`:

1. Palette unter `PALETTES` ergänzen (hell und dunkel, alle 14 Tokens).
2. Eintrag in `CATALOG` mit ID, deutschem und englischem Namen ergänzen.
3. `web/test/themes.test.ts` prüft automatisch Kontrast, Hex-Normalisierung und
   Vollständigkeit. Die CSS-Defaults in `web/src/index.css` gelten nur für das
   Startdesign (`instrument`) und sind ebenfalls an die Katalogwerte gebunden.

Ein Theme ohne alle Tokens ist kein gültiges Theme; abgeleitete Themes (Weg 1)
füllen fehlende Werte bewusst nicht auf.

## Kontrastregeln

Geprüft in `web/src/lib/themes.ts` (`CONTRAST_RULES`), pro Modus:

| Vordergrund                     | Hintergrund                       | Minimum |
| ------------------------------- | --------------------------------- | ------- |
| `ink`                           | `paper`, `surface`, `paperRaised` | 12:1    |
| `inkSoft`                       | `paper`, `surface`                | 5.5:1   |
| `inkMuted`                      | `paper`, `surface`                | 4.5:1   |
| `cobalt`, `good`, `warn`, `bad` | `paper`, `surface`                | 4.5:1   |
| `signal` (Akzent, kein Text)    | `paper`, `surface`                | 2.5:1   |

## KI-Schnittstelle

Das Theme-Format ist bewusst genau das, was ein Sprachmodell erzeugen kann: ein
kleines JSON-Objekt mit `name`, `accent` und `paper`. Ein KI-Assistent trägt
dieses JSON in den Theme-Editor ein, die Kontrastprüfung bleibt die Freigabe.

Das Plugin `llm-providers` (Branch `feat/plugin-llm-providers`, noch nicht auf
`main`) stellt einen internen Completion-Vertrag bereit. Sobald es gemergt ist,
kann ein Button „Theme aus Beschreibung erzeugen" dieses JSON anfordern und in
denselben Import geben. Bis dahin ist der JSON-Import der Anschluss; es gibt
keinen Server-Endpunkt für Themes.
