/**
 * Deterministic prompt-prefix stability checker.
 *
 * Implements the approved prefix-stability invariant as a pure function over a
 * sequence of provider-facing turns. Within a cache epoch the provider-facing
 * prefix (system prompt + tools + leading context), the model id, and the cache
 * key must stay byte-identical; only appended conversation content may change.
 * A new epoch begins only at a sanctioned reset boundary carrying an explicit
 * reset marker. Any other mid-epoch prefix/model/cache-key change is a
 * violation. The suite asserts ONLY against this policy, so its scope cannot
 * balloon into a compaction rewrite.
 */

import { createHash } from "node:crypto";

/** A single provider-facing turn observed during a (real or simulated) run. */
export interface PrefixTurn {
	/** 1-based turn index within the session. */
	turn: number;
	/** The provider-facing prefix bytes (system + tools + leading context). */
	prefix: string;
	/** Model id used for this turn. */
	model: string;
	/** Prompt-cache key / session id used for this turn. */
	cacheKey: string;
	/**
	 * Present only when this turn deliberately opens a new cache epoch at a
	 * sanctioned reset boundary (pre-first-call is implicit for turn 1).
	 */
	resetMarker?: PrefixResetMarker;
}

/** Recorded justification for a sanctioned mid-session prefix reset. */
export interface PrefixResetMarker {
	reason: "compaction" | "session-reset" | "deliberate-reset";
	priorPrefixHash?: string;
	newPrefixHash?: string;
}

export type PrefixViolationKind = "prefix-mutation" | "model-switch" | "cache-key-change";

export interface PrefixViolation {
	turn: number;
	epoch: number;
	kind: PrefixViolationKind;
	detail: string;
}

export interface PrefixStabilityResult {
	stable: boolean;
	/** Number of cache epochs observed (1 + sanctioned resets). */
	epochs: number;
	violations: readonly PrefixViolation[];
}

/** Stable SHA-256 hex hash of a provider-facing prefix. */
export function hashPrefix(prefix: string): string {
	return createHash("sha256").update(prefix, "utf8").digest("hex");
}

interface EpochAnchor {
	prefixHash: string;
	model: string;
	cacheKey: string;
}

/**
 * Check a turn sequence against the prefix-stability policy.
 *
 * Turn 1 establishes the first epoch implicitly. A later turn carrying a
 * `resetMarker` opens a new epoch (no violation). Any later turn WITHOUT a reset
 * marker whose prefix hash, model, or cache key differs from its epoch anchor is
 * a violation.
 */
export function checkPrefixStability(turns: readonly PrefixTurn[]): PrefixStabilityResult {
	const violations: PrefixViolation[] = [];
	let epoch = 0;
	let anchor: EpochAnchor | undefined;

	for (const turn of turns) {
		const current: EpochAnchor = {
			prefixHash: hashPrefix(turn.prefix),
			model: turn.model,
			cacheKey: turn.cacheKey,
		};

		if (anchor === undefined || turn.resetMarker !== undefined) {
			epoch += 1;
			anchor = current;
			continue;
		}

		if (current.prefixHash !== anchor.prefixHash) {
			violations.push({
				turn: turn.turn,
				epoch,
				kind: "prefix-mutation",
				detail: `prefix hash changed within epoch ${epoch} without a reset marker`,
			});
		}
		if (current.model !== anchor.model) {
			violations.push({
				turn: turn.turn,
				epoch,
				kind: "model-switch",
				detail: `model switched from ${anchor.model} to ${current.model} within epoch ${epoch}`,
			});
		}
		if (current.cacheKey !== anchor.cacheKey) {
			violations.push({
				turn: turn.turn,
				epoch,
				kind: "cache-key-change",
				detail: `cache key changed within epoch ${epoch} without a reset marker`,
			});
		}
	}

	return {
		stable: violations.length === 0,
		epochs: epoch,
		violations,
	};
}
