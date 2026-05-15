/**
 * Scenario 20-path — path-mode previews end-to-end
 * (R-19 / SPEC §11.L addendum, warren-7b3c / pl-f4ea step 8).
 *
 * Sibling of scenario 20 (subdomain mode). Locks down the path-mode
 * acceptance criterion (#2 on pl-f4ea): a fresh-install warren with no
 * `WARREN_PREVIEW_HOST` (and no wildcard DNS / wildcard cert) can
 * dispatch a run and serve a working preview at
 * `https://<warren-host>/p/<run-id>/`. This is the zero-domain
 * operator path the path-mode plan exists to enable.
 *
 * Boots its own warren+burrow stack with:
 *
 *   - `WARREN_PREVIEW_MODE=path`
 *   - **no** `WARREN_PREVIEW_HOST` — proves the proxy preamble + the
 *     login handshake both work when the operator has nothing but the
 *     warren origin to hand reviewers.
 *   - idle TTL big enough that eviction doesn't race the proxy assertions
 *     (the idle-TTL eviction path is mode-agnostic and stays the
 *     responsibility of scenario 20 variant B).
 *
 * Dispatches a stub run against a preview-enabled fixture and asserts:
 *
 *   1. Run reaches `succeeded`; `preview_state='live'`, `preview_port`
 *      assigned.
 *   2. Anonymous `GET <warrenUrl>/p/<runId>/` is rejected with 401 by
 *      the path-mode proxy preamble (cookie required).
 *   3. `GET /runs/<runId>/preview/login?token=…&redirect=…` returns 302
 *      with a `Set-Cookie: warren_preview=…; Path=/p/<runId>/` —
 *      per-run path scope is what mitigates SPEC §11.L risk 4 (sibling
 *      preview sessions in the same browser).
 *   4. Authenticated `GET <warrenUrl>/p/<runId>/` returns 200, the body
 *      carries the upstream `preview-ok` marker (proves the proxy hit
 *      the sidecar, not a sibling port) AND the path-mode HTML
 *      rewriter injected `<base href="/p/<runId>/">` (proves the
 *      response-side transform from warren-ab3a fires in path mode).
 *
 * Skip conditions match scenario 20:
 *
 *   - **macOS** — burrow's bwrap-based inbound-port-forwarding (R-08)
 *     is Linux-only (mx-1d31f0).
 *   - **Postgres dialect** — the SPEC §11.L port allocator + eviction
 *     worker are sqlite-only today (mx-b82a55).
 */

import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	AcceptanceError,
	assertEqual,
	assertTrue,
	type Scenario,
	type ScenarioCtx,
	type ScenarioLogger,
	skipScenario,
} from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import { type BootHandle, bootInProc } from "../lib/inproc.ts";

interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
	readonly localPath: string;
}

interface RunRow {
	readonly id: string;
	readonly state: string;
	readonly burrowId: string | null;
	readonly previewState: "starting" | "live" | "failed" | "torn-down" | null;
	readonly previewPort: number | null;
	readonly previewFailureMessage: string | null;
}

interface CreateRunResponse {
	readonly run: RunRow;
}

const POLL_INTERVAL_MS = 250;
/** Same generous budget as scenario 20: reap → branch_push → pr_open →
 *  preview_launch can take up to ~60s of readiness probing. */
const LIVE_PREVIEW_TIMEOUT_MS = 90_000;
const TERMINAL_TIMEOUT_MS = 30_000;
const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);

const PREVIEW_SANDBOX_PORT = 3000;
const PREVIEW_OK_MARKER = "warren-preview-ok";
/** A real HTML doc (with a `<head>` tag) so the path-mode response
 *  rewriter has somewhere to splice the injected `<base>` element. The
 *  subdomain-mode scenario doesn't need this — its index can be a bare
 *  string — so this fixture is path-mode-specific. */
const PREVIEW_INDEX_HTML = `<!doctype html>
<html>
<head><title>warren preview</title></head>
<body>${PREVIEW_OK_MARKER}</body>
</html>
`;

export const scenario: Scenario = {
	id: "20-path",
	title:
		"Preview environments — path mode happy-path (sqlite, Linux only; macOS skip per mx-1d31f0)",
	// Boots its own warren+burrow with `WARREN_PREVIEW_MODE=path` set at
	// boot time; the compose launcher doesn't expose the env-knob
	// injection seam we need, so in-proc only.
	modes: ["in-proc"],
	async run(ctx) {
		if (process.platform === "darwin") {
			skipScenario(
				"preview scenarios require burrow's Linux-only bwrap inbound-port-forwarding " +
					"(mx-1d31f0 / burrow inbound-forward.ts): Seatbelt doesn't isolate the network " +
					"namespace and the host port the allocator hands out has no listener.",
			);
		}
		const dialect = (process.env.WARREN_TEST_DIALECT ?? "sqlite").trim().toLowerCase();
		if (dialect === "postgres" || dialect === "postgresql") {
			skipScenario(
				"preview port allocator + eviction worker are sqlite-only today (mx-b82a55); " +
					"the pg path lights up under the R-13 dialect-aware repo follow-up (pl-f17e). " +
					"This scenario re-passes once that's wired.",
			);
		}

		await runPathHappyPath(ctx);
	},
};

async function runPathHappyPath(ctx: ScenarioCtx): Promise<void> {
	ctx.logger.info("scenario-20-path: dispatch + path-mode proxy round-trip");
	const variantRoot = await mkdtemp(join(tmpdir(), "warren-acceptance-20p-"));
	const sample = await buildPreviewProjectFixture({ ctx, scenarioRoot: variantRoot });

	let handle: BootHandle | undefined;
	try {
		handle = await bootInProc({
			tmpRoot: join(variantRoot, "warren"),
			token: ctx.token,
			canopyRepoUrl: ctx.fixtures.canopyRepoUrl,
			gitConfigPath: sample.gitConfigPath,
			extraEnv: {
				WARREN_STUB_SLEEP_MS: "0",
				// Path mode: WARREN_PREVIEW_HOST deliberately unset. The
				// fresh-install promise is that the operator needs nothing
				// beyond `fly deploy` + a warren API token.
				WARREN_PREVIEW_MODE: "path",
				WARREN_PREVIEW_IDLE_TTL: "30m",
				WARREN_PREVIEW_MAX_LIFETIME: "8h",
				WARREN_PREVIEW_EVICTION_TICK_MS: "10000",
			},
		});
		ctx.logger.info(`scenario-20-path: warren ready at ${handle.warrenUrl}`);

		const http = new WarrenHttp({ baseUrl: handle.warrenUrl, token: handle.token });
		await http.expectStatus("POST", "/agents/refresh", 200);
		const project = await ensureProject(http, sample.gitUrl);

		const created = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
			body: {
				agent: ctx.fixtures.stubAgentName,
				project: project.id,
				prompt: "scenario-20-path: preview path-mode happy-path",
			},
		});
		const runId = created.run.id;
		ctx.logger.debug(`scenario-20-path: dispatched ${runId}`);

		await waitForRunTerminal(http, runId, ctx.logger);
		const live = await waitForPreviewState(http, runId, "live", LIVE_PREVIEW_TIMEOUT_MS);
		assertTrue(
			typeof live.previewPort === "number" && live.previewPort > 0,
			`preview_port populated on live preview (got ${JSON.stringify(live.previewPort)})`,
		);

		const previewPath = `/p/${runId}/`;

		// 1. Anonymous → 401. The path-mode proxy preamble matches
		//    /p/<runId>/ regardless of Host header (we hit the warren
		//    origin directly), runs cookie verification, and rejects when
		//    the cookie is absent.
		const noCookie = await fetchRaw(handle.warrenUrl, previewPath);
		if (noCookie.status !== 401) {
			throw new AcceptanceError(
				`path-mode proxy without cookie: expected 401, got ${noCookie.status} body=${noCookie.bodySnippet}`,
			);
		}

		// 2. Login handshake — assert 302 + Path-scoped cookie.
		const login = await loginAndIssueCookie({
			warrenUrl: handle.warrenUrl,
			token: handle.token,
			runId,
		});
		assertEqual(
			login.cookiePath,
			previewPath,
			"Set-Cookie scopes warren_preview to Path=/p/<runId>/ in path mode (SPEC §11.L risk 4 mitigation)",
		);
		assertTrue(
			login.cookieDomain === undefined,
			`path-mode cookie must be host-only (no Domain attribute); got Domain=${JSON.stringify(login.cookieDomain)}`,
		);

		// 3. Authenticated → 200 with upstream marker AND injected <base>.
		const withCookie = await fetchRaw(handle.warrenUrl, previewPath, {
			cookie: `warren_preview=${login.cookieValue}`,
		});
		if (withCookie.status !== 200) {
			throw new AcceptanceError(
				`path-mode proxy with cookie: expected 200, got ${withCookie.status} body=${withCookie.bodySnippet}`,
			);
		}
		assertTrue(
			withCookie.bodySnippet.includes(PREVIEW_OK_MARKER),
			`expected proxied 200 to include ${JSON.stringify(PREVIEW_OK_MARKER)} marker, got ${JSON.stringify(withCookie.bodySnippet)}`,
		);
		const expectedBase = `<base href="${previewPath}">`;
		assertTrue(
			withCookie.bodySnippet.includes(expectedBase),
			`expected path-mode HTML rewrite to inject ${JSON.stringify(expectedBase)}, got ${JSON.stringify(withCookie.bodySnippet)}`,
		);

		// Cleanup: manual teardown so the eviction worker doesn't have to
		// chase the sidecar after this scenario's warren is killed.
		try {
			await http.request("POST", `/runs/${encodeURIComponent(runId)}/preview/teardown`, {
				body: { actor: "scenario-20-path-cleanup" },
			});
		} catch {
			// Best-effort.
		}
	} finally {
		if (handle !== undefined) {
			await handle.stop().catch(() => undefined);
		}
	}
}

/* ------------------------------------------------------------------ */
/* Fixture builder — preview-opted-in project source                   */
/* ------------------------------------------------------------------ */

interface BuildFixtureInput {
	readonly ctx: ScenarioCtx;
	readonly scenarioRoot: string;
}

interface BuiltPreviewFixture {
	readonly gitUrl: string;
	readonly sourceRepoPath: string;
	readonly gitConfigPath: string;
}

/**
 * Copy the harness's `sample-source` clone into the scenario's tmp dir,
 * drop a `.warren/defaults.json` with a `preview.command` that runs the
 * stdlib python http server, write a proper-HTML `index.html` (so the
 * path-mode `<base>` rewriter has something to splice), commit on a
 * fresh branch, and return a scenario-unique fake URL + an augmented
 * git-config that redirects it onto the on-disk repo.
 */
async function buildPreviewProjectFixture(input: BuildFixtureInput): Promise<BuiltPreviewFixture> {
	const sourceRepoPath = join(input.scenarioRoot, "sample-source");
	await cp(input.ctx.fixtures.sampleProjectPath, sourceRepoPath, { recursive: true });

	const defaultsJson = JSON.stringify(
		{
			defaultRole: input.ctx.fixtures.stubAgentName,
			preview: {
				type: "server",
				command: `python3 -m http.server ${PREVIEW_SANDBOX_PORT} --bind 0.0.0.0 --directory ./.warren/preview-www`,
				port: PREVIEW_SANDBOX_PORT,
				readiness_path: "/",
			},
		},
		null,
		2,
	);
	await Bun.write(join(sourceRepoPath, ".warren", "defaults.json"), defaultsJson);
	await Bun.write(join(sourceRepoPath, ".warren", "preview-www", "index.html"), PREVIEW_INDEX_HTML);

	const suffix = `p-${randomBytes(3).toString("hex")}`;
	const fakeUrl = `https://github.com/warren-acceptance/preview-path-sample-${suffix}.git`;

	await commitInSource(sourceRepoPath, `scenario-20-path: enable preview (${suffix})`);

	const outerGitConfig = await readFile(join(input.ctx.tmp, "git-config"), "utf8");
	const extension = [
		`[url "${sourceRepoPath}"]`,
		`\tinsteadOf = ${fakeUrl}`,
		`[url "${sourceRepoPath}"]`,
		`\tinsteadOf = git@github.com:warren-acceptance/preview-path-sample-${suffix}.git`,
		"",
	].join("\n");
	const gitConfigPath = join(input.scenarioRoot, "git-config");
	await writeFile(gitConfigPath, `${outerGitConfig}\n${extension}`);

	return { gitUrl: fakeUrl, sourceRepoPath, gitConfigPath };
}

async function commitInSource(repoPath: string, message: string): Promise<void> {
	await runGit(repoPath, ["add", "."]);
	await runGit(repoPath, ["commit", "-m", message]);
}

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
	const proc = Bun.spawn({
		cmd: ["git", ...args],
		cwd,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "/tmp",
			GIT_AUTHOR_NAME: "Warren Acceptance",
			GIT_AUTHOR_EMAIL: "acceptance@warren.invalid",
			GIT_COMMITTER_NAME: "Warren Acceptance",
			GIT_COMMITTER_EMAIL: "acceptance@warren.invalid",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((exitCode ?? 0) !== 0) {
		throw new AcceptanceError(
			`git ${args.join(" ")} in ${cwd}: exit ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`,
		);
	}
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                         */
/* ------------------------------------------------------------------ */

async function ensureProject(http: WarrenHttp, gitUrl: string): Promise<ProjectRow> {
	const list = await http.expectJson<{ projects: ProjectRow[] }>("GET", "/projects", 200);
	const existing = list.projects.find((p) => p.gitUrl === gitUrl);
	if (existing !== undefined) return existing;
	return http.expectJson<ProjectRow>("POST", "/projects", 201, { body: { gitUrl } });
}

async function waitForRunTerminal(
	http: WarrenHttp,
	runId: string,
	logger: ScenarioLogger,
): Promise<void> {
	const deadline = Date.now() + TERMINAL_TIMEOUT_MS;
	let last = "<unknown>";
	while (Date.now() < deadline) {
		const row = await http.expectJson<RunRow>("GET", `/runs/${encodeURIComponent(runId)}`, 200);
		last = row.state;
		if (TERMINAL_STATES.has(row.state)) {
			logger.debug(`scenario-20-path: run ${runId} terminal in state=${row.state}`);
			if (row.state !== "succeeded") {
				throw new AcceptanceError(
					`expected run ${runId} to succeed (preview launches only on success); got state=${row.state}`,
				);
			}
			return;
		}
		await sleep(POLL_INTERVAL_MS);
	}
	throw new AcceptanceError(
		`run ${runId} did not reach terminal within ${TERMINAL_TIMEOUT_MS}ms (last state=${last})`,
	);
}

async function waitForPreviewState(
	http: WarrenHttp,
	runId: string,
	target: RunRow["previewState"],
	timeoutMs: number,
): Promise<RunRow> {
	const deadline = Date.now() + timeoutMs;
	let last: RunRow | undefined;
	while (Date.now() < deadline) {
		last = await http.expectJson<RunRow>("GET", `/runs/${encodeURIComponent(runId)}`, 200);
		if (last.previewState === target) return last;
		if (last.previewState === "failed") {
			throw new AcceptanceError(
				`preview transitioned to 'failed' before reaching '${target}' on run ${runId}: ` +
					`${last.previewFailureMessage ?? "<no message>"}`,
			);
		}
		await sleep(POLL_INTERVAL_MS);
	}
	throw new AcceptanceError(
		`preview did not reach '${target}' within ${timeoutMs}ms on run ${runId} ` +
			`(last preview_state=${JSON.stringify(last?.previewState ?? null)}, ` +
			`failure_message=${JSON.stringify(last?.previewFailureMessage ?? null)})`,
	);
}

/* ------------------------------------------------------------------ */
/* Path-mode proxy + login helpers                                       */
/* ------------------------------------------------------------------ */

interface RawResponse {
	readonly status: number;
	readonly bodySnippet: string;
}

/**
 * Hit warren on `<warrenUrl><path>` directly. Unlike the subdomain
 * variant we don't override `Host:` — the path-mode preamble keys off
 * the URL pathname, so the inbound Host is whatever the loopback
 * binding presents. Body is captured up to 2 KiB so the injected
 * `<base>` tag is always visible to the assertion (real preview HTML
 * is small in this fixture; the cap exists only to keep the failure
 * message readable on a regression).
 */
async function fetchRaw(
	warrenUrl: string,
	path: string,
	init: { cookie?: string } = {},
): Promise<RawResponse> {
	const headers: Record<string, string> = {};
	if (init.cookie !== undefined) headers.cookie = init.cookie;
	const res = await fetch(`${warrenUrl}${path}`, {
		method: "GET",
		headers,
		redirect: "manual",
	});
	const text = await res.text();
	return {
		status: res.status,
		bodySnippet: text.length > 2048 ? `${text.slice(0, 2048)}…` : text,
	};
}

interface LoginInput {
	readonly warrenUrl: string;
	readonly token: string;
	readonly runId: string;
}

interface LoginResult {
	readonly cookieValue: string;
	readonly cookiePath: string;
	readonly cookieDomain: string | undefined;
}

/**
 * Walk `/runs/:id/preview/login?token=…&redirect=…` in path mode and
 * return the issued cookie + its Path / Domain attributes so the
 * caller can verify the scope contract (warren-edff: path mode emits
 * `Path=/p/<runId>/` with no Domain).
 */
async function loginAndIssueCookie(input: LoginInput): Promise<LoginResult> {
	const redirect = `${input.warrenUrl}/p/${input.runId}/`;
	const url = `${input.warrenUrl}/runs/${encodeURIComponent(input.runId)}/preview/login?token=${encodeURIComponent(input.token)}&redirect=${encodeURIComponent(redirect)}`;
	const res = await fetch(url, { method: "GET", redirect: "manual" });
	if (res.status !== 302) {
		const body = await res.text();
		throw new AcceptanceError(
			`path-mode preview login: expected 302, got ${res.status}: ${body.slice(0, 256)}`,
		);
	}
	const setCookie = res.headers.get("set-cookie");
	if (setCookie === null || setCookie.length === 0) {
		throw new AcceptanceError("path-mode preview login: missing Set-Cookie on 302");
	}
	const parsed = parseSetCookie(setCookie, "warren_preview");
	if (parsed === null) {
		throw new AcceptanceError(
			`path-mode preview login: Set-Cookie did not carry a warren_preview entry: ${setCookie}`,
		);
	}
	return {
		cookieValue: parsed.value,
		cookiePath: parsed.attributes.Path ?? "",
		cookieDomain: parsed.attributes.Domain,
	};
}

interface ParsedCookie {
	readonly value: string;
	readonly attributes: Readonly<Record<string, string>>;
}

/**
 * Tiny Set-Cookie parser: pulls the `<name>=<value>` head and a
 * case-sensitive attribute map ({Path, Domain, Max-Age, HttpOnly,
 * Secure, SameSite}). We don't need full RFC 6265 conformance — we
 * issue exactly the attributes in `src/preview/cookie.ts`, and the
 * scope assertions key off Path / Domain only.
 */
function parseSetCookie(setCookie: string, name: string): ParsedCookie | null {
	const parts = setCookie.split(";");
	const first = parts[0];
	if (first === undefined) return null;
	const eq = first.indexOf("=");
	if (eq === -1) return null;
	if (first.slice(0, eq).trim() !== name) return null;
	const value = first.slice(eq + 1);
	const attributes: Record<string, string> = {};
	for (let i = 1; i < parts.length; i++) {
		const part = parts[i];
		if (part === undefined) continue;
		const trimmed = part.trim();
		if (trimmed.length === 0) continue;
		const attrEq = trimmed.indexOf("=");
		if (attrEq === -1) {
			attributes[trimmed] = "";
		} else {
			attributes[trimmed.slice(0, attrEq)] = trimmed.slice(attrEq + 1);
		}
	}
	return { value, attributes };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
