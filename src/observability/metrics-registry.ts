/**
 * In-process counter registry feeding the Prometheus `/metrics` endpoint
 * (warren observability Phase 1).
 *
 * Counters are monotonic process-lifetime totals (e.g. log lines by level,
 * scheduler failures). They live in memory only — warren is single-instance
 * (one Fly Machine), so Fly's managed Prometheus scrapes the live process and
 * a deploy resets the counters to zero, which Grafana's `rate()`/`increase()`
 * handle correctly via the counter-reset semantics. Gauges (runs-by-state,
 * cost, active bridges) are NOT stored here; the `/metrics` handler reads
 * those live from SQLite + the bridge registry at scrape time.
 *
 * Labels are serialized to a canonical key so `increment("x", {a:"1"})` and a
 * later call with the same name+labels accumulate onto one series. The label
 * order in the key is sorted so callers needn't pass a stable order.
 */

export interface CounterSnapshot {
	readonly name: string;
	readonly labels: Readonly<Record<string, string>>;
	readonly value: number;
}

interface CounterCell {
	readonly name: string;
	readonly labels: Record<string, string>;
	value: number;
}

export class MetricsRegistry {
	private readonly counters = new Map<string, CounterCell>();

	increment(name: string, labels: Readonly<Record<string, string>> = {}, by = 1): void {
		if (by <= 0) return;
		const sorted = sortLabels(labels);
		const key = `${name}\u0000${canonicalLabelKey(sorted)}`;
		const existing = this.counters.get(key);
		if (existing === undefined) {
			this.counters.set(key, { name, labels: sorted, value: by });
		} else {
			existing.value += by;
		}
	}

	snapshot(): CounterSnapshot[] {
		return [...this.counters.values()]
			.map((c) => ({ name: c.name, labels: { ...c.labels }, value: c.value }))
			.sort((a, b) => a.name.localeCompare(b.name) || compareLabels(a.labels, b.labels));
	}
}

function sortLabels(labels: Readonly<Record<string, string>>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of Object.keys(labels).sort()) {
		const value = labels[key];
		if (value !== undefined) out[key] = value;
	}
	return out;
}

function canonicalLabelKey(labels: Record<string, string>): string {
	return Object.entries(labels)
		.map(([k, v]) => `${k}=${v}`)
		.join(",");
}

function compareLabels(a: Record<string, string>, b: Record<string, string>): number {
	return canonicalLabelKey(a).localeCompare(canonicalLabelKey(b));
}
