# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] — 2026-05-13

Closes the last warren↔burrow disk-seam violations on the spawn and reap
paths by adopting burrow's R-07 HTTP file surface end-to-end. Warren no
longer writes the burrow workspace's `.canopy/` / `.mulch/` / `.seeds/` /
`.pi/` drops through shared `/data` — `src/runs/seed.ts` becomes a pure
builder returning `HttpWorkspaceFile[]`, and `spawnRun` threads the list
through `HttpClient.burrows.up({ seed: { files } })` so provisioning and
seeding land in a single atomic round-trip. Reap's `seeds_close` sub-step
flips to `HttpClient.files.read('.seeds/issues.jsonl')`; the
`mulch_merge` sub-step stays disk-bound pending burrow's file-listing
endpoint (`burrow-18ca`, tracked by `warren-7f7c`). Mechanical refactor,
no user-facing API changes — but the minor bump signals that the
warren↔burrow contract is now HTTP-only on every code path except
`mulch_merge` and `branch_push`, which unblocks the remote-burrow
topology that R-12 needs (warren plan `pl-a31c`, parent `warren-0a83`;
burrow plan `bur-pl-2467`).

### Changed

- **`refactor(runs)`** — `seedBurrowWorkspace` is gone; `buildSeedFiles(agent)`
  replaces it as a pure builder returning `HttpWorkspaceFile[]` with
  workspace-relative paths for the five drops (`.canopy/agent.json`,
  `.mulch/expertise/<domain>.jsonl` from `expertise_seed`, `.seeds/workflow.txt`,
  `.pi/skills/<name>/SKILL.md` from `pi_skills`, `.pi/prompts/<name>.md` from
  `pi_prompts`). `src/runs/seed.ts` no longer imports `node:fs/promises`; the
  `SeedFs` injection seam is removed. Same validation errors as the prior
  writer — malformed JSONL, missing `domain`, missing/invalid pi `name`/`body`,
  duplicate or unsafe pi names all surface as `RunSpawnError` at build time
  (warren-e238, pl-a31c step 1).
- **`feat(runs)`** — `spawnRun` ships the `buildSeedFiles` output as the
  `seed.files` payload on `HttpClient.burrows.up({ seed: { files } })`, so
  provisioning + workspace seed land in one atomic burrow round-trip.
  `buildSeedFiles` runs before the warren run row is created, so
  `expertise_seed` / `pi_skills` / `pi_prompts` validation surfaces as a
  clean `RunSpawnError` with no half-spawned row. Seed-validation failures
  inside `burrows.up` roll back on burrow's side before warren observes a
  `burrow_id` — the catch path sees `burrow === null` and no `DELETE
  /burrows/:id` fires. `SeedWorkspaceInput`, the `seedWorkspace` injection
  seam, and the temporary `writeSeedFilesToDisk` adapter are deleted;
  `src/runs/spawn.ts` no longer imports `node:fs/promises`. `spawn.test.ts`
  asserts on the `seed.files` payload posted to `/burrows` and replaces the
  old "seeding fails" case with an atomic-rollback case
  (`burrowsUpStatus: 422`, no DELETE) (warren-eaee, pl-a31c step 2).
- **`refactor(runs)`** — reap's `seeds_close` sub-step reads
  `<burrow-workspace>/.seeds/issues.jsonl` via
  `input.burrowClient.http.files.read('.seeds/issues.jsonl')` wrapped in
  `withTransportMapping` instead of `fs.readFile`. `NotFoundError` from
  `@os-eco/burrow-cli` is the no-op shape (agent never created the file →
  zero closures, no `reap_failed`); any other thrown error rethrows so
  `reapRun`'s outer catch records it as `reap_failed step=seeds_close`. The
  project-side `.seeds/issues.jsonl` write still flows through `ReapFs`
  because reap remains co-tenanted with the project clone on warren's disk.
  `reap.test.ts`'s `fakeBurrowClient` grows a `FakeBurrowClientOpts` arg
  with `seedsIssuesBody` + `filesRead` knobs; default behaviour throws
  `NotFoundError`, so every other test silently exercises the no-op path
  (warren-ae92, pl-a31c step 3).

### Docs

- **`docs(spec)`** — `SPEC.md` §4.3 step 3 + step 6 and §11.A "Seeding" /
  "Reap" / "Why HTTP-and-not-shared-disk" bullets re-pin the burrow-side
  seam as HTTP, not shared disk. §12's mulch row clarifies that warren
  reads/writes the project-side `.mulch/` directly on the host but seeds
  the per-run `.mulch/` via `seed.files`. The §5 ASCII diagram drops the
  stale `ml record` shell-out from warren's outgoing shell calls.

### Tracked follow-ups

- `warren-7f7c` — burrow follow-up filed as `burrow-18ca` (workspace
  file-listing endpoint). Once shipped, reap's `mulch_merge` sub-step
  becomes a mechanical change in `src/runs/reap.ts` `mergeMulch`:
  `HttpClient.files.list` + `.files.read` replace `fs.readdir` +
  `fs.readFile`, and the last warren↔burrow read-side disk seam closes.
  `branch_push` remains workspace-local and out of scope (would need a
  separate burrow primitive for remote-burrow topologies).

## [0.1.7] — 2026-05-13

Pi lands as the third inline built-in (alongside `claude-code` and
`sapling`), and warren grows the surrounding surface for it:
multi-provider frontmatter + per-run overrides, per-run cost + token
accounting on a new `runs.cost_usd` / `tokens_*` column family
(migration 0006), pi-namespaced canopy sections (`pi_skills` /
`pi_prompts`) materialized into the burrow workspace, and UI
rendering for pi's runtime event sub-kinds. Burrow CLI bumps
`0.2.7 → 0.2.8`, which ships the matching `piRuntime` so dispatching
`agent='pi'` round-trips end-to-end in production. Acceptance grows
scenario 16 (pi parity smoke). Docs reposition warren as a standalone
agent platform (the four os-eco tools framed as opt-in built-in
features, not required infrastructure) and the org-readiness cluster
(R-12 – R-18) joins the active forward direction in SPEC §11.J.

### Added

- **`feat(registry)`** — `pi` built-in agent ships inline alongside
  `claude-code` and `sapling` (warren-d18e, pl-4374 step 2). `PI_BUILTIN`
  mirrors `SAPLING_BUILTIN`'s parity shape (system + burrow_config
  sections, `network=open`, `frontmatter.source='builtin'`). Wired into
  `BUILTIN_AGENTS`, `builtins.test.ts`, the container-smoke scenario,
  and the Agents UI page header / empty-state.
- **`feat(registry)`** — `AgentDefinition.frontmatter.provider` and
  `frontmatter.model` are now well-known optional string fields. Two
  helpers: `readProviderFrontmatter()` narrows the open frontmatter bag
  to typed `{provider?, model?}` strings; `withProviderOverrides()`
  folds operator-supplied per-run overrides onto a freshly-cloned
  `AgentDefinition` (empty/whitespace are no-ops). `spawnRun` applies
  overrides **before** creating the run row, so both
  `runs.rendered_agent_json` and the `.canopy/agent.json` seeded into
  the burrow workspace carry the override-applied frontmatter. Base
  agent row stays untouched — overrides are per-run, not per-agent
  (warren-f8c0, pl-4374 step 4).
- **`feat(server)`** — `POST /runs` accepts optional
  `providerOverride` + `modelOverride` strings on the request body;
  `CreateRunInput` on the wire mirrors them.
- **`feat(ui)`** — `NewRunPage` surfaces a paired Provider/Model 2-col
  grid above the prompt textarea, auto-filling from the selected
  agent's frontmatter until the operator types. Empties are trimmed off
  the wire (warren-f8c0).
- **`feat(runs)`** — `seedBurrowWorkspace` materializes pi-specific
  canopy sections alongside `.canopy/agent.json`, `.mulch/expertise`,
  and `.seeds/workflow.txt`. `pi_skills` is a JSONL stream of
  `{name, body}` envelopes that render to
  `.pi/skills/<name>/SKILL.md` (one subdir per skill); `pi_prompts`
  renders to `.pi/prompts/<name>.md` (flat). Malformed JSON,
  missing/empty name, non-string body, duplicate names, and unsafe
  names (path separators, `.`, `..`) abort seeding with
  `RunSpawnError`, mirroring the existing `expertise_seed` shape. No
  behavior change for non-pi agents (warren-846b, pl-4374 step 3).
- **`feat(db)`** — migration 0006 adds nullable `cost_usd` +
  `tokens_input` / `tokens_output` / `tokens_cache_read` /
  `tokens_cache_write` to `runs`. `RunsRepo.attachStats` merges
  partial stat patches into the row using the same undefined-omitted /
  explicit-null-clears shape as `attachBurrow` (warren-a7dc).
- **`feat(runs)`** — `bridgeRunStream` gains an optional
  `PiStatsClient` that snapshots `get_session_stats` at run-start +
  `agent_end` and persists the **delta**. Resumed pi sessions would
  otherwise double-count prior turns; the delta keeps per-run figures
  honest (warren-a7dc).
- **`feat(ui)`** — `RunDetail` shows a cost badge with a tokens
  tooltip; `Runs.tsx` exposes an opt-in Cost column persisted in
  localStorage. Non-pi runs leave every new column null and render
  blank (warren-a7dc).
- **`feat(ui)`** — `EventLine` detects pi-runtime sub-kinds
  (`compaction_start/end`, `auto_retry_start/end`, `extension_error`,
  `queue_update`) by peeking at `payload.type` when `event.kind` is
  `state_change` / `telemetry` — burrow's pi parser collapses pi's
  wide vocabulary into the stable taxonomy and stores the original
  type in the payload. `extension_error` tints rose like stderr.
  Kind-direct matches are honored too, so a future burrow release
  promoting any of these to first-class kinds works without a UI rev
  (warren-70af).
- **`test(acceptance)`** — scenario 16
  (`scripts/acceptance/scenarios/16-pi-parity-smoke.ts`) dispatches
  `POST /runs agent='pi'` against the in-proc warren+burrow stack and
  asserts (a) `GET /agents/pi` returns `source='builtin'`, (b)
  `burrowId` / `burrowRunId` populated, (c) frozen
  `renderedAgentJson`, (d) ≥1 event lands in the events table. The
  acceptance harness registers a declarative pi stub via
  `burrow-with-stub.ts` (deterministic, no pi binary needed in CI);
  production warren talks to the real `piRuntime` in burrow 0.2.8
  (warren-d18e, warren-0e06).

### Changed

- **Burrow CLI bumped `0.2.7 → 0.2.8`** — burrow v0.2.8 (released
  2026-05-13) lands the built-in `piRuntime` (burrow-8aff, pl-5198).
  Pin bumped in all three lockstep locations (`package.json` +
  `bun.lock` + `Dockerfile` global install — see CLAUDE.md
  "Relationship to burrow") so warren's `BUILT_IN_RUNTIMES` sees pi at
  boot. Closes warren-0e06's four-condition gate end-to-end.

### Docs

- **`docs(readme)`** — repositions warren as a standalone agent
  platform (warren-e576). Leads with what warren does (spawn sandboxed
  agents at GitHub repos, watch live, steer, get a branch) instead of
  the four-tool composition. The os-eco data-plane tools
  (canopy/mulch/seeds/sapling) stay bundled in every image but are
  framed as opt-in built-in features — none required for a fresh
  install. Same code, same depth; only the public framing changes.
  README quickstart, SPEC §1 / §2.1 / §2.3, CLAUDE.md opener, package
  description, Dockerfile + fly.toml comments, and Agents/NewRun
  empty-state copy all updated in lockstep.
- **`docs(spec)`** — new `SPEC.md` §11.J pins the **org-readiness
  direction** (2026-05-11) into the V1 record: the seams to extend
  warren from "one team, one box" to a 50-engineer organization
  without forcing a fork. Covers SSO, remote burrow workers, Postgres
  backend, MCP, audit, budgets, GitHub App. New `SPEC.md` §11.K
  records **pi runtime support** as a frozen design entry: phased
  landing (pl-4374), built-in shape, burrow piRuntime contract,
  canopy sections, multi-provider surface, cost + token accounting,
  event-model widening, MCP omission, headless API-key auth posture.
  §1 / §2.1 / §3.2 / §4.2 / §11.B / §12 updated to name pi as the
  third built-in.
- **`docs(roadmap)`** — `ROADMAP.md` adds the org-readiness cluster
  (R-12 – R-18) plus R-19 preview environments, updates R-03's
  problem statement to list pi in the registry inventory, and logs
  the pl-4374 summary plus the three deferred-decision records under
  "Recently shipped". `WARREN_DEFAULT_AGENT` picks pi as a third
  option.

## [0.1.6] — 2026-05-10

R-06 lands: the cron half of the scheduler ships end-to-end. New
`src/triggers/` module (tick + dispatcher) wires into `bootServer`,
fires `.warren/triggers.yaml` entries via croner with no-catch-up
prev-vs-last semantics, and dispatches past-due `scheduledFor` seed
extensions as `trigger='scheduled'` runs. `GET /projects/:id/triggers`
+ `POST /projects/:id/triggers/:triggerId/run` surface scheduler
state in the API and UI (last/next-fire + Run Now button on Project
Detail). New `triggers` table (migration 0005) holds per-trigger fire
state. Acceptance scenario 15 drives the full cron + scheduled-for
round-trip against an in-proc warren+burrow. R-02's defaults consumer
also expands: NewRun pre-fills the agent picker from
`defaults.defaultRole` and the prompt textarea from
`defaults.defaultPrompt`. Webhook triggers remain V2; cron is in V1.

### Added

- **`feat(triggers)`** — `src/triggers/` module ships end-to-end
  (R-06, plan `pl-2f15`). Mirrors `src/warren-config/`'s layout:
  `errors`, `config` (env + tick-ms), `schema`, `cron` (croner
  facade), `repo`, `dispatch` (cron + scheduled), `seeds-extension`
  (`sd list` / `sd update --extensions` shell-outs), `tick`
  (`runTick` + `startScheduler`), `index`. `dispatchCronTrigger`
  encodes the no-catch-up posture via prev-vs-last (`mx-?`): a fire
  happens iff `previousRun(now) > lastFiredAt`, then stamps `now` and
  rolls `nextFireAt` forward — a 4-hour outage on an hourly trigger
  dispatches once, not four times. First observation seeds the row
  at `now` without firing. `dispatchScheduledSeed` walks `sd list`
  output, dispatches past-due `extensions.scheduledFor` as runs with
  `trigger='scheduled'`; per `pl-2f15` risk #4 the warren-side write
  happens first, and `clearScheduledFor` failures surface as
  `trigger.cleared_extension_failed` system events on the dispatched
  run. `startScheduler` wraps `runTick` in a single-flight guard
  (`pl-2f15` risk #5) so overlapping ticks log
  `scheduler.tick_skipped` instead of stacking; `stop()` drains the
  in-flight tick. Decisions recorded in mulch: croner over a
  homegrown 5-token parser, default-UTC tz, skip-and-log on missing
  seeds, no catch-up after downtime, warren row as source of truth
  for fire state (write-once contract).
- **`feat(db)`** — new `triggers` table (migration 0005) keyed by the
  composite string `<projectId>:<triggerId>` so each tick can write
  back `lastFiredAt` / `nextFireAt` / `lastRunId` without juggling a
  generated id (warren-9d8d). `project_id` cascades on delete (mirrors
  the `.warren/` clone disappearing with the project); `last_run_id`
  sets null on delete so a run cleanup doesn't orphan the trigger.
  `TriggersRepo.upsert` merges undefined-omitted patch fields and
  treats explicit `null` as a clear (same shape as
  `RunsRepo.attachBurrow`); `recordFire` is the dispatcher
  convenience that stamps `lastFiredAt` + `lastRunId` and rolls
  `nextFireAt` forward in one transaction.
- **`feat(server)`** — scheduler boots inside `bootServer` from
  `loadTriggerSchedulerConfigFromEnv` and registers `scheduler.stop()`
  on `WarrenServerHandle.stop` between handle stop and bridge/burrow/
  db shutdown so an in-flight tick mid-`spawnRun` drains cleanly
  (warren-0a1b). A new `DispatchSpawnFn` wraps `spawnRun` and calls
  `bridges.start(runId, burrowRunId)` so scheduled-run events flow
  into `warren.events` the same way `POST /runs` does.
- **`feat(server)`** — `GET /projects/:id/triggers` returns
  `TriggerSummary[]` joining parsed `.warren/triggers.yaml` entries
  with persisted scheduler state (`lastFiredAt` / `nextFireAt` /
  `lastRunId`) and a freshly-computed `nextFireAt` via croner;
  per-trigger `parseError` surfaces strict-grammar failures the loose
  warren-config check waved through (warren-99c3). `POST /projects/:id/triggers/:triggerId/run`
  resolves the trigger from warren-config, dispatches inline via
  `spawnRun` with `trigger='manual-trigger'`, bridges the run, and
  records the fire so the next cron tick's prev-vs-last semantic
  stays correct. Handlers 404 on unknown project/trigger ids.
- **`feat(ui)`** — Project Detail page (`src/ui/src/pages/ProjectDetail.tsx`)
  grows a triggers block driven by `GET /projects/:id/triggers` on
  its own react-query key. Each row shows last/next-fire timestamps,
  the most recent dispatched `lastRunId`, and any per-trigger
  `parseError`; a Run Now button per row invalidates the triggers
  query on success and navigates to the new run page (warren-7bbc).
- **`feat(ui)`** — `NewRunPage` auto-fills the agent select from the
  selected project's `.warren/defaults.defaultRole` when it matches a
  registered agent, and pre-fills the prompt textarea from
  `defaults.defaultPrompt`. Both fills latch off the first time the
  user touches the control so manual edits survive subsequent project
  switches; an inline hint surfaces the source of each default while
  the value still equals it, and a destructive-color warning flags a
  `defaultRole` that doesn't resolve to a registered agent
  (warren-fd14, warren-af38). Broader `defaultRole` consumption (CLI
  `warren run`, scheduled-run prompt fallback) remains deferred to
  R-04.
- **`deps`** — `croner ^10.0.1` for the R-06 cron scheduler
  (warren-a006). Picked over a homegrown 5-token parser: small,
  tz-aware with DST handling, no native deps, supports both Vixie and
  6-token grammars. Warren-config keeps its loose validation
  (`mx-40fe51`) and defers strict parsing to fire time.
- **`config`** — warren now dogfoods its own `.warren/`:
  `defaults.json` sets `defaultRole=claude-code` + `defaultBranch=main`;
  `triggers.yaml` is a comment-only stub. warren-bd22 tracks adding a
  CLI/UI affordance so users don't have to hand-author these files.
- **`test(acceptance)`** — scenario 15
  (`scripts/acceptance/scenarios/15-triggers-roundtrip.ts`) drives the
  R-06 scheduler end-to-end against a live in-proc warren+burrow: Run
  Now persists `lastFiredAt` / `lastRunId`; `scheduledFor` in the
  past dispatches exactly one `trigger='scheduled'` run and the
  seed's `scheduledFor` is cleared via `sd update --extensions`;
  future-dated and closed seeds skip; no spontaneous cron fires
  occur. `WARREN_SCHEDULER_TICK_MS=1000` keeps the dispatch budget
  tight (`pl-2f15` risk #8).

### Docs

- **`docs(roadmap)`** — `ROADMAP.md` flips R-06 from `[proposed]` to
  `[shipped]`, resolves the four open questions (croner over
  homegrown, default-UTC tz, skip-and-log on missing seeds, no
  catch-up after downtime), adds R-06 to "Recently shipped", and
  updates suggested sequencing.
- **`docs(spec)`** — new `SPEC.md` §11.I pins the scheduler
  convention into V1's frozen record: tick cadence, triggers table
  shape (migration 0005), failure semantics, the seeds write-once
  contract. §1 / §2 / §3 framing updates so V1 includes the cron
  half of the scheduler (webhooks still V2); §7 project structure
  adds `src/triggers/`; §8.1 HTTP routes adds the two new endpoints;
  §9 schema reflects the `triggers` table; §11.H deferred-scope note
  updates accordingly.

## [0.1.5] — 2026-05-10

R-02 lands: `.warren/` per-project config directory ships end-to-end —
loader, cache, HTTP read endpoint, UI panel, and `warren doctor` /
`/readyz` diagnostics. Triggers are parsed but not dispatched; R-06
(cron scheduler) is the consumer and is now fully unblocked. New
acceptance scenario 14 covers absent / valid / malformed lifecycle.

### Added

- **`feat(warren-config)`** — `.warren/` per-project config directory
  ships end-to-end (R-02, plan `pl-5d74`, warren-571f). Two optional
  files per project: `triggers.yaml` (zod-validated cron entries with a
  `kind:` discriminator that leaves room for future webhook triggers
  without a breaking schema rev) and `defaults.json` (per-project
  `defaultRole` / `defaultBranch` / `defaultPrompt`). Format choice
  diverges from the original ROADMAP sketch: `defaults` is JSON, not
  YAML, for symmetry with the rest of os-eco's wire surface (`mx-2cefdd`).
  YAML parser is `js-yaml ^4.1.1` to match mulch + overstory
  (`mx-8b6896`). New `src/warren-config/` module mirrors the
  `src/projects/` + `src/registry/` layout (errors / config / schema /
  load / cache / index). Loader uses a missing-vs-malformed envelope so
  per-file errors never throw (`mx-66d478`). Per-project cache is
  invalidated inside `refreshProject` and `deleteProject` to dodge the
  stale-config race (pl-5d74 risk #4, `mx-61c0e6`). Triggers are parsed
  but not dispatched — R-06 (cron scheduler) is the consumer and is now
  fully unblocked.
- **`feat(server)`** — `GET /projects/:id/warren-config` returns the
  `LoadedWarrenConfig` envelope verbatim (`{ triggers, defaults, errors }`);
  404 on unknown project. `WarrenConfigUnavailableError` joins the
  existing `BurrowUnreachableError` / `CanopyUnavailableError` /
  `ProjectUnavailableError` family for uniform error handling
  (`mx-adf588`, `mx-bd1f9f`).
- **`feat(ui)`** — Project detail page (`src/ui/src/pages/ProjectDetail.tsx`,
  `mx-dc191e`) renders a read-only Warren Config panel with three blocks
  per envelope: triggers list, defaults key/value, per-file validation
  errors (`mx-a5e30e`). Editing remains a git operation; warren only
  surfaces the parsed view.
- **`feat(diagnostics)`** — `warren doctor` and `/readyz` add a
  `warren_config` check that walks every loaded project and aggregates
  per-file errors into a single diagnostic row (`mx-f37c30`). Doctor's
  check ordering is now eight entries (`mx-1a70ef`); the eighth slot is
  `warren_config`.
- **`test(acceptance)`** — scenario 14
  (`scripts/acceptance/scenarios/14-warren-config-lifecycle.ts`) covers
  `.warren/` lifecycle: absent / valid / malformed states asserted via
  `/readyz` rather than spawning `warren doctor` as a child (avoids the
  wrong-DB problem documented in `mx-e959c0`). Scenarios 11 and 14 also
  pin `WARREN_DB_PATH` to a scratch path so the doctor exit-code check
  doesn't observe the shared dev DB (`mx-544f8f`, `mx-895738`).

### Docs

- **`docs(roadmap)`** — `ROADMAP.md` flips R-02 from `[proposed]` to
  `[shipped]` and inlines the as-built schema, surface, and the scope
  deliberately deferred to R-04 / R-06. R-06's "Depends on" updates to
  show R-02 as satisfied. Suggested-sequencing R-02 entry marked
  shipped. New entry under "Recently shipped".
- **`docs(spec)`** — `SPEC.md` adds §11.H pinning the `.warren/`
  convention into V1's frozen record (layout, format choice, schema,
  loader contract, HTTP/UI/diagnostics surface, deferred scope). §7
  project structure adds `src/warren-config/`; §8.1 HTTP routes adds
  `GET /projects/:id/warren-config`.

## [0.1.4] — 2026-05-10

Acceptance harness fill-in plus a deploy-time guardrail. Six new
end-to-end scenarios (05–10) close the warren↔burrow contract gaps
left by 0.1.3 — events stream, restart-recovery, steer, cancel, and
both reap roundtrips (mulch LWW + seeds-close mirror) — and the
supervisor now fails fast on the misconfigured-token mode that
silently 401'd every dispatch on Fly. Roadmap V2 direction (R-01
through R-11) lands as a planning artifact.

### Added

- **`feat(supervisor)`** — fail fast on missing or mismatched burrow
  auth tokens at boot, before `installGitCredentials` and
  `runSupervisor`. A misconfigured Fly deploy now exits with one
  pointed error instead of crash-looping `burrow serve` five times
  and 401-ing every dispatch. `WARREN_BURROW_NO_AUTH=1` bypasses for
  loopback dev. On success, the validated token's `sha256:<12-hex>`
  fingerprint is logged so a deployer can eyeball that both ends match
  without ever logging the secret. SPEC §10.2 fly secrets block now
  lists `BURROW_API_TOKEN` + `WARREN_BURROW_TOKEN` alongside
  `WARREN_API_TOKEN` (warren-d317).
- **`test(acceptance)`** — scenarios 05+06 cover the events stream
  contract end-to-end. 05 verifies the NDJSON envelope shape on
  `GET /runs/:id/events`, durability via the non-follow replay path,
  and the `?since=` filter. 06 kills warren mid-run, restarts it, and
  asserts the bridge resumes from `MAX(seq)+1` with no event-table
  gaps — the §9 contract. Adds `ScenarioCtx.lifecycle` so process
  control doesn't have to thread through fixtures, plus a per-second
  heartbeat in `stub-agent.sh` so the recovery path has a steady
  source of new burrow events to courier during the warren-down
  window. New `lib/burrow-serve.ts` shim programmatically registers
  declarative `[[agents]]` (which burrow's runtime registry doesn't
  auto-load from a project's `burrow.toml`) and bypasses bwrap with a
  direct `Bun.spawn` so the harness runs cleanly inside warren's own
  production sandbox where userns nesting fails (warren-647e).
- **`test(acceptance)`** — scenarios 07+08 cover steer + cancel. Steer
  asserts the `steer.sent` audit event and the burrow message echo
  prove delivery to the inbox; cancel asserts both warren and burrow
  surfaces report `cancelled`, idempotent on re-cancel (warren-a7f9).
- **`test(acceptance)`** — scenarios 09+10 cover the reap roundtrip.
  Scenario 09 exercises all three SPEC §11.A LWW branches across three
  sequential runs sharing a stable `mulch_id`: added → updated (newer
  ts) → skipped (older ts). Scenario 10 covers the seeds-close mirror
  happy path (`mode='added'`); the `mode='updated'` branch can't be
  observed end-to-end because `spawnRun`'s pre-spawn
  `refreshProjectClone` wipes reap's uncommitted writes to the tracked
  `.seeds/issues.jsonl` between runs (mulch's `acceptance.jsonl`
  survives because it's not committed in the fixture);
  `mirrorClosedSeeds`' updated branch is exercised by `reap.test.ts`.
  The stub agent gains four prompt-driven knobs alongside
  `[sleep_ms=NNN]`: `[mulch_id=...]`, `[mulch_ts=...]`, `[seed_id=...]`,
  `[seed_ts=...]` — letting scenarios drive deterministic LWW inputs
  without warren restarts (warren-c37e).

### Fixed

- **`test(acceptance)`** — scenario 02 now filters built-ins out of
  the "agents list is empty before first refresh" precondition. The
  server now boot-seeds claude-code + sapling built-ins (mx-f52e13),
  so the original assertion was always wrong. Filters to
  `source !== 'builtin'` before counting; `AgentRow` gains the
  optional `source` field already returned by `GET /agents`
  (warren-3682).

### Changed

- **TypeScript `5.9.3 → 6.0.3`** — dev dependency bump (dependabot).

### Docs

- **`docs(roadmap)`** — `ROADMAP.md` adds the V2 direction (R-01
  through R-11): the team-of-ICs phase. Captures seeds extensions,
  `.warren/` config dir, per-project canopy tier, project + issues UI
  (multica pattern), roles tab editor, cron scheduler, sapling-first
  runtime, operator agent, schema-driven config UI, and canopy+mulch
  role meshing. Records the decisions already made (DB only for
  runtime state; seeds is source of truth for issues; markdown editor
  with full canopy feature set; sapling personal default, claude-code
  public default). Cross-repo follow-ups tracked as seeds in
  seeds/sapling/canopy/mulch.
- **`docs(fly)`** — `fly.toml` operator-workflow comment now spells
  out the `BURROW_API_TOKEN` ↔ `WARREN_BURROW_TOKEN` pairing
  requirement. Deploying without setting both to the same value
  crashed the supervisor in a boot loop, then silently 401'd every
  dispatch once the server-side secret was set alone. App name
  corrected to `warren-deployed` to match the created Fly app
  (warren-d317).

## [0.1.3] — 2026-05-09

Third-dogfood follow-through. Closes the warren-on-warren findings from
SPEC §11.G: agents now actually `git commit` (system prompt reaches the
runtime, gitdir bind via burrow 0.2.7), reap distinguishes empty pushes
from real work, successful pushes auto-open a GitHub PR, the dispatch
form lets operators target a non-default branch, and `CANOPY_REPO_URL`
is now optional thanks to inline built-in agents.

### Added

- **`feat(runs)`** — auto-open a GitHub PR after reap pushes the agent's
  branch. Gated by `WARREN_AUTO_OPEN_PR` (default on); skipped when the
  run isn't successful, the push lands no commits, the branch matches
  `project.defaultBranch`, or `GITHUB_TOKEN` is unset. 422 "already
  exists" is treated as success and the existing PR url is recovered.
  Optional `WARREN_BASE_URL` embeds a back-link to the run in the PR
  body (warren-f6af).
- **`feat(runs)`** — reap distinguishes a real-work push from a no-op
  push against an unchanged HEAD. After a successful push reap runs
  `git rev-list --count <project.defaultBranch>..HEAD` and pins the
  count on `ReapRunResult.commitsAhead`. When the count is 0, an extra
  `reap.empty_push` system event fires and `reap.completed` carries
  `commitsAhead: 0`. RunDetail's header shows a destructive
  "empty push" badge or a green "+N commits" badge accordingly. SPEC
  §4.3 step 6 documents the commit/push contract (warren-f3bb).
- **`feat(runs)`** — dispatch composes `agent.system + delimiter + user
  prompt` before posting to `POST /burrows/:id/runs`. Burrow's
  claude-code runtime never reads `.canopy/agent.json`, so the canopy
  `system` body (workspace map, rituals, commit-only invariant per
  warren-1a09) was dead text on disk; it now actually reaches the model.
  `runs.prompt` keeps the user-typed input verbatim — only the body sent
  to burrow is composed.
- **`feat(ui)`** — NewRun page exposes a free-text "Branch / tag / SHA
  (optional)" field between project select and prompt textarea.
  Placeholder mirrors the project's `defaultBranch`; empty submissions
  are omitted from the `POST /runs` body so the server falls back to
  `defaultBranch` as before (warren-7589).
- **`feat(registry)`** — `CANOPY_REPO_URL` is now optional. Warren ships
  default `claude-code` and `sapling` agents inline (`src/registry/builtins/`)
  so a fresh deploy boots without a custom canopy library. When
  `CANOPY_REPO_URL` *is* set, library agents override built-ins by name
  and new names extend the catalog. `warren doctor` and `/readyz` no
  longer fail when the canopy clone is absent (warren-d3e9).
- **`test(acceptance)`** — scenario 04 drives the §4.3 composition flow
  end-to-end against the in-proc warren+burrow harness. Asserts
  `POST /runs` returns 201 with a `run_xxx` id and a populated
  `renderedAgentJson`, and that the column is frozen at spawn time —
  mutating the canopy fixture and re-running `POST /agents/refresh`
  leaves the existing run unchanged while a fresh spawn picks up the
  drift. `canopyRepoPath` is surfaced on `ScenarioCtx.fixtures` so
  future scenarios can drive canopy-source mutations the same way
  (warren-9f65).

### Changed

- **Burrow CLI bumped `0.2.6 → 0.2.7`** — pulls in the burrow-7a80
  gitdir-bind fix. Host worktree gitdir is now visible inside the bwrap
  sandbox, so agents can run `git commit` on their own workspaces. Two-
  place pin (Dockerfile + `package.json` + `bun.lock`) per CLAUDE.md.
- **TypeScript `5.9.3 → 6.0.3`** — dev dependency bump (dependabot).

### Docs

- **`docs(spec)`** — SPEC §11.G records the 2026-05-09 third dogfood.
  Two warren-on-warren runs against `jayminwest/warren`: the first
  reproduced the silent-empty-branch shape (`branchPushed: true`,
  `ahead_by: 0`) — the trigger for warren-f3bb (reap-pushes-without-
  committing observability gap) and warren-fead (`end_turn` while
  waiting on foreground work). The second was the first warren-on-
  warren run that actually shipped real work to the remote, validating
  burrow-7a80 / 0.2.7 gitdir bind end-to-end and confirming
  warren-f3bb's prompt-instruction-is-sufficient fix scope. Filed
  warren-1a09 (P2: agent-side `git push` blocked by `/root/.gitconfig`
  not being in burrow's bwrap ro-bind set; same architectural pattern
  as warren-1eaa).

## [0.1.2] — 2026-05-09

Second-dogfood hardening pass. Fixes the "stuck running, no branch" failure
mode (warren-a69a + warren-67cc compound) by reaping inline on terminal
bridge events, repairs container recreate past migration 0002 (warren-b060),
makes the bundled os-eco CLIs resolvable inside the bwrap sandbox
(warren-1eaa), and survives `DELETE /projects/:id` against a project with
run history (warren-5f19). Burrow bumped to 0.2.6 for built-in
`ANTHROPIC_API_KEY` plumbing.

### Fixed

- **`fix(runs)`** — reap runs inline when the burrow bridge sees a runtime
  terminal event (`kind=state_change`, `stream=system`,
  `payload.type=result`) or when burrow's cancel response carries a terminal
  state. Without an external scheduler, runs were stuck in `running` after
  the agent exited or the operator cancelled; reap is still the sole writer
  to the terminal state transition (warren-a69a).
- **`fix(runs)`** — adds `no_model_response` to `failure_reason`, so the
  reap classifier discriminates "ran but the model never produced an
  assistant turn" (e.g. claude-code's "Not logged in / Please run /login"
  exit) from a generic crash. Heuristic: outcome=failed, stateOnEntry=running,
  no `text`/`thinking`/`tool_use` event ever landed on `stream=stdout`
  (warren-5165).
- **`fix(db)`** — hoists `PRAGMA foreign_keys=OFF` onto the raw connection
  *before* drizzle's migrate transaction opens. SQLite silently ignores
  PRAGMA foreign_keys toggled inside a multi-statement transaction, so
  migration 0003's "12-step ALTER" was running with FK still ON and
  crashing the supervisor on every container recreate past 0002 against any
  `/data/warren.db` with `events` rows referencing `runs` (warren-b060).
- **`fix(docker)`** — relocates the global Bun package store from `/root/.bun`
  to `/usr/local`. Burrow's bwrap profile ro-binds `/usr` but not `/root`,
  so symlinks in `/usr/local/bin` for `sd`/`ml`/`cn`/`sapling`/`burrow` were
  dangling inside the agent's UID-1000 namespace. Sandboxed agents can now
  resolve every bundled os-eco CLI (warren-1eaa).
- **`fix(projects)`** — `runs.project_id` switched to `ON DELETE SET NULL`
  and `deleteProject` now reorders so a delete of a project with run history
  succeeds instead of state-corrupting on the FK error after `rmrf` already
  wiped the disk. Reap guards a null `projectId` by skipping
  `mulch_merge`/`seeds_close`/`branch_push`; UI renders orphans as
  "(deleted project)" on the runs list and detail (warren-5f19).
- **`fix(ui)`** — `RunDetail` invalidates the `['runs']` query when the live
  event stream emits `state_change`, `cancel.requested`, `reap.completed`,
  or `reap_failed`. The state badge and metadata refresh immediately instead
  of waiting on the 3–5s polling backstop. The cancel button now surfaces
  burrow's post-cancel state inline (alreadyTerminal vs. forwarded + state)
  matching SteerForm's no-toast pattern (warren-d9ad).

### Changed

- **Burrow CLI bumped `0.2.4 → 0.2.6`** — built-in claude-code runtime
  now default-allows `ANTHROPIC_API_KEY` (plus `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`) without requiring a
  project `burrow.toml` `[env]` block. Pinned in **both** `Dockerfile` and
  `package.json` + `bun.lock`.
- **`.env.example`** — replaces the misleading `env_passthrough` claim
  (warren never wired project-level passthrough; deferred to warren-766b)
  with a description of burrow's built-in claude-code env contract
  (warren-5165).

### Docs

- **`docs(claude)`** — `CLAUDE.md` now covers tech stack, build/test
  commands, quality gates, version management, and an explicit "Relationship
  to burrow" section (supervisor contract, two-place `@os-eco/burrow-cli`
  pin, bwrap security flags).
- **`docs(spec)`** — SPEC §11.F records the second-dogfood findings
  (warren-67cc + warren-a69a as the "stuck running, no branch" compound).

### Build

- **`ci(release)`** — configures `git config user.name/email` before
  `git tag -a` in the release workflow. Without an identity the runner
  failed with "empty ident name not allowed" and `v0.1.1` never tagged.

## [0.1.1] — 2026-05-09

Post-V1 hardening pass. Closes every "Known limitations" seed filed against
0.1.0 — `GITHUB_TOKEN` git auth, `--no-auth` burrow knob, warren-on-PATH,
queued-vs-crashed reap classification, and `curl` in the runtime image — plus
projects can now refresh on every run, run streams survive Bun's 10s idle
timeout, and the UI no longer overflows on wide tables.

### Added

- **`feat(projects)`** — every run now `git fetch`-refreshes the project clone
  before composing the burrow; the new `POST /projects/:id/refresh` endpoint
  exposes the same flow for manual use. Persistent clones in
  `/data/projects/<owner>/<name>` no longer drift from upstream.
- **`feat(supervisor)`** — `BURROW_NO_AUTH` and `BURROW_EXTRA_ARGS` env knobs
  splice into the supervisor's `burrow serve` invocation, supporting loopback
  dev without bearer auth (warren-93ee).
- **`feat(runs)`** — failed runs now carry a `failure_reason` column
  (`crashed | never_started | cancelled | timeout | reap_failed`), so reap can
  distinguish "queued, never started" from "crashed mid-run" (warren-3c40).
- **`feat(docker)`** — `curl` is installed in the runtime image so operators
  can probe the burrow unix socket from inside the container (warren-bd69).
- **`test(acceptance)`** — scenario 03 covers projects management end-to-end
  (clone, presence checks, refresh, reap merge).

### Fixed

- **`fix(ui)`** — `min-w-0` on the main pane prevents wide tables (events,
  reap output) from pushing the viewport horizontally on the runs page
  (warren-930c).
- **`fix(docker)`** — the `warren` CLI is now symlinked onto `PATH` inside
  the container; previously `docker exec ... warren doctor` failed (warren-fab1).
- **`fix(supervisor)`** — `GITHUB_TOKEN` is wired into `git config --global
  url.<token>@github.com.insteadOf` at supervisor boot, so private project
  clones work without per-run setup (warren-dcf3).
- **`fix(runs)`** — runs transition `queued → running` on the first burrow
  bridge event (previously stuck in `queued` until completion) (warren-865e).
- **`fix(server)`** — run-event SSE streams are kept alive past Bun's 10s
  idleTimeout via periodic comments; long-running agents no longer drop the
  client connection mid-run (warren-b8fc).

### Build

- Added `.github/workflows/release.yml` — pushes to `main` that bump
  `package.json#version` (kept in sync with `src/index.ts`'s `VERSION`)
  automatically tag `v$VERSION` and create a GitHub release with notes
  extracted from `CHANGELOG.md`. The workflow is idempotent: re-runs against
  an already-tagged version are a no-op.

## [0.1.0] — 2026-05-09

Inaugural release. The V1 manual-run path is end-to-end validated against a real
claude-code agent (SPEC §11.E): `warren run claude-code <project> -p "..."`
provisions a burrow, dispatches the run, streams events back, reaps mulch
deltas, and pushes the workspace branch.

### Added

- **Composition flow** (SPEC §4.3): canopy agent resolution → burrow provision
  → seed `.canopy`/`.mulch`/`.seeds` → dispatch → NDJSON event stream → reap.
  Rendered agent JSON is frozen on the run row at spawn time so mid-run canopy
  edits do not affect in-flight runs.
- **Phase 0** — Bun + TS strict scaffolding (biome, drizzle, src tree).
- **Phase 1** — data model + `bun:sqlite` repos for `agents`, `projects`,
  `runs`, `events`.
- **Phase 2** — `burrow-client/` facade over `@os-eco/burrow` `HttpClient`
  (typed mirror of burrow's HTTP surface over the supervisor-managed unix
  socket).
- **Phase 3** — canopy agent registry: `cn render` → `AgentDef`, schema
  validation, refresh on demand.
- **Phase 4** — project management: clone GitHub URLs into
  `/data/projects/<owner>/<name>`, presence checks for `.seeds`/`.mulch`.
- **Phase 5** — run spawn / composition flow.
- **Phase 6** — event streaming + warren event log (write-through cache of
  burrow's stream; supports reload-after-crash and post-hoc replay).
- **Phase 7** — reap: per-run `.mulch/` merged into the project's persistent
  expertise log with last-write-wins-by-`ts` (SPEC §11.A); seeds the agent
  closed are propagated; workspace branch is pushed.
- **Phase 8** — `POST /runs/:id/steer` and `POST /runs/:id/cancel`, proxying
  to burrow's inbox + cancel routes.
- **Phase 9** — Bun.serve HTTP API + bearer-token auth on every route except
  `/healthz`. CORS strict; SPA shell + assets are auth-exempt so the UI loads
  before the user has configured the token.
- **Phase 10** — React + Vite + shadcn/ui SPA served by the same Bun.serve
  process from `src/ui/dist/`.
- **Phase 11** — `warren` admin CLI: `register-agent`, `add-project`, `run`,
  `doctor`, `serve` (the docker entrypoint).
- **Phase 12** — container + supervisor: `src/supervisor/main.ts` spawns
  `burrow serve` + warren as siblings, forwards SIGTERM/SIGINT, restarts
  burrow on crash with a 5-in-60s budget. Two-stage Dockerfile (UI build +
  runtime).
- **Phase 13** — `warren doctor` (burrow reachable, canopy clean, bwrap
  working) and `/readyz` (canopy clone present, burrow socket reachable, at
  least one agent rendered).
- **Phase 14** — acceptance harness skeleton (`scripts/acceptance/`) for
  scenario-based end-to-end validation.
- **Deploy** — `docker-compose.yml` with the four bwrap-friendly security
  flags (apparmor/seccomp/systempaths unconfined + `cap_add: SYS_ADMIN`,
  SPEC §5.3) and a single named volume at `/data`. `fly.toml` for Fly.io
  with the same image and security posture.
- **Bundled runtime** — the image installs `@os-eco/burrow-cli`,
  `@os-eco/canopy-cli`, `@os-eco/seeds-cli`, `@os-eco/mulch-cli`,
  `@os-eco/sapling-cli`, and `@anthropic-ai/claude-code` at fixed pins, with
  an explicit postinstall invocation for claude-code so the platform-native
  binary is wired up.

### Fixed

- `fix(spawn)` — forward `agent.name` as an `[[agents]]` patch row to
  `burrow up`, so burrow can resolve toolchain paths via
  `resolveEffectiveAgents` (paired with burrow `0.2.2`).
- `fix(server)` — SPA shell + asset routes are bearer-auth-exempt; previously
  the UI could not bootstrap on a fresh deploy.
- `fix(deploy)` — unblock first-run image build + boot.

### Build

- Pinned `@os-eco/burrow-cli` to `0.2.3` for bwrap `--uid`/`--gid` mapping
  (claude-code refuses to run as host root with
  `--dangerously-skip-permissions`). Bumped in **both** `Dockerfile` and
  `package.json` + `bun.lock` — the supervisor's `Bun.spawn` resolves
  `./node_modules/.bin/burrow` before PATH, so a Dockerfile-only bump is a
  no-op.
- Bundled `claude-code` runtime into the image with explicit postinstall so
  `bun install -g`'s skipped lifecycle scripts don't leave `/usr/local/bin/claude`
  unwired.
- Dropped the npm publish workflow — warren ships as a container image, not
  an npm package.

### Known limitations (V1)

See SPEC §11.D for the security posture (single bearer token, no rotation,
trust-the-socket between warren and burrow). Outstanding gaps tracked as
warren seeds: supervisor doesn't auto-wire `GITHUB_TOKEN` into git's
credential helper (`warren-dcf3`), no `--no-auth` knob for burrow loopback
dev (`warren-93ee`), `warren` CLI not on `PATH` inside the container
(`warren-fab1`), reap can't distinguish "queued, never started" from
"crashed" (`warren-3c40`), runtime image lacks `curl` (`warren-bd69`).
Scheduler (cron + webhooks) and library API exports are deferred to V2.
