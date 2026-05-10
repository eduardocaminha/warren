import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleStop, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { runsApi } from "@/api/client.ts";
import type { CancelRunResponse, ReapCompletedPayload, RunEvent } from "@/api/types.ts";
import { RUN_TERMINAL_STATES } from "@/api/types.ts";
import { StateBadge } from "@/components/StateBadge.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { useEventStream } from "@/hooks/useEventStream.ts";
import { formatTimestamp, relativeTime } from "@/lib/utils.ts";

/**
 * Event kinds whose arrival means the warren run row may have advanced
 * (state transition, cancel forwarded, reap finalized). When we observe
 * one in the live event stream we invalidate the run query so the badge
 * and metadata refresh without waiting for the polling backstop.
 */
const REFETCH_TRIGGER_KINDS: ReadonlySet<string> = new Set([
	"state_change",
	"cancel.requested",
	"reap.completed",
	"reap_failed",
]);

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

	// Invalidate the run query when an event with a state-changing kind
	// arrives. Tracked via index, not seq, so events appended out of
	// observed order would still be considered (the hook appends in seq
	// order so this is mostly a guard).
	const processedEventCountRef = useRef(0);
	useEffect(() => {
		const len = stream.events.length;
		if (len <= processedEventCountRef.current) {
			processedEventCountRef.current = len;
			return;
		}
		let trigger = false;
		for (let i = processedEventCountRef.current; i < len; i++) {
			const evt = stream.events[i];
			if (evt !== undefined && REFETCH_TRIGGER_KINDS.has(evt.kind)) {
				trigger = true;
				break;
			}
		}
		processedEventCountRef.current = len;
		if (trigger) {
			// `["runs"]` (no exact) covers both this row and the list page's
			// `["runs", filter]` cache so navigating back doesn't show stale
			// badges either.
			void qc.invalidateQueries({ queryKey: ["runs"] });
		}
	}, [stream.events, id, qc]);

	const cancel = useMutation({
		mutationFn: () => runsApi.cancel(id, {}),
		onSettled: () => qc.invalidateQueries({ queryKey: ["runs"] }),
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
	const reap = extractReapSummary(stream.events);

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
						{reap !== null && reap.branchPushed === true && reap.commitsAhead === 0 ? (
							<Badge
								variant="cancelled"
								className="font-mono text-xs"
								title="git push exited zero but the branch landed no new commits — agent did not commit (warren-f3bb)"
							>
								empty push
							</Badge>
						) : null}
						{reap !== null &&
						reap.branchPushed === true &&
						typeof reap.commitsAhead === "number" &&
						reap.commitsAhead > 0 ? (
							<Badge variant="succeeded" className="font-mono text-xs">
								+{reap.commitsAhead} commit{reap.commitsAhead === 1 ? "" : "s"}
							</Badge>
						) : null}
						{r.prUrl !== null ? (
							<a
								href={r.prUrl}
								target="_blank"
								rel="noreferrer noopener"
								className="font-mono text-xs underline underline-offset-2 text-(--color-fg) hover:text-(--color-primary)"
								title="Open the auto-opened pull request on GitHub (warren-f6af)"
							>
								PR ↗
							</a>
						) : null}
					</div>
					<p className="mt-1 text-sm text-(--color-muted-foreground)">
						<span className="font-medium">{r.agentName}</span> ·{" "}
						{r.projectId === null ? (
							<span className="italic">(deleted project)</span>
						) : (
							<span className="font-mono">{r.projectId}</span>
						)}
					</p>
				</div>
				<div className="flex flex-col items-end gap-1">
					<Button
						variant="destructive"
						onClick={() => cancel.mutate()}
						disabled={cancel.isPending || isTerminal}
					>
						<CircleStop className="h-4 w-4" />
						{cancel.isPending ? "Cancelling…" : "Cancel"}
					</Button>
					<CancelStatus mutation={cancel} />
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
				{r.prUrl !== null ? (
					<MetaCard label="Pull Request">
						<a
							href={r.prUrl}
							target="_blank"
							rel="noreferrer noopener"
							className="break-all font-mono text-xs underline underline-offset-2 hover:text-(--color-primary)"
						>
							{r.prUrl}
						</a>
					</MetaCard>
				) : null}
			</div>

			<Card>
				<CardHeader>
					<CardTitle>Prompt</CardTitle>
				</CardHeader>
				<CardContent>
					<pre className="whitespace-pre-wrap break-words rounded-md bg-(--color-muted) p-3 text-sm">
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

function CancelStatus({
	mutation,
}: {
	mutation: ReturnType<typeof useMutation<CancelRunResponse, Error, void>>;
}) {
	if (mutation.isError) {
		return (
			<p className="text-xs text-(--color-destructive)">
				{mutation.error instanceof Error
					? mutation.error.message
					: String(mutation.error)}
			</p>
		);
	}
	if (mutation.isSuccess && mutation.data !== undefined) {
		const d = mutation.data;
		if (d.alreadyTerminal) {
			return (
				<p className="text-xs text-(--color-muted-foreground)">
					Run was already terminal ({d.state}).
				</p>
			);
		}
		const burrowState = d.burrowRun?.state;
		return (
			<p className="text-xs text-emerald-700 dark:text-emerald-300">
				Cancel forwarded
				{burrowState !== undefined ? ` (burrow: ${burrowState})` : ""}.
			</p>
		);
	}
	return null;
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

/**
 * Pull the latest `reap.completed` payload off the stream so the header
 * can show whether the push actually shipped commits (warren-f3bb). The
 * run row itself doesn't carry `commitsAhead` — it lives only in the
 * event payload — so without this read the empty-push shape (push exit-0
 * against unchanged HEAD) would be visually identical to a successful
 * real-work run.
 */
function extractReapSummary(events: RunEvent[]): ReapCompletedPayload | null {
	for (let i = events.length - 1; i >= 0; i--) {
		const ev = events[i];
		if (ev?.kind !== "reap.completed") continue;
		if (ev.payload === null || typeof ev.payload !== "object" || Array.isArray(ev.payload)) {
			return null;
		}
		return ev.payload as ReapCompletedPayload;
	}
	return null;
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
