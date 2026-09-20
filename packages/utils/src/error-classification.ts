/**
 * Cross-package classification for errors that describe an expected outcome
 * rather than an unexpected failure.
 *
 * The symbol is registered globally so the marker survives package duplication
 * and worker/VM boundaries without relying on a particular Error constructor.
 */
export const DESIGNED_ERROR = Symbol.for("gajae-code.designed-error");

type MarkedError = object & { readonly [DESIGNED_ERROR]?: unknown };

/** Mark an Error as a designed outcome before it crosses package boundaries. */
export function markDesignedError<T extends Error>(error: T): T {
	Object.defineProperty(error, DESIGNED_ERROR, {
		configurable: false,
		enumerable: false,
		value: true,
		writable: false,
	});
	return error;
}

/** Return true when a throwable is explicitly marked or carries a known tool-error name. */
export function isDesignedError(error: unknown): boolean {
	if ((typeof error !== "object" && typeof error !== "function") || error === null) return false;
	try {
		if ((error as MarkedError)[DESIGNED_ERROR] === true) return true;
		const name = (error as { readonly name?: unknown }).name;
		return name === "ToolError" || name === "ToolAbortError";
	} catch {
		return false;
	}
}
