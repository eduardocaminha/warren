# Warren container image (SPEC §10.3).
#
# Two-stage build:
#   1. ui-builder — build the React/Vite SPA into src/ui/dist.
#   2. runtime    — bun + bwrap + uidmap, warren source, the four os-eco
#                   CLIs warren shells out to plus burrow itself, and the
#                   SPA bundle copied from stage 1.
#
# The supervisor (src/supervisor/main.ts) is the ENTRYPOINT — it owns
# spawning + signal-forwarding + restart policy for `burrow serve` and
# warren's HTTP server. See SPEC §10.3 for the contract.
#
# The four `bwrap` security flags (apparmor=unconfined, seccomp=unconfined,
# systempaths=unconfined, cap_add=SYS_ADMIN) are applied by the orchestrator
# (docker-compose.yml or fly.toml), not the image. See SPEC §5.3 + §11.A
# and burrow's DEPLOY.md for the rationale.

# ---------- stage 1: build the UI ----------
FROM oven/bun:1.2 AS ui-builder
WORKDIR /ui-build
COPY src/ui/package.json src/ui/bun.lock src/ui/tsconfig.json ./
COPY src/ui/tsconfig.app.json src/ui/tsconfig.node.json ./
COPY src/ui/vite.config.ts src/ui/index.html ./
COPY src/ui/src ./src
RUN bun install --frozen-lockfile
RUN bun run build

# ---------- stage 2: runtime ----------
FROM oven/bun:1.2

# bubblewrap is the sandbox primitive burrow uses (see burrow DEPLOY.md);
# uidmap provides newuidmap/newgidmap for the userns nesting. ca-certificates
# is needed by git over https.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bubblewrap \
        uidmap \
        git \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# os-eco CLIs warren shells out to during run setup, reap, and project
# management, plus burrow itself (the supervisor execs `burrow serve`).
# Versions track each tool's current release; bumping them is a deliberate
# image-rebuild decision.
RUN bun install -g \
    @os-eco/burrow-cli@0.2.1 \
    @os-eco/canopy-cli@0.2.3 \
    @os-eco/seeds-cli@0.4.1 \
    @os-eco/mulch-cli@0.8.0 \
    @os-eco/sapling-cli@0.3.1

WORKDIR /app

# Server-side dependencies. Copy lockfiles first so a code-only edit
# doesn't bust the bun install layer.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Source. Excludes are listed in .dockerignore (node_modules, data, .env,
# src/ui/node_modules, src/ui/dist) so we don't ship dev artefacts.
COPY . /app

# Pull the prebuilt UI bundle from stage 1.
COPY --from=ui-builder /ui-build/dist /app/src/ui/dist

# Default data root — the deploy mounts a persistent volume here.
ENV WARREN_DATA_DIR=/data
ENV WARREN_BURROW_SOCKET=/var/run/burrow.sock

# /data is a persistence boundary (sqlite + cloned canopy + cloned project
# repos). /var/run is where the supervisor binds burrow's unix socket; the
# directory must exist for `burrow serve --socket /var/run/burrow.sock`.
RUN mkdir -p /data /var/run

EXPOSE 8080

ENTRYPOINT ["bun", "run", "src/supervisor/main.ts"]
