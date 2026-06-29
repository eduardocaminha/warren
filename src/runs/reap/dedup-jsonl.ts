/**
 * Deduplicates a JSONL string by the `id` field, keeping the last occurrence
 * of each id (last-write-wins). Preserves the relative order of surviving
 * lines; unparseable lines are retained as-is.
 *
 * Intended for use after a git `merge=union` rebase on `.seeds/issues.jsonl`
 * and `.seeds/plans.jsonl`. Concurrent appends produce duplicate `id` rows in
 * those files; this pass collapses them down to the last writer's copy.
 *
 * Callers are responsible for pinning calls to the known seed JSONL carriers
 * (`issues.jsonl`, `plans.jsonl`). The `id` uniqueness invariant only holds
 * for those files; applying last-write-wins dedup to an arbitrary JSONL
 * format risks silent data loss.
 */
export function dedupJsonl(body: string): string {
	const lines = splitNonEmpty(body);
	if (lines.length === 0) return "";
	const lastIndex = buildLastIndexMap(lines);
	const result = filterToLastOccurrence(lines, lastIndex);
	return result.length === 0 ? "" : `${result.join("\n")}\n`;
}

function splitNonEmpty(body: string): string[] {
	const out: string[] = [];
	for (const raw of body.split("\n")) {
		const trimmed = raw.trim();
		if (trimmed !== "") out.push(trimmed);
	}
	return out;
}

function buildLastIndexMap(lines: string[]): Map<string, number> {
	const map = new Map<string, number>();
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line === undefined) continue;
		const id = extractId(line);
		if (id !== null) map.set(id, i);
	}
	return map;
}

function filterToLastOccurrence(lines: string[], lastIndex: Map<string, number>): string[] {
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line === undefined) continue;
		const id = extractId(line);
		if (id === null || lastIndex.get(id) === i) out.push(line);
	}
	return out;
}

function extractId(line: string): string | null {
	try {
		const parsed: unknown = JSON.parse(line);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const id = (parsed as Record<string, unknown>).id;
		return typeof id === "string" && id.length > 0 ? id : null;
	} catch {
		return null;
	}
}
