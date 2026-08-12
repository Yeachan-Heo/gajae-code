import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { BUILTIN_MODEL_PROFILES, type ModelProfileDefinition } from "../src/config/model-profiles";
import { ModelRegistry } from "../src/config/model-registry";
import type { ScopedConfigurationMutationReceipt } from "../src/config/scoped-configuration-mutation";
import { Settings } from "../src/config/settings";
import { CURATED_WORK_MODES, type CuratedWorkMode, WORK_MODE_CATALOG_VERSION } from "../src/config/work-mode-catalog";
import {
	getWorkModeExecutionCase,
	WORK_MODE_EXECUTION_CASES,
	type WorkModeExecutionCase,
	type WorkModeExecutionCaseId,
	type WorkModeExecutionCaseMap,
	type WorkModeTurnFinalizeCaseMap,
} from "../src/config/work-mode-execution-cases";
import type {
	DurableMutationStatus,
	ReadinessFact,
	RoleResolutionFact,
	RuntimeActivationStatus,
	WorkModeFacts,
	WorkModeFingerprint,
	WorkModeOperationEvent,
	WorkModeOperationFailureCode,
	WorkModeOperationReceipt,
	WorkModePreGateExitReason,
	WorkModePreviewResult,
	WorkModeRoleReadiness,
} from "../src/config/work-mode-result";
import {
	buildWorkModeRoleTuple,
	computeWorkModeFingerprint,
	definitionFactFromProfile,
	presentFingerprintFact,
	relateWorkModeFingerprints,
	unavailableFingerprintFact,
} from "../src/config/work-mode-result";
import {
	createPendingWorkModeStatusView,
	createWorkModePaletteEntries,
	createWorkModePreviewView,
	createWorkModeReceiptView,
	createWorkModeScopeSelectionView,
	createWorkModeSelectorCards,
	createWorkModeStatusView,
	renderWorkModeExplainLines,
	renderWorkModePreviewLines,
	renderWorkModeScopeLines,
	renderWorkModeStatusLines,
	type WorkModeScope,
	type WorkModeScopeChoiceView,
} from "../src/config/work-mode-view";
import {
	ModelSelectorComponent,
	type ModelSelectorSelection,
	type ModelSelectorWorkModeAdapter,
} from "../src/modes/components/model-selector";
import { getThemeByName, setColorBlindMode, setThemeInstance } from "../src/modes/theme/theme";
import { AuthStorage } from "../src/session/auth-storage";

export const WORK_MODE_VISUAL_CAPTURE_SCHEMA = "gjc.work-mode.visual-capture" as const;
export const WORK_MODE_VISUAL_CAPTURE_VERSION = 1 as const;
export const WORK_MODE_VISUAL_CAPTURE_COUNT = 107 as const;
export const WORK_MODE_CAPTURE_TIMESTAMP = "1970-01-01T00:00:00.000Z" as const;
export const WORK_MODE_CAPTURE_LOCALE = "en-US" as const;
export const WORK_MODE_CAPTURE_TIMEZONE = "UTC" as const;
export const WORK_MODE_CAPTURE_SEED = "g002.5-work-mode-seed-v1" as const;
export const WORK_MODE_CAPTURE_THEME = "red-claw" as const;
export const WORK_MODE_CAPTURE_DEFAULT_OUTPUT = ".gjc/qa/G002.5" as const;
export const WORK_MODE_CAPTURE_DEFAULT_REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
export const WORK_MODE_SOURCE_CLOSURE_FILES = [
	"packages/coding-agent/src/modes/theme/theme.ts",
	"packages/coding-agent/src/modes/theme/defaults/index.ts",
	"packages/coding-agent/src/modes/theme/defaults/red-claw.json",
	"packages/coding-agent/scripts/capture-work-mode-showcase.ts",
	"packages/coding-agent/scripts/verify-work-mode-showcase.ts",
	"packages/coding-agent/src/config/model-profiles.ts",
	"packages/coding-agent/src/config/work-mode-catalog.ts",
	"packages/coding-agent/src/config/work-mode-result.ts",
	"packages/coding-agent/src/config/work-mode-execution-cases.ts",
	"packages/coding-agent/src/config/work-mode-view.ts",
	"packages/coding-agent/src/modes/components/model-selector.ts",
	"packages/coding-agent/src/modes/components/settings-selector.ts",
	"packages/coding-agent/src/modes/components/tool-status-header.ts",
	"packages/coding-agent/src/modes/controllers/selector-controller.ts",
] as const;
export const WORK_MODE_CAPTURE_FILES = [
	"terminal.txt",
	"terminal-ansi.txt",
	"terminal.html",
	"metadata.json",
	"manifest.json",
] as const;

export const WORK_MODE_BASE_STATE_IDS = Object.freeze([
	"catalog",
	"selector",
	"preview-ready",
	"preview-degraded",
	"preview-unavailable",
	"scope-turn",
	"scope-session",
	"scope-project",
	"scope-user",
	"pending",
	"confirmation",
	"drift",
	"conflict",
	"locked",
	"rejected",
	"write-failure",
	"committed-unconfirmed",
	"partial-activation",
	"partial-rollback",
	"pre-gate-settlement",
	"admitted-success",
	"admitted-failure",
	"finalization-success",
	"finalization-failure",
	"custom-qualification",
	"palette",
	"status",
	"explain",
	"receipt",
	"recovery",
	"catalog-unavailable",
] as const);

export const WORK_MODE_SUPPLEMENTAL_IDS = Object.freeze([
	"no-color",
	"cjk",
	"focus",
	"scroll",
	"keyboard",
	"mouse",
	"disposal",
	"color-blind-deuteranopia",
	"color-blind-protanopia",
	"color-blind-tritanopia",
	"no-color-wide",
	"cjk-wide",
	"focus-narrow",
	"scroll-wide",
] as const);

const VIEWPORTS = Object.freeze([
	Object.freeze({ id: "80x24", columns: 80, rows: 24 }),
	Object.freeze({ id: "120x36", columns: 120, rows: 36 }),
	Object.freeze({ id: "160x48", columns: 160, rows: 48 }),
] as const);

type Viewport = (typeof VIEWPORTS)[number];
type SupplementalId = (typeof WORK_MODE_SUPPLEMENTAL_IDS)[number];
type CaptureEntryFlags = Readonly<{
	noColor: boolean;
	cjk: boolean;
	focus: boolean;
	scroll: boolean;
	keyboard: boolean;
	mouse: boolean;
	disposal: boolean;
	colorBlindDisposition: "none" | "deuteranopia" | "protanopia" | "tritanopia";
}>;

export type WorkModeVisualCaptureSourceClosure = Readonly<{
	files: readonly string[];
	sha256: string;
}>;

export type WorkModeVisualRenderTrace = Readonly<{
	component: "ModelSelectorComponent";
	theme: typeof WORK_MODE_CAPTURE_THEME;
	colorBlind: boolean;
	ansiTokenColorSet: readonly string[];
	ansiTokenColorSetHash: string;
	beforeInteractionSha256: string;
	afterInteractionSha256: string;
	interactionChanged: boolean;
	sourceToken: "toolDiffAdded" | null;
	reason: "settings.colorBlindMode" | null;
}>;
export type WorkModeVisualCaptureEntry = Readonly<{
	key: string;
	stateId: string;
	semanticStateId: string;
	semanticDetailHash: string;
	viewport: Viewport;
	flags: CaptureEntryFlags;
	lineStart: number;
	lineCount: number;
	plainSha256: string;
	ansiSha256: string;
	productionRender: true;
	renderTrace: WorkModeVisualRenderTrace;
	renderTraceHash: string;
	actions: readonly string[];
}>;

export type WorkModeVisualCaptureMetadata = Readonly<{
	schema: typeof WORK_MODE_VISUAL_CAPTURE_SCHEMA;
	version: typeof WORK_MODE_VISUAL_CAPTURE_VERSION;
	sourceHash: string;
	captureTimestamp: string;
	locale: typeof WORK_MODE_CAPTURE_LOCALE;
	timezone: typeof WORK_MODE_CAPTURE_TIMEZONE;
	seed: typeof WORK_MODE_CAPTURE_SEED;
	theme: typeof WORK_MODE_CAPTURE_THEME;
	adapterManifestSha256: string;
	sourceClosure: WorkModeVisualCaptureSourceClosure;
	expectedKeyCount: typeof WORK_MODE_VISUAL_CAPTURE_COUNT;
	keys: readonly string[];
	entries: readonly WorkModeVisualCaptureEntry[];
	hashes: Readonly<Record<"terminal.txt" | "terminal-ansi.txt" | "terminal.html", string>>;
}>;

export type WorkModeVisualCaptureManifest = Readonly<{
	schema: typeof WORK_MODE_VISUAL_CAPTURE_SCHEMA;
	version: typeof WORK_MODE_VISUAL_CAPTURE_VERSION;
	sourceHash: string;
	adapterManifestSha256: string;
	sourceClosure: WorkModeVisualCaptureSourceClosure;
	expectedKeyCount: typeof WORK_MODE_VISUAL_CAPTURE_COUNT;
	keys: readonly string[];
	files: Readonly<
		Record<
			"terminal.txt" | "terminal-ansi.txt" | "terminal.html" | "metadata.json",
			Readonly<{ sha256: string; byteLength: number }>
		>
	>;
	entries: readonly WorkModeVisualCaptureEntry[];
}>;

export type WorkModeVisualCaptureOptions = Readonly<{
	repoRoot?: string;
	sourceHash?: string;
	timestamp?: string;
}>;

const ADAPTER_MANIFEST = Object.freeze({
	catalog: "CURATED_WORK_MODES",
	preview: "createWorkModePreviewView/renderWorkModePreviewLines",
	scope: "createWorkModeScopeSelectionView/renderWorkModeScopeLines",
	status: "createWorkModeStatusView/renderWorkModeStatusLines",
	explain: "renderWorkModeExplainLines",
	palette: "createWorkModePaletteEntries",
	selector: "createWorkModeSelectorCards",
	cases: WORK_MODE_EXECUTION_CASES.map(candidate => candidate.caseId),
	catalogVersion: WORK_MODE_CATALOG_VERSION,
});

const hash = (value: string | Uint8Array): string => new Bun.CryptoHasher("sha256").update(value).digest("hex");

export async function computeWorkModeSourceClosure(
	repoRootInput: string = WORK_MODE_CAPTURE_DEFAULT_REPO_ROOT,
): Promise<WorkModeVisualCaptureSourceClosure> {
	const repoRoot = path.resolve(repoRootInput);
	const hasher = new Bun.CryptoHasher("sha256");
	for (const relativePath of WORK_MODE_SOURCE_CLOSURE_FILES) {
		hasher.update(relativePath);
		hasher.update("\0");
		try {
			hasher.update(await fs.readFile(path.join(repoRoot, relativePath)));
		} catch {
			throw new Error(`Work Mode source closure file unavailable: ${relativePath}`);
		}
	}
	return { files: WORK_MODE_SOURCE_CLOSURE_FILES, sha256: hasher.digest("hex") };
}
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
export const WORK_MODE_ADAPTER_MANIFEST = ADAPTER_MANIFEST;
export const WORK_MODE_ADAPTER_MANIFEST_SHA256 = hash(JSON.stringify(ADAPTER_MANIFEST));

function safeHash(value: string | undefined): string {
	const candidate = value?.trim() || WORK_MODE_ADAPTER_MANIFEST_SHA256;
	if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(candidate)) throw new Error("Invalid Work Mode source hash.");
	return candidate;
}

function safeTimestamp(value: string | undefined): string {
	const candidate = value?.trim() || WORK_MODE_CAPTURE_TIMESTAMP;
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(candidate))
		throw new Error("Invalid Work Mode capture timestamp.");
	return candidate;
}

function profileFor(mode: CuratedWorkMode): ModelProfileDefinition {
	const profile = BUILTIN_MODEL_PROFILES.find(candidate => candidate.name === mode.profileId);
	if (!profile) throw new Error("Work Mode catalog profile unavailable.");
	return profile;
}

function previewFingerprint(
	mode: CuratedWorkMode,
	variant: "ready" | "degraded" | "unavailable" | "drifted",
): WorkModeFingerprint {
	const profile = profileFor(mode);
	const definition = definitionFactFromProfile(profile, profile.name);
	if (!definition) throw new Error("Work Mode profile definition unavailable.");
	const degradedRoles: readonly ("planner" | "critic")[] = variant === "degraded" ? ["planner", "critic"] : [];
	const roles =
		variant === "unavailable"
			? buildWorkModeRoleTuple(() => unavailableFingerprintFact("role_resolution_unavailable"))
			: buildWorkModeRoleTuple((_index, role) => {
					const selector = profile.modelMapping[role];
					const unresolved = variant === "degraded" && (role === "planner" || role === "critic");
					const state: RoleResolutionFact["state"] = unresolved
						? "unresolved"
						: selector
							? "resolved"
							: "not_configured";
					const roleFact: RoleResolutionFact = {
						role,
						requested: selector ?? null,
						resolved: unresolved
							? null
							: selector === undefined
								? null
								: (String(selector).split(":")[0] ?? null),
						effort: unresolved
							? null
							: selector === undefined
								? null
								: (String(selector).split(":").at(-1) ?? null),
						state,
					};
					return presentFingerprintFact(roleFact);
				});
	const readiness =
		variant === "unavailable"
			? unavailableFingerprintFact("provider_readiness_unavailable")
			: presentFingerprintFact<ReadinessFact>({
					strictProviders: [{ providerId: profile.requiredProviders[0] ?? "openai-codex", state: "ready" }],
					alternativeGroups: [],
				});
	const fallback =
		variant === "unavailable"
			? unavailableFingerprintFact("fallback_resolution_unavailable")
			: presentFingerprintFact({
					defaultChain: [String(profile.modelMapping.default ?? "unresolved")],
					activeIndex: 0,
					skips: [],
				});
	return computeWorkModeFingerprint({
		catalog: presentFingerprintFact({
			version: WORK_MODE_CATALOG_VERSION,
			modeId: mode.id,
			profileId: mode.profileId,
			entryDigest: hash(`${mode.id}:${mode.profileId}:${WORK_MODE_CATALOG_VERSION}`),
		}),
		bundledDefinition: presentFingerprintFact(definition),
		effectiveDefinition: presentFingerprintFact(definition),
		registryResolution: presentFingerprintFact({
			registryRevision: "showcase-registry-v1",
			resolutionRevision: `resolution-${mode.id}-${variant}`,
			resolutionDigest: hash(`${mode.id}:resolution:${variant}`),
		}),
		readiness,
		roles,
		fallback,
		confirmation: { required: variant === "degraded", roleDegradation: degradedRoles },
	});
}

function previewResult(
	mode: CuratedWorkMode,
	variant: "ready" | "degraded" | "unavailable" | "drifted",
): WorkModePreviewResult {
	const fingerprint = previewFingerprint(mode, variant);
	if (variant === "unavailable") {
		return {
			phase: "preview",
			state: "unavailable",
			fingerprint,
			reason: "required_provider_unauthenticated",
			details: { code: "required_provider_unauthenticated", category: "readiness" },
		};
	}
	const profile = profileFor(mode);
	if (variant === "degraded") {
		const roleReadiness: Extract<WorkModeRoleReadiness, { kind: "degraded" }> = {
			kind: "degraded",
			unresolved: [
				{ role: "planner", reason: "role_unresolved" },
				{ role: "critic", reason: "role_unresolved" },
			],
			confirmation: "accepted",
		};
		const facts: WorkModeFacts = {
			mode,
			profileId: profile.name,
			requestedRoleReadiness: roleReadiness,
		};
		return {
			phase: "preview",
			state: "degraded",
			fingerprint,
			facts,
			roleReadiness,
			confirmationRequired: true,
		};
	}
	const roleReadiness: Extract<WorkModeRoleReadiness, { kind: "complete" }> = {
		kind: "complete",
		confirmation: "not_required",
	};
	const facts: WorkModeFacts = {
		mode,
		profileId: profile.name,
		requestedRoleReadiness: roleReadiness,
	};
	return {
		phase: "preview",
		state: "ready",
		fingerprint,
		facts,
		roleReadiness,
		confirmationRequired: false,
	};
}

function mutationReceipt(
	scope: "project" | "user",
	status: "committed" | "committed_unconfirmed" | "conflict" | "locked" | "rejected",
	reason: ScopedConfigurationMutationReceipt["reason"],
): ScopedConfigurationMutationReceipt {
	return {
		status: status === "committed_unconfirmed" ? "committed" : status,
		reason,
		scope,
		safePath: `/scoped/${scope}/config.yml`,
		beforeRevision: "before-revision",
		afterRevision: "after-revision",
		beforeDigest: "before-digest",
		afterDigest: "after-digest",
		timing: "next_session",
		confirmation:
			status === "committed" ? "confirmed" : status === "committed_unconfirmed" ? "unconfirmed" : "not_applicable",
		durability:
			status === "committed" ? "committed" : status === "committed_unconfirmed" ? "committed_unconfirmed" : "none",
		patches: [{ op: "set", path: "modelProfile.default" }],
	};
}

function scopedReason(value: WorkModeOperationFailureCode | null): ScopedConfigurationMutationReceipt["reason"] {
	if (value === "scope_locked") return "scope_locked";
	if (value === "scope_conflict") return "scope_conflict";
	if (value === "persistent_write_failed") return "persistent_write_failed";
	if (value === "persistent_reload_unconfirmed") return "persistent_reload_unconfirmed";
	if (value === "persistent_reload_mismatch") return "persistent_reload_mismatch";
	if (value === "project_scope_unavailable") return "project_scope_unavailable";
	if (value === "scope_rejected") return "scope_rejected";
	return "scope_rejected";
}
function durableFor(
	candidate: WorkModeExecutionCase,
	reason: WorkModeOperationFailureCode | null,
): DurableMutationStatus {
	switch (candidate.durable) {
		case "committed":
			return { kind: "committed", scopedReceipt: mutationReceipt("project", "committed", null) };
		case "committed_unconfirmed":
			return {
				kind: "committed_unconfirmed",
				code: "persistent_reload_unconfirmed",
				scopedReceipt: mutationReceipt("project", "committed_unconfirmed", "persistent_reload_unconfirmed"),
			};
		case "rejected":
			if (reason === "scope_conflict")
				return { kind: "conflict", scopedReceipt: mutationReceipt("project", "conflict", "scope_conflict") };
			if (reason === "scope_locked")
				return { kind: "locked", scopedReceipt: mutationReceipt("project", "locked", "scope_locked") };
			return {
				kind: "rejected",
				code: reason ?? candidate.legalReasons[0] ?? "scope_rejected",
				scopedReceipt: mutationReceipt("project", "rejected", scopedReason(reason)),
			};
		default:
			return { kind: "not_requested" };
	}
}

function runtimeFor(
	candidate: WorkModeExecutionCase,
	reason: WorkModeOperationFailureCode | null,
): RuntimeActivationStatus {
	switch (candidate.runtime) {
		case "applied":
			return { kind: "applied" };
		case "staged":
			return { kind: "staged" };
		case "admitted":
			return { kind: "admitted", turnLeaseId: "turn-lease-showcase" };
		case "restored":
			return { kind: "restored" };
		case "restore_failed":
			return { kind: "restore_failed", code: "turn_rollback_failed" };
		case "cancelled":
			return { kind: "cancelled", code: reason ?? "turn_admission_cancelled" };
		case "rejected":
			return { kind: "rejected", code: reason ?? candidate.legalReasons[0] ?? "operation_unexpected" };
		default:
			return { kind: "not_requested" };
	}
}

function roleReadinessFor(candidate: WorkModeExecutionCase): WorkModeRoleReadiness {
	return candidate.readiness === "degraded"
		? {
				kind: "degraded",
				unresolved: [
					{ role: "planner", reason: "role_unresolved" },
					{ role: "critic", reason: "role_unresolved" },
				],
				confirmation: "accepted",
			}
		: { kind: "complete", confirmation: "not_required" };
}

type ShowcaseEventCommon<D extends WorkModeExecutionCase> = Readonly<{
	caseId: D["caseId"];
	phase: D["phase"];
	state: D["state"];
	operationId: string;
	acceptedFingerprint: WorkModeFingerprint;
	relation: ReturnType<typeof relateWorkModeFingerprints>;
	roleReadiness: WorkModeRoleReadiness;
	confirmation: Readonly<{ required: boolean; accepted: boolean }>;
	durable: DurableMutationStatus;
	runtime: RuntimeActivationStatus;
	receipt: WorkModeOperationReceipt;
}>;

function commonEventFields<D extends WorkModeExecutionCase>(
	candidate: D,
	acceptedFingerprint: WorkModeFingerprint,
	relation: ReturnType<typeof relateWorkModeFingerprints>,
	roleReadiness: WorkModeRoleReadiness,
	durable: DurableMutationStatus,
	runtime: RuntimeActivationStatus,
	receipt: WorkModeOperationReceipt,
): ShowcaseEventCommon<D> {
	return {
		caseId: candidate.caseId,
		phase: candidate.phase,
		state: candidate.state,
		operationId: receipt.operationId,
		acceptedFingerprint,
		relation,
		roleReadiness,
		confirmation: receipt.confirmation,
		durable,
		runtime,
		receipt,
	};
}

function preGateReason(value: WorkModeOperationFailureCode | null): WorkModePreGateExitReason {
	switch (value) {
		case "turn_admission_cancelled":
		case "turn_admission_handoff_cancelled":
		case "turn_admission_disposed":
		case "turn_admission_setup_failed":
		case "preflight_unexpected":
			return value;
		default:
			return "preflight_unexpected";
	}
}

function cancelledAdmissionReason(
	value: WorkModeOperationFailureCode | null,
): "turn_admission_cancelled" | "turn_admission_handoff_cancelled" | "turn_admission_disposed" {
	switch (value) {
		case "turn_admission_handoff_cancelled":
		case "turn_admission_disposed":
		case "turn_admission_cancelled":
			return value;
		default:
			return "turn_admission_cancelled";
	}
}

function rejectedAdmissionReason(
	value: WorkModeOperationFailureCode | null,
): "turn_admission_setup_failed" | "preflight_unexpected" {
	return value === "preflight_unexpected" ? value : "turn_admission_setup_failed";
}

function eventForCase(
	caseId: WorkModeExecutionCaseId,
	mode: CuratedWorkMode,
	reasonOverride?: WorkModeOperationFailureCode,
): Exclude<WorkModeOperationEvent, { phase: "preview" }> {
	const candidate = getWorkModeExecutionCase(caseId);
	const acceptedFingerprint = previewFingerprint(mode, candidate.readiness === "degraded" ? "degraded" : "ready");
	const changedFingerprint = candidate.relation === "changed" ? previewFingerprint(mode, "drifted") : undefined;
	const reason =
		reasonOverride ?? candidate.legalReasons[0] ?? (candidate.state === "drifted" ? "preview_drift" : null);
	const observedFingerprint = candidate.shape === "pre_gate" ? undefined : (changedFingerprint ?? acceptedFingerprint);
	const relation =
		observedFingerprint === undefined
			? relateWorkModeFingerprints(acceptedFingerprint, undefined, preGateReason(reason))
			: relateWorkModeFingerprints(acceptedFingerprint, observedFingerprint);
	const roleReadiness = roleReadinessFor(candidate);
	const durable = durableFor(candidate, reason);
	const runtime = runtimeFor(candidate, reason);
	const receipt: WorkModeOperationReceipt = {
		schema: "work-mode-receipt.v1",
		version: 1,
		receiptId: `receipt-${caseId.replaceAll(/[^A-Za-z0-9]+/gu, "-")}`,
		operationId: `operation-${caseId.replaceAll(/[^A-Za-z0-9]+/gu, "-")}`,
		phase: candidate.phase,
		scope:
			candidate.phase === "persistent_apply"
				? "project"
				: candidate.phase === "turn_finalize" || candidate.phase.startsWith("turn_")
					? "turn"
					: "session",
		acceptedFingerprint,
		...(observedFingerprint ? { observedFingerprint } : {}),
		relation,
		roleReadiness,
		confirmation: { required: candidate.readiness === "degraded", accepted: candidate.readiness === "degraded" },
		durable,
		runtime,
		reason,
		timing: { startedAt: 1_700_000_000_000, finishedAt: 1_700_000_000_001 },
		facts: { caseId, state: candidate.state },
	};
	const commonEvent = <D extends WorkModeExecutionCase>(narrowed: D): ShowcaseEventCommon<D> =>
		commonEventFields(narrowed, acceptedFingerprint, relation, roleReadiness, durable, runtime, receipt);
	switch (candidate.caseId) {
		case "session_apply.ready":
			return {
				...commonEvent(candidate),
				observedFingerprint: acceptedFingerprint,
				appliedFingerprint: acceptedFingerprint,
			} satisfies WorkModeExecutionCaseMap["session_apply.ready"];
		case "session_apply.degraded":
			return {
				...commonEvent(candidate),
				observedFingerprint: acceptedFingerprint,
				appliedFingerprint: acceptedFingerprint,
			} satisfies WorkModeExecutionCaseMap["session_apply.degraded"];
		case "session_apply.unavailable":
			return {
				...commonEvent(candidate),
				observedFingerprint: acceptedFingerprint,
			} satisfies WorkModeExecutionCaseMap["session_apply.unavailable"];
		case "session_apply.drifted":
			if (relation.kind !== "changed") throw new Error("Work Mode showcase drift relation is unavailable.");
			return {
				...commonEvent(candidate),
				observedFingerprint: relation.observed,
				reason: "preview_drift",
				changedFacts: relation.changedFacts,
				rePreview: previewResult(mode, "ready"),
			} satisfies WorkModeExecutionCaseMap["session_apply.drifted"];
		case "persistent_apply.ready.committed":
			return {
				...commonEvent(candidate),
				observedFingerprint: acceptedFingerprint,
				committedFingerprint: acceptedFingerprint,
			} satisfies WorkModeExecutionCaseMap["persistent_apply.ready.committed"];
		case "persistent_apply.ready.committed_unconfirmed":
			return {
				...commonEvent(candidate),
				observedFingerprint: acceptedFingerprint,
				committedFingerprint: acceptedFingerprint,
			} satisfies WorkModeExecutionCaseMap["persistent_apply.ready.committed_unconfirmed"];
		case "persistent_apply.degraded.committed":
			return {
				...commonEvent(candidate),
				observedFingerprint: acceptedFingerprint,
				committedFingerprint: acceptedFingerprint,
			} satisfies WorkModeExecutionCaseMap["persistent_apply.degraded.committed"];
		case "persistent_apply.degraded.committed_unconfirmed":
			return {
				...commonEvent(candidate),
				observedFingerprint: acceptedFingerprint,
				committedFingerprint: acceptedFingerprint,
			} satisfies WorkModeExecutionCaseMap["persistent_apply.degraded.committed_unconfirmed"];
		case "persistent_apply.unavailable.prewrite":
			return {
				...commonEvent(candidate),
				observedFingerprint: acceptedFingerprint,
			} satisfies WorkModeExecutionCaseMap["persistent_apply.unavailable.prewrite"];
		case "persistent_apply.unavailable.mutation":
			return {
				...commonEvent(candidate),
				observedFingerprint: acceptedFingerprint,
			} satisfies WorkModeExecutionCaseMap["persistent_apply.unavailable.mutation"];
		case "persistent_apply.drifted":
			if (relation.kind !== "changed") throw new Error("Work Mode showcase drift relation is unavailable.");
			return {
				...commonEvent(candidate),
				observedFingerprint: relation.observed,
				reason: "preview_drift",
				changedFacts: relation.changedFacts,
				rePreview: previewResult(mode, "ready"),
			} satisfies WorkModeExecutionCaseMap["persistent_apply.drifted"];
		case "turn_stage.ready":
			return {
				...commonEvent(candidate),
				observedFingerprint: acceptedFingerprint,
				stagedFingerprint: acceptedFingerprint,
			} satisfies WorkModeExecutionCaseMap["turn_stage.ready"];
		case "turn_stage.degraded":
			return {
				...commonEvent(candidate),
				observedFingerprint: acceptedFingerprint,
				stagedFingerprint: acceptedFingerprint,
			} satisfies WorkModeExecutionCaseMap["turn_stage.degraded"];
		case "turn_stage.unavailable":
			return {
				...commonEvent(candidate),
				observedFingerprint: acceptedFingerprint,
			} satisfies WorkModeExecutionCaseMap["turn_stage.unavailable"];
		case "turn_stage.drifted":
			if (relation.kind !== "changed") throw new Error("Work Mode showcase drift relation is unavailable.");
			return {
				...commonEvent(candidate),
				observedFingerprint: relation.observed,
				reason: "preview_drift",
				changedFacts: relation.changedFacts,
				rePreview: previewResult(mode, "ready"),
			} satisfies WorkModeExecutionCaseMap["turn_stage.drifted"];
		case "turn_admission.ready":
			return {
				...commonEvent(candidate),
				observedFingerprint: acceptedFingerprint,
				activationOwner: "admitted_lease",
				stagedFingerprint: acceptedFingerprint,
				admittedFingerprint: acceptedFingerprint,
				turnLeaseId: "turn-lease-showcase",
				admissionReceiptId: receipt.receiptId,
				admissionTokenId: "admission-token-showcase",
				finalizationObligation: "required",
			} satisfies WorkModeExecutionCaseMap["turn_admission.ready"];
		case "turn_admission.degraded":
			return {
				...commonEvent(candidate),
				observedFingerprint: acceptedFingerprint,
				activationOwner: "admitted_lease",
				stagedFingerprint: acceptedFingerprint,
				admittedFingerprint: acceptedFingerprint,
				turnLeaseId: "turn-lease-showcase",
				admissionReceiptId: receipt.receiptId,
				admissionTokenId: "admission-token-showcase",
				finalizationObligation: "required",
			} satisfies WorkModeExecutionCaseMap["turn_admission.degraded"];
		case "turn_admission.unavailable.runtime.activation_failed":
			return {
				...commonEvent(candidate),
				observedFingerprint: acceptedFingerprint,
				activationOwner: "partial_cleanup",
				partialActivationId: "partial-activation-showcase",
				setupCheckpoint: "target_model_mutated",
				admissionTokenId: "admission-token-showcase",
			} satisfies WorkModeExecutionCaseMap["turn_admission.unavailable.runtime.activation_failed"];
		case "turn_admission.unavailable.runtime.rollback_failed":
			return {
				...commonEvent(candidate),
				observedFingerprint: acceptedFingerprint,
				activationOwner: "partial_cleanup",
				partialActivationId: "partial-activation-showcase",
				setupCheckpoint: "setup_verified",
				admissionTokenId: "admission-token-showcase",
			} satisfies WorkModeExecutionCaseMap["turn_admission.unavailable.runtime.rollback_failed"];
		case "turn_admission.unavailable.pre_gate_cancelled":
			return {
				...commonEvent(candidate),
				reason: cancelledAdmissionReason(reason),
				mustRestage: true,
				admissionTokenId: "admission-token-showcase",
			} satisfies WorkModeExecutionCaseMap["turn_admission.unavailable.pre_gate_cancelled"];
		case "turn_admission.unavailable.pre_gate_rejected":
			return {
				...commonEvent(candidate),
				reason: rejectedAdmissionReason(reason),
				mustRestage: true,
				admissionTokenId: "admission-token-showcase",
			} satisfies WorkModeExecutionCaseMap["turn_admission.unavailable.pre_gate_rejected"];
		case "turn_admission.drifted":
			if (relation.kind !== "changed") throw new Error("Work Mode showcase drift relation is unavailable.");
			return {
				...commonEvent(candidate),
				observedFingerprint: relation.observed,
				reason: "preview_drift",
				changedFacts: relation.changedFacts,
				rePreview: previewResult(mode, "ready"),
			} satisfies WorkModeExecutionCaseMap["turn_admission.drifted"];
		case "turn_finalize.ready":
			return {
				...commonEvent(candidate),
				observedFingerprint: acceptedFingerprint,
				activationOwner: "admitted_lease",
				admissionReceiptId: receipt.receiptId,
				turnLeaseId: "turn-lease-showcase",
				admittedFingerprint: acceptedFingerprint,
				finalReason: "completed",
				finalizationReceiptId: `finalization-${caseId}`,
			} satisfies WorkModeTurnFinalizeCaseMap["turn_finalize.ready"];
		case "turn_finalize.degraded":
			return {
				...commonEvent(candidate),
				observedFingerprint: acceptedFingerprint,
				activationOwner: "admitted_lease",
				admissionReceiptId: receipt.receiptId,
				turnLeaseId: "turn-lease-showcase",
				admittedFingerprint: acceptedFingerprint,
				finalReason: "completed",
				finalizationReceiptId: `finalization-${caseId}`,
			} satisfies WorkModeTurnFinalizeCaseMap["turn_finalize.degraded"];
		case "turn_finalize.unavailable.restore_failed":
			return {
				...commonEvent(candidate),
				observedFingerprint: acceptedFingerprint,
				activationOwner: "admitted_lease",
				admissionReceiptId: receipt.receiptId,
				turnLeaseId: "turn-lease-showcase",
				admittedFingerprint: acceptedFingerprint,
				finalReason: "error",
				finalizationReceiptId: `finalization-${caseId}`,
			} satisfies WorkModeTurnFinalizeCaseMap["turn_finalize.unavailable.restore_failed"];
	}
	throw new Error("Unknown Work Mode showcase execution case.");
}

function caseStateLines(stateId: string, columns: number): readonly string[] {
	const mode = CURATED_WORK_MODES[0];
	if (!mode) throw new Error("Work Mode catalog is empty.");
	if (stateId === "catalog" || stateId === "selector" || stateId === "catalog-unavailable") {
		const cards =
			stateId === "catalog-unavailable"
				? createWorkModeSelectorCards({
						unavailableModeIds: new Set(CURATED_WORK_MODES.map(item => item.id)),
						unavailableReasons: new Map(CURATED_WORK_MODES.map(item => [item.id, "Unavailable"])),
					})
				: createWorkModeSelectorCards();
		return cards.map(card => `${card.disabled ? "[disabled] " : ""}${card.label} — ${card.taskContext}`);
	}
	if (stateId.startsWith("preview-")) {
		const variant =
			stateId === "preview-degraded" ? "degraded" : stateId === "preview-unavailable" ? "unavailable" : "ready";
		return renderWorkModePreviewLines(createWorkModePreviewView(mode.id, previewResult(mode, variant)), columns);
	}
	if (stateId.startsWith("scope-")) {
		const selectedScope = stateId.slice("scope-".length) as WorkModeScope;
		return renderWorkModeScopeLines(createWorkModeScopeSelectionView({ selectedScope }), columns);
	}
	if (stateId === "pending") return [createPendingWorkModeStatusView(mode.id).detail];
	if (stateId === "confirmation")
		return renderWorkModePreviewLines(createWorkModePreviewView(mode.id, previewResult(mode, "degraded")), columns);
	if (stateId === "custom-qualification") {
		const event = eventForCase("session_apply.ready", mode);
		const view = createWorkModeStatusView(event, {
			currentProfileId: "custom-profile",
			currentFingerprint: event.receipt.acceptedFingerprint,
			currentPhase: "session_apply",
		});
		return renderWorkModeStatusLines(view, columns);
	}
	if (stateId === "palette")
		return createWorkModePaletteEntries().map(entry => `${entry.label}: ${entry.description}`);
	if (stateId === "status") {
		const event = eventForCase("persistent_apply.ready.committed", mode);
		return renderWorkModeStatusLines(
			createWorkModeStatusView(event, {
				currentProfileId: mode.profileId,
				currentFingerprint: event.receipt.acceptedFingerprint,
				currentPhase: "persistent_apply",
			}),
			columns,
		);
	}
	if (stateId === "explain")
		return renderWorkModeExplainLines(createWorkModePreviewView(mode.id, previewResult(mode, "ready")), columns);
	if (stateId === "receipt") {
		const event = eventForCase("persistent_apply.ready.committed", mode);
		const receipt = createWorkModeReceiptView(event);
		return [
			`Receipt: ${receipt.receiptId}`,
			`Operation: ${receipt.operationId}`,
			`Phase: ${receipt.phase}`,
			`Durability: ${receipt.durable.kind}`,
		];
	}
	if (stateId === "recovery")
		return renderWorkModePreviewLines(
			createWorkModePreviewView(mode.id, previewResult(mode, "unavailable")),
			columns,
		);
	const stateCase: Readonly<
		Record<string, readonly [WorkModeExecutionCaseId, WorkModeOperationFailureCode | undefined]>
	> = {
		drift: ["persistent_apply.drifted", "preview_drift"],
		conflict: ["persistent_apply.unavailable.mutation", "scope_conflict"],
		locked: ["persistent_apply.unavailable.mutation", "scope_locked"],
		rejected: ["persistent_apply.unavailable.mutation", "scope_rejected"],
		"write-failure": ["persistent_apply.unavailable.mutation", "persistent_write_failed"],
		"committed-unconfirmed": ["persistent_apply.ready.committed_unconfirmed", "persistent_reload_unconfirmed"],
		"partial-activation": ["turn_admission.unavailable.runtime.activation_failed", "turn_activation_failed"],
		"partial-rollback": ["turn_admission.unavailable.runtime.rollback_failed", "turn_rollback_failed"],
		"pre-gate-settlement": ["turn_admission.unavailable.pre_gate_cancelled", "turn_admission_cancelled"],
		"admitted-success": ["turn_admission.ready", undefined],
		"admitted-failure": ["turn_admission.unavailable.pre_gate_rejected", "turn_admission_setup_failed"],
		"finalization-success": ["turn_finalize.ready", undefined],
		"finalization-failure": ["turn_finalize.unavailable.restore_failed", "turn_rollback_failed"],
	};
	const selected = stateCase[stateId];
	if (selected) {
		const event = eventForCase(selected[0], mode, selected[1]);
		const view = createWorkModeStatusView(event, {
			currentProfileId: mode.profileId,
			currentFingerprint: event.receipt.observedFingerprint ?? event.receipt.acceptedFingerprint,
			currentPhase: event.phase,
		});
		return renderWorkModeStatusLines(view, columns);
	}
	throw new Error("Unknown Work Mode showcase state.");
}

function supplementalLines(id: SupplementalId, columns: number): readonly string[] {
	const mode = CURATED_WORK_MODES[0];
	if (!mode) throw new Error("Work Mode catalog is empty.");
	switch (id) {
		case "no-color":
		case "no-color-wide":
			return renderWorkModePreviewLines(createWorkModePreviewView(mode.id, previewResult(mode, "ready")), columns);
		case "cjk":
		case "cjk-wide": {
			const scope = createWorkModeScopeSelectionView({ selectedScope: "project" });
			const choices: readonly WorkModeScopeChoiceView[] = scope.choices.map(choice => ({
				...choice,
				label: `${choice.label} · 界面 日本語`,
			}));
			return renderWorkModeScopeLines({ choices, selectedScope: scope.selectedScope }, columns);
		}
		case "focus":
		case "focus-narrow":
			return [
				...renderWorkModeStatusLines(
					createWorkModeStatusView(eventForCase("session_apply.ready", mode), {
						currentProfileId: mode.profileId,
						currentFingerprint: previewFingerprint(mode, "ready"),
						currentPhase: "session_apply",
					}),
					columns,
				),
				"Focus target: ModelSelectorComponent",
			];
		case "scroll":
		case "scroll-wide":
			return [
				...renderWorkModePreviewLines(createWorkModePreviewView(mode.id, previewResult(mode, "ready")), columns),
				"Scroll input exercised: ArrowDown",
			];
		case "keyboard":
			return [
				...createWorkModePaletteEntries().map(entry => `${entry.label}: ${entry.description}`),
				"Keyboard input exercised: Enter",
			];
		case "mouse":
			return renderWorkModeScopeLines(createWorkModeScopeSelectionView({ selectedScope: "turn" }), columns);
		case "disposal":
			return ["Disposal action exercised: selector.dispose", "Recovery: Restore Work Mode runtime"];
		case "color-blind-deuteranopia":
		case "color-blind-protanopia":
		case "color-blind-tritanopia":
			return [
				"Color-blind mode enabled",
				...renderWorkModeStatusLines(
					createWorkModeStatusView(eventForCase("persistent_apply.ready.committed", mode), {
						currentProfileId: mode.profileId,
						currentFingerprint: previewFingerprint(mode, "ready"),
						currentPhase: "persistent_apply",
					}),
					columns,
				),
			];
	}
}

function flagsFor(stateId: string, supplemental: boolean): CaptureEntryFlags {
	const colorBlindDisposition = stateId.includes("deuteranopia")
		? "deuteranopia"
		: stateId.includes("protanopia")
			? "protanopia"
			: stateId.includes("tritanopia")
				? "tritanopia"
				: "none";
	return Object.freeze({
		noColor: stateId === "no-color" || stateId === "no-color-wide",
		cjk: stateId === "cjk" || stateId === "cjk-wide",
		focus: stateId === "focus" || stateId === "focus-narrow",
		scroll: stateId === "scroll" || stateId === "scroll-wide",
		keyboard: stateId === "keyboard",
		mouse: stateId === "mouse",
		disposal: stateId === "disposal",
		colorBlindDisposition,
		...(supplemental ? {} : {}),
	});
}

function viewportForSupplemental(id: SupplementalId): Viewport {
	if (id === "no-color" || id === "cjk" || id === "focus-narrow") return VIEWPORTS[0];
	if (id === "no-color-wide" || id === "cjk-wide" || id === "scroll-wide") return VIEWPORTS[2];
	return VIEWPORTS[1];
}

function supplementalIdFor(value: string): SupplementalId {
	switch (value) {
		case "no-color":
		case "cjk":
		case "focus":
		case "scroll":
		case "keyboard":
		case "mouse":
		case "disposal":
		case "color-blind-deuteranopia":
		case "color-blind-protanopia":
		case "color-blind-tritanopia":
		case "no-color-wide":
		case "cjk-wide":
		case "focus-narrow":
		case "scroll-wide":
			return value;
		default:
			throw new Error("Unknown Work Mode supplemental state.");
	}
}
export const WORK_MODE_VISUAL_KEYS = Object.freeze([
	...WORK_MODE_BASE_STATE_IDS.flatMap(stateId => VIEWPORTS.map(viewport => `${stateId}/${viewport.id}`)),
	...WORK_MODE_SUPPLEMENTAL_IDS.map(id => `${id}/${viewportForSupplemental(id).id}`),
]);

if (
	WORK_MODE_BASE_STATE_IDS.length !== 31 ||
	WORK_MODE_SUPPLEMENTAL_IDS.length !== 14 ||
	WORK_MODE_VISUAL_KEYS.length !== WORK_MODE_VISUAL_CAPTURE_COUNT
) {
	throw new Error("Work Mode visual capture matrix must contain exactly 107 keys.");
}

function colorBlindFor(stateId: string): boolean {
	return (
		stateId === "color-blind-deuteranopia" ||
		stateId === "color-blind-protanopia" ||
		stateId === "color-blind-tritanopia"
	);
}

type ProductionCaptureHarness = Readonly<{
	selector: ModelSelectorComponent;
	tui: TUI;
	terminal: VirtualTerminal;
	dispose: () => void;
}>;

type RenderedEntry = Readonly<{
	plain: string[];
	ansi: string[];
	flags: CaptureEntryFlags;
	semanticStateId: string;
	semanticDetailHash: string;
	renderTrace: WorkModeVisualRenderTrace;
	renderTraceHash: string;
	actions: readonly string[];
}>;

function adapterVariantFor(stateId: string): "ready" | "degraded" | "unavailable" {
	if (stateId.includes("degraded") || stateId === "confirmation") return "degraded";
	if (stateId.includes("unavailable") || stateId === "recovery") return "unavailable";
	return "ready";
}

function createWorkModeAdapter(stateId: string): ModelSelectorWorkModeAdapter {
	const unavailable = stateId === "catalog-unavailable";
	const cards = unavailable
		? createWorkModeSelectorCards({
				unavailableModeIds: new Set(CURATED_WORK_MODES.map(mode => mode.id)),
				unavailableReasons: new Map(CURATED_WORK_MODES.map(mode => [mode.id, "Unavailable"])),
			})
		: createWorkModeSelectorCards();
	return {
		cards,
		preview: async modeId => {
			const mode = CURATED_WORK_MODES.find(candidate => candidate.id === modeId);
			if (!mode) throw new Error("Work Mode adapter mode is unavailable.");
			const variant = adapterVariantFor(stateId);
			const result = previewResult(mode, variant);
			return { result, view: createWorkModePreviewView(mode.id, result) };
		},
		apply: async (modeId, _scope, _preview) => {
			const mode = CURATED_WORK_MODES.find(candidate => candidate.id === modeId);
			if (!mode) throw new Error("Work Mode adapter mode is unavailable.");
			return eventForCase(stateId.includes("degraded") ? "turn_stage.degraded" : "turn_stage.ready", mode);
		},
	};
}

async function createProductionCaptureHarness(
	viewport: Viewport,
	adapter: ModelSelectorWorkModeAdapter,
	initialWorkModeId: string | undefined,
	colorBlind: boolean,
): Promise<ProductionCaptureHarness> {
	const installedTheme = await getThemeByName(WORK_MODE_CAPTURE_THEME);
	if (!installedTheme) throw new Error("Work Mode showcase theme is unavailable.");
	setThemeInstance(installedTheme);
	if (colorBlind) await setColorBlindMode(true);
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("openai-codex", "work-mode-showcase-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const currentModel = modelRegistry.getAll().find(model => model.provider === "openai-codex");
	if (!currentModel) {
		authStorage.close();
		throw new Error("Work Mode showcase model fixture is unavailable.");
	}
	const settings = Settings.isolated({ "compaction.enabled": false, "todo.reminders": false });
	const terminal = new VirtualTerminal(viewport.columns, viewport.rows, { isProcessTerminal: true });
	const tui = new TUI(terminal, false, { widthSettleMs: 0 });
	const selector = new ModelSelectorComponent(
		tui,
		currentModel,
		settings,
		modelRegistry,
		[],
		(_selection: ModelSelectorSelection) => {},
		() => {},
		{
			workModeAdapter: adapter,
			...(initialWorkModeId === undefined ? {} : { initialWorkModeId }),
		},
	);
	tui.addChild(selector);
	tui.setFocus(selector);
	tui.start();
	await terminal.waitForRender();
	await Bun.sleep(0);
	await terminal.waitForRender();
	let selectorDisposed = false;
	let tuiStopped = false;
	let authClosed = false;
	return {
		selector,
		tui,
		terminal,
		dispose: () => {
			if (!selectorDisposed) {
				selector.dispose();
				selectorDisposed = true;
			}
			if (!tuiStopped) {
				tui.stop();
				tuiStopped = true;
			}
			if (!authClosed) {
				authStorage.close();
				authClosed = true;
			}
		},
	};
}

async function settleProductionInput(harness: ProductionCaptureHarness): Promise<void> {
	await Promise.resolve();
	await Bun.sleep(0);
	await harness.terminal.waitForRender();
}

async function driveProductionInteractions(
	harness: ProductionCaptureHarness,
	stateId: string,
	supplemental: boolean,
): Promise<string[]> {
	const actions: string[] = [];
	const shouldPreview = stateId !== "catalog" && stateId !== "selector" && stateId !== "catalog-unavailable";
	if (shouldPreview) {
		harness.selector.handleInput("\n");
		actions.push("preview:Enter");
		await settleProductionInput(harness);
	}
	if (stateId.startsWith("scope-")) {
		const scope = stateId.slice("scope-".length);
		const steps = scope === "turn" ? 0 : scope === "session" ? 1 : scope === "project" ? 2 : 3;
		for (let index = 0; index < steps; index += 1) {
			harness.selector.handleInput("\x1b[B");
		}
		actions.push(`scope:${scope}`);
		await settleProductionInput(harness);
	}
	if (stateId === "focus" || stateId === "focus-narrow") {
		harness.tui.setFocus(harness.selector);
		actions.push("focus:ModelSelectorComponent");
	}
	if (stateId === "scroll" || stateId === "scroll-wide") {
		harness.selector.handleInput("\x1b[B");
		harness.selector.handleInput("\x1b[B");
		actions.push("scroll:ArrowDown×2");
		await settleProductionInput(harness);
	}
	if (stateId === "keyboard") {
		harness.selector.handleInput("\n");
		actions.push("keyboard:Enter");
		await settleProductionInput(harness);
	}
	if (stateId === "mouse") {
		harness.terminal.sendInput("\x1b[<64;1;1M");
		harness.selector.handleInput("\x1b[B");
		actions.push("mouse:wheel+ArrowDown");
		await settleProductionInput(harness);
	}
	if (supplemental && actions.length === 0) actions.push("render:production");
	return actions;
}

function ansiTokenColorSet(lines: readonly string[]): readonly string[] {
	const tokens = new Set<string>();
	for (const line of lines) {
		for (const match of line.matchAll(/\x1b\[([0-9;]*)m/gu)) tokens.add(match[1] ?? "");
	}
	return [...tokens].sort((left, right) => left.localeCompare(right));
}

async function renderEntry(stateId: string, viewport: Viewport, supplemental: boolean): Promise<RenderedEntry> {
	const flags = flagsFor(stateId, supplemental);
	const colorBlind = colorBlindFor(stateId);
	const mode = CURATED_WORK_MODES[0];
	if (!mode) throw new Error("Work Mode catalog is empty.");
	const adapter = createWorkModeAdapter(stateId);
	let harness: ProductionCaptureHarness | undefined;
	try {
		const activeHarness = await createProductionCaptureHarness(viewport, adapter, mode.id, colorBlind);
		harness = activeHarness;
		const beforeInteraction = activeHarness.selector.render(viewport.columns);
		const beforeInteractionSha256 = hash(beforeInteraction.join("\n"));
		const actions = await driveProductionInteractions(activeHarness, stateId, supplemental);
		const afterInteraction = activeHarness.selector.render(viewport.columns);
		const afterInteractionSha256 = hash(afterInteraction.join("\n"));
		const componentAnsi = [...afterInteraction];
		const ansi = flags.noColor ? componentAnsi.map(line => Bun.stripANSI(line)) : componentAnsi;
		const plain = ansi.map(line => Bun.stripANSI(line));
		const semanticLines = supplemental
			? supplementalLines(supplementalIdFor(stateId), viewport.columns)
			: caseStateLines(stateId, viewport.columns);
		const tokenSet = ansiTokenColorSet(ansi);
		const renderTrace: WorkModeVisualRenderTrace = {
			component: "ModelSelectorComponent",
			theme: WORK_MODE_CAPTURE_THEME,
			colorBlind,
			ansiTokenColorSet: tokenSet,
			ansiTokenColorSetHash: hash(JSON.stringify(tokenSet)),
			beforeInteractionSha256,
			afterInteractionSha256,
			interactionChanged: beforeInteractionSha256 !== afterInteractionSha256,
			sourceToken: colorBlind ? "toolDiffAdded" : null,
			reason: colorBlind ? "settings.colorBlindMode" : null,
		};
		const renderTraceHash = hash(JSON.stringify(renderTrace));
		if (stateId === "disposal") actions.push("disposal:selector.dispose");
		if (stateId === "disposal") activeHarness.dispose();
		return {
			plain,
			ansi,
			flags,
			semanticStateId: stateId,
			semanticDetailHash: hash(semanticLines.join("\n")),
			renderTrace,
			renderTraceHash,
			actions,
		};
	} finally {
		harness?.dispose();
		if (colorBlind) await setColorBlindMode(false);
	}
}

function htmlEscape(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function ansiToHtml(value: string): string {
	let body = "";
	let offset = 0;
	let color = "";
	for (const match of value.matchAll(/\x1b\[([0-9;]*)m/gu)) {
		body += htmlEscape(value.slice(offset, match.index));
		offset = (match.index ?? 0) + match[0].length;
		const code = (match[1] || "0").split(";").map(Number)[0] ?? 0;
		color = code === 0 ? "" : code === 38 ? color : color;
		const rgb = match[1]?.match(/^38;2;(\d+);(\d+);(\d+)$/u);
		if (rgb) color = `color:rgb(${rgb[1]},${rgb[2]},${rgb[3]})`;
		if (code === 0) color = "";
		if (color) body += `<span style="${color}">`;
		else body += "</span>";
	}
	body += htmlEscape(value.slice(offset));
	body = body.replaceAll("</span><span", "</span><span");
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><title>Work Mode showcase</title><style>body{margin:0;background:#110b0b;color:#ffe7dc}pre{margin:0;padding:1em;white-space:pre;font-family:ui-monospace,monospace}</style></head><body><pre>${body}</pre></body></html>\n`;
}

function entryFor(
	stateId: string,
	viewport: Viewport,
	_supplemental: boolean,
	lineStart: number,
	plain: string[],
	ansi: string[],
	flags: CaptureEntryFlags,
	semanticStateId: string,
	semanticDetailHash: string,
	renderTrace: WorkModeVisualRenderTrace,
	renderTraceHash: string,
	actions: readonly string[],
): WorkModeVisualCaptureEntry {
	const key = `${stateId}/${viewport.id}`;
	return Object.freeze({
		key,
		stateId,
		semanticStateId,
		semanticDetailHash,
		viewport,
		flags,
		lineStart,
		lineCount: plain.length,
		plainSha256: hash(plain.join("\n")),
		ansiSha256: hash(ansi.join("\n")),
		productionRender: true,
		renderTrace,
		renderTraceHash,
		actions,
	});
}

export async function captureWorkModeVisualShowcase(
	outputRootInput: string = WORK_MODE_CAPTURE_DEFAULT_OUTPUT,
	options: WorkModeVisualCaptureOptions = {},
): Promise<WorkModeVisualCaptureManifest> {
	const outputRoot = path.resolve(outputRootInput);
	const sourceClosure = await computeWorkModeSourceClosure(options.repoRoot);
	const sourceHash = safeHash(options.sourceHash);
	const captureTimestamp = safeTimestamp(options.timestamp);
	const plainLines: string[] = [];
	const ansiLines: string[] = [];
	const entries: WorkModeVisualCaptureEntry[] = [];
	for (const stateId of WORK_MODE_BASE_STATE_IDS) {
		for (const viewport of VIEWPORTS) {
			const rendered = await renderEntry(stateId, viewport, false);
			const lineStart = plainLines.length;
			plainLines.push(...rendered.plain);
			ansiLines.push(...rendered.ansi);
			entries.push(
				entryFor(
					stateId,
					viewport,
					false,
					lineStart,
					rendered.plain,
					rendered.ansi,
					rendered.flags,
					rendered.semanticStateId,
					rendered.semanticDetailHash,
					rendered.renderTrace,
					rendered.renderTraceHash,
					rendered.actions,
				),
			);
		}
	}
	for (const stateId of WORK_MODE_SUPPLEMENTAL_IDS) {
		const viewport = viewportForSupplemental(stateId);
		const rendered = await renderEntry(stateId, viewport, true);
		const lineStart = plainLines.length;
		plainLines.push(...rendered.plain);
		ansiLines.push(...rendered.ansi);
		entries.push(
			entryFor(
				stateId,
				viewport,
				true,
				lineStart,
				rendered.plain,
				rendered.ansi,
				rendered.flags,
				rendered.semanticStateId,
				rendered.semanticDetailHash,
				rendered.renderTrace,
				rendered.renderTraceHash,
				rendered.actions,
			),
		);
	}
	const terminalText = `${plainLines.join("\n")}\n`;
	const terminalAnsiText = `${ansiLines.join("\n")}\n`;
	const terminalHtml = ansiToHtml(terminalAnsiText);
	const metadata: WorkModeVisualCaptureMetadata = {
		schema: WORK_MODE_VISUAL_CAPTURE_SCHEMA,
		version: WORK_MODE_VISUAL_CAPTURE_VERSION,
		sourceHash,
		sourceClosure,
		captureTimestamp,
		locale: WORK_MODE_CAPTURE_LOCALE,
		timezone: WORK_MODE_CAPTURE_TIMEZONE,
		seed: WORK_MODE_CAPTURE_SEED,
		theme: WORK_MODE_CAPTURE_THEME,
		adapterManifestSha256: WORK_MODE_ADAPTER_MANIFEST_SHA256,
		expectedKeyCount: WORK_MODE_VISUAL_CAPTURE_COUNT,
		keys: WORK_MODE_VISUAL_KEYS,
		entries,
		hashes: {
			"terminal.txt": hash(terminalText),
			"terminal-ansi.txt": hash(terminalAnsiText),
			"terminal.html": hash(terminalHtml),
		},
	};
	const metadataText = json(metadata);
	const files: WorkModeVisualCaptureManifest["files"] = {
		"terminal.txt": { sha256: hash(terminalText), byteLength: Buffer.byteLength(terminalText) },
		"terminal-ansi.txt": { sha256: hash(terminalAnsiText), byteLength: Buffer.byteLength(terminalAnsiText) },
		"terminal.html": { sha256: hash(terminalHtml), byteLength: Buffer.byteLength(terminalHtml) },
		"metadata.json": { sha256: hash(metadataText), byteLength: Buffer.byteLength(metadataText) },
	};
	const manifest: WorkModeVisualCaptureManifest = Object.freeze({
		schema: WORK_MODE_VISUAL_CAPTURE_SCHEMA,
		version: WORK_MODE_VISUAL_CAPTURE_VERSION,
		sourceHash,
		sourceClosure,
		adapterManifestSha256: WORK_MODE_ADAPTER_MANIFEST_SHA256,
		expectedKeyCount: WORK_MODE_VISUAL_CAPTURE_COUNT,
		keys: WORK_MODE_VISUAL_KEYS,
		files,
		entries,
	});
	const finalManifestText = json(manifest);
	await fs.mkdir(outputRoot, { recursive: true });
	await Promise.all([
		Bun.write(path.join(outputRoot, "terminal.txt"), terminalText),
		Bun.write(path.join(outputRoot, "terminal-ansi.txt"), terminalAnsiText),
		Bun.write(path.join(outputRoot, "terminal.html"), terminalHtml),
		Bun.write(path.join(outputRoot, "metadata.json"), metadataText),
		Bun.write(path.join(outputRoot, "manifest.json"), finalManifestText),
	]);
	return manifest;
}

export const captureWorkModeShowcase = captureWorkModeVisualShowcase;

function parseCaptureArgs(args: readonly string[]): {
	outputRoot: string;
	repoRoot: string;
	sourceHash?: string;
	timestamp?: string;
} {
	let outputRoot: string = WORK_MODE_CAPTURE_DEFAULT_OUTPUT;
	let repoRoot: string = WORK_MODE_CAPTURE_DEFAULT_REPO_ROOT;
	let sourceHash: string | undefined;
	let timestamp: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--output" || arg === "--out") outputRoot = args[++index] ?? outputRoot;
		else if (arg === "--repo-root") repoRoot = args[++index] ?? repoRoot;
		else if (arg === "--source-hash") sourceHash = args[++index];
		else if (arg === "--timestamp") timestamp = args[++index];
		else throw new Error("Invalid Work Mode showcase arguments.");
	}
	return { outputRoot, repoRoot, sourceHash, timestamp };
}

if (import.meta.main) {
	const parsed = parseCaptureArgs(process.argv.slice(2));
	const manifest = await captureWorkModeVisualShowcase(parsed.outputRoot, parsed);
	process.stdout.write(`Captured ${manifest.keys.length} Work Mode visual keys.\n`);
}
