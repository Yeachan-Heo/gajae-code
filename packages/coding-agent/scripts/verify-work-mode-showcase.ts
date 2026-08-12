import * as fs from "node:fs/promises";
import * as path from "node:path";
import { visibleWidth } from "@gajae-code/tui";
import {
	ansiToHtml,
	WORK_MODE_ADAPTER_MANIFEST_SHA256,
	WORK_MODE_CAPTURE_DEFAULT_OUTPUT,
	WORK_MODE_CAPTURE_DEFAULT_REPO_ROOT,
	WORK_MODE_CAPTURE_FILES,
	WORK_MODE_CAPTURE_THEME,
	WORK_MODE_SOURCE_CLOSURE_FILES,
	WORK_MODE_VISUAL_CAPTURE_COUNT,
	WORK_MODE_VISUAL_CAPTURE_SCHEMA,
	WORK_MODE_VISUAL_CAPTURE_VERSION,
	type WorkModeVisualCaptureEntry,
	type WorkModeVisualCaptureSourceClosure,
	type WorkModeVisualRenderTrace,
} from "./capture-work-mode-showcase";

export type VerifyWorkModeShowcaseOptions = Readonly<{ repoRoot?: string; sourceHash?: string }>;
export type VerifyWorkModeShowcaseSummary = Readonly<{ keyCount: number; sourceHash: string; manifestSha256: string }>;

const hash = (value: string | Uint8Array): string => new Bun.CryptoHasher("sha256").update(value).digest("hex");
function ansiTokenColorSet(lines: readonly string[]): readonly string[] {
	const tokens = new Set<string>();
	for (const line of lines) {
		for (const match of line.matchAll(/\x1b\[([0-9;]*)m/gu)) tokens.add(match[1] ?? "");
	}
	return [...tokens].sort((left, right) => left.localeCompare(right));
}

function readSha256(value: unknown, label: string): string {
	const result = readString(value, label);
	if (!/^[0-9a-f]{64}$/u.test(result)) fail(`${label} is not a SHA-256 digest`);
	return result;
}

function readRenderTrace(value: unknown, label: string): WorkModeVisualRenderTrace {
	const trace = object(value, label);
	if (trace.component !== "ModelSelectorComponent") fail(`${label}.component is invalid`);
	if (trace.theme !== WORK_MODE_CAPTURE_THEME) fail(`${label}.theme is invalid`);
	if (typeof trace.colorBlind !== "boolean") fail(`${label}.colorBlind is invalid`);
	const tokenSet = array(trace.ansiTokenColorSet, `${label}.ansiTokenColorSet`).map((token, index) =>
		readString(token, `${label}.ansiTokenColorSet[${index}]`),
	);
	if (tokenSet.some(token => !/^(?:\d+(?:;\d+)*)?$/u.test(token)))
		fail(`${label}.ansiTokenColorSet contains an invalid SGR token`);
	if (tokenSet.some((token, index) => index > 0 && tokenSet[index - 1]!.localeCompare(token) >= 0))
		fail(`${label}.ansiTokenColorSet must be sorted and unique`);
	const tokenHash = readSha256(trace.ansiTokenColorSetHash, `${label}.ansiTokenColorSetHash`);
	if (hash(JSON.stringify(tokenSet)) !== tokenHash)
		fail(`${label}.ansiTokenColorSetHash does not match the token set`);
	const beforeInteractionSha256 = readSha256(trace.beforeInteractionSha256, `${label}.beforeInteractionSha256`);
	const afterInteractionSha256 = readSha256(trace.afterInteractionSha256, `${label}.afterInteractionSha256`);
	if (typeof trace.interactionChanged !== "boolean") fail(`${label}.interactionChanged is invalid`);
	if (trace.interactionChanged !== (beforeInteractionSha256 !== afterInteractionSha256))
		fail(`${label}.interactionChanged does not match the interaction frame hashes`);
	const sourceToken = trace.sourceToken;
	if (sourceToken !== "toolDiffAdded" && sourceToken !== null) fail(`${label}.sourceToken is invalid`);
	const reason = trace.reason;
	if (reason !== "settings.colorBlindMode" && reason !== null) fail(`${label}.reason is invalid`);
	if (trace.colorBlind !== (sourceToken !== null) || trace.colorBlind !== (reason !== null))
		fail(`${label}.color-blind source metadata does not match colorBlind`);
	return {
		component: "ModelSelectorComponent",
		theme: WORK_MODE_CAPTURE_THEME,
		colorBlind: trace.colorBlind,
		ansiTokenColorSet: tokenSet,
		ansiTokenColorSetHash: tokenHash,
		beforeInteractionSha256,
		afterInteractionSha256,
		interactionChanged: trace.interactionChanged,
		sourceToken,
		reason,
	};
}
const unsafeControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u001b]/u;
const unsafeSecret =
	/(?:\/Users\/|\/home\/|https?:\/\/|file:\/\/|bearer\s+\S+|(?:token|password|api[_ -]?key)\s*[:=]\s*\S+)/iu;
const ansiSgr = /\x1b\[[0-9;]*m/gu;
const syntheticWorkModeLabel = /^\s*Work Mode · [^·]+ · \d+x\d+\s*$/u;
const expectedFiles = [...WORK_MODE_CAPTURE_FILES].sort();

export const WORK_MODE_EXPECTED_VISUAL_KEYS = Object.freeze([
	"catalog/80x24",
	"catalog/120x36",
	"catalog/160x48",
	"selector/80x24",
	"selector/120x36",
	"selector/160x48",
	"preview-ready/80x24",
	"preview-ready/120x36",
	"preview-ready/160x48",
	"preview-degraded/80x24",
	"preview-degraded/120x36",
	"preview-degraded/160x48",
	"preview-unavailable/80x24",
	"preview-unavailable/120x36",
	"preview-unavailable/160x48",
	"scope-turn/80x24",
	"scope-turn/120x36",
	"scope-turn/160x48",
	"scope-session/80x24",
	"scope-session/120x36",
	"scope-session/160x48",
	"scope-project/80x24",
	"scope-project/120x36",
	"scope-project/160x48",
	"scope-user/80x24",
	"scope-user/120x36",
	"scope-user/160x48",
	"pending/80x24",
	"pending/120x36",
	"pending/160x48",
	"confirmation/80x24",
	"confirmation/120x36",
	"confirmation/160x48",
	"drift/80x24",
	"drift/120x36",
	"drift/160x48",
	"conflict/80x24",
	"conflict/120x36",
	"conflict/160x48",
	"locked/80x24",
	"locked/120x36",
	"locked/160x48",
	"rejected/80x24",
	"rejected/120x36",
	"rejected/160x48",
	"write-failure/80x24",
	"write-failure/120x36",
	"write-failure/160x48",
	"committed-unconfirmed/80x24",
	"committed-unconfirmed/120x36",
	"committed-unconfirmed/160x48",
	"partial-activation/80x24",
	"partial-activation/120x36",
	"partial-activation/160x48",
	"partial-rollback/80x24",
	"partial-rollback/120x36",
	"partial-rollback/160x48",
	"pre-gate-settlement/80x24",
	"pre-gate-settlement/120x36",
	"pre-gate-settlement/160x48",
	"admitted-success/80x24",
	"admitted-success/120x36",
	"admitted-success/160x48",
	"admitted-failure/80x24",
	"admitted-failure/120x36",
	"admitted-failure/160x48",
	"finalization-success/80x24",
	"finalization-success/120x36",
	"finalization-success/160x48",
	"finalization-failure/80x24",
	"finalization-failure/120x36",
	"finalization-failure/160x48",
	"custom-qualification/80x24",
	"custom-qualification/120x36",
	"custom-qualification/160x48",
	"palette/80x24",
	"palette/120x36",
	"palette/160x48",
	"status/80x24",
	"status/120x36",
	"status/160x48",
	"explain/80x24",
	"explain/120x36",
	"explain/160x48",
	"receipt/80x24",
	"receipt/120x36",
	"receipt/160x48",
	"recovery/80x24",
	"recovery/120x36",
	"recovery/160x48",
	"catalog-unavailable/80x24",
	"catalog-unavailable/120x36",
	"catalog-unavailable/160x48",
	"no-color/80x24",
	"cjk/80x24",
	"focus/120x36",
	"scroll/120x36",
	"keyboard/120x36",
	"mouse/120x36",
	"disposal/120x36",
	"color-blind-deuteranopia/120x36",
	"color-blind-protanopia/120x36",
	"color-blind-tritanopia/120x36",
	"no-color-wide/160x48",
	"cjk-wide/160x48",
	"focus-narrow/80x24",
	"scroll-wide/160x48",
]);

function fail(message: string): never {
	throw new Error(`Work Mode showcase verification failed: ${message}`);
}

function object(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) fail(`${label} must be an array`);
	return value;
}

function readString(value: unknown, label: string): string {
	if (typeof value !== "string") fail(`${label} must be a string`);
	return value;
}

function readJson<T>(text: string, label: string): T {
	try {
		return JSON.parse(text) as T;
	} catch {
		fail(`${label} is not valid JSON`);
	}
}

function expectedKeys(): readonly string[] {
	return WORK_MODE_EXPECTED_VISUAL_KEYS;
}

function exactKeys(actual: readonly string[], expected: readonly string[], label: string): void {
	if (
		actual.length !== expected.length ||
		new Set(actual).size !== actual.length ||
		actual.some((key, index) => key !== expected[index])
	) {
		fail(`${label} does not contain the exact ordered 107-key matrix`);
	}
}

function checkSafeText(label: string, value: string): void {
	if (unsafeControl.test(value)) fail(`${label} contains terminal control bytes`);
	if (unsafeSecret.test(value)) fail(`${label} contains a secret or locator token`);
}

function checkHash(label: string, value: string, expected: string): void {
	if (hash(value) !== expected) fail(`${label} hash mismatch`);
}

function readSourceClosure(value: unknown, label: string): WorkModeVisualCaptureSourceClosure {
	const closure = object(value, label);
	const files = array(closure.files, `${label}.files`).map((entry, index) =>
		readString(entry, `${label}.files[${index}]`),
	);
	if (
		files.length !== WORK_MODE_SOURCE_CLOSURE_FILES.length ||
		files.some((file, index) => file !== WORK_MODE_SOURCE_CLOSURE_FILES[index])
	)
		fail(`${label}.files drift from the required source closure`);
	return { files, sha256: readSha256(closure.sha256, `${label}.sha256`) };
}

async function recomputeSourceClosure(repoRootInput: string): Promise<WorkModeVisualCaptureSourceClosure> {
	const repoRoot = path.resolve(repoRootInput);
	const hasher = new Bun.CryptoHasher("sha256");
	for (const relativePath of WORK_MODE_SOURCE_CLOSURE_FILES) {
		hasher.update(relativePath);
		hasher.update("\0");
		try {
			hasher.update(await fs.readFile(path.join(repoRoot, relativePath)));
		} catch {
			fail(`source closure file is unavailable: ${relativePath}`);
		}
	}
	return { files: WORK_MODE_SOURCE_CLOSURE_FILES, sha256: hasher.digest("hex") };
}

type WorkModeViewport = WorkModeVisualCaptureEntry["viewport"];
type WorkModeColorBlindDisposition = WorkModeVisualCaptureEntry["flags"]["colorBlindDisposition"];

function readViewport(value: Record<string, unknown>, label: string): WorkModeViewport {
	const id = readString(value.id, `${label}.id`);
	switch (id) {
		case "80x24":
			if (value.columns === 80 && value.rows === 24) return { id: "80x24", columns: 80, rows: 24 };
			break;
		case "120x36":
			if (value.columns === 120 && value.rows === 36) return { id: "120x36", columns: 120, rows: 36 };
			break;
		case "160x48":
			if (value.columns === 160 && value.rows === 48) return { id: "160x48", columns: 160, rows: 48 };
			break;
	}
	fail(`${label} viewport is invalid`);
}

function readColorBlindDisposition(value: unknown, label: string): WorkModeColorBlindDisposition {
	const disposition = readString(value, label);
	switch (disposition) {
		case "none":
			return "none";
		case "deuteranopia":
			return "deuteranopia";
		case "protanopia":
			return "protanopia";
		case "tritanopia":
			return "tritanopia";
		default:
			fail(`${label} is invalid`);
	}
}

function entriesFrom(value: unknown, label: string): WorkModeVisualCaptureEntry[] {
	const raw = array(value, label);
	return raw.map((item, index) => {
		const entry = object(item, `${label}[${index}]`);
		const key = readString(entry.key, `${label}[${index}].key`);
		const stateId = readString(entry.stateId, `${label}[${index}].stateId`);
		const semanticStateId = readString(entry.semanticStateId, `${label}[${index}].semanticStateId`);
		if (semanticStateId !== stateId) fail(`${label}[${index}].semanticStateId does not match stateId`);
		const viewport = readViewport(
			object(entry.viewport, `${label}[${index}].viewport`),
			`${label}[${index}].viewport`,
		);
		if (key !== `${stateId}/${viewport.id}`) fail(`${label}[${index}].key does not match stateId and viewport`);
		const flags = object(entry.flags, `${label}[${index}].flags`);
		const colorBlindDisposition = readColorBlindDisposition(
			flags.colorBlindDisposition,
			`${label}[${index}].flags.colorBlindDisposition`,
		);
		for (const flag of ["noColor", "cjk", "focus", "scroll", "keyboard", "mouse", "disposal"] as const) {
			if (typeof flags[flag] !== "boolean") fail(`${label}[${index}].flags.${flag} is invalid`);
		}
		if (
			typeof entry.lineStart !== "number" ||
			!Number.isInteger(entry.lineStart) ||
			typeof entry.lineCount !== "number" ||
			!Number.isInteger(entry.lineCount) ||
			entry.lineStart < 0 ||
			entry.lineCount < 2
		)
			fail(`${label}[${index}] line range is invalid`);
		const plainSha256 = readSha256(entry.plainSha256, `${label}[${index}].plainSha256`);
		const ansiSha256 = readSha256(entry.ansiSha256, `${label}[${index}].ansiSha256`);
		const semanticDetailHash = readSha256(entry.semanticDetailHash, `${label}[${index}].semanticDetailHash`);
		if (entry.productionRender !== true) fail(`${label}[${index}] is not a production render`);
		const renderTrace = readRenderTrace(entry.renderTrace, `${label}[${index}].renderTrace`);
		const renderTraceHash = readSha256(entry.renderTraceHash, `${label}[${index}].renderTraceHash`);
		const actions = array(entry.actions, `${label}[${index}].actions`).map((action, actionIndex) => {
			const value = readString(action, `${label}[${index}].actions[${actionIndex}]`);
			checkSafeText(`${label}[${index}].actions[${actionIndex}]`, value);
			if (!/^(?:preview|scope|focus|scroll|keyboard|mouse|disposal|render):.+$/u.test(value))
				fail(`${label}[${index}].actions[${actionIndex}] has an invalid trace shape`);
			return value;
		});
		return {
			key,
			stateId,
			semanticStateId,
			semanticDetailHash,
			viewport,
			flags: {
				noColor: Boolean(flags.noColor),
				cjk: Boolean(flags.cjk),
				focus: Boolean(flags.focus),
				scroll: Boolean(flags.scroll),
				keyboard: Boolean(flags.keyboard),
				mouse: Boolean(flags.mouse),
				disposal: Boolean(flags.disposal),
				colorBlindDisposition,
			},
			lineStart: Number(entry.lineStart),
			lineCount: Number(entry.lineCount),
			plainSha256,
			ansiSha256,
			productionRender: true,
			renderTrace,
			renderTraceHash,
			actions,
		};
	});
}

export async function verifyWorkModeVisualShowcase(
	rootInput: string = WORK_MODE_CAPTURE_DEFAULT_OUTPUT,
	options: VerifyWorkModeShowcaseOptions = {},
): Promise<VerifyWorkModeShowcaseSummary> {
	const root = path.resolve(rootInput);
	const repoRoot = path.resolve(options.repoRoot ?? WORK_MODE_CAPTURE_DEFAULT_REPO_ROOT);
	let names: string[];
	try {
		names = (await fs.readdir(root)).sort();
	} catch {
		fail("bundle directory is unavailable");
	}
	if (names.length !== expectedFiles.length || names.some((name, index) => name !== expectedFiles[index]))
		fail("bundle must contain exactly the five capture files");
	const files = {
		"terminal.txt": await Bun.file(path.join(root, "terminal.txt")).text(),
		"terminal-ansi.txt": await Bun.file(path.join(root, "terminal-ansi.txt")).text(),
		"terminal.html": await Bun.file(path.join(root, "terminal.html")).text(),
		"metadata.json": await Bun.file(path.join(root, "metadata.json")).text(),
		"manifest.json": await Bun.file(path.join(root, "manifest.json")).text(),
	};
	for (const [name, value] of Object.entries(files))
		if (Buffer.byteLength(value) < 16) fail(`${name} is empty or trivial`);
	checkSafeText("terminal.txt", files["terminal.txt"]);
	checkSafeText("terminal.html", files["terminal.html"]);
	if (/\x1b/gu.test(files["terminal.html"])) fail("terminal.html contains ANSI controls");
	if (unsafeControl.test(files["terminal-ansi.txt"].replace(ansiSgr, "")))
		fail("terminal-ansi.txt contains non-SGR controls");
	if (Bun.stripANSI(files["terminal-ansi.txt"]) !== files["terminal.txt"])
		fail("plain and ANSI terminal surfaces differ");
	if (files["terminal-ansi.txt"].match(ansiSgr) === null) fail("terminal-ansi.txt has no ANSI SGR styling");
	if (files["terminal.html"] !== ansiToHtml(files["terminal-ansi.txt"]))
		fail("terminal.html is not the canonical ANSI conversion");

	const metadataRaw = object(readJson<unknown>(files["metadata.json"], "metadata.json"), "metadata.json");
	const manifestRaw = object(readJson<unknown>(files["manifest.json"], "manifest.json"), "manifest.json");
	if (
		metadataRaw.schema !== WORK_MODE_VISUAL_CAPTURE_SCHEMA ||
		metadataRaw.version !== WORK_MODE_VISUAL_CAPTURE_VERSION
	)
		fail("metadata schema/version mismatch");
	if (
		manifestRaw.schema !== WORK_MODE_VISUAL_CAPTURE_SCHEMA ||
		manifestRaw.version !== WORK_MODE_VISUAL_CAPTURE_VERSION
	)
		fail("manifest schema/version mismatch");
	if (metadataRaw.theme !== WORK_MODE_CAPTURE_THEME) fail("metadata theme mismatch");
	const metadataSourceClosure = readSourceClosure(metadataRaw.sourceClosure, "metadata.sourceClosure");
	const manifestSourceClosure = readSourceClosure(manifestRaw.sourceClosure, "manifest.sourceClosure");
	for (const required of [
		"packages/coding-agent/src/modes/components/model-selector.ts",
		"packages/coding-agent/src/modes/theme/theme.ts",
		"packages/coding-agent/src/modes/theme/defaults/index.ts",
		"packages/coding-agent/src/modes/theme/defaults/red-claw.json",
	]) {
		if (!metadataSourceClosure.files.includes(required)) fail(`production source closure omits ${required}`);
	}
	if (metadataSourceClosure.sha256 !== manifestSourceClosure.sha256)
		fail("metadata and manifest source closure hashes differ");
	const currentSourceClosure = await recomputeSourceClosure(repoRoot);
	if (currentSourceClosure.sha256 !== metadataSourceClosure.sha256)
		fail("source closure hash does not match the current repository root");
	const sourceHash = readString(metadataRaw.sourceHash, "metadata.sourceHash");
	if (options.sourceHash !== undefined && sourceHash !== options.sourceHash)
		fail("sourceHash does not match verifier input");
	if (manifestRaw.sourceHash !== sourceHash) fail("metadata and manifest sourceHash differ");
	if (
		metadataRaw.adapterManifestSha256 !== WORK_MODE_ADAPTER_MANIFEST_SHA256 ||
		manifestRaw.adapterManifestSha256 !== WORK_MODE_ADAPTER_MANIFEST_SHA256
	)
		fail("adapter manifest hash mismatch");
	if (
		metadataRaw.expectedKeyCount !== WORK_MODE_VISUAL_CAPTURE_COUNT ||
		manifestRaw.expectedKeyCount !== WORK_MODE_VISUAL_CAPTURE_COUNT
	)
		fail("expected key count mismatch");
	const keys = array(metadataRaw.keys, "metadata.keys").map((value, index) =>
		readString(value, `metadata.keys[${index}]`),
	);
	const manifestKeys = array(manifestRaw.keys, "manifest.keys").map((value, index) =>
		readString(value, `manifest.keys[${index}]`),
	);
	exactKeys(keys, expectedKeys(), "metadata.keys");
	exactKeys(manifestKeys, expectedKeys(), "manifest.keys");
	if (JSON.stringify(keys) !== JSON.stringify(manifestKeys)) fail("metadata and manifest key order differs");
	const metadataEntries = entriesFrom(metadataRaw.entries, "metadata.entries");
	const manifestEntries = entriesFrom(manifestRaw.entries, "manifest.entries");
	if (
		metadataEntries.length !== WORK_MODE_VISUAL_CAPTURE_COUNT ||
		manifestEntries.length !== WORK_MODE_VISUAL_CAPTURE_COUNT
	)
		fail("entry count mismatch");
	if (JSON.stringify(metadataEntries) !== JSON.stringify(manifestEntries))
		fail("metadata and manifest entries differ");
	if (metadataEntries.some((entry, index) => entry.key !== keys[index])) fail("entry/key parity mismatch");
	const plainLines = files["terminal.txt"].split("\n");
	const ansiLines = files["terminal-ansi.txt"].split("\n");
	if (plainLines.length !== ansiLines.length) fail("terminal line count differs between plain and ANSI surfaces");
	const forbiddenClaims = /(?:safe palette|keyboard-ready|idempotent cleanup complete)/iu;
	let expectedLineStart = 0;
	for (const entry of metadataEntries) {
		if (entry.lineStart !== expectedLineStart) fail(`frame ranges are not contiguous at ${entry.key}`);
		const plainFrame = plainLines.slice(entry.lineStart, entry.lineStart + entry.lineCount);
		const ansiFrame = ansiLines.slice(entry.lineStart, entry.lineStart + entry.lineCount);
		expectedLineStart += entry.lineCount;
		if (plainFrame.length !== entry.lineCount || ansiFrame.length !== entry.lineCount)
			fail(`frame range missing for ${entry.key}`);
		if (visibleWidth(plainFrame[0] ?? "") > entry.viewport.columns)
			fail(`frame header exceeds terminal width for ${entry.key}`);
		if (plainFrame.some(line => visibleWidth(line) > entry.viewport.columns))
			fail(`terminal-cell width exceeded for ${entry.key}`);
		if (hash(plainFrame.join("\n")) !== entry.plainSha256 || hash(ansiFrame.join("\n")) !== entry.ansiSha256)
			fail(`frame hash mismatch for ${entry.key}`);
		if (plainFrame.some(line => syntheticWorkModeLabel.test(line)))
			fail(`synthetic Work Mode label painted for ${entry.key}`);
		if (plainFrame.some(line => forbiddenClaims.test(line))) fail(`unsupported interaction claim for ${entry.key}`);
		const actualTokenSet = ansiTokenColorSet(ansiFrame);
		if (JSON.stringify(actualTokenSet) !== JSON.stringify(entry.renderTrace.ansiTokenColorSet))
			fail(`render trace token set mismatch for ${entry.key}`);
		if (hash(JSON.stringify(actualTokenSet)) !== entry.renderTrace.ansiTokenColorSetHash)
			fail(`render trace token hash mismatch for ${entry.key}`);
		if (hash(JSON.stringify(entry.renderTrace)) !== entry.renderTraceHash)
			fail(`render trace hash mismatch for ${entry.key}`);
		if (entry.renderTrace.colorBlind !== (entry.flags.colorBlindDisposition !== "none"))
			fail(`color-blind render trace disposition mismatch for ${entry.key}`);
		if (entry.renderTrace.interactionChanged && entry.actions.length === 0)
			fail(`changed interaction has no action trace for ${entry.key}`);
		if (entry.flags.noColor && actualTokenSet.length > 0)
			fail(`no-color frame has render trace colors for ${entry.key}`);
		if (!entry.flags.noColor && actualTokenSet.length === 0)
			fail(`colored frame has no render trace colors for ${entry.key}`);
		if (entry.flags.focus && !entry.actions.some(action => action.startsWith("focus:")))
			fail(`focus action trace missing for ${entry.key}`);
		if (entry.flags.scroll && !entry.actions.some(action => action.startsWith("scroll:")))
			fail(`scroll action trace missing for ${entry.key}`);
		if (entry.flags.keyboard && !entry.actions.some(action => action.startsWith("keyboard:")))
			fail(`keyboard action trace missing for ${entry.key}`);
		if (entry.flags.mouse && !entry.actions.some(action => action.startsWith("mouse:")))
			fail(`mouse action trace missing for ${entry.key}`);
		if (entry.flags.disposal && !entry.actions.some(action => action.startsWith("disposal:")))
			fail(`disposal action trace missing for ${entry.key}`);
	}
	if (expectedLineStart !== plainLines.length - 1) fail("frame ranges do not cover the terminal surface");
	const colorBlindEntries = metadataEntries.filter(entry => entry.flags.colorBlindDisposition !== "none");
	if (colorBlindEntries.length !== 3) fail("color-blind supplemental entries are incomplete");
	const colorBlindTraceHashes = new Set(colorBlindEntries.map(entry => entry.renderTraceHash));
	if (
		colorBlindTraceHashes.size !== 1 ||
		colorBlindEntries.some(entry => entry.renderTrace.ansiTokenColorSet.length === 0)
	)
		fail("color-blind traces are not identical non-empty production traces");
	const metadataHashes = object(metadataRaw.hashes, "metadata.hashes");
	for (const name of ["terminal.txt", "terminal-ansi.txt", "terminal.html"] as const)
		checkHash(`metadata.${name}`, files[name], readString(metadataHashes[name], `metadata.hashes.${name}`));
	const manifestFiles = object(manifestRaw.files, "manifest.files");
	for (const name of ["terminal.txt", "terminal-ansi.txt", "terminal.html", "metadata.json"] as const) {
		const descriptor = object(manifestFiles[name], `manifest.files.${name}`);
		checkHash(`manifest.${name}`, files[name], readString(descriptor.sha256, `manifest.files.${name}.sha256`));
		if (descriptor.byteLength !== Buffer.byteLength(files[name])) fail(`manifest.${name} byte length mismatch`);
	}
	if (
		!metadataEntries.some(entry => entry.flags.noColor) ||
		!metadataEntries.some(entry => entry.flags.cjk) ||
		!metadataEntries.some(entry => entry.flags.focus) ||
		!metadataEntries.some(entry => entry.flags.scroll) ||
		!metadataEntries.some(entry => entry.flags.keyboard) ||
		!metadataEntries.some(entry => entry.flags.mouse) ||
		!metadataEntries.some(entry => entry.flags.disposal) ||
		!metadataEntries.some(entry => entry.flags.colorBlindDisposition !== "none")
	)
		fail("supplemental disposition metadata is incomplete");
	return { keyCount: keys.length, sourceHash, manifestSha256: hash(files["manifest.json"]) };
}

export const verifyWorkModeShowcase = verifyWorkModeVisualShowcase;

function parseVerifyArgs(args: readonly string[]): { root: string; repoRoot: string; sourceHash?: string } {
	let root: string = WORK_MODE_CAPTURE_DEFAULT_OUTPUT;
	let repoRoot: string = WORK_MODE_CAPTURE_DEFAULT_REPO_ROOT;
	let sourceHash: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--root" || arg === "--output" || arg === "--out") root = args[++index] ?? root;
		else if (arg === "--repo-root") repoRoot = args[++index] ?? repoRoot;
		else if (arg === "--source-hash") sourceHash = args[++index];
		else throw new Error("Invalid Work Mode verifier arguments.");
	}
	return { root, repoRoot, sourceHash };
}

if (import.meta.main) {
	const parsed = parseVerifyArgs(process.argv.slice(2));
	const summary = await verifyWorkModeVisualShowcase(parsed.root, parsed);
	process.stdout.write(`Verified ${summary.keyCount} Work Mode visual keys.\n`);
}
