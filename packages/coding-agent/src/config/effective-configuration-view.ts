import { homedir } from "node:os";
import { truncateToWidth, visibleWidth } from "@gajae-code/tui";
import { sanitizeText } from "@gajae-code/utils";
import type {
	EffectiveConfigurationConflictCandidate,
	EffectiveConfigurationExplanation,
	EffectiveConfigurationExplanationOrderingEntry,
	EffectiveConfigurationOwnership,
	EffectiveConfigurationProvenanceEntry,
	EffectiveConfigurationReasonCode,
	EffectiveConfigurationResult,
} from "./effective-configuration";
import { EffectiveConfigurationResolver } from "./effective-configuration";
import type {
	ScopedConfigurationMutationReceipt,
	ScopedConfigurationMutationStatus,
	ScopedConfigurationReasonCode,
	ScopedConfigurationTiming,
} from "./scoped-configuration-mutation";

/** A safe input accepted by all effective-configuration consumers. */
export type EffectiveConfigurationViewInput =
	| EffectiveConfigurationResult
	| EffectiveConfigurationExplanation
	| {
			readonly result: EffectiveConfigurationResult;
			readonly explanation?: EffectiveConfigurationExplanation;
	  };

/** The mutation receipt name used by the consumer layer. */
export type ScopedConfigurationMutationResult = ScopedConfigurationMutationReceipt;

export type EffectiveConfigurationViewState = "resolved" | "absent" | "conflict" | "unavailable";
export type EffectiveConfigurationViewOwnership = EffectiveConfigurationOwnership | "unknown";
export type EffectiveConfigurationSourcePresence = "present" | "absent" | "unavailable";
export type EffectiveConfigurationSourceStability = "stable" | "unstable";

export interface EffectiveConfigurationRecoveryView {
	readonly code: string;
	readonly label: string;
	readonly steps: readonly string[];
}

export interface EffectiveConfigurationSourceView {
	readonly order: number;
	readonly sourceId: string;
	readonly canonicalKey: string;
	readonly rank: number;
	readonly ownership: EffectiveConfigurationViewOwnership;
	readonly safePath: string | null;
	readonly aliases: readonly string[];
	readonly revision: string | null;
	readonly digest: string | null;
	readonly presence: EffectiveConfigurationSourcePresence;
	readonly stability: EffectiveConfigurationSourceStability;
	readonly eligible: boolean;
	readonly ineligibilityReason: EffectiveConfigurationReasonCode | "unknown_reason" | null;
	readonly equalValue: boolean;
	readonly masked: boolean;
	readonly cleared: boolean;
	/** Discovered/third-party records are always read-only in consumer views. */
	readonly writable: boolean;
}

export interface EffectiveConfigurationEqualValueEvidence {
	readonly sourceIds: readonly string[];
	readonly rank: number | null;
}

export interface EffectiveConfigurationMaskedConflictView {
	readonly sourceIds: readonly string[];
	readonly rank: number | null;
}

export interface EffectiveConfigurationExplainView {
	readonly canonicalKey: string;
	readonly state: EffectiveConfigurationViewState;
	readonly reason: EffectiveConfigurationReasonCode | "unknown_reason" | null;
	readonly sources: readonly EffectiveConfigurationSourceView[];
	readonly evidence: readonly EffectiveConfigurationSourceView[];
	readonly equalValueEvidence: EffectiveConfigurationEqualValueEvidence;
	readonly maskedConflicts: readonly EffectiveConfigurationMaskedConflictView[];
	readonly clearedSourceIds: readonly string[];
	/** Present only for a resolved result. Conflicts deliberately have no winner. */
	readonly winner?: EffectiveConfigurationSourceView;
	readonly hasWinner: boolean;
	readonly clearToLower: boolean;
	readonly recovery: EffectiveConfigurationRecoveryView;
	readonly lines: readonly string[];
}

export interface EffectiveConfigurationPickerDetailsView extends EffectiveConfigurationExplainView {
	readonly selectedSourceId: string | null;
	readonly selectedSource: EffectiveConfigurationSourceView | null;
	readonly sourceOptions: readonly EffectiveConfigurationSourceView[];
	readonly writableSourceIds: readonly string[];
}

export type EffectiveConfigurationPickerDetailsOptions = {
	readonly selectedSourceId?: string | null;
};

export type ConfigurationScopeId = "session" | "project" | "user" | "managed";

export interface EffectiveConfigurationScopeSourceView {
	readonly sourceId: string;
	readonly scope: Exclude<ConfigurationScopeId, "session"> | "session";
	readonly ownership: EffectiveConfigurationViewOwnership;
	readonly safePath: string | null;
	readonly available: boolean;
	readonly writable: boolean;
	readonly reason: string | null;
}

export interface EffectiveConfigurationScopeOptionView {
	readonly id: ConfigurationScopeId;
	readonly label: "This session" | "This project" | "User default" | "Managed";
	readonly available: boolean;
	readonly writable: boolean;
	readonly locked: boolean;
	readonly selected: boolean;
	readonly targetPath: string | null;
	readonly reason: string | null;
}

export interface EffectiveConfigurationScopeSelectionInput {
	readonly repoRoot?: string | null;
	readonly targetPaths?: Partial<Record<"project" | "user", string | null>>;
	readonly selectedScope?: ConfigurationScopeId | null;
	readonly sources?: readonly EffectiveConfigurationProvenanceEntry[] | readonly EffectiveConfigurationSourceView[];
	readonly configuration?: EffectiveConfigurationViewInput;
}

export interface EffectiveConfigurationScopeSelectionView {
	readonly selectedScope: ConfigurationScopeId | null;
	readonly scopes: readonly EffectiveConfigurationScopeOptionView[];
	readonly sources: readonly EffectiveConfigurationScopeSourceView[];
	readonly lines: readonly string[];
}

export type EffectiveConfigurationDegradationKind = "none" | "reload_mismatch" | "runtime";

export interface ScopedConfigurationTransientStatusView {
	readonly status: ScopedConfigurationMutationStatus;
	readonly statusLabel: "Committed" | "Applied" | "Degraded" | "Conflict" | "Locked" | "Rejected";
	readonly headline: string;
	readonly reason: ScopedConfigurationReasonCode | "unknown_reason" | null;
	readonly reasonLabel: string;
	readonly recovery: EffectiveConfigurationRecoveryView;
	readonly timing: ScopedConfigurationTiming;
	readonly timingLabel: "Current runtime" | "Next session";
	readonly confirmation: "confirmed" | "unconfirmed" | "not_applicable";
	readonly durability: "none" | "committed" | "committed_unconfirmed";
	readonly degradation: EffectiveConfigurationDegradationKind;
	readonly targetPath: string | null;
	readonly patches: readonly ScopedConfigurationSafePatchView[];
	readonly optimisticSuccess: false | true;
	readonly lines: readonly string[];
}

export interface ScopedConfigurationSafePatchView {
	readonly op: "set" | "clear";
	readonly path: string;
}

export type EffectiveConfigurationRenderOptions = number | { readonly width?: number } | undefined;

const EFFECTIVE_REASON_CODES = new Set<string>([
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
]);

const MUTATION_REASON_CODES = new Set<string>([
	"project_scope_unavailable",
	"scope_locked",
	"invalid_scope",
	"scope_rejected",
	"target_escape",
	"target_symlink",
	"target_non_regular",
	"target_parent_non_directory",
	"unknown_owner_identity",
	"invalid_patch",
	"empty_patch",
	"invalid_key",
	"prototype_pollution_key",
	"unsupported_value",
	"duplicate_patch_paths",
	"conflicting_patch_paths",
	"invalid_yaml",
	"invalid_yaml_root",
	"scope_conflict",
	"persistent_write_failed",
	"runtime_precommit_failed",
	"runtime_postcommit_failed",
	"persistent_reload_mismatch",
	"persistent_reload_unconfirmed",
]);

const VALID_MUTATION_STATUSES = new Set<ScopedConfigurationMutationStatus>([
	"committed",
	"applied",
	"degraded",
	"conflict",
	"locked",
	"rejected",
]);

const SENSITIVE_TEXT_RE =
	/(?:access[_ -]?token|api[_ -]?key|auth(?:orization)?|bearer|credential|password|passwd|private[_ -]?key|secret|token)/iu;
const UNSAFE_PATH_CHARACTER_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const SENSITIVE_PATH_SEGMENT_RE =
	/^(?:access[_ -]?token|api[_ -]?key|auth(?:entication|orization)?|bearer|credential(?:s)?|key|password|passwd|private[_ -]?key|secret|token)$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
	return Object.freeze(value);
}

function safeText(value: unknown, fallback = ""): string {
	if (typeof value !== "string") return fallback;
	return sanitizeText(value).replace(/\s+/gu, " ").trim().slice(0, 512);
}

function safeIdentifier(value: unknown, fallback = "(unknown)"): string {
	const text = safeText(value);
	return text || fallback;
}

function redactOpaque(value: unknown, fallback = "(unknown)"): string {
	const text = safeText(value);
	if (!text) return fallback;
	return SENSITIVE_TEXT_RE.test(text) ? "(redacted)" : text;
}

function safeRevision(value: unknown): string | null {
	const text = redactOpaque(value, "");
	return text || null;
}

function safeAlias(value: unknown): string | null {
	const text = safeText(value);
	if (!text) return null;
	if (SENSITIVE_TEXT_RE.test(text)) return "(redacted)";
	return text.includes("/") || text.includes("\\") ? shortenSafePath(text) : text;
}

function safePath(value: unknown): string | null {
	if (typeof value !== "string") return null;
	if (UNSAFE_PATH_CHARACTER_RE.test(value)) return "<redacted-path>";
	const text = safeText(value);
	if (!text) return null;
	const segments = text.replaceAll("\\", "/").split("/");
	if (segments.some(segment => SENSITIVE_PATH_SEGMENT_RE.test(segment))) return "(redacted path)";
	return shortenSafePath(text);
}

function shortenSafePath(value: string, maxWidth = 72): string {
	let text = safeText(value);
	if (!text) return "";
	text = text.replaceAll("\\", "/").replace(/\/+/gu, "/");
	const home = safeText(homedir()).replaceAll("\\", "/");
	if (home && (text === home || text.startsWith(`${home}/`))) text = `~${text.slice(home.length)}`;
	if (visibleWidth(text) <= maxWidth) return text;
	const parts = text.split("/").filter(Boolean);
	if (parts.length >= 2) {
		const tail = parts.slice(-2).join("/");
		const prefix = text.startsWith("/") ? "/…/" : "…/";
		const shortened = `${prefix}${tail}`;
		if (visibleWidth(shortened) <= maxWidth) return shortened;
	}
	return truncateToWidth(text, Math.max(1, maxWidth));
}

function safeKeyPath(value: unknown): string {
	if (typeof value !== "string") return "(unknown path)";
	if (UNSAFE_PATH_CHARACTER_RE.test(value)) return "<redacted-path>";
	const text = safeText(value, "(unknown path)");
	if (!text) return "(unknown path)";
	const segments = text.split(".");
	if (segments.some(segment => SENSITIVE_PATH_SEGMENT_RE.test(segment))) return "<redacted-path>";
	return text.slice(0, 256);
}

function normalizeEffectiveReason(value: unknown): EffectiveConfigurationReasonCode | "unknown_reason" | null {
	const reason = safeText(value).toLowerCase().replaceAll("-", "_");
	if (!reason) return null;
	return EFFECTIVE_REASON_CODES.has(reason) ? (reason as EffectiveConfigurationReasonCode) : "unknown_reason";
}

function normalizeMutationReason(value: unknown): ScopedConfigurationReasonCode | "unknown_reason" | null {
	const reason = safeText(value).toLowerCase().replaceAll("-", "_");
	if (!reason) return null;
	return MUTATION_REASON_CODES.has(reason) ? (reason as ScopedConfigurationReasonCode) : "unknown_reason";
}

function normalizeOwnership(value: unknown): EffectiveConfigurationViewOwnership {
	const ownership = safeText(value).toLowerCase();
	if (
		ownership === "builtin" ||
		ownership === "discovered" ||
		ownership === "owned" ||
		ownership === "profile" ||
		ownership === "cli" ||
		ownership === "runtime" ||
		ownership === "managed"
	) {
		return ownership;
	}
	return "unknown";
}

function normalizePresence(value: unknown): EffectiveConfigurationSourcePresence {
	return value === "present" || value === "absent" || value === "unavailable" ? value : "unavailable";
}

function normalizeStability(value: unknown): EffectiveConfigurationSourceStability {
	return value === "unstable" ? "unstable" : "stable";
}

function normalizeOrder(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function sourceSort(a: EffectiveConfigurationSourceView, b: EffectiveConfigurationSourceView): number {
	if (a.order !== b.order) return a.order - b.order;
	if (a.rank !== b.rank) return b.rank - a.rank;
	if (a.sourceId !== b.sourceId) return a.sourceId < b.sourceId ? -1 : 1;
	return (a.safePath ?? "") < (b.safePath ?? "") ? -1 : (a.safePath ?? "") === (b.safePath ?? "") ? 0 : 1;
}

function idsFromCandidates(groups: readonly (readonly EffectiveConfigurationConflictCandidate[])[]): Set<string> {
	const ids = new Set<string>();
	for (const group of groups) for (const candidate of group) ids.add(safeIdentifier(candidate.sourceId));
	return ids;
}

function sourceToView(
	entry: EffectiveConfigurationProvenanceEntry | EffectiveConfigurationExplanationOrderingEntry,
	flags: {
		readonly equalValueIds: ReadonlySet<string>;
		readonly maskedIds: ReadonlySet<string>;
		readonly clearedIds: ReadonlySet<string>;
	},
	fallbackOrder: number,
): EffectiveConfigurationSourceView {
	const sourceId = safeIdentifier(entry.sourceId);
	const aliases = [
		...new Set((entry.aliases ?? []).map(safeAlias).filter((item): item is string => item !== null)),
	].sort();
	const ownership = normalizeOwnership(entry.ownership);
	const eligible = entry.eligibility === "eligible";
	const reason = normalizeEffectiveReason(entry.ineligibilityReason);
	const view: EffectiveConfigurationSourceView = {
		order: normalizeOrder((entry as EffectiveConfigurationExplanationOrderingEntry).order, fallbackOrder),
		sourceId,
		canonicalKey: safeIdentifier(entry.canonicalKey, "(unknown key)"),
		rank: typeof entry.rank === "number" && Number.isFinite(entry.rank) ? entry.rank : 0,
		ownership,
		safePath: safePath(entry.safePath),
		aliases,
		revision: safeRevision(entry.revision),
		digest: safeRevision(entry.digest),
		presence: normalizePresence(entry.presence),
		stability: normalizeStability(entry.stability),
		eligible,
		ineligibilityReason: eligible ? null : (reason ?? "unknown_reason"),
		equalValue: flags.equalValueIds.has(sourceId),
		masked: flags.maskedIds.has(sourceId),
		cleared: flags.clearedIds.has(sourceId),
		writable: ownership === "owned",
	};
	return deepFreeze(view);
}

function isExplanation(value: EffectiveConfigurationViewInput): value is EffectiveConfigurationExplanation {
	if (!isRecord(value)) return false;
	if (!("ordering" in value && "provenance" in value)) return false;
	return Array.isArray(value.ordering) && Array.isArray(value.provenance);
}

function toExplanation(input: EffectiveConfigurationViewInput): EffectiveConfigurationExplanation {
	if (isRecord(input) && "result" in input && isRecord(input.result)) {
		if (isRecord(input.explanation) && Array.isArray(input.explanation.ordering)) {
			return input.explanation as EffectiveConfigurationExplanation;
		}
		return new EffectiveConfigurationResolver().explain(input.result as EffectiveConfigurationResult);
	}
	if (isExplanation(input)) return input;
	return new EffectiveConfigurationResolver().explain(input as EffectiveConfigurationResult);
}

function recoveryForExplain(
	state: EffectiveConfigurationViewState,
	reason: EffectiveConfigurationReasonCode | "unknown_reason" | null,
	clearToLower: boolean,
): EffectiveConfigurationRecoveryView {
	if (state === "conflict") {
		return deepFreeze({
			code: "resolve_conflict",
			label: "No winner; resolve the same-rank conflict.",
			steps: [
				"Inspect the listed sources without exposing their values.",
				"Keep one owned source or clear the conflicting key.",
				"Reload and explain the key again.",
			],
		});
	}
	if (state === "unavailable") {
		const unstable = reason === "unstable_source" || reason === "source_race";
		const unknown = reason === "unknown_physical_identity";
		return deepFreeze({
			code: unstable ? "wait_for_stable_source" : unknown ? "identify_source" : "restore_source",
			label: unstable
				? "Source is unstable; wait for a stable snapshot."
				: unknown
					? "Source identity is unknown; do not write to it."
					: "No eligible source is available.",
			steps: unstable
				? ["Retry after the source settles.", "Explain the key again before changing it."]
				: unknown
					? ["Use an owned project or user scope.", "Explain the key again after identity is known."]
					: ["Repair or restore an owned source.", "Reload and explain the key again."],
		});
	}
	if (state === "absent") {
		return deepFreeze({
			code: "set_owned_source",
			label: "No value is resolved.",
			steps: ["Choose an owned writable scope.", "Set the key, then reload the configuration."],
		});
	}
	if (clearToLower) {
		return deepFreeze({
			code: "review_clear",
			label: "A higher source clears a lower value.",
			steps: ["Review the cleared higher source.", "Keep the clear or remove it, then reload."],
		});
	}
	return deepFreeze({ code: "none", label: "No recovery needed.", steps: [] });
}

/** Build the immutable explain view without exposing the resolved value. */
export function createEffectiveConfigurationExplainView(
	input: EffectiveConfigurationViewInput,
): EffectiveConfigurationExplainView {
	const explanation = toExplanation(input);
	const ordering = [...(explanation.ordering ?? explanation.provenance ?? [])].sort((a, b) => {
		const orderA = normalizeOrder(
			(a as EffectiveConfigurationExplanationOrderingEntry).order,
			Number.MAX_SAFE_INTEGER,
		);
		const orderB = normalizeOrder(
			(b as EffectiveConfigurationExplanationOrderingEntry).order,
			Number.MAX_SAFE_INTEGER,
		);
		if (orderA !== orderB) return orderA - orderB;
		const rankA = typeof a.rank === "number" ? a.rank : 0;
		const rankB = typeof b.rank === "number" ? b.rank : 0;
		if (rankA !== rankB) return rankB - rankA;
		return safeIdentifier(a.sourceId).localeCompare(safeIdentifier(b.sourceId));
	});
	const resultWinner =
		isRecord(input) &&
		"result" in input &&
		isRecord(input.result) &&
		(input.result as EffectiveConfigurationResult).state === "resolved"
			? (input.result as Extract<EffectiveConfigurationResult, { readonly state: "resolved" }>).winner
			: undefined;
	const winnerId = resultWinner
		? safeIdentifier(resultWinner.sourceId)
		: explanation.state === "resolved" && explanation.winner
			? safeIdentifier(explanation.winner.sourceId)
			: null;
	const winnerRank =
		explanation.winner?.rank ?? ordering.find(entry => safeIdentifier(entry.sourceId) === winnerId)?.rank ?? null;
	const equalValueIds = new Set<string>();
	if (explanation.state === "resolved" && winnerRank !== null) {
		for (const entry of ordering) {
			if (entry.rank === winnerRank && entry.presence === "present" && entry.eligibility === "eligible") {
				equalValueIds.add(safeIdentifier(entry.sourceId));
			}
		}
	}
	const maskedIds = idsFromCandidates(explanation.maskedConflicts ?? []);
	const clearedIds = new Set(
		(explanation.clearToLower?.higherAbsentSourceIds ?? []).map(sourceId => safeIdentifier(sourceId)),
	);
	const sourceViews = ordering.map((entry, index) =>
		sourceToView(entry, { equalValueIds, maskedIds, clearedIds }, index + 1),
	);
	const sources = [...sourceViews].sort(sourceSort);
	const sourceById = new Map(sources.map(source => [source.sourceId, source]));
	const winner = winnerId && explanation.state === "resolved" ? sourceById.get(winnerId) : undefined;
	const equalValueEvidence = deepFreeze({
		sourceIds: [...equalValueIds].sort(),
		rank: equalValueIds.size > 0 ? winnerRank : null,
	});
	const maskedConflicts = deepFreeze(
		(explanation.maskedConflicts ?? []).map(group =>
			deepFreeze({
				sourceIds: group.map(candidate => safeIdentifier(candidate.sourceId)).sort(),
				rank: group[0]?.rank ?? null,
			}),
		),
	);
	const canonicalKey = safeIdentifier(explanation.canonicalKey, "(unknown key)");
	const state: EffectiveConfigurationViewState =
		explanation.state === "resolved" || explanation.state === "absent" || explanation.state === "conflict"
			? explanation.state
			: "unavailable";
	const reason = normalizeEffectiveReason(explanation.reason);
	const recovery = recoveryForExplain(state, reason, explanation.clearToLower?.occurred === true);
	const evidence = deepFreeze([...sources]);
	const base: Omit<EffectiveConfigurationExplainView, "lines"> = {
		canonicalKey,
		state,
		reason,
		sources: deepFreeze(sources),
		evidence,
		equalValueEvidence,
		maskedConflicts,
		clearedSourceIds: deepFreeze([...clearedIds].sort()),
		...(winner === undefined ? {} : { winner }),
		hasWinner: winner !== undefined,
		clearToLower: explanation.clearToLower?.occurred === true,
		recovery,
	};
	const viewWithoutLines = deepFreeze(base);
	const lines = renderEffectiveConfigurationExplainLines(viewWithoutLines as EffectiveConfigurationExplainView, 120);
	return deepFreeze({ ...viewWithoutLines, lines });
}

function pathLabel(source: EffectiveConfigurationSourceView): string {
	return source.safePath ?? "(path unavailable)";
}

function sourceLine(source: EffectiveConfigurationSourceView): string {
	const aliases = source.aliases.length > 0 ? ` aliases=${source.aliases.join(",")}` : "";
	const revision = source.revision === null ? " revision=(none)" : ` revision=${source.revision}`;
	const eligibility = source.eligible ? "eligible" : `ineligible:${source.ineligibilityReason ?? "unknown_reason"}`;
	const flags = [source.equalValue ? "equal" : "", source.masked ? "masked" : "", source.cleared ? "cleared" : ""]
		.filter(Boolean)
		.join(",");
	return `Source ${source.order}: rank=${source.rank} ownership=${source.ownership} ${eligibility} presence=${source.presence} stability=${source.stability} path=${pathLabel(source)}${revision}${aliases}${flags ? ` flags=${flags}` : ""}`;
}

function renderWidth(options: EffectiveConfigurationRenderOptions): number {
	const width = typeof options === "number" ? options : options?.width;
	return Math.max(1, Number.isFinite(width) ? Math.floor(width as number) : 120);
}

function renderLine(line: string, width: number): string {
	return truncateToWidth(safeText(line), width);
}

/** Render semantic, no-color explain lines clipped by terminal-cell width. */
export function renderEffectiveConfigurationExplainLines(
	view: EffectiveConfigurationExplainView,
	options?: EffectiveConfigurationRenderOptions,
): readonly string[] {
	const width = renderWidth(options);
	const lines: string[] = [
		"Effective configuration",
		`Canonical key: ${view.canonicalKey}`,
		`State: ${view.state}${view.reason ? ` (${view.reason})` : ""}`,
	];
	if (view.hasWinner && view.winner) lines.push(`Winner: source=${view.winner.sourceId} rank=${view.winner.rank}`);
	else if (view.state === "conflict") lines.push("Winner: none (conflict)");
	for (const source of view.sources) lines.push(sourceLine(source));
	if (view.equalValueEvidence.sourceIds.length > 1) {
		lines.push(
			`Equal-value evidence: rank=${view.equalValueEvidence.rank ?? "?"} sources=${view.equalValueEvidence.sourceIds.join(",")}`,
		);
	}
	for (const conflict of view.maskedConflicts) {
		lines.push(`Masked conflict: rank=${conflict.rank ?? "?"} sources=${conflict.sourceIds.join(",")}`);
	}
	if (view.clearedSourceIds.length > 0) lines.push(`Cleared sources: ${view.clearedSourceIds.join(",")}`);
	lines.push(`Recovery: ${view.recovery.label}`);
	for (const step of view.recovery.steps) lines.push(`Recovery step: ${step}`);
	return deepFreeze(lines.map(line => renderLine(line, width)));
}

/** Build picker details from the same explain adapter; no value is copied into the view. */
export function createEffectiveConfigurationPickerDetailsView(
	input: EffectiveConfigurationViewInput,
	options: EffectiveConfigurationPickerDetailsOptions = {},
): EffectiveConfigurationPickerDetailsView {
	const explain = createEffectiveConfigurationExplainView(input);
	const requested = options.selectedSourceId ? safeIdentifier(options.selectedSourceId) : null;
	const defaultId = explain.winner?.sourceId ?? explain.sources[0]?.sourceId ?? null;
	const selectedSourceId =
		requested && explain.sources.some(source => source.sourceId === requested) ? requested : defaultId;
	const selectedSource =
		selectedSourceId === null ? null : (explain.sources.find(source => source.sourceId === selectedSourceId) ?? null);
	const picker: Omit<EffectiveConfigurationPickerDetailsView, "lines"> = {
		...explain,
		selectedSourceId,
		selectedSource,
		sourceOptions: explain.sources,
		writableSourceIds: deepFreeze(
			explain.sources
				.filter(source => source.writable)
				.map(source => source.sourceId)
				.sort(),
		),
	};
	const frozen = deepFreeze(picker);
	const lines = renderEffectiveConfigurationPickerDetailsLines(frozen as EffectiveConfigurationPickerDetailsView, 120);
	return deepFreeze({ ...frozen, lines });
}

export function renderEffectiveConfigurationPickerDetailsLines(
	view: EffectiveConfigurationPickerDetailsView,
	options?: EffectiveConfigurationRenderOptions,
): readonly string[] {
	const width = renderWidth(options);
	const lines: string[] = [
		"Configuration picker details",
		`Canonical key: ${view.canonicalKey}`,
		`State: ${view.state}`,
		`Selected source: ${view.selectedSource?.sourceId ?? "none"}`,
		`Writable sources: ${view.writableSourceIds.length > 0 ? view.writableSourceIds.join(",") : "none"}`,
	];
	if (view.selectedSource) lines.push(`Selected detail: ${sourceLine(view.selectedSource)}`);
	if (view.state === "conflict") lines.push("Selection is read-only until the conflict has no competing winner.");
	lines.push(`Recovery: ${view.recovery.label}`);
	return deepFreeze(lines.map(line => renderLine(line, width)));
}

function sourceScopeFor(
	source: EffectiveConfigurationSourceView | EffectiveConfigurationProvenanceEntry,
): Exclude<ConfigurationScopeId, "session"> | "session" {
	const rank = typeof source.rank === "number" ? source.rank : 0;
	if (rank >= 90 || source.ownership === "managed") return "managed";
	if (rank >= 40) return "project";
	return "user";
}

function scopeSources(
	input: EffectiveConfigurationScopeSelectionInput,
): readonly (EffectiveConfigurationSourceView | EffectiveConfigurationProvenanceEntry)[] {
	if (input.sources) return input.sources;
	if (input.configuration !== undefined) return createEffectiveConfigurationExplainView(input.configuration).sources;
	return [];
}

/** Scope choices are data-only; discovered sources are exposed as read-only facts. */
export function createEffectiveConfigurationScopeSelectionView(
	input: EffectiveConfigurationScopeSelectionInput | string | null = {},
): EffectiveConfigurationScopeSelectionView {
	const options: EffectiveConfigurationScopeSelectionInput =
		typeof input === "string" || input === null ? { repoRoot: input } : input;
	const repoRoot = safeText(options.repoRoot ?? "");
	const sourceInputs = scopeSources(options);
	const sourceViews = sourceInputs.map((source, index) => {
		const sourceId = safeIdentifier(source.sourceId);
		const ownership = normalizeOwnership(source.ownership);
		const discovered = ownership === "discovered";
		const scope = sourceScopeFor(source);
		return deepFreeze({
			sourceId,
			scope,
			ownership,
			safePath: safePath(source.safePath),
			available: true,
			writable: !discovered && ownership === "owned",
			reason: discovered ? "Discovered source is read-only." : ownership === "owned" ? null : "Source is not owned.",
			_order: index,
		});
	});
	const sources = deepFreeze(sourceViews.map(({ _order: _ignored, ...source }) => source));
	const selected =
		options.selectedScope === "session" ||
		options.selectedScope === "project" ||
		options.selectedScope === "user" ||
		options.selectedScope === "managed"
			? options.selectedScope
			: null;
	const projectAvailable = repoRoot.length > 0;
	const projectPath = options.targetPaths?.project === null ? null : safePath(options.targetPaths?.project);
	const userPath = options.targetPaths?.user === null ? null : safePath(options.targetPaths?.user);
	const scopeOptions: EffectiveConfigurationScopeOptionView[] = [
		{
			id: "session",
			label: "This session",
			available: true,
			writable: true,
			locked: false,
			selected: selected === "session",
			targetPath: null,
			reason: null,
		},
		{
			id: "project",
			label: "This project",
			available: projectAvailable,
			writable: projectAvailable,
			locked: false,
			selected: selected === "project" && projectAvailable,
			targetPath: projectPath,
			reason: projectAvailable ? null : "Project scope unavailable: no repository root.",
		},
		{
			id: "user",
			label: "User default",
			available: true,
			writable: true,
			locked: false,
			selected: selected === "user",
			targetPath: userPath,
			reason: null,
		},
		{
			id: "managed",
			label: "Managed",
			available: true,
			writable: false,
			locked: true,
			selected: selected === "managed",
			targetPath: null,
			reason: "Managed scope is locked.",
		},
	];
	const viewWithoutLines: Omit<EffectiveConfigurationScopeSelectionView, "lines"> = {
		selectedScope: selected && scopeOptions.some(scope => scope.id === selected && scope.available) ? selected : null,
		scopes: deepFreeze(scopeOptions),
		sources,
	};
	const frozen = deepFreeze(viewWithoutLines);
	const lines = renderEffectiveConfigurationScopeSelectionLines(
		frozen as EffectiveConfigurationScopeSelectionView,
		120,
	);
	return deepFreeze({ ...frozen, lines });
}

export function renderEffectiveConfigurationScopeSelectionLines(
	view: EffectiveConfigurationScopeSelectionView,
	options?: EffectiveConfigurationRenderOptions,
): readonly string[] {
	const width = renderWidth(options);
	const lines = [
		"Configuration scope",
		...view.scopes.map(scope => {
			const state = scope.locked
				? "locked"
				: scope.available
					? scope.writable
						? "writable"
						: "read-only"
					: "unavailable";
			const target = scope.targetPath ? ` target=${scope.targetPath}` : "";
			const reason = scope.reason ? ` reason=${scope.reason}` : "";
			return `${scope.selected ? "> " : "  "}${scope.label}: ${state}${target}${reason}`;
		}),
	];
	for (const source of view.sources) {
		lines.push(
			`Source ${source.sourceId}: scope=${source.scope} ${source.writable ? "writable" : "read-only"}${source.safePath ? ` path=${source.safePath}` : ""}`,
		);
	}
	return deepFreeze(lines.map(line => renderLine(line, width)));
}

function mutationStatus(value: unknown): ScopedConfigurationMutationStatus {
	return typeof value === "string" && VALID_MUTATION_STATUSES.has(value as ScopedConfigurationMutationStatus)
		? (value as ScopedConfigurationMutationStatus)
		: "rejected";
}

function mutationStatusLabel(
	status: ScopedConfigurationMutationStatus,
): ScopedConfigurationTransientStatusView["statusLabel"] {
	return (status[0].toUpperCase() + status.slice(1)) as ScopedConfigurationTransientStatusView["statusLabel"];
}

function mutationReasonLabel(reason: ScopedConfigurationTransientStatusView["reason"]): string {
	if (reason === null) return "No additional reason.";
	const words = reason.replaceAll("_", " ");
	return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
}

function mutationRecovery(
	status: ScopedConfigurationMutationStatus,
	reason: ScopedConfigurationTransientStatusView["reason"],
): EffectiveConfigurationRecoveryView {
	if (reason === "persistent_reload_mismatch" || reason === "persistent_reload_unconfirmed") {
		return deepFreeze({
			code: "reload_and_verify",
			label: "Durable write is unconfirmed; verify before retrying.",
			steps: ["Reload the configuration and explain the key.", "Retry only after the durable value is confirmed."],
		});
	}
	if (reason === "runtime_postcommit_failed") {
		return deepFreeze({
			code: "repair_runtime",
			label: "Durable write landed, but the current runtime is degraded.",
			steps: ["Keep the durable change if the file is correct.", "Restart or reapply the runtime, then verify."],
		});
	}
	if (reason === "runtime_precommit_failed") {
		return deepFreeze({
			code: "retry_runtime",
			label: "Runtime rejected the change before commit.",
			steps: ["Leave the durable configuration unchanged.", "Retry after the runtime accepts the request."],
		});
	}
	if (status === "conflict" || reason === "scope_conflict") {
		return deepFreeze({
			code: "refresh_scope",
			label: "Scope changed; refresh ownership and retry.",
			steps: ["Read the current scope snapshot.", "Retry with its current owner and revision."],
		});
	}
	if (status === "locked" || reason === "scope_locked" || reason === "project_scope_unavailable") {
		return deepFreeze({
			code: "choose_writable_scope",
			label: "Choose an available owned scope.",
			steps: ["Use This session, This project, or User default when available."],
		});
	}
	if (status === "rejected") {
		return deepFreeze({
			code: "correct_request",
			label: "Request was rejected; no success is claimed.",
			steps: ["Correct the request using the stable reason above.", "Retry without exposing raw error details."],
		});
	}
	return deepFreeze({ code: "none", label: "No recovery needed.", steps: [] });
}

/** Adapt a mutation receipt without copying errors, values, or unsafe paths. */
export function createScopedConfigurationTransientStatusView(
	input: ScopedConfigurationMutationResult,
	options?: EffectiveConfigurationRenderOptions,
): ScopedConfigurationTransientStatusView {
	const record: ScopedConfigurationMutationReceipt = input;
	const status = mutationStatus(record.status);
	const reason = normalizeMutationReason(record.reason);
	const timing: ScopedConfigurationTiming = record.timing === "current_runtime" ? "current_runtime" : "next_session";
	const confirmation =
		record.confirmation === "confirmed" || record.confirmation === "unconfirmed"
			? record.confirmation
			: "not_applicable";
	const durability =
		record.durability === "committed" || record.durability === "committed_unconfirmed" ? record.durability : "none";
	const runtimePostcommitFailed = reason === "runtime_postcommit_failed";
	const reloadMismatch =
		reason === "persistent_reload_mismatch" ||
		reason === "persistent_reload_unconfirmed" ||
		(!runtimePostcommitFailed && durability === "committed_unconfirmed");
	const runtimeDegraded = runtimePostcommitFailed || reason === "runtime_precommit_failed";
	const degradation: EffectiveConfigurationDegradationKind = reloadMismatch
		? "reload_mismatch"
		: runtimeDegraded
			? "runtime"
			: "none";
	const statusLabel = mutationStatusLabel(status);
	const headline = reloadMismatch
		? "Configuration committed; reload is unconfirmed."
		: reason === "runtime_postcommit_failed"
			? "Configuration committed; current runtime is degraded."
			: reason === "runtime_precommit_failed"
				? "Configuration was not committed; runtime rejected it."
				: status === "committed"
					? "Configuration committed."
					: status === "applied"
						? "Configuration applied to the current runtime."
						: status === "degraded"
							? "Configuration is degraded; success is not confirmed."
							: status === "conflict"
								? "Configuration was not changed because the scope conflicted."
								: status === "locked"
									? "Configuration was not changed because the scope is locked."
									: "Configuration was rejected; no success is claimed.";
	const patches = Array.isArray(record.patches)
		? record.patches
				.map(patch => {
					if (!isRecord(patch) || (patch.op !== "set" && patch.op !== "clear")) return null;
					return deepFreeze({ op: patch.op, path: safeKeyPath(patch.path) });
				})
				.filter((patch): patch is ScopedConfigurationSafePatchView => patch !== null)
		: [];
	const viewWithoutLines: Omit<ScopedConfigurationTransientStatusView, "lines"> = {
		status,
		statusLabel,
		headline,
		reason,
		reasonLabel: mutationReasonLabel(reason),
		recovery: mutationRecovery(status, reason),
		timing,
		timingLabel: timing === "current_runtime" ? "Current runtime" : "Next session",
		confirmation,
		durability,
		degradation,
		targetPath: safePath(record.safePath),
		patches: deepFreeze(patches),
		optimisticSuccess: false,
	};
	const frozen = deepFreeze(viewWithoutLines);
	const lines = renderScopedConfigurationTransientStatusLines(
		frozen as ScopedConfigurationTransientStatusView,
		options,
	);
	return deepFreeze({ ...frozen, lines });
}

export function renderScopedConfigurationTransientStatusLines(
	view: ScopedConfigurationTransientStatusView,
	options?: EffectiveConfigurationRenderOptions,
): readonly string[] {
	const width = renderWidth(options);
	const lines = [
		"Configuration status",
		`Outcome: ${view.statusLabel}`,
		view.headline,
		`Timing: ${view.timingLabel}`,
		`Confirmation: ${view.confirmation}`,
		`Durability: ${view.durability}`,
		`Reason: ${view.reasonLabel}`,
		`Target: ${view.targetPath ?? "(path unavailable)"}`,
		`Degradation: ${view.degradation}`,
	];
	if (view.patches.length > 0)
		lines.push(`Patches: ${view.patches.map(patch => `${patch.op} ${patch.path}`).join(", ")}`);
	lines.push(`Recovery: ${view.recovery.label}`);
	for (const step of view.recovery.steps) lines.push(`Recovery step: ${step}`);
	return deepFreeze(lines.map(line => renderLine(line, width)));
}

/** Short aliases keep consumer call sites descriptive without duplicating adapters. */
export const buildEffectiveConfigurationExplainView = createEffectiveConfigurationExplainView;
export const buildEffectiveConfigurationPickerDetailsView = createEffectiveConfigurationPickerDetailsView;
export const buildEffectiveConfigurationScopeSelectionView = createEffectiveConfigurationScopeSelectionView;
export const adaptScopedConfigurationMutationResult = createScopedConfigurationTransientStatusView;
export const renderEffectiveConfigurationExplain = renderEffectiveConfigurationExplainLines;
export const renderEffectiveConfigurationPickerDetails = renderEffectiveConfigurationPickerDetailsLines;
export const renderEffectiveConfigurationScopeSelection = renderEffectiveConfigurationScopeSelectionLines;
export const renderScopedConfigurationTransientStatus = renderScopedConfigurationTransientStatusLines;

export const toEffectiveConfigurationExplainView = createEffectiveConfigurationExplainView;
export const createConfigurationExplainView = createEffectiveConfigurationExplainView;
export const toEffectiveConfigurationPickerDetailsView = createEffectiveConfigurationPickerDetailsView;
export const createEffectiveConfigurationPickerView = createEffectiveConfigurationPickerDetailsView;
export const createConfigurationPickerDetailsView = createEffectiveConfigurationPickerDetailsView;
export const toEffectiveConfigurationScopeSelectionView = createEffectiveConfigurationScopeSelectionView;
export const createConfigurationScopeSelectionView = createEffectiveConfigurationScopeSelectionView;
export const toScopedConfigurationTransientStatusView = createScopedConfigurationTransientStatusView;
export const createConfigurationTransientStatusView = createScopedConfigurationTransientStatusView;
export const createScopedConfigurationStatusView = createScopedConfigurationTransientStatusView;
export const adaptEffectiveConfigurationResult = createEffectiveConfigurationExplainView;
export const renderConfigurationExplainLines = renderEffectiveConfigurationExplainLines;
export const renderConfigurationPickerDetailsLines = renderEffectiveConfigurationPickerDetailsLines;
export const renderConfigurationScopeSelectionLines = renderEffectiveConfigurationScopeSelectionLines;
export const renderConfigurationStatusLines = renderScopedConfigurationTransientStatusLines;
