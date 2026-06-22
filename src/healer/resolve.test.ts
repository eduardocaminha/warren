import { describe, expect, test } from "bun:test";
import type { HealAlert } from "./alert.ts";
import { type HealProjectCandidate, resolveHealProject } from "./resolve.ts";

function alert(over: Partial<HealAlert> = {}): HealAlert {
	return {
		fingerprint: "fp-1",
		title: "HighErrorRate",
		culprit: "src/runs/reap.ts",
		detail: null,
		links: [],
		source: "grafana",
		repo: null,
		...over,
	};
}

function candidate(over: Partial<HealProjectCandidate> = {}): HealProjectCandidate {
	return {
		projectId: "prj_1",
		gitUrl: "https://github.com/jayminwest/warren.git",
		localPath: "/data/projects/jayminwest/warren",
		settings: { enabled: true, maxRetries: 3, cooldownMinutes: 30 },
		role: "healer",
		projectMapping: [],
		...over,
	};
}

describe("resolveHealProject", () => {
	test("matches a static mapping key on the fingerprint", () => {
		const c = candidate({ projectMapping: ["fp-1"] });
		const result = resolveHealProject(alert(), [c]);
		expect(result).toEqual({ kind: "matched", candidate: c });
	});

	test("matches a static mapping key as a culprit substring (case-insensitive)", () => {
		const c = candidate({ projectMapping: ["RUNS/REAP"] });
		expect(resolveHealProject(alert(), [c]).kind).toBe("matched");
	});

	test("falls back to repo match against the project git URL", () => {
		const c = candidate({ projectMapping: [] });
		const result = resolveHealProject(alert({ repo: "jayminwest/warren" }), [c]);
		expect(result).toEqual({ kind: "matched", candidate: c });
	});

	test("mapping wins over repo fallback", () => {
		const mapped = candidate({ projectId: "prj_mapped", projectMapping: ["fp-1"] });
		const repoOnly = candidate({
			projectId: "prj_repo",
			projectMapping: [],
			gitUrl: "https://github.com/jayminwest/warren.git",
		});
		const result = resolveHealProject(alert({ repo: "jayminwest/warren" }), [repoOnly, mapped]);
		expect(result.kind).toBe("matched");
		if (result.kind === "matched") expect(result.candidate.projectId).toBe("prj_mapped");
	});

	test("reports no_match when nothing routes", () => {
		const c = candidate({ projectMapping: ["other"], gitUrl: "https://github.com/x/y.git" });
		expect(resolveHealProject(alert({ repo: null }), [c]).kind).toBe("no_match");
	});

	test("reports not_enabled when a match exists but the project is opted out", () => {
		const c = candidate({
			settings: { enabled: false, maxRetries: 3, cooldownMinutes: 30 },
			projectMapping: ["fp-1"],
		});
		expect(resolveHealProject(alert(), [c]).kind).toBe("not_enabled");
	});

	test("ignores disabled projects when an enabled one also matches", () => {
		const disabled = candidate({
			projectId: "prj_off",
			settings: { enabled: false, maxRetries: 3, cooldownMinutes: 30 },
			projectMapping: ["fp-1"],
		});
		const enabled = candidate({ projectId: "prj_on", projectMapping: ["fp-1"] });
		const result = resolveHealProject(alert(), [disabled, enabled]);
		expect(result.kind).toBe("matched");
		if (result.kind === "matched") expect(result.candidate.projectId).toBe("prj_on");
	});
});
