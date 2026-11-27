# Astro-Vorlage für Websites

Jede Website ohne eigenes Repository wird aus dieser Vorlage gebaut. Der
Build-Worker der Plattform kopiert das Verzeichnis, schreibt
`content/site.json` und pro Route eine Markdown-Datei nach `content/pages` und
startet `astro build`.

## Aufbau

- `content/pages/*.md`: eine Datei je Route. `index.md` ist die Startseite,
  `zimmer/suite.md` wird zu `/zimmer/suite/`. Frontmatter: `title`, `order`.
- `content/site.json`: Name und kurzer Untertitel der Website.
- `src/layouts/Site.astro`: Gerüst mit den Farben und Schriftgrößen aus
  `DESIGN.md`, ohne externe Schriften oder Skripte.
- `src/pages/index.astro`, `src/pages/[...slug].astro`: rendern die Sammlung.

## Zwei Regeln, die nicht offensichtlich sind

1. **`workspaces: []` in `package.json` bleibt.** Vite sucht seinen
   Workspace-Wurzelpunkt, indem es Verzeichnisse aufwärts läuft. Ohne diesen
   Eintrag läuft die Suche über das Build-Verzeichnis hinaus bis `/`, und die
   Leserechte des Build-Prozesses brechen den Build ab. Der Eintrag beendet die
   Suche an der Projektwurzel.
2. **`node_modules` ist nicht Teil der Vorlage, sondern des Images.** Der Build
   läuft ohne Netzwerk und ohne `npm ci`; die Abhängigkeiten werden beim
   Image-Build installiert und zur Laufzeit unter dem Build-Verzeichnis
   bereitgestellt.

## Selbst bauen

```
npm ci
npm run build
```

`dist/` enthält die fertigen Seiten. Die Auslieferung übernimmt die Plattform
über einen eigenen Port je Website.