# Two stages: the build stage has the toolchain and produces the SPA bundle, the
# runtime stage carries only what the server needs. Both run the same Node
# version, so the bundle cannot be built against a newer runtime than it runs on.
FROM node:22-bookworm-slim AS build
WORKDIR /app

# `COPY` keeps the mode of the build context, and an agent worktree runs with
# umask 0077: files arrive as 600 root:root, directories as 700 root:root, and
# the unprivileged runtime user cannot read them. `--chown` makes the image
# independent of the umask of whoever built it.
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node api/package.json ./api/package.json
COPY --chown=node:node web/package.json ./web/package.json
RUN npm ci

COPY --chown=node:node web ./web
RUN npm run build --workspace @smartflow/web

# The site template is a separate package: its dependencies are installed once
# here, so a build never runs `npm ci` and never needs a registry. The build
# worker copies this directory and symlinks the dependencies in.
COPY --chown=node:node templates/astro-site ./templates/astro-site
RUN cd templates/astro-site && npm ci --omit=dev --no-audit --no-fund

# The runtime image keeps the dependencies of both workspaces minus the
# toolchain; `tsx` is a regular dependency because the server is run through it.
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

# The SPA is served by the API itself, so one container serves one origin.
# `SF_PUBLIC_URL` is deliberately absent: a production process refuses to start
# without an https origin, and baking a default in here would hide exactly that
# misconfiguration. It comes from the environment at `docker run`/compose time.
ENV NODE_ENV=production \
    SF_HOST=0.0.0.0 \
    SF_DATA_DIR=/data \
    SF_WEB_DIR=/app/web/dist
WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/web/dist ./web/dist
COPY --from=build --chown=node:node /app/templates/astro-site ./templates/astro-site
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node api/package.json api/tsconfig.json ./api/
COPY --chown=node:node api/scripts ./api/scripts
COPY --chown=node:node api/src ./api/src

WORKDIR /app/api
# npm runs scripts with a restrictive umask, which would leave the generated
# registry unreadable for the unprivileged runtime user.
RUN npm run plugins && chmod 644 src/kernel/plugin-registry.generated.ts \
 && mkdir -p /data && chown node:node /data

USER node
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.SF_PORT || 8790) + '/api/v1/health').then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--import", "tsx", "scripts/serve-api.ts"]
