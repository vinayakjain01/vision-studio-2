# Vision Studio — production image for a container host you control (e.g.
# DigitalOcean, per docs/DEPLOY.md).
#
# NOT currently used to deploy to Render — render.yaml uses Render's own
# native Node build environment instead, after a custom image built here
# crashed `better-sqlite3` at start-up on Render specifically (native binary
# mismatch, not reproducible or diagnosable from outside their build
# infrastructure). Kept for a host where you control the exact base image and
# that class of mismatch does not apply.
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
#  2. This is a low-traffic, internal team tool. A few hundred extra MB of
#     image size costs nothing that matters here; a subtle runtime failure
#     from an over-pruned image does.
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
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Model weights are baked into the IMAGE at build time, not fetched at
# container start. Render's free tier has no persistent disk, so the
# container's filesystem resets on every restart — including every time the
# service wakes from its 15-minute idle sleep. Fetching ~160MB from Hugging
# Face on every wake would make cold starts far slower and depends on that
# endpoint being reachable at exactly the wrong moment. Baking them in means
# the image is self-contained: identical on every restart, no network
# dependency at boot.
RUN npm run models:fetch

RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

# `db:migrate` runs on every container start, not just the first. It only
# creates tables that do not already exist, so this is safe to repeat — and
# on the free tier it is NECESSARY every time, since ./data resets along with
# the rest of the filesystem on each restart. On a host with a real
# persistent disk mounted at ./data, this same command is still correct: it
# is a no-op against an already-migrated database.
CMD ["sh", "-c", "npm run db:migrate && npm start"]
