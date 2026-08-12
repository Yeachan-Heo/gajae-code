/**
 * Source-preserving effective configuration resolution.
 *
 * This module deliberately has no Settings, filesystem, or runtime dependencies. A
 * caller supplies immutable source records; the resolver only canonicalizes and
 * orders those records and returns an immutable explanation of the result.
 */

export type CanonicalConfigurationJsonValue =
	| null
	| boolean
	| number
	| string
	| readonly CanonicalConfigurationJsonValue[]
	| { readonly [key: string]: CanonicalConfigurationJsonValue };

export const EFFECTIVE_CONFIGURATION_SOURCE_RANKS = Object.freeze({
	builtin: 10,
	discoveredUser: 20,
	ownedUser: 30,
	profileMaterialization: 35,
	discoveredProject: 40,
	ownedNativeProject: 50,
	cli: 60,
	session: 70,
	turn: 80,
	managed: 90,
} as const);

export type EffectiveConfigurationSourceRank =
	(typeof EFFECTIVE_CONFIGURATION_SOURCE_RANKS)[keyof typeof EFFECTIVE_CONFIGURATION_SOURCE_RANKS];

export const BUILTIN_SOURCE_RANK = EFFECTIVE_CONFIGURATION_SOURCE_RANKS.builtin;
export const DISCOVERED_USER_SOURCE_RANK = EFFECTIVE_CONFIGURATION_SOURCE_RANKS.discoveredUser;
export const OWNED_USER_SOURCE_RANK = EFFECTIVE_CONFIGURATION_SOURCE_RANKS.ownedUser;
export const PROFILE_MATERIALIZATION_SOURCE_RANK = EFFECTIVE_CONFIGURATION_SOURCE_RANKS.profileMaterialization;
export const DISCOVERED_PROJECT_SOURCE_RANK = EFFECTIVE_CONFIGURATION_SOURCE_RANKS.discoveredProject;
export const OWNED_NATIVE_PROJECT_SOURCE_RANK = EFFECTIVE_CONFIGURATION_SOURCE_RANKS.ownedNativeProject;
export const CLI_SOURCE_RANK = EFFECTIVE_CONFIGURATION_SOURCE_RANKS.cli;
export const SESSION_SOURCE_RANK = EFFECTIVE_CONFIGURATION_SOURCE_RANKS.session;
export const TURN_SOURCE_RANK = EFFECTIVE_CONFIGURATION_SOURCE_RANKS.turn;
export const MANAGED_SOURCE_RANK = EFFECTIVE_CONFIGURATION_SOURCE_RANKS.managed;

export type EffectiveConfigurationOwnership =
	| "builtin"
	| "discovered"
	| "owned"
	| "profile"
	| "cli"
	| "runtime"
	| "managed";

/** Stable, safe reason codes emitted by this module. */
export type EffectiveConfigurationReasonCode =
	| "no_sources"
	| "no_eligible_sources"
	| "absent"
	| "clear_to_lower"
	| "conflict"
	| "revealed_conflict"
	| "unknown_physical_identity"
	| "unstable_source"
	| "source_race"
	| "unsupported_value"
	| "cyclic_value"
	| "unavailable_source"
	| "presence_unavailable"
	| "invalid_source"
	| "invalid_rank"
	| "invalid_ownership"
	| "invalid_key"
	| "invalid_physical_identity"
	| "physical_alias_disagreement"
	| "source_read_failed";

export const EFFECTIVE_CONFIGURATION_REASON_CODES = Object.freeze([
	"no_sources",
	"no_eligible_sources",
	"absent",
	"clear_to_lower",
	"conflict",
	"revealed_conflict",
	"unknown_physical_identity",
	"unstable_source",
	"source_race",
	"unsupported_value",
	"cyclic_value",
	"unavailable_source",
	"presence_unavailable",
	"invalid_source",
	"invalid_rank",
	"invalid_ownership",
	"invalid_key",
	"invalid_physical_identity",
	"physical_alias_disagreement",
	"source_read_failed",
] as const);

export type EffectiveConfigurationPresence<T = unknown> =
	| { readonly presence: "present"; readonly value: T }
	| { readonly presence: "absent" }
	| {
			readonly presence: "unavailable";
			readonly reason: EffectiveConfigurationReasonCode;
			readonly detail?: string;
	  };

export type EffectiveConfigurationPhysicalIdentity =
	| {
			readonly kind: "known";
			/** Canonical opaque identity. Device/inode evidence may accompany it. */
			readonly identity: string;
			readonly device?: string | number;
			readonly inode?: string | number;
	  }
	| { readonly kind: "unknown"; readonly reason: EffectiveConfigurationReasonCode };

export type EffectiveConfigurationStability =
	| { readonly state: "stable" }
	| { readonly state: "unstable"; readonly reason: EffectiveConfigurationReasonCode };

/**
 * A source record is data only. The resolver never writes to, freezes, or
 * otherwise mutates a caller-owned record.
 */
export interface EffectiveConfigurationSourceRecord<T = unknown> {
	readonly sourceId: string;
	readonly canonicalKey: string;
	readonly presence: EffectiveConfigurationPresence<T>;
	readonly rank: EffectiveConfigurationSourceRank;
	readonly ownership: EffectiveConfigurationOwnership;
	readonly safePath?: string;
	readonly physicalIdentity: EffectiveConfigurationPhysicalIdentity;
	readonly revision?: string;
	readonly digest?: string;
	readonly cwdDistance?: number;
	readonly aliases?: readonly string[];
	readonly stability: EffectiveConfigurationStability;
}

export type EffectiveConfigurationSourceRecordInput = EffectiveConfigurationSourceRecord<unknown>;

export interface EffectiveConfigurationProvenanceEntry {
	readonly sourceId: string;
	readonly canonicalKey: string;
	readonly rank: number;
	readonly ownership: EffectiveConfigurationOwnership;
	readonly safePath?: string;
	readonly physicalIdentity: EffectiveConfigurationPhysicalIdentity;
	readonly revision?: string;
	readonly digest?: string;
	readonly cwdDistance?: number;
	readonly aliases: readonly string[];
	readonly presence: "present" | "absent" | "unavailable";
	readonly stability: "stable" | "unstable";
	readonly eligibility: "eligible" | "ineligible";
	readonly ineligibilityReason?: EffectiveConfigurationReasonCode;
	readonly physicalDeduplication: {
		readonly identity: string;
		readonly memberCount: number;
		readonly collapsed: boolean;
	};
}

export interface EffectiveConfigurationConflictCandidate {
	readonly sourceId: string;
	readonly rank: number;
	readonly safePath?: string;
	readonly aliases: readonly string[];
	readonly digest?: string;
}

interface EffectiveConfigurationResultBase {
	readonly canonicalKey: string;
	readonly provenance: readonly EffectiveConfigurationProvenanceEntry[];
	readonly evidence: readonly EffectiveConfigurationProvenanceEntry[];
	readonly clearToLower: boolean;
	readonly maskedConflicts: readonly EffectiveConfigurationConflictCandidate[][];
}

export interface EffectiveConfigurationResolvedResult extends EffectiveConfigurationResultBase {
	readonly state: "resolved";
	readonly value: CanonicalConfigurationJsonValue;
	readonly winner: EffectiveConfigurationProvenanceEntry;
	readonly reason?: "clear_to_lower";
}

export interface EffectiveConfigurationAbsentResult extends EffectiveConfigurationResultBase {
	readonly state: "absent";
	readonly reason: "no_sources" | "absent" | "clear_to_lower";
}

export interface EffectiveConfigurationConflictResult extends EffectiveConfigurationResultBase {
	readonly state: "conflict";
	readonly reason: "conflict" | "revealed_conflict";
	readonly candidates: readonly EffectiveConfigurationConflictCandidate[];
}

export interface EffectiveConfigurationUnavailableResult extends EffectiveConfigurationResultBase {
	readonly state: "unavailable";
	readonly reason: EffectiveConfigurationReasonCode;
}

export type EffectiveConfigurationResult =
	| EffectiveConfigurationResolvedResult
	| EffectiveConfigurationAbsentResult
	| EffectiveConfigurationConflictResult
	| EffectiveConfigurationUnavailableResult;

export interface EffectiveConfigurationExplanationOrderingEntry extends EffectiveConfigurationProvenanceEntry {
	readonly order: number;
}

export interface EffectiveConfigurationPhysicalDeduplicationExplanation {
	readonly canonicalKey: string;
	readonly identity: string;
	readonly sourceIds: readonly string[];
	readonly aliases: readonly string[];
	readonly memberCount: number;
	readonly collapsed: boolean;
}

export interface EffectiveConfigurationEligibilityExplanation {
	readonly sourceId: string;
	readonly eligible: boolean;
	readonly reason?: EffectiveConfigurationReasonCode;
}

export interface EffectiveConfigurationWinnerExplanation {
	readonly sourceId: string;
	readonly rank: number;
	readonly safePath?: string;
	readonly ownership: EffectiveConfigurationOwnership;
	readonly writable: boolean;
}

export interface EffectiveConfigurationClearToLowerExplanation {
	readonly occurred: boolean;
	readonly higherAbsentSourceIds: readonly string[];
	readonly revealedState?: EffectiveConfigurationResult["state"];
}

export interface EffectiveConfigurationExplanation {
	readonly canonicalKey: string;
	readonly state: EffectiveConfigurationResult["state"];
	readonly reason?: EffectiveConfigurationReasonCode;
	readonly ordering: readonly EffectiveConfigurationExplanationOrderingEntry[];
	readonly provenance: readonly EffectiveConfigurationProvenanceEntry[];
	readonly evidence: readonly EffectiveConfigurationProvenanceEntry[];
	readonly aliases: readonly EffectiveConfigurationPhysicalDeduplicationExplanation[];
	readonly physicalDedup: readonly EffectiveConfigurationPhysicalDeduplicationExplanation[];
	readonly eligibility: readonly EffectiveConfigurationEligibilityExplanation[];
	readonly winner?: EffectiveConfigurationWinnerExplanation;
	readonly conflict?: readonly EffectiveConfigurationConflictCandidate[];
	readonly maskedConflicts: readonly EffectiveConfigurationConflictCandidate[][];
	readonly clearToLower: EffectiveConfigurationClearToLowerExplanation;
}

interface CanonicalizeSuccess {
	readonly ok: true;
	readonly value: CanonicalConfigurationJsonValue;
}

interface CanonicalizeFailure {
	readonly ok: false;
	readonly reason: "unsupported_value" | "cyclic_value";
}

type CanonicalizeResult = CanonicalizeSuccess | CanonicalizeFailure;

interface NormalizedSource {
	readonly sourceId: string;
	readonly canonicalKey: string;
	readonly presence: EffectiveConfigurationPresence<CanonicalConfigurationJsonValue>;
	readonly rank: number;
	readonly ownership: EffectiveConfigurationOwnership;
	readonly safePath?: string;
	readonly physicalIdentity: EffectiveConfigurationPhysicalIdentity;
	readonly revision?: string;
	readonly digest?: string;
	readonly cwdDistance?: number;
	readonly aliases: readonly string[];
	readonly stability: EffectiveConfigurationStability;
	readonly invalidReason?: EffectiveConfigurationReasonCode;
	readonly memberCount: number;
}

interface PhysicalGroup {
	readonly identity: string;
	readonly canonicalKey: string;
	readonly members: readonly NormalizedSource[];
}

const VALID_RANKS = new Set<number>(Object.values(EFFECTIVE_CONFIGURATION_SOURCE_RANKS));
const VALID_OWNERSHIPS = new Set<EffectiveConfigurationOwnership>([
	"builtin",
	"discovered",
	"owned",
	"profile",
	"cli",
	"runtime",
	"managed",
]);
const VALID_REASONS = new Set<string>(EFFECTIVE_CONFIGURATION_REASON_CODES);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isCanonicalObject(
	value: CanonicalConfigurationJsonValue,
): value is { readonly [key: string]: CanonicalConfigurationJsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareStrings(a: string, b: string): number {
	if (a === b) return 0;
	return a < b ? -1 : 1;
}

function safeText(value: unknown, fallback = "(unknown)"): string {
	if (typeof value !== "string") return fallback;
	return value
		.normalize("NFC")
		.replace(/[\u0000-\u001f\u007f]/g, "?")
		.slice(0, 512);
}

function safeOptionalText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = safeText(value, "");
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeReason(value: unknown, fallback: EffectiveConfigurationReasonCode): EffectiveConfigurationReasonCode {
	if (typeof value !== "string") return fallback;
	const normalized = value.trim().toLowerCase().replace(/-/g, "_");
	return VALID_REASONS.has(normalized) ? (normalized as EffectiveConfigurationReasonCode) : fallback;
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
	return Object.freeze(value);
}

function canonicalizeJsonLike(value: unknown, active = new Set<object>()): CanonicalizeResult {
	if (value === null) return { ok: true, value: null };
	if (typeof value === "string" || typeof value === "boolean") return { ok: true, value };
	if (typeof value === "number") {
		return Number.isFinite(value)
			? { ok: true, value: Object.is(value, -0) ? 0 : value }
			: { ok: false, reason: "unsupported_value" };
	}
	if (
		typeof value === "undefined" ||
		typeof value === "bigint" ||
		typeof value === "symbol" ||
		typeof value === "function"
	) {
		return { ok: false, reason: "unsupported_value" };
	}
	if (!isRecord(value)) return { ok: false, reason: "unsupported_value" };
	if (active.has(value)) return { ok: false, reason: "cyclic_value" };
	active.add(value);
	try {
		if (value instanceof Map) {
			const entries: Array<[string, CanonicalConfigurationJsonValue]> = [];
			for (const [key, item] of value.entries()) {
				if (typeof key !== "string") return { ok: false, reason: "unsupported_value" };
				const canonical = canonicalizeJsonLike(item, active);
				if (!canonical.ok) return canonical;
				entries.push([key, canonical.value]);
			}
			entries.sort((a, b) => compareStrings(a[0], b[0]));
			const output: Record<string, CanonicalConfigurationJsonValue> = {};
			for (const [key, item] of entries) output[key] = item;
			return { ok: true, value: deepFreeze(output) };
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
			return { ok: false, reason: "unsupported_value" };
		}
		if (Object.getOwnPropertySymbols(value).length > 0) return { ok: false, reason: "unsupported_value" };
		if (Array.isArray(value)) {
			const output: CanonicalConfigurationJsonValue[] = [];
			for (let index = 0; index < value.length; index += 1) {
				const canonical = canonicalizeJsonLike(value[index], active);
				if (!canonical.ok) return canonical;
				output.push(canonical.value);
			}
			return { ok: true, value: deepFreeze(output) };
		}
		const output: Record<string, CanonicalConfigurationJsonValue> = {};
		let keys: string[];
		try {
			keys = Object.keys(value).sort(compareStrings);
		} catch {
			return { ok: false, reason: "unsupported_value" };
		}
		for (const key of keys) {
			let item: unknown;
			try {
				item = value[key];
			} catch {
				return { ok: false, reason: "unsupported_value" };
			}
			const canonical = canonicalizeJsonLike(item, active);
			if (!canonical.ok) return canonical;
			output[key] = canonical.value;
		}
		return { ok: true, value: deepFreeze(output) };
	} catch {
		return { ok: false, reason: "unsupported_value" };
	} finally {
		active.delete(value);
	}
}

function canonicalValuesEqual(a: CanonicalConfigurationJsonValue, b: CanonicalConfigurationJsonValue): boolean {
	if (a === b) return true;
	if (typeof a !== typeof b || a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((item, index) => canonicalValuesEqual(item, b[index]));
	}
	if (isCanonicalObject(a) && isCanonicalObject(b)) {
		const aKeys = Object.keys(a);
		const bKeys = Object.keys(b);
		if (aKeys.length !== bKeys.length) return false;
		for (let index = 0; index < aKeys.length; index += 1) {
			const key = aKeys[index];
			const otherKey = bKeys[index];
			if (key === undefined || otherKey === undefined || key !== otherKey) return false;
			if (!canonicalValuesEqual(a[key], b[otherKey])) return false;
		}
		return true;
	}
	return false;
}

function canonicalValueCompare(a: CanonicalConfigurationJsonValue, b: CanonicalConfigurationJsonValue): number {
	if (canonicalValuesEqual(a, b)) return 0;
	const rank = (value: CanonicalConfigurationJsonValue): number => {
		if (value === null) return 0;
		if (typeof value === "boolean") return 1;
		if (typeof value === "number") return 2;
		if (typeof value === "string") return 3;
		if (Array.isArray(value)) return 4;
		return 5;
	};
	const typeDifference = rank(a) - rank(b);
	if (typeDifference !== 0) return typeDifference;
	if (typeof a === "boolean" && typeof b === "boolean") return a ? 1 : -1;
	if (typeof a === "number" && typeof b === "number") return a < b ? -1 : 1;
	if (typeof a === "string" && typeof b === "string") return compareStrings(a, b);
	if (Array.isArray(a) && Array.isArray(b)) {
		for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
			const difference = canonicalValueCompare(a[index], b[index]);
			if (difference !== 0) return difference;
		}
		return a.length < b.length ? -1 : 1;
	}
	if (isCanonicalObject(a) && isCanonicalObject(b)) {
		const aKeys = Object.keys(a);
		const bKeys = Object.keys(b);
		for (let index = 0; index < Math.min(aKeys.length, bKeys.length); index += 1) {
			const aKey = aKeys[index];
			const bKey = bKeys[index];
			if (aKey === undefined || bKey === undefined) break;
			const keyDifference = compareStrings(aKey, bKey);
			if (keyDifference !== 0) return keyDifference;
			const valueDifference = canonicalValueCompare(a[aKey], b[bKey]);
			if (valueDifference !== 0) return valueDifference;
		}
		return aKeys.length < bKeys.length ? -1 : 1;
	}
	return 0;
}

function normalizePhysicalIdentity(value: unknown): {
	identity: EffectiveConfigurationPhysicalIdentity;
	invalidReason?: EffectiveConfigurationReasonCode;
} {
	if (!isRecord(value)) {
		return { identity: { kind: "unknown", reason: "unknown_physical_identity" } };
	}
	if (value.kind === "known") {
		const identity = safeOptionalText(value.identity);
		if (identity) {
			return {
				identity: {
					kind: "known",
					identity,
					device: typeof value.device === "string" || typeof value.device === "number" ? value.device : undefined,
					inode: typeof value.inode === "string" || typeof value.inode === "number" ? value.inode : undefined,
				},
			};
		}
		if (
			(typeof value.device === "string" || typeof value.device === "number") &&
			(typeof value.inode === "string" || typeof value.inode === "number")
		) {
			return {
				identity: {
					kind: "known",
					identity: `${String(value.device)}:${String(value.inode)}`,
					device: value.device,
					inode: value.inode,
				},
			};
		}
		return {
			identity: { kind: "unknown", reason: "unknown_physical_identity" },
			invalidReason: "invalid_physical_identity",
		};
	}
	return {
		identity: {
			kind: "unknown",
			reason: normalizeReason(value.reason, "unknown_physical_identity"),
		},
	};
}

function normalizeStability(value: unknown): EffectiveConfigurationStability {
	if (!isRecord(value) || value.state === "stable" || value === undefined) return { state: "stable" };
	if (value.state === "unstable") {
		return { state: "unstable", reason: normalizeReason(value.reason, "unstable_source") };
	}
	return { state: "unstable", reason: "unstable_source" };
}

function normalizePresence(value: unknown): {
	presence: EffectiveConfigurationPresence<CanonicalConfigurationJsonValue>;
	invalidReason?: EffectiveConfigurationReasonCode;
} {
	if (!isRecord(value)) {
		return { presence: { presence: "unavailable", reason: "invalid_source" }, invalidReason: "invalid_source" };
	}
	if (value.presence === "absent") return { presence: { presence: "absent" } };
	if (value.presence === "unavailable") {
		return {
			presence: {
				presence: "unavailable",
				reason: normalizeReason(value.reason, "unavailable_source"),
			},
		};
	}
	if (value.presence === "present") {
		const canonical = canonicalizeJsonLike(value.value);
		if (canonical.ok) return { presence: { presence: "present", value: canonical.value } };
		return {
			presence: { presence: "unavailable", reason: canonical.reason },
			invalidReason: canonical.reason,
		};
	}
	return { presence: { presence: "unavailable", reason: "invalid_source" }, invalidReason: "invalid_source" };
}

function normalizeSource(record: EffectiveConfigurationSourceRecordInput): NormalizedSource {
	const candidate = record as unknown as Record<string, unknown>;
	const sourceId = safeText(candidate.sourceId, "(unknown source)");
	const canonicalKey = safeText(candidate.canonicalKey, "");
	const rankValue = typeof candidate.rank === "number" ? candidate.rank : Number.NaN;
	const rankValid = VALID_RANKS.has(rankValue);
	const rank = rankValid ? rankValue : 0;
	const ownershipValue = candidate.ownership;
	const ownership = VALID_OWNERSHIPS.has(ownershipValue as EffectiveConfigurationOwnership)
		? (ownershipValue as EffectiveConfigurationOwnership)
		: "discovered";
	const physical = normalizePhysicalIdentity(candidate.physicalIdentity);
	const presence = normalizePresence(candidate.presence);
	const stability = normalizeStability(candidate.stability);
	const aliases = new Set<string>();
	if (Array.isArray(candidate.aliases)) {
		for (const alias of candidate.aliases) {
			const safeAlias = safeOptionalText(alias);
			if (safeAlias) aliases.add(safeAlias);
		}
	}
	const safePath = safeOptionalText(candidate.safePath);
	if (safePath) aliases.add(safePath);
	let invalidReason = presence.invalidReason ?? physical.invalidReason;
	if (!canonicalKey) invalidReason ??= "invalid_key";
	if (!rankValid) invalidReason ??= "invalid_rank";
	if (!VALID_OWNERSHIPS.has(ownershipValue as EffectiveConfigurationOwnership)) invalidReason ??= "invalid_ownership";
	return {
		sourceId,
		canonicalKey,
		presence: presence.presence,
		rank,
		ownership,
		safePath,
		physicalIdentity: physical.identity,
		revision: safeOptionalText(candidate.revision),
		digest: safeOptionalText(candidate.digest),
		cwdDistance:
			typeof candidate.cwdDistance === "number" && Number.isFinite(candidate.cwdDistance)
				? Math.max(0, candidate.cwdDistance)
				: undefined,
		aliases: [...aliases].sort(compareStrings),
		stability,
		invalidReason,
		memberCount: 1,
	};
}

function physicalIdentitySortKey(identity: EffectiveConfigurationPhysicalIdentity): string {
	return identity.kind === "known" ? `known:${identity.identity}` : `unknown:${identity.reason}`;
}

function presenceSortKey(presence: EffectiveConfigurationPresence<CanonicalConfigurationJsonValue>): string {
	return presence.presence === "present" ? "0" : presence.presence === "absent" ? "1" : "2";
}

function compareNormalizedSources(a: NormalizedSource, b: NormalizedSource): number {
	if (a.rank !== b.rank) return b.rank - a.rank;
	let difference = compareStrings(
		physicalIdentitySortKey(a.physicalIdentity),
		physicalIdentitySortKey(b.physicalIdentity),
	);
	if (difference !== 0) return difference;
	difference = compareStrings(a.sourceId, b.sourceId);
	if (difference !== 0) return difference;
	difference = compareStrings(a.safePath ?? "", b.safePath ?? "");
	if (difference !== 0) return difference;
	const aDistance = a.cwdDistance ?? Number.POSITIVE_INFINITY;
	const bDistance = b.cwdDistance ?? Number.POSITIVE_INFINITY;
	if (aDistance !== bDistance) return aDistance < bDistance ? -1 : 1;
	difference = compareStrings(a.revision ?? "", b.revision ?? "");
	if (difference !== 0) return difference;
	difference = compareStrings(a.digest ?? "", b.digest ?? "");
	if (difference !== 0) return difference;
	difference = compareStrings(presenceSortKey(a.presence), presenceSortKey(b.presence));
	if (difference !== 0) return difference;
	if (a.presence.presence === "present" && b.presence.presence === "present") {
		difference = canonicalValueCompare(a.presence.value, b.presence.value);
		if (difference !== 0) return difference;
	}
	difference = compareStrings(a.ownership, b.ownership);
	if (difference !== 0) return difference;
	return compareStrings(
		a.stability.state === "stable" ? "stable" : a.stability.reason,
		b.stability.state === "stable" ? "stable" : b.stability.reason,
	);
}

function samePresence(
	a: EffectiveConfigurationPresence<CanonicalConfigurationJsonValue>,
	b: EffectiveConfigurationPresence<CanonicalConfigurationJsonValue>,
): boolean {
	if (a.presence !== b.presence) return false;
	if (a.presence === "present" && b.presence === "present") return canonicalValuesEqual(a.value, b.value);
	if (a.presence === "unavailable" && b.presence === "unavailable") return a.reason === b.reason;
	return true;
}

function mergePhysicalGroup(group: PhysicalGroup): NormalizedSource {
	const members = [...group.members].sort(compareNormalizedSources);
	const representative = members[0];
	const payloadAgrees = members.every(member => samePresence(member.presence, representative.presence));
	const allStable = members.every(member => member.stability.state === "stable");
	const aliasSet = new Set<string>();
	for (const member of members) for (const alias of member.aliases) aliasSet.add(alias);
	const sourceInvalid = members.find(member => member.invalidReason)?.invalidReason;
	const presence: EffectiveConfigurationPresence<CanonicalConfigurationJsonValue> = payloadAgrees
		? representative.presence
		: { presence: "unavailable", reason: "physical_alias_disagreement" };
	let firstUnstableReason: EffectiveConfigurationReasonCode | undefined;
	let hasSourceRace = false;
	for (const member of members) {
		const stability = member.stability;
		if (stability.state !== "unstable") continue;
		firstUnstableReason ??= stability.reason;
		if (stability.reason === "source_race") hasSourceRace = true;
	}
	const mergedStabilityReason: EffectiveConfigurationReasonCode = hasSourceRace
		? "source_race"
		: (firstUnstableReason ?? "unstable_source");
	const stability: EffectiveConfigurationStability =
		allStable && payloadAgrees
			? { state: "stable" }
			: { state: "unstable", reason: payloadAgrees ? mergedStabilityReason : "physical_alias_disagreement" };
	return {
		...representative,
		presence,
		stability,
		aliases: [...aliasSet].sort(compareStrings),
		invalidReason: sourceInvalid,
		memberCount: members.length,
	};
}

function deduplicatePhysicalSources(records: readonly NormalizedSource[]): {
	sources: readonly NormalizedSource[];
	groups: readonly PhysicalGroup[];
} {
	const groups = new Map<string, NormalizedSource[]>();
	const ungrouped: NormalizedSource[] = [];
	for (const record of records) {
		if (record.physicalIdentity.kind !== "known") {
			ungrouped.push(record);
			continue;
		}
		const key = `${record.canonicalKey}\u0000${record.physicalIdentity.identity}`;
		const group = groups.get(key);
		if (group) group.push(record);
		else groups.set(key, [record]);
	}
	const physicalGroups: PhysicalGroup[] = [...groups.entries()].map(([key, members]) => {
		const separator = key.indexOf("\u0000");
		return {
			canonicalKey: key.slice(0, separator),
			identity: key.slice(separator + 1),
			members,
		};
	});
	const deduplicated = physicalGroups.map(mergePhysicalGroup);
	const sources = [...ungrouped, ...deduplicated].sort(compareNormalizedSources);
	return {
		sources,
		groups: physicalGroups.sort((a, b) =>
			compareStrings(`${a.canonicalKey}\u0000${a.identity}`, `${b.canonicalKey}\u0000${b.identity}`),
		),
	};
}

function sourceEligibility(source: NormalizedSource): { eligible: boolean; reason?: EffectiveConfigurationReasonCode } {
	if (source.invalidReason) return { eligible: false, reason: source.invalidReason };
	if (source.physicalIdentity.kind === "unknown") {
		return { eligible: false, reason: "unknown_physical_identity" };
	}
	if (source.stability.state === "unstable") return { eligible: false, reason: source.stability.reason };
	if (source.presence.presence === "unavailable") return { eligible: false, reason: source.presence.reason };
	return { eligible: true };
}

function toProvenance(
	source: NormalizedSource,
	eligible: { eligible: boolean; reason?: EffectiveConfigurationReasonCode },
): EffectiveConfigurationProvenanceEntry {
	const physicalIdentity =
		source.physicalIdentity.kind === "known"
			? {
					kind: "known" as const,
					identity: source.physicalIdentity.identity,
					...(source.physicalIdentity.device === undefined ? {} : { device: source.physicalIdentity.device }),
					...(source.physicalIdentity.inode === undefined ? {} : { inode: source.physicalIdentity.inode }),
				}
			: { kind: "unknown" as const, reason: source.physicalIdentity.reason };
	return {
		sourceId: source.sourceId,
		canonicalKey: source.canonicalKey,
		rank: source.rank,
		ownership: source.ownership,
		...(source.safePath === undefined ? {} : { safePath: source.safePath }),
		physicalIdentity,
		...(source.revision === undefined ? {} : { revision: source.revision }),
		...(source.digest === undefined ? {} : { digest: source.digest }),
		...(source.cwdDistance === undefined ? {} : { cwdDistance: source.cwdDistance }),
		aliases: source.aliases,
		presence: source.presence.presence,
		stability: source.stability.state,
		eligibility: eligible.eligible ? "eligible" : "ineligible",
		...(eligible.reason === undefined ? {} : { ineligibilityReason: eligible.reason }),
		physicalDeduplication: {
			identity: physicalIdentitySortKey(source.physicalIdentity),
			memberCount: source.memberCount,
			collapsed: source.memberCount > 1,
		},
	};
}

function conflictCandidates(
	sources: readonly NormalizedSource[],
	rank: number,
): readonly EffectiveConfigurationConflictCandidate[] {
	return sources
		.filter(source => source.rank === rank && source.presence.presence === "present")
		.sort(compareNormalizedSources)
		.map(source => ({
			sourceId: source.sourceId,
			rank: source.rank,
			...(source.safePath === undefined ? {} : { safePath: source.safePath }),
			aliases: source.aliases,
			...(source.digest === undefined ? {} : { digest: source.digest }),
		}));
}

function findRankConflicts(sources: readonly NormalizedSource[]): readonly EffectiveConfigurationConflictCandidate[][] {
	const byRank = new Map<number, NormalizedSource[]>();
	for (const source of sources) {
		if (source.presence.presence !== "present") continue;
		const bucket = byRank.get(source.rank);
		if (bucket) bucket.push(source);
		else byRank.set(source.rank, [source]);
	}
	const conflicts: EffectiveConfigurationConflictCandidate[][] = [];
	for (const rank of [...byRank.keys()].sort((a, b) => b - a)) {
		const bucket = byRank.get(rank) ?? [];
		if (bucket.length < 2) continue;
		const first = bucket[0].presence;
		if (first.presence !== "present") continue;
		if (
			bucket.some(
				source =>
					source.presence.presence === "present" && !canonicalValuesEqual(first.value, source.presence.value),
			)
		) {
			conflicts.push([...conflictCandidates(bucket, rank)]);
		}
	}
	return conflicts;
}

function freezeResult<T extends EffectiveConfigurationResult>(result: T): T {
	return deepFreeze(result);
}

function makeBase(
	canonicalKey: string,
	provenance: readonly EffectiveConfigurationProvenanceEntry[],
	clearToLower: boolean,
	maskedConflicts: readonly EffectiveConfigurationConflictCandidate[][] = [],
): EffectiveConfigurationResultBase {
	return { canonicalKey, provenance, evidence: provenance, clearToLower, maskedConflicts };
}

export class EffectiveConfigurationResolver {
	readonly #records: readonly EffectiveConfigurationSourceRecordInput[];

	constructor(records: readonly EffectiveConfigurationSourceRecordInput[] = []) {
		this.#records = [...records];
	}

	resolve(
		canonicalKey: string,
		records: readonly EffectiveConfigurationSourceRecordInput[] = this.#records,
	): EffectiveConfigurationResult {
		const requestedKey = safeText(canonicalKey, "");
		const matching = records
			.filter(record => safeText((record as unknown as Record<string, unknown>).canonicalKey, "") === requestedKey)
			.map(normalizeSource)
			.sort(compareNormalizedSources);
		if (matching.length === 0) {
			const provenance = deepFreeze([] as EffectiveConfigurationProvenanceEntry[]);
			return freezeResult({
				...makeBase(requestedKey, provenance, false),
				state: "absent",
				reason: "no_sources",
			});
		}

		const { sources } = deduplicatePhysicalSources(matching);
		const eligibility = sources.map(source => sourceEligibility(source));
		const provenance = deepFreeze(
			sources.map((source, index) => {
				const entry = toProvenance(source, eligibility[index]);
				return deepFreeze(entry);
			}),
		);
		const eligibleSources = sources.filter((_, index) => eligibility[index].eligible);
		const presentSources = eligibleSources.filter(source => source.presence.presence === "present");
		const absentSources = eligibleSources.filter(source => source.presence.presence === "absent");
		const highestEligibleRank =
			eligibleSources.length > 0 ? Math.max(...eligibleSources.map(source => source.rank)) : undefined;
		const highestPresentRank =
			presentSources.length > 0 ? Math.max(...presentSources.map(source => source.rank)) : undefined;
		const rankConflicts = findRankConflicts(eligibleSources);
		const maskedConflicts = deepFreeze(
			highestPresentRank === undefined
				? []
				: rankConflicts.filter(conflict => (conflict[0]?.rank ?? highestPresentRank) < highestPresentRank),
		);
		const higherAbsentSourceIds =
			highestPresentRank === undefined
				? []
				: eligibleSources
						.filter(source => source.presence.presence === "absent" && source.rank > highestPresentRank)
						.map(source => source.sourceId);
		const clearToLower = higherAbsentSourceIds.length > 0;

		if (highestPresentRank !== undefined) {
			const highestPresent = presentSources
				.filter(source => source.rank === highestPresentRank)
				.sort(compareNormalizedSources);
			const firstPresence = highestPresent[0].presence;
			if (
				firstPresence.presence === "present" &&
				highestPresent.every(
					source =>
						source.presence.presence === "present" &&
						canonicalValuesEqual(firstPresence.value, source.presence.value),
				)
			) {
				const winnerSource = highestPresent[0];
				const winnerIndex = sources.indexOf(winnerSource);
				const winner = provenance[winnerIndex];
				return freezeResult({
					...makeBase(requestedKey, provenance, clearToLower, maskedConflicts),
					state: "resolved",
					value: firstPresence.value,
					winner,
					...(clearToLower ? { reason: "clear_to_lower" as const } : {}),
				});
			}
			const candidates = deepFreeze([...conflictCandidates(highestPresent, highestPresentRank)]);
			return freezeResult({
				...makeBase(requestedKey, provenance, clearToLower, maskedConflicts),
				state: "conflict",
				reason: clearToLower ? "revealed_conflict" : "conflict",
				candidates,
			});
		}

		if (absentSources.length > 0) {
			const reason =
				highestEligibleRank !== undefined && absentSources.some(source => source.rank === highestEligibleRank)
					? "absent"
					: "clear_to_lower";
			return freezeResult({
				...makeBase(requestedKey, provenance, false, maskedConflicts),
				state: "absent",
				reason,
			});
		}

		const excludedReasons = sources
			.map((_, index) => eligibility[index].reason)
			.filter((reason): reason is EffectiveConfigurationReasonCode => reason !== undefined);
		const reason =
			excludedReasons.includes("unstable_source") || excludedReasons.includes("source_race")
				? "unstable_source"
				: excludedReasons.includes("unknown_physical_identity")
					? "unknown_physical_identity"
					: (excludedReasons[0] ?? "no_eligible_sources");
		return freezeResult({
			...makeBase(requestedKey, provenance, false, maskedConflicts),
			state: "unavailable",
			reason,
		});
	}

	explain(result: EffectiveConfigurationResult): EffectiveConfigurationExplanation {
		const ordering = deepFreeze(result.provenance.map((entry, index) => deepFreeze({ ...entry, order: index + 1 })));
		const physicalGroups = new Map<string, EffectiveConfigurationPhysicalDeduplicationExplanation>();
		for (const entry of result.provenance) {
			const identity = entry.physicalDeduplication.identity;
			const key = `${entry.canonicalKey}\u0000${identity}`;
			const previous = physicalGroups.get(key);
			if (!previous) {
				physicalGroups.set(key, {
					canonicalKey: entry.canonicalKey,
					identity,
					sourceIds: [entry.sourceId],
					aliases: entry.aliases,
					memberCount: entry.physicalDeduplication.memberCount,
					collapsed: entry.physicalDeduplication.collapsed,
				});
			} else {
				physicalGroups.set(key, {
					...previous,
					sourceIds: [...new Set([...previous.sourceIds, entry.sourceId])].sort(compareStrings),
					aliases: [...new Set([...previous.aliases, ...entry.aliases])].sort(compareStrings),
					memberCount: previous.memberCount + entry.physicalDeduplication.memberCount,
					collapsed: previous.collapsed || entry.physicalDeduplication.collapsed,
				});
			}
		}
		const physicalDedup = deepFreeze(
			[...physicalGroups.values()]
				.sort((a, b) => {
					const keyA = `${a.canonicalKey}\u0000${a.identity}`;
					const keyB = `${b.canonicalKey}\u0000${b.identity}`;
					return compareStrings(keyA, keyB);
				})
				.map(deepFreeze),
		);
		const eligibility = deepFreeze(
			result.provenance.map(entry =>
				deepFreeze({
					sourceId: entry.sourceId,
					eligible: entry.eligibility === "eligible",
					...(entry.ineligibilityReason === undefined ? {} : { reason: entry.ineligibilityReason }),
				}),
			),
		);

		const winner =
			result.state === "resolved"
				? deepFreeze({
						sourceId: result.winner.sourceId,
						rank: result.winner.rank,
						...(result.winner.safePath === undefined ? {} : { safePath: result.winner.safePath }),
						ownership: result.winner.ownership,
						writable: result.winner.ownership === "owned",
					})
				: undefined;
		const conflict = result.state === "conflict" ? result.candidates : undefined;
		const higherAbsentSourceIds = result.clearToLower
			? result.provenance
					.filter(entry => entry.eligibility === "eligible" && entry.presence === "absent")
					.map(entry => entry.sourceId)
			: [];
		return deepFreeze({
			canonicalKey: result.canonicalKey,
			state: result.state,
			...("reason" in result ? { reason: result.reason } : {}),
			ordering,
			provenance: result.provenance,
			evidence: result.evidence,
			aliases: physicalDedup,
			physicalDedup,
			eligibility,
			...(winner === undefined ? {} : { winner }),
			...(conflict === undefined ? {} : { conflict }),
			maskedConflicts: result.maskedConflicts,
			clearToLower: {
				occurred: result.clearToLower,
				higherAbsentSourceIds,
				...(result.clearToLower ? { revealedState: result.state } : {}),
			},
		});
	}
}

export function resolveEffectiveConfiguration(
	canonicalKey: string,
	records: readonly EffectiveConfigurationSourceRecordInput[],
): EffectiveConfigurationResult {
	return new EffectiveConfigurationResolver().resolve(canonicalKey, records);
}

export function canonicalizeEffectiveConfigurationValue(
	value: unknown,
): CanonicalConfigurationJsonValue | EffectiveConfigurationReasonCode {
	const result = canonicalizeJsonLike(value);
	return result.ok ? result.value : result.reason;
}
