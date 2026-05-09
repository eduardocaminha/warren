import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleStop, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { runsApi } from "@/api/client.ts";
import type { RunEvent } from "@/api/types.ts";
import { RUN_TERMINAL_STATES } from "@/api/types.ts";
import { StateBadge } from "@/components/StateBadge.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { useEventStream } from "@/hooks/useEventStream.ts";
import { formatTimestamp, relativeTime } from "@/lib/utils.ts";

export function RunDetailPage() {
	const { id = "" } = useParams<{ id: string }>();
	const qc = useQueryClient();

	const run = useQuery({
		queryKey: ["runs", id],
		queryFn: ({ signal }) => runsApi.get(id, signal),
		refetchInterval: (q) => {
			const data = q.state.data;
			if (!data) return 5000;
			return RUN_TERMINAL_STATES.includes(data.state) ? false : 3000;
		},
	});

	const isTerminal =
		run.data !== undefined && RUN_TERMINAL_STATES.includes(run.data.state);
	const stream = useEventStream(id, !isTerminal);

	const cancel = useMutation({
		mutationFn: () => runsApi.cancel(id, {}),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["runs", id] }),
	});

	if (run.isLoading) {
		return <p className="text-sm text-(--color-muted-foreground)">Loading…</p>;
	}
	if (run.isError) {
		return (
			<p className="text-sm text-(--color-destructive)">
				{run.error instanceof Error ? run.error.message : String(run.error)}
			</p>
		);
	}
	if (!run.data) return null;
	const r = run.data;

	return (
		<div className="space-y-6">
			<header className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<div className="flex items-center gap-3">
						<h1 className="font-mono text-xl font-semibold">{r.id}</h1>
						<StateBadge state={r.state} />
						{r.state === "failed" && r.failureReason !== null ? (
							<Badge variant="cancelled" className="font-mono text-xs">
								{r.failureReason}
							</Badge>
						) : null}
					</div>
					<p className="mt-1 text-sm text-(--color-muted-foreground)">
						<span className="font-medium">{r.agentName}</span> ·{" "}
						<span className="font-mono">{r.projectId}</span>
					</p>
				</div>
				<div className="flex gap-2">
					<Button
						variant="destructive"
						onClick={() => cancel.mutate()}
						disabled={cancel.isPending || isTerminal}
					>
						<CircleStop className="h-4 w-4" />
						{cancel.isPending ? "Cancelling…" : "Cancel"}
					</Button>
				</div>
			</header>

			<div className="grid gap-4 md:grid-cols-3">
				<MetaCard label="Started">{formatTimestamp(r.startedAt)}</MetaCard>
				<MetaCard label="Ended">{formatTimestamp(r.endedAt)}</MetaCard>
				<MetaCard label="Trigger">{r.trigger}</MetaCard>
				<MetaCard label="Burrow ID">
					<span className="font-mono text-xs">{r.burrowId ?? "—"}</span>
				</MetaCard>
				<MetaCard label="Burrow Run">
					<span className="font-mono text-xs">{r.burrowRunId ?? "—"}</span>
				</MetaCard>
				<MetaCard label="Updated">{relativeTime(r.endedAt ?? r.startedAt)}</MetaCard>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>Prompt</CardTitle>
				</CardHeader>
				<CardContent>
					<pre className="whitespace-pre-wrap rounded-md bg-(--color-muted) p-3 text-sm">
						{r.prompt}
					</pre>
				</CardContent>
			</Card>

			<EventTail
				events={stream.events}
				status={stream.status}
				error={stream.error}
				terminal={isTerminal}
			/>

			<SteerForm runId={r.id} disabled={isTerminal} />
		</div>
	);
}

function MetaCard({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<Card>
			<CardContent className="space-y-1 p-4">
				<div className="text-xs uppercase tracking-wide text-(--color-muted-foreground)">
					{label}
				</div>
				<div className="text-sm">{children}</div>
			</CardContent>
		</Card>
	);
}

function EventTail({
	events,
	status,
	error,
	terminal,
}: {
	events: RunEvent[];
	status: string;
	error: string | null;
	terminal: boolean;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [autoScroll, setAutoScroll] = useState(true);

	const sorted = useMemo(() => {
		const copy = [...events];
		copy.sort((a, b) => a.seq - b.seq);
		return copy;
	}, [events]);

	useEffect(() => {
		if (autoScroll && ref.current) {
			ref.current.scrollTop = ref.current.scrollHeight;
		}
	}, [autoScroll]);

	useEffect(() => {
		if (!autoScroll || !ref.current) return;
		ref.current.scrollTop = ref.current.scrollHeight;
	}, [sorted.length, autoScroll]);

	const onScroll = (e: React.UIEvent<HTMLDivElement>): void => {
		const el = e.currentTarget;
		const atBottom = el.scrollHeight - el.clientHeight - el.scrollTop < 32;
		setAutoScroll(atBottom);
	};

	return (
		<Card>
			<CardHeader className="flex-row items-center justify-between space-y-0">
				<CardTitle>Events ({sorted.length})</CardTitle>
				<div className="flex items-center gap-2">
					{terminal ? (
						<Badge variant="cancelled">terminal</Badge>
					) : (
						<Badge variant={statusVariant(status)}>{status}</Badge>
					)}
					<label className="flex items-center gap-1 text-xs text-(--color-muted-foreground)">
						<input
							type="checkbox"
							checked={autoScroll}
							onChange={(e) => setAutoScroll(e.target.checked)}
						/>
						auto-scroll
					</label>
				</div>
			</CardHeader>
			<CardContent>
				{error !== null ? (
					<p className="mb-2 text-xs text-(--color-destructive)">{error}</p>
				) : null}
				<div
					ref={ref}
					onScroll={onScroll}
					className="h-[480px] overflow-auto rounded-md border bg-(--color-muted)/30 p-2 font-mono text-xs"
				>
					{sorted.length === 0 ? (
						<p className="p-4 text-(--color-muted-foreground)">No events yet.</p>
					) : (
						sorted.map((e) => <EventLine key={e.id} event={e} />)
					)}
				</div>
			</CardContent>
		</Card>
	);
}

function statusVariant(
	s: string,
): "running" | "queued" | "succeeded" | "failed" | "cancelled" | "secondary" {
	switch (s) {
		case "live":
			return "running";
		case "connecting":
			return "queued";
		case "ended":
			return "succeeded";
		case "error":
			return "failed";
		default:
			return "secondary";
	}
}

function EventLine({ event }: { event: RunEvent }) {
	const colour =
		event.stream === "stderr"
			? "text-rose-700 dark:text-rose-300"
			: event.stream === "system"
				? "text-emerald-700 dark:text-emerald-300"
				: "text-(--color-fg)";
	const payload =
		typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload);
	return (
		<div className={`whitespace-pre-wrap break-words ${colour}`}>
			<span className="text-(--color-muted-foreground)">
				[{event.seq}] {event.kind}
				{event.stream ? ` ${event.stream}` : ""}
			</span>{" "}
			{payload}
		</div>
	);
}

function SteerForm({ runId, disabled }: { runId: string; disabled: boolean }) {
	const [body, setBody] = useState("");
	const [success, setSuccess] = useState(false);

	const steer = useMutation({
		mutationFn: () => runsApi.steer(runId, { body }),
		onSuccess: () => {
			setBody("");
			setSuccess(true);
			window.setTimeout(() => setSuccess(false), 3000);
		},
	});

	return (
		<Card>
			<CardHeader>
				<CardTitle>Steer</CardTitle>
			</CardHeader>
			<CardContent>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						if (body.trim().length === 0) return;
						steer.mutate();
					}}
					className="space-y-3"
				>
					<div className="space-y-1.5">
						<Label htmlFor="steer-body">Message</Label>
						<Textarea
							id="steer-body"
							rows={3}
							value={body}
							onChange={(e) => setBody(e.target.value)}
							disabled={disabled}
							placeholder={
								disabled
									? "Run is terminal; steering is disabled."
									: "Send a steering message to the agent's inbox."
							}
						/>
					</div>
					{steer.isError ? (
						<p className="text-sm text-(--color-destructive)">
							{steer.error instanceof Error
								? steer.error.message
								: String(steer.error)}
						</p>
					) : null}
					{success ? (
						<p className="text-sm text-emerald-700 dark:text-emerald-300">
							Steering message delivered.
						</p>
					) : null}
					<div className="flex justify-end">
						<Button
							type="submit"
							disabled={disabled || steer.isPending || body.trim().length === 0}
						>
							<Send className="h-4 w-4" />
							{steer.isPending ? "Sending…" : "Send"}
						</Button>
					</div>
				</form>
			</CardContent>
		</Card>
	);
}
