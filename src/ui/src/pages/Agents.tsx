import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { useState } from "react";
import { agentsApi } from "@/api/client.ts";
import type { AgentRow } from "@/api/types.ts";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table.tsx";
import { formatTimestamp } from "@/lib/utils.ts";

export function AgentsPage() {
	const qc = useQueryClient();
	const agents = useQuery({
		queryKey: ["agents"],
		queryFn: ({ signal }) => agentsApi.list(signal),
	});
	const refresh = useMutation({
		mutationFn: () => agentsApi.refresh(),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
	});
	const [openName, setOpenName] = useState<string | null>(null);

	return (
		<div className="space-y-6">
			<header className="flex items-center justify-between">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
					<p className="text-sm text-(--color-muted-foreground)">
						Agents available for dispatch. <code>claude-code</code>,{" "}
						<code>sapling</code>, and <code>pi</code> ship inline; refresh
						re-clones the optional canopy library for custom agents.
					</p>
				</div>
				<Button
					onClick={() => refresh.mutate()}
					disabled={refresh.isPending}
					variant="outline"
				>
					<RefreshCw
						className={`h-4 w-4 ${refresh.isPending ? "animate-spin" : ""}`}
					/>
					Refresh registry
				</Button>
			</header>

			{refresh.isSuccess ? (
				<Card>
					<CardContent className="flex flex-wrap items-center gap-3 p-4 text-sm">
						<span className="font-medium">Last refresh:</span>
						<Badge variant="succeeded">
							{refresh.data.registered.length} registered
						</Badge>
						{refresh.data.skipped.length > 0 ? (
							<Badge variant="failed">{refresh.data.skipped.length} skipped</Badge>
						) : null}
						{refresh.data.removed.length > 0 ? (
							<Badge variant="cancelled">
								{refresh.data.removed.length} removed
							</Badge>
						) : null}
						<span className="text-(--color-muted-foreground)">
							{refresh.data.clone.head.slice(0, 12)}
						</span>
					</CardContent>
				</Card>
			) : null}

			{refresh.isError ? (
				<Card>
					<CardContent className="p-4 text-sm text-(--color-destructive)">
						{refresh.error instanceof Error ? refresh.error.message : String(refresh.error)}
					</CardContent>
				</Card>
			) : null}

			<Card>
				<CardHeader>
					<CardTitle>{agents.data?.agents.length ?? 0} registered</CardTitle>
				</CardHeader>
				<CardContent className="p-0">
					{agents.isLoading ? (
						<p className="p-6 text-sm text-(--color-muted-foreground)">Loading…</p>
					) : agents.isError ? (
						<p className="p-6 text-sm text-(--color-destructive)">
							{agents.error instanceof Error
								? agents.error.message
								: String(agents.error)}
						</p>
					) : agents.data?.agents.length === 0 ? (
						<p className="p-6 text-sm text-(--color-muted-foreground)">
							No agents registered. Built-in <code>claude-code</code>,{" "}
							<code>sapling</code>, and <code>pi</code> should appear here
							automatically — if not, check <code>warren doctor</code>. To layer
							a custom canopy library on top, set <code>CANOPY_REPO_URL</code> and
							click <strong>Refresh registry</strong>.
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="w-8" />
									<TableHead>Name</TableHead>
									<TableHead>Registered</TableHead>
									<TableHead>Last refreshed</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{agents.data?.agents.map((a) => (
									<AgentDisplayRow
										key={a.name}
										agent={a}
										open={openName === a.name}
										onToggle={() =>
											setOpenName(openName === a.name ? null : a.name)
										}
									/>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>
		</div>
	);
}

function AgentDisplayRow({
	agent,
	open,
	onToggle,
}: {
	agent: AgentRow;
	open: boolean;
	onToggle: () => void;
}) {
	return (
		<>
			<TableRow className="cursor-pointer" onClick={onToggle}>
				<TableCell>
					{open ? (
						<ChevronDown className="h-4 w-4" />
					) : (
						<ChevronRight className="h-4 w-4" />
					)}
				</TableCell>
				<TableCell className="font-medium">{agent.name}</TableCell>
				<TableCell className="text-(--color-muted-foreground)">
					{formatTimestamp(agent.registeredAt)}
				</TableCell>
				<TableCell className="text-(--color-muted-foreground)">
					{formatTimestamp(agent.lastRefreshed)}
				</TableCell>
			</TableRow>
			{open ? (
				<TableRow>
					<TableCell colSpan={4} className="bg-(--color-muted)/30 max-w-0">
						<AgentDefinitionPanel agent={agent} />
					</TableCell>
				</TableRow>
			) : null}
		</>
	);
}

interface RenderedAgent {
	name?: string;
	version?: number;
	sections?: Record<string, unknown>;
	resolvedFrom?: unknown[];
	frontmatter?: Record<string, unknown>;
}

function readRenderedAgent(raw: unknown): RenderedAgent {
	if (typeof raw !== "object" || raw === null) return {};
	return raw as RenderedAgent;
}

function readStringField(obj: Record<string, unknown> | undefined, key: string): string | null {
	if (!obj) return null;
	const v = obj[key];
	return typeof v === "string" && v.length > 0 ? v : null;
}

function readTags(frontmatter: Record<string, unknown> | undefined): string[] {
	if (!frontmatter) return [];
	const v = frontmatter.tags;
	if (!Array.isArray(v)) return [];
	return v.filter((t): t is string => typeof t === "string" && t.length > 0);
}

function AgentDefinitionPanel({ agent }: { agent: AgentRow }) {
	const def = readRenderedAgent(agent.renderedJson);
	const [showRaw, setShowRaw] = useState(false);
	const provider = readStringField(def.frontmatter, "provider");
	const model = readStringField(def.frontmatter, "model");
	const tags = readTags(def.frontmatter);
	const sectionEntries = Object.entries(def.sections ?? {});
	const resolvedFrom = (def.resolvedFrom ?? []).filter(
		(s): s is string => typeof s === "string" && s.length > 0,
	);

	return (
		<div className="space-y-4 break-words">
			<dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3 lg:grid-cols-4">
				<MetaField label="Name" value={def.name ?? agent.name} mono />
				<MetaField
					label="Version"
					value={typeof def.version === "number" ? String(def.version) : "—"}
					mono
				/>
				<MetaField label="Source" value={agent.source ?? "—"} />
				<MetaField label="Provider" value={provider ?? "—"} mono />
				<MetaField label="Model" value={model ?? "—"} mono />
				<div>
					<dt className="text-(--color-muted-foreground)">Tags</dt>
					<dd className="mt-1 flex flex-wrap gap-1">
						{tags.length === 0 ? (
							<span className="text-(--color-muted-foreground)">—</span>
						) : (
							tags.map((t) => (
								<Badge key={t} variant="secondary">
									{t}
								</Badge>
							))
						)}
					</dd>
				</div>
			</dl>

			{resolvedFrom.length > 0 ? (
				<div className="text-xs text-(--color-muted-foreground)">
					<span className="font-medium">Resolved from:</span>{" "}
					<span className="font-mono break-all">{resolvedFrom.join(" → ")}</span>
				</div>
			) : null}

			{sectionEntries.length === 0 ? (
				<p className="text-xs text-(--color-muted-foreground)">No sections.</p>
			) : (
				<div className="space-y-2">
					{sectionEntries.map(([name, body]) => (
						<details
							key={name}
							open={name === "system"}
							className="group rounded-md border border-(--color-border) bg-(--color-card)"
						>
							<summary className="flex cursor-pointer items-center gap-1 px-3 py-2 text-xs font-medium select-none [&::-webkit-details-marker]:hidden">
								<ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
								{sectionLabel(name)}
							</summary>
							<pre className="max-h-[420px] overflow-auto px-3 pt-0 pb-3 font-mono text-xs whitespace-pre-wrap break-words">
								{typeof body === "string" ? body : JSON.stringify(body, null, 2)}
							</pre>
						</details>
					))}
				</div>
			)}

			<div>
				<Button
					variant="outline"
					size="sm"
					onClick={() => setShowRaw((v) => !v)}
					className="h-7 text-xs"
				>
					{showRaw ? "Hide raw JSON" : "View raw JSON"}
				</Button>
				{showRaw ? (
					<pre className="mt-2 max-h-[420px] overflow-auto rounded-md bg-(--color-card) p-3 text-xs whitespace-pre-wrap break-words">
						{JSON.stringify(agent.renderedJson, null, 2)}
					</pre>
				) : null}
			</div>
		</div>
	);
}

function MetaField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
	return (
		<div>
			<dt className="text-(--color-muted-foreground)">{label}</dt>
			<dd className={`mt-1 ${mono ? "font-mono" : ""} break-all`}>{value}</dd>
		</div>
	);
}

function sectionLabel(name: string): string {
	if (name === "system") return "System prompt";
	return name;
}
