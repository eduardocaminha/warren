/**
 * Shared response constructors.
 *
 * Centralising Content-Type and encoding here keeps every handler on
 * the same wire shape — and gives tests one seam to assert on. The
 * NDJSON helper preserves backpressure: the source generator is only
 * consumed when the wire pulls more bytes, so a slow client doesn't
 * make warren buffer the whole event log in memory.
 */

const JSON_CT = "application/json; charset=utf-8";
const NDJSON_CT = "application/x-ndjson";

export function jsonResponse(status: number, body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		status,
		...init,
		headers: mergeHeaders(init?.headers, { "content-type": JSON_CT }),
	});
}

export function textResponse(status: number, body: string, contentType: string): Response {
	return new Response(body, {
		status,
		headers: { "content-type": contentType },
	});
}

export function ndjsonResponse(stream: ReadableStream<Uint8Array>, init?: ResponseInit): Response {
	return new Response(stream, {
		status: 200,
		...init,
		headers: mergeHeaders(init?.headers, {
			"content-type": NDJSON_CT,
			"cache-control": "no-store",
		}),
	});
}

function mergeHeaders(
	provided: HeadersInit | undefined,
	defaults: Record<string, string>,
): Headers {
	const headers = new Headers(provided);
	for (const [key, value] of Object.entries(defaults)) {
		if (!headers.has(key)) headers.set(key, value);
	}
	return headers;
}
