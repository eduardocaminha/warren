import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NotFoundError, ValidationError } from "../core/errors.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { AgentsRepo } from "../db/repos/agents.ts";
import { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import { ProjectsRepo } from "../db/repos/projects.ts";
import { RunsRepo } from "../db/repos/runs.ts";
import {
	DEFAULT_PREVIEW_PORT_RANGE,
	loadPreviewPortRangeFromEnv,
	PORT_EXHAUSTED_REASON,
	PREVIEW_PORT_USAGE_WARN_RATIO,
	PreviewPortAllocator,
	parsePortRange,
	rangeSize,
	WARREN_PREVIEW_PORT_RANGE_ENV,
} from "./port-allocator.ts";

describe("parsePortRange", () => {
	test("accepts <start>-<end>", () => {
		expect(parsePortRange("30000-31000")).toEqual({ start: 30000, end: 31000 });
	});

	test("accepts whitespace around the dash", () => {
		expect(parsePortRange(" 30000 - 31000 ")).toEqual({ start: 30000, end: 31000 });
	});

	test("accepts a single-port range", () => {
		expect(parsePortRange("4000-4000")).toEqual({ start: 4000, end: 4000 });
	});

	test("rejects malformed input", () => {
		expect(() => parsePortRange("not-a-range")).toThrow(ValidationError);
		expect(() => parsePortRange("30000")).toThrow(ValidationError);
		expect(() => parsePortRange("30000-")).toThrow(ValidationError);
		expect(() => parsePortRange("")).toThrow(ValidationError);
	});

	test("rejects out-of-range bounds", () => {
		expect(() => parsePortRange("0-100")).toThrow(ValidationError);
		expect(() => parsePortRange("100-99999")).toThrow(ValidationError);
	});

	test("rejects start > end", () => {
		expect(() => parsePortRange("31000-30000")).toThrow(ValidationError);
	});
});

describe("loadPreviewPortRangeFromEnv", () => {
	test("unset falls back to default", () => {
		expect(loadPreviewPortRangeFromEnv({})).toEqual(DEFAULT_PREVIEW_PORT_RANGE);
	});

	test("empty / whitespace falls back to default", () => {
		expect(loadPreviewPortRangeFromEnv({ [WARREN_PREVIEW_PORT_RANGE_ENV]: "" })).toEqual(
			DEFAULT_PREVIEW_PORT_RANGE,
		);
		expect(loadPreviewPortRangeFromEnv({ [WARREN_PREVIEW_PORT_RANGE_ENV]: "   " })).toEqual(
			DEFAULT_PREVIEW_PORT_RANGE,
		);
	});

	test("valid env override is parsed", () => {
		expect(loadPreviewPortRangeFromEnv({ [WARREN_PREVIEW_PORT_RANGE_ENV]: "40000-40100" })).toEqual(
			{
				start: 40000,
				end: 40100,
			},
		);
	});

	test("malformed env throws ValidationError", () => {
		expect(() =>
			loadPreviewPortRangeFromEnv({ [WARREN_PREVIEW_PORT_RANGE_ENV]: "garbage" }),
		).toThrow(ValidationError);
	});
});

describe("rangeSize", () => {
	test("inclusive on both ends", () => {
		expect(rangeSize({ start: 30000, end: 31000 })).toBe(1001);
		expect(rangeSize({ start: 4000, end: 4000 })).toBe(1);
	});
});

describe("constants", () => {
	test("PORT_EXHAUSTED_REASON matches SPEC §11.L wording", () => {
		expect(PORT_EXHAUSTED_REASON).toBe("port_exhausted");
	});

	test("warn ratio matches SPEC §11.L (≥80%)", () => {
		expect(PREVIEW_PORT_USAGE_WARN_RATIO).toBe(0.8);
	});
});

describe("PreviewPortAllocator", () => {
	let db: WarrenDb;
	let runsRepo: RunsRepo;
	let agentName: string;
	let projectId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		const agents = new AgentsRepo(DrizzleAdapter.for(db));
		const projects = new ProjectsRepo(DrizzleAdapter.for(db));
		const a = await agents.upsert({ name: "preview-bot", renderedJson: { sections: {} } });
		const p = await projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		agentName = a.name;
		projectId = p.id;
		runsRepo = new RunsRepo(db.drizzle);
	});

	afterEach(async () => {
		await db.close();
	});

	async function spawn() {
		return runsRepo.create({
			agentName,
			projectId,
			prompt: "preview please",
			renderedAgentJson: { sections: {} },
			trigger: "manual",
		});
	}

	test("rejects a range outside the valid TCP space", async () => {
		expect(() => new PreviewPortAllocator(db, { start: 0, end: 10 })).toThrow(ValidationError);
		expect(() => new PreviewPortAllocator(db, { start: 10, end: 5 })).toThrow(ValidationError);
	});

	test("allocates the lowest free port and writes preview state", async () => {
		const allocator = new PreviewPortAllocator(db, { start: 40000, end: 40002 });
		const run = await spawn();
		const now = new Date("2026-05-14T18:00:00.000Z");
		const outcome = await allocator.allocate(run.id, now);
		expect(outcome).toEqual({ status: "allocated", port: 40000 });

		const reread = await runsRepo.require(run.id);
		expect(reread.previewPort).toBe(40000);
		expect(reread.previewState).toBe("starting");
		expect(reread.previewStartedAt).toBe(now.toISOString());
	});

	test("skips ports already in use by starting/live runs", async () => {
		const allocator = new PreviewPortAllocator(db, { start: 40000, end: 40005 });
		const inUse = await spawn();
		await runsRepo.attachPreview(inUse.id, { previewState: "starting", previewPort: 40000 });
		const live = await spawn();
		await runsRepo.attachPreview(live.id, { previewState: "live", previewPort: 40001 });

		const candidate = await spawn();
		const outcome = await allocator.allocate(candidate.id);
		expect(outcome).toEqual({ status: "allocated", port: 40002 });
	});

	test("released ports (state torn-down/failed) are re-allocatable", async () => {
		const allocator = new PreviewPortAllocator(db, { start: 40000, end: 40000 });
		const first = await spawn();
		const ok1 = await allocator.allocate(first.id);
		expect(ok1).toEqual({ status: "allocated", port: 40000 });

		// Release the port via the eviction-style write: state -> torn-down,
		// preview_port cleared. The allocator must see 40000 as free.
		await runsRepo.attachPreview(first.id, {
			previewState: "torn-down",
			previewPort: null,
		});

		const second = await spawn();
		const ok2 = await allocator.allocate(second.id);
		expect(ok2).toEqual({ status: "allocated", port: 40000 });
	});

	test("a stale port left behind on a failed run is still considered free", async () => {
		// The state filter is what excludes a row from the in-use set — even
		// if preview_port was never cleared on a failed row, the next
		// allocator must reuse the port.
		const allocator = new PreviewPortAllocator(db, { start: 40000, end: 40000 });
		const failed = await spawn();
		await runsRepo.attachPreview(failed.id, {
			previewState: "failed",
			previewPort: 40000,
			previewFailureMessage: "boot crashed",
		});

		const next = await spawn();
		expect(await allocator.allocate(next.id)).toEqual({ status: "allocated", port: 40000 });
	});

	test("returns exhausted when every port is in use", async () => {
		const allocator = new PreviewPortAllocator(db, { start: 40000, end: 40001 });
		const a = await spawn();
		const b = await spawn();
		await runsRepo.attachPreview(a.id, { previewState: "starting", previewPort: 40000 });
		await runsRepo.attachPreview(b.id, { previewState: "live", previewPort: 40001 });

		const candidate = await spawn();
		expect(await allocator.allocate(candidate.id)).toEqual({ status: "exhausted" });

		// The candidate row must NOT have been mutated when the range is
		// exhausted — caller (reap) emits preview_failed and the row stays
		// open for a future retry once a port is released.
		const reread = await runsRepo.require(candidate.id);
		expect(reread.previewPort).toBeNull();
		expect(reread.previewState).toBeNull();
	});

	test("throws NotFoundError for an unknown run id", async () => {
		const allocator = new PreviewPortAllocator(db);
		expect(allocator.allocate("run_doesnotexist")).rejects.toThrow(NotFoundError);
	});

	test("is idempotent for a run already holding a port (starting/live)", async () => {
		const allocator = new PreviewPortAllocator(db, { start: 40000, end: 40010 });
		const run = await spawn();
		const startedAt = "2026-05-14T18:00:00.000Z";
		await runsRepo.attachPreview(run.id, {
			previewState: "starting",
			previewPort: 40005,
			previewStartedAt: startedAt,
		});
		const outcome = await allocator.allocate(run.id, new Date("2026-05-14T19:00:00.000Z"));
		expect(outcome).toEqual({ status: "allocated", port: 40005 });

		// preview_started_at must not be clobbered by the idempotent path —
		// re-allocation would otherwise reset max-lifetime accounting.
		const reread = await runsRepo.require(run.id);
		expect(reread.previewStartedAt).toBe(startedAt);
	});

	test("restart-safety: a fresh allocator instance sees committed in-use ports", async () => {
		const a1 = new PreviewPortAllocator(db, { start: 40000, end: 40010 });
		const r1 = await spawn();
		const r2 = await spawn();
		await a1.allocate(r1.id);
		await a1.allocate(r2.id);

		// Simulating restart: the runs table survives; a brand-new allocator
		// against the same db must avoid the already-claimed ports.
		const a2 = new PreviewPortAllocator(db, { start: 40000, end: 40010 });
		const r3 = await spawn();
		const outcome = await a2.allocate(r3.id);
		expect(outcome).toEqual({ status: "allocated", port: 40002 });
	});

	test("usage reports inUse count and total range size", async () => {
		const allocator = new PreviewPortAllocator(db, { start: 40000, end: 40009 });
		expect(await allocator.usage()).toEqual({
			inUse: 0,
			total: 10,
			range: { start: 40000, end: 40009 },
		});

		for (let i = 0; i < 8; i += 1) {
			const run = await spawn();
			await allocator.allocate(run.id);
		}
		const usage = await allocator.usage();
		expect(usage.inUse).toBe(8);
		expect(usage.total).toBe(10);
		expect(usage.inUse / usage.total).toBe(0.8);
	});

	test("usage de-duplicates would-be duplicate ports (defensive)", async () => {
		// Two runs writing the same port would be a bug in the eviction /
		// teardown path, but usage() should still report a unique count so
		// the doctor warning isn't double-counted.
		const allocator = new PreviewPortAllocator(db, { start: 40000, end: 40005 });
		const a = await spawn();
		const b = await spawn();
		await runsRepo.attachPreview(a.id, { previewState: "starting", previewPort: 40000 });
		await runsRepo.attachPreview(b.id, { previewState: "live", previewPort: 40000 });
		const usage = await allocator.usage();
		expect(usage.inUse).toBe(1);
	});

	test("concurrent allocations against the same db never double-allocate a port", async () => {
		const range = { start: 40000, end: 40019 };
		const allocator = new PreviewPortAllocator(db, range);
		const candidates = await Promise.all(Array.from({ length: 20 }, () => spawn()));
		const outcomes = await Promise.all(candidates.map((c) => allocator.allocate(c.id)));
		const ports = outcomes
			.map((o) => (o.status === "allocated" ? o.port : null))
			.filter((p): p is number => p !== null);
		expect(new Set(ports).size).toBe(20);
		expect(ports.every((p) => p >= range.start && p <= range.end)).toBe(true);
	});
});
