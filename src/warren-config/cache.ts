/**
 * Per-project lazy cache for `.warren/` config (R-02, pl-5d74 step 3).
 *
 * The HTTP surface (`GET /projects/:id/warren-config`), the doctor check,
 * and the project UI all want a parsed view of the same files. Re-parsing
 * on every read would multiply disk + YAML cost across concurrent
 * requests; eager parsing at boot would tie warren startup to every
 * registered project's `.warren/` being clean.
 *
 * The cache is keyed by **project id** (not local path) — refreshProject
 * and deleteProject know the id, and a re-cloned project under the same
 * id should drop any stale entry even if the path stayed the same.
 *
 * Single-flight: a second `get(id, path)` arriving while the first is
 * mid-parse waits on the in-flight promise. Invalidate() drops the
 * resolved entry *and* the in-flight promise atomically — per pl-5d74
 * risk #4, refreshProject invalidates BEFORE recordRefresh writes so a
 * concurrent reader either waited on the in-flight load (now dropped) or
 * triggers a fresh parse against the post-fetch tree. Either way no
 * caller observes the post-refresh row paired with the pre-refresh
 * parse.
 *
 * Errors are intentionally NOT cached: a transient
 * `WarrenConfigUnavailableError` (clone vanished mid-flight) should not
 * pin a 503 on subsequent requests. Per-file `WarrenConfigFileError`
 * entries DO cache as part of the envelope — that's the contract
 * (acceptance #2) and the operator wants the same answer until they
 * push a fix and refresh.
 */

import type { LoadedWarrenConfig, LoadWarrenConfigInput } from "./load.ts";
import { loadWarrenConfig } from "./load.ts";

export type WarrenConfigLoader = (input: LoadWarrenConfigInput) => Promise<LoadedWarrenConfig>;

export interface WarrenConfigCacheOptions {
	/** Inject the loader; defaults to `loadWarrenConfig`. */
	readonly load?: WarrenConfigLoader;
}

export interface WarrenConfigCache {
	/**
	 * Resolve the cached envelope for a project, parsing on demand. The
	 * second argument is the project's on-disk clone path — passed at the
	 * call site because the cache deliberately doesn't keep a handle to
	 * the projects repo (the HTTP/doctor surfaces already have it).
	 */
	get(projectId: string, projectPath: string): Promise<LoadedWarrenConfig>;
	/**
	 * Drop the entry for a project. Called BEFORE refreshProject stamps
	 * the row (pl-5d74 risk #4) and AFTER deleteProject removes it.
	 */
	invalidate(projectId: string): void;
	/** Drop every entry. Used by tests and `bootServer`'s shutdown path. */
	clear(): void;
	/** Test/diagnostic surface — number of currently-cached entries. */
	size(): number;
}

export function createWarrenConfigCache(opts: WarrenConfigCacheOptions = {}): WarrenConfigCache {
	const load = opts.load ?? loadWarrenConfig;

	type Entry =
		| { readonly state: "loading"; readonly promise: Promise<LoadedWarrenConfig> }
		| { readonly state: "resolved"; readonly value: LoadedWarrenConfig };

	const entries = new Map<string, Entry>();

	return {
		async get(projectId, projectPath) {
			const existing = entries.get(projectId);
			if (existing !== undefined) {
				if (existing.state === "resolved") return existing.value;
				return existing.promise;
			}
			// Track our slot by identity so the resolution path can detect
			// a mid-flight invalidate(): if our entry was replaced, drop
			// the result on the floor instead of committing stale data.
			let loadingEntry: Entry | null = null;
			const promise = load({ projectPath }).then(
				(value) => {
					if (entries.get(projectId) === loadingEntry) {
						entries.set(projectId, { state: "resolved", value });
					}
					return value;
				},
				(err) => {
					// Don't pin transient failures — drop the in-flight
					// entry so the next get() retries against fresh state.
					if (entries.get(projectId) === loadingEntry) {
						entries.delete(projectId);
					}
					throw err;
				},
			);
			loadingEntry = { state: "loading", promise };
			entries.set(projectId, loadingEntry);
			return promise;
		},
		invalidate(projectId) {
			entries.delete(projectId);
		},
		clear() {
			entries.clear();
		},
		size() {
			return entries.size;
		},
	};
}
