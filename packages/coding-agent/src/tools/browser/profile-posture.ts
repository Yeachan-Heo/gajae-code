/**
 * Auto-default profile-reuse posture decision (plan Phase 2, Intent Reconciliation).
 *
 * User-confirmed policy: when a usable real Chrome profile is available, the
 * browser tool uses it automatically (AUTO), emits a warning, and falls back to
 * synthetic stealth when unavailable. The posture is overridable via a setting.
 * This is pure decision logic (no browser, no filesystem side effects) so the
 * launch/attach layer can call it and it can be unit-tested deterministically.
 */

/** Configured posture: `auto` (default) prefers the real profile; `opt-in` stays synthetic unless explicitly asked. */
export type ProfileReusePosture = "auto" | "opt-in";

export const DEFAULT_PROFILE_REUSE_POSTURE: ProfileReusePosture = "auto";

export interface PostureInputs {
	/** Configured posture; defaults to `auto` when unset. */
	posture?: ProfileReusePosture;
	/** A usable real Chrome profile was detected and is attachable/safe to copy. */
	realProfileAvailable: boolean;
	/** Caller explicitly requested real-profile reuse for this run (e.g. app.browser === "chrome"). */
	explicitlyRequested?: boolean;
}

export interface PostureDecision {
	/** `real` = use the (isolated copy of the) real profile; `synthetic` = synthetic stealth session. */
	mode: "real" | "synthetic";
	/** User-facing warning to emit when real credentials/state are about to be used. */
	warning: string | null;
	/** Machine-readable reason for logs/audit. */
	reason: "auto-real" | "explicit-real" | "synthetic-fallback" | "synthetic-opt-in";
}

/**
 * Decide whether to reuse the real profile or run synthetic.
 *
 * - `auto` + available            -> real (with warning)
 * - `opt-in` + explicitly asked   -> real (with warning)
 * - `opt-in` (no explicit ask)    -> synthetic
 * - not available                 -> synthetic (fallback), even under `auto`
 */
export function decideProfilePosture(inputs: PostureInputs): PostureDecision {
	const posture = inputs.posture ?? DEFAULT_PROFILE_REUSE_POSTURE;
	const warning =
		"Using an isolated copy of your real Chrome profile (cookies/session/cache) for stealth. " +
		"Real logged-in credentials may be exercised on visited pages. Set browser.profileReuse to 'opt-in' to disable.";

	if (!inputs.realProfileAvailable) {
		return { mode: "synthetic", warning: null, reason: "synthetic-fallback" };
	}
	if (posture === "auto") {
		return { mode: "real", warning, reason: "auto-real" };
	}
	// opt-in
	if (inputs.explicitlyRequested) {
		return { mode: "real", warning, reason: "explicit-real" };
	}
	return { mode: "synthetic", warning: null, reason: "synthetic-opt-in" };
}
