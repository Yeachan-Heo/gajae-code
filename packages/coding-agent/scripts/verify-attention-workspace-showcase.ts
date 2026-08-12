import * as fs from "node:fs/promises";
import * as path from "node:path";
import { visibleWidth } from "@gajae-code/tui";
import {
	ATTENTION_WORKSPACE_CAPTURE_DEFAULT_OUTPUT,
	ATTENTION_WORKSPACE_CAPTURE_DEFAULT_REPO_ROOT,
	ATTENTION_WORKSPACE_CAPTURE_FILES,
	ATTENTION_WORKSPACE_CAPTURE_LOCALE,
	ATTENTION_WORKSPACE_CAPTURE_SEED,
	ATTENTION_WORKSPACE_CAPTURE_THEME,
	ATTENTION_WORKSPACE_CAPTURE_TIMESTAMP,
	ATTENTION_WORKSPACE_CAPTURE_TIMEZONE,
	ATTENTION_WORKSPACE_SOURCE_CLOSURE_FILES,
	ATTENTION_WORKSPACE_VISUAL_CAPTURE_COUNT,
	ATTENTION_WORKSPACE_VISUAL_CAPTURE_SCHEMA,
	ATTENTION_WORKSPACE_VISUAL_CAPTURE_VERSION,
	type AttentionWorkspaceCaptureEntry,
	type AttentionWorkspaceSourceClosure,
	ansiToHtml,
} from "./capture-attention-workspace-showcase";

export type VerifyAttentionWorkspaceShowcaseOptions = Readonly<{ repoRoot?: string; sourceHash?: string }>;
export type VerifyAttentionWorkspaceShowcaseSummary = Readonly<{
	keyCount: number;
	sourceHash: string;
	manifestSha256: string;
}>;

const hash = (value: string | Uint8Array): string => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const unsafeControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u001b]/u;
const unsafeSecret =
	/(?:https?:\/\/|file:\/\/|bearer\s+\S+|(?:^|\s)(?:~\/|\.\.?\/|\/(?:Users|home|private|tmp|var|etc)\/)|(?:api[_ -]?key|authorization|credential|password|secret|token)\s*[:=]\s*\S+)/iu;
const ansiSgr = /\x1b\[[0-9;]*m/gu;
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** Independent verifier oracle: do not derive this matrix from the producer. */
export const ATTENTION_WORKSPACE_EXPECTED_VISUAL_KEYS = Object.freeze([
	"empty/80x24",
	"empty/120x36",
	"empty/160x48",
	"running-bash/80x24",
	"running-bash/120x36",
	"running-bash/160x48",
	"waiting-cron/80x24",
	"waiting-cron/120x36",
	"waiting-cron/160x48",
	"failed-unack/80x24",
	"failed-unack/120x36",
	"failed-unack/160x48",
	"failed-ack/80x24",
	"failed-ack/120x36",
	"failed-ack/160x48",
	"done/80x24",
	"done/120x36",
	"done/160x48",
	"cancelled/80x24",
	"cancelled/120x36",
	"cancelled/160x48",
	"reveal-bash/80x24",
	"reveal-bash/120x36",
	"reveal-bash/160x48",
	"reveal-cron/80x24",
	"reveal-cron/120x36",
	"reveal-cron/160x48",
	"reveal-unavailable/80x24",
	"reveal-unavailable/120x36",
	"reveal-unavailable/160x48",
	"reveal-stale/80x24",
	"reveal-stale/120x36",
	"reveal-stale/160x48",
	"reveal-failed/80x24",
	"reveal-failed/120x36",
	"reveal-failed/160x48",
	"ack-pending/80x24",
	"ack-pending/120x36",
	"ack-pending/160x48",
	"ack-failed/80x24",
	"ack-failed/120x36",
	"ack-failed/160x48",
	"cjk-long/80x24",
	"cjk-long/120x36",
	"cjk-long/160x48",
	"no-color-disposed/80x24",
	"no-color-disposed/120x36",
	"no-color-disposed/160x48",
]);

function fail(message: string): never {
	throw new Error(`Attention workspace showcase verification failed: ${message}`);
}

function object(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) fail(`${label} must be an array`);
	return value;
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string") fail(`${label} must be a string`);
	return value;
}

function boolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") fail(`${label} must be a boolean`);
	return value;
}

function integer(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
		fail(`${label} must be a non-negative integer`);
	return value;
}

function sha(value: unknown, label: string): string {
	const digest = string(value, label);
	if (!/^[0-9a-f]{64}$/u.test(digest)) fail(`${label} is not a SHA-256 digest`);
	return digest;
}

function readJson(text: string, label: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		fail(`${label} is not valid JSON`);
	}
}

function checkSafeText(label: string, value: string): void {
	if (unsafeControl.test(value)) fail(`${label} contains terminal control bytes`);
	if (unsafeSecret.test(value)) fail(`${label} contains a secret or locator token`);
}

function exactKeys(actual: readonly string[], label: string): void {
	if (
		actual.length !== ATTENTION_WORKSPACE_EXPECTED_VISUAL_KEYS.length ||
		new Set(actual).size !== actual.length ||
		actual.some((key, index) => key !== ATTENTION_WORKSPACE_EXPECTED_VISUAL_KEYS[index])
	)
		fail(`${label} does not contain the exact ordered literal 48-key matrix`);
}

function readSourceClosure(value: unknown, label: string): AttentionWorkspaceSourceClosure {
	const closure = object(value, label);
	const files = array(closure.files, `${label}.files`).map((entry, index) =>
		string(entry, `${label}.files[${index}]`),
	);
	if (
		files.length !== ATTENTION_WORKSPACE_SOURCE_CLOSURE_FILES.length ||
		files.some((file, index) => file !== ATTENTION_WORKSPACE_SOURCE_CLOSURE_FILES[index])
	)
		fail(`${label}.files drift from the required production source closure`);
	return { files, sha256: sha(closure.sha256, `${label}.sha256`) };
}

async function recomputeSourceClosure(repoRootInput: string): Promise<AttentionWorkspaceSourceClosure> {
	const repoRoot = path.resolve(repoRootInput);
	const hasher = new Bun.CryptoHasher("sha256");
	for (const relativePath of ATTENTION_WORKSPACE_SOURCE_CLOSURE_FILES) {
		hasher.update(relativePath);
		hasher.update("\0");
		try {
			hasher.update(await fs.readFile(path.join(repoRoot, relativePath)));
		} catch {
			fail(`source closure file is unavailable: ${relativePath}`);
		}
	}
	return { files: ATTENTION_WORKSPACE_SOURCE_CLOSURE_FILES, sha256: hasher.digest("hex") };
}

function readViewport(value: unknown, label: string): AttentionWorkspaceCaptureEntry["viewport"] {
	const viewport = object(value, label);
	const id = string(viewport.id, `${label}.id`);
	if (id === "80x24" && viewport.columns === 80 && viewport.rows === 24) return { id: "80x24", columns: 80, rows: 24 };
	if (id === "120x36" && viewport.columns === 120 && viewport.rows === 36)
		return { id: "120x36", columns: 120, rows: 36 };
	if (id === "160x48" && viewport.columns === 160 && viewport.rows === 48)
		return { id: "160x48", columns: 160, rows: 48 };
	fail(`${label} is not one of the three required viewports`);
}

function readFlags(value: unknown, label: string): AttentionWorkspaceCaptureEntry["flags"] {
	const flags = object(value, label);
	return {
		noColor: boolean(flags.noColor, `${label}.noColor`),
		cjk: boolean(flags.cjk, `${label}.cjk`),
		disposal: boolean(flags.disposal, `${label}.disposal`),
	};
}

function readTrace(value: unknown, label: string): AttentionWorkspaceCaptureEntry["renderTrace"] {
	const trace = object(value, label);
	if (trace.component !== "TasksPaneComponent") fail(`${label}.component is invalid`);
	if (trace.theme !== ATTENTION_WORKSPACE_CAPTURE_THEME) fail(`${label}.theme is invalid`);
	if (trace.productionRender !== true) fail(`${label}.productionRender is false`);
	const noColorDisposition = string(trace.noColorDisposition, `${label}.noColorDisposition`);
	if (noColorDisposition !== "ansi_stripped" && noColorDisposition !== "native_color")
		fail(`${label}.noColorDisposition is invalid`);
	const beforeInteractionSha256 = sha(trace.beforeInteractionSha256, `${label}.beforeInteractionSha256`);
	const afterInteractionSha256 = sha(trace.afterInteractionSha256, `${label}.afterInteractionSha256`);
	const interactionChanged = boolean(trace.interactionChanged, `${label}.interactionChanged`);
	if (interactionChanged !== (beforeInteractionSha256 !== afterInteractionSha256))
		fail(`${label}.interactionChanged does not match its hashes`);
	const postDisposalSha256 =
		trace.postDisposalSha256 === null ? null : sha(trace.postDisposalSha256, `${label}.postDisposalSha256`);
	const postDisposalChanged = boolean(trace.postDisposalChanged, `${label}.postDisposalChanged`);
	if (postDisposalSha256 === null && postDisposalChanged)
		fail(`${label}.postDisposalChanged has no post-disposal hash`);
	return {
		component: "TasksPaneComponent",
		theme: ATTENTION_WORKSPACE_CAPTURE_THEME,
		productionRender: true,
		noColorDisposition,
		beforeInteractionSha256,
		afterInteractionSha256,
		interactionChanged,
		postDisposalSha256,
		postDisposalChanged,
	};
}

function readEntry(value: unknown, label: string): AttentionWorkspaceCaptureEntry {
	const entry = object(value, label);
	const key = string(entry.key, `${label}.key`);
	const stateId = string(entry.stateId, `${label}.stateId`) as AttentionWorkspaceCaptureEntry["stateId"];
	if (!ATTENTION_WORKSPACE_EXPECTED_VISUAL_KEYS.some(expected => expected.startsWith(`${stateId}/`)))
		fail(`${label}.stateId is invalid`);
	const semanticStateId = string(
		entry.semanticStateId,
		`${label}.semanticStateId`,
	) as AttentionWorkspaceCaptureEntry["stateId"];
	if (semanticStateId !== stateId) fail(`${label}.semanticStateId does not match stateId`);
	const viewport = readViewport(entry.viewport, `${label}.viewport`);
	if (key !== `${stateId}/${viewport.id}`) fail(`${label}.key does not match stateId and viewport`);
	const flags = readFlags(entry.flags, `${label}.flags`);
	const lineStart = integer(entry.lineStart, `${label}.lineStart`);
	const lineCount = integer(entry.lineCount, `${label}.lineCount`);
	if (lineCount < 2) fail(`${label}.lineCount is too small`);
	const lineWidths = array(entry.lineWidths, `${label}.lineWidths`).map((item, index) =>
		integer(item, `${label}.lineWidths[${index}]`),
	);
	if (lineWidths.length !== lineCount) fail(`${label}.lineWidths length differs from lineCount`);
	const plainSha256 = sha(entry.plainSha256, `${label}.plainSha256`);
	const ansiSha256 = sha(entry.ansiSha256, `${label}.ansiSha256`);
	const semanticDetailHash = sha(entry.semanticDetailHash, `${label}.semanticDetailHash`);
	const component = string(entry.component, `${label}.component`);
	if (component !== "TasksPaneComponent") fail(`${label}.component is invalid`);
	const theme = string(entry.theme, `${label}.theme`);
	if (theme !== ATTENTION_WORKSPACE_CAPTURE_THEME) fail(`${label}.theme is invalid`);
	const productionRender = entry.productionRender === true;
	if (!productionRender) fail(`${label}.productionRender is false`);
	const renderTrace = readTrace(entry.renderTrace, `${label}.renderTrace`);
	const renderTraceHash = sha(entry.renderTraceHash, `${label}.renderTraceHash`);
	const actions = array(entry.actions, `${label}.actions`).map((item, index) => {
		const action = string(item, `${label}.actions[${index}]`);
		checkSafeText(`${label}.actions[${index}]`, action);
		if (!/^(?:render|selection|reveal|keyboard|ack|disposal|late-callback):[A-Za-z0-9_.-]+$/u.test(action))
			fail(`${label}.actions[${index}] has an invalid trace shape`);
		return action;
	});
	return {
		key,
		stateId,
		semanticStateId,
		semanticDetailHash,
		viewport,
		flags,
		lineStart,
		lineCount,
		lineWidths,
		plainSha256,
		ansiSha256,
		productionRender: true,
		component: "TasksPaneComponent",
		theme: ATTENTION_WORKSPACE_CAPTURE_THEME,
		renderTrace,
		renderTraceHash,
		actions,
	};
}

function expectedFlags(stateId: string): AttentionWorkspaceCaptureEntry["flags"] {
	return {
		noColor: stateId === "no-color-disposed",
		cjk: stateId === "cjk-long",
		disposal: stateId === "no-color-disposed",
	};
}

function requireAction(entry: AttentionWorkspaceCaptureEntry, action: string): void {
	if (!entry.actions.includes(action)) fail(`${entry.key} is missing action ${action}`);
}

function requireStatus(stateId: string, frame: readonly string[]): void {
	const text = frame.join("\n");
	if (stateId === "empty") {
		if (!text.includes("No tasks")) fail("empty state does not render the real No tasks item");
		return;
	}
	const expected =
		stateId === "reveal-stale"
			? "No tasks"
			: stateId === "running-bash" || stateId === "reveal-bash" || stateId === "no-color-disposed"
				? "Running"
				: stateId === "waiting-cron" ||
						stateId === "reveal-cron" ||
						stateId === "reveal-unavailable" ||
						stateId === "reveal-failed" ||
						stateId === "cjk-long"
					? "Waiting"
					: stateId === "done"
						? "Done"
						: stateId === "cancelled"
							? "Cancelled"
							: "Failed";
	if (!text.includes(expected)) fail(`${stateId} does not render its real ${expected} status row`);
}

function verifyActions(entry: AttentionWorkspaceCaptureEntry): void {
	requireAction(entry, "render:TasksPaneComponent");
	if (["reveal-bash", "reveal-cron", "reveal-unavailable", "reveal-stale", "reveal-failed"].includes(entry.stateId)) {
		requireAction(entry, "keyboard:Enter");
	}
	if (entry.stateId === "reveal-bash") requireAction(entry, "reveal:bash-owner");
	if (entry.stateId === "reveal-cron") requireAction(entry, "reveal:cron-owner");
	if (entry.stateId === "reveal-unavailable") requireAction(entry, "reveal:unavailable");
	if (entry.stateId === "reveal-stale") requireAction(entry, "reveal:stale");
	if (entry.stateId === "reveal-failed") requireAction(entry, "reveal:failed");
	if (entry.stateId === "ack-pending") {
		requireAction(entry, "keyboard:a");
		requireAction(entry, "ack:pending");
	}
	if (entry.stateId === "ack-failed") {
		requireAction(entry, "keyboard:a");
		requireAction(entry, "ack:failure");
	}
	if (entry.stateId === "no-color-disposed") {
		requireAction(entry, "disposal:TasksPaneComponent");
		requireAction(entry, "late-callback:ignored");
	}
}

export async function verifyAttentionWorkspaceShowcase(
	rootInput: string = ATTENTION_WORKSPACE_CAPTURE_DEFAULT_OUTPUT,
	options: VerifyAttentionWorkspaceShowcaseOptions = {},
): Promise<VerifyAttentionWorkspaceShowcaseSummary> {
	const root = path.resolve(rootInput);
	const repoRoot = path.resolve(options.repoRoot ?? ATTENTION_WORKSPACE_CAPTURE_DEFAULT_REPO_ROOT);
	let names: string[];
	try {
		names = (await fs.readdir(root)).sort();
	} catch {
		fail("bundle directory is unavailable");
	}
	const expectedFiles = [...ATTENTION_WORKSPACE_CAPTURE_FILES].sort();
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
	if (unsafeControl.test(files["terminal.html"])) fail("terminal.html contains unsafe controls");
	if (/\x1b/gu.test(files["terminal.html"])) fail("terminal.html contains ANSI controls");
	if (unsafeControl.test(files["terminal-ansi.txt"].replace(ansiSgr, "")))
		fail("terminal-ansi.txt contains non-SGR controls");
	if (Bun.stripANSI(files["terminal-ansi.txt"]) !== files["terminal.txt"])
		fail("plain and ANSI terminal surfaces differ");
	if (files["terminal-ansi.txt"].match(ansiSgr) === null) fail("terminal-ansi.txt has no production SGR styling");
	if (files["terminal.html"] !== ansiToHtml(files["terminal-ansi.txt"]))
		fail("terminal.html is not canonical ANSI HTML");

	const metadataRaw = object(readJson(files["metadata.json"], "metadata.json"), "metadata.json");
	const manifestRaw = object(readJson(files["manifest.json"], "manifest.json"), "manifest.json");
	if (
		metadataRaw.schema !== ATTENTION_WORKSPACE_VISUAL_CAPTURE_SCHEMA ||
		metadataRaw.version !== ATTENTION_WORKSPACE_VISUAL_CAPTURE_VERSION ||
		manifestRaw.schema !== ATTENTION_WORKSPACE_VISUAL_CAPTURE_SCHEMA ||
		manifestRaw.version !== ATTENTION_WORKSPACE_VISUAL_CAPTURE_VERSION
	)
		fail("schema/version mismatch");
	if (metadataRaw.captureTimestamp !== ATTENTION_WORKSPACE_CAPTURE_TIMESTAMP)
		fail("capture timestamp is not the fixed deterministic timestamp");
	if (
		metadataRaw.locale !== ATTENTION_WORKSPACE_CAPTURE_LOCALE ||
		metadataRaw.timezone !== ATTENTION_WORKSPACE_CAPTURE_TIMEZONE
	)
		fail("locale/timezone metadata mismatch");
	if (metadataRaw.seed !== ATTENTION_WORKSPACE_CAPTURE_SEED || metadataRaw.theme !== ATTENTION_WORKSPACE_CAPTURE_THEME)
		fail("seed/theme metadata mismatch");
	const metadataClosure = readSourceClosure(metadataRaw.sourceClosure, "metadata.sourceClosure");
	const manifestClosure = readSourceClosure(manifestRaw.sourceClosure, "manifest.sourceClosure");
	if (metadataClosure.sha256 !== manifestClosure.sha256) fail("metadata and manifest source closure hashes differ");
	for (const required of [
		"packages/coding-agent/src/modes/components/tasks-pane.ts",
		"packages/coding-agent/src/modes/components/dynamic-border.ts",
		"packages/coding-agent/src/modes/tasks-aggregator.ts",
		"packages/coding-agent/src/modes/attention-event-store.ts",
		"packages/coding-agent/src/modes/attention-reveal-routing.ts",
		"packages/coding-agent/src/modes/theme/theme.ts",
		"packages/coding-agent/src/modes/theme/defaults/index.ts",
		"packages/coding-agent/src/modes/theme/defaults/red-claw.json",
		"packages/coding-agent/scripts/capture-attention-workspace-showcase.ts",
		"packages/coding-agent/scripts/verify-attention-workspace-showcase.ts",
		"packages/coding-agent/test/attention-workspace-visual-capture.test.ts",
		"packages/coding-agent/test/attention-tasks-pane-source.test.ts",
	])
		if (!metadataClosure.files.includes(required)) fail(`source closure omits ${required}`);
	const currentClosure = await recomputeSourceClosure(repoRoot);
	if (currentClosure.sha256 !== metadataClosure.sha256) fail("source closure bytes do not match repository root");
	const sourceHash = string(metadataRaw.sourceHash, "metadata.sourceHash");
	if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(sourceHash)) fail("metadata.sourceHash is invalid");
	if (options.sourceHash !== undefined && sourceHash !== options.sourceHash)
		fail("sourceHash does not match verifier input");
	if (manifestRaw.sourceHash !== sourceHash) fail("metadata and manifest sourceHash differ");
	if (
		metadataRaw.expectedKeyCount !== ATTENTION_WORKSPACE_VISUAL_CAPTURE_COUNT ||
		manifestRaw.expectedKeyCount !== ATTENTION_WORKSPACE_VISUAL_CAPTURE_COUNT
	)
		fail("expected key count mismatch");
	const keys = array(metadataRaw.keys, "metadata.keys").map((value, index) =>
		string(value, `metadata.keys[${index}]`),
	);
	const manifestKeys = array(manifestRaw.keys, "manifest.keys").map((value, index) =>
		string(value, `manifest.keys[${index}]`),
	);
	exactKeys(keys, "metadata.keys");
	exactKeys(manifestKeys, "manifest.keys");
	if (JSON.stringify(keys) !== JSON.stringify(manifestKeys)) fail("metadata and manifest key order differs");
	const metadataEntries = array(metadataRaw.entries, "metadata.entries").map((value, index) =>
		readEntry(value, `metadata.entries[${index}]`),
	);
	const manifestEntries = array(manifestRaw.entries, "manifest.entries").map((value, index) =>
		readEntry(value, `manifest.entries[${index}]`),
	);
	if (
		metadataEntries.length !== ATTENTION_WORKSPACE_VISUAL_CAPTURE_COUNT ||
		manifestEntries.length !== metadataEntries.length
	)
		fail("entry count mismatch");
	if (JSON.stringify(metadataEntries) !== JSON.stringify(manifestEntries))
		fail("metadata and manifest entries differ");
	if (metadataEntries.some((entry, index) => entry.key !== keys[index])) fail("entry/key parity mismatch");

	const plainLines = files["terminal.txt"].split("\n");
	const ansiLines = files["terminal-ansi.txt"].split("\n");
	if (plainLines.length !== ansiLines.length) fail("plain and ANSI line counts differ");
	let expectedLineStart = 0;
	for (const entry of metadataEntries) {
		if (entry.lineStart !== expectedLineStart) fail(`frame ranges are not contiguous at ${entry.key}`);
		const plainFrame = plainLines.slice(entry.lineStart, entry.lineStart + entry.lineCount);
		const ansiFrame = ansiLines.slice(entry.lineStart, entry.lineStart + entry.lineCount);
		expectedLineStart += entry.lineCount;
		if (plainFrame.length !== entry.lineCount || ansiFrame.length !== entry.lineCount)
			fail(`frame range is incomplete for ${entry.key}`);
		if (plainFrame.some(line => visibleWidth(line) > entry.viewport.columns))
			fail(`terminal-cell width exceeded for ${entry.key}`);
		if (entry.lineWidths.some((width, index) => width !== visibleWidth(plainFrame[index] ?? "")))
			fail(`terminal-cell width metadata mismatch for ${entry.key}`);
		if (hash(plainFrame.join("\n")) !== entry.plainSha256) fail(`plain frame hash mismatch for ${entry.key}`);
		if (hash(ansiFrame.join("\n")) !== entry.ansiSha256) fail(`ANSI frame hash mismatch for ${entry.key}`);
		if (hash(`${entry.stateId}\0${plainFrame.join("\n")}`) !== entry.semanticDetailHash)
			fail(`semantic detail hash mismatch for ${entry.key}`);
		for (const line of plainFrame) checkSafeText(`${entry.key}.frame`, line);
		const tokenSet = new Set<string>();
		for (const line of ansiFrame)
			for (const match of line.matchAll(/\x1b\[([0-9;]*)m/gu)) tokenSet.add(match[1] ?? "");
		const expectedNoColorDisposition = entry.flags.noColor ? "ansi_stripped" : "native_color";
		if (entry.renderTrace.noColorDisposition !== expectedNoColorDisposition)
			fail(`no-color disposition mismatch for ${entry.key}`);
		if (entry.flags.noColor) {
			if (tokenSet.size > 0) fail(`no-color frame contains SGR for ${entry.key}`);
			if (ansiFrame.join("\n") !== plainFrame.join("\n")) fail(`no-color ANSI/plain mismatch for ${entry.key}`);
		} else if (tokenSet.size === 0) {
			fail(`colored production frame contains no SGR for ${entry.key}`);
		}
		if (entry.flags.cjk) {
			const text = plainFrame.join("\n");
			if (!cjk.test(text)) fail(`CJK evidence is absent for ${entry.key}`);
			if (!plainFrame.some(line => visibleWidth(line) > line.length))
				fail(`CJK cell-width evidence is absent for ${entry.key}`);
		}
		if (entry.renderTrace.afterInteractionSha256 !== entry.ansiSha256)
			fail(`after-interaction hash does not bind the captured frame for ${entry.key}`);
		if (entry.flags.disposal) {
			if (entry.renderTrace.postDisposalSha256 !== entry.ansiSha256)
				fail(`post-disposal hash does not bind the captured frame for ${entry.key}`);
			if (entry.renderTrace.postDisposalChanged !== false)
				fail(`late callback changed the disposed frame for ${entry.key}`);
		} else if (entry.renderTrace.postDisposalSha256 !== null || entry.renderTrace.postDisposalChanged !== false) {
			fail(`non-disposal entry carries post-disposal evidence for ${entry.key}`);
		}
		if (hash(JSON.stringify(entry.renderTrace)) !== entry.renderTraceHash)
			fail(`render trace hash mismatch for ${entry.key}`);
		if (entry.renderTrace.productionRender !== true) fail(`non-production render trace for ${entry.key}`);
		if (entry.productionRender !== true) fail(`non-production entry for ${entry.key}`);
		if (JSON.stringify(entry.flags) !== JSON.stringify(expectedFlags(entry.stateId)))
			fail(`state flags mismatch for ${entry.key}`);
		requireStatus(entry.stateId, plainFrame);
		verifyActions(entry);
	}
	if (expectedLineStart !== plainLines.length - 1) fail("frame ranges do not cover the terminal surface");

	const metadataHashes = object(metadataRaw.hashes, "metadata.hashes");
	for (const name of ["terminal.txt", "terminal-ansi.txt", "terminal.html"] as const) {
		if (hash(files[name]) !== sha(metadataHashes[name], `metadata.hashes.${name}`))
			fail(`metadata hash mismatch for ${name}`);
	}
	const manifestFiles = object(manifestRaw.files, "manifest.files");
	for (const name of ["terminal.txt", "terminal-ansi.txt", "terminal.html", "metadata.json"] as const) {
		const descriptor = object(manifestFiles[name], `manifest.files.${name}`);
		if (hash(files[name]) !== sha(descriptor.sha256, `manifest.files.${name}.sha256`))
			fail(`manifest hash mismatch for ${name}`);
		if (descriptor.byteLength !== Buffer.byteLength(files[name])) fail(`manifest byte length mismatch for ${name}`);
	}
	return { keyCount: keys.length, sourceHash, manifestSha256: hash(files["manifest.json"]) };
}

export const verifyAttentionWorkspaceShowcaseBundle = verifyAttentionWorkspaceShowcase;

function parseVerifyArgs(args: readonly string[]): VerifyAttentionWorkspaceShowcaseOptions & { root: string } {
	let root = ATTENTION_WORKSPACE_CAPTURE_DEFAULT_OUTPUT;
	let repoRoot = ATTENTION_WORKSPACE_CAPTURE_DEFAULT_REPO_ROOT;
	let sourceHash: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--root" || arg === "--output" || arg === "--out") root = args[++index] ?? root;
		else if (arg === "--repo-root") repoRoot = args[++index] ?? repoRoot;
		else if (arg === "--source-hash") sourceHash = args[++index];
		else throw new Error("Invalid attention workspace verifier arguments.");
	}
	return { root, repoRoot, sourceHash };
}

if (import.meta.main) {
	const parsed = parseVerifyArgs(process.argv.slice(2));
	const summary = await verifyAttentionWorkspaceShowcase(parsed.root, parsed);
	process.stdout.write(`Verified ${summary.keyCount} attention workspace visual keys.\n`);
}
