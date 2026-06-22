/**
 * Hand-rolled Prometheus text-format (v0.0.4) encoder (warren observability
 * Phase 1).
 *
 * Deliberately dependency-free — warren's low-dep + knip-strict ethos makes a
 * tiny pure encoder cleaner than pulling `prom-client` server-side. Emits the
 * exposition format Fly's managed Prometheus scrapes: one `# HELP` + `# TYPE`
 * pair per metric family, then one sample line per label-set. Label values are
 * escaped per the spec (backslash, double-quote, newline).
 *
 * Pure: `renderPrometheus` takes a fully-resolved metric list and returns the
 * body string. The `/metrics` handler is responsible for collecting live
 * gauges + counter snapshots into this shape.
 */

export type PromType = "gauge" | "counter";

export interface PromSample {
	readonly labels?: Readonly<Record<string, string>>;
	readonly value: number;
}

export interface PromMetric {
	readonly name: string;
	readonly help: string;
	readonly type: PromType;
	readonly samples: readonly PromSample[];
}

/** Prometheus text exposition content type (version 0.0.4). */
export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

export function renderPrometheus(metrics: readonly PromMetric[]): string {
	const lines: string[] = [];
	for (const metric of metrics) {
		lines.push(`# HELP ${metric.name} ${escapeHelp(metric.help)}`);
		lines.push(`# TYPE ${metric.name} ${metric.type}`);
		for (const sample of metric.samples) {
			lines.push(`${metric.name}${renderLabels(sample.labels)} ${renderValue(sample.value)}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

function renderLabels(labels: Readonly<Record<string, string>> | undefined): string {
	if (labels === undefined) return "";
	const entries = Object.entries(labels).filter(([, v]) => v !== undefined);
	if (entries.length === 0) return "";
	const inner = entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(",");
	return `{${inner}}`;
}

function renderValue(value: number): string {
	if (Number.isNaN(value)) return "NaN";
	if (value === Number.POSITIVE_INFINITY) return "+Inf";
	if (value === Number.NEGATIVE_INFINITY) return "-Inf";
	return String(value);
}

function escapeLabelValue(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function escapeHelp(help: string): string {
	return help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}
