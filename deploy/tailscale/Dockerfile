# Serve-Konfiguration ins Image gebacken statt als Einzeldatei-Bind-Mount:
# auf Hosts mit User-Namespaces erscheint eine einzelne gemountete Datei als
# leeres Verzeichnis (gleiche Begründung wie beim Caddyfile).
FROM tailscale/tailscale:latest
COPY serve.json /config/serve.json
