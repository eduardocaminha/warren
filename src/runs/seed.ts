/**
 * Seed a burrow workspace with the agent's canopy/mulch/seeds inputs
 * (SPEC §4.3 step 3, §11.A).
 *
 * Five drops, all written directly into the burrow workspace path
 * (warren and burrow share the container filesystem, so direct writes
 * are the "or equivalent" of `burrow exec` from §11.A):
 *
 *   `.canopy/agent.json` — the rendered AgentDefinition. The harness
 *      (claude-code or sapling) reads whichever sections it needs;
 *      packaging the whole envelope avoids prematurely freezing a
 *      per-section file layout before harness expectations stabilize.
 *
 *   `.mulch/expertise/<domain>.jsonl` — one append per `expertise_seed`
 *      line, grouped by the line's `domain` field. Format is canonical
 *      mulch record JSONL; bad lines (non-JSON, missing `domain`) abort
 *      seeding so the operator sees the schema break before the run
 *      starts. Idempotent within a fresh per-run workspace.
 *
 *   `.seeds/workflow.txt` — the workflow body verbatim. Seeds tooling
 *      consumes it; warren is just the courier.
 *
 *   `.pi/skills/<name>/SKILL.md` — one file per `pi_skills` JSONL line
 *      `{name, body}`. Pi reads SKILL.md from each skill directory; the
 *      canopy section is one envelope-per-line so a single canopy
 *      section can ship many skills without inventing a new artifact
 *      type. Bad lines (non-JSON, missing/invalid `name` or `body`)
 *      abort seeding with the same RunSpawnError shape as expertise_seed.
 *
 *   `.pi/prompts/<name>.md` — same JSONL `{name, body}` shape as
 *      pi_skills but flat (one .md per prompt, no per-prompt
 *      directory).
 *
 * Mkdir + writeFile are injectable so unit tests don't touch disk. The
 * default impls call `fs/promises` directly with `recursive: true` and
 * append-mode writes for the JSONL files.
 */

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentDefinition } from "../registry/schema.ts";
import { RunSpawnError } from "./errors.ts";

export interface SeedFs {
	readonly mkdirp: (path: string) => Promise<void>;
	readonly writeFile: (path: string, contents: string) => Promise<void>;
	readonly appendFile: (path: string, contents: string) => Promise<void>;
}

export interface SeedBurrowWorkspaceInput {
	readonly workspacePath: string;
	readonly agent: AgentDefinition;
	readonly fs?: SeedFs;
}

export interface SeedBurrowWorkspaceResult {
	readonly canopyPath: string;
	readonly mulchDomains: readonly string[];
	readonly workflowPath: string | null;
	readonly piSkills: readonly string[];
	readonly piPrompts: readonly string[];
}

export async function seedBurrowWorkspace(
	input: SeedBurrowWorkspaceInput,
): Promise<SeedBurrowWorkspaceResult> {
	const fs = input.fs ?? defaultFs;
	const canopyPath = await writeCanopyAgent(input.workspacePath, input.agent, fs);
	const mulchDomains = await writeExpertiseSeed(
		input.workspacePath,
		input.agent.sections.expertise_seed,
		fs,
	);
	const workflowPath = await writeWorkflowTemplate(
		input.workspacePath,
		input.agent.sections.workflow,
		fs,
	);
	const piSkills = await writePiArtifacts(
		input.workspacePath,
		input.agent.sections.pi_skills,
		fs,
		"skill",
	);
	const piPrompts = await writePiArtifacts(
		input.workspacePath,
		input.agent.sections.pi_prompts,
		fs,
		"prompt",
	);
	return { canopyPath, mulchDomains, workflowPath, piSkills, piPrompts };
}

async function writeCanopyAgent(
	workspacePath: string,
	agent: AgentDefinition,
	fs: SeedFs,
): Promise<string> {
	const path = join(workspacePath, ".canopy", "agent.json");
	await fs.mkdirp(dirname(path));
	const body = JSON.stringify(
		{
			name: agent.name,
			version: agent.version,
			sections: agent.sections,
			resolvedFrom: agent.resolvedFrom,
			frontmatter: agent.frontmatter,
		},
		null,
		2,
	);
	await fs.writeFile(path, `${body}\n`);
	return path;
}

async function writeExpertiseSeed(
	workspacePath: string,
	body: string | undefined,
	fs: SeedFs,
): Promise<readonly string[]> {
	if (body === undefined || body.trim() === "") return [];
	const expertiseDir = join(workspacePath, ".mulch", "expertise");
	await fs.mkdirp(expertiseDir);

	const grouped = new Map<string, string[]>();
	const lines = body.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		if (raw === undefined) continue;
		const line = raw.trim();
		if (line === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (err) {
			throw new RunSpawnError(
				`expertise_seed line ${i + 1} is not valid JSON: ${formatError(err)}`,
				{ recoveryHint: "fix the canopy prompt's expertise_seed section" },
			);
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new RunSpawnError(
				`expertise_seed line ${i + 1} is not a JSON object: ${truncate(line, 80)}`,
			);
		}
		const domain = (parsed as { domain?: unknown }).domain;
		if (typeof domain !== "string" || domain === "") {
			throw new RunSpawnError(`expertise_seed line ${i + 1} is missing a non-empty "domain" field`);
		}
		const bucket = grouped.get(domain) ?? [];
		bucket.push(line);
		grouped.set(domain, bucket);
	}

	for (const [domain, records] of grouped) {
		const target = join(expertiseDir, `${domain}.jsonl`);
		await fs.appendFile(target, `${records.join("\n")}\n`);
	}

	return [...grouped.keys()].sort();
}

async function writeWorkflowTemplate(
	workspacePath: string,
	body: string | undefined,
	fs: SeedFs,
): Promise<string | null> {
	if (body === undefined || body.trim() === "") return null;
	const path = join(workspacePath, ".seeds", "workflow.txt");
	await fs.mkdirp(dirname(path));
	await fs.writeFile(path, body.endsWith("\n") ? body : `${body}\n`);
	return path;
}

type PiArtifactKind = "skill" | "prompt";

async function writePiArtifacts(
	workspacePath: string,
	body: string | undefined,
	fs: SeedFs,
	kind: PiArtifactKind,
): Promise<readonly string[]> {
	if (body === undefined || body.trim() === "") return [];
	const sectionName = kind === "skill" ? "pi_skills" : "pi_prompts";

	const entries: Array<{ name: string; body: string }> = [];
	const seen = new Set<string>();
	const lines = body.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		if (raw === undefined) continue;
		const line = raw.trim();
		if (line === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (err) {
			throw new RunSpawnError(
				`${sectionName} line ${i + 1} is not valid JSON: ${formatError(err)}`,
				{ recoveryHint: `fix the canopy prompt's ${sectionName} section` },
			);
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new RunSpawnError(
				`${sectionName} line ${i + 1} is not a JSON object: ${truncate(line, 80)}`,
			);
		}
		const obj = parsed as { name?: unknown; body?: unknown };
		if (typeof obj.name !== "string" || obj.name === "") {
			throw new RunSpawnError(`${sectionName} line ${i + 1} is missing a non-empty "name" field`);
		}
		if (!isSafeArtifactName(obj.name)) {
			throw new RunSpawnError(
				`${sectionName} line ${i + 1} has unsafe "name" ${JSON.stringify(obj.name)} (no path separators, "." or "..")`,
			);
		}
		if (typeof obj.body !== "string") {
			throw new RunSpawnError(`${sectionName} line ${i + 1} is missing a string "body" field`);
		}
		if (seen.has(obj.name)) {
			throw new RunSpawnError(
				`${sectionName} line ${i + 1} duplicates name ${JSON.stringify(obj.name)}`,
			);
		}
		seen.add(obj.name);
		entries.push({ name: obj.name, body: obj.body });
	}

	if (entries.length === 0) return [];

	const baseDir = join(workspacePath, ".pi", kind === "skill" ? "skills" : "prompts");
	await fs.mkdirp(baseDir);

	for (const entry of entries) {
		const target =
			kind === "skill" ? join(baseDir, entry.name, "SKILL.md") : join(baseDir, `${entry.name}.md`);
		if (kind === "skill") {
			await fs.mkdirp(dirname(target));
		}
		await fs.writeFile(target, entry.body.endsWith("\n") ? entry.body : `${entry.body}\n`);
	}

	return entries.map((e) => e.name).sort();
}

function isSafeArtifactName(name: string): boolean {
	if (name === "." || name === "..") return false;
	if (name.includes("/") || name.includes("\\")) return false;
	if (name.includes("\0")) return false;
	return true;
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function formatError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

const defaultFs: SeedFs = {
	mkdirp: async (path) => {
		await mkdir(path, { recursive: true });
	},
	writeFile: async (path, contents) => {
		await writeFile(path, contents);
	},
	appendFile: async (path, contents) => {
		await appendFile(path, contents);
	},
};
