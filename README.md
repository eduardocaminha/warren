# Warren

Spawn cloud agents at your GitHub repos. Watch them work live, steer them mid-run, get a branch back.

[![CI](https://github.com/jayminwest/warren/actions/workflows/ci.yml/badge.svg)](https://github.com/jayminwest/warren/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> A network of interconnected burrows. Agents that operate in isolation, self-manage, self-repair, and self-improve.

Warren is a self-hostable control plane for ephemeral coding agents — short-lived, sandboxed runs that complete a task, validate the changes, push a branch, and spin down. Point it at your repos, dispatch from a browser or CLI, watch the events stream live, and reap the result. **One container, one volume, one HTTP API, one UI.**

A fresh install needs nothing but a GitHub URL and a prompt. The built-in `claude-code` agent ships inline; pick it, paste your repo, write what you want done. Power features — versioned prompt libraries, persistent agent memory, an integrated issue queue, a steerable alternative harness — light up when you opt into them.

## Who this is for

Engineering teams self-hosting their own agent infrastructure — not a SaaS, not a hosted product. The deployment unit is one team or one org running one warren on their own box, their own Fly account, or (post-V1) their own cluster. Run it for yourself on a home server today; the [post-V1 direction](SPEC.md#11j-org-readiness-direction-2026-05-11) extends the same architecture to a 50+ engineer organization without forcing a fork.

## Status

V1 (`0.1.7`). The manual-run path is end-to-end validated against a deployed Fly.io instance ([SPEC §11.E](SPEC.md#11e-first-run-validation-2026-05-09)) and exercised by 16 scenario-based acceptance tests in [`scripts/acceptance/`](scripts/acceptance/). The cron half of the scheduler now ships in V1 ([SPEC §11.I](SPEC.md)); GitHub webhook triggers and library API exports remain deferred to V2. V1 is single-user / single-host as shipped; the [org-readiness cluster](ROADMAP.md#org-readiness-cluster-r-12--r-18) (SSO, remote burrow workers, Postgres backend, MCP, audit, budgets, GitHub App) is the active forward direction.

## What you get

- **One image, one volume.** The supervisor (`src/supervisor/main.ts`) is the container ENTRYPOINT — it spawns the sandbox runtime first, waits for the unix socket, then spawns warren. SIGTERM/SIGINT forward to both children; the runtime restarts under a 5-in-60s budget on unexpected exit.
- **Native sandboxing per run.** Every run gets a fresh `bwrap`-isolated workspace under `/data/burrow/`. The host is unreachable; warren talks to the runtime over a unix socket with a shared bearer token.
- **Built-in agents.** `claude-code`, `sapling`, and `pi` ship inline (`src/registry/builtins/`) — no library, no config, no extra setup to dispatch a run.
- **Live event stream.** NDJSON events are persisted to warren's SQLite log and tailed over `GET /runs/:id/events?follow=1`. The UI, CLI (`warren run`), and HTTP clients all consume the same stream.
- **Steerable mid-run.** `POST /runs/:id/steer` lands a message in the agent's inbox; the next turn picks it up. `POST /runs/:id/cancel` aborts cleanly.
- **Scheduled runs.** `.warren/triggers.yaml` defines cron triggers per project; the in-process scheduler dispatches them on the same composition path as manual runs.
- **Three thin clients of one pipeline.** Web UI, `warren` admin CLI, and HTTP API all flow through the same composition path ([SPEC §4.3](SPEC.md#43-the-composition-flow)).

## Quickstart (home server)

```bash
git clone https://github.com/jayminwest/warren && cd warren
cp .env.example .env && $EDITOR .env
docker compose up -d
open http://localhost:8080
```

Paste your `WARREN_API_TOKEN`, click **Projects → Add**, give it a GitHub URL. Then **Dispatch run**, pick `claude-code`, write a prompt, hit go. The events panel streams; when the run completes warren pushes a branch you can open a PR from.

Required environment variables (see [`.env.example`](.env.example) for the full list):

| Variable | Purpose |
|---|---|
| `WARREN_API_TOKEN` | Bearer token on every route except `/healthz`. `openssl rand -hex 32`. |
| `BURROW_API_TOKEN` | Token the sandbox runtime requires to bind. `openssl rand -hex 32`. |
| `WARREN_BURROW_TOKEN` | Token warren's runtime client sends. **Must equal `BURROW_API_TOKEN`** — they are the two ends of one channel. |
| `ANTHROPIC_API_KEY` | Forwarded to agent runtimes that need it. |
| `GITHUB_TOKEN` | Forwarded for project clones + branch pushes. |

The compose file applies the four bwrap-required security flags (`apparmor=unconfined`, `seccomp=unconfined`, `systempaths=unconfined`, `cap_add: SYS_ADMIN`) — these relax the outer container so the runtime's nested userns sandboxes can come up. Removing any one of them breaks sandbox provisioning.

## Deploy to Fly.io

Same image, same volume layout, same security flags:

```bash
fly launch                                    # uses ./fly.toml
fly volumes create warren_data --size 50 --region sjc
fly secrets set \
    WARREN_API_TOKEN=... \
    BURROW_API_TOKEN=... \
    WARREN_BURROW_TOKEN=... \
    ANTHROPIC_API_KEY=... \
    GITHUB_TOKEN=...
fly deploy
```

## Power features (opt-in)

Warren bundles a small set of [os-eco](https://github.com/jayminwest/os-eco) tools as built-in features. None of them are required to dispatch a run — they light up when you use them, stay silent when you don't.

### Custom agents — bring your own prompt library

The built-in `claude-code`, `sapling`, and `pi` agents cover the common case. To define custom agents as versioned prompts (with inheritance, mixins, and per-agent sandbox config), point warren at a [canopy](https://github.com/jayminwest/canopy) repo:

```bash
fly secrets set CANOPY_REPO_URL=https://github.com/<you>/agents.git
```

Library agents override built-ins by name. See [SPEC §4.2](SPEC.md#42-the-bundle-expressed-in-canopy) for the agent-as-prompt schema.

### Agent memory — persistent expertise across runs

If a project has a `.mulch/` directory, every run gets that expertise primed into context on spawn. As the agent learns conventions, patterns, and failure modes, it records them with `ml record`; reap merges the new records back to the project's persistent `.mulch/` with last-write-wins by timestamp. Memory accumulates across runs without a database, just files in the repo. See [mulch](https://github.com/jayminwest/mulch).

### Issue queue — agents work from and write to seeds

If a project has a `.seeds/` directory, agents can `sd ready` for unblocked work, claim it with `sd update`, file follow-ups with `sd create`, and close completed seeds with `sd close`. Reap closes any seeds the agent marked done. The trigger scheduler can also fire on past-due `extensions.scheduledFor` seed timestamps ([SPEC §11.I](SPEC.md)). See [seeds](https://github.com/jayminwest/seeds).

### Steerable harness — sapling as an alternative to claude-code

The built-in `sapling` agent is a headless coding harness with proactive context management. Use it the same way you'd use `claude-code`. See [sapling](https://github.com/jayminwest/sapling).

## Architecture

```
┌──────────────── container (bwrap-friendly host) ────────────────┐
│  supervisor  ─┬─►  sandbox runtime  (unix socket: /var/run/...) │
│  (Bun parent) └─►  warren           (Bun.serve :8080, SPA + API)│
│                                                                 │
│  /data/                                                         │
│  ├── canopy-repo/         ← optional cloned agent library       │
│  ├── projects/<o>/<n>/    ← cloned project repos                │
│  ├── burrow/              ← runtime home (SQLite, workspaces)   │
│  └── warren.db            ← warren's SQLite (runs, events)      │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │  HTTPS (terminated upstream)
                          [browser]
```

Under the hood, warren talks to [burrow](https://github.com/jayminwest/burrow) as the sandbox runtime — they are co-tenanted inside the container, share a unix socket, and share a bearer token (`BURROW_API_TOKEN` == `WARREN_BURROW_TOKEN`). See [SPEC §10.3](SPEC.md#103-container-layout) for the full layout.

## CLI

The `warren` (or `wr`) admin CLI is for ops; the web UI is daily.

| Command | Description |
|---|---|
| `warren register-agent <name>` | Refresh canopy + register one agent |
| `warren add-project <git-url>` | Clone a project under `/data/projects` |
| `warren run <agent> <project> -p "..."` | One-shot run, no UI |
| `warren doctor` | Runtime reachable? Bwrap working? |
| `warren serve` | Start the HTTP server (default in entrypoint) |

`warren run claude-code <project> -p "..."` does the full composition end-to-end: resolves the agent (built-in or library), provisions the sandbox, dispatches the run, streams events back, then pushes the branch. If the project has `.mulch/` or `.seeds/`, those round-trip too.

## HTTP API

```
GET    /agents                       list registered agents
POST   /agents/refresh               re-clone the optional canopy library
GET    /agents/:name                 rendered agent JSON

GET    /projects                     list cloned projects
POST   /projects                     { gitUrl, defaultBranch? } → clone
POST   /projects/:id/refresh         git fetch + reset to upstream HEAD
DELETE /projects/:id                 remove project
GET    /projects/:id/warren-config   parsed .warren/ envelope
GET    /projects/:id/triggers        scheduler state per trigger
POST   /projects/:id/triggers/:tid/run   dispatch a trigger inline

POST   /runs                         { agent, project, prompt } → spawn
GET    /runs                         list (filter by status / agent / project)
GET    /runs/:id                     detail incl. rendered_agent_json
GET    /runs/:id/events?follow=1     NDJSON tail (warren log + live)
POST   /runs/:id/steer               proxy to runtime inbox
POST   /runs/:id/cancel              proxy to runtime cancel

GET    /healthz                      liveness (no auth)
GET    /readyz                       runtime + first-render check
```

`Authorization: Bearer ${WARREN_API_TOKEN}` is required on every non-`/healthz` route. Warren does not terminate TLS — front it with Caddy on a home server, or rely on Fly's edge.

## Development

Requires [Bun](https://bun.sh) v1.1+.

```bash
bun install
bun test                                          # all unit tests
bun run lint                                      # biome check --error-on-warnings
bun run typecheck                                 # tsc --noEmit
bun test && bun run lint && bun run typecheck     # all quality gates
```

UI development (separate from the server build):

```bash
bun run ui:install
bun run ui:dev
```

The acceptance harness in [`scripts/acceptance/`](scripts/acceptance/) drives 16 scenario-based end-to-end runs against a live container — covering boot health, agent refresh, project lifecycle, run spawn/stream/cancel/steer, restart recovery, mulch + seeds round-tripping, doctor exit codes, supervisor restart-budget, container-mode parity, `.warren/` config lifecycle, cron + scheduled-for trigger dispatch, and the pi built-in parity smoke. See [ACCEPTANCE.md](ACCEPTANCE.md) for the runbook.

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming, testing conventions, and PR expectations.

## Project layout

```
src/
├── index.ts            library entry (V1: VERSION constant only)
├── core/               types, errors, id minting (ag_*, prj_*, run_*)
├── registry/           agent definition resolution (built-in + library)
├── projects/           GitHub clone management
├── runs/               spawn / stream / reap composition flow (SPEC §4.3)
├── triggers/           cron + scheduled-for dispatcher (SPEC §11.I)
├── warren-config/      .warren/ per-project config loader + cache (SPEC §11.H)
├── burrow-client/      facade over the sandbox runtime's HttpClient
├── supervisor/         container entrypoint (spawns warren + runtime)
├── server/             Bun.serve HTTP API + static UI serving
├── db/                 drizzle schema + bun:sqlite repos
├── cli/                warren admin commands
└── ui/                 React + Vite + shadcn SPA
```

## V1 today

Documented in [SPEC §11.D](SPEC.md#11d-v1-security-posture-known-limitations) and accepted for this release:

- **Single bearer token.** No rotation, no expiry, no scopes. Loss of `WARREN_API_TOKEN` is full access; rotate by editing `.env` (or `fly secrets set`) and bouncing the container.
- **TLS is upstream's job.** Direct HTTP on a non-loopback bind is a misconfiguration; `warren doctor` warns.
- **Trust-the-socket** between warren and the runtime inside the container — they are co-tenanted by design.
- **No CSRF, single-user.** UI calls warren's API with the bearer; CORS is strict.
- **SQLite-only state.** Run history and scheduler state live in `/data/warren.db` on the local volume.
- **One host is the concurrency ceiling.** Sandboxes run inside the warren container; horizontal scale-out across machines isn't a V1 feature.

## Where this is going

The org-readiness cluster recorded in [SPEC §11.J](SPEC.md#11j-org-readiness-direction-2026-05-11) is the active direction — the seams to extend warren from "one team, one box" to "50-engineer org, their own infra":

- **Remote sandbox workers** ([R-12](ROADMAP.md)) — one warren dispatching across many runtime workers; lifts the single-host ceiling. Runtime-side protocol design is in flight as `burrow-c47a`.
- **Bring-your-own database** ([R-13](ROADMAP.md)) — `WARREN_DB_URL` with Postgres as a first-class backend alongside SQLite, so org state lives where the SRE team can operate it.
- **SSO / per-user identity** ([R-09](ROADMAP.md)) — OIDC login replacing the shared bearer; the bearer stays as a service-account path for CI.
- **MCP support** ([R-15](ROADMAP.md)) — agents declare `mcp_servers` in their prompt frontmatter; warren plumbs credentials into the sandbox.
- **Cross-project activity UI + stable OpenAPI** ([R-14](ROADMAP.md)) — a "what is every agent doing right now" view, plus a versioned API contract so teams can build their own dashboards.
- **Audit log** ([R-16](ROADMAP.md)) and **cost / concurrency guardrails** ([R-17](ROADMAP.md)) — the security-review and budget-control surface that follows from real user identity.
- **GitHub App auth** ([R-18](ROADMAP.md)) — installation-scoped, short-lived per-run tokens replacing the shared PAT.

Each item is additive — none of them change V1's shipped behavior when the relevant feature is unconfigured. See [ROADMAP.md](ROADMAP.md) for full design sketches and sequencing.

## Security

Found a vulnerability? Please follow the disclosure process in [SECURITY.md](SECURITY.md).

## Part of os-eco

Warren is part of the [os-eco](https://github.com/jayminwest/os-eco) AI agent tooling ecosystem.

<p align="center">
  <img src="https://raw.githubusercontent.com/jayminwest/os-eco/main/branding/logo.png" alt="os-eco" width="444" />
</p>

## License

MIT — see [LICENSE](LICENSE).
