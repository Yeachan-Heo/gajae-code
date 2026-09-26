/**
 * Adapter-owned carrier for provider diagnostics on throw paths.
 *
 * A thrown provider error keeps its exact legacy message and identity; the
 * diagnostic rides alongside it in a private WeakMap so no key enumeration,
 * serialization, or downstream message parsing can observe or forge it.
 *
 * Both verbs stay behind the `adapter-internals` export block. The public
 * `../provider-diagnostic` re-reads this carrier through `peekProviderDiagnostic`
 * and returns a freshly validated snapshot, so no caller shares the stored
 * reference and reading can never create evidence.
 */

import type { ProviderDiagnostic } from "../provider-diagnostic";

const carrier = new WeakMap<object, ProviderDiagnostic>();

export function attachProviderDiagnostic<E extends object>(error: E, diagnostic: ProviderDiagnostic | undefined): E {
	try {
		if (diagnostic !== undefined) carrier.set(error, diagnostic);
	} catch {
		// A revoked proxy cannot carry a diagnostic; the legacy throw is unchanged.
	}
	return error;
}

/** Raw carrier lookup; callers must revalidate before exposing the value. */
export function peekProviderDiagnostic(error: unknown): ProviderDiagnostic | undefined {
	try {
		if (typeof error !== "object" || error === null) return undefined;
		return carrier.get(error);
	} catch {
		return undefined;
	}
}
