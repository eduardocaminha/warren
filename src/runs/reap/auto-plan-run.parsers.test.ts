import { describe, expect, test } from "bun:test";
import { parsePlanChildren, parsePlanIds } from "./auto-plan-run.ts";

describe("parsePlanIds", () => {
	test("empty string returns empty set", () => {
		expect(parsePlanIds("")).toEqual(new Set());
	});

	test("whitespace-only string returns empty set", () => {
		expect(parsePlanIds("   \n  \n")).toEqual(new Set());
	});

	test("single valid plan returns its id", () => {
		const body = '{"id":"pl-abc","status":"approved","children":["x1"]}\n';
		expect(parsePlanIds(body)).toEqual(new Set(["pl-abc"]));
	});

	test("multiple valid plans return all ids", () => {
		const body = '{"id":"pl-a","children":["x1"]}\n' + '{"id":"pl-b","children":["x2","x3"]}\n';
		expect(parsePlanIds(body)).toEqual(new Set(["pl-a", "pl-b"]));
	});

	test("skips malformed JSON lines and parses the rest", () => {
		const body = 'not-json\n{"id":"pl-good"}\n{broken\n{"id":"pl-also-good"}\n';
		expect(parsePlanIds(body)).toEqual(new Set(["pl-good", "pl-also-good"]));
	});

	test("skips lines missing the id field", () => {
		const body = '{"status":"approved","children":["x1"]}\n{"id":"pl-has-id"}\n';
		expect(parsePlanIds(body)).toEqual(new Set(["pl-has-id"]));
	});

	test("skips lines where id is not a string", () => {
		const body = '{"id":42}\n{"id":null}\n{"id":true}\n{"id":"pl-real"}\n';
		expect(parsePlanIds(body)).toEqual(new Set(["pl-real"]));
	});

	test("skips lines where id is an empty string", () => {
		const body = '{"id":""}\n{"id":"pl-nonempty"}\n';
		expect(parsePlanIds(body)).toEqual(new Set(["pl-nonempty"]));
	});

	test("skips JSON arrays and primitives at the top level", () => {
		const body = '["not","an","object"]\n42\n"string"\nnull\n{"id":"pl-obj"}\n';
		expect(parsePlanIds(body)).toEqual(new Set(["pl-obj"]));
	});

	test("deduplicates repeated plan ids", () => {
		const body = '{"id":"pl-dup"}\n{"id":"pl-dup"}\n{"id":"pl-other"}\n';
		expect(parsePlanIds(body)).toEqual(new Set(["pl-dup", "pl-other"]));
	});
});

describe("parsePlanChildren", () => {
	test("empty string returns empty array", () => {
		expect(parsePlanChildren("", "pl-x")).toEqual([]);
	});

	test("whitespace-only string returns empty array", () => {
		expect(parsePlanChildren("   \n  \n", "pl-x")).toEqual([]);
	});

	test("plan id not found returns empty array", () => {
		const body = '{"id":"pl-other","children":["x1","x2"]}\n';
		expect(parsePlanChildren(body, "pl-missing")).toEqual([]);
	});

	test("returns children for matching plan id", () => {
		const body = '{"id":"pl-target","children":["warren-a1","warren-a2"]}\n';
		expect(parsePlanChildren(body, "pl-target")).toEqual(["warren-a1", "warren-a2"]);
	});

	test("returns children of the correct plan when multiple plans present", () => {
		const body =
			'{"id":"pl-a","children":["warren-a1"]}\n' +
			'{"id":"pl-b","children":["warren-b1","warren-b2"]}\n';
		expect(parsePlanChildren(body, "pl-b")).toEqual(["warren-b1", "warren-b2"]);
	});

	test("returns empty array when plan has no children field", () => {
		const body = '{"id":"pl-x","status":"approved"}\n';
		expect(parsePlanChildren(body, "pl-x")).toEqual([]);
	});

	test("returns empty array when children field is null", () => {
		const body = '{"id":"pl-x","children":null}\n';
		expect(parsePlanChildren(body, "pl-x")).toEqual([]);
	});

	test("returns empty array when children field is not an array", () => {
		const body = '{"id":"pl-x","children":"warren-c1"}\n';
		expect(parsePlanChildren(body, "pl-x")).toEqual([]);
	});

	test("filters out non-string children entries", () => {
		const body = '{"id":"pl-x","children":["warren-c1",42,null,true,"warren-c2"]}\n';
		expect(parsePlanChildren(body, "pl-x")).toEqual(["warren-c1", "warren-c2"]);
	});

	test("filters out empty-string children entries", () => {
		const body = '{"id":"pl-x","children":["warren-c1","","warren-c2"]}\n';
		expect(parsePlanChildren(body, "pl-x")).toEqual(["warren-c1", "warren-c2"]);
	});

	test("skips malformed JSON lines and finds the target plan", () => {
		const body = "not-json\n" + '{"id":"pl-x","children":["warren-c1"]}\n' + "{broken\n";
		expect(parsePlanChildren(body, "pl-x")).toEqual(["warren-c1"]);
	});

	test("skips JSON arrays and primitives at the top level", () => {
		const body = '["array"]\n42\nnull\n"string"\n{"id":"pl-x","children":["warren-c1"]}\n';
		expect(parsePlanChildren(body, "pl-x")).toEqual(["warren-c1"]);
	});

	test("stops at first matching plan id (returns first match)", () => {
		const body =
			'{"id":"pl-x","children":["warren-first"]}\n' +
			'{"id":"pl-x","children":["warren-second"]}\n';
		expect(parsePlanChildren(body, "pl-x")).toEqual(["warren-first"]);
	});
});
