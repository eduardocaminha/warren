/**
 * Drizzle Kit config — `drizzle-kit generate` emits SQL migrations from the
 * schema. Runtime migration application happens in src/db/client.ts via
 * drizzle-orm/bun-sqlite/migrator. The schema itself lands in Phase 1
 * (warren-35db); this file pins where the schema and migrations will live.
 */

import type { Config } from "drizzle-kit";

export default {
	schema: "./src/db/schema.ts",
	out: "./src/db/migrations",
	dialect: "sqlite",
} satisfies Config;
