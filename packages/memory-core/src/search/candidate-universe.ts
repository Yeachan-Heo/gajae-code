import { invalidInput, type MemoryResult } from "../errors";
import { createSearchBudget, reserveFile, type SearchBudgetState } from "./budget";

export type CandidateEntryKind = "file" | "directory" | "symlink";

export interface CandidateScopeDescriptor {
	readonly kind: string;
	/** An already-admitted and policy-bound root. It is never returned in a candidate. */
	readonly root: string;
	readonly enabled?: boolean;
	/** Optional URI prefix, such as `global://` or `project://project-key/`. */
	readonly uriPrefix?: string;
}

export interface CandidateDirectoryEntry {
	readonly name: string;
	readonly kind?: CandidateEntryKind;
}

export interface CandidateReservation {
	readonly scope: string;
	readonly relPath: string;
	readonly stage: "map-route" | "metadata" | "heading";
	readonly uri?: string;
}

export interface CandidateUniverseCandidate {
	readonly scope: string;
	readonly relPath: string;
	readonly uri: string;
}

export interface CandidateUniverseResult {
	readonly candidates: readonly CandidateUniverseCandidate[];
	readonly budget: SearchBudgetState;
	readonly truncated: boolean;
}

export interface CandidateUniverseInput {
	readonly scopes: readonly CandidateScopeDescriptor[];
	readonly list: (
		scope: CandidateScopeDescriptor,
		relPath: string,
	) => readonly (CandidateDirectoryEntry | string)[] | Promise<readonly (CandidateDirectoryEntry | string)[]>;
	readonly stat?: (
		scope: CandidateScopeDescriptor,
		relPath: string,
	) => CandidateEntryKind | Promise<CandidateEntryKind>;
	readonly reservations?: readonly CandidateReservation[];
	readonly budget?: SearchBudgetState;
}

type DiscoveredCandidate = CandidateUniverseCandidate;

interface OrderedEntry {
	readonly normalizedName: string;
	readonly originalName: string;
	readonly kind?: CandidateEntryKind;
}

const EXCLUDED_SEGMENTS = new Set(["archive", "proposals", ".journal", ".locks", "transcripts", "unverified"]);
const STAGE_ORDER: Readonly<Record<CandidateReservation["stage"], number>> = Object.freeze({
	"map-route": 0,
	metadata: 1,
	heading: 2,
});

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function invalid(detail: string): MemoryResult<never> {
	return invalidInput(`candidate universe: ${detail}`);
}

function normalizeSegment(value: string): string | null {
	if (typeof value !== "string") return null;
	if (value.length === 0 || value.includes("\u0000") || value.includes("/") || value.includes("\\")) return null;
	const normalized = value.normalize("NFC");
	if (normalized === "." || normalized === "..") return null;
	return normalized;
}

function normalizeRelativePath(value: string): string | null {
	if (typeof value !== "string") return null;
	if (value.length === 0) return "";
	if (value.includes("\\") || value.startsWith("/") || value.includes("\u0000")) return null;
	const segments = value.split("/");
	const normalized: string[] = [];
	for (const segment of segments) {
		const safe = normalizeSegment(segment);
		if (safe === null) return null;
		normalized.push(safe);
	}
	return normalized.join("/");
}

function pathSegments(relPath: string): readonly string[] {
	return relPath.length === 0 ? [] : relPath.split("/");
}

function isExcludedPath(relPath: string): boolean {
	const segments = pathSegments(relPath);
	for (const segment of segments) {
		const lower = segment.toLowerCase();
		if (EXCLUDED_SEGMENTS.has(lower) || lower.endsWith(".jsonl")) return true;
		if (
			lower === "unverified.md" ||
			lower.includes("transcript") ||
			lower.includes("unverified") ||
			lower.endsWith(".transcript.md") ||
			lower.endsWith(".unverified.md")
		)
			return true;
	}
	return false;
}

function isMarkdown(relPath: string): boolean {
	return relPath.toLowerCase().endsWith(".md");
}

function makeUri(scope: CandidateScopeDescriptor, relPath: string): string {
	const prefix = typeof scope.uriPrefix === "string" ? scope.uriPrefix.normalize("NFC") : undefined;
	if (prefix === undefined || prefix.length === 0) return `${scope.kind.normalize("NFC")}://${relPath}`;
	if (prefix.endsWith("://") || prefix.endsWith("/")) return `${prefix}${relPath}`;
	return `${prefix}/${relPath}`;
}

function entryName(entry: CandidateDirectoryEntry | string): string | null {
	if (typeof entry === "string") return entry;
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
	return typeof entry.name === "string" ? entry.name : null;
}

function entryKind(entry: CandidateDirectoryEntry | string): CandidateEntryKind | undefined | null {
	if (typeof entry === "string") return undefined;
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
	return entry.kind;
}

function orderedEntries(entries: readonly (CandidateDirectoryEntry | string)[]): MemoryResult<readonly OrderedEntry[]> {
	if (!Array.isArray(entries)) return invalid("directory listing must be an array");
	const ordered: OrderedEntry[] = [];
	for (const entry of entries) {
		const originalName = entryName(entry);
		if (originalName === null) return invalid("directory entry name must be a string");
		const normalizedName = normalizeSegment(originalName);
		if (normalizedName === null) return invalid(`unsafe directory entry ${JSON.stringify(originalName)}`);
		const kind = entryKind(entry);
		if (kind === null) return invalid(`invalid directory entry ${JSON.stringify(normalizedName)}`);
		if (kind !== undefined && kind !== "file" && kind !== "directory" && kind !== "symlink") {
			return invalid(`unknown directory entry kind for ${JSON.stringify(normalizedName)}`);
		}
		ordered.push({ normalizedName, originalName, kind });
	}
	ordered.sort((left, right) => {
		const byNormalized = compareUtf8(left.normalizedName, right.normalizedName);
		return byNormalized !== 0 ? byNormalized : compareUtf8(left.originalName, right.originalName);
	});

	const unique: OrderedEntry[] = [];
	const seenNames = new Set<string>();
	for (const entry of ordered) {
		if (seenNames.has(entry.normalizedName)) continue;
		seenNames.add(entry.normalizedName);
		unique.push(entry);
	}
	return { ok: true, value: unique };
}

function reservationKey(scope: string, relPath: string): string {
	return `${scope.normalize("NFC")}\u0000${relPath}`;
}

function normalizedReservation(reservation: CandidateReservation): CandidateReservation | null {
	if (typeof reservation !== "object" || reservation === null || Array.isArray(reservation)) return null;
	if (typeof reservation.scope !== "string" || typeof reservation.relPath !== "string") return null;
	if (reservation.stage !== "map-route" && reservation.stage !== "metadata" && reservation.stage !== "heading")
		return null;
	if (reservation.uri !== undefined && typeof reservation.uri !== "string") return null;
	const relPath = normalizeRelativePath(reservation.relPath);
	if (relPath === null || relPath.length === 0 || !isMarkdown(relPath) || isExcludedPath(relPath)) return null;
	const scope = reservation.scope.normalize("NFC");
	if (scope.length === 0) return null;
	return {
		scope,
		relPath,
		stage: reservation.stage,
		uri: reservation.uri?.normalize("NFC"),
	};
}

function reservationComparator(
	left: readonly [CandidateReservation, number],
	right: readonly [CandidateReservation, number],
): number {
	const byStage = STAGE_ORDER[left[0].stage] - STAGE_ORDER[right[0].stage];
	if (byStage !== 0) return byStage;
	const byScope = compareUtf8(left[0].scope, right[0].scope);
	if (byScope !== 0) return byScope;
	const byPath = compareUtf8(left[0].relPath, right[0].relPath);
	return byPath !== 0 ? byPath : left[1] - right[1];
}

async function walkScope(
	scope: CandidateScopeDescriptor,
	list: CandidateUniverseInput["list"],
	stat: CandidateUniverseInput["stat"],
	relPath: string,
	output: DiscoveredCandidate[],
): Promise<MemoryResult<true>> {
	let listed: readonly (CandidateDirectoryEntry | string)[];
	try {
		listed = await list(scope, relPath);
	} catch {
		return invalid(`listing failed for ${scope.kind}:${relPath}`);
	}
	const entries = orderedEntries(listed);
	if (!entries.ok) return entries;

	for (const entry of entries.value) {
		const childPath = relPath.length === 0 ? entry.normalizedName : `${relPath}/${entry.normalizedName}`;
		if (isExcludedPath(childPath)) continue;
		let kind = entry.kind;
		if (kind === undefined) {
			if (stat === undefined) {
				kind = "file";
			} else {
				try {
					kind = await stat(scope, childPath);
					if (kind !== "file" && kind !== "directory" && kind !== "symlink") {
						return invalid(`unknown stat kind for ${scope.kind}:${childPath}`);
					}
				} catch {
					return invalid(`stat failed for ${scope.kind}:${childPath}`);
				}
			}
		}
		if (kind === "directory") {
			const walked = await walkScope(scope, list, stat, childPath, output);
			if (!walked.ok) return walked;
			continue;
		}
		if (kind !== "file" || !isMarkdown(childPath)) continue;
		output.push({
			scope: scope.kind.normalize("NFC"),
			relPath: childPath,
			uri: makeUri(scope, childPath),
		});
	}
	return { ok: true, value: true };
}

/** Walk admitted scope roots depth-first without reading any file body. */
export async function buildCandidateUniverse(
	input: CandidateUniverseInput,
): Promise<MemoryResult<CandidateUniverseResult>> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return invalid("input must be an object");
	if (!Array.isArray(input.scopes) || input.scopes.length === 0) return invalid("at least one scope is required");
	if (typeof input.list !== "function") return invalid("a listing callback is required");
	if (input.stat !== undefined && typeof input.stat !== "function") return invalid("stat must be a callback");
	if (input.reservations !== undefined && !Array.isArray(input.reservations))
		return invalid("reservations must be an array");

	const scopes: CandidateScopeDescriptor[] = [];
	for (const scope of input.scopes) {
		if (typeof scope !== "object" || scope === null || Array.isArray(scope))
			return invalid("scope must be an object");
		if (typeof scope.kind !== "string" || typeof scope.root !== "string") {
			return invalid("scope kind and admitted root are required");
		}
		if (scope.enabled !== undefined && typeof scope.enabled !== "boolean")
			return invalid("scope enabled must be boolean");
		if (scope.uriPrefix !== undefined && typeof scope.uriPrefix !== "string")
			return invalid("scope URI prefix must be a string");
		if (scope.enabled === false) continue;
		const kind = scope.kind.normalize("NFC");
		if (kind.length === 0 || scope.root.length === 0) return invalid("scope kind and admitted root are required");
		scopes.push({ ...scope, kind });
	}
	scopes.sort((left, right) => compareUtf8(left.kind, right.kind));
	const discovered: DiscoveredCandidate[] = [];
	const scopeKinds = new Set<string>();

	for (const scope of scopes) {
		if (scopeKinds.has(scope.kind)) return invalid(`duplicate scope kind ${scope.kind}`);
		scopeKinds.add(scope.kind);
		const walked = await walkScope(scope, input.list, input.stat, "", discovered);
		if (!walked.ok) return walked;
	}

	const byKey = new Map<string, DiscoveredCandidate>();
	for (const candidate of discovered) {
		const key = reservationKey(candidate.scope, candidate.relPath);
		if (!byKey.has(key)) byKey.set(key, candidate);
	}

	const reservations: Array<readonly [CandidateReservation, number]> = [];
	for (const [index, reservation] of (input.reservations ?? []).entries()) {
		const normalized = normalizedReservation(reservation);
		if (normalized !== null) reservations.push([normalized, index]);
	}
	reservations.sort(reservationComparator);

	const ordered: DiscoveredCandidate[] = [];
	const reservedKeys = new Set<string>();
	for (const [reservation] of reservations) {
		const key = reservationKey(reservation.scope, reservation.relPath);
		const candidate = byKey.get(key);
		if (candidate === undefined || reservedKeys.has(key)) continue;
		reservedKeys.add(key);
		ordered.push({
			...candidate,
			uri: reservation.uri ?? candidate.uri,
		});
	}
	for (const candidate of byKey.values()) {
		if (!reservedKeys.has(reservationKey(candidate.scope, candidate.relPath))) ordered.push(candidate);
	}

	let budget = input.budget ?? createSearchBudget();
	const candidates: CandidateUniverseCandidate[] = [];
	const seenUris = new Set<string>();
	for (const candidate of ordered) {
		if (seenUris.has(candidate.uri)) continue;
		seenUris.add(candidate.uri);
		const reservation = reserveFile(budget, 1, `${candidate.scope}:${candidate.relPath}`);
		budget = reservation.state;
		if (!reservation.accepted) continue;
		candidates.push({
			scope: candidate.scope,
			relPath: candidate.relPath,
			uri: candidate.uri,
		});
	}
	return {
		ok: true,
		value: Object.freeze({
			candidates: Object.freeze(candidates),
			budget,
			truncated: budget.truncated,
		}),
	};
}
