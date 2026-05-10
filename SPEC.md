# Warren — Specification

> A network of interconnected burrows. The control plane and UI for cloud-based custom agents that operate in isolation, self-manage, self-repair, and self-improve.

**Status:** Design phase, V1 spec.
**Last updated:** 2026-05-08.
**CLI:** `warren` / `wr` (TBD).
**Package:** `@os-eco/warren` (TBD).

V1 scope is the **manual run path**: connect canopy, add project, spawn run, watch events, steer/cancel. Scheduler (cron + webhooks) and library API exports are deferred to V2 — kept in this spec for context, marked **(V2)** where they appear.

---

## 1. TL;DR

Warren is the platform layer for the os-eco agent ecosystem. It composes the four data-plane tools (canopy, mulch, seeds, sapling) and the runtime substrate (burrow) into a single deployable system that runs on a home server or in the cloud.

A user defines a custom agent as a versioned canopy prompt (with structured sections like `system`, `skills`, `expertise_seed`, `burrow_config`). Warren spawns that agent against a project repo inside a burrow sandbox, streams events back, persists outcomes, and lets the agent self-manage its own work queue (seeds), self-repair from past failures (mulch), and self-improve by recording new expertise. A web UI sits on top of the same HTTP API that any external orchestrator could call.

V1 is single-user, single-host: clone warren, `docker compose up`, browser at `localhost:8080`. The same image runs on Fly.io with a volume and three secrets. No cross-tenant story, no SaaS, no auth beyond a bearer token.

---

## 2. Vision

### 2.1 The day-in-the-life

```
$ git clone https://github.com/jayminwest/warren && cd warren
$ cp .env.example .env && $EDITOR .env   # WARREN_API_TOKEN, BURROW_API_TOKEN, WARREN_BURROW_TOKEN, ANTHROPIC_API_KEY, GITHUB_TOKEN (CANOPY_REPO_URL optional)
$ docker compose up -d
$ open http://homeserver.local:8080
```

In the UI:
1. **Pick an agent** — Warren ships built-in `claude-code` and `sapling` agents inline (`src/registry/builtins/`), so a fresh install can dispatch a run without further setup. To layer a custom library on top, set `CANOPY_REPO_URL` and Warren clones your canopy repo; every prompt tagged `agent` becomes a library-source agent that overrides any same-named built-in (`refactor-bot`, `docs-bot`, `sre-bot`, ...).
2. **Add project** — paste a GitHub URL. Warren clones it under `/data/projects/`.
3. **Spawn run** — pick agent + project + prompt. Warren provisions a burrow, renders the canopy agent into it, dispatches the run, streams events to the UI.
4. **Watch and steer** — live event tail, send steering messages, see seeds the agent files for itself, see mulch records the agent records as it learns.
5. **Schedule** *(V2)* — "every 6 hours, run docs-bot against repo X" or "on PR open, run reviewer-bot." Cron and trigger-driven runs. Out of V1 scope; UI surface and HTTP routes return "deferred" placeholders.

### 2.2 What Warren is

- The **control plane**: one process, one HTTP API, one volume.
- The **glue**: shells out to mulch/seeds/canopy/sapling CLIs, talks to burrow over its HTTP API.
- The **UI**: web frontend served from the same process.
- The **agent registry**: reads canopy, surfaces installable roles.
- *(V2)* The **scheduler**: cron and event-triggered runs.

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
- Web UI for: agent registry, project list, run dispatch, live event tail, basic settings.
- HTTP API mirroring the UI's surface so external scripts can drive warren.
- Custom-agent-as-canopy-prompt: an agent is a single canopy prompt with required sections; warren auto-discovers from a connected canopy repo.
- Runs against project repos cloned into warren's data dir from GitHub URLs.
- Self-* loop: agents read seeds queue, write seeds for follow-ups, record mulch on success/failure, prime mulch on next spawn.
- Durable event log: every event burrow streams is persisted in warren's SQLite so reload-after-crash and post-hoc inspection both work.

**Deferred to V2** (kept in this spec for context, not built in V1):
- Cron-scheduled runs and the scheduler tick loop.
- GitHub webhook receiver and signature verification.
- `@os-eco/warren` library API exports — internal-only `Client` is fine for V1.

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

1. **Resolve agent** — `cn render <agent-name>` against the canopy repo. Returns a single object with all sections expanded after inheritance/mixin resolution. The rendered JSON is persisted on the run row (`runs.rendered_agent_json`) and **frozen for the lifetime of the run** — mid-run edits to canopy do not affect in-flight runs. Run-time agent identity always reads from `runs.rendered_agent_json`, never from a re-render.
2. **Provision burrow** — `POST /burrows` to burrow with `{ projectRoot, branch?, baseBranch?, network?, ... }` derived from the agent's `burrow_config` and the project's local clone path. Burrow returns 201 + `Burrow` (id, workspace path, branch, state). Warren records `burrow_id` on the run.
3. **Seed the burrow** — write the rendered `system` + `skills` into the burrow's `.canopy/`; pipe `expertise_seed` lines (one mulch record per line) through `ml record` against the burrow's per-run `.mulch/` (see §11.A); install the workflow template into the burrow's `.seeds/`.
4. **Dispatch** — `POST /burrows/:burrow_id/runs` with `{ agentId, prompt, metadata? }`. Burrow returns 201 + `Run` in `state='queued'`; its run loop picks it up. Warren records the burrow run id in `runs.burrow_run_id`.
5. **Stream** — `GET /runs/:burrow_run_id/stream?follow=1` (NDJSON, chunked HTTP). Warren persists every event into its own `events` table (see §9) keyed by warren run id, then fans out to UI subscribers. UI clients hit warren's own `/runs/:id/events?follow=1`, which serves history from the warren log + tails the live stream concurrently. If warren restarts mid-run, on boot it re-subscribes to burrow's stream from `MAX(events.burrow_event_seq)+1` to backfill anything missed.
6. **Reap** — on run terminal state, copy the burrow's `.mulch/expertise/*.jsonl` back to the project's persistent `.mulch/` with **last-write-wins by record `ts`** (§11.A); close any seeds the agent marked done in the burrow's `.seeds/`; push the workspace branch.

Steering: `POST /runs/:id/steer` (warren) → `POST /burrows/:burrow_id/inbox` (burrow). Cancellation: `POST /runs/:id/cancel` (warren) → `POST /runs/:burrow_run_id/cancel` (burrow). Burrow's full HTTP contract is at `GET /openapi.json` on the burrow socket; warren generates code against the OpenAPI document, so contract drift surfaces at build time.

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

Three processes inside the container, supervised by a small Bun parent (see §10.3):

- **supervisor** — `src/supervisor/main.ts`, ~50–100 LOC. Spawns warren and burrow as children, forwards SIGTERM/SIGINT, restarts `burrow serve` on unexpected exit (with a budget), exits non-zero on warren crash.
- **`warren`** — Bun.serve, the platform process. HTTP API + UI. (V2: scheduler tick + webhook receiver run inside this process.)
- **`burrow serve`** — Bun.serve bound to a unix socket at `/var/run/burrow.sock`, the runtime substrate. Owns SQLite + sandboxes.

Plus short-lived shell-outs to `cn`, `sd`, `ml`, `git` invoked from the warren process.

### 5.2 Why burrow is a separate process

Warren restarts shouldn't kill in-flight agent runs. Burrow's SQLite + run loop persist across warren deploys; the supervisor restarts only the failing child. The unix socket is the seam — no TCP exposure, no auth on the loopback, trust-the-socket posture matches burrow's default (§7 of burrow's spec). Warren never imports burrow as a library; only the typed `HttpClient` from `@os-eco/burrow` (§15.6 of burrow's spec) crosses the boundary.

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
| Frontend | **React + Vite + shadcn/ui + Tailwind** | SPA served as static files from warren. shadcn for component primitives (copy-in, no runtime dep), Tailwind for styling. Build output lives at `src/ui/dist/`, served by the same Bun.serve. |
| Burrow client | **`HttpClient` from `@os-eco/burrow`** (§15.6) | Typed mirror of burrow's library API over the unix socket. No hand-written HTTP. |
| Cron | **(V2)** in-process timer | Deferred. |

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
│   │   ├── reap.ts             # capture mulch deltas (§11.A), close seeds, push branch
│   │   ├── stream.ts           # bridge burrow events → warren events table → subscribers
│   │   └── events.ts           # warren event log (write-through cache of burrow stream)
│   ├── burrow-client/          # thin facade over @os-eco/burrow HttpClient
│   ├── supervisor/
│   │   └── main.ts             # docker entrypoint: spawns warren + burrow serve, signal forwarding (§10.3)
│   ├── server/
│   │   ├── main.ts             # Bun.serve entry
│   │   ├── routes/
│   │   ├── auth.ts
│   │   └── ui.ts               # static SPA serving
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
│   ├── ui/                     # React + Vite + shadcn/ui SPA, build output served by server
│   └── scheduler/              # (V2) cron tick + GitHub webhook receiver
├── data/                       # gitignored, runtime state (mounted volume in deploy)
└── docker/
    └── burrow-base/            # if base image lives here vs burrow repo
```

---

## 8. Public Surface

### 8.1 HTTP API (top-level resources)

```
# V1 — manual run path
GET    /agents                  — list registered agent defs from canopy
POST   /agents/refresh          — re-clone canopy repo, re-discover agents
GET    /agents/:name            — full rendered agent (cn render output)

GET    /projects                — list cloned project repos
POST   /projects                — { gitUrl, defaultBranch? } → clone
DELETE /projects/:id            — remove project

POST   /runs                    — { agent, project, prompt } → spawn
GET    /runs                    — list with filters (status, agent, project)
GET    /runs/:id                — detail + summary (includes rendered_agent_json)
GET    /runs/:id/events?follow=1 — NDJSON event tail (warren log + live tail)
POST   /runs/:id/steer          — send steering message (proxies to burrow inbox)
POST   /runs/:id/cancel         — graceful cancel (proxies to burrow)

GET    /healthz                 — liveness
GET    /readyz                  — readiness (canopy reachable, burrow reachable)

# V2 — deferred
GET    /schedules               — list cron + trigger schedules
POST   /schedules               — { name, cron|webhook, agent, project, prompt }
DELETE /schedules/:id
POST   /webhooks/github         — GitHub webhook target
```

Auth: `Authorization: Bearer ${WARREN_API_TOKEN}` on every route except `/healthz`. Warren expects HTTPS termination at a reverse proxy (Caddy on home server, Fly's edge on Fly.io); it does not terminate TLS itself. Token is single-user, single-value, no rotation in V1 — see §11 for the security posture.

### 8.2 CLI (admin-only)

The CLI is for ops, not daily use — the UI is daily.

```
warren register-agent <name>       — refresh canopy and register one agent
warren add-project <git-url>       — clone a project
warren run <agent> <project> -p "..."  — one-shot, no UI
warren doctor                       — burrow reachable? canopy clean? bwrap working?
warren serve                        — start the HTTP server (default in docker entrypoint)

# V2 — deferred
warren schedule add ...
warren schedule list
```

### 8.3 Library API (V2)

Deferred. V1's `Client` class is internal; warren's only public surface is the HTTP API + CLI. When the HTTP surface stabilizes, `src/index.ts` will export a `Client` that mirrors the routes 1:1, following burrow's `Client` / `HttpClient` pattern (§15 of burrow's spec).

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
  rendered_agent_json TEXT,     -- frozen at run start; survives canopy edits
  state TEXT,                   -- queued | running | succeeded | failed | cancelled
  started_at TEXT,
  ended_at TEXT,
  prompt TEXT,
  trigger TEXT                  -- 'manual' (V2: 'cron:<sched_id>' | 'webhook:<sched_id>')
);

events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  burrow_event_seq INTEGER,     -- mirrors burrow's monotonic seq for replay
  ts TEXT NOT NULL,             -- ISO8601 from burrow envelope
  kind TEXT NOT NULL,           -- 'tool_use' | 'tool_result' | 'thinking' | 'text' | 'state_change' | 'error' | 'stderr'
  stream TEXT,                  -- 'stdout' | 'stderr' | 'system'
  payload_json TEXT NOT NULL    -- pass-through from burrow
);
-- Index: events(run_id, burrow_event_seq) for ordered replay; events(run_id, ts) for time queries.

-- V2 — deferred
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

**Event durability rationale.** Burrow owns the canonical event log (its `events` table, NDJSON archive on destroy). Warren persists a copy of every event it streams from burrow because (a) the UI's "reload page, see history" expectation requires server-side history, (b) warren restart shouldn't lose events users were watching, and (c) decoupling warren's UI from burrow's archive lifecycle keeps the seam clean. Warren's events table is *not* the source of truth — it's a write-through cache of what burrow streamed. On warren restart, the run's stream is re-subscribed at `MAX(events.burrow_event_seq) + 1`. If warren's DB is lost, runs continue (burrow has them); the UI loses scrollback for terminated runs but not for running ones.

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
    ANTHROPIC_API_KEY=... \
    GITHUB_TOKEN=...
# Optional: layer a custom canopy library on top of the built-ins:
#   CANOPY_REPO_URL=https://github.com/<you>/agents.git
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
ENTRYPOINT ["bun", "run", "src/supervisor/main.ts"]
```

The entrypoint is the Bun supervisor (`src/supervisor/main.ts`), not warren directly:

- Spawns `burrow serve --socket /var/run/burrow.sock` as a child via `Bun.spawn`.
- Waits for the socket file to appear (`fs.access` poll, 100 ms × 50 = 5s timeout) before spawning warren.
- Spawns warren (`bun run src/server/main.ts`) as a child.
- Forwards `SIGTERM` and `SIGINT` to both children, then waits for clean exit (5s grace) before forcing.
- Restarts `burrow serve` if it exits non-zero, with an exponential backoff and a budget of 5 restarts in 60s; after exhaustion, the supervisor exits, the container restarts under Docker/Fly's restart policy.
- Crashes if warren exits non-zero (warren is the user-facing process; restart-by-orchestrator is preferred to mask warren bugs in-process).

Rationale: zero non-Bun deps; signal handling and lifecycle are explicit in our code; warren restarts (the more frequent kind, e.g., on deploy) leave burrow's run loop and SQLite untouched.

---

## 11. Decisions & Open Questions

### 11.A Expertise capture (mulch reap)

The decided shape, expanded from prior open question #4:

- **Per-run isolation.** Each burrow run gets its own `.mulch/` inside the burrow workspace — not shared across concurrent runs against the same project. This matches burrow's "one run at a time per burrow" default (§4.2 of burrow's spec) and avoids race conditions if that posture is later relaxed.
- **Seeding (run start, step 3 of §4.3).** Warren reads `expertise_seed` lines from the rendered agent JSON; for each line, invokes `ml record` inside the burrow workspace via `burrow exec` (or equivalent) so the seed records land in the burrow's per-run `.mulch/expertise/<domain>.jsonl`. Format is canonical mulch record JSONL — one record per line, schema validated by mulch.
- **Reap (run end, step 6 of §4.3).** Warren reads `<burrow-workspace>/.mulch/expertise/*.jsonl` and merges each record into the project's persistent `.mulch/expertise/<domain>.jsonl` using the project's local clone path. Merge rule: **last-write-wins by record `ts` field**. Conflict resolution:
  - Same `id` (named record), incoming `ts > existing ts` → overwrite, emit a warren event `mulch.record.updated`.
  - Same `id`, incoming `ts <= existing ts` → drop incoming, emit `mulch.record.skipped`.
  - No `id` (anonymous record) → append, no conflict possible.
- **Failure mode.** Reap errors (disk full, schema violation) do not fail the run — they are logged and surfaced as a `reap_failed` event on the run. The agent's work is preserved on the branch even if expertise capture fails.
- **Why not bind-mount.** Bind-mounting the project's `.mulch/` into the sandbox would break burrow's isolation contract and risks corrupting the project's expertise log if the agent runs `ml` commands incorrectly. The reap step is the seam.
- **Why not "agent commits mulch as a branch artifact".** Requires every agent definition to know about persistence mechanics. The reap step is invisible to agents — they just call `ml record` as documented in canopy/mulch.

### 11.B Resolved decisions

| Question | Resolution | Where |
|---|---|---|
| Process supervisor | Small Bun parent process (`src/supervisor/main.ts`), zero non-Bun deps. | §10.3 |
| Frontend stack | React + Vite + shadcn/ui + Tailwind. | §6 |
| Mulch capture | Per-run isolated `.mulch/`, post-run reap, last-write-wins-by-ts merge. | §11.A |
| Run cancellation | `POST /runs/:id/cancel` proxies to burrow's `POST /runs/:burrow_run_id/cancel`. Hard-stop = `DELETE /burrows/:burrow_id` is V2; not needed for V1. | §4.3 |
| Burrow API contract | Burrow's `/openapi.json` is the source of truth. Warren generates a typed client against it. | §4.3 |
| Burrow shippability | All 21 routes implemented as of `burrow@7926a0e` (2026-05-08). `POST /burrows` no longer returns 501. | — |
| `CANOPY_REPO_URL` is optional (warren-d3e9, 2026-05-10) | Warren ships built-in `claude-code` and `sapling` agents inline (`src/registry/builtins/`); the canopy library is a power-user override, not a hard dependency. Boot seeds built-ins; refresh upserts library agents on top (same-named library agents win). `warren doctor` and `/readyz` treat unset `CANOPY_REPO_URL` as info, not failure. `POST /agents/refresh` and `warren register-agent` 400 with a friendly hint when no library is configured. `GET /agents` returns `source: "builtin" \| "library"` provenance derived from `frontmatter.source`. | §10.2, §11.B |

### 11.C Open questions for V1

1. **OpenAPI spec for warren's own HTTP surface.** Same question burrow resolved by hand-authoring `src/server/openapi/spec.ts` and golden-locking it. Recommend the same pattern; defer decision until after `/runs` and `/agents` routes stabilize.
2. **Concurrent runs per project.** Warren can dispatch many runs against the same project; each run gets its own burrow (provisioned per-run, destroyed on completion). Or do we share a long-lived burrow per project and queue runs serially inside it? Decision affects burrow lifecycle (provision-per-run vs. provision-per-project) and `runs.burrow_id` semantics. Lean toward provision-per-run for V1: simpler isolation, matches "task burrow" model from burrow's §4.1.
3. **Reverse proxy assumption.** Spec assumes warren is fronted by Caddy/Fly edge for TLS. Should warren refuse to start if `WARREN_TRUST_PROXY != true` and the bind address is non-loopback? V1 default: warn loudly in `doctor`, do not refuse — home-server users may not have a proxy yet.
4. **`readyz` timing.** When does warren consider itself "ready"? Burrow socket reachable + canopy clone present + at least one agent successfully rendered? All three? Affects deploy-time orchestration.

### 11.D V1 security posture (known limitations)

Documented, accepted for V1:

- **Single bearer token.** No rotation, no expiry, no revocation. Loss of `WARREN_API_TOKEN` = full access. Mitigation: rotate by editing `.env` / `fly secrets set` and bouncing the container.
- **Plaintext secrets in `.env`.** Standard for self-host; user is responsible for filesystem perms (`chmod 600 .env`). Fly.io's secret store is encrypted at rest.
- **No HTTPS termination in warren.** TLS is the reverse proxy's job. Direct HTTP on a non-loopback address is a misconfiguration; `warren doctor` warns.
- **Trust-the-socket between warren and burrow.** Burrow's unix socket has no auth; the in-container threat model is "warren is the only client." If a third party gains code execution inside the warren process, they have full burrow access. Acceptable: warren and burrow are co-tenanted by design.
- **No CSRF protection on the UI.** UI calls warren's API with the bearer token. Not exposed to third-party origins (CORS strict). Single-user posture.

These are limitations for V1, not bugs. V2 candidates: token-pair (read/write), per-token scopes, audit log.

### 11.E First-run validation (2026-05-09)

The §4.3 composition flow was exercised end-to-end against a real claude-code agent for the first time. Three architectural gaps in burrow surfaced and shipped fixes in the same session: `burrow-7b97` (`burrow serve` had no in-process executor — runs queued forever; fixed by wiring `RunDispatcher` into `startServer` and hooking `RunsClient.setOnCreated`), `burrow-55e3` (HTTP `burrows.up` ignored agent-id hints, leaving `toolchainPaths: []`; fixed by accepting `agents` on `HttpBurrowUpInput` and threading through `resolveEffectiveAgents` — paired with warren's spawn forwarding `agents: [agent.name]`), and `burrow-0329` (`buildBwrapArgv` lacked `--uid`/`--gid`, so the sandboxed process inherited host root and claude-code refused to run with `--dangerously-skip-permissions`). Warren-side fixes were narrower: bumping `@os-eco/burrow-cli` in **both** `Dockerfile` and `package.json` + `bun.lock` (the supervisor's `Bun.spawn` resolves `./node_modules/.bin/burrow` before PATH, so a Dockerfile-only bump is a no-op), bundling `@anthropic-ai/claude-code` with an explicit postinstall invocation (`bun install -g` skips lifecycle scripts), and a compose-time `CANOPY_SOURCE_DIR` bind mount for local-canopy testing. With burrow at `0.2.3`, a `warren run claude-code <prj> -p "..."` against warren itself completes in ~5s with `state: succeeded`, `branchPushed: true`, and a real model response in `run.event seq:4`. Outstanding gaps for V1 (all open warren seeds): the supervisor doesn't auto-wire `GITHUB_TOKEN` into git's credential helper (`warren-dcf3`), the supervisor offers no `--no-auth` knob for burrow loopback dev (`warren-93ee`), the `warren` CLI isn't on `PATH` inside the container (`warren-fab1`), the reap step can't distinguish "queued, never started" from "crashed" (`warren-3c40`), and the runtime image lacks `curl` for diagnostics (`warren-bd69`).

### 11.F Second dogfood (2026-05-09)

After all five §11.E gaps were closed, a second end-to-end run against warren itself surfaced six new structural seams. Burrow patched one mid-session: `burrow-e9e7` (`claude-code` runtime now default-allows `ANTHROPIC_API_KEY` + OAuth env names without requiring a project `burrow.toml [env]` block — claude-code is a built-in runtime, so its env contract is built-in too; landed in `0.2.6`). With burrow at `0.2.6`, the agent authenticated cleanly (`apiKeySource: "ANTHROPIC_API_KEY"` in seq:1 init), ran for 12m48s, and emitted a clean terminal `result` event with `is_error: false`, 102 turns, and `bun test 417/417 + lint + typecheck` all green inside the sandbox. **None of that work landed on the remote.** Two compounding bugs explain why: `warren-67cc` (the burrow worktree's `.git` file points at `<project>/.git/worktrees/<burrowId>`, which lives outside the bwrap mount — agent literally cannot `git commit` inside its workspace, so there was nothing for reap to push) and `warren-a69a` (warren's reap doesn't transition runs on terminal events — bridge stores the result event but the runs row stays `running` forever; even if the agent could commit, reap wouldn't push). Pattern recorded as `mx-runs/branchPushed-requires-both-reap-and-sandbox-git`: `branchPushed: true` is a compound output of in-sandbox git AND warren reap, and either failing alone produces an indistinguishable "stuck running, no branch" shape. Other open seeds from this iteration: `warren-5f19` (`deleteProject` rmrf's the disk before the row delete; FK on `runs.project_id` makes the row delete fail and leaves the system in a `(row exists, disk gone)` state — recommended fix: `ON DELETE SET NULL` plus row-first ordering inside a tx), `warren-1eaa` (`bun install -g` runs as root during build, so `/usr/local/bin/{sd,ml,cn,sapling,overstory}` symlink into `/root/.bun/...` which user `bun` can't traverse — every os-eco CLI is dangling at runtime), `warren-5165` (`.env.example` and SPEC claimed canopy `env_passthrough` flows via `burrow_config`, but `parseBurrowConfig` only reads `[sandbox].network`; resolved as docs-only — claude-code's env contract is now burrow-built-in via `burrow-e9e7`, and project-level `env_passthrough` plumbing is deferred until a non-built-in runtime needs it), `warren-d9ad` (UI's RunDetail badge doesn't react to incoming events — even after the reap fix lands, the UI will show stale state until a manual refresh).

### 11.G Third dogfood (2026-05-09)

Released as `0.1.2` after closing all six §11.F gaps; bumped `@os-eco/burrow-cli` to `0.2.7` in **both** `Dockerfile` and `package.json` + `bun.lock` to pull in the gitdir-bind fix (`burrow-7a80`: burrow's bwrap profile now binds the host worktree gitdir into the sandbox, so an agent at UID 1000 can resolve `<workspace>/.git → /<host-path>/.git/worktrees/<id>` and run `git commit` inside its workspace). Two runs against warren-on-warren produced the cleanest signal yet on the §4.3 composition flow. **Run 1 (`run_a98cfx1fantf`, prompt `"Work on sd warren-9f65. Use ml"`)** completed `succeeded` in 6m28s / 49 turns with `branchPushed: true` — and zero of the agent's work on the remote (`gh compare main...burrow/bur_r9mjn6da9xc9 → ahead_by: 0, total_commits: 0`). The branch ref pointed at main's SHA; warren reap pushed an unchanged HEAD because the agent never ran `git commit`. The thin canopy `claude-code` prompt (`canopy-daf3`: `"You are a helpful coding assistant. Be concise."`) contains no commit contract; combined with `src/runs/reap.ts:257-265` (push-without-commit) and the `branchPushed` boolean (which flips `true` on any successful push including a no-op) the result is a silent work-loss shape that even an attentive operator misreads as success — filed as `warren-f3bb` (P1: observability fix B + canopy-prompt fix C + SPEC §4.3.6 doc fix D). A secondary entanglement filed as `warren-fead` (the agent emitted `stop_reason=end_turn` while waiting on a foreground `bun install` Monitor — *"I'll wait for the monitor"* with no follow-up tool call ended the run before commit could happen). **Run 2 (`run_agpet4ev6e4a`, prompt `"...Commit and push when you're done"`)** produced the first warren-on-warren success that actually shipped: branch `burrow/bur_0qgh4pwpvgv0` at SHA `15339e61` with `ahead_by: 1`, real diff across 5 files (acceptance scenario 04 implementation + lib changes + mulch + seeds). The fix-C scope is validated — instructing the agent to commit is sufficient for the smoke-test agent. The *"and push"* portion was inert and counterproductive: agent-side `git push` failed four times with `fatal: could not read Username for 'https://github.com'` because warren's supervisor installs the `insteadOf` rewrite rule into `/root/.gitconfig` (`src/supervisor/git-credentials.ts:65-71`), but burrow's bwrap profile ro-binds `/usr`, `/etc`, `/lib`, `/lib64`, `/bin`, `/sbin`, `/opt` — *not* `/root`. Same architectural pattern as `warren-1eaa` (Bun store at `/root/.bun` invisible inside sandbox); the git config has the same problem and was not relocated. Filed as `warren-1a09` (P2): for V1, fix A (canopy prompt instructs commit only — *"warren handles the push"*) and fix D (SPEC documents the contract: agent commits, reap pushes, sandbox has no github auth path) are sufficient. Reap pushed the agent's commit successfully because reap runs host-side with `/root/.gitconfig` visible — the system did the right thing while the agent burned ~5 turns on doomed retries.

---

## 12. Relationship to other os-eco tools

| Tool | Warren's relationship |
|---|---|
| **burrow** | Hard dependency. HTTP API consumer via the typed `HttpClient` from `@os-eco/burrow` (burrow's §15.6). Warren cannot run without burrow. Burrow's HTTP API is shipped as of `7926a0e` (2026-05-08); all routes warren needs (`POST /burrows`, `POST /burrows/:id/runs`, `GET /runs/:id/stream`, `POST /burrows/:id/inbox`, `POST /runs/:id/cancel`, `DELETE /burrows/:id`, `GET /watch`) are live. |
| **canopy** | Hard dependency. Source of agent definitions. Cloned at startup, refreshed on demand. |
| **mulch** | Used per-project. Warren shells out to `ml record` / `ml prime` against the project mulch dir during run setup and reap. |
| **seeds** | Used per-project. Warren reads `sd ready` to surface the project's worklist in the UI; agents file/close seeds during runs. |
| **sapling** | One of two harness choices (the other is claude-code). Shipped as a pre-installed CLI in the container; selected per agent via `burrow_config`. |
| **overstory** | Sibling, not subordinate. Multi-agent orchestration is overstory's domain; warren is single-agent-per-run. Overstory could be invoked as a "harness" in a future agent definition. |
| **greenhouse** | Sibling. Greenhouse polls GitHub → creates seeds → could call warren's HTTP API to dispatch a run. The autonomous outer loop. |
| **mycelium / grove** | Out of scope for this document. |

---

## 13. References

- Burrow HTTP API: shipped via `pl-5b40` / `burrow-1d64`. Canonical contract at `GET /openapi.json` on a running `burrow serve`; spec pointer in burrow's SPEC.md §27. `POST /burrows` provisioning landed in `burrow@7926a0e` (2026-05-08).
- Burrow library API (`@os-eco/burrow` `HttpClient`): burrow's SPEC.md §15.6.
- Burrow dashboard snapshot envelope (`GET /watch`): burrow's SPEC.md §26 — possible future basis for warren's dashboard view.
- Bwrap-in-container recipe: `mx-94901b`, `mx-c085ba` (burrow repo `.mulch/expertise/sandbox.jsonl`).
- Canopy inheritance + mixins: see canopy `cn tree` / `cn render` (canopy repo).
- Seeds plan workflow: `sd plan templates` (any os-eco repo with seeds).
- Mulch record types and lifecycle: see mulch `ml --help` (mulch repo).
- Os-eco ecosystem overview: `/Users/jayminwest/Projects/os-eco/CLAUDE.md`.
