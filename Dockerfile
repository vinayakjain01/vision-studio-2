# Vision Studio — production image for a container host you control (a VPS,
# DigitalOcean/Linode/Hetzner droplet, etc. — see docs/DEPLOY.md for the full
# first-deploy walkthrough with Caddy in front of it).
#
# Single stage, deliberately. The obvious optimisation is a multi-stage build
# that prunes devDependencies out of the final image, but two things in this
# app make that a net loss:
#
#  1. `tsx` runs the worker pool's TypeScript source DIRECTLY in production,
#     not a compiled output — see src/jobs/pool.ts. Pruning has to be exact
#     about what the workers import at runtime, and getting that wrong is a
#     production-only crash that never reproduces locally. Keeping the full
#     dependency tree removes that whole class of mistake.
#  2. This app's traffic profile does not justify shaving image size at the
#     cost of that risk. A subtle runtime failure from an over-pruned image
#     costs far more than a few hundred extra MB.
#
# Base is `node:20-slim` (Debian, glibc) rather than an Alpine image: sharp,
# better-sqlite3, onnxruntime-node and @napi-rs/canvas all ship prebuilt
# native binaries for glibc-linux. Alpine's musl libc does not match those
# prebuilds, and forcing a from-source rebuild of four native addons in a
# container is exactly the kind of slow, fragile build worth avoiding when a
# stock Debian base sidesteps it entirely.

FROM node:20-slim

# Fallback compiler toolchain for node-gyp. `node:20-slim` ships no compiler at
# all. sharp, better-sqlite3, onnxruntime-node and @napi-rs/canvas each publish
# prebuilt binaries for glibc-linux and normally skip compiling entirely — but
# "normally" is doing work in that sentence. If npm's prebuild lookup for any
# one of them misses (an arch/libc combination the maintainer didn't publish
# for, a registry hiccup, a version bump that lagged its prebuild release),
# node-gyp is the fallback, and node-gyp with no python3/make/g++ present fails
# immediately with almost no diagnostic output — exactly the failure this
# guards against, whichever package turns out to have triggered it.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Installed separately from the rest of the source so this layer only
# rebuilds when dependencies actually change, not on every code edit.
# `npm ci` (not `npm install`) — always installs exactly what's in
# package-lock.json, never resolves or writes a new lockfile.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Model weights are baked into the IMAGE at build time, not fetched at
# container start — the whole point being a container's filesystem can be
# replaced (a redeploy, a fresh host) without re-downloading ~160MB from
# Hugging Face at exactly the wrong moment (a cold start an operator is
# actively waiting on).
RUN npm run models:fetch

RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

# Non-root. `node:20-slim` already ships a `node` user (uid 1000) for exactly
# this — no need to create a new one. `/app/data` is where the SQLite files
# and every tenant's media live (see src/config.ts's `dataDir`, normally a
# mounted volume in production); it has to be writable by this user BEFORE
# the volume is mounted over it, because a volume mount takes on whatever
# ownership the mount point already has only on FIRST creation — fixing
# permissions after the fact on an existing volume is an operator's job (see
# docs/OPERATIONS.md), not this image's.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

COPY --chown=node:node docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Hits the real readiness check (src/app/api/health/route.ts) — a writable
# control.db AND a writable data directory, not just "the process is up".
# node's own fetch (global since Node 18) avoids needing curl/wget installed
# in the image just for this.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/app/docker-entrypoint.sh"]
# Invokes next's own binary directly rather than `npm start` — one fewer
# process layer between PID 1 and the actual server, which
# docker-entrypoint.sh's `exec` depends on for SIGTERM to reach the right
# process (see that file's own comment, and src/jobs/shutdown.ts).
CMD ["node_modules/.bin/next", "start"]
