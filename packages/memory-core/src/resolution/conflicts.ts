import { invalidInput, type MemoryResult } from "../errors";
import type { ConflictResult, MemoryClaim, MemoryDocumentType } from "../index";

import {
	type ClaimOrderingContext,
	compareAuthority,
	compareClaims,
	compareFreshness,
	compareSpecificity,
} from "./authority";
import { compareVolatility } from "./volatility";

export interface ResolveConflictsContext extends ClaimOrderingContext {}

type CompareMode = "authority" | "specificity" | "freshness" | "session";

interface Candidate {
	readonly claim: MemoryClaim;
	readonly value: string;
}

interface RejectedCandidate {
	readonly candidate: Candidate;
	readonly reason: string;
}

interface Selection {
	readonly winner: Candidate | null;
	readonly ties: readonly Candidate[];
}

interface RuleResult {
	readonly candidates: readonly Candidate[];
	readonly selection: Selection;
	readonly mode: CompareMode;
	readonly forcedRejected: readonly RejectedCandidate[];
	readonly unresolved: boolean;
	readonly blocked: boolean;
	readonly winnerReason: string;
}

const CONSTRAINT_TYPES: readonly MemoryDocumentType[] = ["constraint", "policy"];
const HYPOTHESIS_PROTECTED_TYPES: readonly MemoryDocumentType[] = [
	"fact",
	"observation",
	"constraint",
	"policy",
	"decision",
];
const TASK_STATE_PROTECTED_TYPES: readonly MemoryDocumentType[] = ["constraint", "policy"];
const OBSERVATION_TYPES: readonly MemoryDocumentType[] = ["fact", "observation"];

function invalid(detail: string): MemoryResult<never> {
	return invalidInput(`conflicts: ${detail}`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasType(types: readonly MemoryDocumentType[], type: MemoryDocumentType): boolean {
	return types.includes(type);
}

function normalize(value: string): string {
	return value.normalize("NFC").trim();
}

function textValue(value: unknown): string {
	return typeof value === "string" ? normalize(value) : "";
}

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(normalize(left), "utf8"), Buffer.from(normalize(right), "utf8"));
}

function sourceKey(claim: MemoryClaim): readonly string[] {
	return [
		textValue(claim.source.uri),
		textValue(claim.source.relPath),
		textValue(claim.source.heading),
		String(claim.source.startLine),
		String(claim.source.endLine),
		textValue(claim.source.digest),
	];
}

function compareSource(left: MemoryClaim, right: MemoryClaim): number {
	const leftKey = sourceKey(left);
	const rightKey = sourceKey(right);
	for (let index = 0; index < leftKey.length; index += 1) {
		const compared = compareUtf8(leftKey[index] ?? "", rightKey[index] ?? "");
		if (compared !== 0) return compared;
	}
	return 0;
}

function compareCandidateStable(left: Candidate, right: Candidate): number {
	return (
		compareUtf8(left.value, right.value) ||
		compareSource(left.claim, right.claim) ||
		compareUtf8(left.claim.authority, right.claim.authority) ||
		compareUtf8(left.claim.type, right.claim.type) ||
		compareUtf8(left.claim.freshness, right.claim.freshness) ||
		compareUtf8(left.claim.volatility, right.claim.volatility)
	);
}

function normalizeCandidate(claim: MemoryClaim): Candidate {
	return Object.freeze({ claim, value: normalize(claim.text) });
}

function validateContext(context: ResolveConflictsContext): MemoryResult<ResolveConflictsContext> {
	if (!isRecord(context) || typeof context.asOf !== "string") return invalid("context must contain asOf");
	const result = compareFreshness(context.asOf, context.asOf, context.asOf);
	if (!result.ok) return result;
	return { ok: true, value: Object.freeze({ asOf: context.asOf }) };
}

function validateClaims(claims: readonly MemoryClaim[], context: ResolveConflictsContext): MemoryResult<true> {
	for (const [index, claim] of claims.entries()) {
		if (claim === null || typeof claim !== "object" || Array.isArray(claim)) {
			return invalid(`claim ${index} is malformed`);
		}
		const normalizedKey = typeof claim.claimKey === "string" ? normalize(claim.claimKey) : "";
		const normalizedText = typeof claim.text === "string" ? normalize(claim.text) : "";
		if (normalizedKey.length === 0 || normalizedText.length === 0)
			return invalid(`claim ${index} has an empty key or text`);
		const checked = compareClaims(claim, claim, context);
		if (!checked.ok) return checked;
	}
	return { ok: true, value: true };
}

function candidateTypes(candidates: readonly Candidate[]): readonly MemoryDocumentType[] {
	const values = new Set<MemoryDocumentType>();
	for (const candidate of candidates) values.add(candidate.claim.type);
	return [...values].sort(compareUtf8);
}

function compareDimensions(
	left: Candidate,
	right: Candidate,
	context: ResolveConflictsContext,
	mode: CompareMode,
): MemoryResult<number> {
	const compare = (dimension: "authority" | "specificity" | "freshness" | "volatility"): MemoryResult<number> => {
		if (dimension === "authority") {
			return { ok: true, value: compareAuthority(left.claim.authority, right.claim.authority) };
		}
		if (dimension === "specificity") {
			return {
				ok: true,
				value: compareSpecificity(left.claim.source.scope, right.claim.source.scope),
			};
		}
		if (dimension === "freshness") {
			return compareFreshness(left.claim.freshness, right.claim.freshness, context.asOf);
		}
		return { ok: true, value: compareVolatility(left.claim.volatility, right.claim.volatility) };
	};
	const dimensions: readonly ("authority" | "specificity" | "freshness" | "volatility")[] =
		mode === "authority"
			? ["authority", "specificity", "freshness", "volatility"]
			: mode === "specificity"
				? ["specificity", "authority", "freshness", "volatility"]
				: mode === "freshness"
					? ["freshness", "authority", "specificity", "volatility"]
					: ["specificity", "freshness", "authority", "volatility"];
	for (const dimension of dimensions) {
		const result = compare(dimension);
		if (!result.ok) return result;
		if (result.value !== 0) return result;
	}
	return { ok: true, value: 0 };
}

function deduplicateCandidates(
	claims: readonly MemoryClaim[],
	context: ResolveConflictsContext,
): MemoryResult<readonly Candidate[]> {
	const candidates: Candidate[] = [];
	for (const claim of claims) {
		const candidate = normalizeCandidate(claim);
		const existingIndex = candidates.findIndex(item => item.value === candidate.value);
		if (existingIndex < 0) {
			candidates.push(candidate);
			continue;
		}
		const existing = candidates[existingIndex];
		if (existing === undefined) return invalid("candidate deduplication failed");
		const compared = compareClaims(candidate.claim, existing.claim, context);
		if (!compared.ok) return compared;
		if (compared.value > 0 || (compared.value === 0 && compareCandidateStable(candidate, existing) < 0)) {
			candidates[existingIndex] = candidate;
		}
	}
	candidates.sort(compareCandidateStable);
	return { ok: true, value: Object.freeze(candidates) };
}

function selectCandidates(
	candidates: readonly Candidate[],
	context: ResolveConflictsContext,
	mode: CompareMode,
): MemoryResult<Selection> {
	if (candidates.length === 0) return invalid("cannot select from an empty candidate set");
	let winner = candidates[0];
	if (winner === undefined) return invalid("candidate selection lost its first candidate");
	let ties: Candidate[] = [winner];
	for (const candidate of candidates.slice(1)) {
		const compared = compareDimensions(candidate, winner, context, mode);
		if (!compared.ok) return compared;
		if (compared.value > 0) {
			winner = candidate;
			ties = [candidate];
		} else if (compared.value === 0) {
			ties = [...ties, candidate];
		}
	}
	return { ok: true, value: Object.freeze({ winner: ties.length === 1 ? winner : null, ties: Object.freeze(ties) }) };
}

function propertyString(value: unknown, key: string): string | null {
	if (!isRecord(value)) return null;
	const candidate = value[key];
	return typeof candidate === "string" ? normalize(candidate) : null;
}

function propertyBoolean(value: unknown, key: string): boolean | null {
	if (!isRecord(value)) return null;
	const candidate = value[key];
	return typeof candidate === "boolean" ? candidate : null;
}

function propertyStrings(value: unknown, key: string): readonly string[] {
	if (!isRecord(value)) return [];
	const candidate = value[key];
	if (typeof candidate === "string") return [normalize(candidate)];
	if (!Array.isArray(candidate)) return [];
	return candidate
		.filter((item): item is string => typeof item === "string")
		.map(normalize)
		.filter(Boolean);
}

function claimStatus(candidate: Candidate): string {
	const claimRecord = candidate.claim as unknown as Readonly<Record<string, unknown>>;
	const sourceRecord = candidate.claim.source as unknown as Readonly<Record<string, unknown>>;
	return propertyString(claimRecord, "status") ?? propertyString(sourceRecord, "status") ?? "active";
}

function claimIsActive(candidate: Candidate): boolean {
	const claimRecord = candidate.claim as unknown as Readonly<Record<string, unknown>>;
	const sourceRecord = candidate.claim.source as unknown as Readonly<Record<string, unknown>>;
	const active = propertyBoolean(claimRecord, "active") ?? propertyBoolean(sourceRecord, "active");
	if (active !== null) return active;
	return claimStatus(candidate) === "active";
}

function decisionReferences(candidate: Candidate): readonly string[] {
	const claimRecord = candidate.claim as unknown as Readonly<Record<string, unknown>>;
	const sourceRecord = candidate.claim.source as unknown as Readonly<Record<string, unknown>>;
	const values = [...propertyStrings(claimRecord, "supersedes"), ...propertyStrings(sourceRecord, "supersedes")];
	const textMatch = /\bsupersedes?\s*:?\s+([\p{L}\p{N}_.:/-]+)/iu.exec(candidate.value);
	if (textMatch?.[1] !== undefined) values.push(normalize(textMatch[1]));
	return Object.freeze(values.filter(Boolean));
}

function decisionIdentities(candidate: Candidate): readonly string[] {
	const claimRecord = candidate.claim as unknown as Readonly<Record<string, unknown>>;
	const sourceRecord = candidate.claim.source as unknown as Readonly<Record<string, unknown>>;
	const relPath = propertyString(sourceRecord, "relPath");
	const uri = candidate.claim.source.uri;
	// `supersedes` entries reference a document id, which may be written as the
	// bare id, the full memory URI, or the root-relative path. Accept every
	// canonical spelling so a predecessor is matched deterministically.
	const derived = [
		uri.split("#")[0]?.split("/").pop() ?? null,
		relPath === null ? null : (relPath.split("/").pop() ?? null),
	].map(value => (value === null ? null : value.replace(/\.md$/u, "")));
	return Object.freeze(
		[
			candidate.claim.claimKey,
			uri,
			propertyString(claimRecord, "id"),
			propertyString(sourceRecord, "id"),
			relPath,
			...derived,
		]
			.filter((value): value is string => value !== null && value.length > 0)
			.map(normalize),
	);
}

function supersedes(left: Candidate, right: Candidate): boolean {
	const identities = decisionIdentities(right);
	return decisionReferences(left).some(reference => identities.some(identity => reference === identity));
}

function isSameScopeAuthority(candidate: Candidate): boolean {
	return candidate.claim.source.scope === "global" && candidate.claim.authority === "user-confirmed";
}

function isConstraint(candidate: Candidate): boolean {
	return hasType(CONSTRAINT_TYPES, candidate.claim.type);
}

function isObservation(candidate: Candidate): boolean {
	return hasType(OBSERVATION_TYPES, candidate.claim.type);
}

function uniqueSorted(values: readonly string[]): readonly string[] {
	return [...new Set(values.map(normalize))].sort(compareUtf8);
}

function dimensionsFor(
	candidates: readonly Candidate[],
	selection: Candidate | null,
	mode: CompareMode,
	blocked: boolean,
): ConflictResult["dimensions"] {
	const authorities = uniqueSorted(candidates.map(candidate => candidate.claim.authority));
	const scopes = uniqueSorted(candidates.map(candidate => candidate.claim.source.scope));
	const freshness = uniqueSorted(candidates.map(candidate => candidate.claim.freshness));
	const volatilities = uniqueSorted(candidates.map(candidate => candidate.claim.volatility));
	const authority =
		authorities.length === 1
			? `authority tied at ${authorities[0]}`
			: selection === null
				? `authority candidates: ${authorities.join(" < ")}; no unique authority winner`
				: `authority winner ${selection.claim.authority} over ${authorities.filter(value => value !== selection.claim.authority).join(", ")}`;
	const specificityOrder =
		mode === "specificity" || mode === "session"
			? "specificity-first"
			: mode === "freshness"
				? "freshness-first"
				: "authority-first";
	const specificity =
		scopes.length === 1
			? `scope specificity tied at ${scopes[0]}`
			: selection === null
				? `scope candidates: ${scopes.join(" < ")}; no unique specificity winner`
				: `scope winner ${selection.claim.source.scope} under ${specificityOrder} ordering`;
	const freshnessText =
		freshness.length === 1
			? `freshness tied at ${freshness[0]}`
			: selection === null
				? `freshness candidates: ${freshness.join(", ")}; no unique freshness winner`
				: `freshness winner ${selection.claim.freshness} (newest relative to injected asOf)`;
	const volatility =
		volatilities.length === 1
			? `volatility tied at ${volatilities[0]}`
			: `volatility downranks only: ${volatilities.join(", ")}; volatile claims require verification before action`;
	return Object.freeze({
		authority: blocked ? `${authority}; user-confirmed global constraint is protected` : authority,
		specificity: specificity,
		freshness: freshnessText,
		volatility,
	});
}

function rejectedEntry(
	candidate: Candidate,
	reason: string,
): { readonly value: string; readonly source: string; readonly reason: string } {
	return Object.freeze({ value: candidate.value, source: normalize(candidate.claim.source.uri), reason });
}

function sortRejected(
	entries: readonly { readonly value: string; readonly source: string; readonly reason: string }[],
): readonly { readonly value: string; readonly source: string; readonly reason: string }[] {
	return Object.freeze(
		[...entries].sort(
			(left, right) =>
				compareUtf8(left.value, right.value) ||
				compareUtf8(left.source, right.source) ||
				compareUtf8(left.reason, right.reason),
		),
	);
}

function winnerReason(type: MemoryDocumentType, mode: CompareMode, superseding: boolean): string {
	if (superseding) return "active decision explicitly supersedes its predecessor";
	if (type === "constraint" || type === "policy")
		return "higher authority wins, followed by scope specificity, freshness, and volatility";
	if (type === "convention") return "more specific scope wins unless a higher-authority constraint applies";
	if (type === "preference") return "the explicit project or session scope overrides a global default when present";
	if (type === "fact" || type === "observation")
		return "newer evidence wins, with tool-verified evidence preferred at equal freshness";
	if (type === "task-state")
		return "current session/live task state wins over older task state and cannot redefine standing policy";
	if (type === "hypothesis")
		return "hypothesis ordering applies only when no fact, verified observation, policy, or decision is present";
	return `resolved by ${mode}-ordered authority dimensions`;
}

function rejectionReason(type: MemoryDocumentType, winner: Candidate | null, candidate: Candidate): string {
	if (type === "hypothesis") return "hypothesis cannot override a fact, verified observation, policy, or decision";
	if (type === "task-state" && winner !== null && isConstraint(winner))
		return "task state cannot redefine standing policy or constraint";
	if ((type === "constraint" || type === "policy") && winner !== null && isSameScopeAuthority(winner)) {
		return "repository, project, or session claim cannot weaken a user-confirmed global constraint";
	}
	if (winner !== null && winner.claim.source.scope !== candidate.claim.source.scope) {
		return `lost to more specific ${winner.claim.source.scope} scope`;
	}
	if (winner !== null && winner.claim.authority !== candidate.claim.authority) {
		return `lost to higher authority ${winner.claim.authority}`;
	}
	if (winner !== null && winner.claim.freshness !== candidate.claim.freshness) return "lost to newer evidence";
	return "lost to the deterministic conflict ordering";
}

function buildResult(claimKey: string, allCandidates: readonly Candidate[], rule: RuleResult): ConflictResult {
	const winner = rule.selection.winner;
	const forced = new Map<Candidate, string>();
	for (const item of rule.forcedRejected) forced.set(item.candidate, item.reason);
	const rejectedCandidates = allCandidates.filter(candidate => {
		if (winner !== null) return candidate !== winner;
		if (rule.blocked) return rule.forcedRejected.some(item => item.candidate === candidate);
		return true;
	});
	const rejected = rejectedCandidates.map(candidate => {
		const reason =
			forced.get(candidate) ??
			(winner === null
				? "unresolved conflict; retained for user confirmation"
				: rejectionReason(candidate.claim.type, winner, candidate));
		return rejectedEntry(candidate, reason);
	});
	const volatileAction = winner !== null && isObservation(winner) && winner.claim.volatility === "volatile";
	const conflict = allCandidates.length > 1;
	const requiresUserConfirmation = rule.unresolved || rule.blocked || volatileAction;
	return Object.freeze({
		claimKey,
		conflict,
		resolution:
			winner === null
				? null
				: Object.freeze({
						value: winner.value,
						source: normalize(winner.claim.source.uri),
						reason: rule.winnerReason,
					}),
		rejected: sortRejected(rejected),
		requiresUserConfirmation,
		dimensions: dimensionsFor(allCandidates, winner, rule.mode, rule.blocked),
	});
}

function unresolvedRule(
	candidates: readonly Candidate[],
	mode: CompareMode,
	forcedRejected: readonly RejectedCandidate[] = [],
): RuleResult {
	return {
		candidates,
		selection: { winner: null, ties: candidates },
		mode,
		forcedRejected,
		unresolved: true,
		blocked: false,
		winnerReason: "no unique winner; user confirmation is required",
	};
}

function selectedRule(
	candidates: readonly Candidate[],
	selection: Selection,
	mode: CompareMode,
	winnerType: MemoryDocumentType,
	forcedRejected: readonly RejectedCandidate[] = [],
	superseding = false,
): RuleResult {
	return {
		candidates,
		selection,
		mode,
		forcedRejected,
		unresolved: selection.winner === null,
		blocked: false,
		winnerReason:
			selection.winner === null
				? "no unique winner; user confirmation is required"
				: winnerReason(winnerType, mode, superseding),
	};
}

function blockedRule(candidates: readonly Candidate[], protectedCandidate: Candidate): RuleResult {
	const forcedRejected = candidates
		.filter(candidate => candidate !== protectedCandidate)
		.map(candidate => ({
			candidate,
			reason: "cannot weaken a user-confirmed global safety or authorization constraint",
		}));
	return {
		candidates,
		selection: { winner: null, ties: [protectedCandidate] },
		mode: "authority",
		forcedRejected,
		unresolved: false,
		blocked: true,
		winnerReason: "user-confirmed global constraint is unbeatable without explicit user confirmation",
	};
}

function highestAuthorityConstraint(
	constraints: readonly Candidate[],
	conventions: readonly Candidate[],
): Candidate | null {
	for (const constraint of constraints) {
		if (
			conventions.some(convention => compareAuthority(constraint.claim.authority, convention.claim.authority) > 0)
		) {
			return constraint;
		}
	}
	return null;
}

function resolveCandidates(
	claimKey: string,
	candidates: readonly Candidate[],
	allCandidates: readonly Candidate[],
	context: ResolveConflictsContext,
	mode: CompareMode,
	forcedRejected: readonly RejectedCandidate[] = [],
	winnerType: MemoryDocumentType,
	superseding = false,
): MemoryResult<ConflictResult> {
	const selection = selectCandidates(candidates, context, mode);
	if (!selection.ok) return selection;
	const rule = selectedRule(candidates, selection.value, mode, winnerType, forcedRejected, superseding);
	return { ok: true, value: buildResult(claimKey, allCandidates, rule) };
}

function resolveGroup(
	claimKey: string,
	candidates: readonly Candidate[],
	context: ResolveConflictsContext,
): MemoryResult<ConflictResult> {
	if (candidates.length === 0) return invalid(`claim group ${claimKey} is empty`);
	if (candidates.length === 1) {
		return {
			ok: true,
			value: buildResult(
				claimKey,
				candidates,
				selectedRule(
					candidates,
					{ winner: candidates[0] ?? null, ties: candidates },
					"authority",
					candidates[0]?.claim.type ?? "note",
				),
			),
		};
	}
	const types = candidateTypes(candidates);
	const protectedGlobal = candidates.find(candidate => isSameScopeAuthority(candidate) && isConstraint(candidate));
	if (protectedGlobal !== undefined) {
		const weakening = candidates.some(candidate => candidate !== protectedGlobal && !isSameScopeAuthority(candidate));
		if (weakening)
			return { ok: true, value: buildResult(claimKey, candidates, blockedRule(candidates, protectedGlobal)) };
	}
	const constraints = candidates.filter(isConstraint);
	const hypotheses = candidates.filter(candidate => candidate.claim.type === "hypothesis");
	const protectedHypothesisTargets = candidates.filter(candidate =>
		hasType(HYPOTHESIS_PROTECTED_TYPES, candidate.claim.type),
	);
	if (hypotheses.length > 0 && protectedHypothesisTargets.length > 0) {
		const forced = hypotheses.map(candidate => ({
			candidate,
			reason: rejectionReason("hypothesis", protectedHypothesisTargets[0] ?? null, candidate),
		}));
		return resolveCandidates(
			claimKey,
			protectedHypothesisTargets,
			candidates,
			context,
			"authority",
			forced,
			protectedHypothesisTargets[0]?.claim.type ?? "fact",
		);
	}
	const taskStates = candidates.filter(candidate => candidate.claim.type === "task-state");
	const standingPolicies = candidates.filter(candidate => hasType(TASK_STATE_PROTECTED_TYPES, candidate.claim.type));
	if (taskStates.length > 0 && standingPolicies.length > 0) {
		const forced = taskStates.map(candidate => ({
			candidate,
			reason: "task state cannot redefine standing policy or constraint",
		}));
		return resolveCandidates(
			claimKey,
			standingPolicies,
			candidates,
			context,
			"authority",
			forced,
			standingPolicies[0]?.claim.type ?? "policy",
		);
	}
	const conventions = candidates.filter(candidate => candidate.claim.type === "convention");
	if (conventions.length > 0 && constraints.length > 0) {
		const higherConstraint = highestAuthorityConstraint(constraints, conventions);
		if (higherConstraint !== null) {
			const forced = conventions.map(candidate => ({
				candidate,
				reason: "convention cannot violate a higher-authority constraint",
			}));
			return resolveCandidates(
				claimKey,
				constraints,
				candidates,
				context,
				"authority",
				forced,
				higherConstraint.claim.type,
			);
		}
		const forced = constraints.map(candidate => ({
			candidate,
			reason: "lower-authority constraint does not override a more specific convention",
		}));
		return resolveCandidates(claimKey, conventions, candidates, context, "specificity", forced, "convention");
	}
	const observations = candidates.filter(isObservation);
	if (taskStates.length > 0 && observations.length > 0) {
		const forced = taskStates.map(candidate => ({
			candidate,
			reason: "current session/live observation supersedes older task state",
		}));
		return resolveCandidates(
			claimKey,
			observations,
			candidates,
			context,
			"freshness",
			forced,
			observations[0]?.claim.type ?? "observation",
		);
	}
	if (types.length !== 1) {
		return { ok: true, value: buildResult(claimKey, candidates, unresolvedRule(candidates, "authority")) };
	}
	const type = types[0] ?? "note";
	if (type === "decision") {
		const active = candidates.filter(claimIsActive);
		// A predecessor is often already marked `superseded`, so the reference set
		// is every candidate in the group; only the superseding claim must be active.
		const superseders = active.filter(candidate =>
			candidates.some(other => other !== candidate && supersedes(candidate, other)),
		);
		if (superseders.length > 0) {
			const selection = selectCandidates(superseders, context, "authority");
			if (!selection.ok) return selection;
			return {
				ok: true,
				value: buildResult(
					claimKey,
					candidates,
					selectedRule(candidates, selection.value, "authority", type, [], true),
				),
			};
		}
	}
	const mode: CompareMode =
		type === "convention" || type === "preference"
			? "specificity"
			: type === "fact" || type === "observation"
				? "freshness"
				: type === "task-state"
					? "session"
					: "authority";
	return resolveCandidates(claimKey, candidates, candidates, context, mode, [], type);
}

/** Resolve claims deterministically into one typed conflict result per claim key. */
export function resolveConflicts(
	claims: readonly MemoryClaim[],
	context: ResolveConflictsContext,
): MemoryResult<readonly ConflictResult[]> {
	if (!Array.isArray(claims)) return invalid("claims must be an array");
	const checkedContext = validateContext(context);
	if (!checkedContext.ok) return checkedContext;
	const validated = validateClaims(claims, checkedContext.value);
	if (!validated.ok) return validated;
	const groups = new Map<string, MemoryClaim[]>();
	for (const claim of claims) {
		const key = normalize(claim.claimKey);
		const group = groups.get(key);
		if (group === undefined) groups.set(key, [claim]);
		else group.push(claim);
	}
	const results: ConflictResult[] = [];
	for (const claimKey of [...groups.keys()].sort(compareUtf8)) {
		const group = groups.get(claimKey);
		if (group === undefined) return invalid(`claim group ${claimKey} disappeared`);
		const deduplicated = deduplicateCandidates(group, checkedContext.value);
		if (!deduplicated.ok) return deduplicated;
		const resolved = resolveGroup(claimKey, deduplicated.value, checkedContext.value);
		if (!resolved.ok) return resolved;
		results.push(resolved.value);
	}
	return { ok: true, value: Object.freeze(results) };
}
