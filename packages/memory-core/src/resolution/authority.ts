import { parseMemoryUri } from "../documents/uri";
import { invalidInput, type MemoryResult } from "../errors";
import type { AuthorityTier, MemoryClaim, MemoryScopeKind } from "../index";
import { compareVolatility } from "./volatility";

const AUTHORITY_TIERS: readonly AuthorityTier[] = Object.freeze([
	"user-confirmed",
	"repository-reviewed",
	"project-config",
	"tool-verified",
	"session-observed",
	"model-inferred",
	"unverified",
]);

const SCOPES: readonly MemoryScopeKind[] = Object.freeze(["session", "project", "global"]);
const DOCUMENT_TYPES = Object.freeze([
	"preference",
	"constraint",
	"policy",
	"convention",
	"decision",
	"fact",
	"observation",
	"hypothesis",
	"task-state",
	"handoff",
	"checkpoint",
	"note",
] as const);
const VOLATILITIES = Object.freeze(["stable", "volatile", "historical"] as const);
const STRICT_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left.normalize("NFC"), "utf8"), Buffer.from(right.normalize("NFC"), "utf8"));
}

function invalid(detail: string): MemoryResult<never> {
	return invalidInput(`authority: ${detail}`);
}

function authorityRank(value: AuthorityTier): number {
	const index = AUTHORITY_TIERS.indexOf(value);
	return index < 0 ? AUTHORITY_TIERS.length : index;
}

function scopeRank(value: MemoryScopeKind): number {
	const index = SCOPES.indexOf(value);
	return index < 0 ? SCOPES.length : index;
}

function strictTimestamp(value: unknown, label: string): MemoryResult<number> {
	if (typeof value !== "string") return invalid(`${label} must be a string`);
	const match = STRICT_UTC_PATTERN.exec(value);
	if (match === null) return invalid(`${label} must be strict UTC ISO-8601`);
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	const millisecond = Number(match[7] ?? "0");
	if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 || millisecond > 999) {
		return invalid(`${label} is outside the UTC calendar range`);
	}
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
	if (day < 1 || day > daysInMonth) return invalid(`${label} is outside the UTC calendar range`);
	const milliseconds = Date.parse(value);
	if (!Number.isFinite(milliseconds)) return invalid(`${label} is not a valid timestamp`);
	const parsed = new Date(milliseconds);
	if (
		parsed.getUTCFullYear() !== year ||
		parsed.getUTCMonth() + 1 !== month ||
		parsed.getUTCDate() !== day ||
		parsed.getUTCHours() !== hour ||
		parsed.getUTCMinutes() !== minute ||
		parsed.getUTCSeconds() !== second ||
		parsed.getUTCMilliseconds() !== millisecond
	) {
		return invalid(`${label} is not a valid timestamp`);
	}
	return { ok: true, value: milliseconds };
}

function isKnown<T extends string>(values: readonly T[], value: unknown): value is T {
	return typeof value === "string" && (values as readonly string[]).includes(value);
}

function claimValue(value: unknown, label: string): MemoryResult<MemoryClaim> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid(`${label} is malformed`);
	const candidate = value as Readonly<Record<string, unknown>>;
	if (
		typeof candidate.claimKey !== "string" ||
		typeof candidate.text !== "string" ||
		typeof candidate.type !== "string" ||
		typeof candidate.authority !== "string" ||
		typeof candidate.freshness !== "string" ||
		typeof candidate.volatility !== "string"
	) {
		return invalid(`${label} has malformed claim fields`);
	}
	if (candidate.claimKey.normalize("NFC").trim().length === 0 || candidate.text.normalize("NFC").trim().length === 0) {
		return invalid(`${label} claimKey and text must be non-empty`);
	}
	if (!(AUTHORITY_TIERS as readonly string[]).includes(candidate.authority)) {
		return invalid(`${label} has an unknown authority tier`);
	}
	const source = candidate.source;
	if (source === null || typeof source !== "object" || Array.isArray(source))
		return invalid(`${label} source is malformed`);
	const citation = source as Readonly<Record<string, unknown>>;
	if (
		typeof citation.uri !== "string" ||
		typeof citation.scope !== "string" ||
		typeof citation.updatedAt !== "string" ||
		!isKnown(DOCUMENT_TYPES, candidate.type) ||
		!isKnown(VOLATILITIES, candidate.volatility) ||
		!isKnown(SCOPES, citation.scope)
	) {
		return invalid(`${label} source or claim has malformed vocabulary`);
	}
	if (citation.uri.normalize("NFC").trim().length === 0) return invalid(`${label} source URI must be non-empty`);
	const parsedUri = parseMemoryUri(citation.uri);
	if (!parsedUri.ok) return invalid(`${label} source URI is not canonical`);
	if (parsedUri.value.scheme !== citation.scope)
		return invalid(`${label} source URI scope does not match citation scope`);
	const updatedAt = strictTimestamp(citation.updatedAt, `${label} source updatedAt`);
	if (!updatedAt.ok) return updatedAt;
	const claim = value as MemoryClaim;
	return { ok: true, value: claim };
}

/** Compare declared authority tiers; a positive result means the left tier wins. */
export function compareAuthority(left: AuthorityTier, right: AuthorityTier): number {
	const leftRank = authorityRank(left);
	const rightRank = authorityRank(right);
	if (leftRank < rightRank) return 1;
	if (leftRank > rightRank) return -1;
	return 0;
}

/** Compare scope specificity; a positive result means the left scope wins. */
export function compareSpecificity(left: MemoryScopeKind, right: MemoryScopeKind): number {
	const leftRank = scopeRank(left);
	const rightRank = scopeRank(right);
	if (leftRank < rightRank) return 1;
	if (leftRank > rightRank) return -1;
	return 0;
}

/** Compare strict UTC freshness timestamps relative to an injected as-of timestamp. */
export function compareFreshness(left: string, right: string, asOf: string): MemoryResult<number> {
	const leftTimestamp = strictTimestamp(left, "left freshness");
	if (!leftTimestamp.ok) return leftTimestamp;
	const rightTimestamp = strictTimestamp(right, "right freshness");
	if (!rightTimestamp.ok) return rightTimestamp;
	const asOfTimestamp = strictTimestamp(asOf, "asOf");
	if (!asOfTimestamp.ok) return asOfTimestamp;
	const leftAge = asOfTimestamp.value - leftTimestamp.value;
	const rightAge = asOfTimestamp.value - rightTimestamp.value;
	if (leftAge < rightAge) return { ok: true, value: 1 };
	if (leftAge > rightAge) return { ok: true, value: -1 };
	return { ok: true, value: 0 };
}

export interface ClaimOrderingContext {
	readonly asOf: string;
}

/**
 * Compare claims using authority, scope specificity, freshness, and canonical URI bytes.
 * A positive result means the left claim wins; zero means all ordering dimensions tie.
 */
export function compareClaims(
	left: MemoryClaim,
	right: MemoryClaim,
	context: ClaimOrderingContext,
): MemoryResult<number> {
	const leftValue = claimValue(left, "left claim");
	if (!leftValue.ok) return leftValue;
	const rightValue = claimValue(right, "right claim");
	if (!rightValue.ok) return rightValue;
	if (context === null || typeof context !== "object" || typeof context.asOf !== "string") {
		return invalid("ordering context must contain a strict UTC asOf timestamp");
	}
	const authority = compareAuthority(leftValue.value.authority, rightValue.value.authority);
	if (authority !== 0) return { ok: true, value: authority };
	const specificity = compareSpecificity(leftValue.value.source.scope, rightValue.value.source.scope);
	if (specificity !== 0) return { ok: true, value: specificity };
	const freshness = compareFreshness(leftValue.value.freshness, rightValue.value.freshness, context.asOf);
	if (!freshness.ok) return freshness;
	if (freshness.value !== 0) return freshness;
	const leftUri = parseMemoryUri(leftValue.value.source.uri);
	if (!leftUri.ok) return invalid("left claim source URI is not canonical");
	const rightUri = parseMemoryUri(rightValue.value.source.uri);
	if (!rightUri.ok) return invalid("right claim source URI is not canonical");
	const volatility = compareVolatility(leftValue.value.volatility, rightValue.value.volatility);
	if (volatility !== 0) return { ok: true, value: volatility };
	return { ok: true, value: compareUtf8(rightUri.value.href, leftUri.value.href) };
}
