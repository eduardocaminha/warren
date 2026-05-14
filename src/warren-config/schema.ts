/**
 * Zod schemas for the per-project `.warren/` config files (R-02).
 *
 * Two files matter in this seed:
 *   triggers.yaml   array of trigger entries (YAML for cron readability)
 *   defaults.json   per-project defaults (JSON for symmetry)
 *
 * Triggers carry a `kind: 'cron'` discriminator even though only cron is
 * implemented today. Per pl-5d74 risk #1, this leaves room for future
 * webhook-style triggers (R-06+) to be added as another `kind:` without a
 * breaking schema rev.
 *
 * Triggers are parsed and exposed by this module but NOT dispatched here —
 * R-06 (cron scheduler) is the consumer. Defaults are parsed; the NewRun
 * UI consumes `defaultRole` (warren-fd14) by auto-filling its agent picker
 * and `defaultPrompt` (warren-af38) by pre-filling its prompt textarea
 * when the project declares one. `defaultProvider` / `defaultModel`
 * (warren-618b) are folded into the agent's frontmatter at spawn time, in
 * the same precedence slot as per-run overrides — operator override >
 * project default > agent frontmatter. `runBranchPrefix` (warren-9993)
 * overrides the prefix warren uses when composing the burrow branch as
 * `${prefix}/${run.id}`; precedence is project default >
 * WARREN_RUN_BRANCH_PREFIX env > built-in "burrow". CLI `warren run`
 * consumption of `defaultRole`, scheduled-run prompt fallback for
 * `defaultPrompt`, and any template substitution are deferred to R-04 / R-06.
 *
 * `parseTriggersConfig` and `parseDefaultsConfig` return discriminated
 * results — the loader collects `{ ok: false }` shapes into the per-file
 * errors envelope so a malformed sibling never throws.
 */

import { z } from "zod";

const TriggerIdSchema = z
	.string()
	.min(1, "id must be non-empty")
	.regex(
		/^[a-z0-9][a-z0-9._-]*$/,
		"id must be kebab/snake-case (lowercase, digits, dots, dashes, underscores)",
	);

const SeedRefSchema = z.string().min(1, "seed must be non-empty");

const RoleNameSchema = z
	.string()
	.min(1, "role must be non-empty")
	.regex(
		/^[a-z0-9][a-z0-9._-]*$/,
		"role must be a canopy agent name (lowercase, digits, dots, dashes, underscores)",
	);

// warren-9993: the branch warren passes to `burrows.up` is `<prefix>/<run.id>`,
// where the run id is the warren `run_xxxxxxxxxxxx` so the branch traces back
// to the warren run on `git log` / PR review. Same kebab/snake-case grammar
// as RoleNameSchema; slashes inside the prefix are disallowed so the
// `<prefix>/<id>` shape stays a single ref segment under the prefix.
const RunBranchPrefixSchema = z
	.string()
	.min(1, "runBranchPrefix must be non-empty")
	.regex(
		/^[a-z0-9][a-z0-9._-]*$/,
		"runBranchPrefix must be kebab/snake-case (lowercase, digits, dots, dashes, underscores)",
	);

const CronExpressionSchema = z
	.string()
	.min(1, "cron must be non-empty")
	// Loose parse: warren validates the structural shape (5 or 6 whitespace-
	// separated tokens). R-06 owns full cron validation when it wires up the
	// scheduler — duplicating croner's grammar here would lock the version.
	.refine(
		(value) => {
			const tokens = value.trim().split(/\s+/);
			return tokens.length === 5 || tokens.length === 6;
		},
		{ message: "cron must have 5 or 6 whitespace-separated fields" },
	);

const TimezoneSchema = z.string().min(1, "timezone must be non-empty if provided");

const PromptSchema = z.string().min(1, "prompt must be non-empty if provided");

// warren-7be9 / SPEC §11.L: idle_ttl and max_lifetime are both string-duration
// fields (e.g. "30m", "8h", "1h30m"). The launcher / eviction worker parses
// these into milliseconds; the schema only validates shape so malformed input
// surfaces in the per-file errors envelope before reap-time. Compound forms
// like "1h30m" are accepted so operators don't have to pre-do the math.
const DurationStringSchema = z
	.string()
	.min(1, "duration must be non-empty if provided")
	.regex(
		/^(\d+(ms|s|m|h|d))+$/,
		'duration must be one or more <number><unit> pairs (units: ms, s, m, h, d) — e.g. "30m", "8h", "1h30m"',
	);

const PreviewCommandSchema = z.string().min(1, "preview.command must be non-empty");

// TCP port the preview server binds to inside the sandbox. Privileged ports
// (1-1023) are accepted because the sandbox runs unprivileged-by-namespace —
// rejecting them here would surprise operators whose dev server binds 80/443.
const PreviewPortSchema = z
	.number()
	.int("preview.port must be an integer")
	.min(1, "preview.port must be between 1 and 65535")
	.max(65535, "preview.port must be between 1 and 65535");

const PreviewReadinessPathSchema = z
	.string()
	.min(1, "preview.readiness_path must be non-empty if provided")
	.regex(/^\//, "preview.readiness_path must start with '/'");

// warren-7be9 / SPEC §11.L: the schema carries a `type` discriminator from
// day one so V2 can add `type: 'static'` (build step + dir to serve) without
// breaking the config. V1 implements only `type: 'server'`. `type: 'static'`
// is accepted by the parser but rejected at launch time by the reap-step
// launcher (warren-f156) with an error that names the follow-up seed.
const ServerPreviewConfigSchema = z
	.object({
		type: z.literal("server"),
		command: PreviewCommandSchema,
		port: PreviewPortSchema,
		readiness_path: PreviewReadinessPathSchema.optional(),
		idle_ttl: DurationStringSchema.optional(),
		max_lifetime: DurationStringSchema.optional(),
	})
	.strict();

// Static preview shape is intentionally permissive at the schema layer — the
// follow-up seed under pl-2c59 will lock its fields. We pin only the `type`
// discriminator so the launcher can recognize and reject it with a
// "not yet implemented" message that names that seed.
const StaticPreviewConfigSchema = z
	.object({
		type: z.literal("static"),
	})
	.passthrough();

export const PreviewConfigSchema = z.discriminatedUnion("type", [
	ServerPreviewConfigSchema,
	StaticPreviewConfigSchema,
]);

export type ServerPreviewConfig = z.infer<typeof ServerPreviewConfigSchema>;
export type StaticPreviewConfig = z.infer<typeof StaticPreviewConfigSchema>;
export type PreviewConfig = z.infer<typeof PreviewConfigSchema>;

const CronTriggerSchema = z
	.object({
		id: TriggerIdSchema,
		kind: z.literal("cron"),
		cron: CronExpressionSchema,
		seed: SeedRefSchema,
		role: RoleNameSchema,
		timezone: TimezoneSchema.optional(),
		prompt: PromptSchema.optional(),
	})
	.strict();

export const TriggerSchema = z.discriminatedUnion("kind", [CronTriggerSchema]);

export const TriggersConfigSchema = z.array(TriggerSchema).superRefine((list, ctx) => {
	const seen = new Set<string>();
	list.forEach((entry, index) => {
		if (seen.has(entry.id)) {
			ctx.addIssue({
				code: "custom",
				path: [index, "id"],
				message: `duplicate trigger id "${entry.id}"`,
			});
		}
		seen.add(entry.id);
	});
});

export type CronTrigger = z.infer<typeof CronTriggerSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;
export type TriggersConfig = z.infer<typeof TriggersConfigSchema>;

export const DefaultsConfigSchema = z
	.object({
		defaultRole: RoleNameSchema.optional(),
		defaultBranch: z.string().min(1, "defaultBranch must be non-empty if provided").optional(),
		defaultPrompt: PromptSchema.optional(),
		// warren-618b: free-text provider/model defaults applied at spawn time
		// the same way per-run overrides are (operator override > project
		// default > agent frontmatter). Runtimes that don't honor frontmatter
		// .provider/.model just ignore them — same shape as the per-run override.
		defaultProvider: z.string().min(1, "defaultProvider must be non-empty if provided").optional(),
		defaultModel: z.string().min(1, "defaultModel must be non-empty if provided").optional(),
		// warren-9993: per-project override of the run branch prefix. spawnRun
		// composes the branch as `${runBranchPrefix}/${run.id}` and passes it
		// to burrows.up. Precedence project default > WARREN_RUN_BRANCH_PREFIX
		// env > built-in "burrow" (kept as the default for backward compat).
		runBranchPrefix: RunBranchPrefixSchema.optional(),
		// warren-7be9 / SPEC §11.L: per-run preview environments (R-19).
		// Missing-block is not an error — projects without a `preview` field
		// simply skip the reap-time preview launch sub-step. File location
		// stays `.warren/defaults.json` for V1; the broader `.warren/` YAML
		// reorg lives in a follow-up seed under pl-2c59.
		preview: PreviewConfigSchema.optional(),
	})
	.strict();

export type DefaultsConfig = z.infer<typeof DefaultsConfigSchema>;

export type ParseResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly message: string };

export function parseTriggersConfig(raw: unknown): ParseResult<TriggersConfig> {
	// Empty file (yaml.load returns undefined) is the same as "no triggers"
	// — operators should be able to scaffold the file without forcing an
	// explicit empty list literal.
	if (raw === undefined || raw === null) {
		return { ok: true, value: [] };
	}
	const parsed = TriggersConfigSchema.safeParse(raw);
	if (parsed.success) {
		return { ok: true, value: parsed.data };
	}
	return { ok: false, message: parsed.error.issues.map(formatZodIssue).join("; ") };
}

export function parseDefaultsConfig(raw: unknown): ParseResult<DefaultsConfig> {
	// Empty file (`{}` or undefined) is valid — operators may keep the file
	// around as documentation even when no overrides are set.
	if (raw === undefined || raw === null) {
		return { ok: true, value: {} };
	}
	const parsed = DefaultsConfigSchema.safeParse(raw);
	if (parsed.success) {
		return { ok: true, value: parsed.data };
	}
	return { ok: false, message: parsed.error.issues.map(formatZodIssue).join("; ") };
}

function formatZodIssue(issue: z.core.$ZodIssue): string {
	const path = issue.path.length === 0 ? "<root>" : issue.path.join(".");
	return `${path}: ${issue.message}`;
}
