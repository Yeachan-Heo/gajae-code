import type { VerificationMetadata } from "../documents/frontmatter";
import { invalidInput, type MemoryResult } from "../errors";
import type { MemoryClaim, VolatileClaim, Volatility } from "../index";

const VOLATILITY_SCORES: Readonly<Record<Volatility, number>> = Object.freeze({
	stable: 1,
	historical: 0.85,
	volatile: 0.65,
});

const VOLATILITY_PENALTIES: Readonly<Record<Volatility, number>> = Object.freeze({
	stable: 0,
	historical: 0.15,
	volatile: 0.35,
});

function invalid(detail: string): MemoryResult<never> {
	return invalidInput(`volatility: ${detail}`);
}

function isVolatility(value: unknown): value is Volatility {
	return value === "stable" || value === "historical" || value === "volatile";
}

function validVerification(value: VerificationMetadata | null | undefined): MemoryResult<VerificationMetadata | null> {
	if (value === undefined || value === null) return { ok: true, value: null };
	if (
		typeof value !== "object" ||
		typeof value.provider !== "string" ||
		typeof value.resource !== "string" ||
		typeof value.id !== "string"
	) {
		return invalid("verification metadata is malformed");
	}
	const provider = value.provider.normalize("NFC").trim();
	const resource = value.resource.normalize("NFC").trim();
	const id = value.id.normalize("NFC").trim();
	if (provider.length === 0 || resource.length === 0 || id.length === 0) {
		return invalid("verification metadata fields must be non-empty");
	}
	return {
		ok: true,
		value: Object.freeze({ provider, resource, id }),
	};
}

function validClaim(value: MemoryClaim): MemoryResult<MemoryClaim> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("claim is malformed");
	if (typeof value.text !== "string" || value.text.normalize("NFC").trim().length === 0) {
		return invalid("claim text must be non-empty");
	}
	if (!isVolatility(value.volatility)) return invalid("claim volatility is unknown");
	return { ok: true, value };
}

/** Return a multiplicative score that only lowers volatile or historical claims. */
export function volatilityScore(volatility: Volatility): number {
	return VOLATILITY_SCORES[volatility] ?? 0;
}

/** Return a non-negative penalty; stable claims have no penalty. */
export function volatilityPenalty(volatility: Volatility): number {
	return VOLATILITY_PENALTIES[volatility] ?? 1;
}

/** Compare volatility only after higher-priority dimensions have been compared. */
export function compareVolatility(left: Volatility, right: Volatility): number {
	const leftScore = volatilityScore(left);
	const rightScore = volatilityScore(right);
	if (leftScore > rightScore) return 1;
	if (leftScore < rightScore) return -1;
	return 0;
}

/** Derive the public volatile-claim shape from a claim and optional document metadata. */
export function toVolatileClaim(
	claim: MemoryClaim,
	verification?: VerificationMetadata | null,
): MemoryResult<VolatileClaim> {
	const valid = validClaim(claim);
	if (!valid.ok) return valid;
	const hint = validVerification(verification);
	if (!hint.ok) return hint;
	const isVolatile = valid.value.volatility === "volatile";
	return {
		ok: true,
		value: Object.freeze({
			claim: valid.value.text.normalize("NFC"),
			verificationRequired: isVolatile,
			verificationHint: isVolatile ? hint.value : null,
		}),
	};
}
