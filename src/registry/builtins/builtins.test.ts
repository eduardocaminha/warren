import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { AgentsRepo } from "../../db/repos/agents.ts";
import { parseRenderedAgent, type RenderResponse } from "../schema.ts";
import {
	BUILTIN_AGENT_NAMES,
	BUILTIN_AGENTS,
	CLAUDE_CODE_BUILTIN,
	PI_BUILTIN,
	readAgentSource,
	SAPLING_BUILTIN,
	seedBuiltinAgents,
} from "./index.ts";

describe("BUILTIN_AGENTS", () => {
	test("includes claude-code, sapling, and pi", () => {
		expect(BUILTIN_AGENT_NAMES.has("claude-code")).toBe(true);
		expect(BUILTIN_AGENT_NAMES.has("sapling")).toBe(true);
		expect(BUILTIN_AGENT_NAMES.has("pi")).toBe(true);
	});

	test("each builtin has a non-empty system section (warren's required schema field)", () => {
		for (const builtin of BUILTIN_AGENTS) {
			expect(builtin.sections.system?.length ?? 0).toBeGreaterThan(0);
		}
	});

	test("each builtin round-trips through parseRenderedAgent (the canopy schema)", () => {
		for (const builtin of BUILTIN_AGENTS) {
			const renderResponse: RenderResponse = {
				success: true,
				command: "render",
				name: builtin.name,
				version: builtin.version,
				sections: Object.entries(builtin.sections).map(([name, body]) => ({ name, body })),
				resolvedFrom: [...builtin.resolvedFrom],
				frontmatter: { ...builtin.frontmatter },
			};
			const parsed = parseRenderedAgent(renderResponse, builtin.name);
			expect(parsed.name).toBe(builtin.name);
			expect(parsed.sections.system).toBe(builtin.sections.system);
		}
	});

	test("each builtin's frontmatter declares source = 'builtin' for provenance", () => {
		for (const builtin of BUILTIN_AGENTS) {
			expect(builtin.frontmatter.source).toBe("builtin");
		}
	});
});

describe("readAgentSource", () => {
	test("returns 'builtin' when frontmatter.source === 'builtin'", () => {
		expect(readAgentSource(CLAUDE_CODE_BUILTIN)).toBe("builtin");
		expect(readAgentSource(SAPLING_BUILTIN)).toBe("builtin");
		expect(readAgentSource(PI_BUILTIN)).toBe("builtin");
	});

	test("returns 'library' for arbitrary library-shaped renderedJson", () => {
		expect(readAgentSource({ name: "foo", sections: { system: "..." }, frontmatter: {} })).toBe(
			"library",
		);
		// Canopy doesn't set frontmatter.source, so unset frontmatter falls back to library.
		expect(readAgentSource({ name: "foo" })).toBe("library");
	});

	test("returns 'library' for malformed renderedJson", () => {
		expect(readAgentSource(null)).toBe("library");
		expect(readAgentSource("not-an-object")).toBe("library");
		expect(readAgentSource(42)).toBe("library");
	});
});

describe("seedBuiltinAgents", () => {
	let db: WarrenDb;
	let repo: AgentsRepo;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repo = new AgentsRepo(db.drizzle);
	});

	afterEach(() => {
		db.close();
	});

	test("inserts every builtin into an empty registry", () => {
		const now = () => new Date("2026-05-10T00:00:00.000Z");
		const result = seedBuiltinAgents(repo, undefined, now);
		expect([...result.seeded].sort()).toEqual([...BUILTIN_AGENT_NAMES].sort());
		expect(result.skipped).toEqual([]);
		const stored = repo.get("claude-code");
		expect(stored).not.toBeNull();
		expect(readAgentSource(stored?.renderedJson)).toBe("builtin");
	});

	test("preserves existing rows (library override) and skips them", () => {
		// Simulate a prior refresh having installed a canopy 'claude-code' override.
		repo.upsert({
			name: "claude-code",
			renderedJson: { name: "claude-code", sections: { system: "library override" } },
		});
		const result = seedBuiltinAgents(repo);
		expect(result.skipped).toContain("claude-code");
		// Library override is preserved; not overwritten by the builtin.
		const stored = repo.get("claude-code");
		expect(stored).not.toBeNull();
		expect(readAgentSource(stored?.renderedJson)).toBe("library");
	});

	test("is idempotent — second call seeds nothing", () => {
		seedBuiltinAgents(repo);
		const second = seedBuiltinAgents(repo);
		expect(second.seeded).toEqual([]);
		expect([...second.skipped].sort()).toEqual([...BUILTIN_AGENT_NAMES].sort());
	});
});
