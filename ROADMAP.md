# Warren Roadmap

Direction for warren as it grows from "single-user end-to-end works on Fly" to a
self-hosted control plane that an engineering organization of 50+ ICs can adopt
on their own infrastructure. Each item is a self-contained idea with a stable
ID for reference. Items can be sequenced independently; the dependency graph is
captured per-item.

The positioning shift toward org-scale self-hosting is recorded in `SPEC.md`
§11.J (2026-05-11). The **Org-readiness cluster** below (R-12 through R-18,
plus the repromoted R-09) captures the eight planned additions: remote burrow
workers, bring-your-own database, multi-user identity, MCP support, a
cross-project activity UI, audit log, cost guardrails, and GitHub App auth.

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
built-ins shipped in `src/registry/builtins/` (claude-code, sapling, pi) and
an optional shared canopy repo via `CANOPY_REPO_URL`. There's no third tier for
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
Status: [shipped] 2026-05-11 via plan `pl-2f15` (parent seed `warren-3f59`).
Depends on: R-02 (`.warren/triggers.yaml` parsed via `loadWarrenConfig`,
shipped 2026-05-10 via pl-5d74); R-01 (seeds `extensions.scheduledFor` +
`sd ready --respect-schedule`, shipped seeds v0.4.3). Both satisfied at
implementation time.
Unlocks: scheduled agent runs without leaving warren; nightly refactor /
weekly docs-update / hourly triage-sweep workflows. SPEC §11.I covers the
shipped contract; this entry is the design record.

**Problem.** Warren's only trigger today is "manual via UI or CLI." Teams need
recurring runs (nightly cleanup, weekly stale-issue triage) without standing
up an external cron + webhook pair. That's a thin layer on warren's existing
spawn path.

**Shipped shape.** Module `src/triggers/` mirrors `src/warren-config/` layout
(`errors.ts`, `config.ts`, `schema.ts`, `repo.ts`, `dispatch.ts`, `tick.ts`,
`cron.ts`, `seeds-extension.ts`, `index.ts`). Two trigger sources:

1. **Recurring (cron):** entries in `<projectPath>/.warren/triggers.yaml`
   (R-02). Each entry has a cron expression and dispatches a warren run with
   `trigger: 'cron'`. Cron parsing is `croner` (chosen for tz support, ~30 KB,
   no native deps — `mx-5199d0`); warren-config keeps the loose 5-or-6-token
   validation (`mx-40fe51`) and dispatch falls through to croner for the
   strict pass at fire time.
2. **One-off (scheduled-for):** seeds with `extensions.scheduledFor` in the
   past dispatch with `trigger: 'scheduled'`. After dispatch, warren shells
   out to `sd update --extensions` to move `scheduledFor` → `lastScheduledRun`
   (`mx-a2ea60`). The triggers row is written **first** so a failed clear
   can't cause double-dispatch on the next tick.

A single in-process tick (60s by default, `WARREN_SCHEDULER_TICK_MS`) runs
inside `bootServer`'s lifecycle; teardown is via `WarrenServerHandle.stop`
(`mx-15bd97`). The tick wraps itself in a single-flight guard so a slow tick
can't pile up (`mx-eb4a3a`). Disable with `WARREN_SCHEDULER_DISABLED=1`.

Warren DB additions (migration 0005):

    triggers (
      id TEXT PRIMARY KEY,            -- composite: <projectId>:<triggerId>
      project_id TEXT NOT NULL,       -- FK projects(id) ON DELETE CASCADE
      last_fired_at TEXT,
      next_fire_at TEXT,
      last_run_id TEXT                -- FK runs(id) ON DELETE SET NULL
    )

Composite-string PK (`mx-55296f`) avoids a multi-column key; `TriggersRepo.upsert`
uses undefined-vs-null semantics on patch fields so omitted means
"preserve" and null means "clear" (`mx-18a708`).

**HTTP surface.** `GET /projects/:id/triggers` returns
`{triggers: TriggerSummary[], errors: WarrenConfigFileError[]}` — parsed YAML
joined with the triggers row's `lastFiredAt`/`nextFireAt`/`lastRunId` (`mx-a93eb5`).
`POST /projects/:id/triggers/:triggerId/run` is the Run Now path: resolves
the trigger from warren-config, dispatches inline with `trigger='manual'`
(human-pressed Run Now is a manual dispatch, not a cron fire), returns the
run row (`mx-f3b48d`).

**UI.** `TriggersBlock` in `ProjectDetail` (`mx-28b6a2`) renders the wire
envelope: per-trigger row with cron expression + last/next fire columns + a
Run Now button. YAML editing remains a git operation per the R-02 read-only
posture (`mx-a5e30e`).

**Open questions — resolved.**
- *Cron implementation:* picked `croner` over a homegrown parser. Cron has
  enough corner cases (step values, ranges, DOW vs DOM, 6-token seconds) that
  rolling our own would be wrong or grow into croner anyway. The "small
  surface" argument only held if we skipped tz + DST, which we explicitly
  want. Recorded as decision in mulch.
- *Timezone:* per-trigger `timezone` schema field stays (R-02). Default UTC
  when omitted. UI renders the tz next to the cron expression; SPEC §11.I
  notes the DST gotchas.
- *Failure handling:* closed/missing seed → skip + structured log + surface
  as a `lastSkipReason` on the trigger summary (deferred to follow-up if
  pressure shows up in production). Cron parse failures bubble through the
  warren-config errors envelope on `GET /triggers` so operators see the
  failing entry without tailing logs.
- *Catch-up after warren downtime:* explicit no. Cron is "fire at time T,"
  not "fire N missed runs." First observation of a fresh trigger seeds
  `lastFiredAt=now` and computes `nextFireAt` from there (`mx-ac8acd`), so a
  long outage skips silently and the operator can Run Now if they want
  replay. Recorded as decision.

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

## R-09 — Per-user identity and SSO
Status: [proposed] — repromoted 2026-05-11 from `[deferred]` as part of the
org-readiness cluster (SPEC §11.J). The "wait for a real consumer" condition
is satisfied: org-scale self-hosting is now the explicit direction.
Depends on: — (independent of R-01 through R-08; load-bearing for R-16 and R-17)
Unlocks: real attribution on issues/runs, multi-user assignee picker
("members + roles"), audit log for compliance-conscious teams (R-16),
per-user cost & concurrency budgets (R-17), service-account separation for
CI vs. interactive users

**Problem.** A single shared bearer token doesn't work for a 50-engineer
team. Every dispatch is attributed to "the warren box"; revoking access for
one departing engineer means rotating one secret everybody now needs;
compliance review can't accept "we share one credential" as a finding. SSO
via OIDC (Okta / Google Workspace / GitHub OAuth) is the table-stakes shape
every internal-platform tool ends up needing at this size.

**Sketch.** OIDC login as the primary path; the existing single bearer
token stays as a *service account* path for CI scripts and the greenhouse
outer loop. Schema additions: `users` table (id, email, oidc_subject,
created_at, disabled_at), `runs.created_by` (FK to users, nullable for
service-account dispatches), `seeds.extensions.assignedBy` populated on
warren-side issue updates. The UI gains a session-cookie auth layer and a
top-bar identity widget. Service-account bearer dispatches show in the
audit log (R-16) as their own pseudo-user.

**Open questions.**
- Provider abstraction — bake against a generic OIDC library (`openid-client`
  or similar) so Okta / Google / GitHub / Auth0 all work, or hard-code two
  or three concrete providers? Lean generic OIDC for the same reason warren
  uses generic Bun.serve over a framework.
- Token lifetime / refresh strategy. Short-lived access tokens + refresh
  tokens stored server-side, signed session cookie holds the user id.
- Migration story for existing single-bearer deploys. Probably: SSO is
  opt-in via `WARREN_OIDC_ISSUER_URL`; if unset, warren stays in
  single-bearer mode (V1 posture preserved).
- Per-user authorization is intentionally *not* in this item — every
  authenticated user can do everything in V2 of R-09. RBAC is a separate
  follow-up if it ever lands.

---

## Org-readiness cluster (R-12 – R-18)

The seven items below are the rest of the org-readiness direction recorded
in `SPEC.md` §11.J (2026-05-11). R-09 (above) is the eighth; it's
sequenced first because R-16 and R-17 depend on real user identity. The
cluster is additive — none of these change V1's shipped behavior when the
relevant feature is unconfigured (no SSO issuer = single-bearer mode, no
`WARREN_DB_URL` = SQLite, no remote workers registered = local burrow,
etc.).

## R-12 — Remote burrow workers
Status: [proposed]
Depends on: `burrow-c47a` (burrow-side protocol design — transport, auth,
worker registration, run placement). Filed 2026-05-11 as a stub-with-plan
seed; the burrow agent expands it into a sub-plan before any code lands.
Unlocks: warren as a control plane across multiple hosts; lifting the
"single box is the concurrency ceiling" limit; per-worker capabilities
(e.g. GPU-only workers) for advanced use cases

**Problem.** Today every burrow runs inside the warren container. One box
is the concurrency ceiling — 50 engineers each dispatching an agent at
once exhausts the host. The warren↔burrow seam is already HTTP
(`HttpClient` from `@os-eco/burrow` over a unix socket, §3.3); making
burrow listen on a network address with auth is additive, not a rewrite.
The SPEC's "No remote burrow workers" non-goal (§3.2) was an explicit
choice for V1 simplicity; org-scale adoption is the reason to lift it.

**Sketch.** Burrow side (tracked in `burrow-c47a`): a "worker mode" for
`burrow serve` that binds TCP with bearer-token auth (mTLS as the
recommended deploy posture). Warren side: a `workers` table (id, url,
auth_token_ref, labels, last_seen_at, drained_at), a worker registry
endpoint workers call into on boot, a placement function that picks a
worker per run (round-robin with project-affinity for warm clones). Local
burrow stays the default — a warren with zero registered remote workers
behaves exactly like today (`burrow.sock` over a unix socket).

**Open questions.**
- Worker discovery — static config list, warren-side registration
  endpoint, or both? Static for V2, dynamic registration as a follow-up.
- Run placement policy — round-robin, project-affinity, label-based,
  explicit pin? Start with project-affinity (keep a project's clones warm
  on the worker that first saw it) and let users override per-dispatch.
- State boundary — keep burrow's SQLite per-worker, warren queries each
  worker for its runs and aggregates. Don't try to lift run state up to
  warren; the existing local-state-per-burrow contract is correct.
- Threat model — assume the network between warren and worker is
  hostile by default (TLS required, no plaintext bearer). VPC-private
  deploys can downgrade if they want.

---

## R-13 — Bring-your-own database (Postgres backend)
Status: [proposed]
Depends on: — (independent; uses Drizzle's existing dialect abstraction)
Unlocks: SREs operating warren state in their org's existing managed
Postgres rather than a docker volume; org-scale deploy stories
("attach warren to our RDS instance") that V1 can't tell

**Problem.** SQLite via `bun:sqlite` is the only backend today (§6).
That's the right default for a home-server appliance and the wrong one
for an internal-platform tool a 50-engineer org adopts. Org SRE teams
won't operate "state lives in a docker volume" as their source of truth
for what their engineers ran when. The fact that Drizzle is already the
ORM (§6) makes this swappable at the storage layer rather than a
rewrite.

**Sketch.** `WARREN_DB_URL` env var. If unset (or `sqlite:///data/warren.db`),
warren behaves as today. If a Postgres URL (`postgres://...`), warren
uses `drizzle-orm/node-postgres` and runs Postgres-dialect migrations.
Burrow's own SQLite stays per-worker — that's run-local sandbox state,
not org truth, and the boundary is already clean. Audit the schema for
SQLite-isms (no `WITHOUT ROWID`, no SQLite-specific JSON ops, careful
with text-as-enum) and have Drizzle Kit emit both dialects from one
schema file.

**Open questions.**
- Connection pooling shape — Drizzle's default `node-postgres` Pool with
  `WARREN_DB_POOL_MAX` knob, or PgBouncer assumed in front? Default pool
  for V2 of this item; document the PgBouncer path.
- Migration story for existing SQLite users. Probably: ship a
  `warren db migrate-to-postgres --from <sqlite-path> --to <pg-url>`
  one-shot tool, not an in-place online migration.
- What about MySQL? Drizzle supports it. Decision: Postgres only for V2;
  MySQL as a follow-up if a real consumer asks. Keep the dialect
  abstraction clean so it's a config change, not a code change.

---

## R-14 — Cross-project activity UI + stable OpenAPI
Status: [proposed]
Depends on: R-04 (project + issues UI) for the per-project drill-down
target. The activity feed lives above R-04, not instead of it.
Unlocks: cognitive scalability when a team is running dozens of agents
across many repos; third-party dashboards built against warren's API
(closes §11.C open question #1 on OpenAPI)

**Problem.** Today's UI is project-scoped — pick a project first, then
see its runs and triggers. That breaks at any non-trivial fleet size:
an SRE on-call wants "what is every agent doing right now, what needs
attention" without clicking through 30 projects. Kanban boards (multica,
OpenAI Codex Web) are one answer; an engineering-team-shaped answer is
**a unified activity feed sorted by 'needs attention'** with collapse-by-
project. Separately, the lack of a versioned OpenAPI spec means teams who
want to build their own dashboards have to reverse-engineer the wire
envelope.

**Sketch.** New top-level UI page `/activity`: time-sorted feed of runs
across all projects, with filters (status, agent, project, user once
R-09 lands), grouping by project as an option not a default. Each row
links to its run / project / PR / failing test. "Needs attention" is a
computed pseudo-status: `failed`, `awaiting_input` (steered run with no
follow-up), `pr_review_requested`, `pr_check_failed`. Backed by a new
`GET /activity` endpoint that aggregates across projects. Separately,
hand-author `src/server/openapi/spec.ts` (same pattern burrow uses, per
§11.C #1), golden-lock it, generate a typed client for the UI off of it.

**Open questions.**
- Real-time vs. polled? Today's project page polls; activity feed wants
  SSE to feel live. Reuse the existing event-stream bridge or a new
  cross-project SSE? Probably new — single subscription, server-side
  fan-in.
- Pagination shape for the OpenAPI surface. Cursor-based against a
  monotonic id is the right answer; document it once and use it
  everywhere.
- Where does the audit log (R-16) surface? Same feed with a filter, or
  a separate page? Same feed; audit is "what happened" and activity is
  "what's happening." Different filters over the same underlying
  stream.

---

## R-15 — MCP support
Status: [proposed]
Depends on: burrow-side per-run credential mount (not yet filed; same
architectural shape as the `.gitconfig` resolution in SPEC §11.G). Sapling
MCP support tracked as the long-tail dep in §R-08.
Unlocks: agents that use the team's existing MCP servers (GitHub, Slack,
Notion, Linear, internal tools) without per-deployment glue; closes the
biggest "we already standardized on MCP" objection from would-be adopters

**Problem.** MCP isn't mentioned anywhere in `SPEC.md`. Every large
engineering org has already adopted MCP for tool integrations and will
expect their agents to use it. Two distinct problems sit underneath:
(a) how does an agent definition declare which MCP servers it wants, and
(b) how do those servers authenticate from inside a sandbox where OAuth
flows can't redirect to localhost?

**Sketch.** Canopy frontmatter gains an `mcp_servers` block alongside
the existing `burrow_config`:

    mcp_servers:
      - name: github
        url: https://mcp.github.com
        auth: oauth          # or "token"
      - name: linear
        url: https://mcp.linear.app
        auth: token

Warren reads the block at spawn time and threads it into the agent's
runtime config (sapling and claude-code both speak MCP). For `auth: token`
servers, warren mounts a credential file from `WARREN_MCP_CREDENTIALS_DIR`
into the burrow workspace at a known path (`/run/secrets/mcp/<name>`).
For `auth: oauth`, V2 of this item ships static-token-only ("paste the
already-issued token into the credentials dir"); a proper OAuth broker
on the warren host with refresh-token mounting is a follow-up.

**Open questions.**
- Where does the burrow-side mount live? Burrow's bwrap profile currently
  binds `/usr`, `/etc`, `/lib`, etc. (read-only). A per-run secrets bind
  is the same architectural change as the `.gitconfig` problem (§11.G);
  do it once, use it for both. File the burrow-side seed when this item
  becomes committed work.
- Credential rotation — static tokens until they expire, or refresh
  on-the-fly? Static for V2; refresh broker as a follow-up.
- Server discovery — purely declared per-agent, or a project-level
  default in `.warren/`? Per-agent for V2; project-level defaults can be
  layered on top once the per-agent path is shipped.

---

## R-16 — Audit log
Status: [proposed]
Depends on: R-09 (need real user identity to attribute events to)
Unlocks: compliance review, "who ran what against which repo when"
queries, security-review sign-off; doubles as the data source for R-14's
activity feed

**Problem.** Today every dispatch is attributable to "the warren box" via
a shared bearer. That's not survivable for any org with a compliance
function — security review will ask "who can dispatch agents, and how do
you know after the fact what they did?" and the only answer warren can
give today is "the git history of the PRs they opened." Insufficient for
read actions (secret reads, agent edits, steer messages) that don't
produce a commit.

**Sketch.** New `audit_log` table — append-only, never updated, indexed
on `user_id` + `created_at`. Events: `run.dispatched`, `run.steered`,
`run.cancelled`, `agent.created`, `agent.updated`, `secret.read`,
`trigger.run_now`, `project.added`, `project.deleted`, `auth.login`,
`auth.token_rotated`. Each row: `(id, user_id, action, resource_type,
resource_id, metadata jsonb, ip_address, user_agent, created_at)`.
Service-account dispatches use a synthetic user id (`svc:<token-name>`).
Surfaced in the UI as a filtered view of R-14's activity feed; exportable
as JSONL for SIEM ingest via `GET /audit-log.jsonl?since=<cursor>`.

**Open questions.**
- Retention policy. Append-only forever is the right default for
  compliance; add a `WARREN_AUDIT_LOG_RETENTION_DAYS` knob for orgs that
  want a hard cap.
- Tamper-evidence — chain rows with a hash-of-previous-row, or just
  trust append-only-via-Postgres? Trust the DB for V2 of this item;
  hash chaining is a follow-up if any real consumer asks.
- Secret-read event resolution — log "this run accessed
  `ANTHROPIC_API_KEY`" or just "this run was authorized to access
  these secret names at dispatch time"? Latter for V2; the per-access
  granularity requires a hook in burrow that doesn't exist yet.

---

## R-17 — Cost & concurrency guardrails
Status: [proposed]
Depends on: R-09 (per-user budgets need user identity)
Unlocks: predictable spend at org scale; "one runaway agent can't take
down the box" SLO; pre-dispatch rejection rather than post-bill surprise

**Problem.** Nothing today prevents one excited engineer from kicking off
a 12-hour refactor that drains a month of API budget, or 50 simultaneous
dispatches that exhaust the host. V1's "no payment, no usage metering,
no quota" (§3.2) was a deliberate single-user-home-server choice; at
org scale it becomes a foot-gun. Token spend per run is already
observable (claude-code emits token counts; sapling has
`turn_end.contextUtilization`); the gap is enforcement before dispatch.

**Sketch.** Two budget tables — `budgets` (per-user, per-project,
per-agent; columns: scope_type, scope_id, period, tokens_max,
runs_concurrent_max, runs_per_period_max) and `budget_usage` (rolling
counters keyed by scope_id + period_start). Pre-dispatch check
intercepts `POST /runs` and rejects with a structured 429 + remaining
budget. Soft-warn at 80% via a UI banner; hard-fail at 100%. Per-run
token spend tallied at reap time from the run's terminal `result` event
(same source `branchPushed` uses). Concurrent-run cap is a simple count
of `runs.state IN ('queued', 'running')`.

**Open questions.**
- Budget granularity — token budgets only, or also "dollars" with a
  configurable per-model rate card? Tokens for V2 (model-agnostic);
  dollars as a follow-up using a config file pinning rates.
- Period semantics — calendar month, rolling 30-day window,
  fiscal-month-with-org-timezone? Rolling 30-day is the simplest;
  calendar-aligned periods are a follow-up.
- Who can change budgets — anyone authenticated, or an "admin" pseudo-
  role? V2 ships "anyone authenticated can change any budget" and lets
  the audit log (R-16) be the accountability mechanism. RBAC for budget
  edits is a follow-up.

---

## R-18 — GitHub App auth
Status: [proposed]
Depends on: — (independent; touches secrets handling and the supervisor's
git credential plumbing)
Unlocks: per-repo permission scoping, automatic token rotation,
short-lived per-run tokens (so a compromised run can't exfiltrate a
long-lived PAT), elimination of "everybody shares one human's PAT" as
a deploy pattern

**Problem.** V1 uses a shared `GITHUB_TOKEN` (a PAT) for cloning,
pushing, and PR creation. PATs are long-lived, broadly scoped, and
attributed to whatever human created them — none of those properties
are correct for an org-scale deploy. The supervisor's git credential
plumbing (`src/supervisor/git-credentials.ts`, see §11.G) already mints
the in-container git config; the change is in what it mints and how
it refreshes.

**Sketch.** Warren stores a GitHub App's private key + installation id
in its DB (encrypted at rest if `WARREN_ENCRYPTION_KEY` is set). At
dispatch time, the supervisor mints a fresh installation token scoped
to the project's repo via the GitHub API, valid for the duration of
the run (≤ 1 hour). The token is written to the same git-credentials
path that the PAT goes today (`/root/.gitconfig` `insteadOf` rewrite,
§11.G). PAT mode stays supported via `GITHUB_TOKEN` for the home-server
deploy; GitHub App mode activates when `WARREN_GITHUB_APP_ID` +
`WARREN_GITHUB_APP_PRIVATE_KEY` are set.

**Open questions.**
- Per-repo allowlist — installation-level (the App is installed on
  specific repos via GitHub's UI) is the natural answer; warren-side
  allowlist on top of that is a follow-up if needed.
- Token caching — mint per run, or cache for the install's
  `expires_at` and reuse across runs? Cache for the install duration;
  mint a new one if cached token has < 5 minutes left. Audit log
  (R-16) records each mint.
- Webhook signature verification — the V2 webhook receiver (§3.1)
  will want this too; GitHub App webhook secret lives next to the App
  credentials. Synergistic with R-18 but not blocking.

---

## R-19 — Per-run preview environments
Status: [proposed] — needs more sketching before commit
Depends on: burrow-side inbound networking policy (not yet filed; today
burrow's bwrap profiles bind for outbound only). Plays well with R-12
(remote workers) but doesn't require it.
Unlocks: runs feel real — "here's the agent's branch, here's the diff,
**and here's the working app at this URL**" instead of just a diff in
the UI. Removes the "I'd need to check this out locally to see if it
works" friction that pushes humans out of the review loop.

**Problem.** Today a successful run ends with a pushed branch and a
reap summary. The reviewer's next step is git-checkout-and-run-locally,
which is high-friction enough that most runs get judged on the diff
alone. If each run produced an ephemeral URL where the agent's output
was actually running, runs would feel like deployable artifacts rather
than text diffs. This is the *single biggest* perceived-realness win we
can ship — but it's underspecified across at least four layers (port
binding, host routing, TLS, lifecycle) and warrants a design pass
before we commit.

**Sketch.** Each successful run optionally exposes a public URL of the
form `https://run-<id>.<warren-host>` that proxies into the burrow
workspace's listening port. Roughly:

1. **Project opts in.** `.warren/defaults.json` (or `triggers.yaml`)
   gains a `preview` block declaring how to start a server inside the
   workspace and what port it listens on:

       preview:
         enabled: true
         command: "bun run dev"
         port: 3000
         readiness_path: "/healthz"
         ttl: "1h"

2. **Run reaper starts the preview.** After the agent reaches terminal
   success, warren tells burrow to spawn `preview.command` as a
   long-lived sidecar process inside the same workspace sandbox (or a
   forked sandbox — see open questions). Burrow needs an inbound
   networking policy that doesn't exist today.

3. **Routing.** A reverse proxy on the warren host (likely Caddy, which
   already handles its TLS automation) accepts `*.<warren-host>` and
   maps the subdomain → burrow workspace → internal port via a warren
   API call (`GET /previews/:run-id` returning `{burrow_id, port}`).
4. **TLS.** Operator points a wildcard `*.<warren-host>` CNAME at the
   warren box; Caddy issues a wildcard cert via Let's Encrypt DNS-01.
   Operator picks a DNS provider Caddy supports (Cloudflare,
   Route53, etc.) — this is real config burden we should document
   honestly.
5. **Lifecycle.** Preview lives until `preview.ttl` elapses or the
   reviewer clicks "Tear down" on the run-detail page. Warren persists
   `preview_state` per run (`starting | live | torn-down | failed`)
   and exposes the URL in the UI as a clickable link with a status
   badge.

**Open questions (the part that needs sketching).**

- **Same sandbox or forked?** Running `bun run dev` inside the same
  bwrap that the agent just ran in is simpler (one workspace, one
  filesystem, one process tree) but means the preview shares whatever
  state the agent left behind, including any malicious side effects.
  Forking a fresh sandbox from the agent's final commit is safer but
  doubles the burrow workload and complicates port binding. Default
  to "same sandbox" for the initial spec and document the tradeoff?
- **Auth on the preview URL.** A run against private code produces a
  preview containing whatever the agent built — possibly with secrets,
  possibly with the org's UI. Options: (a) the same bearer token that
  fronts warren, transferred via signed cookie; (b) GitHub OAuth (if
  R-18 ships); (c) basic auth with a per-run password surfaced in the
  reap summary; (d) no auth, opt-in per project. We should not ship
  (d) as the default.
- **Inbound burrow networking.** Burrow's bwrap profiles bind for
  outbound only today. Adding inbound means a per-burrow port-forward
  on the host loopback (`127.0.0.1:<random-port>` → burrow's port
  3000). This is the same architectural change as the
  `.gitconfig`-mount / per-run secret mount discussed in R-15 and
  §11.G — coordinate the seam.
- **Port allocation.** Static range (`30000-31000`)? Dynamic from the
  ephemeral range? Need a small allocator in warren that survives
  restarts (persist to `runs.preview_port`).
- **Resource ceiling.** A long-lived `bun run dev` per recent run can
  exhaust memory fast. Need an LRU eviction policy that supersedes
  the per-preview TTL (e.g., "max 20 live previews, evict oldest").
  Pairs naturally with R-17 (cost & concurrency guardrails) but
  shouldn't *require* R-17 to ship a useful V2.
- **Remote workers (R-12) interaction.** If the burrow is on a
  different host than warren, the host-side proxy needs to route
  cross-machine. Wireguard mesh between warren and workers? Public
  IP per worker + signed-URL routing? Push to R-12's protocol
  discussions before locking the design.
- **Custom domain per project.** Some projects will want
  `<project>.example.com/runs/<id>/` instead of
  `run-<id>.<warren-host>`. Defer to V2-of-this-item; ship the
  `run-<id>` form first.
- **Non-HTTP previews.** Lots of agent output is not a web server —
  a CLI tool, a generated PDF, a video render, a static-site bundle.
  Static-site fallback (preview command produces a directory, warren
  serves it through the same proxy) is a near-free addition once
  the routing layer exists; non-HTTP "preview as downloadable
  artifact" is a separate problem and likely out of scope here.
- **Failure UX.** If `preview.command` fails to bind or never passes
  `readiness_path`, the run is still successful — the agent did its
  work — but the preview is broken. Surface `preview_state: failed`
  with the last 200 lines of stdout/stderr; don't fail the run.

**Why this is filed as needs-sketching rather than implementable.** The
sketch above touches burrow's network policy, warren's proxy story,
TLS/DNS operator burden, auth, lifecycle, and the remote-worker future.
A real design doc should land before any code — probably a §11.K
addition to SPEC.md plus a burrow-side issue for inbound networking.

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
- **Single-bearer auth in V1.** Per-user identity (R-09) was deferred in
  the 2026-05-10 design discussion and repromoted 2026-05-11 as part of the
  org-readiness direction (SPEC §11.J). The bearer stays as a
  service-account path once R-09 ships OIDC.
- **Sapling for personal use, claude-code as public default.**
  `WARREN_DEFAULT_AGENT` env var, no source change. (Pi joined as the third
  built-in 2026-05-12 — same env-var picks it as default for multi-provider
  / cost-reporting deployments.)
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
- **Built-in agents shipped inline** (`src/registry/builtins/`). `claude-code`,
  `sapling`, and `pi` available without any `CANOPY_REPO_URL` configuration.
  Fresh warren installs work out of the box.
- **Pi built-in agent + multi-provider + cost reporting** (plan `pl-4374` /
  warren-39c1, 2026-05-12). Third coding-agent built-in (`pi`,
  `@earendil-works/pi-coding-agent`) shipped in seven phased steps: burrow
  piRuntime cross-repo contract (warren-0e06), parity-shape builtin
  (warren-d18e + acceptance scenario 16), `pi_skills` + `pi_prompts` canopy
  sections materialized into `.pi/skills/<name>/SKILL.md` + `.pi/prompts/<name>.md`
  via JSONL `{name, body}` envelopes (warren-846b), multi-provider surface —
  `AgentDefinition.frontmatter.provider/model` + `POST /runs` provider/model
  overrides + `NewRun.tsx` Inputs + burrow `envPassthrough` widening to
  `OPENAI_API_KEY`/`GEMINI_API_KEY`/`GOOGLE_API_KEY`/`PI_API_KEY`/`GROQ_API_KEY`/
  `MISTRAL_API_KEY`/`DEEPSEEK_API_KEY` (warren-f8c0), per-run cost tracking —
  migration 0006 (`runs.cost_usd` + `tokens_*`) + `RunsRepo.attachStats` +
  bridge `get_session_stats` delta consumer + RunDetail cost badge + Runs
  Cost column (warren-a7dc), UI rendering for pi event sub-kinds
  (`compaction_*`, `auto_retry_*`, `extension_error`, `queue_update`) in
  RunDetail (warren-70af), and SPEC §11.K + ROADMAP entry + mulch decisions
  (warren-f1da). Pi extensions deferred until canopy ships artifact types;
  MCP omission documented as worldview difference (pi has no MCP — R-15 stays
  scoped to claude-code/sapling); headless API-key-only auth posture (pi
  `/login` OAuth flow unsupported in V1 — reconsiderable in V2 if demanded).
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
- **Cron scheduler** (R-06, plan `pl-2f15`, 2026-05-11). In-process tick
  (60s default, `WARREN_SCHEDULER_TICK_MS`) inside `bootServer`'s lifecycle
  dispatches `.warren/triggers.yaml` entries as runs with `trigger='cron'`
  and seeds with `extensions.scheduledFor` in the past with
  `trigger='scheduled'`. New `src/triggers/` module + migration 0005
  (`triggers` table, composite-string PK). Cron parsing via `croner` for
  tz/DST support. `GET /projects/:id/triggers` returns parsed YAML joined
  with last/next-fire state; `POST /projects/:id/triggers/:triggerId/run`
  is the Run Now path. ProjectDetail UI renders last/next-fire columns +
  Run Now button. Acceptance scenario 15 covers cron round-trip,
  scheduled-for past+future, missing-seed skip. No catch-up after warren
  downtime — standard cron semantics; first observation of a fresh
  trigger seeds `lastFiredAt=now`. Webhook triggers (the V2 half of the
  scheduler) remain deferred.

## Cross-repo readiness (2026-05-11)

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
| Canopy `mcp_servers` frontmatter block | R-15 | ❌ not started | — |
| Canopy config schema CLI | R-10 | ❌ not started | — |
| Mulch `ml prime --format plain` / `--dry-run` | R-11 | ✅ shipped | mulch v0.8.0+ |
| Mulch config schema CLI | R-10 | ✅ shipped | mulch v0.9.0 |
| Sapling event stream (contextUtilization, score, commitments, compact, RPC) | R-07 | ✅ shipped | sapling v0.3.2 |
| Sapling `operationCount`/`archiveEntryCount` on `turn_end` | R-07 | ⚠️ via RPC `getState` only | sapling v0.3.2 |
| Sapling `--system-prompt-file` | R-07, R-11 | ✅ shipped | sapling v0.3.2 |
| Sapling config schema CLI | R-10 | ⚠️ partial (set ✅, schema ❌) | sapling v0.3.2 |
| Sapling MCP / custom tool registry | R-08, R-15 | ❌ not started | — |
| Burrow remote-worker protocol design | R-12 | 🟡 in design (`burrow-c47a`, 2026-05-11) | — |
| Burrow per-run credential mount (for MCP secrets) | R-15 | ❌ not filed yet | — |

Net: every cross-repo blocker for R-01, R-04, R-05, R-06, R-07, and R-11
is satisfied. R-10 can ship 2-of-4 tabs (mulch + seeds) today; canopy and
sapling tabs unlock as those tools add `<tool> config schema --json`. R-08's
MCP dependency for sapling-as-operator-harness is still out — claude-code
remains the operator harness for V2. The org-readiness cluster (R-12 – R-18)
has minimal cross-repo footprint: only R-12 (burrow worker protocol, in
design as `burrow-c47a`) and R-15 (canopy frontmatter + burrow secrets
mount) need sibling-repo work; the other six items are warren-internal.

## Suggested sequencing

A first cut at order of attack — not committed. Updated 2026-05-11 to layer
in the org-readiness cluster. The R-01 through R-11 ordering is unchanged;
R-09 is repromoted and R-12 through R-18 are slotted in.

**Wave 1 — team-of-ICs UX (warren-internal, no cross-repo blockers).**

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
5. **R-06** (cron scheduler) — ✅ shipped 2026-05-11 (plan `pl-2f15`). In-process
   tick + `triggers` table + HTTP surface + UI columns + Run Now + acceptance
   scenario 15. Webhook receiver half remains V2.
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

**Wave 2 — org-readiness cluster (SPEC §11.J, 2026-05-11).**

11. **R-12** (remote burrow workers) — top priority of the cluster.
    Blocked on `burrow-c47a` design output. Lifts the single-host
    concurrency ceiling that prevents real org adoption. Warren-side
    work (worker registry + dispatch routing) is parallelizable with the
    burrow-side protocol design.
12. **R-13** (bring-your-own database / Postgres) — independent of R-12;
    can land in parallel. Drizzle abstraction is already in place, so the
    main work is dialect-auditing the schema and shipping a migration
    tool. Highest-leverage org-readiness item per unit-of-work.
13. **R-09** (per-user identity / SSO) — repromoted from `[deferred]`.
    Independent of R-12 and R-13. Load-bearing for R-16 and R-17 — both
    need real user identity to attribute events and enforce per-user
    budgets. Do this before R-16 and R-17.
14. **R-15** (MCP support) — independent of R-09; can land in parallel
    with the identity work. Needs a burrow-side per-run credential mount
    (not yet filed). Static-token-only for V2; OAuth broker as a
    follow-up.
15. **R-14** (cross-project activity UI + OpenAPI) — depends on R-04
    (per-project UI) for the drill-down targets. Closes §11.C open
    question #1 on OpenAPI. Sequences after R-04 lands; can layer on
    top of any subset of R-12 / R-13 / R-09 / R-15.
16. **R-16** (audit log) — depends on R-09 for user identity. Shares
    the activity feed (R-14) as a presentation surface, so pairs
    naturally with R-14.
17. **R-17** (cost & concurrency guardrails) — depends on R-09 for
    per-user budgets. Can ship per-project budgets earlier without R-09
    if pressure dictates. Pre-dispatch enforcement is the integration
    point.
18. **R-18** (GitHub App) — independent of the rest of the cluster.
    Can ship any time once an org actually asks; PAT mode stays
    supported indefinitely as the home-server path.

**Wave 3 — perceived-realness (post-org-readiness, design-first).**

19. **R-19** (per-run preview environments) — explicitly needs a
    design pass before commit (SPEC §11.K + burrow inbound-networking
    seed). High UX leverage — collapses "diff + checkout-locally to
    verify" into "click the URL" — but the design surface spans burrow
    network policy, TLS/DNS, auth, lifecycle, and the R-12 remote-worker
    future. Sketch first; sequence after R-12's protocol stabilizes so
    cross-host routing isn't a retrofit.
