# Warren — Specification

> A network of interconnected burrows. The control plane and UI for cloud-based custom agents that operate in isolation, self-manage, self-repair, and self-improve.

**Status:** Design phase, V1 spec.
**Last updated:** 2026-05-08.
**CLI:** `warren` / `wr` (TBD).
**Package:** `@os-eco/warren` (TBD).

V1 scope is the **manual run path** plus the **cron half of the scheduler**: connect canopy, add project, spawn run, watch events, steer/cancel, and dispatch recurring runs from `.warren/triggers.yaml` + one-off seeds with `extensions.scheduledFor` (R-06, shipped 2026-05-11). Webhook triggers and library API exports are deferred to V2 — kept in this spec for context, marked **(V2)** where they appear.

**Post-V1 direction (2026-05-11).** Warren is being positioned as a self-hostable control plane for engineering organizations of 50+ ICs, not only a solo home-server appliance. V1 stays single-user / single-host as shipped; V2/V3 layer in multi-user identity (SSO), remote burrow workers, a bring-your-own-database backend, MCP support, audit logging, cost/concurrency guardrails, and a GitHub App auth path. See `ROADMAP.md` R-09 + R-12 through R-18, and §11.J below for the dated decision record.

---

## 1. TL;DR

Warren is a self-hostable control plane for ephemeral coding agents. A user points it at a GitHub repo, picks an agent, writes a prompt; warren spawns the agent inside a sandbox, streams events back to the UI, lets the user steer mid-run, then pushes the workspace branch. **One container, one volume, one HTTP API, one UI.**

The fresh-install path is standalone: the built-in `claude-code` agent ships inline, so a user with a GitHub URL and an Anthropic key can dispatch a run end-to-end with no other tooling. Two additional coding-agent runtimes ship inline alongside it — `sapling` (steerable harness) and `pi` (multi-provider, with per-run cost reporting). Warren also bundles a small set of [os-eco](https://github.com/jayminwest/os-eco) tools as opt-in built-in features — versioned prompt libraries via canopy, persistent agent memory via mulch, an integrated issue queue via seeds — each surfaced only when the project or operator opts in. The runtime substrate is [burrow](https://github.com/jayminwest/burrow), a sibling process inside the container that warren talks to over a unix socket.

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
1. **Pick an agent** — Warren ships three built-in agents inline (`src/registry/builtins/`): `claude-code` (default), `sapling` (alternative steerable harness), and `pi` (multi-provider harness with first-class cost reporting). A fresh install can dispatch a run against any of them without further setup. Power users who want a custom prompt library set `CANOPY_REPO_URL`; warren clones the repo and every prompt tagged `agent` becomes a library-source agent that overrides any same-named built-in.
2. **Add project** — paste a GitHub URL. Warren clones it under `/data/projects/`.
3. **Spawn run** — pick agent + project + prompt. Warren provisions a sandbox, seeds the rendered agent into it, dispatches the run, streams events to the UI.
4. **Watch and steer** — live event tail, send steering messages, cancel cleanly. If the project opted into the agent-memory feature, the UI also surfaces mulch records the agent recorded; if it opted into the issue-queue feature, it surfaces seeds the agent filed or closed.
5. **Schedule** — "every 6 hours, run docs-bot against repo X" via `.warren/triggers.yaml`, or "dispatch this seed at 3am" via `extensions.scheduledFor`. Cron half shipped in V1 (R-06, §11.I); webhook/event-driven triggers (e.g. "on PR open, run reviewer-bot") remain V2.

### 2.2 What Warren is

- The **control plane**: one process, one HTTP API, one volume.
- The **agent registry**: built-in agents inline, plus optional canopy library on top.
- The **dispatcher**: provisions sandboxes via the runtime, streams events back, reaps results.
- The **UI**: web frontend served from the same process.
- The **scheduler**: in-process cron tick + scheduled-seed dispatch (V1, §11.I). Webhook/event-triggered runs deferred to V2.

Warren bundles four os-eco data-plane tools (canopy, mulch, seeds, sapling) as built-in features, but a fresh install does not require a user to adopt any of them — `claude-code` ships inline and reads/writes nothing outside the sandbox. The integrations light up when the operator sets `CANOPY_REPO_URL`, or when a project contains `.mulch/` / `.seeds/`.

### 2.3 What Warren is not

- Not a coding agent. The runtime runs them; sapling/claude-code are them; warren orchestrates.
- Not a sandbox. The runtime owns isolation.
- Not a hard dependency on the os-eco data-plane tools. They are bundled features, not required infrastructure — see §2.2 above.
- Not a multi-tenant SaaS. The deployment unit is one team / one org self-hosting one warren — never a shared hosted service. V1 ships single-user (one bearer token, one box); V2/V3 layer in SSO + per-user identity + remote workers so a team of 50 ICs can share one warren without sharing one credential or one machine (R-09, R-12, §11.J).

Warren is a thin coordinator — most of the value is in the runtime plus whichever data-plane features the project opts into. Warren's job is to compose them into a deployable system with a UI on top.

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
- GitHub webhook receiver and signature verification (the event-driven half of the scheduler — cron half shipped in V1, §11.I).
- `@os-eco/warren` library API exports — internal-only `Client` is fine for V1.

### 3.2 V1 Non-Goals

- No multi-tenant auth, no per-user RBAC in V1. Single bearer token, one user. Multi-user identity via OIDC is a planned post-V1 addition (R-09).
- No agent marketplace. Agents come from your own canopy repo.
- No remote burrow workers in V1 — burrows run inside warren's container. The "single warren box is the concurrency ceiling" shape is acceptable for V1; remote workers are planned for V2 (R-12, design tracked in `burrow-c47a`). The warren↔burrow seam is already HTTP, so this is additive rather than a rewrite.
- No laptop-driven `burrow up` against warren. The home server is the canonical V1 deploy.
- No real-time collaboration. One UI, one user at a time.
- No payment, no usage metering, no quota in V1. Per-user / per-project cost and concurrency guardrails are planned post-V1 (R-17).
- No cost or run-budget enforcement in V1. Token spend and concurrent-run caps are planned post-V1 (R-17). V1 does *report* per-run cost + token usage for the `pi` built-in (`runs.cost_usd`, `runs.tokens_*`, §11.K) — reporting is observability; enforcement (per-user / per-project budget caps) is the deferred half.
- No bring-your-own database in V1 — SQLite via `bun:sqlite` is the only backend. Postgres-as-a-backend is planned post-V1 (R-13).
- No MCP server configuration in V1. Canopy-frontmatter-driven MCP plus burrow-side credential mounts are planned post-V1 (R-15).
- No audit log in V1. Append-only dispatch/steer/cancel/secret-read ledger is planned post-V1 (R-16), and lands alongside R-09 since it depends on real user identity.
- No GitHub App auth in V1 — shared PAT via `GITHUB_TOKEN`. GitHub App with installation-scoped tokens and per-repo allowlists is planned post-V1 (R-18).

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
  pi_skills: |                           # pi-only — materialized into .pi/skills/<name>/SKILL.md
    {"name":"refactor-pass","body":"# Refactor pass\nIdentify dead code..."}
    {"name":"safe-rename","body":"# Safe rename\nUse the LSP rename..."}
  pi_prompts: |                          # pi-only — materialized into .pi/prompts/<name>.md
    {"name":"summarize-diff","body":"Summarize the diff in {{lines}} lines..."}
```

**Section enumeration (V1).** Generic sections shared by every runtime:
`system`, `skills`, `expertise_seed`, `burrow_config`, `workflow`. Pi-namespaced
sections (consumed only by the `pi` built-in; ignored by `claude-code` /
`sapling`): `pi_skills`, `pi_prompts`. Pi-section bodies are JSON-Lines envelopes
of `{name, body}` — one artifact per line — which `src/runs/seed.ts`
materializes into `.pi/skills/<name>/SKILL.md` and `.pi/prompts/<name>.md`
inside the burrow workspace before dispatch (§11.K). Malformed envelopes
(non-JSON, missing/empty `name`, non-string `body`, duplicate names, unsafe
names containing `/`, `\`, `.`, `..`) abort seeding with the same
`RunSpawnError` shape as `expertise_seed`.

Inheritance solves the "thousand repos" problem: `base-coding-agent` defines defaults, role-specific bots override only what differs. One PR to canopy updates every descendant.

### 4.3 The composition flow

When warren spawns a run:

1. **Resolve agent** — `cn render <agent-name>` against the canopy repo. Returns a single object with all sections expanded after inheritance/mixin resolution. The rendered JSON is persisted on the run row (`runs.rendered_agent_json`) and **frozen for the lifetime of the run** — mid-run edits to canopy do not affect in-flight runs. Run-time agent identity always reads from `runs.rendered_agent_json`, never from a re-render.
2. **Provision burrow** — `POST /burrows` to burrow with `{ projectRoot, branch?, baseBranch?, network?, ... }` derived from the agent's `burrow_config` and the project's local clone path. Burrow returns 201 + `Burrow` (id, workspace path, branch, state). Warren records `burrow_id` on the run.
3. **Seed the burrow** — `buildSeedFiles(agent)` returns an `HttpWorkspaceFile[]` covering the five workspace drops (`.canopy/agent.json`, `.mulch/expertise/<domain>.jsonl` from `expertise_seed`, `.seeds/workflow.txt`, `.pi/skills/<name>/SKILL.md` from `pi_skills`, `.pi/prompts/<name>.md` from `pi_prompts`). The list rides along on the step-2 `POST /burrows` as `seed.files`, so provision-and-seed is a single atomic round-trip — burrow rolls the burrow back on its side if any file fails validation, and warren never observes a half-seeded workspace (R-07; see §11.A).
4. **Dispatch** — `POST /burrows/:burrow_id/runs` with `{ agentId, prompt, metadata? }`. Burrow returns 201 + `Run` in `state='queued'`; its run loop picks it up. Warren records the burrow run id in `runs.burrow_run_id`.
5. **Stream** — `GET /runs/:burrow_run_id/stream?follow=1` (NDJSON, chunked HTTP). Warren persists every event into its own `events` table (see §9) keyed by warren run id, then fans out to UI subscribers. UI clients hit warren's own `/runs/:id/events?follow=1`, which serves history from the warren log + tails the live stream concurrently. If warren restarts mid-run, on boot it re-subscribes to burrow's stream from `MAX(events.burrow_event_seq)+1` to backfill anything missed.
6. **Reap** — on run terminal state, copy the burrow's `.mulch/expertise/*.jsonl` back to the project's persistent `.mulch/` with **last-write-wins by record `ts`** (§11.A); close any seeds the agent marked done by reading the burrow's `.seeds/issues.jsonl` via `HttpClient.files.read` (R-07); push the workspace branch. The `mulch_merge` sub-step still reads off shared disk pending burrow's file-listing endpoint (`burrow-18ca`, tracked by `warren-7f7c`) — once shipped, that read flips to `HttpClient.files.list` + `.files.read` and warren's reap goes fully HTTP. **Commit/push contract:** the agent commits inside the sandbox; reap pushes from the host. Sandboxed agents have **no GitHub auth path** in V1 (`warren-1a09`: the supervisor's `insteadOf` rewrite lives in `/root/.gitconfig`, which burrow's bwrap profile does not bind), so agent-side `git push` is structurally broken — the canopy `claude-code` prompt instructs commit-only and warren reap is the actual push mechanism. After push, reap counts commits ahead of `baseBranch` (`git rev-list --count <baseBranch>..HEAD`) and surfaces `commitsAhead` on the reap summary; `commitsAhead: 0` fires a `reap.empty_push` event so a push that landed nothing (the `warren-f3bb` shape: agent never committed, push exit-0'd against unchanged HEAD) is observably distinct from a real-work push.

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
│        └─── shell: cn render / sd list / git                           │
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
- **`warren`** — Bun.serve, the platform process. HTTP API + UI + scheduler tick (single-flight in-process loop, §11.I). The V2 webhook receiver will run in the same process.
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
| Cron | **`croner`** (in-process tick) | Tz/DST-aware, ~30 KB, no native deps. Single in-process tick wrapped in a single-flight guard; cadence via `WARREN_SCHEDULER_TICK_MS` (§11.I). |

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
│   ├── warren-config/          # per-project .warren/ loader (§11.H, R-02)
│   │   ├── schema.ts           # zod: triggers.yaml + defaults.json
│   │   ├── load.ts             # missing-vs-malformed envelope, never throws
│   │   ├── cache.ts            # per-project cache invalidated on refreshProject
│   │   └── errors.ts           # WarrenConfigUnavailableError + per-file codes
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
│   ├── triggers/               # in-process cron tick + scheduled-seed dispatch (§11.I, R-06)
│   │   ├── schema.ts           # TriggerSummary wire envelope
│   │   ├── repo.ts             # triggers table CRUD (composite-string PK)
│   │   ├── cron.ts             # croner facade — parse + nextRun
│   │   ├── seeds-extension.ts  # sd list / sd update --extensions shell-out
│   │   ├── dispatch.ts         # spawnRun with trigger='cron'|'scheduled'
│   │   ├── tick.ts             # single-flight tick loop
│   │   ├── config.ts           # WARREN_SCHEDULER_TICK_MS / WARREN_SCHEDULER_DISABLED
│   │   └── errors.ts
│   └── scheduler/              # (V2) GitHub webhook receiver
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
GET    /projects/:id/warren-config — parsed .warren/ envelope (§11.H, R-02)
GET    /projects/:id/triggers   — parsed triggers.yaml joined with last/next-fire state (§11.I, R-06)
POST   /projects/:id/triggers/:triggerId/run — Run Now: dispatch trigger inline with trigger='manual'

POST   /runs                    — { agent, project, prompt } → spawn
GET    /runs                    — list with filters (status, agent, project)
GET    /runs/:id                — detail + summary (includes rendered_agent_json)
GET    /runs/:id/events?follow=1 — NDJSON event tail (warren log + live tail)
POST   /runs/:id/steer          — send steering message (proxies to burrow inbox)
POST   /runs/:id/cancel         — graceful cancel (proxies to burrow)

GET    /healthz                 — liveness
GET    /readyz                  — readiness (canopy reachable, burrow reachable)

# V2 — deferred
POST   /webhooks/github         — GitHub webhook target (event-driven trigger half of the scheduler)
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
  trigger TEXT                  -- 'manual' | 'cron' | 'scheduled' (V2 adds 'webhook'); arbitrary strings accepted (mx-513713)
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

-- V1 — scheduler state (R-06, §11.I)
triggers (
  id TEXT PRIMARY KEY,          -- composite: '<projectId>:<triggerId>'
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  last_fired_at TEXT,
  next_fire_at TEXT,
  last_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL
);
-- Trigger definitions themselves live in <projectPath>/.warren/triggers.yaml; this
-- table only holds dispatch state. Row identity comes from the YAML entry's
-- triggerId (mx-55296f); a project delete cascades, a run delete clears the back-ref.

-- V2 — deferred
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
BURROW_TOKEN=$(openssl rand -hex 32)
fly secrets set \
    WARREN_API_TOKEN=$(openssl rand -hex 32) \
    BURROW_API_TOKEN=$BURROW_TOKEN \
    WARREN_BURROW_TOKEN=$BURROW_TOKEN \
    ANTHROPIC_API_KEY=... \
    GITHUB_TOKEN=...
# Optional: layer a custom canopy library on top of the built-ins:
#   CANOPY_REPO_URL=https://github.com/<you>/agents.git
fly deploy
```

`BURROW_API_TOKEN` (read by `burrow serve`) and `WARREN_BURROW_TOKEN` (read by warren's burrow-client) are the two ends of one channel and **must hold the same value** — the supervisor validates equality at boot (warren-d317) and refuses to spawn burrow + warren if either is missing or they disagree, instead of letting `burrow serve` crash-loop with `[validation_error]` and warren 401 on every dispatch. `WARREN_API_TOKEN` is the browser-facing bearer; rotate the three independently. For loopback-dev only, set `WARREN_BURROW_NO_AUTH=1` to skip burrow auth (and the validation).

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
- **Seeding (run start, step 3 of §4.3).** Warren reads `expertise_seed` lines from the rendered agent JSON, groups them by `domain`, and emits one `HttpWorkspaceFile` entry per domain (`.mulch/expertise/<domain>.jsonl`, canonical mulch record JSONL — one record per line) alongside the `.canopy/` / `.seeds/` / `.pi/` drops. The whole list ships as the `seed.files` payload on `POST /burrows` via `HttpClient.burrows.up({ seed: { files } })` (burrow R-07, plan `bur-pl-2467`). Burrow validates and writes the files atomically with provisioning — a malformed record or a seed-side filesystem error rolls the burrow back on burrow's side before warren observes a `burrow_id`. This replaces the prior "shell out to `ml record` inside the burrow workspace via `burrow exec` (or equivalent)" sketch: warren never reaches past the HTTP seam onto disk, and the seed payload is the contract.
- **Reap (run end, step 6 of §4.3).** Warren reads `<burrow-workspace>/.mulch/expertise/*.jsonl` and merges each record into the project's persistent `.mulch/expertise/<domain>.jsonl` using the project's local clone path. The `seeds_close` sub-step has migrated to `HttpClient.files.read('.seeds/issues.jsonl')` (warren plan `pl-a31c` step 3, warren `0.2.0`); `mulch_merge` still reads off the shared `.mulch/expertise/` directory because burrow has no file-listing endpoint yet — once `burrow-18ca` lands, it flips to `HttpClient.files.list` + `.files.read` and the warren↔burrow seam is fully HTTP on the read side too. Merge rule: **last-write-wins by record `ts` field**. Conflict resolution:
  - Same `id` (named record), incoming `ts > existing ts` → overwrite, emit a warren event `mulch.record.updated`.
  - Same `id`, incoming `ts <= existing ts` → drop incoming, emit `mulch.record.skipped`.
  - No `id` (anonymous record) → append, no conflict possible.
- **Failure mode.** Reap errors (disk full, schema violation) do not fail the run — they are logged and surfaced as a `reap_failed` event on the run. The agent's work is preserved on the branch even if expertise capture fails.
- **Why not bind-mount.** Bind-mounting the project's `.mulch/` into the sandbox would break burrow's isolation contract and risks corrupting the project's expertise log if the agent runs `ml` commands incorrectly. The reap step is the seam.
- **Why not "agent commits mulch as a branch artifact".** Requires every agent definition to know about persistence mechanics. The reap step is invisible to agents — they just call `ml record` as documented in canopy/mulch.
- **Why HTTP-and-not-shared-disk for seed + close.** Same reasoning that produced burrow's R-07: shared disk is an artifact of co-tenancy, not the contract. Warren's other warren↔burrow paths (spawn, dispatch, stream, steer, cancel) are typed HTTP; the seed + reap paths were the last consumers of the disk seam. Closing it makes a future remote-burrow topology possible without re-architecting the spawn path, and locks every workspace mutation behind a contract burrow's tests already pin (`bur-pl-2467`).

### 11.B Resolved decisions

| Question | Resolution | Where |
|---|---|---|
| Process supervisor | Small Bun parent process (`src/supervisor/main.ts`), zero non-Bun deps. | §10.3 |
| Frontend stack | React + Vite + shadcn/ui + Tailwind. | §6 |
| Mulch capture | Per-run isolated `.mulch/`, post-run reap, last-write-wins-by-ts merge. | §11.A |
| Run cancellation | `POST /runs/:id/cancel` proxies to burrow's `POST /runs/:burrow_run_id/cancel`. Hard-stop = `DELETE /burrows/:burrow_id` is V2; not needed for V1. | §4.3 |
| Burrow API contract | Burrow's `/openapi.json` is the source of truth. Warren generates a typed client against it. | §4.3 |
| Burrow shippability | All 21 routes implemented as of `burrow@7926a0e` (2026-05-08). `POST /burrows` no longer returns 501. | — |
| `CANOPY_REPO_URL` is optional (warren-d3e9, 2026-05-10) | Warren ships built-in `claude-code`, `sapling`, and `pi` agents inline (`src/registry/builtins/`); the canopy library is a power-user override, not a hard dependency. Boot seeds built-ins; refresh upserts library agents on top (same-named library agents win). `warren doctor` and `/readyz` treat unset `CANOPY_REPO_URL` as info, not failure. `POST /agents/refresh` and `warren register-agent` 400 with a friendly hint when no library is configured. `GET /agents` returns `source: "builtin" \| "library"` provenance derived from `frontmatter.source`. | §10.2, §11.B |

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

### 11.H `.warren/` directory convention (2026-05-10)

R-02 from `ROADMAP.md` shipped via plan `pl-5d74` (warren-571f) before the
V2 phase opens. Worth pinning in V1's frozen record because the warren ↔
project-repo seam now has a third tier alongside `.canopy/` (prompts) and
`.mulch/` (expertise).

**Layout.** Each project repo may contain a `.warren/` directory with two
optional files:

```
.warren/
  triggers.yaml      # array of trigger entries (cron today; webhooks future)
  defaults.json      # per-project default role / branch / prompt
```

Both files are optional; the loader's envelope returns `null` for missing
files instead of erroring (`mx-66d478`), so existing project repos keep
working unchanged.

**Format choice.** `triggers.yaml` is YAML (cron expressions read better;
arrays-of-objects are noisier in TOML/JSON). `defaults.json` is JSON despite
the original ROADMAP sketch saying YAML — the file is small, structurally
flat, and matches the rest of os-eco's JSON wire surface. Format choice
recorded as `mx-2cefdd`; YAML parser is `js-yaml ^4.1.1` to match mulch +
overstory (`mx-8b6896`).

**Schema.** `triggers.yaml` is `Array<Trigger>` with a `kind:` discriminator
(only `'cron'` is implemented today; `kind:` exists so future webhook
entries can land without a breaking schema rev — `mx-3636de`). Cron-token
validation is intentionally loose (5 or 6 whitespace-separated fields,
non-empty); R-06 owns full grammar checking when it wires in croner
(`mx-40fe51`). `defaults.json` is `{ defaultRole?, defaultBranch?,
defaultPrompt? }` — all optional, all strict.

**Loader contract** (`src/warren-config/load.ts`):

- Returns `LoadedWarrenConfig = { triggers: TriggersConfig | null,
  defaults: DefaultsConfig | null, errors: WarrenConfigFileError[] }`.
- Missing file → entry is `null`, no error.
- Present-but-malformed file → entry is `null`, error appended with code
  (`yaml_parse | json_parse | schema_invalid`) and message.
- Per-project cache (`src/warren-config/cache.ts`) is invalidated inside
  `refreshProject` and `deleteProject` (`mx-61c0e6`) so the next request
  reparses; this avoids the stale-config race called out in pl-5d74 risk #4.

**HTTP surface.** `GET /projects/:id/warren-config` returns the
`LoadedWarrenConfig` envelope verbatim (`mx-adf588`); 404 if the project
doesn't exist; `WarrenConfigUnavailableError` joins the existing
`BurrowUnreachableError` / `CanopyUnavailableError` /
`ProjectUnavailableError` family (`mx-bd1f9f`).

**UI surface.** Project detail (`src/ui/src/pages/ProjectDetail.tsx`,
`mx-dc191e`) renders three blocks per envelope: triggers list, defaults
key/value, per-file errors. Read-only in V1 — editing the YAML/JSON is a
git operation; warren only surfaces the parsed view (`mx-a5e30e`).

**Diagnostics.** `warren doctor` and `/readyz` emit a `warren_config` check
that walks every loaded project and aggregates `errors[]` into a single
diagnostic row (`mx-f37c30`). Doctor's check ordering is now eight entries
(`mx-1a70ef`); the eighth slot is `warren_config`.

**Acceptance.** Scenario 14 (`scripts/acceptance/scenarios/14-warren-config.ts`)
exercises absent / valid / malformed against `/readyz` rather than spawning
`warren doctor` as a child, because doctor would be running against the
wrong DB (`mx-e959c0` documents the rationale).

**Scope deliberately deferred to R-04.** `defaults.defaultRole` is
parsed but spawn still falls back to `WARREN_DEFAULT_AGENT`;
`defaults.defaultPrompt` has no template-substitution consumer yet. As of
2026-05-11 the trigger half is no longer deferred — R-06 (§11.I) dispatches
`triggers.yaml` entries on a 60s tick.

### 11.I Scheduler (cron + scheduled-for, 2026-05-11)

R-06 from `ROADMAP.md` shipped via plan `pl-2f15` (warren-3f59). The
scheduler is the only consumer of the trigger half of `.warren/` (§11.H) and
the warren-side consumer of seeds' `extensions.scheduledFor` (seeds v0.4.3).

**Sources.** Two trigger kinds dispatch per tick:

- **Cron** — entries in `<projectPath>/.warren/triggers.yaml` with `kind: cron`
  and a cron expression. Warren-config parses the YAML (loose 5-or-6-token
  validation, `mx-40fe51`); the scheduler hands the expression to `croner`
  for the strict pass at fire time (`mx-5199d0`). Dispatched runs carry
  `trigger='cron'`.
- **Scheduled seeds** — `sd list --format json` against the project's
  `.seeds/` finds seeds whose `extensions.scheduledFor` (ISO-8601) is in
  the past. Dispatched runs carry `trigger='scheduled'`. The `trigger` column
  accepts arbitrary strings (`mx-513713`); current call-sites are `'manual'`
  (default and Run Now), `'cron'`, and `'scheduled'`.

**Tick.** One in-process loop, lives inside `bootServer`'s lifecycle. Cadence
via `WARREN_SCHEDULER_TICK_MS` (positive int, default 60000); disable with
`WARREN_SCHEDULER_DISABLED=1` (`mx-8e42e9`). The tick wraps itself in a
single-flight guard so a slow tick can't pile up — overlap is impossible,
worst case is reduced effective cadence rather than duplicated fires
(`mx-eb4a3a`). Acceptance harness compresses the cadence to 1s globally via
`scripts/acceptance/run.ts` extra-env (`mx-883866`). Teardown order on
shutdown is `handle.stop()` (HTTP listener) → `scheduler.stop()` →
`bridges.stopAll()` → burrow stop (`mx-15bd97`).

**Table shape.** Migration 0005 adds the `triggers` table (see §9). PK is a
composite string `'<projectId>:<triggerId>'` (`mx-55296f`), not a multi-column
key. `project_id` FK cascades on project delete; `last_run_id` FK is
`ON DELETE SET NULL` so reaping an old run never blocks the trigger row.
`TriggersRepo.upsert` uses undefined-vs-null semantics on patch fields:
omitted (`undefined`) preserves the existing value, explicit `null` clears
it (`mx-18a708`). First observation of a fresh trigger seeds
`lastFiredAt=now` and computes `nextFireAt = parsedCron.nextRun(now)`
(`mx-ac8acd`) — a fresh row never fires immediately, which is what gives the
"no catch-up after downtime" property.

**Failure semantics.**
- *Catch-up after warren downtime:* no. Cron is "fire at time T," not "fire
  N missed runs." Operators who want replay press Run Now.
- *Closed or missing referenced seed:* skip + structured log + surface as a
  `lastSkipReason` on the trigger summary in `GET /triggers`. Not a hard
  failure.
- *Cron parse failure on a YAML entry:* surfaced in the warren-config errors
  envelope on `GET /triggers` so operators see the failing entry without
  tailing logs. Other triggers in the same file continue to fire.
- *Project delete races with an in-flight tick:* per-project section of the
  tick is wrapped in try/catch; the FK cascade on `triggers.project_id`
  keeps the warren side consistent regardless.
- *Timezone / DST:* per-trigger `timezone` field is supported by croner.
  Default UTC when omitted. DST transitions in zoned triggers follow croner's
  semantics (skip the "lost" hour, fire once for the "repeated" hour) —
  document the chosen zone explicitly in `triggers.yaml`.

**Seeds write path.** When a scheduled seed fires, the write order is:
spawn run FIRST → if the spawn succeeds, attempt
`sd update <seed> --extensions '{"scheduledFor": null, "lastScheduledRun": "<iso>"}'`
(`mx-a2ea60`). The triggers row's `last_fired_at` is also written before
the extension clear is attempted — warren's DB is the source of truth, and
a failed clear gets surfaced as a system event on the dispatched run rather
than dropping the dispatch. This makes the duplicate-dispatch hazard fail
safe: the next tick reads the warren row, sees the recent fire, and skips.

**HTTP surface.** `GET /projects/:id/triggers` returns
`{triggers: TriggerSummary[], errors: WarrenConfigFileError[]}` (`mx-a93eb5`).
`POST /projects/:id/triggers/:triggerId/run` resolves the trigger from
warren-config, dispatches inline with `trigger='manual'` (Run Now is a human
press, not a cron fire), and returns the run row 201 (`mx-f3b48d`). Both
routes require the project row first (`mx-fa6ac7`) and surface
`WarrenConfigUnavailableError` if the loader can't read the YAML.

**UI surface.** `TriggersBlock` in `src/ui/src/pages/ProjectDetail.tsx`
(`mx-28b6a2`) renders the wire envelope: one row per trigger with cron
expression + last/next fire columns + Run Now button. YAML editing remains a
git operation per the R-02 read-only posture (`mx-a5e30e`).

**Acceptance.** Scenario 15
(`scripts/acceptance/scenarios/15-triggers-roundtrip.ts`) exercises three
shapes (`mx-6fc1ef`): a cron entry that fires once without double-dispatch,
a `scheduledFor` in the past + one in the future, and a trigger that
references a missing or closed seed. The scenario bootstraps
`.seeds/config.yaml` in the sample-source repo before driving the scheduler
(`mx-fc2827`).

**Adding new schema fields or new trigger kinds.** Per `mx-5339d5`, update
three places in lockstep: ROADMAP R-06 (or its successor entry), this section
(§11.I), and acceptance scenario 15. New `TriggerSchema` fields must stay
additive (all-optional) so existing `triggers.yaml` files keep parsing —
warren-config (R-02) and the dispatcher (R-06) co-own the schema.

### 11.J Org-readiness direction (2026-05-11)

V1 is shipped — manual dispatch, cron + scheduled-for, single-user box. The
next direction, decided 2026-05-11, is to make warren self-hostable by an
engineering organization of 50+ ICs without forcing a fork. V1's
"one token, one user, one box" posture stays accurate for what's shipped;
the additions below extend the seams that are already in place rather than
rewriting them. None of this changes V1 — `docker compose up` against the
current code still works exactly the same.

**Why now.** Warren is being positioned externally as the answer to the
"ephemeral cloud agents that complete a task, validate it, open a PR, then
spin down" problem that vertical-SaaS engineering teams keep asking for.
The existing architecture (warren↔burrow HTTP seam, canopy as agent source,
seeds as work queue) already points at that shape. What's missing for an
org to actually adopt it on their own infra is: multi-user identity, a
backend an SRE team will operate, MCP, audit, budgets, and the ability for
one warren to dispatch across more than one host.

**The eight planned additions, in priority order.** Full design in
`ROADMAP.md`; this section is the cross-reference:

1. **Remote burrow workers** (R-12) — one warren, N burrow workers across
   hosts. Lifts the "single box is the concurrency ceiling" limit. Burrow
   side tracked in `burrow-c47a` (the protocol design — transport, auth,
   worker registration, placement). Warren side is a worker registry + a
   dispatch router. Today's local burrow keeps working with zero registered
   remote workers, so this is additive.
2. **Bring-your-own database** (R-13) — `WARREN_DB_URL`, Postgres as a
   first-class backend alongside SQLite. SQLite stays the home-server
   default. Burrow's own SQLite stays per-worker (it's run-local state, not
   org truth).
3. **Per-user identity / SSO** (R-09, repromoted from `[deferred]`) — OIDC
   login replacing the single bearer token; the bearer stays as a
   service-account path for CI. Prerequisite for R-16 and R-17.
4. **MCP support** (R-15) — `mcp_servers` block in canopy frontmatter,
   threaded into the agent's runtime config; burrow-side per-run credential
   mount (same architectural shape as the `.gitconfig` resolution in §11.G).
5. **Cross-project activity UI + stable OpenAPI** (R-14) — a global "what
   is every agent doing right now" view; a versioned OpenAPI spec so teams
   can build their own dashboards (closes §11.C #1).
6. **Audit log** (R-16) — append-only dispatch/steer/cancel/secret-read
   ledger keyed to the authenticated user. Depends on R-09.
7. **Cost & concurrency guardrails** (R-17) — per-user / per-project token
   budgets and concurrent-run caps enforced at dispatch time. Depends on R-09.
8. **GitHub App** (R-18) — installation-scoped tokens with per-repo
   allowlists replacing the shared PAT; short-lived tokens minted per run.

**What stays single-tenant.** "Not a multi-tenant SaaS" remains a non-goal
(§2.3). The deployment unit is one team / one org self-hosting one warren.
SSO does not turn warren into a hosted service — it turns one warren into
something a 50-person team can share without sharing a credential.

**Cross-repo footprint.** Only burrow has an open dependency: the
`burrow-c47a` design (remote-worker protocol) gates R-12. Seeds, canopy,
mulch, and sapling have no new asks from this direction — the org-readiness
work is almost entirely warren-internal. Update the cross-repo readiness
table in `ROADMAP.md` when `burrow-c47a` produces a sub-plan.

### 11.K Pi runtime support (2026-05-12)

The `pi` (`@earendil-works/pi-coding-agent`) runtime is the third built-in
coding agent alongside `claude-code` and `sapling`. It shipped as
plan `pl-4374` (warren-39c1) in seven phased steps: a cross-repo burrow
piRuntime contract (`warren-0e06` → `burrow-8aff`), a parity-shape builtin
(`warren-d18e`), workspace seeding for pi-namespaced canopy sections
(`warren-846b`), a multi-provider surface (`warren-f8c0`), per-run cost
tracking (`warren-a7dc`), event-model widening in the UI (`warren-70af`),
and this docs/decision record (`warren-f1da`).

**Why a third built-in.** Pi is distinguished from `claude-code` and
`sapling` by three properties warren operators care about: (1) a unified
multi-provider LLM API (Anthropic, OpenAI, Google, Bedrock, Vertex,
DeepSeek, Groq, Mistral, Azure OpenAI, and custom OpenAI-compatible
endpoints) — pick the best model per task without standing up a second
runtime; (2) first-class `get_session_stats` RPC reporting tokens
(input / output / cacheRead / cacheWrite) + cost (USD) per session — see
what a run actually cost; (3) a clean customization surface
(`.pi/skills/<name>/SKILL.md`, `.pi/prompts/<name>.md`) that maps onto
warren's existing canopy-section seeding flow.

**Built-in shape.** `src/registry/builtins/pi.ts` (`PI_BUILTIN`,
`mx-4888d2`) mirrors `SAPLING_BUILTIN` exactly: `name='pi'`, `version=1`,
`sections.system` + `sections.burrow_config` with `network='open'`,
`frontmatter.source='builtin'`, `resolvedFrom=['builtin:pi']`. Wired into
`BUILTIN_AGENTS` (`src/registry/builtins/index.ts`), asserted by
`builtins.test.ts`, surfaced in the Agents page (`mx-723c5e`), and covered
by acceptance scenario 16 (`mx-05f62f`). Warren forwards `agent.name='pi'`
to burrow as the runtime id via the existing
`agent.name → burrow agentId` convention (`mx-7352f4`, `mx-c8fc41`); burrow's
piRuntime is registered in the `AgentRegistry` per the warren-0e06 contract
(`mx-0db923`).

**Burrow piRuntime contract.** Pinned at `mx-0db923`:
`id='pi'`; `displayName='Pi'`; `supportsResume=true` (pi has
`--continue` / `--session`, *not* one-shot like codex); spawn shape
`pi --mode rpc --no-session [--no-extensions] --provider <…> --model <…>`
(RPC mode, not JSON — chosen for the bidirectional steer / abort /
get_state / get_session_stats surface that warren's spawn-per-turn flow
assumes). RPC commands warren consumes: `prompt`, `steer`, `abort`,
`get_state`, `get_session_stats`. Event kinds warren's parser surfaces:
`agent_start`/`end`, `turn_start`/`end`, `message_start`/`update`/`end`,
`tool_execution_start`/`update`/`end`, `queue_update`, `compaction_start`/`end`,
`auto_retry_start`/`end`, `extension_error`. `envPassthrough` widens beyond
claude-code's `ANTHROPIC_*` + `CLAUDE_CODE_OAUTH_TOKEN` set to include
`OPENAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `PI_API_KEY`,
`GROQ_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY` — implemented at the
runtime-contract layer (burrow's `envPassthrough` escape hatch), so warren
does not change `docker-compose.yml` to add a new provider. If burrow ships
piRuntime under a different id (e.g. `pi-coding-agent`), warren's
`BUILTIN_AGENTS` name must change in lockstep — the two strings must match
exactly (`mx-7352f4`).

**Canopy sections.** Pi accepts two extra canopy sections beyond the
generic enumeration in §4.2: `pi_skills` and `pi_prompts`. Bodies are
JSON-Lines `{name, body}` envelopes, materialized by
`src/runs/seed.ts` into the burrow workspace before dispatch
(`mx-413c1b`): `pi_skills` writes to `.pi/skills/<name>/SKILL.md`
(per-skill subdir matching the `agentskills.io` standard); `pi_prompts`
writes to `.pi/prompts/<name>.md` (flat). Both reject malformed JSON,
non-object lines, missing/empty `name`, non-string `body`, duplicate
names, and unsafe names with `RunSpawnError` — same shape as
`expertise_seed`. Sections are pi-namespaced (not generic `skills`) so a
canopy author can land a generic `skills` section on a base agent and have
it remain ignored by pi without collision.

**Multi-provider surface.** `AgentDefinition.frontmatter` grows two
well-known optional string fields: `provider` and `model` (`mx-20a3b9`).
Built-in `PI_BUILTIN` leaves both unset by default — pi resolves from its
own `~/.pi/agent/models.json`. `POST /runs` accepts optional
`providerOverride` + `modelOverride` strings (`mx-fd6008`); they thread onto
`agent.frontmatter` before freeze, so the rendered agent on
`runs.rendered_agent_json` records exactly what ran. `NewRun.tsx` surfaces
the pair as two free-text Inputs in a 2-col grid (`mx-0048cb`), auto-filled
from the selected agent's frontmatter.

**Cost + token accounting.** Migration 0006 adds five nullable columns to
`runs`: `cost_usd REAL`, `tokens_input INTEGER`, `tokens_output INTEGER`,
`tokens_cache_read INTEGER`, `tokens_cache_write INTEGER`. `RunsRepo.attachStats`
mirrors `attachBurrow`'s partial-input semantics (`mx-49272e`): omitted fields
preserve existing values; explicit `null` does not clear. The bridge layer
issues `get_session_stats` against pi at run-start and run-end via a
`PiStatsClient` injected into `bridgeRunStream` (`mx-916eb6`); persisted
cost is the run-end-minus-run-start delta (defends against the multi-session
cost double-count when pi resumes via `--continue` / `--session`).
Non-pi runs leave every column `null`. RPC failures are logged as a system
event and do not fail the run. `RunDetail.tsx` renders a header cost badge
using `formatCostUsd()` (`mx-9d987a`): `≥$1` → 2 decimals, `<$1` → 3 decimals;
badge omitted when `cost_usd` is `null`. `Runs.tsx` adds an opt-in Cost
column (hidden by default, toggled via the toolbar).

**Event model.** Pi's wider event vocabulary (`compaction_start`/`end`,
`auto_retry_start`/`end`, `extension_error`, `queue_update`) is collapsed by
burrow's pi parser (`src/runtime/parsers/pi.ts`) into burrow's stable
event taxonomy, with the original pi envelope `type` preserved in
`payload.type`. `RunDetail.tsx` `EventLine` detects pi sub-kinds by peeking
at `payload.type` when `event.kind` is `state_change` or `telemetry`
(`mx-66ff69`); `PI_SUBKIND_LABELS` maps each to a friendlier display label;
`extension_error` additionally tints `rose-700` like stderr. A kind-direct
match (e.g. `event.kind === 'compaction_start'`) is also honored so a
future burrow release that promotes any of these to first-class kinds Just
Works without a UI rev. Unknown kinds fall through to the existing generic
renderer.

**Pi extensions are deferred** (`.pi/extensions/*.ts`). Pi extensions are
TypeScript source modules with access to `ExtensionAPI` (`registerTool`,
`registerCommand`). Encoding TS source inside a canopy section body works
but is awkward — operators lose `tsc` / `biome` on the source, syntax errors
only surface at run time, and the canopy diff view becomes useless. The
right fix is a canopy *artifact type* (file-shaped, not section-shaped)
that warren materializes alongside the rendered `AgentDefinition`. That is
a canopy-side change first. V1 ships `pi_skills` + `pi_prompts` (already
file-shaped + markdown) and leaves `.pi/extensions/` to a follow-up plan
once canopy ships artifact types.

**No MCP support on pi.** Pi explicitly has no MCP — its tool surface is
built-in plus extensions only. This is a worldview difference, not an
omission: R-15 (MCP via canopy frontmatter, post-V1) stays scoped to
`claude-code` and `sapling` and is *not* a blocker for the `pi` built-in.
Operators wanting MCP-style external tools on pi should reach for pi's
extensions story once canopy artifact types land.

**Headless provider-auth posture.** Warren passes provider API keys into
the sandbox via burrow's `envPassthrough` (see contract above). Pi's
interactive `/login` flow (OAuth for Anthropic Claude Pro/Max, ChatGPT
Plus, GitHub Copilot, etc.) is unsupported by design: warren is headless.
A future "bring-your-own-browser" path for OAuth-only providers is
reconsiderable in V2 if there is demand; in V1, pi is API-key-only.

**Why not ship pi as a canopy library agent?** Built-ins exist precisely
so a fresh warren install can dispatch a run without `CANOPY_REPO_URL` set
(see §2.1, `src/registry/builtins/index.ts`). `claude-code` and `sapling`
both ship inline; `pi` is the third member of the same set and deserves the
same treatment. A library-only path would mean every operator who wants
pi has to stand up a canopy fork first — high friction for the
"multi-provider out of the box" value proposition.

**Adding a fourth built-in (or schema-extending pi).** Per `mx-39a64f`,
five places update in lockstep: (1) `src/registry/builtins/<name>.ts`,
(2) `BUILTIN_AGENTS` array + re-export in `src/registry/builtins/index.ts`,
(3) `builtins.test.ts` assertions on `BUILTIN_AGENT_NAMES` + `readAgentSource`,
(4) `scripts/acceptance/scenarios/13-container-smoke.ts` builtin-names check,
(5) `src/ui/src/pages/Agents.tsx` header + empty-state copy. Scenario
`02-agents-refresh.ts` already filters on `source !== 'builtin'`
(`mx-ae877e`), so it auto-extends without a code change.

---

## 12. Relationship to other os-eco tools

| Tool | Warren's relationship |
|---|---|
| **burrow** | Hard dependency. HTTP API consumer via the typed `HttpClient` from `@os-eco/burrow` (burrow's §15.6). Warren cannot run without burrow. Burrow's HTTP API is shipped as of `7926a0e` (2026-05-08); all routes warren needs (`POST /burrows`, `POST /burrows/:id/runs`, `GET /runs/:id/stream`, `POST /burrows/:id/inbox`, `POST /runs/:id/cancel`, `DELETE /burrows/:id`, `GET /watch`) are live. |
| **canopy** | Hard dependency. Source of agent definitions. Cloned at startup, refreshed on demand. |
| **mulch** | Used per-project. Warren reads the project's `.mulch/expertise/` on the host to source `expertise_seed` lines and merges per-run mulch records back during reap (host-side disk write, last-write-wins-by-ts). The per-run `.mulch/` inside the burrow workspace is seeded via the `seed.files` payload on `POST /burrows` (R-07; see §11.A) — warren never shells out to `ml record` inside the sandbox. |
| **seeds** | Used per-project. Warren reads `sd ready` to surface the project's worklist in the UI; agents file/close seeds during runs. |
| **sapling** | One of three built-in harnesses (alongside `claude-code` and `pi`). Shipped as a pre-installed CLI in the container; selected per agent via `burrow_config`. |
| **pi** (`@earendil-works/pi-coding-agent`) | Third built-in harness, multi-provider with first-class per-run cost reporting. Shipped as a pre-installed CLI in the container; runtime contract lives in burrow's `AgentRegistry` (see §11.K). |
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
