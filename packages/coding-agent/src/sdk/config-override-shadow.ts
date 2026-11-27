import type { Settings } from "../config/settings";

/** Capture the settings values a config patch is allowed to shadow. */
export function captureConfigOverridesShadow(
	settings: Settings,
	configOverrides: Map<string, unknown>,
): Map<string, unknown> {
	const before = new Map<string, unknown>();
	for (const key of configOverrides.keys()) {
		try {
			before.set(key, settings.get(key as never));
		} catch {
			before.set(key, undefined);
		}
	}
	return before;
}

/** Drop patches whose underlying setting changed while the operation was in flight. */
export function reconcileConfigOverridesShadow(
	settings: Settings,
	configOverrides: Map<string, unknown>,
	before: ReadonlyMap<string, unknown>,
): void {
	for (const [key, prior] of before) {
		let current: unknown;
		try {
			current = settings.get(key as never);
		} catch {
			current = undefined;
		}
		if (!deepStructuralEqual(current, prior)) configOverrides.delete(key);
	}
}

function deepStructuralEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) && Array.isArray(right))
		return left.length === right.length && left.every((value, index) => deepStructuralEqual(value, right[index]));
	if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	const leftKeys = Object.keys(leftRecord);
	const rightKeys = Object.keys(rightRecord);
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every(key => deepStructuralEqual(leftRecord[key], rightRecord[key]))
	);
}
