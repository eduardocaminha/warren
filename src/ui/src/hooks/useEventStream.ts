import { useEffect, useRef, useState } from "react";
import { streamRunEvents, UnauthorizedError } from "@/api/client.ts";
import type { RunEvent } from "@/api/types.ts";
import { formatError } from "@/lib/format-error";

export type StreamStatus = "idle" | "connecting" | "live" | "ended" | "error";

interface State {
	events: RunEvent[];
	status: StreamStatus;
	error: string | null;
}

/**
 * Subscribe to /runs/:id/events and accumulate the parsed NDJSON
 * envelopes. `follow=true` keeps the connection open for live tail;
 * `follow=false` replays history and closes (for terminal runs).
 *
 * Auto-reconnects with exponential backoff (max 30s) on transport
 * errors when following; UnauthorizedError aborts permanently so the
 * auth gate can boot the user back to login.
 */
export function useEventStream(runId: string, follow: boolean): State {
	const [state, setState] = useState<State>({
		events: [],
		status: "connecting",
		error: null,
	});
	const lastSeqRef = useRef<number | null>(null);

	useEffect(() => {
		let cancelled = false;
		let backoff = 500;
		const ctrl = new AbortController();

		const run = async (): Promise<void> => {
			while (!cancelled) {
				setState((s) => ({ ...s, status: "connecting", error: null }));
				try {
					const opts: { follow: boolean; signal: AbortSignal; sinceSeq?: number } = {
						follow,
						signal: ctrl.signal,
					};
					if (lastSeqRef.current !== null) opts.sinceSeq = lastSeqRef.current + 1;
					const iter = streamRunEvents(runId, opts);
					setState((s) => ({ ...s, status: "live" }));
					backoff = 500;
					for await (const evt of iter) {
						if (cancelled) break;
						lastSeqRef.current = evt.seq;
						setState((s) => ({ ...s, events: [...s.events, evt] }));
					}
					if (!cancelled) setState((s) => ({ ...s, status: "ended" }));
					return;
				} catch (err) {
					if (cancelled || ctrl.signal.aborted) return;
					if (err instanceof UnauthorizedError) {
						setState((s) => ({ ...s, status: "error", error: err.message }));
						return;
					}
					const msg = formatError(err);
					setState((s) => ({ ...s, status: "error", error: msg }));
					if (!follow) {
						return;
					}
					await new Promise((r) => setTimeout(r, backoff));
					backoff = Math.min(backoff * 2, 30_000);
				}
			}
		};
		void run();

		return () => {
			cancelled = true;
			ctrl.abort();
		};
	}, [runId, follow]);

	return state;
}
