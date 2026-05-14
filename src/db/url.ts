/**
 * WARREN_DB_URL parser (R-13, pl-f17e step 3).
 *
 * Single env-var contract for which database backend warren opens:
 *
 *   sqlite:///data/warren.db    sqlite at /data/warren.db
 *   file:///data/warren.db      sqlite at /data/warren.db (RFC 8089 alias)
 *   sqlite://./warren.db        sqlite at ./warren.db (relative)
 *   :memory:                    sqlite in-memory (no scheme, sentinel)
 *   /data/warren.db             sqlite at /data/warren.db (bare path)
 *   postgres://user:pw@h/db     postgres connection string (passed through)
 *   postgresql://user:pw@h/db   postgres connection string (passed through)
 *
 * Bare paths are accepted so WARREN_DB_PATH can be synthesized into the URL
 * contract without operators learning a new shape — `loadDatabaseConfig` in
 * server config (step 5) folds the legacy var into this parser unchanged.
 *
 * The parser is intentionally permissive about the sqlite forms: anything
 * that doesn't start with a recognized `postgres:` / `postgresql:` scheme is
 * treated as a sqlite path. That preserves back-compat with WARREN_DB_PATH
 * (which has always been a bare filesystem path or `:memory:`) and avoids
 * a class of mistyped-scheme failures where `sqlite:/data/warren.db` (one
 * slash) would otherwise be a hard error.
 */

import { ValidationError } from "../core/errors.ts";

export type ParsedDatabaseUrl =
	| { dialect: "sqlite"; path: string }
	| { dialect: "postgres"; connectionString: string };

export function parseDatabaseUrl(input: string): ParsedDatabaseUrl {
	const trimmed = input.trim();
	if (trimmed === "") {
		throw new ValidationError("database URL is empty", {
			recoveryHint:
				"set WARREN_DB_URL to a sqlite path (`sqlite:///data/warren.db` or `:memory:`) or a Postgres URL (`postgres://...`)",
		});
	}

	if (trimmed === ":memory:") {
		return { dialect: "sqlite", path: ":memory:" };
	}

	const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
	const scheme = schemeMatch?.[1]?.toLowerCase();

	if (scheme === "postgres" || scheme === "postgresql") {
		return { dialect: "postgres", connectionString: trimmed };
	}

	if (scheme === "sqlite" || scheme === "file") {
		// Strip `scheme:` plus 0..N leading slashes. `sqlite:///abs/path` becomes
		// `/abs/path`; `sqlite://./rel/path` becomes `./rel/path`; `sqlite::memory:`
		// becomes `:memory:`. The triple-slash form is the SQLAlchemy convention
		// operators are most likely to copy from existing docs.
		const stripped = trimmed.slice(scheme.length + 1).replace(/^\/{0,3}/, (slashes) =>
			// 0 slashes  → "" (keep as-is, e.g. `sqlite::memory:` → `:memory:`)
			// 1 slash    → "" (relative path, e.g. `sqlite:/foo` → `foo`)
			// 2 slashes  → "" (e.g. `sqlite://./rel` → `./rel`)
			// 3 slashes  → "/" (absolute path, e.g. `sqlite:///foo` → `/foo`)
			slashes.length === 3 ? "/" : "",
		);
		if (stripped === "" || stripped === "/") {
			throw new ValidationError(`sqlite URL has no path: ${JSON.stringify(input)}`, {
				recoveryHint:
					"use `:memory:` for an ephemeral db, or `sqlite:///absolute/path` / `sqlite://./relative/path`",
			});
		}
		return { dialect: "sqlite", path: stripped };
	}

	// No recognized scheme — treat as a bare sqlite path. This is the
	// WARREN_DB_PATH back-compat surface (and is also how plain `:memory:`
	// would land if not special-cased above).
	return { dialect: "sqlite", path: trimmed };
}

/**
 * Construct a `sqlite://` URL for a filesystem path. Used by server config
 * to synthesize a URL from WARREN_DB_PATH so the rest of the system speaks
 * URLs even when operators set only the legacy path env.
 */
export function sqliteUrlForPath(path: string): string {
	if (path === ":memory:") return ":memory:";
	if (path.startsWith("/")) return `sqlite://${path}`; // sqlite:///abs/path
	return `sqlite://${path}`; // sqlite://./rel or sqlite://rel
}
