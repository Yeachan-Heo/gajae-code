import * as fs from "node:fs/promises";
import * as path from "node:path";
import { visibleWidth } from "@gajae-code/tui";
import { CURATED_EXECUTION_PRESETS } from "../src/config/execution-preset";
import { DEFAULT_TASK_EXECUTION_POLICY, type TaskExecutionPolicy } from "../src/task/execution-policy";
import {
	ansiToHtml,
	EXECUTION_PRESET_CAPTURE_DEFAULT_OUTPUT,
	EXECUTION_PRESET_CAPTURE_DEFAULT_REPO_ROOT,
	EXECUTION_PRESET_CAPTURE_LOCALE,
	EXECUTION_PRESET_CAPTURE_SEED,
	EXECUTION_PRESET_CAPTURE_THEME,
	EXECUTION_PRESET_CAPTURE_TIMESTAMP,
	EXECUTION_PRESET_CAPTURE_TIMEZONE,
	EXECUTION_PRESET_SOURCE_CLOSURE_FILES,
	EXECUTION_PRESET_VISUAL_CAPTURE_COUNT,
	EXECUTION_PRESET_VISUAL_CAPTURE_SCHEMA,
	EXECUTION_PRESET_VISUAL_CAPTURE_VERSION,
} from "./capture-execution-preset-showcase";

export type VerifyExecutionPresetShowcaseOptions = Readonly<{
	repoRoot?: string;
	sourceHash?: string;
}>;

export type VerifyExecutionPresetShowcaseSummary = Readonly<{
	keyCount: number;
	sourceHash: string;
	sourceClosureSha256: string;
}>;

const EXPECTED_KEY_COUNT = 48;
const EXPECTED_VIEWPORTS = Object.freeze([
	Object.freeze({ id: "80x24", columns: 80, rows: 24 }),
	Object.freeze({ id: "120x36", columns: 120, rows: 36 }),
	Object.freeze({ id: "160x48", columns: 160, rows: 48 }),
]);
const EXPECTED_STATE_IDS = Object.freeze([
	"list-session",
	"list-project",
	"list-user",
	"preview-secure",
	"preview-fast",
	"preview-isolated",
	"scope-cycle",
	"apply-session",
	"apply-project-committed",
	"apply-user-degraded",
	"apply-conflict",
	"stale-preview",
	"custom-cjk",
	"custom-redacted",
	"delete-confirm",
	"no-color-disposed",
]);

/** Independent verifier oracle. Never derive this matrix from the producer. */
export const EXECUTION_PRESET_EXPECTED_VISUAL_KEYS = Object.freeze([
	"list-session/80x24",
	"list-session/120x36",
	"list-session/160x48",
	"list-project/80x24",
	"list-project/120x36",
	"list-project/160x48",
	"list-user/80x24",
	"list-user/120x36",
	"list-user/160x48",
	"preview-secure/80x24",
	"preview-secure/120x36",
	"preview-secure/160x48",
	"preview-fast/80x24",
	"preview-fast/120x36",
	"preview-fast/160x48",
	"preview-isolated/80x24",
	"preview-isolated/120x36",
	"preview-isolated/160x48",
	"scope-cycle/80x24",
	"scope-cycle/120x36",
	"scope-cycle/160x48",
	"apply-session/80x24",
	"apply-session/120x36",
	"apply-session/160x48",
	"apply-project-committed/80x24",
	"apply-project-committed/120x36",
	"apply-project-committed/160x48",
	"apply-user-degraded/80x24",
	"apply-user-degraded/120x36",
	"apply-user-degraded/160x48",
	"apply-conflict/80x24",
	"apply-conflict/120x36",
	"apply-conflict/160x48",
	"stale-preview/80x24",
	"stale-preview/120x36",
	"stale-preview/160x48",
	"custom-cjk/80x24",
	"custom-cjk/120x36",
	"custom-cjk/160x48",
	"custom-redacted/80x24",
	"custom-redacted/120x36",
	"custom-redacted/160x48",
	"delete-confirm/80x24",
	"delete-confirm/120x36",
	"delete-confirm/160x48",
	"no-color-disposed/80x24",
	"no-color-disposed/120x36",
	"no-color-disposed/160x48",
]);

const EXPECTED_CAPTURE_FILES = Object.freeze([
	"terminal.txt",
	"terminal-ansi.txt",
	"terminal.html",
	"metadata.json",
	"manifest.json",
]);
const EXPECTED_MANIFEST_FILES = Object.freeze(["terminal.txt", "terminal-ansi.txt", "terminal.html", "metadata.json"]);

const ANSI_SGR = /\x1b\[[0-9;]*m/gu;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u001b]/u;
const UNSAFE_URL = /\b(?:https?|file|ftp):\/\/\S+/iu;
const UNSAFE_LOCATOR =
	/(?:^|[\s=:(])(?:~\/|\.{1,2}\/|\/(?:Users|home|private|tmp|var|etc|opt|Volumes|mnt|workspace)(?:\/|$)|[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])/iu;
const UNSAFE_CREDENTIAL_ASSIGNMENT =
	/\b(?:api[_ -]?key|authorization|credential|password|secret|token)\s*[:=]\s*(?!<redacted>(?=$|[\s,;]))[^\s,;]+/iu;
const UNSAFE_CREDENTIAL_ASSIGNMENT_WITH_TRUNCATED_REDACTION =
	/\b(?:api[_ -]?key|authorization|credential|password|secret|token)\s*[:=]\s*(?!(?:<redacted>(?=$|[\s,;])|<(?:r|re|red|reda|redac|redact|redacte|redacted)(?=$)))[^\s,;]+/imu;
const UNSAFE_CREDENTIAL_QUERY =
	/[?&](?:api[_-]?key|authorization|credential|password|secret|token)=(?!<redacted>(?=$|[&\s]))[^&\s]+/iu;
const UNSAFE_BEARER = /\bbearer\s+(?!<redacted>(?=$|[\s,;]))\S+/iu;
const UNSAFE_SECRET_PREFIX = /\b(?:sk|pk|ghp|xox[baprs])[-_A-Za-z0-9]+/iu;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_SOURCE_HASH = /^[A-Za-z0-9._:-]{1,128}$/u;

const METADATA_KEYS = Object.freeze([
	"schema",
	"version",
	"sourceHash",
	"captureTimestamp",
	"locale",
	"timezone",
	"seed",
	"theme",
	"hostMatrix",
	"fontRenderingAssumptions",
	"wrappingPolicy",
	"ansiControlSemantics",
	"sourceClosure",
	"expectedKeyCount",
	"keys",
	"entries",
	"hashes",
]);
const MANIFEST_KEYS = Object.freeze([
	"schema",
	"version",
	"sourceHash",
	"sourceClosure",
	"expectedKeyCount",
	"keys",
	"files",
	"entries",
]);
const ENTRY_KEYS = Object.freeze([
	"key",
	"stateId",
	"semanticStateId",
	"semanticStatus",
	"semanticRows",
	"semanticDetailHash",
	"viewport",
	"flags",
	"lineStart",
	"lineCount",
	"lineWidths",
	"plainSha256",
	"ansiSha256",
	"productionRender",
	"component",
	"theme",
	"renderTrace",
	"renderTraceHash",
	"receipt",
	"actions",
]);
const FLAGS_KEYS = Object.freeze(["noColor", "cjk", "redacted", "disposal"]);
const TRACE_KEYS = Object.freeze([
	"component",
	"theme",
	"productionRender",
	"noColorDisposition",
	"beforeInteractionSha256",
	"afterInteractionSha256",
	"interactionChanged",
	"beforeDisposalSha256",
	"callbackCountBeforeDisposal",
	"callbackCountAfterDisposal",
	"statusCountBeforeDisposal",
	"statusCountAfterDisposal",
	"requestRenderCountBeforeDisposal",
	"requestRenderCountAfterDisposal",
	"disposition",
	"postDisposalSha256",
	"postDisposalChanged",
	"controllerRevision",
	"controllerFingerprint",
	"receiptSemanticHash",
]);
const RECEIPT_KEYS = Object.freeze([
	"status",
	"reason",
	"timing",
	"durability",
	"mutationStatus",
	"mutationReason",
	"mutationDurability",
	"controllerRevision",
	"controllerFingerprint",
]);

const hash = (value: string | Uint8Array): string => new Bun.CryptoHasher("sha256").update(value).digest("hex");

function fail(message: string): never {
	throw new Error(`Execution preset showcase verification failed: ${message}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function list(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) fail(`${label} must be an array`);
	return value;
}

function text(value: unknown, label: string): string {
	if (typeof value !== "string") fail(`${label} must be a string`);
	return value;
}

function bool(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") fail(`${label} must be a boolean`);
	return value;
}

function integer(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
		fail(`${label} must be a non-negative integer`);
	return value;
}

function nullableInteger(value: unknown, label: string): number | null {
	if (value === null) return null;
	return integer(value, label);
}

function digest(value: unknown, label: string): string {
	const result = text(value, label);
	if (!SHA256.test(result)) fail(`${label} is not a SHA-256 digest`);
	return result;
}

function json(value: string, label: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		fail(`${label} is not valid JSON`);
	}
}

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
	const actual = Object.keys(value);
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		fail(`${label} has unexpected fields or field order`);
	}
}

function checkSafeText(label: string, value: string): void {
	if (UNSAFE_CONTROL.test(value)) fail(`${label} contains terminal control bytes`);
	if (UNSAFE_URL.test(value)) fail(`${label} contains a URL`);
	if (UNSAFE_LOCATOR.test(value)) fail(`${label} contains a path or locator`);
	const credentialAssignment =
		label === "terminal.txt" || label.endsWith(".frame")
			? UNSAFE_CREDENTIAL_ASSIGNMENT_WITH_TRUNCATED_REDACTION
			: UNSAFE_CREDENTIAL_ASSIGNMENT;
	if (credentialAssignment.test(value)) fail(`${label} contains an unredacted credential assignment`);
	if (UNSAFE_CREDENTIAL_QUERY.test(value)) fail(`${label} contains an unredacted credential query`);
	if (UNSAFE_BEARER.test(value)) fail(`${label} contains an unredacted Bearer token`);
	if (UNSAFE_SECRET_PREFIX.test(value)) fail(`${label} contains a secret-prefix token`);
}

function exactKeys(actual: readonly string[], label: string): void {
	if (
		actual.length !== EXPECTED_KEY_COUNT ||
		new Set(actual).size !== actual.length ||
		actual.some((key, index) => key !== EXECUTION_PRESET_EXPECTED_VISUAL_KEYS[index])
	) {
		fail(`${label} does not contain the exact ordered literal 48-key matrix`);
	}
}

function readSourceClosure(value: unknown, label: string): { files: readonly string[]; sha256: string } {
	const closure = record(value, label);
	exactObjectKeys(closure, ["files", "sha256"], label);
	const files = list(closure.files, `${label}.files`).map((entry, index) => text(entry, `${label}.files[${index}]`));
	if (
		files.length !== EXECUTION_PRESET_SOURCE_CLOSURE_FILES.length ||
		files.some((file, index) => file !== EXECUTION_PRESET_SOURCE_CLOSURE_FILES[index])
	) {
		fail(`${label}.files does not match the exact production source closure order`);
	}
	return { files, sha256: digest(closure.sha256, `${label}.sha256`) };
}

async function recomputeSourceClosure(repoRootInput: string): Promise<{ files: readonly string[]; sha256: string }> {
	const repoRoot = path.resolve(repoRootInput);
	const hasher = new Bun.CryptoHasher("sha256");
	for (const relativePath of EXECUTION_PRESET_SOURCE_CLOSURE_FILES) {
		hasher.update(relativePath);
		hasher.update("\0");
		try {
			hasher.update(await fs.readFile(path.join(repoRoot, relativePath)));
		} catch {
			fail(`source closure file is unavailable: ${relativePath}`);
		}
	}
	return { files: EXECUTION_PRESET_SOURCE_CLOSURE_FILES, sha256: hasher.digest("hex") };
}

type Viewport = (typeof EXPECTED_VIEWPORTS)[number];
type StateId = (typeof EXPECTED_STATE_IDS)[number];
type Flags = Readonly<{ noColor: boolean; cjk: boolean; redacted: boolean; disposal: boolean }>;
type ReceiptStatus = "applied" | "committed" | "degraded" | "rejected" | "conflict" | "locked" | "deleted";
type MutationStatus = ReceiptStatus;
type Timing = "current_runtime" | "next_session";
type Durability = "none" | "committed" | "committed_unconfirmed";
type Receipt = Readonly<{
	status: ReceiptStatus | null;
	reason: string | null;
	timing: Timing | null;
	durability: Durability | null;
	mutationStatus: MutationStatus | null;
	mutationReason: string | null;
	mutationDurability: Durability | null;
	controllerRevision: number;
	controllerFingerprint: string;
}>;
type RenderTrace = Readonly<{
	component: "ExecutionPresetSelectorComponent";
	theme: typeof EXECUTION_PRESET_CAPTURE_THEME;
	productionRender: true;
	noColorDisposition: "ansi_stripped" | "native_color";
	beforeInteractionSha256: string;
	afterInteractionSha256: string;
	interactionChanged: boolean;
	beforeDisposalSha256: string | null;
	callbackCountBeforeDisposal: number | null;
	callbackCountAfterDisposal: number | null;
	statusCountBeforeDisposal: number | null;
	statusCountAfterDisposal: number | null;
	requestRenderCountBeforeDisposal: number | null;
	requestRenderCountAfterDisposal: number | null;
	disposition: "none" | "late_apply_cancelled";
	postDisposalSha256: string | null;
	postDisposalChanged: boolean;
	controllerRevision: number;
	controllerFingerprint: string;
	receiptSemanticHash: string;
}>;
type Entry = Readonly<{
	key: string;
	stateId: StateId;
	semanticStateId: StateId;
	semanticStatus: string;
	semanticRows: readonly string[];
	semanticDetailHash: string;
	viewport: Viewport;
	flags: Flags;
	lineStart: number;
	lineCount: number;
	lineWidths: readonly number[];
	plainSha256: string;
	ansiSha256: string;
	productionRender: true;
	component: "ExecutionPresetSelectorComponent";
	theme: typeof EXECUTION_PRESET_CAPTURE_THEME;
	renderTrace: RenderTrace;
	renderTraceHash: string;
	receipt: Receipt;
	actions: readonly string[];
}>;

type FileData = Readonly<{ bytes: Uint8Array; text: string }>;

function readViewport(value: unknown, label: string): Viewport {
	const viewport = record(value, label);
	exactObjectKeys(viewport, ["id", "columns", "rows"], label);
	const id = text(viewport.id, `${label}.id`);
	const candidate = EXPECTED_VIEWPORTS.find(item => item.id === id);
	if (!candidate || viewport.columns !== candidate.columns || viewport.rows !== candidate.rows) {
		fail(`${label} is not one of the required deterministic viewports`);
	}
	return candidate;
}

function readFlags(value: unknown, label: string): Flags {
	const flags = record(value, label);
	exactObjectKeys(flags, FLAGS_KEYS, label);
	return {
		noColor: bool(flags.noColor, `${label}.noColor`),
		cjk: bool(flags.cjk, `${label}.cjk`),
		redacted: bool(flags.redacted, `${label}.redacted`),
		disposal: bool(flags.disposal, `${label}.disposal`),
	};
}

function readNullableText(value: unknown, label: string): string | null {
	if (value === null) return null;
	return text(value, label);
}

function readReceipt(value: unknown, label: string): Receipt {
	const receipt = record(value, label);
	exactObjectKeys(receipt, RECEIPT_KEYS, label);
	const status = readNullableText(receipt.status, `${label}.status`);
	if (
		status !== null &&
		!["applied", "committed", "degraded", "rejected", "conflict", "locked", "deleted"].includes(status)
	) {
		fail(`${label}.status is invalid`);
	}
	const timing = readNullableText(receipt.timing, `${label}.timing`);
	if (timing !== null && timing !== "current_runtime" && timing !== "next_session") fail(`${label}.timing is invalid`);
	const durability = readNullableText(receipt.durability, `${label}.durability`);
	if (
		durability !== null &&
		durability !== "none" &&
		durability !== "committed" &&
		durability !== "committed_unconfirmed"
	) {
		fail(`${label}.durability is invalid`);
	}
	const mutationStatus = readNullableText(receipt.mutationStatus, `${label}.mutationStatus`);
	if (
		mutationStatus !== null &&
		!["committed", "applied", "degraded", "conflict", "locked", "rejected"].includes(mutationStatus)
	) {
		fail(`${label}.mutationStatus is invalid`);
	}
	const mutationDurability = readNullableText(receipt.mutationDurability, `${label}.mutationDurability`);
	if (
		mutationDurability !== null &&
		mutationDurability !== "none" &&
		mutationDurability !== "committed" &&
		mutationDurability !== "committed_unconfirmed"
	) {
		fail(`${label}.mutationDurability is invalid`);
	}
	const controllerFingerprint = digest(receipt.controllerFingerprint, `${label}.controllerFingerprint`);
	return {
		status: status as ReceiptStatus | null,
		reason: readNullableText(receipt.reason, `${label}.reason`),
		timing: timing as Timing | null,
		durability: durability as Durability | null,
		mutationStatus: mutationStatus as MutationStatus | null,
		mutationReason: readNullableText(receipt.mutationReason, `${label}.mutationReason`),
		mutationDurability: mutationDurability as Durability | null,
		controllerRevision: integer(receipt.controllerRevision, `${label}.controllerRevision`),
		controllerFingerprint,
	};
}

function readTrace(value: unknown, label: string): RenderTrace {
	const trace = record(value, label);
	exactObjectKeys(trace, TRACE_KEYS, label);
	if (trace.component !== "ExecutionPresetSelectorComponent") fail(`${label}.component is invalid`);
	if (trace.theme !== EXECUTION_PRESET_CAPTURE_THEME) fail(`${label}.theme is invalid`);
	if (trace.productionRender !== true) fail(`${label}.productionRender is false`);
	const noColorDisposition = text(trace.noColorDisposition, `${label}.noColorDisposition`);
	if (noColorDisposition !== "ansi_stripped" && noColorDisposition !== "native_color") {
		fail(`${label}.noColorDisposition is invalid`);
	}
	const beforeInteractionSha256 = digest(trace.beforeInteractionSha256, `${label}.beforeInteractionSha256`);
	const afterInteractionSha256 = digest(trace.afterInteractionSha256, `${label}.afterInteractionSha256`);
	const interactionChanged = bool(trace.interactionChanged, `${label}.interactionChanged`);
	if (interactionChanged !== (beforeInteractionSha256 !== afterInteractionSha256)) {
		fail(`${label}.interactionChanged does not match its hashes`);
	}
	const beforeDisposalSha256 =
		trace.beforeDisposalSha256 === null ? null : digest(trace.beforeDisposalSha256, `${label}.beforeDisposalSha256`);
	const callbackCountBeforeDisposal = nullableInteger(
		trace.callbackCountBeforeDisposal,
		`${label}.callbackCountBeforeDisposal`,
	);
	const callbackCountAfterDisposal = nullableInteger(
		trace.callbackCountAfterDisposal,
		`${label}.callbackCountAfterDisposal`,
	);
	const statusCountBeforeDisposal = nullableInteger(
		trace.statusCountBeforeDisposal,
		`${label}.statusCountBeforeDisposal`,
	);
	const statusCountAfterDisposal = nullableInteger(
		trace.statusCountAfterDisposal,
		`${label}.statusCountAfterDisposal`,
	);
	const requestRenderCountBeforeDisposal = nullableInteger(
		trace.requestRenderCountBeforeDisposal,
		`${label}.requestRenderCountBeforeDisposal`,
	);
	const requestRenderCountAfterDisposal = nullableInteger(
		trace.requestRenderCountAfterDisposal,
		`${label}.requestRenderCountAfterDisposal`,
	);
	const dispositionValue = text(trace.disposition, `${label}.disposition`);
	if (dispositionValue !== "none" && dispositionValue !== "late_apply_cancelled")
		fail(`${label}.disposition is invalid`);
	const disposition: RenderTrace["disposition"] =
		dispositionValue === "late_apply_cancelled" ? "late_apply_cancelled" : "none";
	const postDisposalSha256 =
		trace.postDisposalSha256 === null ? null : digest(trace.postDisposalSha256, `${label}.postDisposalSha256`);
	const postDisposalChanged = bool(trace.postDisposalChanged, `${label}.postDisposalChanged`);
	if (postDisposalSha256 === null && postDisposalChanged) fail(`${label}.postDisposalChanged has no hash`);
	return {
		component: "ExecutionPresetSelectorComponent",
		theme: EXECUTION_PRESET_CAPTURE_THEME,
		productionRender: true,
		noColorDisposition,
		beforeInteractionSha256,
		afterInteractionSha256,
		interactionChanged,
		beforeDisposalSha256,
		callbackCountBeforeDisposal,
		callbackCountAfterDisposal,
		statusCountBeforeDisposal,
		statusCountAfterDisposal,
		requestRenderCountBeforeDisposal,
		requestRenderCountAfterDisposal,
		disposition,
		postDisposalSha256,
		postDisposalChanged,
		controllerRevision: integer(trace.controllerRevision, `${label}.controllerRevision`),
		controllerFingerprint: digest(trace.controllerFingerprint, `${label}.controllerFingerprint`),
		receiptSemanticHash: digest(trace.receiptSemanticHash, `${label}.receiptSemanticHash`),
	};
}

function readEntry(value: unknown, label: string): Entry {
	const entry = record(value, label);
	exactObjectKeys(entry, ENTRY_KEYS, label);
	const key = text(entry.key, `${label}.key`);
	const stateId = text(entry.stateId, `${label}.stateId`);
	if (!EXPECTED_STATE_IDS.includes(stateId as StateId)) fail(`${label}.stateId is invalid`);
	const semanticStateId = text(entry.semanticStateId, `${label}.semanticStateId`);
	if (semanticStateId !== stateId) fail(`${label}.semanticStateId does not match stateId`);
	const viewport = readViewport(entry.viewport, `${label}.viewport`);
	if (key !== `${stateId}/${viewport.id}`) fail(`${label}.key does not match state and viewport`);
	const semanticRows = list(entry.semanticRows, `${label}.semanticRows`).map((item, index) => {
		const row = text(item, `${label}.semanticRows[${index}]`);
		checkSafeText(`${label}.semanticRows[${index}]`, row);
		return row;
	});
	const flags = readFlags(entry.flags, `${label}.flags`);
	const lineStart = integer(entry.lineStart, `${label}.lineStart`);
	const lineCount = integer(entry.lineCount, `${label}.lineCount`);
	if (lineCount < 2) fail(`${label}.lineCount is too small`);
	const lineWidths = list(entry.lineWidths, `${label}.lineWidths`).map((item, index) =>
		integer(item, `${label}.lineWidths[${index}]`),
	);
	if (lineWidths.length !== lineCount) fail(`${label}.lineWidths length differs from lineCount`);
	const plainSha256 = digest(entry.plainSha256, `${label}.plainSha256`);
	const ansiSha256 = digest(entry.ansiSha256, `${label}.ansiSha256`);
	const semanticDetailHash = digest(entry.semanticDetailHash, `${label}.semanticDetailHash`);
	if (entry.productionRender !== true) fail(`${label}.productionRender is false`);
	if (entry.component !== "ExecutionPresetSelectorComponent") fail(`${label}.component is invalid`);
	if (entry.theme !== EXECUTION_PRESET_CAPTURE_THEME) fail(`${label}.theme is invalid`);
	const renderTrace = readTrace(entry.renderTrace, `${label}.renderTrace`);
	const renderTraceHash = digest(entry.renderTraceHash, `${label}.renderTraceHash`);
	const receipt = readReceipt(entry.receipt, `${label}.receipt`);
	const actions = list(entry.actions, `${label}.actions`).map((item, index) => {
		const action = text(item, `${label}.actions[${index}]`);
		checkSafeText(`${label}.actions[${index}]`, action);
		if (
			!/^(?:render|keyboard|scope|receipt|controller|delete|apply|disposal|late-callback|late-receipt):[A-Za-z0-9_.-]+$/u.test(
				action,
			)
		) {
			fail(`${label}.actions[${index}] has an invalid trace shape`);
		}
		return action;
	});
	return {
		key,
		stateId: stateId as StateId,
		semanticStateId: semanticStateId as StateId,
		semanticStatus: text(entry.semanticStatus, `${label}.semanticStatus`),
		semanticRows,
		semanticDetailHash,
		viewport,
		flags,
		lineStart,
		lineCount,
		lineWidths,
		plainSha256,
		ansiSha256,
		productionRender: true,
		component: "ExecutionPresetSelectorComponent",
		theme: EXECUTION_PRESET_CAPTURE_THEME,
		renderTrace,
		renderTraceHash,
		receipt,
		actions,
	};
}

function expectedFlags(stateId: StateId): Flags {
	return {
		noColor: stateId === "no-color-disposed",
		cjk: stateId === "custom-cjk",
		redacted: stateId === "custom-redacted",
		disposal: stateId === "no-color-disposed",
	};
}

function expectedSemanticStatus(stateId: StateId): string {
	if (stateId.startsWith("list-") || stateId === "scope-cycle") return "list";
	if (stateId.startsWith("preview-") || stateId === "custom-cjk") return "preview";
	if (stateId === "custom-redacted") return "list";
	if (stateId === "apply-session" || stateId === "apply-project-committed") return "applied";
	if (stateId === "apply-user-degraded") return "degraded";
	if (stateId === "apply-conflict") return "conflict";
	if (stateId === "stale-preview") return "stale";
	if (stateId === "delete-confirm") return "deleted";
	return "disposed";
}

function expectedScope(stateId: StateId): "session" | "project" | "user" {
	if (stateId === "list-project" || stateId === "apply-project-committed") return "project";
	if (
		stateId === "list-user" ||
		stateId === "apply-user-degraded" ||
		stateId === "apply-conflict" ||
		stateId === "scope-cycle"
	)
		return "user";
	return "session";
}

function expectedSemanticRows(stateId: StateId): readonly string[] {
	const scope = expectedScope(stateId);
	const scopeLabel = scope === "session" ? "Session" : scope === "project" ? "Project" : "User";
	if (stateId.startsWith("list-") || stateId === "scope-cycle") {
		return ["Execution presets", `Scope: ${scopeLabel}`];
	}
	if (stateId === "preview-secure" || stateId === "no-color-disposed")
		return ["Preview: Secure Review", "Work Mode: unchanged"];
	if (stateId === "preview-fast") return ["Preview: Fast Build", "Work Mode: unchanged"];
	if (stateId === "preview-isolated") return ["Preview: Isolated Autonomy", "Work Mode: unchanged"];
	if (stateId === "custom-cjk") return ["Preview: 研究者プリセット", "日本語と한국어"];
	if (stateId === "custom-redacted") return ["Redacted Review · custom-redacted", "<redacted>"];
	if (stateId === "apply-session") return ["Status: Applied for Session; timing current_runtime; durability none."];
	if (stateId === "apply-project-committed")
		return ["Status: Applied for Project; timing current_runtime; durability committed."];
	if (stateId === "apply-user-degraded")
		return [`Status: Saved for ${scopeLabel}; runtime active, verification degraded.`];
	if (stateId === "apply-conflict") return ["The user preset changed elsewhere; no change was applied."];
	if (stateId === "stale-preview") return ["The preset could not be applied; no change was applied."];
	return ["Deleted from Project."];
}

function expectedActions(stateId: StateId): readonly string[] {
	switch (stateId) {
		case "list-session":
			return ["render:ExecutionPresetSelectorComponent"];
		case "list-project":
			return ["render:ExecutionPresetSelectorComponent", "keyboard:s", "scope:project"];
		case "list-user":
			return ["render:ExecutionPresetSelectorComponent", "keyboard:s", "scope:project", "keyboard:s", "scope:user"];
		case "preview-secure":
			return ["render:ExecutionPresetSelectorComponent", "keyboard:Enter"];
		case "preview-fast":
			return ["render:ExecutionPresetSelectorComponent", "keyboard:ArrowDown", "keyboard:Enter"];
		case "preview-isolated":
			return [
				"render:ExecutionPresetSelectorComponent",
				"keyboard:ArrowDown",
				"keyboard:ArrowDown",
				"keyboard:Enter",
			];
		case "scope-cycle":
			return ["render:ExecutionPresetSelectorComponent", "keyboard:s", "scope:project", "keyboard:s", "scope:user"];
		case "apply-session":
			return ["render:ExecutionPresetSelectorComponent", "keyboard:Enter", "keyboard:Enter", "receipt:applied"];
		case "apply-project-committed":
			return [
				"render:ExecutionPresetSelectorComponent",
				"keyboard:s",
				"scope:project",
				"keyboard:Enter",
				"keyboard:Enter",
				"receipt:committed",
			];
		case "apply-user-degraded":
			return [
				"render:ExecutionPresetSelectorComponent",
				"keyboard:s",
				"scope:project",
				"keyboard:s",
				"scope:user",
				"keyboard:Enter",
				"keyboard:Enter",
				"receipt:degraded",
			];
		case "apply-conflict":
			return [
				"render:ExecutionPresetSelectorComponent",
				"keyboard:s",
				"scope:project",
				"keyboard:s",
				"scope:user",
				"keyboard:Enter",
				"keyboard:Enter",
				"receipt:conflict",
			];
		case "stale-preview":
			return [
				"render:ExecutionPresetSelectorComponent",
				"keyboard:Enter",
				"controller:apply-default",
				"keyboard:Enter",
				"receipt:preview_stale",
			];
		case "custom-cjk":
			return [
				"render:ExecutionPresetSelectorComponent",
				"keyboard:ArrowDown",
				"keyboard:ArrowDown",
				"keyboard:ArrowDown",
				"keyboard:Enter",
			];
		case "custom-redacted":
			return [
				"render:ExecutionPresetSelectorComponent",
				"keyboard:ArrowDown",
				"keyboard:ArrowDown",
				"keyboard:ArrowDown",
			];
		case "delete-confirm":
			return [
				"render:ExecutionPresetSelectorComponent",
				"keyboard:s",
				"scope:project",
				"keyboard:ArrowDown",
				"keyboard:ArrowDown",
				"keyboard:ArrowDown",
				"keyboard:d",
				"keyboard:Enter",
				"delete:custom-cjk",
			];
		case "no-color-disposed":
			return [
				"render:ExecutionPresetSelectorComponent",
				"keyboard:Enter",
				"keyboard:Enter",
				"apply:pending",
				"disposal:ExecutionPresetSelectorComponent",
				"late-receipt:cancelled",
			];
	}
	throw new Error(`Unknown execution preset state: ${stateId}`);
}

function policyFingerprint(policy: TaskExecutionPolicy): string {
	return hash(
		JSON.stringify({
			isolation: policy.isolation,
			toolAccess: { allow: [...policy.toolAccess.allow], deny: [...policy.toolAccess.deny] },
			mcpDiscovery: policy.mcpDiscovery,
			maxDurationMs: policy.maxDurationMs,
			simpleMode: policy.simpleMode,
		}),
	);
}

function presetFingerprint(id: string): string {
	const preset = CURATED_EXECUTION_PRESETS.find(candidate => candidate.id === id);
	if (!preset) fail(`curated preset ${id} is unavailable`);
	return policyFingerprint(preset.policy);
}

function expectedReceipt(stateId: StateId): Receipt {
	const defaultFingerprint = policyFingerprint(DEFAULT_TASK_EXECUTION_POLICY);
	const secureFingerprint = presetFingerprint("secure-review");
	if (stateId === "apply-session") {
		return {
			status: "applied",
			reason: null,
			timing: "current_runtime",
			durability: "none",
			mutationStatus: null,
			mutationReason: null,
			mutationDurability: null,
			controllerRevision: 1,
			controllerFingerprint: secureFingerprint,
		};
	}
	if (stateId === "apply-project-committed") {
		return {
			status: "committed",
			reason: null,
			timing: "current_runtime",
			durability: "committed",
			mutationStatus: "committed",
			mutationReason: null,
			mutationDurability: "committed",
			controllerRevision: 1,
			controllerFingerprint: secureFingerprint,
		};
	}
	if (stateId === "apply-user-degraded") {
		return {
			status: "degraded",
			reason: "persistent_reload_mismatch",
			timing: "current_runtime",
			durability: "committed_unconfirmed",
			mutationStatus: "degraded",
			mutationReason: "persistent_reload_mismatch",
			mutationDurability: "committed_unconfirmed",
			controllerRevision: 1,
			controllerFingerprint: secureFingerprint,
		};
	}
	if (stateId === "apply-conflict") {
		return {
			status: "conflict",
			reason: "scope_conflict",
			timing: "next_session",
			durability: "none",
			mutationStatus: "conflict",
			mutationReason: "scope_conflict",
			mutationDurability: "none",
			controllerRevision: 0,
			controllerFingerprint: defaultFingerprint,
		};
	}
	if (stateId === "stale-preview") {
		return {
			status: "rejected",
			reason: "preview_stale",
			timing: "current_runtime",
			durability: "none",
			mutationStatus: null,
			mutationReason: null,
			mutationDurability: null,
			controllerRevision: 1,
			controllerFingerprint: defaultFingerprint,
		};
	}
	if (stateId === "no-color-disposed") {
		return {
			status: "rejected",
			reason: "cancelled",
			timing: "current_runtime",
			durability: "none",
			mutationStatus: null,
			mutationReason: null,
			mutationDurability: null,
			controllerRevision: 0,
			controllerFingerprint: defaultFingerprint,
		};
	}
	if (stateId === "delete-confirm") {
		return {
			status: "deleted",
			reason: null,
			timing: "next_session",
			durability: "committed",
			mutationStatus: "committed",
			mutationReason: null,
			mutationDurability: "committed",
			controllerRevision: 0,
			controllerFingerprint: defaultFingerprint,
		};
	}
	return {
		status: null,
		reason: null,
		timing: null,
		durability: null,
		mutationStatus: null,
		mutationReason: null,
		mutationDurability: null,
		controllerRevision: 0,
		controllerFingerprint: defaultFingerprint,
	};
}

function expectedFrameTitle(stateId: StateId): string | null {
	if (
		stateId === "preview-secure" ||
		stateId === "no-color-disposed" ||
		stateId.startsWith("apply-") ||
		stateId === "stale-preview"
	)
		return "Preview: Secure Review";
	if (stateId === "preview-fast") return "Preview: Fast Build";
	if (stateId === "preview-isolated") return "Preview: Isolated Autonomy";
	if (stateId === "custom-cjk") return "Preview: 研究者プリセット";
	if (stateId === "custom-redacted") return null;
	return null;
}

function expectedStatusText(stateId: StateId): string | null {
	if (stateId === "apply-session") return "Status: Applied for Session; timing current_runtime; durability none.";
	if (stateId === "apply-project-committed")
		return "Status: Applied for Project; timing current_runtime; durability committed.";
	if (stateId === "apply-user-degraded") return "Status: Saved for User; runtime active, verification degraded.";
	if (stateId === "apply-conflict") return "The user preset changed elsewhere; no change was applied.";
	if (stateId === "stale-preview") return "The preset could not be applied; no change was applied.";
	if (stateId === "delete-confirm") return "Deleted from Project.";
	return null;
}

function verifyFrameEvidence(entry: Entry, plainFrame: readonly string[]): void {
	const textFrame = plainFrame.join("\n");
	if (entry.stateId.startsWith("list-") || entry.stateId === "scope-cycle") {
		if (!textFrame.includes("Execution presets")) fail(`${entry.key} does not show the production selector heading`);
		const scopeLabel =
			entry.stateId === "list-project" || entry.stateId === "apply-project-committed"
				? "Project"
				: entry.stateId === "list-user" || entry.stateId === "scope-cycle"
					? "User"
					: "Session";
		if (!textFrame.includes(`Scope: ${scopeLabel}`)) fail(`${entry.key} does not show its selected scope`);
	}
	if (entry.stateId === "no-color-disposed" && !textFrame.includes("Scope: Session"))
		fail(`${entry.key} does not show its selected scope`);
	const title = expectedFrameTitle(entry.stateId);
	if (title && !textFrame.includes(title)) fail(`${entry.key} does not show its production preview title`);
	const status = expectedStatusText(entry.stateId);
	if (status && !textFrame.includes(status)) fail(`${entry.key} does not show its expected status evidence`);
	if (entry.stateId === "custom-cjk") {
		if (!CJK.test(textFrame)) fail(`${entry.key} lacks CJK evidence`);
		if (!plainFrame.some(line => visibleWidth(line) > line.length)) fail(`${entry.key} lacks wide-cell evidence`);
	}
	if (entry.stateId === "custom-redacted" && !textFrame.includes("<redacted>"))
		fail(`${entry.key} lacks redaction evidence`);
}

function verifyReceipt(entry: Entry): void {
	const expected = expectedReceipt(entry.stateId);
	if (JSON.stringify(entry.receipt) !== JSON.stringify(expected))
		fail(
			`${entry.key} has an unexpected receipt/controller relation: expected ${JSON.stringify(expected)}, actual ${JSON.stringify(entry.receipt)}`,
		);
	if (entry.renderTrace.controllerRevision !== entry.receipt.controllerRevision)
		fail(`${entry.key} render trace revision is detached from receipt`);
	if (entry.renderTrace.controllerFingerprint !== entry.receipt.controllerFingerprint)
		fail(`${entry.key} render trace fingerprint is detached from receipt`);
}

function verifyEntryRelations(entry: Entry, plainFrame: readonly string[], ansiFrame: readonly string[]): void {
	if (JSON.stringify(entry.flags) !== JSON.stringify(expectedFlags(entry.stateId)))
		fail(`${entry.key} flags do not match its canonical state`);
	if (entry.semanticStatus !== expectedSemanticStatus(entry.stateId)) fail(`${entry.key} semantic status is invalid`);
	if (JSON.stringify(entry.semanticRows) !== JSON.stringify(expectedSemanticRows(entry.stateId)))
		fail(`${entry.key} semantic rows are invalid`);
	if (JSON.stringify(entry.actions) !== JSON.stringify(expectedActions(entry.stateId)))
		fail(`${entry.key} action trace is invalid`);
	const expectedChanged = entry.stateId !== "list-session";
	if (entry.renderTrace.interactionChanged !== expectedChanged)
		fail(`${entry.key} interaction change relation is invalid`);
	if (entry.renderTrace.noColorDisposition !== (entry.flags.noColor ? "ansi_stripped" : "native_color")) {
		fail(`${entry.key} native-color/ANSI-stripped disposition is invalid`);
	}
	if (entry.renderTrace.afterInteractionSha256 !== entry.ansiSha256)
		fail(`${entry.key} after-interaction hash does not bind ANSI frame`);
	if (entry.flags.disposal) {
		if (entry.renderTrace.disposition !== "late_apply_cancelled")
			fail(`${entry.key} disposal disposition does not prove a late apply was cancelled`);
		if (entry.renderTrace.beforeDisposalSha256 === null) fail(`${entry.key} is missing the pre-disposal frame hash`);
		if (entry.renderTrace.postDisposalSha256 !== entry.ansiSha256)
			fail(`${entry.key} post-disposal hash is not unchanged`);
		if (entry.renderTrace.beforeDisposalSha256 !== entry.renderTrace.postDisposalSha256)
			fail(`${entry.key} pre/post disposal hashes differ`);
		if (entry.renderTrace.postDisposalChanged !== false) fail(`${entry.key} late callback changed disposed output`);
		if (
			entry.renderTrace.callbackCountBeforeDisposal === null ||
			entry.renderTrace.callbackCountAfterDisposal === null ||
			entry.renderTrace.callbackCountBeforeDisposal !== entry.renderTrace.callbackCountAfterDisposal
		)
			fail(`${entry.key} late apply changed callback count`);
		if (
			entry.renderTrace.statusCountBeforeDisposal === null ||
			entry.renderTrace.statusCountAfterDisposal === null ||
			entry.renderTrace.statusCountBeforeDisposal !== entry.renderTrace.statusCountAfterDisposal
		)
			fail(`${entry.key} late apply changed status callback count`);
		if (
			entry.renderTrace.requestRenderCountBeforeDisposal === null ||
			entry.renderTrace.requestRenderCountAfterDisposal === null ||
			entry.renderTrace.requestRenderCountBeforeDisposal !== entry.renderTrace.requestRenderCountAfterDisposal
		)
			fail(`${entry.key} late apply changed request-render count`);
		if (!entry.actions.includes("apply:pending") || !entry.actions.includes("late-receipt:cancelled"))
			fail(`${entry.key} is missing late apply cancellation evidence`);
	} else if (
		entry.renderTrace.disposition !== "none" ||
		entry.renderTrace.beforeDisposalSha256 !== null ||
		entry.renderTrace.callbackCountBeforeDisposal !== null ||
		entry.renderTrace.callbackCountAfterDisposal !== null ||
		entry.renderTrace.statusCountBeforeDisposal !== null ||
		entry.renderTrace.statusCountAfterDisposal !== null ||
		entry.renderTrace.requestRenderCountBeforeDisposal !== null ||
		entry.renderTrace.requestRenderCountAfterDisposal !== null ||
		entry.renderTrace.postDisposalSha256 !== null ||
		entry.renderTrace.postDisposalChanged !== false
	) {
		fail(`${entry.key} carries post-disposal evidence without disposal`);
	}
	if (hash(JSON.stringify(entry.renderTrace)) !== entry.renderTraceHash)
		fail(`${entry.key} render trace hash mismatch`);
	if (hash(JSON.stringify(entry.receipt)) !== entry.renderTrace.receiptSemanticHash)
		fail(`${entry.key} receipt semantic hash mismatch`);
	if (
		hash(`${entry.stateId}\0${plainFrame.join("\n")}\0${JSON.stringify(entry.receipt)}`) !== entry.semanticDetailHash
	) {
		fail(`${entry.key} semantic detail hash mismatch`);
	}
	verifyReceipt(entry);
	verifyFrameEvidence(entry, plainFrame);
	const sgrTokens = new Set<string>();
	for (const line of ansiFrame) {
		for (const match of line.matchAll(/\x1b\[([0-9;]*)m/gu)) sgrTokens.add(match[1] ?? "");
	}
	if (entry.flags.noColor) {
		if (sgrTokens.size > 0 || ansiFrame.join("\n") !== plainFrame.join("\n"))
			fail(`${entry.key} no-color evidence still contains SGR`);
	} else if (sgrTokens.size === 0) {
		fail(`${entry.key} native-color evidence contains no SGR`);
	}
}

export async function verifyExecutionPresetShowcase(
	rootInput: string = EXECUTION_PRESET_CAPTURE_DEFAULT_OUTPUT,
	options: VerifyExecutionPresetShowcaseOptions = {},
): Promise<VerifyExecutionPresetShowcaseSummary> {
	if (EXPECTED_KEY_COUNT !== EXECUTION_PRESET_VISUAL_CAPTURE_COUNT)
		fail("producer capture count drifted from the literal 48-key oracle");
	if (EXECUTION_PRESET_EXPECTED_VISUAL_KEYS.length !== EXPECTED_KEY_COUNT) fail("literal visual oracle is incomplete");
	const root = path.resolve(rootInput);
	const repoRoot = path.resolve(options.repoRoot ?? EXECUTION_PRESET_CAPTURE_DEFAULT_REPO_ROOT);
	let names: string[];
	try {
		names = (await fs.readdir(root)).sort();
	} catch {
		fail("bundle directory is unavailable");
	}
	const expectedFiles = [...EXPECTED_CAPTURE_FILES].sort();
	if (names.length !== expectedFiles.length || names.some((name, index) => name !== expectedFiles[index])) {
		fail("bundle must contain exactly the six capture files");
	}
	const files = {} as Record<(typeof EXPECTED_CAPTURE_FILES)[number], FileData>;
	for (const name of EXPECTED_CAPTURE_FILES) {
		try {
			const bytes = await fs.readFile(path.join(root, name));
			const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			if (bytes.length < 16) fail(`${name} is empty or trivial`);
			files[name] = { bytes, text: decoded };
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("Execution preset showcase verification failed:"))
				throw error;
			fail(`${name} is unavailable or not valid UTF-8`);
		}
	}
	checkSafeText("terminal.txt", files["terminal.txt"].text);
	checkSafeText("metadata.json", files["metadata.json"].text);
	checkSafeText("manifest.json", files["manifest.json"].text);
	if (UNSAFE_CONTROL.test(files["terminal.html"].text) || /\x1b/gu.test(files["terminal.html"].text))
		fail("terminal.html contains unsafe controls");
	if (UNSAFE_CONTROL.test(files["terminal-ansi.txt"].text.replace(ANSI_SGR, "")))
		fail("terminal-ansi.txt contains non-SGR controls");
	if (Bun.stripANSI(files["terminal-ansi.txt"].text) !== files["terminal.txt"].text)
		fail("plain and ANSI terminal surfaces differ");
	if (files["terminal-ansi.txt"].text.match(ANSI_SGR) === null)
		fail("terminal-ansi.txt has no production SGR styling");
	if (files["terminal.html"].text !== ansiToHtml(files["terminal-ansi.txt"].text))
		fail("terminal.html is not the canonical ANSI conversion");

	const metadataRaw = record(json(files["metadata.json"].text, "metadata.json"), "metadata.json");
	const manifestRaw = record(json(files["manifest.json"].text, "manifest.json"), "manifest.json");
	exactObjectKeys(metadataRaw, METADATA_KEYS, "metadata");
	exactObjectKeys(manifestRaw, MANIFEST_KEYS, "manifest");
	if (
		metadataRaw.schema !== EXECUTION_PRESET_VISUAL_CAPTURE_SCHEMA ||
		metadataRaw.version !== EXECUTION_PRESET_VISUAL_CAPTURE_VERSION ||
		manifestRaw.schema !== EXECUTION_PRESET_VISUAL_CAPTURE_SCHEMA ||
		manifestRaw.version !== EXECUTION_PRESET_VISUAL_CAPTURE_VERSION
	) {
		fail("schema/version mismatch");
	}
	if (
		metadataRaw.captureTimestamp !== EXECUTION_PRESET_CAPTURE_TIMESTAMP ||
		metadataRaw.locale !== EXECUTION_PRESET_CAPTURE_LOCALE ||
		metadataRaw.timezone !== EXECUTION_PRESET_CAPTURE_TIMEZONE ||
		metadataRaw.seed !== EXECUTION_PRESET_CAPTURE_SEED ||
		metadataRaw.theme !== EXECUTION_PRESET_CAPTURE_THEME
	) {
		fail("fixed timestamp, locale, timezone, seed, or theme metadata mismatch");
	}
	const hostMatrix = record(metadataRaw.hostMatrix, "metadata.hostMatrix");
	exactObjectKeys(hostMatrix, ["captureHost", "livePty", "network"], "metadata.hostMatrix");
	if (hostMatrix.captureHost !== "VirtualTerminal" || hostMatrix.livePty !== false || hostMatrix.network !== false) {
		fail("metadata host matrix is not the deterministic VirtualTerminal host");
	}
	if (
		metadataRaw.fontRenderingAssumptions !==
			"Embedded red-claw theme at deterministic truecolor; HTML uses a monospace terminal fallback stack." ||
		metadataRaw.wrappingPolicy !==
			"ExecutionPresetSelectorComponent owns ANSI-aware terminal-cell truncation at each recorded viewport width." ||
		metadataRaw.ansiControlSemantics !==
			"VirtualTerminal-backed production TUI rendering preserves SGR; no-color evidence strips SGR only."
	) {
		fail("metadata rendering assumptions drifted");
	}
	const metadataClosure = readSourceClosure(metadataRaw.sourceClosure, "metadata.sourceClosure");
	const manifestClosure = readSourceClosure(manifestRaw.sourceClosure, "manifest.sourceClosure");
	if (
		metadataClosure.sha256 !== manifestClosure.sha256 ||
		JSON.stringify(metadataClosure.files) !== JSON.stringify(manifestClosure.files)
	) {
		fail("metadata and manifest source closures differ");
	}
	const currentClosure = await recomputeSourceClosure(repoRoot);
	if (currentClosure.sha256 !== metadataClosure.sha256) fail("source closure bytes do not match the repository root");
	const sourceHash = text(metadataRaw.sourceHash, "metadata.sourceHash");
	if (!SAFE_SOURCE_HASH.test(sourceHash)) fail("metadata.sourceHash is invalid");
	if (options.sourceHash !== undefined && sourceHash !== options.sourceHash)
		fail("sourceHash does not match verifier input");
	if (manifestRaw.sourceHash !== sourceHash) fail("metadata and manifest sourceHash differ");
	if (metadataRaw.expectedKeyCount !== EXPECTED_KEY_COUNT || manifestRaw.expectedKeyCount !== EXPECTED_KEY_COUNT)
		fail("expected key count mismatch");

	const metadataKeys = list(metadataRaw.keys, "metadata.keys").map((value, index) =>
		text(value, `metadata.keys[${index}]`),
	);
	const manifestKeys = list(manifestRaw.keys, "manifest.keys").map((value, index) =>
		text(value, `manifest.keys[${index}]`),
	);
	exactKeys(metadataKeys, "metadata.keys");
	exactKeys(manifestKeys, "manifest.keys");
	if (JSON.stringify(metadataKeys) !== JSON.stringify(manifestKeys)) fail("metadata and manifest key order differs");

	const metadataEntriesRaw = list(metadataRaw.entries, "metadata.entries");
	const manifestEntriesRaw = list(manifestRaw.entries, "manifest.entries");
	if (metadataEntriesRaw.length !== EXPECTED_KEY_COUNT || manifestEntriesRaw.length !== EXPECTED_KEY_COUNT)
		fail("entry count mismatch");
	if (JSON.stringify(metadataEntriesRaw) !== JSON.stringify(manifestEntriesRaw))
		fail("metadata and manifest entries differ");
	const entries = metadataEntriesRaw.map((value, index) => readEntry(value, `metadata.entries[${index}]`));
	for (const [index, entry] of entries.entries()) {
		if (entry.key !== metadataKeys[index]) fail(`entry/key parity mismatch at ${entry.key}`);
	}

	const plainLines = files["terminal.txt"].text.split("\n");
	const ansiLines = files["terminal-ansi.txt"].text.split("\n");
	if (plainLines.length !== ansiLines.length) fail("plain and ANSI line counts differ");
	let expectedLineStart = 0;
	for (const entry of entries) {
		if (entry.lineStart !== expectedLineStart) fail(`frame ranges are not contiguous at ${entry.key}`);
		const plainFrame = plainLines.slice(entry.lineStart, entry.lineStart + entry.lineCount);
		const ansiFrame = ansiLines.slice(entry.lineStart, entry.lineStart + entry.lineCount);
		expectedLineStart += entry.lineCount;
		if (plainFrame.length !== entry.lineCount || ansiFrame.length !== entry.lineCount)
			fail(`frame range is incomplete for ${entry.key}`);
		if (plainFrame.some(line => visibleWidth(line) > entry.viewport.columns))
			fail(`terminal-cell width exceeded for ${entry.key}`);
		if (entry.lineWidths.some((width, index) => width !== visibleWidth(plainFrame[index] ?? "")))
			fail(`cell-width metadata mismatch for ${entry.key}`);
		if (hash(plainFrame.join("\n")) !== entry.plainSha256) fail(`plain frame hash mismatch for ${entry.key}`);
		if (hash(ansiFrame.join("\n")) !== entry.ansiSha256) fail(`ANSI frame hash mismatch for ${entry.key}`);
		for (const line of plainFrame) checkSafeText(`${entry.key}.frame`, line);
		verifyEntryRelations(entry, plainFrame, ansiFrame);
	}
	if (expectedLineStart !== plainLines.length - 1 || plainLines.at(-1) !== "")
		fail("frame ranges do not cover the terminal surface");

	const metadataHashes = record(metadataRaw.hashes, "metadata.hashes");
	exactObjectKeys(metadataHashes, ["terminal.txt", "terminal-ansi.txt", "terminal.html"], "metadata.hashes");
	for (const name of ["terminal.txt", "terminal-ansi.txt", "terminal.html"] as const) {
		if (hash(files[name].bytes) !== digest(metadataHashes[name], `metadata.hashes.${name}`))
			fail(`metadata hash mismatch for ${name}`);
	}
	const manifestFiles = record(manifestRaw.files, "manifest.files");
	exactObjectKeys(manifestFiles, EXPECTED_MANIFEST_FILES, "manifest.files");
	for (const name of EXPECTED_MANIFEST_FILES) {
		const descriptor = record(manifestFiles[name], `manifest.files.${name}`);
		exactObjectKeys(descriptor, ["sha256", "byteLength"], `manifest.files.${name}`);
		if (hash(files[name].bytes) !== digest(descriptor.sha256, `manifest.files.${name}.sha256`))
			fail(`manifest hash mismatch for ${name}`);
		if (integer(descriptor.byteLength, `manifest.files.${name}.byteLength`) !== files[name].bytes.byteLength) {
			fail(`manifest byte length mismatch for ${name}`);
		}
	}
	return { keyCount: metadataKeys.length, sourceHash, sourceClosureSha256: metadataClosure.sha256 };
}

export const verifyExecutionPresetShowcaseBundle = verifyExecutionPresetShowcase;

function parseVerifyArgs(args: readonly string[]): VerifyExecutionPresetShowcaseOptions & { root: string } {
	let root: string = EXECUTION_PRESET_CAPTURE_DEFAULT_OUTPUT;
	let repoRoot = EXECUTION_PRESET_CAPTURE_DEFAULT_REPO_ROOT;
	let sourceHash: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--root" || arg === "--output" || arg === "--out") root = args[++index] ?? root;
		else if (arg === "--repo-root") repoRoot = args[++index] ?? repoRoot;
		else if (arg === "--source-hash") sourceHash = args[++index];
		else throw new Error("Invalid execution preset showcase verifier arguments.");
	}
	return { root, repoRoot, sourceHash };
}

if (import.meta.main) {
	const parsed = parseVerifyArgs(process.argv.slice(2));
	const summary = await verifyExecutionPresetShowcase(parsed.root, parsed);
	process.stdout.write(`Verified ${summary.keyCount} execution preset visual keys.\n`);
}
