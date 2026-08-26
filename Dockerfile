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
COPY team-map.json ./

# DATABASE_PATH is the only filesystem touchpoint. Mount a volume here (Railway
# volume, EBS-backed path, docker -v …) or the database is lost on restart.
#
# Deliberately no VOLUME instruction: Railway's builder rejects it, and it buys
# nothing here. Its only effect is to auto-create an *anonymous* volume when the
# operator forgets to mount one — which hides the mistake rather than surfacing
# it. Mount explicitly instead; see deploy/RUNBOOK.md.
ENV DATABASE_PATH=/data/bot.sqlite
RUN mkdir -p /data && chown -R node:node /data

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# No `USER node` here: the entrypoint starts as root purely to make the mounted
# volume writable, then drops to `node` itself. Setting USER would leave the
# process unable to create its database in a root-owned mount.

# No EXPOSE: every connection this process makes is outbound (Socket Mode
# WebSocket + GitHub REST). There is nothing to route inbound traffic to.

# Exec form throughout so the app ends up as PID 1 and receives SIGTERM directly
# — the graceful shutdown path depends on it.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
