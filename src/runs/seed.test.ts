import { describe, expect, test } from "bun:test";
import type { AgentDefinition } from "../registry/schema.ts";
import { RunSpawnError } from "./errors.ts";
import { type SeedFs, seedBurrowWorkspace } from "./seed.ts";

interface FsRecorder {
	readonly fs: SeedFs;
	readonly mkdirCalls: string[];
	readonly writes: Map<string, string>;
	readonly appends: Map<string, string>;
}

function recorder(): FsRecorder {
	const mkdirCalls: string[] = [];
	const writes = new Map<string, string>();
	const appends = new Map<string, string>();
	const fs: SeedFs = {
		mkdirp: async (path) => {
			mkdirCalls.push(path);
		},
		writeFile: async (path, contents) => {
			writes.set(path, contents);
		},
		appendFile: async (path, contents) => {
			appends.set(path, (appends.get(path) ?? "") + contents);
		},
	};
	return { fs, mkdirCalls, writes, appends };
}

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		name: "refactor-bot",
		version: 3,
		sections: { system: "be a refactor agent", ...(overrides.sections ?? {}) },
		resolvedFrom: ["base-coding-agent"],
		frontmatter: {},
		...overrides,
	};
}

describe("seedBurrowWorkspace", () => {
	test("writes the rendered agent envelope to .canopy/agent.json", async () => {
		const { fs, mkdirCalls, writes } = recorder();
		const result = await seedBurrowWorkspace({
			workspacePath: "/data/burrow/ws",
			agent: makeAgent(),
			fs,
		});

		expect(result.canopyPath).toBe("/data/burrow/ws/.canopy/agent.json");
		expect(mkdirCalls).toContain("/data/burrow/ws/.canopy");
		const written = writes.get("/data/burrow/ws/.canopy/agent.json");
		expect(written).toBeDefined();
		const parsed = JSON.parse(written ?? "");
		expect(parsed.name).toBe("refactor-bot");
		expect(parsed.sections.system).toBe("be a refactor agent");
	});

	test("groups expertise_seed by domain into .mulch/expertise/<domain>.jsonl", async () => {
		const { fs, appends, mkdirCalls } = recorder();
		const seed = [
			'{"type":"convention","domain":"refactor","content":"a"}',
			'{"type":"failure","domain":"refactor","description":"x","resolution":"y"}',
			'{"type":"convention","domain":"build","content":"b"}',
			"",
			"   ",
		].join("\n");
		const result = await seedBurrowWorkspace({
			workspacePath: "/ws",
			agent: makeAgent({ sections: { system: "s", expertise_seed: seed } }),
			fs,
		});

		expect(result.mulchDomains).toEqual(["build", "refactor"]);
		expect(mkdirCalls).toContain("/ws/.mulch/expertise");
		expect(appends.get("/ws/.mulch/expertise/refactor.jsonl")).toBe(
			`${[
				'{"type":"convention","domain":"refactor","content":"a"}',
				'{"type":"failure","domain":"refactor","description":"x","resolution":"y"}',
			].join("\n")}\n`,
		);
		expect(appends.get("/ws/.mulch/expertise/build.jsonl")).toBe(
			'{"type":"convention","domain":"build","content":"b"}\n',
		);
	});

	test("rejects malformed expertise_seed lines with RunSpawnError", async () => {
		const { fs } = recorder();
		await expect(
			seedBurrowWorkspace({
				workspacePath: "/ws",
				agent: makeAgent({ sections: { system: "s", expertise_seed: "not json" } }),
				fs,
			}),
		).rejects.toBeInstanceOf(RunSpawnError);
	});

	test("rejects expertise_seed lines without a non-empty domain", async () => {
		const { fs } = recorder();
		await expect(
			seedBurrowWorkspace({
				workspacePath: "/ws",
				agent: makeAgent({ sections: { system: "s", expertise_seed: '{"type":"x"}' } }),
				fs,
			}),
		).rejects.toBeInstanceOf(RunSpawnError);
	});

	test("writes the workflow body verbatim into .seeds/workflow.txt", async () => {
		const { fs, writes, mkdirCalls } = recorder();
		const wf = "template: refactor";
		const result = await seedBurrowWorkspace({
			workspacePath: "/ws",
			agent: makeAgent({ sections: { system: "s", workflow: wf } }),
			fs,
		});

		expect(result.workflowPath).toBe("/ws/.seeds/workflow.txt");
		expect(mkdirCalls).toContain("/ws/.seeds");
		expect(writes.get("/ws/.seeds/workflow.txt")).toBe("template: refactor\n");
	});

	test("returns null workflowPath and empty mulchDomains when those sections are absent", async () => {
		const { fs } = recorder();
		const result = await seedBurrowWorkspace({
			workspacePath: "/ws",
			agent: makeAgent(),
			fs,
		});
		expect(result.workflowPath).toBeNull();
		expect(result.mulchDomains).toEqual([]);
		expect(result.piSkills).toEqual([]);
		expect(result.piPrompts).toEqual([]);
	});

	test("writes pi_skills JSONL lines to .pi/skills/<name>/SKILL.md", async () => {
		const { fs, writes, mkdirCalls } = recorder();
		const section = [
			JSON.stringify({ name: "refactor", body: "# Refactor\nguidance here" }),
			JSON.stringify({ name: "review", body: "# Review\nchecklist" }),
		].join("\n");
		const result = await seedBurrowWorkspace({
			workspacePath: "/ws",
			agent: makeAgent({ sections: { system: "s", pi_skills: section } }),
			fs,
		});

		expect(result.piSkills).toEqual(["refactor", "review"]);
		expect(mkdirCalls).toContain("/ws/.pi/skills");
		expect(mkdirCalls).toContain("/ws/.pi/skills/refactor");
		expect(mkdirCalls).toContain("/ws/.pi/skills/review");
		expect(writes.get("/ws/.pi/skills/refactor/SKILL.md")).toBe("# Refactor\nguidance here\n");
		expect(writes.get("/ws/.pi/skills/review/SKILL.md")).toBe("# Review\nchecklist\n");
	});

	test("preserves a body that already ends with a newline (pi_skills)", async () => {
		const { fs, writes } = recorder();
		const section = JSON.stringify({ name: "x", body: "body\n" });
		await seedBurrowWorkspace({
			workspacePath: "/ws",
			agent: makeAgent({ sections: { system: "s", pi_skills: section } }),
			fs,
		});
		expect(writes.get("/ws/.pi/skills/x/SKILL.md")).toBe("body\n");
	});

	test("writes pi_prompts JSONL lines to .pi/prompts/<name>.md", async () => {
		const { fs, writes, mkdirCalls } = recorder();
		const section = [
			JSON.stringify({ name: "summary", body: "Summarize the diff." }),
			JSON.stringify({ name: "deep-dive", body: "Investigate root cause." }),
		].join("\n");
		const result = await seedBurrowWorkspace({
			workspacePath: "/ws",
			agent: makeAgent({ sections: { system: "s", pi_prompts: section } }),
			fs,
		});

		expect(result.piPrompts).toEqual(["deep-dive", "summary"]);
		expect(mkdirCalls).toContain("/ws/.pi/prompts");
		expect(writes.get("/ws/.pi/prompts/summary.md")).toBe("Summarize the diff.\n");
		expect(writes.get("/ws/.pi/prompts/deep-dive.md")).toBe("Investigate root cause.\n");
	});

	test("rejects malformed pi_skills lines with RunSpawnError", async () => {
		const { fs } = recorder();
		await expect(
			seedBurrowWorkspace({
				workspacePath: "/ws",
				agent: makeAgent({ sections: { system: "s", pi_skills: "not json" } }),
				fs,
			}),
		).rejects.toBeInstanceOf(RunSpawnError);
	});

	test("rejects pi_skills lines without a non-empty name", async () => {
		const { fs } = recorder();
		await expect(
			seedBurrowWorkspace({
				workspacePath: "/ws",
				agent: makeAgent({
					sections: { system: "s", pi_skills: JSON.stringify({ body: "x" }) },
				}),
				fs,
			}),
		).rejects.toBeInstanceOf(RunSpawnError);
	});

	test("rejects pi_skills lines without a string body", async () => {
		const { fs } = recorder();
		await expect(
			seedBurrowWorkspace({
				workspacePath: "/ws",
				agent: makeAgent({
					sections: { system: "s", pi_skills: JSON.stringify({ name: "x" }) },
				}),
				fs,
			}),
		).rejects.toBeInstanceOf(RunSpawnError);
	});

	test("rejects pi_skills names containing path separators or traversal", async () => {
		const { fs } = recorder();
		await expect(
			seedBurrowWorkspace({
				workspacePath: "/ws",
				agent: makeAgent({
					sections: {
						system: "s",
						pi_skills: JSON.stringify({ name: "../escape", body: "x" }),
					},
				}),
				fs,
			}),
		).rejects.toBeInstanceOf(RunSpawnError);
	});

	test("rejects duplicate pi_skills names", async () => {
		const { fs } = recorder();
		const dup = [
			JSON.stringify({ name: "x", body: "a" }),
			JSON.stringify({ name: "x", body: "b" }),
		].join("\n");
		await expect(
			seedBurrowWorkspace({
				workspacePath: "/ws",
				agent: makeAgent({ sections: { system: "s", pi_skills: dup } }),
				fs,
			}),
		).rejects.toBeInstanceOf(RunSpawnError);
	});

	test("rejects malformed pi_prompts lines with RunSpawnError", async () => {
		const { fs } = recorder();
		await expect(
			seedBurrowWorkspace({
				workspacePath: "/ws",
				agent: makeAgent({
					sections: {
						system: "s",
						pi_prompts: `${JSON.stringify({ name: "good", body: "ok" })}\n}{garbage`,
					},
				}),
				fs,
			}),
		).rejects.toBeInstanceOf(RunSpawnError);
	});
});
