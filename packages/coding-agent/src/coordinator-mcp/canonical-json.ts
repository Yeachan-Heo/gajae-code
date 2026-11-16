/**
 * Byte-stable JSON for coordinator idempotency and outbox digests: keys are
 * sorted by code unit. Unlike `sdk/broker/canonical-json.ts` it does not omit
 * `undefined` properties, so persisted digests of the same value stay stable
 * across both the server and question-state writers.
 */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}
