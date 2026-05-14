import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { WARREN_CONFIG_DIR, WARREN_CONFIG_FILES } from "./config.ts";
import { WARREN_CONFIG_FILE_ERROR_CODES, WarrenConfigUnavailableError } from "./errors.ts";
import { type ExistsFn, loadWarrenConfig, type ReadFileFn } from "./load.ts";

const PROJECT = "/data/projects/owner/repo";
const TRIGGERS_PATH = join(PROJECT, WARREN_CONFIG_DIR, WARREN_CONFIG_FILES.triggers);
const DEFAULTS_PATH = join(PROJECT, WARREN_CONFIG_DIR, WARREN_CONFIG_FILES.defaults);
const DIR_PATH = join(PROJECT, WARREN_CONFIG_DIR);

interface FsHarness {
	readonly exists: ExistsFn;
	readonly readFile: ReadFileFn;
}

function fs(files: Record<string, string>, opts?: { withDir?: boolean }): FsHarness {
	const withDir = opts?.withDir ?? Object.keys(files).length > 0;
	const present = new Set<string>([PROJECT, ...Object.keys(files)]);
	if (withDir) present.add(DIR_PATH);
	return {
		exists: (path) => present.has(path),
		readFile: async (path) => {
			const value = files[path];
			if (value === undefined) {
				throw new Error(`unexpected read: ${path}`);
			}
			return value;
		},
	};
}

describe("loadWarrenConfig", () => {
	test("project clone missing on disk → throws WarrenConfigUnavailableError", async () => {
		await expect(
			loadWarrenConfig({
				projectPath: PROJECT,
				exists: () => false,
				readFile: async () => "",
			}),
		).rejects.toBeInstanceOf(WarrenConfigUnavailableError);
	});

	test("no .warren/ directory → both fields null, no errors (bootstrap shape)", async () => {
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({}),
		});
		expect(result.triggers).toBeNull();
		expect(result.defaults).toBeNull();
		expect(result.errors).toEqual([]);
	});

	test("missing triggers.yaml + missing defaults.json (but dir present) → both null, no errors", async () => {
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({}, { withDir: true }),
		});
		expect(result.triggers).toBeNull();
		expect(result.defaults).toBeNull();
		expect(result.errors).toEqual([]);
	});

	test("valid triggers.yaml + valid defaults.json → both parsed, no errors", async () => {
		const triggers = `
- id: nightly-refactor
  kind: cron
  cron: "0 3 * * *"
  timezone: UTC
  seed: seeds-abc1
  role: refactor-bot
`;
		const defaults = JSON.stringify({
			defaultRole: "claude-code",
			defaultBranch: "main",
			defaultPrompt: "Read the issue, plan, execute.",
		});
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({ [TRIGGERS_PATH]: triggers, [DEFAULTS_PATH]: defaults }),
		});
		expect(result.errors).toEqual([]);
		expect(result.triggers).toHaveLength(1);
		expect(result.triggers?.[0]?.id).toBe("nightly-refactor");
		expect(result.defaults?.defaultRole).toBe("claude-code");
		expect(result.defaults?.defaultBranch).toBe("main");
	});

	test("malformed YAML in triggers → triggers null, parseError entry, defaults still loads", async () => {
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({
				[TRIGGERS_PATH]: ":\n  - not: [valid: yaml",
				[DEFAULTS_PATH]: JSON.stringify({ defaultBranch: "main" }),
			}),
		});
		expect(result.triggers).toBeNull();
		expect(result.defaults?.defaultBranch).toBe("main");
		expect(result.errors).toHaveLength(1);
		const entry = result.errors[0];
		expect(entry?.file).toBe(`${WARREN_CONFIG_DIR}/${WARREN_CONFIG_FILES.triggers}`);
		expect(entry?.code).toBe(WARREN_CONFIG_FILE_ERROR_CODES.parseError);
	});

	test("schema-invalid triggers → triggers null, schemaError entry", async () => {
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({
				[TRIGGERS_PATH]: '- id: bad\n  kind: cron\n  cron: ""\n  seed: s\n  role: r\n',
			}),
		});
		expect(result.triggers).toBeNull();
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.code).toBe(WARREN_CONFIG_FILE_ERROR_CODES.schemaError);
	});

	test("malformed JSON in defaults → defaults null, parseError entry, triggers still loads", async () => {
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({
				[TRIGGERS_PATH]: "[]",
				[DEFAULTS_PATH]: "{ not valid json",
			}),
		});
		expect(result.triggers).toEqual([]);
		expect(result.defaults).toBeNull();
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.code).toBe(WARREN_CONFIG_FILE_ERROR_CODES.parseError);
		expect(result.errors[0]?.file).toBe(`${WARREN_CONFIG_DIR}/${WARREN_CONFIG_FILES.defaults}`);
	});

	test("schema-invalid defaults → defaults null, schemaError entry", async () => {
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({
				[DEFAULTS_PATH]: JSON.stringify({ defaultRole: "" }),
			}),
		});
		expect(result.defaults).toBeNull();
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.code).toBe(WARREN_CONFIG_FILE_ERROR_CODES.schemaError);
	});

	test("both files malformed → two error entries, both fields null", async () => {
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({
				[TRIGGERS_PATH]: "- id: bad\n  kind: cron\n  cron: nope nope\n  seed: s\n  role: r\n",
				[DEFAULTS_PATH]: JSON.stringify({ defaultBranch: 42 }),
			}),
		});
		expect(result.triggers).toBeNull();
		expect(result.defaults).toBeNull();
		expect(result.errors).toHaveLength(2);
	});

	test("empty triggers file (yaml.load returns undefined) → empty array, no error", async () => {
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({ [TRIGGERS_PATH]: "" }),
		});
		expect(result.triggers).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	test("empty defaults file → empty defaults object, no error", async () => {
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({ [DEFAULTS_PATH]: "" }),
		});
		expect(result.defaults).toEqual({});
		expect(result.errors).toEqual([]);
	});

	// warren-7be9 / SPEC §11.L: malformed preview block surfaces in the per-file
	// errors envelope (mx-66d478) — same pattern as any other `.warren/` field.
	test("malformed preview block in defaults.json → defaults null, schemaError entry", async () => {
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({
				[DEFAULTS_PATH]: JSON.stringify({
					preview: { type: "server", command: "bun run dev" /* missing port */ },
				}),
			}),
		});
		expect(result.defaults).toBeNull();
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.code).toBe(WARREN_CONFIG_FILE_ERROR_CODES.schemaError);
		expect(result.errors[0]?.file).toBe(`${WARREN_CONFIG_DIR}/${WARREN_CONFIG_FILES.defaults}`);
		expect(result.errors[0]?.message).toMatch(/preview/);
	});

	test("valid preview block in defaults.json → parsed through to LoadedWarrenConfig", async () => {
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			...fs({
				[DEFAULTS_PATH]: JSON.stringify({
					preview: {
						type: "server",
						command: "bun run dev",
						port: 3000,
						readiness_path: "/healthz",
						idle_ttl: "30m",
						max_lifetime: "8h",
					},
				}),
			}),
		});
		expect(result.errors).toEqual([]);
		expect(result.defaults?.preview).toBeDefined();
		if (result.defaults?.preview && result.defaults.preview.type === "server") {
			expect(result.defaults.preview.command).toBe("bun run dev");
			expect(result.defaults.preview.port).toBe(3000);
			expect(result.defaults.preview.idle_ttl).toBe("30m");
		}
	});

	test("readFile throws (e.g. EACCES) → recorded as parseError, no throw", async () => {
		const present = new Set<string>([PROJECT, DIR_PATH, TRIGGERS_PATH]);
		const result = await loadWarrenConfig({
			projectPath: PROJECT,
			exists: (path) => present.has(path),
			readFile: async () => {
				throw new Error("EACCES: permission denied");
			},
		});
		expect(result.triggers).toBeNull();
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.code).toBe(WARREN_CONFIG_FILE_ERROR_CODES.parseError);
		expect(result.errors[0]?.message).toMatch(/EACCES/);
	});
});
