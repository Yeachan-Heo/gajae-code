/**
 * Throw-proof error description.
 *
 * Hostile or exotic thrown values can make `String(value)` throw (a `toString`
 * that throws, a revoked proxy, a null-prototype object) and a `message` getter
 * can throw too. Logging or recording a failure must never become a second
 * failure, so every failure path that stringifies a caught value uses this.
 *
 * @example
 * ```ts
 * import { safeErrorDescription } from "@gajae-code/utils";
 *
 * try {
 *     await risky();
 * } catch (error) {
 *     logger.warn("risky failed", { error: safeErrorDescription(error) });
 * }
 * ```
 */
export function safeErrorDescription(value: unknown): string {
	let isError = false;
	try {
		isError = value instanceof Error;
	} catch {
		// Hostile proxies can throw from getPrototypeOf during instanceof.
	}
	if (isError) {
		try {
			const message = (value as { message?: unknown }).message;
			if (typeof message === "string") return message;
		} catch {
			// Hostile error getters must not replace the primary failure.
		}
	}
	try {
		return String(value);
	} catch {
		return "<unprintable error>";
	}
}
