# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY bot.js doctor.js healthcheck.js discord-cli.js ./
COPY lib ./lib
COPY test ./test
COPY scripts ./scripts
# A version whose tests fail never produces an image.
RUN npm test && npm run check && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    DATA_DIR=/app/data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json bot.js doctor.js healthcheck.js discord-cli.js discord.sh ./
COPY lib ./lib
RUN mkdir -p data && chown node:node data
USER node
VOLUME ["/app/data"]
# The bridge exits with code 75 when its own gateway health check fails and the restart policy brings it back.
# This check reads data/health.json (rewritten every 30 s), so `docker ps` shows healthy/unhealthy. No ports are opened.
HEALTHCHECK --interval=60s --timeout=10s --start-period=90s --retries=3 CMD ["node", "healthcheck.js"]
CMD ["node", "bot.js"]
