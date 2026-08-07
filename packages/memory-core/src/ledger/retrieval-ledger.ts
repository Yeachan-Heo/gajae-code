import { createHash } from "node:crypto";
import { parseMemoryUri } from "../documents/uri";
import type { MemoryEnvironment } from "../env";
import { validateMemoryEnvironment } from "../env";
import { invalidInput, MEMORY_EXIT_CODES, type MemoryResult } from "../errors";
import type { SensitivityFinding } from "../index";
import { authorizeLedgerAccess } from "../policy/access-policy";
import { checkInitializedRoot } from "../policy/initialized";

import { scanSecretContent } from "../policy/secret-scan";
import type { SearchBudgetLimits, SearchBudgetState, SearchBudgetUsage } from "../search/budget";
import { appendJsonl } from "../storage/append-jsonl";
import { VerifiedStorageError } from "../storage/verified-open";

export const RETRIEVAL_LEDGER_SCHEMA_VERSION = "gajae.memory.retrieval-ledger-entry.v1" as const;

const DEFAULT_BUDGET_LIMITS: SearchBudgetLimits = Object.freeze({
	maxMaps: 4,
	maxFiles: 20,
	maxSections: 8,
	maxChars: 24_000,
});

const DEFAULT_BUDGET_USAGE: SearchBudgetUsage = Object.freeze({
	maps: 0,
	files: 0,
	sections: 0,
	chars: 0,
});
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const SAFE_DIGEST = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/;
const STRICT_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

type LedgerRecord = { readonly [key: string]: unknown };

type ScopeInput = string | RetrievalLedgerScopeInput;
type MapInput = string | RetrievalLedgerMapInput;

export interface RetrievalLedgerScopeInput {
	readonly scope?: string;
	readonly kind?: string;
	readonly name?: string;
	readonly digest?: string | null;
	readonly scopeDigest?: string | null;
	readonly startLine?: number;
	readonly endLine?: number;
	readonly lineStart?: number;
	readonly lineEnd?: number;
}

export interface RetrievalLedgerMapInput {
	readonly uri?: string;
	readonly href?: string;
	readonly digest?: string | null;
	readonly mapDigest?: string | null;
	readonly sourceDigest?: string | null;
	readonly startLine?: number;
	readonly endLine?: number;
	readonly lineStart?: number;
	readonly lineEnd?: number;
}

export interface RetrievalLedgerSourceInput {
	readonly uri?: string;
	readonly href?: string;
	readonly digest?: string | null;
	readonly sourceDigest?: string | null;
	readonly sha256?: string | null;
	readonly startLine?: number;
	readonly endLine?: number;
	readonly lineStart?: number;
	readonly lineEnd?: number;
	readonly stage?: string | null;
	readonly authority?: string | null;
	readonly volatility?: string | null;
	readonly heading?: string | null;
	/** Accepted at the boundary only so callers can prove it is omitted. */
	readonly relPath?: string;
	/** Legacy alias accepted at the boundary only; it is never persisted. */
	readonly path?: string;
}

export interface RetrievalLedgerRejectionInput {
	readonly uri?: string | null;
	readonly href?: string | null;
	readonly candidateId?: string | null;
	readonly digest?: string | null;
	readonly sourceDigest?: string | null;
	readonly reason: string;
	readonly stage?: string | null;
}

export interface RetrievalLedgerConflictDimensions {
	readonly authority?: string;
	readonly specificity?: string;
	readonly freshness?: string;
	readonly volatility?: string;
}

export interface RetrievalLedgerConflictInput {
	readonly claimKey: string;
	readonly conflict?: boolean;
	readonly requiresUserConfirmation?: boolean;
	readonly dimensions?: RetrievalLedgerConflictDimensions;
	readonly resolution?: unknown;
	readonly rejected?: unknown;
}

export interface RetrievalLedgerVerificationHint {
	readonly provider: string;
	readonly resource: string;
	readonly id: string | number;
}

export interface RetrievalLedgerVolatileClaimInput {
	readonly claim?: string;
	readonly claimDigest?: string | null;
	readonly digest?: string | null;
	readonly verificationRequired?: boolean;
	readonly verificationHint?: RetrievalLedgerVerificationHint | null;
}

export interface RetrievalLedgerBudgetInput {
	readonly limits?: Partial<SearchBudgetLimits>;
	readonly usage?: Partial<SearchBudgetUsage>;
	readonly maps?: number;
	readonly files?: number;
	readonly sections?: number;
	readonly chars?: number;
	readonly droppedCandidates?: readonly string[];
	readonly drops?: readonly RetrievalLedgerBudgetDropInput[];
	readonly truncated?: boolean;
}

export interface RetrievalLedgerBudgetDropInput {
	readonly candidateId?: string;
	readonly dimension?: string | null;
	readonly amount?: number;
	readonly reason?: string;
}

export interface RetrievalLedgerInput {
	readonly query: string;
	readonly intent?: string | null;
	readonly scopes?: readonly ScopeInput[];
	readonly mapsRead?: readonly MapInput[];
	readonly selectedSources?: readonly RetrievalLedgerSourceInput[];
	readonly rejections?: readonly RetrievalLedgerRejectionInput[];
	readonly conflicts?: readonly RetrievalLedgerConflictInput[];
	readonly volatileClaims?: readonly RetrievalLedgerVolatileClaimInput[];
	readonly budget?: RetrievalLedgerBudgetInput | SearchBudgetState | null;
	readonly truncated?: boolean;
}

export interface RetrievalLedgerScope {
	readonly scope: string;
	readonly digest: string | null;
	readonly startLine: number | null;
	readonly endLine: number | null;
}

export interface RetrievalLedgerMap {
	readonly uri: string;
	readonly digest: string | null;
	readonly startLine: number | null;
	readonly endLine: number | null;
}

export interface RetrievalLedgerSource {
	readonly uri: string;
	readonly digest: string | null;
	readonly startLine: number | null;
	readonly endLine: number | null;
	readonly stage: string | null;
	readonly authority: string | null;
	readonly volatility: string | null;
}

export interface RetrievalLedgerRejection {
	readonly uri: string | null;
	readonly digest: string | null;
	readonly stage: string | null;
	readonly reason: string;
}

export interface RetrievalLedgerConflict {
	readonly claimKey: string;
	readonly conflict: boolean;
	readonly requiresUserConfirmation: boolean;
	readonly dimensions: {
		readonly authority: string | null;
		readonly specificity: string | null;
		readonly freshness: string | null;
		readonly volatility: string | null;
	};
}

export interface RetrievalLedgerVolatileClaim {
	readonly claimDigest: string | null;
	readonly verificationRequired: boolean;
	readonly verificationHint: RetrievalLedgerVerificationHint | null;
}

export interface RetrievalLedgerBudgetDrop {
	readonly candidateDigest: string | null;
	readonly dimension: RetrievalLedgerBudgetDimension | null;
	readonly amount: number;
	readonly reason: string | null;
}

export interface RetrievalLedgerBudget {
	readonly limits: SearchBudgetLimits;
	readonly usage: SearchBudgetUsage;
	readonly droppedCandidates: readonly string[];
	readonly drops: readonly RetrievalLedgerBudgetDrop[];
}

export interface RetrievalLedgerEntry {
	readonly schemaVersion: typeof RETRIEVAL_LEDGER_SCHEMA_VERSION;
	readonly ledgerId: string;
	readonly queryId: string;
	readonly queryDigest: string;
	readonly asOf: string;
	readonly intent: string | null;
	readonly scopes: readonly RetrievalLedgerScope[];
	readonly mapsRead: readonly RetrievalLedgerMap[];
	readonly selectedSources: readonly RetrievalLedgerSource[];
	readonly rejections: readonly RetrievalLedgerRejection[];
	readonly conflicts: readonly RetrievalLedgerConflict[];
	readonly volatileClaims: readonly RetrievalLedgerVolatileClaim[];
	readonly budget: RetrievalLedgerBudget;
	readonly truncated: boolean;
}

export interface RetrievalLedgerResult {
	readonly ledgerId: string | null;
	readonly written: boolean;
	readonly relPath: string | null;
}

interface LineRange {
	readonly startLine: number;
	readonly endLine: number;
}

interface NormalizedQuery {
	readonly queryDigest: string;
	readonly queryId: string;
	readonly ledgerId: string;
}
type RetrievalLedgerBudgetDimension = "maps" | "files" | "sections" | "chars";

function isRecord(value: unknown): value is LedgerRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function field(value: LedgerRecord, name: string): unknown {
	return Object.hasOwn(value, name) ? value[name] : undefined;
}

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left.normalize("NFC"), "utf8"), Buffer.from(right.normalize("NFC"), "utf8"));
}

function digestString(value: string): string {
	return createHash("sha256")
		.update(Buffer.from(value.normalize("NFC"), "utf8"))
		.digest("hex");
}

function policyDenied(reason: string): MemoryResult<never> {
	return {
		ok: false,
		error: {
			code: "policy-denied",
			exitCode: MEMORY_EXIT_CODES.policyDenied,
			destination: "ledger",
			reason,
		},
	};
}

function sensitivityViolation(findings: readonly SensitivityFinding[]): MemoryResult<never> {
	return {
		ok: false,
		error: {
			code: "sensitivity-violation",
			exitCode: MEMORY_EXIT_CODES.sensitivityViolation,
			destination: "ledger",
			findings,
		},
	};
}

function normalizeText(value: unknown, label: string, allowEmpty = false): MemoryResult<string> {
	if (typeof value !== "string") return invalidInput(`ledger: ${label} must be a string`);
	const normalized = value.normalize("NFC").replace(/\r\n?/g, "\n");
	if (!allowEmpty && normalized.trim().length === 0) return invalidInput(`ledger: ${label} must not be empty`);
	for (const character of normalized) {
		const codePoint = character.codePointAt(0);
		if (codePoint !== undefined && codePoint < 0x20 && character !== "\n" && character !== "\t") {
			return invalidInput(`ledger: ${label} contains a control character`);
		}
	}
	return { ok: true, value: normalized };
}

function redactAbsolutePaths(value: string): string {
	return value.replace(/(?:[A-Za-z]:[\\/]|\/{1,2})[^\s"'`),;]+/g, "[PATH]");
}

function normalizeIdentifier(value: unknown, label: string, allowEmpty = false): MemoryResult<string> {
	const normalized = normalizeText(value, label, allowEmpty);
	if (!normalized.ok) return normalized;
	if (normalized.value.includes("\n") || normalized.value.includes("\t")) {
		return invalidInput(`ledger: ${label} contains a line break`);
	}
	if (
		normalized.value.startsWith("/") ||
		normalized.value.startsWith("\\") ||
		/^[A-Za-z]:[\\/]/.test(normalized.value) ||
		normalized.value.includes("/") ||
		normalized.value.includes("\\")
	) {
		return invalidInput(`ledger: ${label} must not be a path`);
	}
	if (!SAFE_ID.test(normalized.value)) return invalidInput(`ledger: ${label} is unsafe`);
	return normalized;
}

function normalizeDigest(value: unknown, label: string, allowNull = true): MemoryResult<string | null> {
	if (value === null || value === undefined) {
		return allowNull ? { ok: true, value: null } : invalidInput(`ledger: ${label} is required`);
	}
	const normalized = normalizeText(value, label);
	if (!normalized.ok) return normalized;
	if (!SAFE_DIGEST.test(normalized.value)) return invalidInput(`ledger: ${label} is malformed`);
	return { ok: true, value: normalized.value };
}

function normalizeUri(value: unknown, label: string): MemoryResult<string> {
	const normalized = normalizeText(value, label);
	if (!normalized.ok) return normalized;
	const parsed = parseMemoryUri(normalized.value);
	if (!parsed.ok) return invalidInput(`ledger: ${label} is not a canonical memory URI`);
	return { ok: true, value: parsed.value.href };
}

function lineValue(record: LedgerRecord, primary: string, alias: string): unknown {
	const direct = field(record, primary);
	return direct === undefined ? field(record, alias) : direct;
}

function normalizeLine(value: unknown, label: string): MemoryResult<number> {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || !Number.isSafeInteger(value)) {
		return invalidInput(`ledger: ${label} must be a positive integer`);
	}
	return { ok: true, value };
}

function normalizeRange(record: LedgerRecord, label: string): MemoryResult<LineRange | null> {
	const startValue = lineValue(record, "startLine", "lineStart");
	const endValue = lineValue(record, "endLine", "lineEnd");
	if (startValue === undefined && endValue === undefined) return { ok: true, value: null };
	if (startValue === undefined || endValue === undefined)
		return invalidInput(`ledger: ${label} line range is incomplete`);
	const start = normalizeLine(startValue, `${label} startLine`);
	if (!start.ok) return start;
	const end = normalizeLine(endValue, `${label} endLine`);
	if (!end.ok) return end;
	if (start.value > end.value) return invalidInput(`ledger: ${label} line range is reversed`);
	return { ok: true, value: { startLine: start.value, endLine: end.value } };
}

function lineStart(range: LineRange | null): number | null {
	return range?.startLine ?? null;
}

function lineEnd(range: LineRange | null): number | null {
	return range?.endLine ?? null;
}

function secretCheck(value: string): MemoryResult<true> {
	const scanned = scanSecretContent(value);
	if (!scanned.ok) return policyDenied("retrieval ledger secret scan failed closed");
	return scanned.value.findings.length === 0
		? { ok: true, value: true }
		: sensitivityViolation(scanned.value.findings);
}

function normalizedAsOf(environment: MemoryEnvironment): MemoryResult<string> {
	const candidate = environment.asOf ?? environment.now.toISOString();
	if (!STRICT_UTC.test(candidate) || !Number.isFinite(Date.parse(candidate))) {
		return invalidInput("ledger: asOf must be strict UTC ISO-8601");
	}
	return { ok: true, value: candidate };
}

function normalizedQuery(query: string, asOf: string): MemoryResult<NormalizedQuery> {
	const normalized = normalizeText(query, "query");
	if (!normalized.ok) return normalized;
	const checked = secretCheck(normalized.value);
	if (!checked.ok) return checked;
	const queryDigest = digestString(normalized.value);
	const canonicalQuery = normalized.value;
	const identityDigest = digestString(`${canonicalQuery}${asOf}`);
	return {
		ok: true,
		value: Object.freeze({
			queryDigest,
			queryId: `memq_${identityDigest}`,
			ledgerId: `memledger_${identityDigest}`,
		}),
	};
}

function scopeValue(value: unknown): MemoryResult<{
	readonly scope: string;
	readonly digest: string | null;
	readonly range: LineRange | null;
}> {
	if (typeof value === "string") {
		const scope = normalizeIdentifier(value, "scope");
		if (!scope.ok) return scope;
		return {
			ok: true,
			value: { scope: scope.value, digest: null, range: null },
		};
	}
	if (!isRecord(value)) return invalidInput("ledger: scope entry is malformed");
	const rawScope = field(value, "scope") ?? field(value, "kind") ?? field(value, "name");
	const scope = normalizeIdentifier(rawScope, "scope");
	if (!scope.ok) return scope;
	const digest = normalizeDigest(field(value, "digest") ?? field(value, "scopeDigest"), "scope digest");
	if (!digest.ok) return digest;
	const range = normalizeRange(value, "scope");
	if (!range.ok) return range;
	const checked = secretCheck(scope.value);
	if (!checked.ok) return checked;
	return {
		ok: true,
		value: { scope: scope.value, digest: digest.value, range: range.value },
	};
}

function normalizeScopes(values: unknown): MemoryResult<{
	readonly names: readonly string[];
	readonly details: readonly RetrievalLedgerScope[];
}> {
	if (values === undefined) return { ok: true, value: { names: [], details: [] } };
	if (!Array.isArray(values)) return invalidInput("ledger: scopes must be an array");
	const parsed: Array<{
		readonly scope: string;
		readonly digest: string | null;
		readonly range: LineRange | null;
	}> = [];
	for (const value of values) {
		const normalized = scopeValue(value);
		if (!normalized.ok) return normalized;
		parsed.push(normalized.value);
	}
	parsed.sort((left, right) => {
		const byScope = compareUtf8(left.scope, right.scope);
		if (byScope !== 0) return byScope;
		const byDigest = compareUtf8(left.digest ?? "", right.digest ?? "");
		if (byDigest !== 0) return byDigest;
		return compareUtf8(JSON.stringify(left.range), JSON.stringify(right.range));
	});
	const names: string[] = [];
	const details: RetrievalLedgerScope[] = [];
	const seenNames = new Set<string>();
	const seenDetails = new Set<string>();
	for (const value of parsed) {
		if (!seenNames.has(value.scope)) {
			seenNames.add(value.scope);
			names.push(value.scope);
		}
		const key = `${value.scope}\u0000${value.digest ?? ""}\u0000${lineStart(value.range) ?? ""}\u0000${lineEnd(value.range) ?? ""}`;
		if (!seenDetails.has(key)) {
			seenDetails.add(key);
			details.push(
				Object.freeze({
					scope: value.scope,
					digest: value.digest,
					startLine: lineStart(value.range),
					endLine: lineEnd(value.range),
				}),
			);
		}
	}
	return {
		ok: true,
		value: { names: Object.freeze(names), details: Object.freeze(details) },
	};
}

function mapValue(value: unknown): MemoryResult<RetrievalLedgerMap> {
	if (typeof value === "string") {
		const uri = normalizeUri(value, "map URI");
		if (!uri.ok) return uri;
		return {
			ok: true,
			value: Object.freeze({
				uri: uri.value,
				digest: null,
				startLine: null,
				endLine: null,
			}),
		};
	}
	if (!isRecord(value)) return invalidInput("ledger: MAP entry is malformed");
	const rawUri = field(value, "uri") ?? field(value, "href");
	const uri = normalizeUri(rawUri, "map URI");
	if (!uri.ok) return uri;
	const digest = normalizeDigest(
		field(value, "digest") ?? field(value, "mapDigest") ?? field(value, "sourceDigest"),
		"MAP digest",
	);
	if (!digest.ok) return digest;
	const range = normalizeRange(value, "MAP");
	if (!range.ok) return range;
	return {
		ok: true,
		value: Object.freeze({
			uri: uri.value,
			digest: digest.value,
			startLine: lineStart(range.value),
			endLine: lineEnd(range.value),
		}),
	};
}

function normalizeMaps(values: unknown): MemoryResult<{
	readonly names: readonly string[];
	readonly details: readonly RetrievalLedgerMap[];
}> {
	if (values === undefined) return { ok: true, value: { names: [], details: [] } };
	if (!Array.isArray(values)) return invalidInput("ledger: mapsRead must be an array");
	const parsed: RetrievalLedgerMap[] = [];
	for (const value of values) {
		const normalized = mapValue(value);
		if (!normalized.ok) return normalized;
		parsed.push(normalized.value);
	}
	parsed.sort((left, right) => {
		const byUri = compareUtf8(left.uri, right.uri);
		if (byUri !== 0) return byUri;
		const byDigest = compareUtf8(left.digest ?? "", right.digest ?? "");
		if (byDigest !== 0) return byDigest;
		return compareUtf8(JSON.stringify(left), JSON.stringify(right));
	});
	const names: string[] = [];
	const details: RetrievalLedgerMap[] = [];
	const seen = new Set<string>();
	for (const value of parsed) {
		if (!names.includes(value.uri)) names.push(value.uri);
		const key = `${value.uri}\u0000${value.digest ?? ""}\u0000${value.startLine ?? ""}\u0000${value.endLine ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		details.push(value);
	}
	return {
		ok: true,
		value: { names: Object.freeze(names), details: Object.freeze(details) },
	};
}

function sourceValue(value: unknown): MemoryResult<RetrievalLedgerSource> {
	if (!isRecord(value)) return invalidInput("ledger: selected source is malformed");
	const uri = normalizeUri(field(value, "uri") ?? field(value, "href"), "source URI");
	if (!uri.ok) return uri;
	const digest = normalizeDigest(
		field(value, "digest") ?? field(value, "sourceDigest") ?? field(value, "sha256"),
		"source digest",
	);
	if (!digest.ok) return digest;
	const range = normalizeRange(value, "source");
	if (!range.ok) return range;
	const stageValue = field(value, "stage");
	const stage =
		stageValue === null || stageValue === undefined
			? { ok: true as const, value: null }
			: normalizeIdentifier(stageValue, "source stage");
	if (!stage.ok) return stage;
	const authorityValue = field(value, "authority");
	const authority =
		authorityValue === null || authorityValue === undefined
			? { ok: true as const, value: null }
			: normalizeIdentifier(authorityValue, "source authority");
	if (!authority.ok) return authority;
	const volatilityValue = field(value, "volatility");
	const volatility =
		volatilityValue === null || volatilityValue === undefined
			? { ok: true as const, value: null }
			: normalizeIdentifier(volatilityValue, "source volatility");
	if (!volatility.ok) return volatility;
	const headingValue = field(value, "heading");
	if (headingValue !== undefined && headingValue !== null) {
		// A section-less document legitimately cites an empty heading, so the ledger
		// records it as-is rather than failing the whole retrieval.
		const heading = normalizeText(headingValue, "source heading", true);
		if (!heading.ok) return heading;
		const checked = secretCheck(heading.value);
		if (!checked.ok) return checked;
	}
	return {
		ok: true,
		value: Object.freeze({
			uri: uri.value,
			digest: digest.value,
			startLine: lineStart(range.value),
			endLine: lineEnd(range.value),
			stage: stage.value,
			authority: authority.value,
			volatility: volatility.value,
		}),
	};
}

function normalizeSources(values: unknown): MemoryResult<readonly RetrievalLedgerSource[]> {
	if (values === undefined) return { ok: true, value: Object.freeze([]) };
	if (!Array.isArray(values)) return invalidInput("ledger: selectedSources must be an array");
	const parsed: RetrievalLedgerSource[] = [];
	for (const value of values) {
		const normalized = sourceValue(value);
		if (!normalized.ok) return normalized;
		parsed.push(normalized.value);
	}
	parsed.sort((left, right) => {
		const byUri = compareUtf8(left.uri, right.uri);
		if (byUri !== 0) return byUri;
		const byStage = compareUtf8(left.stage ?? "", right.stage ?? "");
		if (byStage !== 0) return byStage;
		const byDigest = compareUtf8(left.digest ?? "", right.digest ?? "");
		if (byDigest !== 0) return byDigest;
		return compareUtf8(JSON.stringify(left), JSON.stringify(right));
	});
	const seen = new Set<string>();
	const output: RetrievalLedgerSource[] = [];
	for (const source of parsed) {
		const key = JSON.stringify(source);
		if (seen.has(key)) continue;
		seen.add(key);
		output.push(source);
	}
	return { ok: true, value: Object.freeze(output) };
}

function rejectionValue(value: unknown): MemoryResult<RetrievalLedgerRejection> {
	if (!isRecord(value)) return invalidInput("ledger: rejection is malformed");
	const uriValue = field(value, "uri") ?? field(value, "href");
	let uri: string | null = null;
	if (uriValue !== undefined && uriValue !== null) {
		const normalizedUri = normalizeUri(uriValue, "rejection URI");
		if (!normalizedUri.ok) return normalizedUri;
		uri = normalizedUri.value;
	}
	const candidateId = field(value, "candidateId");
	if (uri === null && candidateId !== undefined && candidateId !== null) {
		const normalizedCandidate = normalizeText(candidateId, "rejection candidateId");
		if (!normalizedCandidate.ok) return normalizedCandidate;
	}
	const digest = normalizeDigest(field(value, "digest") ?? field(value, "sourceDigest"), "rejection digest");
	if (!digest.ok) return digest;
	const reason = normalizeText(field(value, "reason"), "rejection reason");
	if (!reason.ok) return reason;
	const safeReason = redactAbsolutePaths(reason.value);
	const checked = secretCheck(safeReason);
	if (!checked.ok) return checked;
	const stageValue = field(value, "stage");
	const stage =
		stageValue === null || stageValue === undefined
			? { ok: true as const, value: null }
			: normalizeIdentifier(stageValue, "rejection stage");
	if (!stage.ok) return stage;
	return {
		ok: true,
		value: Object.freeze({
			uri,
			digest: digest.value,
			stage: stage.value,
			reason: safeReason,
		}),
	};
}

function normalizeRejections(values: unknown): MemoryResult<readonly RetrievalLedgerRejection[]> {
	if (values === undefined) return { ok: true, value: Object.freeze([]) };
	if (!Array.isArray(values)) return invalidInput("ledger: rejections must be an array");
	const parsed: RetrievalLedgerRejection[] = [];
	for (const value of values) {
		const normalized = rejectionValue(value);
		if (!normalized.ok) return normalized;
		parsed.push(normalized.value);
	}
	parsed.sort((left, right) => {
		const byUri = compareUtf8(left.uri ?? "", right.uri ?? "");
		if (byUri !== 0) return byUri;
		const byReason = compareUtf8(left.reason, right.reason);
		if (byReason !== 0) return byReason;
		const byStage = compareUtf8(left.stage ?? "", right.stage ?? "");
		if (byStage !== 0) return byStage;
		return compareUtf8(left.digest ?? "", right.digest ?? "");
	});
	const seen = new Set<string>();
	const output: RetrievalLedgerRejection[] = [];
	for (const rejection of parsed) {
		const key = JSON.stringify(rejection);
		if (seen.has(key)) continue;
		seen.add(key);
		output.push(rejection);
	}
	return { ok: true, value: Object.freeze(output) };
}

function conflictValue(value: unknown): MemoryResult<RetrievalLedgerConflict> {
	if (!isRecord(value)) return invalidInput("ledger: conflict is malformed");
	const claimKey = normalizeIdentifier(field(value, "claimKey"), "conflict claimKey");
	if (!claimKey.ok) return claimKey;
	const conflictValueRaw = field(value, "conflict");
	if (conflictValueRaw !== undefined && typeof conflictValueRaw !== "boolean") {
		return invalidInput("ledger: conflict flag must be boolean");
	}
	const confirmationRaw = field(value, "requiresUserConfirmation");
	if (confirmationRaw !== undefined && typeof confirmationRaw !== "boolean") {
		return invalidInput("ledger: conflict confirmation flag must be boolean");
	}
	const dimensionsRaw = field(value, "dimensions");
	if (dimensionsRaw !== undefined && !isRecord(dimensionsRaw))
		return invalidInput("ledger: conflict dimensions are malformed");
	const dimensions: LedgerRecord = dimensionsRaw ?? {};
	const dimensionNames = ["authority", "specificity", "freshness", "volatility"] as const;
	const normalizedDimensions: Record<(typeof dimensionNames)[number], string | null> = {
		authority: null,
		specificity: null,
		freshness: null,
		volatility: null,
	};
	for (const name of dimensionNames) {
		const raw = field(dimensions, name);
		if (raw === undefined || raw === null) continue;
		const normalized = normalizeIdentifier(raw, `conflict ${name}`);
		if (!normalized.ok) return normalized;
		normalizedDimensions[name] = normalized.value;
	}
	return {
		ok: true,
		value: Object.freeze({
			claimKey: claimKey.value,
			conflict: conflictValueRaw ?? true,
			requiresUserConfirmation: confirmationRaw ?? false,
			dimensions: Object.freeze(normalizedDimensions),
		}),
	};
}

function normalizeConflicts(values: unknown): MemoryResult<readonly RetrievalLedgerConflict[]> {
	if (values === undefined) return { ok: true, value: Object.freeze([]) };
	if (!Array.isArray(values)) return invalidInput("ledger: conflicts must be an array");
	const parsed: RetrievalLedgerConflict[] = [];
	for (const value of values) {
		const normalized = conflictValue(value);
		if (!normalized.ok) return normalized;
		parsed.push(normalized.value);
	}
	parsed.sort((left, right) => {
		const byClaim = compareUtf8(left.claimKey, right.claimKey);
		if (byClaim !== 0) return byClaim;
		return compareUtf8(JSON.stringify(left), JSON.stringify(right));
	});
	const seen = new Set<string>();
	const output: RetrievalLedgerConflict[] = [];
	for (const conflict of parsed) {
		const key = JSON.stringify(conflict);
		if (seen.has(key)) continue;
		seen.add(key);
		output.push(conflict);
	}
	return { ok: true, value: Object.freeze(output) };
}

function verificationHint(value: unknown): MemoryResult<RetrievalLedgerVerificationHint | null> {
	if (value === undefined || value === null) return { ok: true, value: null };
	if (!isRecord(value)) return invalidInput("ledger: verificationHint is malformed");
	const provider = normalizeIdentifier(field(value, "provider"), "verification provider");
	if (!provider.ok) return provider;
	const resource = normalizeIdentifier(field(value, "resource"), "verification resource");
	if (!resource.ok) return resource;
	const id = field(value, "id");
	if (typeof id === "number") {
		if (!Number.isSafeInteger(id) || id < 0) return invalidInput("ledger: verification id is invalid");
		return {
			ok: true,
			value: Object.freeze({
				provider: provider.value,
				resource: resource.value,
				id,
			}),
		};
	}
	const normalizedId = normalizeIdentifier(id, "verification id");
	if (!normalizedId.ok) return normalizedId;
	return {
		ok: true,
		value: Object.freeze({
			provider: provider.value,
			resource: resource.value,
			id: normalizedId.value,
		}),
	};
}

function volatileValue(value: unknown): MemoryResult<RetrievalLedgerVolatileClaim> {
	if (!isRecord(value)) return invalidInput("ledger: volatile claim is malformed");
	const claim = field(value, "claim");
	let claimDigest = normalizeDigest(field(value, "claimDigest") ?? field(value, "digest"), "volatile claim digest");
	if (!claimDigest.ok) return claimDigest;
	if (claim !== undefined && claim !== null) {
		const normalizedClaim = normalizeText(claim, "volatile claim");
		if (!normalizedClaim.ok) return normalizedClaim;
		const checked = secretCheck(normalizedClaim.value);
		if (!checked.ok) return checked;
		if (claimDigest.value === null) claimDigest = { ok: true, value: digestString(normalizedClaim.value) };
	}
	const required = field(value, "verificationRequired");
	if (required !== undefined && typeof required !== "boolean")
		return invalidInput("ledger: verificationRequired must be boolean");
	const hint = verificationHint(field(value, "verificationHint"));
	if (!hint.ok) return hint;
	return {
		ok: true,
		value: Object.freeze({
			claimDigest: claimDigest.value,
			verificationRequired: required ?? false,
			verificationHint: hint.value,
		}),
	};
}

function normalizeVolatileClaims(values: unknown): MemoryResult<readonly RetrievalLedgerVolatileClaim[]> {
	if (values === undefined) return { ok: true, value: Object.freeze([]) };
	if (!Array.isArray(values)) return invalidInput("ledger: volatileClaims must be an array");
	const parsed: RetrievalLedgerVolatileClaim[] = [];
	for (const value of values) {
		const normalized = volatileValue(value);
		if (!normalized.ok) return normalized;
		parsed.push(normalized.value);
	}
	parsed.sort((left, right) => {
		const byDigest = compareUtf8(left.claimDigest ?? "", right.claimDigest ?? "");
		if (byDigest !== 0) return byDigest;
		return compareUtf8(JSON.stringify(left), JSON.stringify(right));
	});
	const seen = new Set<string>();
	const output: RetrievalLedgerVolatileClaim[] = [];
	for (const claim of parsed) {
		const key = JSON.stringify(claim);
		if (seen.has(key)) continue;
		seen.add(key);
		output.push(claim);
	}
	return { ok: true, value: Object.freeze(output) };
}

function finiteCount(value: unknown, label: string, fallback: number): MemoryResult<number> {
	if (value === undefined) return { ok: true, value: fallback };
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		return invalidInput(`ledger: ${label} must be a non-negative integer`);
	return { ok: true, value };
}
function normalizeBudgetDimension(value: unknown): MemoryResult<RetrievalLedgerBudgetDimension | null> {
	if (value === undefined || value === null) return { ok: true, value: null };
	switch (value) {
		case "maps":
			return { ok: true, value: "maps" };
		case "files":
			return { ok: true, value: "files" };
		case "sections":
			return { ok: true, value: "sections" };
		case "chars":
			return { ok: true, value: "chars" };
		default:
			return invalidInput("ledger: budget dimension must be maps, files, sections, chars, or null");
	}
}

function budgetValue(value: unknown): MemoryResult<RetrievalLedgerBudget> {
	if (value === null || value === undefined) {
		return {
			ok: true,
			value: Object.freeze({
				limits: DEFAULT_BUDGET_LIMITS,
				usage: DEFAULT_BUDGET_USAGE,
				droppedCandidates: Object.freeze([]),
				drops: Object.freeze([]),
			}),
		};
	}
	if (!isRecord(value)) return invalidInput("ledger: budget is malformed");
	const limitsRaw = field(value, "limits");
	if (limitsRaw !== undefined && !isRecord(limitsRaw)) return invalidInput("ledger: budget limits are malformed");
	const usageRaw = field(value, "usage");
	if (usageRaw !== undefined && !isRecord(usageRaw)) return invalidInput("ledger: budget usage is malformed");
	const limits: LedgerRecord = limitsRaw ?? {};
	const usage: LedgerRecord = usageRaw ?? value;
	const limitNames = ["maxMaps", "maxFiles", "maxSections", "maxChars"] as const;
	const normalizedLimits = {
		maxMaps: DEFAULT_BUDGET_LIMITS.maxMaps,
		maxFiles: DEFAULT_BUDGET_LIMITS.maxFiles,
		maxSections: DEFAULT_BUDGET_LIMITS.maxSections,
		maxChars: DEFAULT_BUDGET_LIMITS.maxChars,
	};
	for (const name of limitNames) {
		const parsed = finiteCount(field(limits, name), `budget ${name}`, normalizedLimits[name]);
		if (!parsed.ok) return parsed;
		normalizedLimits[name] = parsed.value;
	}
	const usageNames = ["maps", "files", "sections", "chars"] as const;
	const normalizedUsage = { maps: 0, files: 0, sections: 0, chars: 0 };
	for (const name of usageNames) {
		const parsed = finiteCount(field(usage, name), `budget ${name}`, 0);
		if (!parsed.ok) return parsed;
		normalizedUsage[name] = parsed.value;
	}
	const droppedRaw = field(value, "droppedCandidates");
	if (droppedRaw !== undefined && !Array.isArray(droppedRaw))
		return invalidInput("ledger: droppedCandidates is malformed");
	const dropped: string[] = [];
	for (const candidate of (droppedRaw ?? []) as readonly unknown[]) {
		const normalizedCandidate = normalizeText(candidate, "budget candidate");
		if (!normalizedCandidate.ok) return normalizedCandidate;
		dropped.push(digestString(normalizedCandidate.value));
	}
	dropped.sort(compareUtf8);
	const dropsRaw = field(value, "drops");
	if (dropsRaw !== undefined && !Array.isArray(dropsRaw)) return invalidInput("ledger: budget drops are malformed");
	const drops: RetrievalLedgerBudgetDrop[] = [];
	for (const rawDrop of (dropsRaw ?? []) as readonly unknown[]) {
		if (!isRecord(rawDrop)) return invalidInput("ledger: budget drop is malformed");
		const candidateId = field(rawDrop, "candidateId");
		let candidateDigest: string | null = null;
		if (candidateId !== undefined && candidateId !== null) {
			const normalizedCandidate = normalizeText(candidateId, "budget candidate");
			if (!normalizedCandidate.ok) return normalizedCandidate;
			candidateDigest = digestString(normalizedCandidate.value);
		}
		const normalizedDimension = normalizeBudgetDimension(field(rawDrop, "dimension"));
		if (!normalizedDimension.ok) return normalizedDimension;
		const dimension = normalizedDimension.value;
		const amount = finiteCount(field(rawDrop, "amount"), "budget drop amount", 0);
		if (!amount.ok) return amount;
		const reasonRaw = field(rawDrop, "reason");
		let reason: string | null = null;
		if (reasonRaw !== undefined && reasonRaw !== null) {
			const normalizedReason = normalizeIdentifier(reasonRaw, "budget drop reason");
			if (!normalizedReason.ok) return normalizedReason;
			reason = normalizedReason.value;
		}
		drops.push(
			Object.freeze({
				candidateDigest,
				dimension,
				amount: amount.value,
				reason,
			}),
		);
	}
	drops.sort((left, right) => {
		const byCandidate = compareUtf8(left.candidateDigest ?? "", right.candidateDigest ?? "");
		if (byCandidate !== 0) return byCandidate;
		const byDimension = compareUtf8(left.dimension ?? "", right.dimension ?? "");
		if (byDimension !== 0) return byDimension;
		const byAmount = left.amount - right.amount;
		if (byAmount !== 0) return byAmount;
		return compareUtf8(left.reason ?? "", right.reason ?? "");
	});
	return {
		ok: true,
		value: Object.freeze({
			limits: Object.freeze(normalizedLimits),
			usage: Object.freeze(normalizedUsage),
			droppedCandidates: Object.freeze(dropped),
			drops: Object.freeze(drops),
		}),
	};
}

function inputRecord(input: unknown): LedgerRecord | null {
	return isRecord(input) ? input : null;
}

function createEntry(environment: MemoryEnvironment, input: unknown): MemoryResult<RetrievalLedgerEntry> {
	const rawInput = inputRecord(input);
	if (rawInput === null) return invalidInput("ledger: input must be an object");
	const queryValue = field(rawInput, "query");
	if (typeof queryValue !== "string") return invalidInput("ledger: query must be a string");
	const asOf = normalizedAsOf(environment);
	if (!asOf.ok) return asOf;
	const query = normalizedQuery(queryValue, asOf.value);
	if (!query.ok) return query;
	const intentValue = field(rawInput, "intent");
	let intent: string | null = null;
	if (intentValue !== undefined && intentValue !== null) {
		const normalizedIntent = normalizeIdentifier(intentValue, "intent");
		if (!normalizedIntent.ok) return normalizedIntent;
		intent = normalizedIntent.value;
	}
	const scopes = normalizeScopes(field(rawInput, "scopes"));
	if (!scopes.ok) return scopes;
	const maps = normalizeMaps(field(rawInput, "mapsRead"));
	if (!maps.ok) return maps;
	const sources = normalizeSources(field(rawInput, "selectedSources"));
	if (!sources.ok) return sources;
	const rejections = normalizeRejections(field(rawInput, "rejections"));
	if (!rejections.ok) return rejections;
	const conflicts = normalizeConflicts(field(rawInput, "conflicts"));
	if (!conflicts.ok) return conflicts;
	const volatileClaims = normalizeVolatileClaims(field(rawInput, "volatileClaims"));
	if (!volatileClaims.ok) return volatileClaims;
	const budget = budgetValue(field(rawInput, "budget"));
	if (!budget.ok) return budget;
	const truncatedValue = field(rawInput, "truncated");
	if (truncatedValue !== undefined && typeof truncatedValue !== "boolean")
		return invalidInput("ledger: truncated must be boolean");
	const budgetTruncated =
		isRecord(field(rawInput, "budget")) && field(field(rawInput, "budget") as LedgerRecord, "truncated") === true;
	const entry: RetrievalLedgerEntry = Object.freeze({
		schemaVersion: RETRIEVAL_LEDGER_SCHEMA_VERSION,
		queryId: query.value.queryId,
		ledgerId: query.value.ledgerId,
		queryDigest: query.value.queryDigest,
		intent,
		scopes: scopes.value.details,
		mapsRead: maps.value.details,
		selectedSources: sources.value,
		rejections: rejections.value,
		conflicts: conflicts.value,
		volatileClaims: volatileClaims.value,
		budget: budget.value,
		truncated: truncatedValue === true || budgetTruncated,
		asOf: asOf.value,
	});
	const serialized = JSON.stringify(entry);
	const checked = secretCheck(serialized);
	if (!checked.ok) return checked;
	return { ok: true, value: entry };
}

export function createRetrievalLedgerEntry(
	environment: MemoryEnvironment,
	input: RetrievalLedgerInput,
): MemoryResult<RetrievalLedgerEntry> {
	const validated = validateMemoryEnvironment(environment);
	if (!validated.ok) return validated;
	try {
		return createEntry(validated.value, input);
	} catch {
		return policyDenied("retrieval ledger canonicalization failed closed");
	}
}

function appendError(reason?: string): MemoryResult<never> {
	return policyDenied(reason ?? "retrieval ledger append denied");
}

/** Append one metadata-only ledger record, or return the documented no-ledger result without a session. */
export async function appendRetrievalLedger(
	environment: MemoryEnvironment,
	input: RetrievalLedgerInput,
): Promise<MemoryResult<RetrievalLedgerResult>> {
	const validated = validateMemoryEnvironment(environment);
	if (!validated.ok) return validated;
	const entry = createRetrievalLedgerEntry(validated.value, input);
	if (!entry.ok) return entry;
	if (validated.value.sessionId === null) {
		return {
			ok: true,
			value: Object.freeze({ ledgerId: null, written: false, relPath: null }),
		};
	}
	const sessionId = validated.value.sessionId.normalize("NFC");
	const relPath = `sessions/${sessionId}/retrieval-ledger.jsonl`;
	const line = `${JSON.stringify(entry.value)}\n`;
	const grant = authorizeLedgerAccess({
		environment: validated.value,
		content: line,
	});
	if (!grant.ok) return grant;
	try {
		await appendJsonl({ grant: grant.value, relPath, record: entry.value });
	} catch (error) {
		const initialized = checkInitializedRoot(validated.value.memoryRoot);
		if (!initialized.ok) return initialized;
		if (error instanceof VerifiedStorageError) return appendError(error.reason);
		return appendError();
	}
	return {
		ok: true,
		value: Object.freeze({
			ledgerId: entry.value.ledgerId,
			written: true,
			relPath,
		}),
	};
}
