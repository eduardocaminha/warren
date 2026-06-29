import { describe, expect, test } from "bun:test";
import { dedupJsonl } from "./dedup-jsonl.ts";

/* ----------------------------------------------------------------------- */
/* Helpers                                                                  */
/* ----------------------------------------------------------------------- */

function lines(...rows: string[]): string {
	return rows.map((r) => `${r}\n`).join("");
}

function issue(id: string, status = "open", extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ id, status, updatedAt: "2026-01-01T00:00:00Z", ...extra });
}

function plan(id: string, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ id, status: "approved", ...extra });
}

/* ----------------------------------------------------------------------- */
/* dedupJsonl — core contract                                               */
/* ----------------------------------------------------------------------- */

describe("dedupJsonl", () => {
	test("returns empty string for empty input", () => {
		expect(dedupJsonl("")).toBe("");
	});

	test("returns empty string for whitespace-only input", () => {
		expect(dedupJsonl("   \n  \n")).toBe("");
	});

	test("preserves a single line unchanged", () => {
		const body = `${issue("sd-1")}\n`;
		expect(dedupJsonl(body)).toBe(body);
	});

	test("preserves multiple non-duplicate lines in order", () => {
		const body = lines(issue("sd-1"), issue("sd-2"), issue("sd-3"));
		expect(dedupJsonl(body)).toBe(body);
	});

	test("last-write-wins: duplicate id keeps last occurrence", () => {
		const first = issue("sd-1", "open");
		const last = issue("sd-1", "closed");
		const result = dedupJsonl(lines(first, last));
		expect(result).toBe(`${last}\n`);
	});

	test("deduplicates three occurrences of the same id to the last one", () => {
		const a = issue("sd-1", "open", { title: "a" });
		const b = issue("sd-1", "open", { title: "b" });
		const c = issue("sd-1", "closed", { title: "c" });
		const result = dedupJsonl(lines(a, b, c));
		expect(result).toBe(`${c}\n`);
	});

	test("preserves order of surviving lines", () => {
		// sd-1 first and last → keeps last; sd-2 and sd-3 unique → kept in order
		const sd1old = issue("sd-1", "open");
		const sd2 = issue("sd-2", "open");
		const sd3 = issue("sd-3", "open");
		const sd1new = issue("sd-1", "closed");
		const result = dedupJsonl(lines(sd1old, sd2, sd3, sd1new));
		expect(result).toBe(lines(sd2, sd3, sd1new));
	});

	test("dedup in the middle: first and last duplicates, unique lines sandwiched", () => {
		const sd1a = issue("sd-1", "open");
		const sd2 = issue("sd-2", "open");
		const sd1b = issue("sd-1", "closed");
		const sd3 = issue("sd-3", "open");
		const result = dedupJsonl(lines(sd1a, sd2, sd1b, sd3));
		// sd-1's last copy is sd1b; sd-2 and sd-3 survive intact
		expect(result).toBe(lines(sd2, sd1b, sd3));
	});

	test("works for plans.jsonl shape (no status field, just id)", () => {
		const p1old = plan("pl-abc", { rev: 1 });
		const p1new = plan("pl-abc", { rev: 2 });
		const result = dedupJsonl(lines(p1old, p1new));
		expect(result).toBe(`${p1new}\n`);
	});

	test("retains unparseable lines in their relative position", () => {
		const sd1 = issue("sd-1");
		const bad = "not-json";
		const sd2 = issue("sd-2");
		const result = dedupJsonl(lines(sd1, bad, sd2));
		expect(result).toBe(lines(sd1, bad, sd2));
	});

	test("retains multiple unparseable lines even when they look alike", () => {
		const result = dedupJsonl(lines("bad-line", "bad-line"));
		// both are kept because neither has a parseable id
		expect(result).toBe(lines("bad-line", "bad-line"));
	});

	test("retains lines whose id is empty string", () => {
		const noId = JSON.stringify({ id: "", status: "open" });
		const result = dedupJsonl(lines(noId, noId));
		expect(result).toBe(lines(noId, noId));
	});

	test("retains lines with a non-string id", () => {
		const numId = JSON.stringify({ id: 42, status: "open" });
		const result = dedupJsonl(lines(numId, numId));
		expect(result).toBe(lines(numId, numId));
	});

	test("retains lines with no id field at all", () => {
		const noId = JSON.stringify({ status: "open", title: "x" });
		const result = dedupJsonl(lines(noId, noId));
		expect(result).toBe(lines(noId, noId));
	});

	test("handles a mix of parseable and unparseable lines with duplicates", () => {
		const sd1a = issue("sd-1", "open");
		const sd1b = issue("sd-1", "closed");
		const bad = "broken";
		const sd2 = issue("sd-2");
		// sd-1's last is sd1b; bad is always kept; sd-2 is unique
		const result = dedupJsonl(lines(sd1a, bad, sd1b, sd2));
		expect(result).toBe(lines(bad, sd1b, sd2));
	});

	test("output always ends with newline when non-empty", () => {
		const result = dedupJsonl(issue("sd-1")); // no trailing newline in input
		expect(result.endsWith("\n")).toBe(true);
	});

	test("handles input with extra blank lines between records", () => {
		const body = `${issue("sd-1")}\n\n${issue("sd-2")}\n\n`;
		const result = dedupJsonl(body);
		expect(result).toBe(lines(issue("sd-1"), issue("sd-2")));
	});

	test("deduplicates multiple distinct ids with multiple duplicates each", () => {
		const sd1a = issue("sd-1", "open", { v: 1 });
		const sd2a = issue("sd-2", "open", { v: 1 });
		const sd1b = issue("sd-1", "open", { v: 2 });
		const sd2b = issue("sd-2", "closed", { v: 2 });
		const sd1c = issue("sd-1", "closed", { v: 3 });
		const result = dedupJsonl(lines(sd1a, sd2a, sd1b, sd2b, sd1c));
		expect(result).toBe(lines(sd2b, sd1c));
	});

	test("typical union-merge shape: concurrent agent appends resolved correctly", () => {
		// Simulates issues.jsonl after git merge=union when two runs closed
		// different seeds and also both closed sd-1 (race)
		const sd1a = issue("sd-1", "closed", { updatedAt: "2026-06-01T10:00:00Z" });
		const sd2closed = issue("sd-2", "closed");
		const sd1b = issue("sd-1", "closed", { updatedAt: "2026-06-01T10:01:00Z" });
		const sd3closed = issue("sd-3", "closed");
		const result = dedupJsonl(lines(sd1a, sd2closed, sd1b, sd3closed));
		// sd-1's last copy (sd1b with later timestamp) survives
		expect(result).toBe(lines(sd2closed, sd1b, sd3closed));
		// verify sd1a's timestamp is gone, sd1b's remains
		expect(result).toContain("10:01:00Z");
		expect(result).not.toContain("10:00:00Z");
	});
});
