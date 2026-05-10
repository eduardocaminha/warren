/**
 * `openPullRequest` — open a GitHub PR for a branch reap just pushed
 * (warren-f6af). Fourth best-effort sub-step of `reapRun`, gated by
 * `WARREN_AUTO_OPEN_PR` (default on).
 *
 * The call hits the GitHub REST API directly (`POST /repos/:owner/:repo/pulls`)
 * via an injected `fetch` seam — no shell-out to `gh`, no extra runtime
 * dependency. Auth is `GITHUB_TOKEN`, the same token the supervisor wires
 * into git's `insteadOf` rule at boot (warren-dcf3).
 *
 * Failure shapes (callers translate into `reap_failed` events; reap never
 * crashes the run because the PR step blew up):
 *   - `missing_token` — `GITHUB_TOKEN` unset/empty. Skip cleanly.
 *   - `pr_exists`    — GitHub returns 422 because a PR already covers the
 *                       same head→base. Treated as success: re-fetch the
 *                       existing PR's `html_url` so the caller still gets
 *                       a link to surface (idempotency for re-runs and
 *                       restart-recovery sweeps).
 *   - `network`      — fetch threw or non-2xx response that isn't a
 *                       known idempotent shape.
 *
 * The body and title format is fixed in V1 — first prompt line as title,
 * full prompt + run id + warren UI link as body. Per-project templating
 * is out of scope (file a follow-up if needed).
 */

export interface OpenPullRequestInput {
	readonly owner: string;
	readonly repo: string;
	readonly head: string;
	readonly base: string;
	readonly title: string;
	readonly body: string;
	readonly token: string;
}

export type OpenPullRequestResult =
	| { readonly ok: true; readonly url: string; readonly mode: "created" | "exists" }
	| {
			readonly ok: false;
			readonly reason: "missing_token" | "network" | "http_error";
			readonly message: string;
	  };

export interface PrFetcher {
	readonly fetch: typeof fetch;
}

const GITHUB_API_BASE = "https://api.github.com";
const USER_AGENT = "warren-reap-pr-open";

export async function openPullRequest(
	input: OpenPullRequestInput,
	deps: PrFetcher = { fetch: globalThis.fetch },
): Promise<OpenPullRequestResult> {
	if (input.token === "") {
		return {
			ok: false,
			reason: "missing_token",
			message: "GITHUB_TOKEN unset; cannot open pull request",
		};
	}

	const url = `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}/pulls`;
	const headers = buildHeaders(input.token);

	let res: Response;
	try {
		res = await deps.fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify({
				title: input.title,
				body: input.body,
				head: input.head,
				base: input.base,
			}),
		});
	} catch (err) {
		return {
			ok: false,
			reason: "network",
			message: err instanceof Error ? err.message : String(err),
		};
	}

	if (res.status === 201) {
		const created = (await readJson(res)) as { html_url?: unknown } | null;
		const link = typeof created?.html_url === "string" ? created.html_url : null;
		if (link === null) {
			return { ok: false, reason: "http_error", message: "POST /pulls returned no html_url" };
		}
		return { ok: true, url: link, mode: "created" };
	}

	if (res.status === 422) {
		// 422 covers both "PR already exists" and "no commits between head and
		// base". The first is idempotent — fetch the existing PR and return
		// its url. The second is a no-op shape callers are expected to skip
		// upstream (commitsAhead === 0), but if it slips through we surface
		// the message so the operator sees why.
		const body = (await readJson(res)) as { errors?: unknown; message?: unknown } | null;
		const message = typeof body?.message === "string" ? body.message : "422 from POST /pulls";
		const errorsBlob = JSON.stringify(body?.errors ?? []);
		if (/already exists|pull request already exists/i.test(errorsBlob + message)) {
			const existing = await findExistingPr(input, deps);
			if (existing !== null) {
				return { ok: true, url: existing, mode: "exists" };
			}
			return {
				ok: false,
				reason: "http_error",
				message: "PR already exists but lookup did not return a url",
			};
		}
		return { ok: false, reason: "http_error", message };
	}

	const text = await readText(res);
	return {
		ok: false,
		reason: "http_error",
		message: `POST /pulls returned ${res.status}: ${truncate(text, 500)}`,
	};
}

async function findExistingPr(
	input: OpenPullRequestInput,
	deps: PrFetcher,
): Promise<string | null> {
	const params = new URLSearchParams({
		head: `${input.owner}:${input.head}`,
		base: input.base,
		state: "open",
		per_page: "1",
	});
	const url = `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}/pulls?${params.toString()}`;
	let res: Response;
	try {
		res = await deps.fetch(url, { method: "GET", headers: buildHeaders(input.token) });
	} catch {
		return null;
	}
	if (!res.ok) return null;
	const list = (await readJson(res)) as Array<{ html_url?: unknown }> | null;
	if (!Array.isArray(list) || list.length === 0) return null;
	const first = list[0];
	return typeof first?.html_url === "string" ? first.html_url : null;
}

function buildHeaders(token: string): Record<string, string> {
	return {
		accept: "application/vnd.github+json",
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
		"user-agent": USER_AGENT,
		"x-github-api-version": "2022-11-28",
	};
}

async function readJson(res: Response): Promise<unknown> {
	try {
		return await res.json();
	} catch {
		return null;
	}
}

async function readText(res: Response): Promise<string> {
	try {
		return await res.text();
	} catch {
		return "";
	}
}

function truncate(input: string, max: number): string {
	return input.length <= max ? input : `${input.slice(0, max)}…`;
}

/* ----------------------------------------------------------------------- */
/* Title + body formatting                                                  */
/* ----------------------------------------------------------------------- */

const TITLE_MAX_LENGTH = 72;

export interface BuildPrContentInput {
	readonly prompt: string;
	readonly runId: string;
	readonly agentName: string;
	/** Optional warren UI base URL (e.g. `https://warren.example.com`). */
	readonly warrenBaseUrl?: string;
}

export interface PrContent {
	readonly title: string;
	readonly body: string;
}

/**
 * First non-empty prompt line becomes the PR title (truncated to 72 chars
 * with an ellipsis). Body carries the full prompt, the run id, and a link
 * back to the warren UI when a base URL is configured. Falls back to the
 * agent name when the prompt is empty.
 */
export function buildPrContent(input: BuildPrContentInput): PrContent {
	const firstLine = input.prompt
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l !== "");
	const rawTitle = firstLine ?? `warren run ${input.runId} (${input.agentName})`;
	const title =
		rawTitle.length <= TITLE_MAX_LENGTH ? rawTitle : `${rawTitle.slice(0, TITLE_MAX_LENGTH - 1)}…`;

	const lines: string[] = [];
	lines.push(`Opened by warren run \`${input.runId}\` (${input.agentName}).`);
	if (input.warrenBaseUrl !== undefined && input.warrenBaseUrl !== "") {
		const base = input.warrenBaseUrl.replace(/\/+$/, "");
		lines.push("");
		lines.push(`Warren run: ${base}/#/runs/${input.runId}`);
	}
	lines.push("");
	lines.push("## Prompt");
	lines.push("");
	lines.push("```");
	lines.push(input.prompt === "" ? "(empty prompt)" : input.prompt);
	lines.push("```");

	return { title, body: lines.join("\n") };
}

/* ----------------------------------------------------------------------- */
/* Config                                                                   */
/* ----------------------------------------------------------------------- */

export interface AutoOpenPrConfig {
	readonly enabled: boolean;
	readonly token: string;
	readonly warrenBaseUrl: string | null;
}

export type AutoOpenEnvLike = Readonly<Record<string, string | undefined>>;

/**
 * Resolve the auto-open config (warren-f6af). `WARREN_AUTO_OPEN_PR` defaults
 * to enabled — the seed's whole point is "agent run → reviewable change with
 * no manual hop". Anything that isn't a recognized falsy value (`0`, `false`,
 * `no`, `off`, case-insensitive, with whitespace tolerated) leaves it on, so
 * an operator can disable globally with `WARREN_AUTO_OPEN_PR=false` without
 * tripping a stricter parser.
 */
export function loadAutoOpenPrConfigFromEnv(env: AutoOpenEnvLike = process.env): AutoOpenPrConfig {
	const raw = env.WARREN_AUTO_OPEN_PR;
	const enabled = raw === undefined ? true : !isFalsy(raw);
	return {
		enabled,
		token: env.GITHUB_TOKEN ?? "",
		warrenBaseUrl: env.WARREN_BASE_URL ?? null,
	};
}

function isFalsy(raw: string): boolean {
	const v = raw.trim().toLowerCase();
	return v === "0" || v === "false" || v === "no" || v === "off" || v === "";
}
