# The Caddyfile is baked into the image instead of bind-mounted: a bind mount of
# a single file depends on the host path existing and on the daemon's mount
# capabilities, and it fails outright on hosts with user namespaces. This image
# has no such dependency. The trade-off is a rebuild when the Caddyfile changes.
FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
