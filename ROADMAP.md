# Warren Roadmap

Direction for warren as it grows from "single-user end-to-end works on Fly" to a
self-hosted control plane usable by a team of ICs. Each item is a self-contained
idea with a stable ID for reference. Items can be sequenced independently; the
dependency graph is captured per-item.

This file is the punch list, not the spec. Items here become seeds issues when
committed to. [SPEC.md](SPEC.md) is the frozen V1 design record; ROADMAP.md is
the forward-looking direction.

## Status legend

- `[proposed]` — under discussion, not committed
- `[in-progress]` — actively being built
- `[partially shipped]` — some sub-items released, others still open
- `[shipped]` — released
- `[deferred]` — useful but not now

## Item template

New items follow this shape so the format doesn't drift:

    ## R-NN — Title
    Status: [proposed]
    Depends on: —
    Unlocks: —

    **Problem.** One paragraph: what breaks today, especially as warren leaves
    single-user manual-dispatch use.

    **Sketch.** Short description or config/code example of the proposed shape.
    Not a spec.

    **Open questions.** Bullets — things to decide before or during implementation.

---

## R-01 — Seeds `extensions` field for runtime metadata
Status: [partially shipped] — seeds side landed v0.4.3 (2026-05-10); warren consumer not yet wired up
Depends on: — (cross-repo: lands first in `seeds`, then warren consumes)
Unlocks: R-04 (issues UI needs role/schedule/trigger metadata on each seed); R-06
(cron scheduler reads `extensions.scheduledFor` / `extensions.trigger`)

**Cross-repo status (2026-05-10).** Shipped in seeds v0.4.3:
- `extensions?: Record<string, unknown>` on `Issue` (seeds `src/types.ts:17`)
- `sd update --extensions <json>` with shallow-merge semantics; `--clear-extensions`
  for removal (`src/commands/update.ts:211-212`)
- `sd show` renders an "Extensions:" line (`src/output.ts:74-83`)
- `sd ready --respect-schedule` filters `extensions.queued === true` and future
  `extensions.scheduledFor` from the queue (`src/commands/ready.ts:111-114`)

What did **not** ship: a dedicated `sd extensions <set|show|remove>` subcommand.
The team chose `sd update --extensions` (merge) + `--clear-extensions` as the only
write path. Warren's consumer-side work (R-04, R-06) calls these directly.

**Problem.** Warren needs to attach runtime metadata to seeds — assigned agent
role, scheduled-for timestamp, trigger source, last-run pointer — without
forking the seeds schema or maintaining a separate warren issue table. Seeds
today has fixed fields (status, type, priority, labels, plan_id, etc.) and no
structured extension point. Labels (`role:refactor-bot`, `trigger:cron`) work
as a hack but lose their structure on read and don't round-trip cleanly.

The persistence rule for warren V2 is: **DB only holds runtime state (runs,
events, schedule fire-history). Definitions, expertise, issues all live as
git-tracked files in the project repo.** That rule needs a clean place to put
warren-specific issue metadata that travels with the seed.

**Sketch.** One-line schema addition in `seeds/src/types.ts`:

    export interface Issue {
      // ... existing fields ...
      extensions?: Record<string, unknown>;
    }

Validation: none — warren owns the shape of its own keys. Storage: round-trips
through `.seeds/issues.jsonl` like any other field. Display: `sd show` adds an
"Extensions:" line summarizing the keys present.

CLI surface: extend `sd update` with `--extensions <json>` (merge semantics, not
replace). Optionally a `sd extensions <set|show|remove>` subcommand for
per-key writes that don't require composing JSON on the command line.

Warren's namespaced keys, agreed by convention:

    extensions: {
      role: "refactor-bot",                      // canopy role name
      scheduledFor: "2026-05-12T03:00:00Z",      // ISO8601, when to dispatch
      trigger: "cron",                            // manual | cron | webhook | comment
      queued: true,                               // "created but don't run yet"
      lastRunId: "wr-...",                        // most recent warren run
      lastRunAt: "2026-05-10T03:00:00Z"
    }

Other tools (greenhouse, overstory) are free to use their own keys without
collision.

**Open questions.**
- Whether to add a runtime validator (JSON Schema per consumer's namespace) or
  leave it to the consuming tool. Lean leave-it-to-the-consumer for now;
  warren validates its own keys with zod inside warren.
- Whether `sd ready` should know about `extensions.queued` / `scheduledFor`
  and exclude those from the ready queue. Probably yes — but as an opt-in
  filter, not a default change to seeds' core semantics.
- Whether warren talks to seeds via `Bun.spawn` (today) or via a published
  `@os-eco/seeds` library. Spawn is fine for V2; library lift is a separate
  item if call volume becomes a problem.

---

## R-02 — `.warren/` directory convention
Status: [shipped] — landed via plan `pl-5d74` (warren-571f), 2026-05-10.
Convention, schema, loader, HTTP/UI surface, and `warren doctor` check all
ship in V1; R-06 (cron scheduler) consumes the parsed `triggers.yaml` next.
Depends on: —
Unlocks: R-06 (cron schedules need a git-tracked home); future webhook trigger
mappings; per-project default-role overrides

**Problem.** Some warren config is genuinely warren-specific — cron schedules,
trigger definitions, project-level defaults. Squeezing it into `.canopy/` (a
prompt store) or seed `extensions` (per-issue metadata) is the wrong shape.
But it's still git-tracked config that benefits from PR review, version
history, and travels with the project.

**Shipped shape.** Each project repo can grow a `.warren/` directory with two
files. Both are optional — missing files are not errors, and the loader
returns a `null` entry per missing file so existing projects keep working
unchanged. Format choice diverged from the original sketch:

    .warren/
      triggers.yaml      # cron triggers (and future webhook entries)
      defaults.json      # per-project defaults — JSON, not YAML

The YAML→JSON switch on `defaults` (sketch was `defaults.yaml`) was a
deliberate format-symmetry decision: `defaults` is small, structurally
flat, and matches the rest of os-eco's JSON wire surface; YAML's only
advantage is multi-line strings, which `defaultPrompt` doesn't need today.
Recorded as `mx-2cefdd` (mulch). Triggers stay YAML — cron expressions read
better there and arrays-of-objects are noisier in TOML/JSON. YAML parser
is `js-yaml ^4.1.1` to match mulch and overstory (`mx-8b6896`).

`triggers.yaml` schema (zod-validated, `kind` discriminator leaves room for
future webhook entries without a breaking schema rev):

    - id: nightly-refactor
      kind: cron
      cron: "0 3 * * *"
      timezone: UTC               # optional
      seed: seeds-abc1
      role: refactor-bot
      prompt: |                   # optional override of defaultPrompt
        Run nightly cleanup pass.

`defaults.json` schema:

    {
      "defaultRole": "claude-code",
      "defaultBranch": "main",
      "defaultPrompt": "Read the issue, plan, execute, file follow-ups."
    }

Surface that landed alongside the schema:

- `src/warren-config/` module mirrors `src/projects/` + `src/registry/`
  layout (errors / config / schema / load / index, plus a per-project
  cache). Loader is `loadWarrenConfig({ projectPath })` and uses a
  missing-vs-malformed envelope (`mx-66d478`) — never throws on per-file
  errors.
- `GET /projects/:id/warren-config` returns the `LoadedWarrenConfig`
  envelope (`{ triggers, defaults, errors }`); `WarrenConfigUnavailableError`
  joins the existing burrow/canopy/project unavailable family
  (`mx-bd1f9f`).
- Project detail page renders a read-only Warren Config panel showing
  triggers, defaults, and per-file validation errors (`mx-a5e30e`).
- `warren doctor` and `/readyz` emit a `warren_config` check that walks
  every loaded project and flags malformed entries (`mx-f37c30`,
  `mx-1a70ef` — eight checks now).
- Acceptance scenario 14 (`scripts/acceptance/scenarios/14-warren-config.ts`)
  covers absent / valid / malformed across `/readyz` (`mx-e959c0`).

Runtime state (last-fired-at, next-fire-at) stays in warren's SQLite.

Inspired by `.github/workflows/`: declarative config in git, runtime in the
control plane.

**Scope deliberately deferred** to keep this seed bounded:

- `defaults.defaultRole` is wired into the NewRun agent picker
  (warren-fd14): when a selected project's `.warren/defaults.json` declares
  a `defaultRole` that matches a registered agent, the picker auto-fills
  to that role until the user manually overrides. CLI `warren run`
  consumption is still deferred to R-04.
- `defaults.defaultPrompt` is wired into the NewRun prompt textarea
  (warren-af38): when a selected project's `.warren/defaults.json`
  declares a `defaultPrompt`, the textarea pre-fills with that string
  until the user types into it. Scheduled-run fallback (R-06: a
  `triggers.yaml` entry that omits its own `prompt:` falls back to
  `defaultPrompt`) and any template substitution remain deferred.
- `triggers` are parsed and exposed but not dispatched. R-06 reads them.
- Bootstrap UX: `warren add-project` does not auto-create an empty
  `.warren/`. Lazy is fine; no point in empty files.

---

## R-03 — Per-project `.canopy/` role tier
Status: [proposed]
Depends on: —
Unlocks: R-05 (roles tab can read/write project-local roles); user-creatable
roles without forking a shared canopy repo

**Problem.** Warren's registry today resolves agent roles from two sources:
built-ins shipped in `src/registry/builtins/` (claude-code, sapling) and an
optional shared canopy repo via `CANOPY_REPO_URL`. There's no third tier for
roles that should travel with one specific project — e.g., a refactor-bot
tuned for this codebase's conventions. Forcing project-specific roles into a
shared canopy repo couples unrelated projects' role definitions.

**Sketch.** Extend `src/registry/canopy.ts` to scan `<projectPath>/.canopy/`
for agent prompts in addition to the shared repo. Resolution order when a name
collides:

    per-project (.canopy/ in the cloned repo)
      > library (CANOPY_REPO_URL)
      > built-in (src/registry/builtins/)

Per-project roles are scoped to the project that owns the file. Library and
built-in roles stay globally available. `POST /agents/refresh` re-renders all
three tiers and stamps the source onto each agents row (`source: builtin |
library | project:<projectId>`).

Spawn-time freezing (today's behavior) is unchanged: the rendered JSON is
copied into `runs.renderedAgentJson` and never re-rendered mid-run.

**Open questions.**
- Whether per-project roles can `extend:` library/built-in roles. Yes — that's
  the whole point. Canopy already supports inheritance; the resolver just
  needs to look up the parent across tiers.
- Whether a per-project role's render result should be cached on disk inside
  the project (`<projectPath>/.canopy/.rendered/`) so consumers without
  warren can still see it. Probably yes; matches `cn emit`'s contract.
- What happens when a per-project role and a library role share a name and
  the library role's parent changes. Per-project wins; resolver must not
  silently re-render across tier boundaries.

---

## R-04 — Project + Issues UI (the multica pattern)
Status: [proposed]
Depends on: R-01 (seeds `extensions` field — **seeds side shipped v0.4.3 2026-05-10**, warren-consumer side is the only remaining blocker)
Unlocks: team-of-ICs workflow — file work today, run tonight, batch-assign a
sprint; deferred dispatch; per-project organization in the UI

**Problem.** Today's UI is six flat pages: Agents, Projects, NewRun, Runs,
RunDetail, Login. Workflow is "pick agent + project + write prompt + click
run." That's fine for a single user spawning ad-hoc runs. It does not scale
to a team that wants to *file* work as issues, *assign* roles, *defer*
execution, and *track* what each issue's most recent run did. Multica has
production-quality UX for exactly this and warren can borrow it whole.

The persistence rule says: seeds is the source of truth for issues. Warren
does not maintain a separate issues table. The UI is a friendly editor over
`.seeds/issues.jsonl` plus a runtime control surface for runs that touch
those seeds.

**Sketch.** Replace the flat nav with a project-scoped tree:

    Projects
      ├── warren
      │     ├── Issues       ← .seeds/issues.jsonl
      │     ├── Roles        ← .canopy/ + library + built-ins
      │     ├── Triggers     ← .warren/triggers.yaml
      │     ├── Runs         ← warren DB, filtered by project
      │     └── Expertise    ← .mulch/expertise/
      └── burrow
            └── ...
    Library
      ├── Roles              ← shared canopy repo
      └── Runs               ← warren DB, all projects

**Issues tab.** Lists seeds from the project's `.seeds/issues.jsonl`. Columns:
title, status, priority, role (`extensions.role`), scheduled-for
(`extensions.scheduledFor`), last-run state. Filters by status, label, role,
trigger source. Click a row → issue detail.

**Issue detail.** All seed fields editable via the warren UI (round-trip
through `sd update`). Runtime panel shows the assigned role, schedule,
trigger, last-run link. Buttons: "Run now" / "Steer current run" / "Cancel
current run" / "Re-run". If a warren run is currently active for this seed,
the page live-tails events.

**Create-issue modal.** Multica's pattern, copied:

    [Title  ]
    [Description (rich text)]
    Type:        [task | bug | feature | epic]
    Priority:    [P0..P4]
    Labels:      [+ tag]
    Role:        [searchable picker, frequency-sorted]
    When:        ( ) Run now
                 ( ) Queue (don't run yet)
                 ( ) Schedule for [datetime]
    [Cancel]    [Create]

"Run now" → `sd create` + `POST /runs`. "Queue" → `sd create` with
`extensions.queued: true`, no run dispatched. "Schedule" → `sd create` with
`extensions.scheduledFor: <ISO8601>`, picked up by R-06.

**Role picker** mirrors multica's assignee picker: searchable list of roles
available to this project (per-project + library + built-in), most-recently-
used at top, source labels visible.

Backend: warren reads `.seeds/issues.jsonl` via `Bun.spawn('sd', ['list',
'--format', 'json'])` and watches the JSONL for changes (mtime polling on a
2s interval per open project page). All mutations go through the seeds CLI;
warren does not touch the JSONL directly.

**Open questions.**
- Real-time strategy. mtime polling is good enough for V2; a filesystem
  watcher (or seeds-side event emitter, if seeds ever adds one) is the V3
  story.
- Whether issue editing in the UI requires a git commit per change or
  batches into a single "save" commit. Probably batch; commit message
  generated from the diff.
- Multi-user race conditions on edit. Defer until R-05's auth story exists.
  Single-bearer = single-user-effectively today.
- Whether the UI also lets users edit `.mulch/` from the Expertise tab.
  Read-only for V2; mulch editing is its own item.

---

## R-05 — Roles tab (in-UI canopy editor)
Status: [proposed]
Depends on: R-03 (per-project `.canopy/` tier); canopy's inheritance/composition
end-to-end — **canopy v0.2.4 ships `extends`, mixins, and `cn render --json`
verified by smoke tests**, so the editor's preview-pane contract is ready
Unlocks: user-creatable roles without leaving the browser; role iteration
inside the warren feedback loop instead of an external repo round-trip

**Problem.** Today, creating a new role means: clone the canopy repo, write a
prompt file by hand, push, set `CANOPY_REPO_URL`, refresh the registry. Five
steps, three tools, and the user has to know canopy's prompt syntax. Warren
should make role creation a first-class in-UI operation while preserving
canopy's full feature set (inheritance, mixins, partials).

**Sketch.** Roles tab, per project:

- Lists all roles available to this project, grouped by source (project /
  library / built-in). Status badges for each.
- "New role" button: choose a starter template (refactor-bot, docs-bot,
  triage-bot, blank), then drop into the editor.
- "Fork to project" button on library/built-in roles: copies the rendered
  source into `.canopy/` so it can be edited locally.
- Role editor: a Monaco-style markdown editor for the canopy prompt, with a
  live `cn render --json` preview pane on the right.
- Save: write to `<projectPath>/.canopy/<name>.md`, run validation, refresh
  the registry, stage a git commit. Push is a separate explicit action.

**Editor decision (locked in design discussion):** raw markdown with full
canopy feature set. Users get inheritance, mixins, partials. Editing a base
prompt that other roles inherit from propagates through the whole tree on
next render. This is non-negotiable — wrapping canopy in a structured form
loses its composition story.

Concretely, this means:

- The editor is markdown-aware (frontmatter highlighting, fenced section
  validation) but does not abstract canopy syntax.
- The preview pane shows the *rendered* JSON envelope, with inheritance
  resolved, so users can verify a base-prompt edit propagated correctly.
- Validation surfaces canopy errors (unknown parent, invalid section) inline
  in the editor.

**Conflict story for V2.** Warren's role write path stages a commit but does
not auto-push. Users review via `git diff` and push themselves. Multi-user
editing is moot until R-09 (auth) lands; single-bearer = single-effective-
user.

**Open questions.**
- Where the "Fork to project" target writes for a built-in (which has no
  source markdown — it's a TS object today). Either render the built-in
  through canopy and emit markdown, or ship the built-ins *as* markdown
  files in a baked location. Lean ship-as-markdown so fork is a literal
  copy.
- Whether the editor is in the warren UI bundle or pulls Monaco from CDN.
  Bundle for offline support; warren is self-hosted.
- Diff view when editing an existing role — do we show the canonical canopy
  source diff, or the rendered-JSON diff? Lean source; rendered is the
  preview.

---

## R-06 — Cron scheduler
Status: [proposed] — fully unblocked as of 2026-05-10.
Depends on: R-02 (`.warren/triggers.yaml` is the trigger config home —
**shipped 2026-05-10 via pl-5d74**, parsed schema available via
`loadWarrenConfig` and `GET /projects/:id/warren-config`); R-01 (seeds
`extensions.scheduledFor` for one-off scheduled runs — **seeds side shipped
v0.4.3, including `sd ready --respect-schedule` to keep deferred seeds out of
the ready queue**). Both prerequisites satisfied.
Unlocks: scheduled agent runs without leaving warren; nightly refactor /
weekly docs-update / hourly triage-sweep workflows

**Problem.** Warren's only trigger today is "manual via UI or CLI." Teams need
recurring runs (nightly cleanup, weekly stale-issue triage) without standing
up an external cron + webhook pair. That's a thin layer on warren's existing
spawn path.

**Sketch.** New module `src/triggers/`. Two trigger sources:

1. **Recurring (cron):** entries in `<projectPath>/.warren/triggers.yaml`
   (R-02). Each entry references a seed (which carries the role, prompt, and
   any other metadata) and a cron expression.
2. **One-off (scheduled-for):** seeds with
   `extensions.scheduledFor: <ISO8601>` get dispatched at that time exactly
   once. After dispatch, the field is cleared (or moved to
   `extensions.lastScheduledRun`).

A scheduler tick runs every 60s in-process (no external cron daemon). For
each loaded project: walk `triggers.yaml`, compute next-fire-at against the
last-fired-at in warren's DB, dispatch matching entries. Then walk
`extensions.scheduledFor` across the project's seeds and dispatch any whose
time has passed.

Warren DB additions:

    triggers (
      id TEXT PRIMARY KEY,            -- composite: <project>:<trigger-id>
      project_id TEXT,
      last_fired_at TEXT,
      next_fire_at TEXT,
      last_run_id TEXT
    )

Dispatched runs carry `trigger: "cron"` or `trigger: "scheduled"` so the UI
can label them.

**UI:** Triggers tab on project detail. Lists `triggers.yaml` entries with
next-fire-at and last-fire-at. Editor that round-trips through YAML. "Run
now" button to dry-fire any trigger.

**Open questions.**
- Cron implementation: bring our own (small, no deps) vs. use a library
  (`node-cron` etc.). Lean small-implementation; the surface is tiny and
  warren already has `Bun.serve` as its only runtime dep.
- Timezone: per-trigger `timezone` field (R-02 already proposed it). Default
  UTC. Surface in UI clearly so users don't get confused by DST.
- Failure handling: if a trigger fires but the seed it references is closed,
  what happens? Skip + log. If the seed doesn't exist? Skip + warn in UI.
- Catch-up after warren downtime: if warren was down when a cron should have
  fired, do we fire on boot? Lean no — cron is "fire at time T," not "fire
  N missed runs." Match standard cron semantics.

---

## R-07 — Sapling-first runtime surface
Status: [proposed]
Depends on: optional sapling-side event additions — **most have shipped in
sapling v0.3.2** (see cross-repo status below). Not blocking; warren can land
the default-role toggle and the RunDetail panel today against the existing
event surface.
Unlocks: sapling-as-default option for power users; production pressure on
sapling itself; differentiated UX vs. claude-code runs

**Cross-repo status (2026-05-10).** Sapling v0.3.2 emits everything the
roadmap originally listed as "future":
- `turn_end.contextUtilization` ✅ (`src/loop.ts:426`)
- `ready.model` ✅ (`src/hooks/events.ts:52-54`)
- `--mode rpc` for steer/abort/getState ✅ (`src/rpc/`)
- Structured `compact` events with `reason` + `archivedAs` ✅
  (`src/hooks/events.ts:172-180`)
- Per-turn score on `turn_end` (`activeOperationScore`, aliased `score`) ✅
- `commitment_added` / `commitment_resolved` events ✅
- `pipeline_stage` events under `--verbose` ✅
- `--system-prompt-file <path>` ✅ (also unlocks R-11's mulch injection path)

Remaining gaps:
- `operationCount` and `archiveEntryCount` are exposed via RPC `getState`
  (`src/rpc/types.ts:48,50`) but **not** on the `turn_end` NDJSON event.
  Workaround for warren: poll RPC `getState` for the panel's counters, or
  ask sapling to mirror them onto `turn_end` (small upstream patch).
- MCP / custom tool registry: not started; relevant to R-08 not R-07.

**Problem.** Warren today treats sapling and claude-code identically: spawn,
tail NDJSON, reap. But sapling has differentiating signals — context
utilization per turn, an active operations registry, an archive of compacted
turns — that the UI never surfaces. Meanwhile sapling itself hasn't had much
real-world pressure-testing; using it more in warren is the fastest way to
exercise it.

**Sketch.** Two parts:

1. **Default-role toggle.** `WARREN_DEFAULT_AGENT` env var picks the default
   role for the new-run form. Public default unset → `claude-code`. The
   project maintainer's Fly deploy sets it to `sapling`. Zero source change.

2. **Sapling-specific RunDetail panel.** When the run's agent is sapling:
   - **Context Health meter** sourced from `turn_end.contextUtilization`
     (already emitted today, 0.0–1.0 ratio).
   - **Operations / Archive counters** from `turn_end.operationCount` and
     `turn_end.archiveEntryCount`.
   - **Current model** from `ready.model`.
   - **(Future)** per-turn score, compaction events, commitments — surface
     these as sapling exposes them in the NDJSON stream.

Symmetry: sapling already supports `steer`, `abort`, and `getState` over its
RPC channel (stdin + unix socket). Warren's existing steer + cancel
endpoints just need to pass `--mode rpc` to sapling so the channel is open.
That's a 5-line change in the spawn path.

The sapling-side improvements (compact events, per-turn score in events,
commitment surface, structured pipeline-decision events) are a separate
cross-repo seed in `../sapling`. Warren ships R-07 with what's there today
and gets richer over time.

**Open questions.**
- Whether the panel is sapling-only or generic ("agents that emit
  contextUtilization"). Generic is cleaner; gate on event presence, not
  agent name.
- Whether warren should snapshot sapling's archive on reap (so the user can
  inspect what was compacted post-hoc). Defer; sapling's own archive
  persistence design is unfinished.
- Whether to enable sapling's RPC channel by default for all runs. Yes —
  it's the only way steer + cancel work cleanly, and there's no downside
  when no caller exercises it.

---

## R-08 — Operator agent (chat surface for warren management)
Status: [proposed]
Depends on: a self-describing warren API (`GET /openapi.json` is the natural
fit, mirroring burrow's `mx-f5d9c8` pattern); a long-running run that doesn't
freeze on idle (today's runs are one-shot)
Unlocks: conversational warren management — "spawn a refactor run on the auth
module," "create a triage seed for that error," "edit the docs-bot role" —
without context-switching to other UI surfaces; meta-validation that warren's
HTTP API is genuinely consumable by an agent

**Problem.** As the team's workflow gets richer (issues, roles, triggers,
multiple projects), the cost of clicking through warren's UI to set up each
task grows. The right answer is not more UI affordances; it's an agent that
sits inside warren and drives it on the user's behalf via the same HTTP API
external clients use.

**Sketch.** Three parts:

1. **Self-describing warren API.** `GET /openapi.json` exposes the full HTTP
   contract (auth-required, mirrors burrow's pattern). `GET /openapi.html`
   serves a Scalar-rendered viewer (auth-exempt). Hand-authored source so
   the wire shape is locked.

2. **Built-in `operator` role.** A canopy prompt with warren's HTTP API as
   its tool set. Realistically claude-code as the harness for V2 (sapling's
   tools are hardcoded today; MCP support is future sapling work). The role
   knows how to: list/create/update seeds, dispatch runs, edit `.canopy/`
   prompts, configure triggers.

3. **Chat UI.** Multica-style FAB at bottom-right of the warren UI. Opens a
   panel that pipes messages into a long-running operator run. Operator
   responses + tool-call events stream back into the chat.

The operator agent is *just another role* — no special code path, no
privileged tools. Its capability comes entirely from warren's HTTP surface
plus its system prompt.

**Open questions.**
- Long-running run lifecycle. One-shot today; the operator wants a session
  that stays alive across many user messages. Either a new "session"
  primitive in warren, or the operator opens a fresh run per user message
  and stitches them via shared expertise (`.mulch/`). Lean session — clean
  conversational continuity matters more than implementation simplicity.
- Auth scope. The operator runs with full warren API access. Single-bearer
  today is fine; per-token scopes are a follow-up to R-09.
- Whether the operator role is per-project (lives in each project's
  `.canopy/`) or warren-instance-wide (a built-in). Built-in for V2; users
  fork it to a project if they want project-specific operator behavior.
- Cost. A long-running operator session burns tokens on idle context. Mitigate
  with sapling's compaction once R-07's sapling-side improvements ship.

---

## R-10 — Schema-driven configuration UI
Status: [proposed]
Depends on: R-04 (project nav hosts a Settings tab); each os-eco tool needs to
expose a config JSON Schema. **Per-tool readiness (2026-05-10):**
- Mulch ✅ shipped v0.9.0 — `ml config schema/show/set/unset`
- Seeds ✅ shipped v0.4.3 — `sd config schema/show/set --json`
- Canopy ❌ not started — no `cn config` write commands; config is read-only today
- Sapling ⚠️ partial — config cascade and `sapling config set <key> <value>`
  exist; `sapling config schema --json` not yet implemented

Warren can ship R-10 against mulch + seeds tabs today; canopy and sapling
tabs land as those tools add the schema CLI. This matches the original
"each tab unlocks for free as the upstream ships" framing.
Unlocks: every config knob in every os-eco tool tunable from warren's UI
without warren-side code changes; new knobs auto-appear as upstream tools ship
them; uniform validation/help-text experience across the ecosystem

**Problem.** Mulch (~20 knobs) and seeds (~3 knobs + `plan_templates`) and the
forthcoming canopy/sapling configs all live as YAML files in the project repo.
Today users edit those YAMLs by hand, often without remembering what knobs
exist. The natural next step is "wrap them in warren's UI," but the naive
approach — hand-rolling a form per knob — means warren has to ship a UI change
every time mulch adds `governance.archive_after_days`. That's a treadmill.

The leverage point: every os-eco tool's config is git-tracked, schema-shaped,
and free of env vars / machine-local state. They look near-identical
structurally. One schema-driven form renderer in warren wraps all of them at
once and stays current automatically as upstream tools evolve.

**Sketch.** Three parts:

1. **Each tool publishes its config schema.** A new CLI subcommand emits
   JSON Schema for the tool's config file:

       ml config schema --json     # → mulch.config.yaml schema
       sd config schema --json     # → seeds .seeds/config.yaml schema
       cn config schema --json     # → canopy config schema (future)

   Schema is hand-authored in each tool (same pattern as burrow's
   `mx-f5d9c8` OpenAPI self-description), versioned alongside the tool's
   own version. Warren caches per-tool-version.

2. **Warren has a generic SchemaForm renderer.** Reads a JSON Schema, emits
   a form. Type-aware widgets:
   - `string` → text input (or textarea if `format: long-text`)
   - `number` / `integer` → number input with min/max
   - `boolean` → toggle
   - `enum` → select
   - `array` → repeating list with add/remove
   - `object` → fieldset (recursive)
   - `Record<string, ...>` (e.g., `domains`, `custom_types`, `plan_templates`)
     → key/value editor with one nested SchemaForm per entry

   Uses the schema's `title`, `description`, `default` for labels, help text,
   and placeholder values. Validation runs client-side against the same schema.

3. **Per-tool overrides** for things that shouldn't be auto-rendered. A
   small file in warren maps schema paths to custom widgets:

       // src/ui/src/config/overrides.ts
       export const overrides = {
         "mulch:hooks.pre-record": "FilePicker",      // not a textarea
         "mulch:custom_types.*.summary": "TemplateEditor",
         "seeds:plan_templates.*.sections": "PlanTemplateEditor",
       };

   Default behavior is auto-rendering; overrides are escape hatches for the
   ~5% of knobs that benefit from bespoke UX.

**UI shape.** Settings tab on project detail (R-04 nav). Tabs within Settings,
one per tool: Mulch / Seeds / Canopy / Sapling / Warren. Each tab is a
schema-driven form. Save → write through the tool's CLI (`ml config set
governance.max_entries 200`) or, if a single-shot CLI doesn't exist, write
the YAML directly and run `<tool> config validate` to confirm.

**Read/write path.** Read: warren shells out `<tool> config show --json` (or
parses YAML directly if no command exists). Write: prefer `<tool> config set
<path> <value>` if the tool offers it; fall back to "edit YAML, run validate,
stage commit" otherwise. The CLI surface for `config set` is a small
cross-repo addition each tool can implement at its own pace.

**Open questions.**
- Schema discovery: does warren call `<tool> config schema` at startup, or
  bake per-tool-version manifests into warren's source? Lean dynamic
  discovery — warren stays current without redeployment when the user
  upgrades mulch/seeds.
- Save semantics: prefer per-knob CLI commands, or write YAML and let the
  tool re-validate? Lean per-knob CLI when available (atomic, validation
  built in); YAML write is the fallback. Either way, every save stages a
  git commit.
- Nested editors for `custom_types`, `plan_templates`, `hooks` — single
  shared component (driven by the schema's nested shape) or one per tool?
  Lean shared; the structures differ in keys but not in shape.
- How to handle config knobs that need a tool restart to take effect (if
  any). Mulch + seeds are CLI-invoked-per-call so this is moot today, but
  warren's own config (R-02 `.warren/`) might have runtime-state knobs
  that need a scheduler tick to pick up. Surface a "restart required"
  banner per knob in those cases.
- Whether to surface tool versions in the Settings UI ("running mulch
  v0.8.0; schema differs in v0.9 — run `ml config migrate` to update").
  Yes, eventually; defer to v2.1+.

**Cross-repo work.**
- Mulch: add `ml config schema` and `ml config set <path> <value>` CLI
  surface. ROADMAP item in mulch.
- Seeds: same — `sd config schema`, `sd config set`. ROADMAP item in seeds.
- Canopy: same when canopy gets a config file.
- Sapling: same — sapling already has a config cascade (env → YAML → defaults);
  publishing the schema is small.

---

## R-11 — Canopy roles declare mulch dependencies (spawn-time injection)
Status: [partially shipped] — both cross-repo halves shipped 2026-05-10; warren consumer-side spawn injection not yet wired up
Depends on: cross-repo prerequisites — **all shipped (2026-05-10):**
- Canopy v0.2.4 — `mulch:` + `extends_mulch:` resolve in `cn render --json`,
  emit on `RenderResult.mulch`; merge semantics tested in render.smoke.test.ts
- Mulch v0.8.0+ — `ml prime --format plain` and `--dry-run` both exist; compose
  with `--domain` / `--files` / `--budget` as the roadmap assumed
- Sapling v0.3.2 — `--system-prompt-file <path>` exists, so the concatenated
  system prompt can be passed through cleanly (claude-code's equivalent already
  in use)
Unlocks: roles become self-contained units of "system prompt + active project
expertise"; base-prompt expertise dependencies propagate via canopy inheritance
(opt-in); user no longer has to remember to `ml prime` per session — the role
declares its own knowledge dependencies and warren applies them automatically

**Problem.** Mulch and canopy serve adjacent purposes — canopy stores prompt
templates, mulch stores structured project expertise — and are disconnected
today. A canopy role doesn't know which mulch domains/files matter for its
work, so users invoke `ml prime` separately each session and hope the agent
reads it. Roles defined around "this codebase's refactor patterns" should
travel with their expertise dependencies as part of the role definition;
otherwise the same role becomes useless against a project where the user
forgot to prime mulch first.

**Sketch.** Add a `mulch:` block to canopy role frontmatter:

    extends: base-coding-agent
    extends_mulch: true              # opt-in: merge parent's mulch declaration
    mulch:
      prime:
        domains: [warren, ecosystem]
        files: [src/runs/**, .seeds/**]
      budget: 50000
      on_empty: skip                 # skip | warn | error

Canopy resolves inheritance: with `extends_mulch: true`, the child's mulch
declaration merges with the parent's (domains and files unions, budget last-
wins). Without it, the child's declaration overrides the parent's wholesale.
The resolved declaration is emitted as part of the rendered envelope
(`agents.renderedJson.mulch`); canopy itself does **not** shell out to ml.

At spawn time, warren consumes the resolved declaration:

1. Reads `agents.renderedJson.mulch` from the role's registry entry.
2. Expands globs against the project's working tree (warren's clone, not the
   burrow workspace — faster, matches mulch's anchor model).
3. Shells out `ml prime --domain warren --domain ecosystem --files
   src/runs/... --files .seeds/... --budget 50000 --format plain`.
4. **Concatenates** the output into the system prompt sent to the harness:

       {role.systemPrompt}

       ## Project Expertise (from mulch)

       {primedContent}

5. Passes the combined system prompt to sapling/claude-code (sapling:
   `--system-prompt-file`; claude-code: equivalent).

No workspace file, no agent-side read instruction. The expertise simply *is*
the system prompt.

Caching: roles without `mulch:` use the agents-table cache as today. Roles
with `mulch:` re-prime on every spawn — `ml prime` cost is small relative
to run cost, and mulch state can change between spawns. The cached canopy
render stays clean (mulch-free); injection happens at warren's spawn step.

Observability: R-05's editor preview pane shows "would prime: N records,
M tokens" via `ml prime --dry-run`. Run detail page lists the actual primed
record IDs after spawn (clickable to view).

**Open questions.**
- Concatenation point: system prompt suffix vs. an additional system message
  slot if the harness supports multiple. Lean suffix — works with any harness
  that accepts a single combined system prompt; no per-harness branching.
- Project with no `.mulch/`: `ml prime` returns empty, warren skips the
  concatenation cleanly. Matches `on_empty: skip` default. Confirm.
- Globs evaluated against working tree (warren's clone) vs. burrow workspace.
  Lean working tree — faster, doesn't require a burrow round-trip.
- Whether to surface the primed content in the run detail UI or just the
  record IDs. Lean record IDs (clickable to expand); full text would bloat
  the UI for long primings.
- Dynamic file priming where the file list is derived from the seed/issue
  (paths mentioned in description, files modified in the latest commit on
  the branch). Out of scope for V1; could become R-12 if the static glob-
  list proves insufficient.
- Whether `extends_mulch: true` is the right name. Alternatives: `merge`,
  `mulch_merge`, `mulch.extends: true`. Bikeshed during implementation.

**Cross-repo work.**
- Canopy: add `mulch:` and `extends_mulch:` to role schema; resolve
  inheritance; emit resolved declaration in rendered envelope. No ml
  shellout.
- Mulch: add `--format plain` if missing (clean text suitable for system
  prompt concatenation, no markdown noise); optional `--dry-run` for the
  editor preview. Both small additions.
- Warren: consume `renderedJson.mulch` in the spawn step; add `ml prime`
  invocation; concatenate output into system prompt before dispatching
  to harness. Roughly 30–50 lines in `src/runs/spawn.ts` + a small
  glob-expansion helper.

---

## R-09 — Per-user identity and audit
Status: [deferred]
Depends on: — (independent of all above)
Unlocks: real attribution on issues/runs, multi-user assignee picker
("members + roles"), audit log for compliance-conscious teams

**Why deferred (2026-05-10).** Locked in design discussion: stay single-shared-
bearer for V2. The team-of-ICs use case can be served by everyone sharing one
Fly deploy with one token, and treating the project repo's git history as the
audit trail. Per-user accounts are the gating feature for richer attribution
UX (multica's member picker, Slack-style mentions) but not for any of R-01
through R-08.

Pick up when one of these is true: (a) a team adopts warren at >5 ICs and
asks for attribution, (b) compliance/security review requires per-user audit,
(c) R-08's operator agent grows enough power that scoping its access becomes
worth the cost.

**Sketch (for when revisited).** Local-first auth: a `users` table in warren's
SQLite, password or local-token login (no external SSO in V2 of this item),
attribution on `runs.created_by`, `seeds.extensions.assignedBy`, etc. OAuth
(GitHub) login as a follow-up if external SSO becomes important.

---

## Decisions already made

Choices locked in during prior design discussions. Captured here so they aren't
relitigated when items become seeds issues.

- **DB only for runtime state.** Warren's SQLite holds runs, events,
  trigger fire-history, agents-registry-cache. It does *not* hold issues,
  roles, expertise, or trigger config. Those are git-tracked in the project
  repo (`.seeds/`, `.canopy/`, `.mulch/`, `.warren/`). This is the
  architectural anchor for R-01 through R-08.
- **Seeds is the source of truth for issues.** No warren issues table.
  The UI is a friendlier wrapper over `sd` CLI.
- **Single-bearer auth in V2.** Per-user identity (R-09) is deferred.
- **Sapling for personal use, claude-code as public default.**
  `WARREN_DEFAULT_AGENT` env var, no source change.
- **Roles tab editor is raw markdown with full canopy feature set.**
  Inheritance, mixins, and partials all work. Editing a base prompt
  propagates through the whole tree on next render. Wrapping canopy in a
  structured form is rejected.
- **Roles resolve in three tiers: per-project > library > built-in.**
  Per-project `.canopy/` is the new tier added by R-03.
- **No GitHub label / issue-event triggers in this phase.** Warren stays
  a self-contained dashboard. GH webhook integration can be added later as
  another `kind:` entry in `.warren/triggers.yaml`; the schema leaves room.
- **Warren stays self-hosted, not SaaS.** Multi-tenancy is explicitly
  out of scope; one warren deploy = one team.

## Cross-cutting themes

Threads that run through multiple items.

- **Git as the source of truth for definitions** (R-01, R-02, R-03, R-05).
  Roles, issues, expertise, trigger config all live in the project repo.
  Warren is a friendly editor + runtime control plane on top. Losing a
  warren VM never costs you knowledge.
- **Decoupling creation from execution** (R-04, R-06). Multica's headline
  pattern: file work today, dispatch later. Issues queue, schedules fire,
  triggers route. Manual dispatch is one of many trigger sources, not the
  only one.
- **Sapling as production harness** (R-07; cross-repo work in `../sapling`).
  Warren is the most active consumer of sapling. Pressure-testing it here
  closes its real-world feedback loop.
- **Warren as a substrate for managing itself** (R-08). The operator role
  is the meta-validation that warren's HTTP API is genuinely consumable
  by an agent — not just by the React UI.
- **Schema-driven UI as ecosystem leverage** (R-10). Each os-eco tool
  publishes its config schema; warren consumes them all through one
  renderer. Adding a knob upstream becomes "edit schema" — UI follows
  automatically. Same pattern that burrow's `mx-f5d9c8` OpenAPI
  self-description applied to API surface, R-10 applies to config surface.
- **Roles travel with their expertise** (R-11). Canopy holds the role
  definition, mulch holds the project's accumulated knowledge. R-11 makes
  the canopy role declare which mulch domains/files it depends on, so
  spawning a role automatically primes the agent with the right expertise.
  Inheritance (opt-in) lets a base prompt's expertise propagate to all
  descendants — same pattern as the markdown-edit propagation in R-05.

## Recently shipped

Cross-references to closed work that maps onto post-V1 direction. Tracked here
so subsequent revisions know what's already off the punch list.

- **End-to-end Fly deploy with PR auto-open** (verified 2026-05-10). Manual
  run path on cloud-deployed warren: dispatch from UI → burrow spawned →
  agent worked → reap → PR opened automatically. The V1 success criterion.
- **Acceptance harness scenarios 05–08** (warren-647e, warren-a7f9). Events
  stream durability, restart-recovery, steer + cancel coverage. Live-stack
  end-to-end checks under `scripts/acceptance/`.
- **PR auto-open on reap** (warren-f6af). Reap pushes the agent's branch and
  opens a PR via `gh` if `WARREN_AUTO_OPEN_PR=1` and there are commits ahead
  of the base branch. Surfaces the PR URL in the run row + UI.
- **Branch ref selection in NewRun UI** (warren-7589). Users pick a base
  branch when dispatching; project refresh tracks per-branch HEAD SHAs.
- **Built-in agents shipped inline** (`src/registry/builtins/`). `claude-code`
  and `sapling` available without any `CANOPY_REPO_URL` configuration. Fresh
  warren installs work out of the box.
- **`.warren/` directory convention** (R-02, plan `pl-5d74`, 2026-05-10).
  Per-project, git-tracked home for warren-specific config. Two files:
  `triggers.yaml` (cron entries, `kind:` discriminator leaves room for
  future webhook triggers) and `defaults.json` (per-project default role /
  branch / prompt). New `src/warren-config/` module owns the loader + zod
  schemas; `GET /projects/:id/warren-config` exposes the envelope; project
  detail UI renders triggers + defaults + per-file errors; `warren doctor`
  + `/readyz` add a `warren_config` check; acceptance scenario 14 covers
  absent / valid / malformed states. Triggers are parsed but not
  dispatched — R-06 picks them up next.

## Cross-repo readiness (2026-05-10)

Snapshot of which sibling-repo features the warren ROADMAP depends on, and
whether they've landed. Updated when sibling-repo versions bump. Per-item
detail lives inside each R-NN; this is just the dashboard.

| Dep | Item | Status | Version |
|---|---|---|---|
| Seeds `extensions` field + CLI | R-01, R-04, R-06 | ✅ shipped | seeds v0.4.3 |
| Seeds `--respect-schedule` ready filter | R-04, R-06 | ✅ shipped | seeds v0.4.3 |
| Seeds config schema CLI | R-10 | ✅ shipped | seeds v0.4.3 |
| Canopy `extends` + mixins + `cn render --json` | R-05 | ✅ shipped | canopy v0.2.4 |
| Canopy `mulch:` / `extends_mulch:` frontmatter | R-11 | ✅ shipped | canopy v0.2.4 |
| Canopy config schema CLI | R-10 | ❌ not started | — |
| Mulch `ml prime --format plain` / `--dry-run` | R-11 | ✅ shipped | mulch v0.8.0+ |
| Mulch config schema CLI | R-10 | ✅ shipped | mulch v0.9.0 |
| Sapling event stream (contextUtilization, score, commitments, compact, RPC) | R-07 | ✅ shipped | sapling v0.3.2 |
| Sapling `operationCount`/`archiveEntryCount` on `turn_end` | R-07 | ⚠️ via RPC `getState` only | sapling v0.3.2 |
| Sapling `--system-prompt-file` | R-07, R-11 | ✅ shipped | sapling v0.3.2 |
| Sapling config schema CLI | R-10 | ⚠️ partial (set ✅, schema ❌) | sapling v0.3.2 |
| Sapling MCP / custom tool registry | R-08 | ❌ not started | — |

Net: every cross-repo blocker for R-01, R-04, R-05, R-06, R-07, and R-11
is satisfied. R-10 can ship 2-of-4 tabs (mulch + seeds) today; canopy and
sapling tabs unlock as those tools add `<tool> config schema --json`. R-08's
MCP dependency for sapling-as-operator-harness is still out — claude-code
remains the operator harness for V2.

## Suggested sequencing

A first cut at order of attack — not committed. Updated 2026-05-10 to reflect
cross-repo readiness: R-01's seeds-side and R-11's canopy + mulch sides have
all shipped, so several items that were "wait on the upstream" are now
"warren-internal work."

1. **R-02** (`.warren/` directory) — ✅ shipped 2026-05-10 (plan `pl-5d74`).
   Establishes the config pattern R-06 builds on. R-06 now unblocked.
2. **R-03** (per-project canopy tier) — small, scoped to the registry module.
   Independent of R-02; can land in parallel.
3. **R-01 consumer-side** — seeds half is shipped; warren needs to wire
   `sd update --extensions` calls into the spawn / reap paths and start
   reading `extensions.{role,scheduledFor,trigger,lastRunId}` in the UI.
   Small; folds naturally into R-04.
4. **R-04** (project + issues UI) — biggest item. The team-of-ICs UX unlock.
   All seeds-side prereqs satisfied.
5. **R-06** (cron scheduler) — depends on R-02. Seeds-side scheduling primitives
   (`extensions.scheduledFor`, `sd ready --respect-schedule`) are ready. Can
   land before R-04 if scheduling pressure is higher than issue-tracking
   pressure.
6. **R-05** (roles tab UI) — depends on R-03. Canopy's render contract is
   ready. Less load-bearing than R-04; land after the issue UX is solid.
7. **R-11** (canopy + mulch meshing) — both upstreams shipped; entirely
   warren-side now. Roughly 30-50 lines in `src/runs/spawn.ts` plus glob
   expansion. Pairs nicely with R-05's editor preview pane but doesn't
   block on it.
8. **R-07** (sapling-first runtime) — orthogonal to everything else; can land
   any time. Most sapling events shipped; warren just consumes them.
   `operationCount`/`archiveEntryCount` use RPC `getState` until sapling
   mirrors them onto `turn_end`.
9. **R-10** (schema-driven config UI) — depends on R-04. Mulch + seeds tabs
   can ship today against shipped schema CLIs. Canopy and sapling tabs
   wait on each tool's `config schema --json` to land.
10. **R-08** (operator agent) — stretch. Depends on R-04 and R-05 being
    stable enough that an agent can drive them. Benefits from R-11 (the
    operator is itself a role that wants project expertise). Sapling MCP
    is the long-tail dependency for sapling-as-operator-harness; claude-code
    is the V2 harness regardless. Skip if earlier items run long.
11. **R-09** (per-user identity) — deferred until a real consumer asks.
