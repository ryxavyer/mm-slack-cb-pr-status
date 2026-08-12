# The canonical deployment artifact. Railway builds this, but so can ECS, Fly, a
# plain EC2 box, or `docker run` on a laptop — nothing here is host-specific.

# ---- build ----------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 compiles a native addon when no prebuild matches the platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Re-resolve to production dependencies only, for copying into the runtime stage.
RUN npm prune --omit=dev

# ---- runtime --------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
COPY package.json ./

# DATABASE_PATH is the only filesystem touchpoint. Mount a volume here (Railway
# volume, EBS-backed path, docker -v …) or the database is lost on restart.
ENV DATABASE_PATH=/data/bot.sqlite
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

# Run unprivileged; `node` exists in the base image.
USER node

# No EXPOSE: every connection this process makes is outbound (Socket Mode
# WebSocket + GitHub REST). There is nothing to route inbound traffic to.

# Exec form so the process is PID 1 and receives SIGTERM directly — the graceful
# shutdown path depends on it.
CMD ["node", "dist/index.js"]
