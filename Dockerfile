FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

# `COPY` keeps the mode of the build context, and an agent worktree runs with
# umask 0077: files arrive as 600 root:root, directories as 700 root:root, and
# the unprivileged runtime user cannot read them. `--chown` makes the image
# independent of the umask of whoever built it.
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node api/package.json ./api/package.json
COPY --chown=node:node web/package.json ./web/package.json
RUN npm ci --omit=dev --workspace @smartflow/api

COPY --chown=node:node api/tsconfig.json ./api/tsconfig.json
COPY --chown=node:node api/scripts ./api/scripts
COPY --chown=node:node api/src ./api/src

WORKDIR /app/api
# npm runs scripts with a restrictive umask, which would leave the generated
# registry unreadable for the unprivileged runtime user.
RUN npm run plugins && chmod 644 src/kernel/plugin-registry.generated.ts \
 && mkdir -p /data && chown node:node /data

# The container binds all interfaces so the port is reachable from outside,
# and keeps its databases on the writable volume instead of the app tree.
ENV SF_HOST=0.0.0.0
ENV SF_DATA_DIR=/data

USER node
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.SF_PORT || 8790) + '/api/v1/health').then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--import", "tsx", "scripts/serve-api.ts"]
