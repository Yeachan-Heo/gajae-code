import * as z from "zod/v4";

/** A model selector or an ordered fallback chain of selectors. */
export type ModelSelectorValue = string | readonly string[];

/**
 * Accept one validated selector or a non-empty ordered chain of validated selectors.
 * Element schemas own each configuration surface's selector grammar.
 */
export function stringOrNonEmptyArray<T extends z.ZodType<string>>(elementSchema: T) {
	return z.union([elementSchema, z.array(elementSchema).min(1)]);
}

/** Return whether a value is a non-blank selector or a non-empty selector chain. */
export function isModelSelectorValue(value: unknown): value is ModelSelectorValue {
	return (
		(typeof value === "string" && value.trim().length > 0) ||
		(Array.isArray(value) &&
			value.length > 0 &&
			value.every(item => typeof item === "string" && item.trim().length > 0))
	);
}

/**
 * Preserve compatibility with comma-delimited selector strings while flattening
 * configured chains in their declared order.
 */
export function normalizeModelSelectorValue(value: ModelSelectorValue | undefined): string[] {
	if (value === undefined) return [];
	if (typeof value === "string") {
		return value
			.split(",")
			.map(part => part.trim())
			.filter(Boolean);
	}
	if (!Array.isArray(value)) return [];
	return value
		.filter((selector): selector is string => typeof selector === "string")
		.flatMap(selector =>
			selector
				.split(",")
				.map(part => part.trim())
				.filter(Boolean),
		);
}

/** Return the first configured selector for consumers that need one selector. */
export function selectorHead(value: ModelSelectorValue | undefined): string | undefined {
	return normalizeModelSelectorValue(value)[0];
}
