FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY api/package.json ./api/package.json
COPY web/package.json ./web/package.json
RUN npm ci --omit=dev --workspace @smartflow/api

COPY api/tsconfig.json ./api/tsconfig.json
COPY api/scripts ./api/scripts
COPY api/src ./api/src

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
CMD ["node", "--import", "tsx", "scripts/serve-api.ts"]
