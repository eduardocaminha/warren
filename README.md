# Warren

> A network of interconnected burrows. The control plane and UI for cloud-based custom agents that operate in isolation, self-manage, self-repair, and self-improve.

**Status:** V1, 0.1.0. The manual-run path is end-to-end validated as of 2026-05-09 (see [SPEC.md §11.E](SPEC.md#11e-first-run-validation-2026-05-09)). Scheduler (cron + webhooks) and library API exports are deferred to V2.

Warren composes the os-eco data-plane tools — [canopy](https://github.com/jayminwest/canopy) (prompts), [mulch](https://github.com/jayminwest/mulch) (expertise), [seeds](https://github.com/jayminwest/seeds) (issues), [sapling](https://github.com/jayminwest/sapling) (harness) — and the [burrow](https://github.com/jayminwest/burrow) sandbox runtime into a single deployable system. **One container, one volume, one HTTP API, one UI.**

## What works today

A `warren run claude-code <project> -p "..."` against a real project repo:

1. Resolves the agent from a connected canopy library (`cn render`).
2. Provisions a `bwrap`-isolated burrow under `/data/burrow/` with the agent's `burrow_config`.
3. Seeds the burrow's `.canopy/`, `.mulch/`, and `.seeds/` from the rendered agent.
4. Dispatches the run via burrow's HTTP API and streams NDJSON events back into warren's event log.
5. Reaps per-run mulch deltas into the project's persistent `.mulch/` (last-write-wins by `ts`), closes seeds the agent marked done, and pushes the workspace branch.

The same flow drives the web UI, the `warren` admin CLI, and the HTTP API — all three are thin clients of the same composition pipeline (SPEC §4.3).

## Architecture

```
┌──────────────── container (bwrap-friendly host) ────────────────┐
│  supervisor  ─┬─►  burrow serve   (unix socket: /var/run/...)   │
│  (Bun parent) └─►  warren         (Bun.serve :8080, SPA + API)  │
│                                                                 │
│  /data/                                                         │
│  ├── canopy-repo/         ← cloned agent library                │
│  ├── projects/<o>/<n>/    ← cloned project repos                │
│  ├── burrow/              ← burrow's home (SQLite, workspaces)  │
│  └── warren.db            ← warren's SQLite (runs, events)      │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │  HTTPS (terminated upstream)
                          [browser]
```

The supervisor (`src/supervisor/main.ts`) is the container ENTRYPOINT. It spawns `burrow serve` first, waits for the unix socket to appear, then spawns warren. SIGTERM/SIGINT are forwarded to both children; burrow restarts with a 5-in-60s budget on unexpected exit. See [SPEC.md §10.3](SPEC.md#103-container-layout).

## Quick start (home server)

```bash
git clone https://github.com/jayminwest/warren && cd warren
cp .env.example .env && $EDITOR .env
docker compose up -d
open http://localhost:8080
```

Required `.env` values (see `.env.example` for the full list):

| Variable | Purpose |
|---|---|
| `WARREN_API_TOKEN` | Bearer token on every route except `/healthz`. `openssl rand -hex 32`. |
| `BURROW_API_TOKEN` | Token `burrow serve` requires to bind. `openssl rand -hex 32`. |
| `WARREN_BURROW_TOKEN` | Token warren's burrow client sends. **Must equal `BURROW_API_TOKEN`** — they are the two ends of one channel. |
| `CANOPY_REPO_URL` | Git URL of your canopy agent library. Cloned on first refresh. |
| `ANTHROPIC_API_KEY` | Forwarded to agent runtimes that need it. |
| `GITHUB_TOKEN` | Forwarded for project clones + branch pushes. |

The compose file applies the four bwrap-required security flags (`apparmor=unconfined`, `seccomp=unconfined`, `systempaths=unconfined`, `cap_add: SYS_ADMIN`) — these relax the outer container so burrow's nested userns sandboxes can come up. Removing any one of them breaks `burrow up`.

## Deploy to Fly.io

Same image, same volume layout, same security flags:

```bash
fly launch                                    # uses ./fly.toml
fly volumes create warren_data --size 50 --region sjc
fly secrets set \
    WARREN_API_TOKEN=... \
    BURROW_API_TOKEN=... \
    WARREN_BURROW_TOKEN=... \
    CANOPY_REPO_URL=https://github.com/<you>/agents.git \
    ANTHROPIC_API_KEY=... \
    GITHUB_TOKEN=...
fly deploy
```

## CLI

The `warren` (or `wr`) admin CLI is for ops. The web UI is daily.

```
warren register-agent <name>            refresh canopy + register one agent
warren add-project <git-url>            clone a project under /data/projects
warren run <agent> <project> -p "..."   one-shot, no UI
warren doctor                           burrow reachable? canopy clean? bwrap working?
warren serve                            start the HTTP server (default in entrypoint)
```

Heads up: the CLI binary isn't on container `PATH` yet (`warren-fab1`); inside the container, invoke via `bun run /app/src/cli/main.ts <command>` until that lands.

## HTTP API

```
GET    /agents                       list registered agents (from canopy)
POST   /agents/refresh               re-clone canopy, re-discover
GET    /agents/:name                 rendered agent JSON

GET    /projects                     list cloned projects
POST   /projects                     { gitUrl, defaultBranch? } → clone
DELETE /projects/:id                 remove project

POST   /runs                         { agent, project, prompt } → spawn
GET    /runs                         list (filter by status / agent / project)
GET    /runs/:id                     detail incl. rendered_agent_json
GET    /runs/:id/events?follow=1     NDJSON tail (warren log + live)
POST   /runs/:id/steer               proxy to burrow inbox
POST   /runs/:id/cancel              proxy to burrow cancel

GET    /healthz                      liveness (no auth)
GET    /readyz                       canopy + burrow + first-render check
```

`Authorization: Bearer ${WARREN_API_TOKEN}` on every non-`/healthz` route. Warren does not terminate TLS — front it with Caddy on a home server or rely on Fly's edge.

## Development

```bash
bun install
bun test                                          # all unit tests
bun run lint                                      # biome check
bun run typecheck                                 # tsc --noEmit
bun test && bun run lint && bun run typecheck     # all quality gates
```

UI dev (separate from the server build):

```bash
bun run ui:install
bun run ui:dev
```

The acceptance harness (`scripts/acceptance/`) drives scenario-based end-to-end runs against a live container. See `scripts/acceptance/run.ts` for the entry.

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming, testing conventions, and PR expectations.

## Project layout

```
src/
├── index.ts            library entry (V1: VERSION constant only)
├── core/               types, errors, id minting (ag_*, prj_*, run_*)
├── registry/           canopy → agent definition resolution
├── projects/           GitHub clone management
├── runs/               spawn / stream / reap composition flow (SPEC §4.3)
├── burrow-client/      facade over @os-eco/burrow HttpClient
├── supervisor/         container entrypoint (spawns warren + burrow serve)
├── server/             Bun.serve HTTP API + static UI serving
├── db/                 drizzle schema + bun:sqlite repos
├── cli/                warren admin commands
└── ui/                 React + Vite + shadcn SPA
```

## V1 limitations

Documented in [SPEC.md §11.D](SPEC.md#11d-v1-security-posture-known-limitations) and accepted for this release:

- **Single bearer token.** No rotation, no expiry, no scopes. Loss of `WARREN_API_TOKEN` is full access; rotate by editing `.env` (or `fly secrets set`) and bouncing the container.
- **TLS is upstream's job.** Direct HTTP on a non-loopback bind is a misconfiguration; `warren doctor` warns.
- **Trust-the-socket** between warren and burrow inside the container — they are co-tenanted by design.
- **No CSRF, single-user.** UI calls warren's API with the bearer; CORS is strict.

V2 candidates: scheduler (cron + GitHub webhooks), token-pair (read/write), per-token scopes, audit log, library API exports.

## License

MIT — see [LICENSE](LICENSE).
