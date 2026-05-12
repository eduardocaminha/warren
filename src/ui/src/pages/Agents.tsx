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
						Agents available for dispatch. <code>claude-code</code> and{" "}
						<code>sapling</code> ship inline; refresh re-clones the optional canopy
						library for custom agents.
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
							No agents registered. Built-in <code>claude-code</code> and{" "}
							<code>sapling</code> should appear here automatically — if not, check{" "}
							<code>warren doctor</code>. To layer a custom canopy library on top,
							set <code>CANOPY_REPO_URL</code> and click{" "}
							<strong>Refresh registry</strong>.
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
					<TableCell colSpan={4} className="bg-(--color-muted)/30">
						<pre className="max-h-[420px] overflow-auto rounded-md bg-(--color-card) p-3 text-xs">
							{JSON.stringify(agent.renderedJson, null, 2)}
						</pre>
					</TableCell>
				</TableRow>
			) : null}
		</>
	);
}
