FROM node:24.22.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --engine-strict
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts --engine-strict

FROM node:24.22.1-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -p /host-metrics/proc /host-metrics/hwmon \
    && touch /host-metrics/proc/stat /host-metrics/proc/meminfo \
             /host-metrics/proc/loadavg /host-metrics/proc/uptime \
    && mkdir -p /app/data \
    && chown node:node /app/data \
    && chmod 0700 /app/data
RUN mkdir -p /app/public-data && chown node:node /app/public-data && chmod 0750 /app/public-data
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/index.js"]

# Public image: only the HTTP service and its allowlisted data contract.
FROM node:24.22.1-bookworm-slim AS dashboard
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist/dashboard.js /app/dist/dashboard-config.js /app/dist/dashboard-server.js /app/dist/dashboard-data.js /app/dist/dashboard-healthcheck.js ./dist/
COPY --chown=node:node web ./web
RUN mkdir -p /app/public-data /app/tls \
    && chown node:node /app/public-data && chmod 0750 /app/public-data
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "dist/dashboard-healthcheck.js"]
CMD ["node", "dist/dashboard.js"]

# A plain docker build still produces the bot, as before.
FROM runtime AS bot
