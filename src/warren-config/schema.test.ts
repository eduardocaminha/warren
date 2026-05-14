import { describe, expect, test } from "bun:test";
import {
	DefaultsConfigSchema,
	PreviewConfigSchema,
	parseDefaultsConfig,
	parseTriggersConfig,
	TriggersConfigSchema,
} from "./schema.ts";

const VALID_TRIGGER = {
	id: "nightly-refactor",
	kind: "cron",
	cron: "0 3 * * *",
	timezone: "UTC",
	seed: "seeds-abc1",
	role: "refactor-bot",
};

describe("TriggersConfigSchema", () => {
	test("accepts an array of cron triggers", () => {
		const parsed = TriggersConfigSchema.safeParse([VALID_TRIGGER]);
		expect(parsed.success).toBe(true);
	});

	test("accepts the optional 6-field cron form (seconds first)", () => {
		const parsed = TriggersConfigSchema.safeParse([{ ...VALID_TRIGGER, cron: "0 0 3 * * *" }]);
		expect(parsed.success).toBe(true);
	});

	test("rejects unknown kinds (preserves room for future webhook triggers)", () => {
		const parsed = TriggersConfigSchema.safeParse([{ ...VALID_TRIGGER, kind: "webhook" }]);
		expect(parsed.success).toBe(false);
	});

	test("rejects strict-extra fields so typos surface loudly", () => {
		const parsed = TriggersConfigSchema.safeParse([{ ...VALID_TRIGGER, oops: 1 }]);
		expect(parsed.success).toBe(false);
	});

	test("rejects malformed cron expressions", () => {
		const parsed = TriggersConfigSchema.safeParse([{ ...VALID_TRIGGER, cron: "every minute" }]);
		expect(parsed.success).toBe(false);
	});

	test("rejects duplicate trigger ids", () => {
		const parsed = TriggersConfigSchema.safeParse([VALID_TRIGGER, VALID_TRIGGER]);
		expect(parsed.success).toBe(false);
	});

	test("rejects ids that aren't kebab/snake-case", () => {
		const parsed = TriggersConfigSchema.safeParse([{ ...VALID_TRIGGER, id: "Nightly Job" }]);
		expect(parsed.success).toBe(false);
	});
});

describe("parseTriggersConfig", () => {
	test("treats null/undefined as an empty trigger list", () => {
		expect(parseTriggersConfig(null)).toEqual({ ok: true, value: [] });
		expect(parseTriggersConfig(undefined)).toEqual({ ok: true, value: [] });
	});

	test("returns ok=true with parsed entries on success", () => {
		const result = parseTriggersConfig([VALID_TRIGGER]);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toHaveLength(1);
			expect(result.value[0]?.id).toBe("nightly-refactor");
		}
	});

	test("returns ok=false with a joined message on failure (no throw)", () => {
		const result = parseTriggersConfig([{ ...VALID_TRIGGER, cron: "" }]);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toMatch(/cron/);
		}
	});
});

describe("DefaultsConfigSchema", () => {
	test("accepts the full shape", () => {
		const parsed = DefaultsConfigSchema.safeParse({
			defaultRole: "claude-code",
			defaultBranch: "main",
			defaultPrompt: "Read the issue, plan, execute.",
			defaultProvider: "anthropic",
			defaultModel: "claude-opus-4-7",
			runBranchPrefix: "warren",
		});
		expect(parsed.success).toBe(true);
	});

	test("accepts an empty object (operators may keep the file as documentation)", () => {
		const parsed = DefaultsConfigSchema.safeParse({});
		expect(parsed.success).toBe(true);
	});

	test("rejects extra fields so typos surface loudly", () => {
		const parsed = DefaultsConfigSchema.safeParse({ defaultRoll: "claude-code" });
		expect(parsed.success).toBe(false);
	});

	test("rejects empty-string overrides", () => {
		expect(DefaultsConfigSchema.safeParse({ defaultRole: "" }).success).toBe(false);
		expect(DefaultsConfigSchema.safeParse({ defaultBranch: "" }).success).toBe(false);
		expect(DefaultsConfigSchema.safeParse({ defaultPrompt: "" }).success).toBe(false);
		expect(DefaultsConfigSchema.safeParse({ defaultProvider: "" }).success).toBe(false);
		expect(DefaultsConfigSchema.safeParse({ defaultModel: "" }).success).toBe(false);
		expect(DefaultsConfigSchema.safeParse({ runBranchPrefix: "" }).success).toBe(false);
	});

	test("rejects role names that aren't canopy-shaped", () => {
		const parsed = DefaultsConfigSchema.safeParse({ defaultRole: "Refactor Bot" });
		expect(parsed.success).toBe(false);
	});

	test("rejects runBranchPrefix that contains slashes or other invalid chars (warren-9993)", () => {
		expect(DefaultsConfigSchema.safeParse({ runBranchPrefix: "bot/agent" }).success).toBe(false);
		expect(DefaultsConfigSchema.safeParse({ runBranchPrefix: "Warren" }).success).toBe(false);
		expect(DefaultsConfigSchema.safeParse({ runBranchPrefix: ".warren" }).success).toBe(false);
		expect(DefaultsConfigSchema.safeParse({ runBranchPrefix: "warren agent" }).success).toBe(false);
	});

	test("accepts kebab-case runBranchPrefix (warren-9993)", () => {
		expect(DefaultsConfigSchema.safeParse({ runBranchPrefix: "warren" }).success).toBe(true);
		expect(DefaultsConfigSchema.safeParse({ runBranchPrefix: "agent-1" }).success).toBe(true);
		expect(DefaultsConfigSchema.safeParse({ runBranchPrefix: "bot.fix" }).success).toBe(true);
	});
});

describe("parseDefaultsConfig", () => {
	test("treats null/undefined as an empty defaults block", () => {
		expect(parseDefaultsConfig(null)).toEqual({ ok: true, value: {} });
		expect(parseDefaultsConfig(undefined)).toEqual({ ok: true, value: {} });
	});

	test("returns ok=false on schema failure (no throw)", () => {
		const result = parseDefaultsConfig({ defaultBranch: 42 });
		expect(result.ok).toBe(false);
	});
});

// warren-7be9 / SPEC §11.L: per-run preview environments (R-19). The schema
// must accept a `type` discriminator from day one so the static-mode follow-up
// (filed under pl-2c59) doesn't break the config.
const VALID_SERVER_PREVIEW = {
	type: "server",
	command: "bun run dev",
	port: 3000,
	readiness_path: "/healthz",
	idle_ttl: "30m",
	max_lifetime: "8h",
};

describe("PreviewConfigSchema", () => {
	test("accepts the full server-type shape from SPEC §11.L", () => {
		const parsed = PreviewConfigSchema.safeParse(VALID_SERVER_PREVIEW);
		expect(parsed.success).toBe(true);
	});

	test("accepts the minimum server shape (command + port only)", () => {
		const parsed = PreviewConfigSchema.safeParse({
			type: "server",
			command: "bun run dev",
			port: 3000,
		});
		expect(parsed.success).toBe(true);
	});

	test("accepts type: 'static' at the parser level (launcher rejects later — warren-f156)", () => {
		const parsed = PreviewConfigSchema.safeParse({ type: "static" });
		expect(parsed.success).toBe(true);
	});

	test("rejects unknown type discriminators", () => {
		const parsed = PreviewConfigSchema.safeParse({
			type: "lambda",
			command: "bun run dev",
			port: 3000,
		});
		expect(parsed.success).toBe(false);
	});

	test("rejects missing command for type: server", () => {
		const parsed = PreviewConfigSchema.safeParse({ type: "server", port: 3000 });
		expect(parsed.success).toBe(false);
	});

	test("rejects missing port for type: server", () => {
		const parsed = PreviewConfigSchema.safeParse({ type: "server", command: "bun run dev" });
		expect(parsed.success).toBe(false);
	});

	test("rejects empty command", () => {
		const parsed = PreviewConfigSchema.safeParse({
			...VALID_SERVER_PREVIEW,
			command: "",
		});
		expect(parsed.success).toBe(false);
	});

	test("rejects non-integer / out-of-range ports", () => {
		expect(PreviewConfigSchema.safeParse({ ...VALID_SERVER_PREVIEW, port: 0 }).success).toBe(false);
		expect(PreviewConfigSchema.safeParse({ ...VALID_SERVER_PREVIEW, port: 70000 }).success).toBe(
			false,
		);
		expect(PreviewConfigSchema.safeParse({ ...VALID_SERVER_PREVIEW, port: 3.14 }).success).toBe(
			false,
		);
		expect(PreviewConfigSchema.safeParse({ ...VALID_SERVER_PREVIEW, port: "3000" }).success).toBe(
			false,
		);
	});

	test("accepts privileged ports (1-1023) — sandbox runs unprivileged-by-namespace", () => {
		const parsed = PreviewConfigSchema.safeParse({ ...VALID_SERVER_PREVIEW, port: 80 });
		expect(parsed.success).toBe(true);
	});

	test("rejects readiness_path that doesn't start with '/'", () => {
		const parsed = PreviewConfigSchema.safeParse({
			...VALID_SERVER_PREVIEW,
			readiness_path: "healthz",
		});
		expect(parsed.success).toBe(false);
	});

	test("accepts duration strings: 30m, 8h, 45s, 1d, 200ms, 1h30m", () => {
		for (const d of ["30m", "8h", "45s", "1d", "200ms", "1h30m"]) {
			const parsed = PreviewConfigSchema.safeParse({
				...VALID_SERVER_PREVIEW,
				idle_ttl: d,
				max_lifetime: d,
			});
			expect(parsed.success).toBe(true);
		}
	});

	test("rejects garbage duration strings", () => {
		for (const d of ["thirty minutes", "30", "m30", "30y", ""]) {
			const parsed = PreviewConfigSchema.safeParse({
				...VALID_SERVER_PREVIEW,
				idle_ttl: d,
			});
			expect(parsed.success).toBe(false);
		}
	});

	test("rejects strict-extra fields on server preview so typos surface loudly", () => {
		const parsed = PreviewConfigSchema.safeParse({
			...VALID_SERVER_PREVIEW,
			ttl: "30m", // common typo: design lock rejected single-TTL collapse
		});
		expect(parsed.success).toBe(false);
	});

	test("keeps idle_ttl and max_lifetime as separate fields (design lock — no single-ttl collapse)", () => {
		const parsed = PreviewConfigSchema.safeParse({
			type: "server",
			command: "bun run dev",
			port: 3000,
			idle_ttl: "30m",
			max_lifetime: "8h",
		});
		expect(parsed.success).toBe(true);
		if (parsed.success && parsed.data.type === "server") {
			expect(parsed.data.idle_ttl).toBe("30m");
			expect(parsed.data.max_lifetime).toBe("8h");
		}
	});
});

describe("DefaultsConfigSchema preview block", () => {
	test("accepts defaults with no preview block (opt-in, missing is not an error)", () => {
		const parsed = DefaultsConfigSchema.safeParse({ defaultRole: "claude-code" });
		expect(parsed.success).toBe(true);
	});

	test("accepts defaults with a valid preview block", () => {
		const parsed = DefaultsConfigSchema.safeParse({
			defaultRole: "claude-code",
			preview: VALID_SERVER_PREVIEW,
		});
		expect(parsed.success).toBe(true);
	});

	test("propagates preview parse failures up through DefaultsConfig (surfaces in errors envelope)", () => {
		const parsed = DefaultsConfigSchema.safeParse({
			preview: { type: "server", command: "bun run dev" /* missing port */ },
		});
		expect(parsed.success).toBe(false);
	});

	test("propagates preview parse failures via parseDefaultsConfig too (no throw)", () => {
		const result = parseDefaultsConfig({
			preview: { type: "server", command: "", port: 3000 },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toMatch(/preview/);
			expect(result.message).toMatch(/command/);
		}
	});
});
