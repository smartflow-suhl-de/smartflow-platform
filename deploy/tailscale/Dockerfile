# Serve-Konfiguration ins Image gebacken statt als Einzeldatei-Bind-Mount:
# auf Hosts mit User-Namespaces erscheint eine einzelne gemountete Datei als
# leeres Verzeichnis (gleiche Begründung wie bei jeder einzelnen Konfigurationsdatei).
# Gepinnt (Tag + Digest) gegen Supply-Chain-Drift; Update bewusst per PR.
FROM tailscale/tailscale:v1.104.7@sha256:72c1e19e0aedca96b8533bbb0b4368564410ff20b17e53b804eb6c1f04a31be4
COPY serve.json /config/serve.json
