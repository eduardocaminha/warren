export const DEFAULT_SD_TIMEOUT_MS = 30_000;

export function truncateSdOutput(raw: string, limit = 500): string {
	const trimmed = raw.trim();
	if (trimmed.length <= limit) return trimmed;
	return `${trimmed.slice(0, limit)}… [truncated]`;
}
