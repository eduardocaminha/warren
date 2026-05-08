# Warren — Specification

> A network of interconnected burrows. The control plane and UI for cloud-based custom agents that operate in isolation, self-manage, self-repair, and self-improve.

**Status:** Design phase, draft.
**Last updated:** 2026-05-08.
**CLI:** `warren` / `wr` (TBD).
**Package:** `@os-eco/warren` (TBD).

---

## 1. TL;DR

Warren is the platform layer for the os-eco agent ecosystem. It composes the four data-plane tools (canopy, mulch, seeds, sapling) and the runtime substrate (burrow) into a single deployable system that runs on a home server or in the cloud.

A user defines a custom agent as a versioned canopy prompt (with structured sections like `system`, `skills`, `expertise_seed`, `burrow_config`). Warren spawns that agent against a project repo inside a burrow sandbox, streams events back, persists outcomes, and lets the agent self-manage its own work queue (seeds), self-repair from past failures (mulch), and self-improve by recording new expertise. A web UI sits on top of the same HTTP API that any external orchestrator could call.

V1 is single-user, single-host: clone warren, `docker compose up`, browser at `localhost:8080`. The same image runs on Fly.io with a volume and three secrets. No cross-tenant story, no SaaS, no auth beyond a bearer token.

---

## 2. Vision

### 2.1 The day-in-the-life

```
$ git clone https://github.com/jaymin/warren && cd warren
$ cp .env.example .env && $EDITOR .env   # CANOPY_REPO_URL, ANTHROPIC_API_KEY, GITHUB_TOKEN
$ docker compose up -d
$ open http://homeserver.local:8080
```

In the UI:
1. **Connect agent library** — Warren clones your canopy repo. Every prompt with the `agent: true` schema tag becomes a registered agent (`refactor-bot`, `docs-bot`, `sre-bot`, ...).
2. **Add project** — paste a GitHub URL. Warren clones it under `/data/projects/`.
3. **Spawn run** — pick agent + project + prompt. Warren provisions a burrow, renders the canopy agent into it, dispatches the run, streams events to the UI.
4. **Watch and steer** — live event tail, send steering messages, see seeds the agent files for itself, see mulch records the agent records as it learns.
5. **Schedule** — "every 6 hours, run docs-bot against repo X" or "on PR open, run reviewer-bot." Cron and trigger-driven runs.

### 2.2 What Warren is

- The **control plane**: one process, one HTTP API, one volume.
- The **glue**: shells out to mulch/seeds/canopy/sapling CLIs, talks to burrow over its HTTP API.
- The **UI**: web frontend served from the same process.
- The **scheduler**: cron and event-triggered runs.
- The **agent registry**: reads canopy, surfaces installable roles.

### 2.3 What Warren is not

- Not a coding agent. Burrow runs them; sapling/claude-code are them; warren orchestrates.
- Not a sandbox. Burrow owns isolation.
- Not an issue tracker. Seeds owns the work queue.
- Not a prompt manager. Canopy owns the agent definitions.
- Not an expertise store. Mulch owns memory.
- Not a multi-tenant SaaS. One token, one user, one box.

Warren is a thin coordinator — most of the value is in the four CLIs and burrow. Warren's job is to compose them into a deployable system with a UI on top.

---

## 3. Goals & Non-Goals

### 3.1 V1 Goals

- Single-image deploy: `docker compose up` on a home server, `fly deploy` on Fly.io, same Dockerfile.
- Web UI for: agent registry, project list, run dispatch, live event tail, scheduled runs, basic settings.
- HTTP API mirroring the UI's surface so external scripts can drive warren.
- Custom-agent-as-canopy-prompt: an agent is a single canopy prompt with required sections; warren auto-discovers from a connected canopy repo.
- Runs against project repos cloned into warren's data dir from GitHub URLs.
- Cron-scheduled runs and a webhook surface for trigger-driven runs.
- Self-* loop: agents read seeds queue, write seeds for follow-ups, record mulch on success/failure, prime mulch on next spawn.

### 3.2 V1 Non-Goals

- No multi-tenant auth, no per-user RBAC. Single bearer token, one user.
- No agent marketplace. Agents come from your own canopy repo.
- No remote burrow workers. Burrows run inside warren's container; no FlyProvider-driven worker pool.
- No laptop-driven `burrow up` against warren. The home server is the canonical deploy.
- No real-time collaboration. One UI, one user at a time.
- No payment, no usage metering, no quota.

### 3.3 The seams that matter

- **Burrow HTTP API** (burrow's `pl-5b40` / `burrow-1d64`) — warren never imports burrow as a library. HTTP only, so warren and burrow can be independent processes inside one container.
- **Canopy as agent source** — agents are not warren records, they are canopy prompts. Warren is a read-mostly consumer of canopy.
- **CLI shell-out for mulch/seeds/canopy** — these tools are git-native, file-locked, atomic. Warren does not embed their state; it shells out.
- **HTTP API for warren itself** — the UI is one consumer; greenhouse, ad-hoc scripts, and future orchestrators are others.

---

## 4. Mental Model

### 4.1 The four sides of a custom agent

| Side | Where it lives | Tool |
|---|---|---|
| **Mind** (persona, skills) | `.canopy/prompts.jsonl` (agent library repo) | canopy |
| **Memory** (expertise) | `.mulch/expertise/<domain>.jsonl` (per-project) | mulch |
| **Worklist** (tasks) | `.seeds/issues.jsonl` (per-project) | seeds |
| **Body** (loop, tools) | `sapling` or `claude-code` | sapling / claude-code |

Burrow is the cell the agent runs in. Warren is the operator that picks who runs where, when, and on what.

### 4.2 The bundle, expressed in canopy

An agent is a single canopy prompt with a schema-validated set of sections:

```yaml
name: refactor-bot
extends: base-coding-agent              # canopy inheritance
sections:
  system: |
    You are a refactor-focused agent. Prefer small, reviewable diffs...
  skills:                                # mixin'd from canopy children
    - run-tests
    - open-pr
    - investigate-flake
  expertise_seed: |
    {"type":"convention","domain":"refactor","content":"..."}
    {"type":"failure","domain":"refactor","description":"...","resolution":"..."}
  burrow_config: |
    [toolchain]
    bun = "1.1"
    [sandbox]
    network = "restricted"
    allowed_domains = ["api.anthropic.com", "github.com", "registry.npmjs.org"]
  workflow: |
    # seeds plan template name to use
    template: refactor
```

Inheritance solves the "thousand repos" problem: `base-coding-agent` defines defaults, role-specific bots override only what differs. One PR to canopy updates every descendant.

### 4.3 The composition flow

When warren spawns a run:

1. **Resolve agent** — `cn render <agent-name>` against the canopy repo. Returns a single object with all sections expanded after inheritance/mixin resolution.
2. **Provision burrow** — call burrow's create-burrow endpoint with the agent's `burrow_config`, pointing at the project workspace.[^burrow-501]
3. **Seed the burrow** — write the rendered `system` + `skills` into the burrow's `.canopy/`; pipe `expertise_seed` lines through `ml record` against the burrow's mulch; install the workflow template into burrow's seeds.
4. **Dispatch** — call burrow's dispatch-run endpoint with the user's prompt + agent identity.
5. **Stream** — subscribe to burrow's NDJSON event tail over the HTTP API; relay to UI subscribers via warren's own `/runs/:id/events?follow=1`.
6. **Reap** — on run completion, capture the agent's mulch additions back to the project's persistent mulch (so learnings accumulate), close any seeds the agent marked done, push the workspace branch.

See burrow's `/openapi.json` for canonical request/response shapes.

[^burrow-501]: Burrow's `POST /burrows` currently returns 501 — warren's provisioning flow is blocked on burrow shipping this (tracked in burrow's `.seeds/`).

The agent's worklist (seeds) belongs to the project, not the agent. Same project worked on by `refactor-bot` today and `sre-bot` tomorrow uses the same seeds queue.

---

## 5. Architecture Overview

```
┌─────── HOME SERVER (Linux container, Mac Pro / Fly.io / etc.) ────────┐
│                                                                        │
│   ┌────────────────────────┐                                           │
│   │ warren                 │                                           │
│   │ ─ HTTP API + UI        │                                           │
│   │ ─ scheduler (cron)     │                                           │
│   │ ─ webhook receiver     │                                           │
│   │ ─ shells out: cn/sd/ml │                                           │
│   │ ─ HTTP: burrow         │                                           │
│   └────┬───────────────────┘                                           │
│        │                                                               │
│        ├─── unix socket: /var/run/burrow.sock                          │
│        │     ┌────────────────────────────────┐                        │
│        │     │ burrow serve                   │                        │
│        │     │ (separate Bun process)         │                        │
│        │     │ owns SQLite + sandboxes        │                        │
│        │     └────────────────────────────────┘                        │
│        │                                                               │
│        └─── shell: cn render / sd ready / ml record / git              │
│                                                                        │
│   /data/                                                               │
│   ├── canopy-repo/         ← cloned agent library                      │
│   ├── projects/<owner>/<name>/  ← cloned project repos                 │
│   ├── burrow/              ← burrow's home: SQLite, workspaces         │
│   └── warren.db            ← warren's SQLite: schedules, run history   │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
                  ▲
                  │ HTTPS
              [browser]
```

### 5.1 Process model

Two long-running processes inside the container:

- **`warren`** — Bun.serve, the platform process. HTTP API + UI + scheduler.
- **`burrow serve`** — Bun.serve over unix socket, the runtime substrate.

Plus short-lived shell-outs to `cn`, `sd`, `ml`, `git` invoked from the warren process.

### 5.2 Why burrow is a separate process

Same reason warren and burrow are separate repos: warren restarts shouldn't kill in-flight agent runs. Burrow's SQLite + run loop persist across warren deploys. The unix socket is the seam.

### 5.3 Sandbox nesting

Burrow runs `bwrap`-isolated agents inside the warren container. The container needs the four flags from `mulch:mx-94901b` / `mulch:mx-c085ba`:

```yaml
security_opt:
  - apparmor=unconfined
  - seccomp=unconfined
  - systempaths=unconfined
cap_add: [SYS_ADMIN]
```

Verified empirically on Docker 28.4 / Ubuntu 24.04. Same recipe applies to Fly.io machines.

---

## 6. Tech Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | **Bun** (≥1.1) | Matches every other os-eco tool. |
| Language | **TypeScript** (strict) | Type safety across server, scheduler, UI. |
| HTTP | **Bun.serve** | Same posture as burrow's `serve` — sufficient, no framework. |
| DB | **`bun:sqlite`** (WAL mode) | Run history, schedules, webhook secrets. Same as burrow. |
| ORM | **Drizzle** | Match burrow. |
| Validation | **Zod 4** | Match burrow. |
| CLI framework | **commander** | Match burrow / mulch / seeds / canopy. |
| Logging | **pino** | Match burrow. |
| Frontend | **React + Vite** (TBD) | Single SPA, served as static files from warren. |
| Cron | **`node-cron`** or in-process timer | One scheduler per warren process. |

No HTTP framework on the server. No Postgres, no Redis, no Docker-in-Docker.

---

## 7. Project Structure

```
warren/
├── package.json                # @os-eco/warren
├── bunfig.toml
├── tsconfig.json
├── biome.json
├── drizzle.config.ts
├── README.md
├── SPEC.md                     # this document
├── CLAUDE.md
├── Dockerfile                  # extends ghcr.io/jayminwest/burrow-base
├── docker-compose.yml          # default home-server compose file
├── fly.toml                    # default Fly deploy template
├── src/
│   ├── index.ts                # public library entry
│   ├── core/
│   │   ├── types.ts            # AgentDef, AgentRun, Project, Schedule
│   │   ├── errors.ts
│   │   └── ids.ts              # ag_xxx, prj_xxx, run_xxx, sched_xxx
│   ├── registry/
│   │   ├── canopy.ts           # cn render — turn canopy prompts into AgentDefs
│   │   └── schema.ts           # canopy schema validating "agent: true" prompts
│   ├── projects/
│   │   ├── clone.ts            # git clone <url> → /data/projects/...
│   │   └── repo.ts             # discovery, .seeds/.mulch/ presence checks
│   ├── runs/
│   │   ├── spawn.ts            # composition flow §4.3
│   │   ├── reap.ts             # capture mulch deltas, close seeds, push branch
│   │   └── stream.ts           # bridge burrow events → warren subscribers
│   ├── burrow-client/          # thin wrapper over burrow's HTTP-backed Client
│   ├── server/
│   │   ├── main.ts             # Bun.serve entry
│   │   ├── routes/
│   │   ├── auth.ts
│   │   └── ui.ts               # static SPA serving
│   ├── scheduler/
│   │   ├── cron.ts             # tick loop
│   │   └── webhook.ts          # GitHub webhook receiver
│   ├── db/
│   │   ├── client.ts
│   │   ├── schema.ts
│   │   └── repos/
│   ├── cli/
│   │   ├── main.ts             # `warren` CLI for ops/admin
│   │   └── commands/
│   │       ├── register-agent.ts
│   │       ├── add-project.ts
│   │       ├── run.ts
│   │       └── doctor.ts
│   └── ui/                     # React + Vite SPA, build output served by server
├── data/                       # gitignored, runtime state (mounted volume in deploy)
└── docker/
    └── burrow-base/            # if base image lives here vs burrow repo
```

---

## 8. Public Surface

### 8.1 HTTP API (top-level resources)

```
GET    /agents                  — list registered agent defs from canopy
POST   /agents/refresh          — re-clone canopy repo, re-discover agents
GET    /agents/:name            — full rendered agent (cn render output)

GET    /projects                — list cloned project repos
POST   /projects                — { gitUrl, defaultBranch? } → clone
DELETE /projects/:id            — remove project

POST   /runs                    — { agent, project, prompt } → spawn
GET    /runs                    — list with filters (status, agent, project)
GET    /runs/:id                — detail + summary
GET    /runs/:id/events?follow=1 — NDJSON event tail (proxies burrow)
POST   /runs/:id/steer          — send steering message
POST   /runs/:id/cancel

GET    /schedules               — list cron + trigger schedules
POST   /schedules               — { name, cron|webhook, agent, project, prompt }
DELETE /schedules/:id

POST   /webhooks/github         — GitHub webhook target

GET    /healthz                 — liveness
GET    /readyz                  — readiness (canopy reachable, burrow reachable)
```

Auth: `Authorization: Bearer ${WARREN_API_TOKEN}`.

### 8.2 CLI (admin-only)

The CLI is for ops, not daily use — the UI is daily.

```
warren register-agent <name>       — refresh canopy and register one agent
warren add-project <git-url>       — clone a project
warren run <agent> <project> -p "..."  — one-shot, no UI
warren schedule add ...
warren schedule list
warren doctor                       — burrow reachable? canopy clean? bwrap working?
warren serve                        — start the HTTP server (default in docker entrypoint)
```

### 8.3 Library API

`src/index.ts` exports the same shape, so a future user can embed warren in their own Bun program. Mirrors the HTTP routes 1:1.

---

## 9. Data Model (sketch)

```sql
agents (
  name TEXT PRIMARY KEY,        -- canopy prompt name
  rendered_json TEXT,           -- last cn render output, cached
  registered_at TEXT,
  last_refreshed TEXT
);

projects (
  id TEXT PRIMARY KEY,          -- prj_xxx
  git_url TEXT,
  local_path TEXT,              -- /data/projects/owner/name
  default_branch TEXT,
  added_at TEXT
);

runs (
  id TEXT PRIMARY KEY,          -- run_xxx (warren's, not burrow's)
  agent_name TEXT,
  project_id TEXT,
  burrow_id TEXT,               -- see burrow's /openapi.json
  burrow_run_id TEXT,           -- see burrow's /openapi.json
  state TEXT,                   -- queued | running | succeeded | failed | cancelled
  started_at TEXT,
  ended_at TEXT,
  prompt TEXT,
  trigger TEXT                  -- 'manual' | 'cron:<sched_id>' | 'webhook:<sched_id>'
);

schedules (
  id TEXT PRIMARY KEY,          -- sched_xxx
  name TEXT,
  kind TEXT,                    -- 'cron' | 'webhook'
  spec TEXT,                    -- cron expression or webhook event filter
  agent_name TEXT,
  project_id TEXT,
  prompt_template TEXT,
  enabled INTEGER,
  created_at TEXT
);

webhook_secrets (
  source TEXT PRIMARY KEY,      -- 'github'
  secret TEXT
);
```

Run events are not stored in warren — burrow owns them. Warren stores enough run metadata to render the UI list and link out to burrow's event log.

---

## 10. Deploy

### 10.1 Home server (canonical)

```bash
git clone https://github.com/jaymin/warren && cd warren
cp .env.example .env && $EDITOR .env
docker compose up -d
open http://localhost:8080
```

`docker-compose.yml` mounts a single named volume at `/data` and applies the bwrap-friendly security flags.

### 10.2 Fly.io

```bash
fly launch                          # uses ./fly.toml
fly volumes create warren_data --size 50 --region sjc
fly secrets set \
    WARREN_API_TOKEN=... \
    CANOPY_REPO_URL=https://github.com/<you>/agents.git \
    ANTHROPIC_API_KEY=... \
    GITHUB_TOKEN=...
fly deploy
```

Same image, same volume layout, same security flags. Mac Pro and Fly.io are interchangeable hosts.

### 10.3 Container layout

```dockerfile
FROM ghcr.io/jayminwest/burrow-base:0.2.0   # bun + bwrap + uidmap + burrow CLI
RUN bun install -g \
    @os-eco/canopy-cli@<v> \
    @os-eco/seeds-cli@<v> \
    @os-eco/mulch-cli@<v> \
    @os-eco/sapling-cli@<v>
WORKDIR /app
COPY . /app
RUN bun install && bun run build:ui
ENV WARREN_DATA_DIR=/data
EXPOSE 8080
ENTRYPOINT ["bun", "run", "src/server/main.ts"]
```

`burrow serve` runs as a sidecar process via a process-supervisor inside the container (s6-overlay, supervisord, or a small Bun parent process — TBD).

---

## 11. Open Questions

1. **Process supervisor inside the container.** Two long-running Bun processes (warren, burrow serve) — supervised how? Options: s6-overlay, supervisord, a Bun parent that spawns both. Lean toward Bun parent for zero non-Bun deps, but s6 is battle-tested.
2. **Frontend stack.** React + Vite is default, but Bun + plain HTML/htmx might be enough for the V1 surface (mostly tables + event tail). Decide after the API is stable.
3. **Webhook framework.** GitHub webhooks need signature verification, replay protection. Rolling our own vs. a small lib like `@octokit/webhooks`.
4. **Mulch capture from agent runs.** When the agent records to its in-burrow mulch, how do those records get captured back into the project's persistent mulch? Options: (a) bind-mount the project's `.mulch/` into the burrow read-write (simplest, but breaks isolation); (b) the agent commits + pushes mulch deltas as part of its branch (clean, but requires the agent to know to do it); (c) post-run reap step that copies the burrow's `.mulch/expertise/*.jsonl` into the project (clean, requires schema-compatible merge). Probably (c).
5. **Run cancellation semantics.** Cancel endpoints are now scoped: `POST /runs/:id/cancel` for graceful cancel (optional `{reason}` payload, emits cancel event) and `DELETE /runs/:id` for hard-stop or record cleanup (semantics TBD during burrow implementation). Blocked on burrow shipping the endpoints; tracked in burrow's `.seeds/`.
6. **OpenAPI spec generation for warren's HTTP surface.** Same question that's been opened against burrow as a follow-up.

---

## 12. Relationship to other os-eco tools

| Tool | Warren's relationship |
|---|---|
| **burrow** | Hard dependency. HTTP API consumer (`pl-5b40`). Warren cannot run without burrow. |
| **canopy** | Hard dependency. Source of agent definitions. Cloned at startup, refreshed on demand. |
| **mulch** | Used per-project. Warren shells out to `ml record` / `ml prime` against the project mulch dir during run setup and reap. |
| **seeds** | Used per-project. Warren reads `sd ready` to surface the project's worklist in the UI; agents file/close seeds during runs. |
| **sapling** | One of two harness choices (the other is claude-code). Shipped as a pre-installed CLI in the container; selected per agent via `burrow_config`. |
| **overstory** | Sibling, not subordinate. Multi-agent orchestration is overstory's domain; warren is single-agent-per-run. Overstory could be invoked as a "harness" in a future agent definition. |
| **greenhouse** | Sibling. Greenhouse polls GitHub → creates seeds → could call warren's HTTP API to dispatch a run. The autonomous outer loop. |
| **mycelium / grove** | Out of scope for this document. |

---

## 13. References

- Burrow HTTP API: `pl-5b40` / `burrow-1d64` (burrow repo `.seeds/`).
- Bwrap-in-container recipe: `mx-94901b`, `mx-c085ba` (burrow repo `.mulch/expertise/sandbox.jsonl`).
- Canopy inheritance + mixins: see canopy `cn tree` / `cn render` (canopy repo).
- Seeds plan workflow: `sd plan templates` (any os-eco repo with seeds).
- Mulch record types and lifecycle: see mulch `ml --help` (mulch repo).
- Os-eco ecosystem overview: `/Users/jayminwest/Projects/os-eco/CLAUDE.md`.
