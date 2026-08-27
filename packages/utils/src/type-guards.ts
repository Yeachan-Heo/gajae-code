export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}

export function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

/**
 * Placeholder tokens a model emits when it has no real content to put in a
 * required string. Shared so the ask contract screen and the ultragoal evidence
 * screen cannot drift apart (#5002 review B5 — `unused` existed in only one).
 */
export const PLACEHOLDER_TOKENS = [
	"unused",
	"todo",
	"tbd",
	"n/a",
	"na",
	"none",
	"placeholder",
	"empty",
	"stub",
] as const;

/** True when a trimmed, lowercased string is exactly one placeholder token. */
export function isPlaceholderToken(value: string): boolean {
	return (PLACEHOLDER_TOKENS as readonly string[]).includes(value.trim().toLowerCase());
}
