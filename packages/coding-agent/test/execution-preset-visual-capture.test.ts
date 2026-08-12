import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	captureExecutionPresetShowcase,
	EXECUTION_PRESET_CAPTURE_DEFAULT_REPO_ROOT,
	EXECUTION_PRESET_CAPTURE_FILES,
	EXECUTION_PRESET_SOURCE_CLOSURE_FILES,
	EXECUTION_PRESET_VISUAL_CAPTURE_COUNT,
	EXECUTION_PRESET_VISUAL_KEYS,
} from "../scripts/capture-execution-preset-showcase";
import {
	EXECUTION_PRESET_EXPECTED_VISUAL_KEYS,
	verifyExecutionPresetShowcase,
} from "../scripts/verify-execution-preset-showcase";

const SOURCE_HASH = "g005-visual-test-source-v1";
const roots: string[] = [];

const INDEPENDENT_VISUAL_KEY_ORACLE: readonly string[] = Object.freeze([
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

interface ParsedSourceClosure {
	files: string[];
	sha256: string;
}

interface ParsedFlags {
	cjk: boolean;
	noColor: boolean;
	disposal: boolean;
}

interface ParsedRenderTrace {
	component: string;
	theme: string;
	noColorDisposition: string;
	beforeInteractionSha256: string;
	afterInteractionSha256: string;
	postDisposalSha256: string | null;
	beforeDisposalSha256: string | null;
	callbackCountBeforeDisposal: number | null;
	callbackCountAfterDisposal: number | null;
	statusCountBeforeDisposal: number | null;
	statusCountAfterDisposal: number | null;
	requestRenderCountBeforeDisposal: number | null;
	requestRenderCountAfterDisposal: number | null;
	disposition: string;
	postDisposalChanged: boolean;
}

interface ParsedReceipt {
	status: string | null;
	reason: string | null;
	timing: string | null;
	durability: string | null;
	controllerRevision: number;
}

interface ParsedEntry {
	key: string;
	stateId: string;
	semanticStateId: string;
	productionRender: true;
	component: string;
	theme: string;
	flags: ParsedFlags;
	renderTrace: ParsedRenderTrace;
	receipt: ParsedReceipt;
	actions: string[];
}

interface ParsedMetadata {
	schema: string;
	version: number;
	sourceHash: string;
	theme: string;
	sourceClosure: ParsedSourceClosure;
	expectedKeyCount: number;
	keys: string[];
	entries: ParsedEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}
function isNullableInteger(value: unknown): value is number | null {
	return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

function isSourceClosure(value: unknown): value is ParsedSourceClosure {
	if (!isRecord(value)) return false;
	return isStringArray(value.files) && typeof value.sha256 === "string";
}

function isFlags(value: unknown): value is ParsedFlags {
	if (!isRecord(value)) return false;
	return typeof value.cjk === "boolean" && typeof value.noColor === "boolean" && typeof value.disposal === "boolean";
}

function isRenderTrace(value: unknown): value is ParsedRenderTrace {
	if (!isRecord(value)) return false;
	return (
		typeof value.component === "string" &&
		typeof value.theme === "string" &&
		typeof value.noColorDisposition === "string" &&
		typeof value.beforeInteractionSha256 === "string" &&
		typeof value.afterInteractionSha256 === "string" &&
		isNullableString(value.postDisposalSha256) &&
		isNullableString(value.beforeDisposalSha256) &&
		isNullableInteger(value.callbackCountBeforeDisposal) &&
		isNullableInteger(value.callbackCountAfterDisposal) &&
		isNullableInteger(value.statusCountBeforeDisposal) &&
		isNullableInteger(value.statusCountAfterDisposal) &&
		isNullableInteger(value.requestRenderCountBeforeDisposal) &&
		isNullableInteger(value.requestRenderCountAfterDisposal) &&
		typeof value.disposition === "string" &&
		typeof value.postDisposalChanged === "boolean"
	);
}

function isReceipt(value: unknown): value is ParsedReceipt {
	if (!isRecord(value)) return false;
	return (
		isNullableString(value.status) &&
		isNullableString(value.reason) &&
		isNullableString(value.timing) &&
		isNullableString(value.durability)
	);
}

function isEntry(value: unknown): value is ParsedEntry {
	if (!isRecord(value)) return false;
	return (
		typeof value.key === "string" &&
		typeof value.stateId === "string" &&
		value.semanticStateId === value.stateId &&
		value.productionRender === true &&
		typeof value.component === "string" &&
		typeof value.theme === "string" &&
		isFlags(value.flags) &&
		isRenderTrace(value.renderTrace) &&
		isReceipt(value.receipt) &&
		isStringArray(value.actions)
	);
}

function isMetadata(value: unknown): value is ParsedMetadata {
	if (!isRecord(value)) return false;
	return (
		typeof value.schema === "string" &&
		typeof value.version === "number" &&
		typeof value.sourceHash === "string" &&
		typeof value.theme === "string" &&
		isSourceClosure(value.sourceClosure) &&
		typeof value.expectedKeyCount === "number" &&
		isStringArray(value.keys) &&
		Array.isArray(value.entries) &&
		value.entries.every(isEntry)
	);
}

async function readMetadata(root: string): Promise<ParsedMetadata> {
	const parsed: unknown = JSON.parse(await Bun.file(path.join(root, "metadata.json")).text());
	if (!isMetadata(parsed)) throw new Error("Execution preset metadata shape is invalid.");
	return parsed;
}

async function copySourceClosure(repoRoot: string, destinationRoot: string): Promise<void> {
	for (const relativePath of EXECUTION_PRESET_SOURCE_CLOSURE_FILES) {
		const destination = path.join(destinationRoot, relativePath);
		await fs.mkdir(path.dirname(destination), { recursive: true });
		await fs.copyFile(path.join(repoRoot, relativePath), destination);
	}
}

function entriesFor(metadata: ParsedMetadata, stateId: string): ParsedEntry[] {
	return metadata.entries.filter(entry => entry.stateId === stateId);
}

function requireAction(entry: ParsedEntry, action: string): void {
	expect(entry.actions.includes(action)).toBe(true);
}

function expectActionForState(metadata: ParsedMetadata, stateId: string, action: string): void {
	const entries = entriesFor(metadata, stateId);
	expect(entries).toHaveLength(3);
	for (const entry of entries) requireAction(entry, action);
}

function expectForbiddenSurfacesAbsent(surfaces: readonly string[]): void {
	const forbidden = [
		"https://user:pass@example.test/private?token=top-secret",
		"/Users/private/credential.txt",
		"sk-test-secret-123",
	];
	for (const surface of surfaces) {
		for (const value of forbidden) expect(surface.includes(value)).toBe(false);
	}
}

afterEach(async () => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) await fs.rm(root, { recursive: true, force: true });
	}
});

describe("G005 execution preset visual capture", () => {
	test("captures the exact 48-key production matrix and independently verifies its evidence", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "g005-execution-preset-visual-"));
		roots.push(root);
		const repoRoot = EXECUTION_PRESET_CAPTURE_DEFAULT_REPO_ROOT;
		const manifest = await captureExecutionPresetShowcase(root, { repoRoot, sourceHash: SOURCE_HASH });
		const metadata = await readMetadata(root);

		expect(manifest.sourceHash).toBe(SOURCE_HASH);
		expect(manifest.expectedKeyCount).toBe(EXECUTION_PRESET_VISUAL_CAPTURE_COUNT);
		expect(manifest.keys).toHaveLength(48);
		expect(manifest.keys).toEqual(INDEPENDENT_VISUAL_KEY_ORACLE);
		expect(manifest.keys).toEqual(EXECUTION_PRESET_VISUAL_KEYS);
		expect(manifest.keys).toEqual(EXECUTION_PRESET_EXPECTED_VISUAL_KEYS);
		expect(manifest.entries).toHaveLength(48);
		expect(metadata.expectedKeyCount).toBe(48);
		expect(metadata.keys).toEqual([...INDEPENDENT_VISUAL_KEY_ORACLE]);
		expect(metadata.entries).toHaveLength(48);
		expect(metadata.sourceHash).toBe(SOURCE_HASH);
		expect(metadata.theme).toBe("red-claw");
		expect(metadata.sourceClosure.files).toEqual([...EXECUTION_PRESET_SOURCE_CLOSURE_FILES]);
		expect(metadata.sourceClosure.sha256).toBe(manifest.sourceClosure.sha256);

		for (const entry of metadata.entries) {
			expect(entry.key).toBe(`${entry.stateId}/${entry.key.split("/").at(-1)}`);
			expect(entry.semanticStateId).toBe(entry.stateId);
			expect(entry.productionRender).toBe(true);
			expect(entry.component).toBe("ExecutionPresetSelectorComponent");
			expect(entry.theme).toBe("red-claw");
			expect(entry.renderTrace.component).toBe("ExecutionPresetSelectorComponent");
			expect(entry.renderTrace.theme).toBe("red-claw");
			expect(entry.renderTrace.beforeInteractionSha256).toMatch(/^[0-9a-f]{64}$/u);
			expect(entry.renderTrace.afterInteractionSha256).toMatch(/^[0-9a-f]{64}$/u);
		}

		expect(metadata.entries.filter(entry => entry.flags.cjk)).toHaveLength(3);
		expect(metadata.entries.filter(entry => entry.flags.noColor)).toHaveLength(3);
		expect(metadata.entries.filter(entry => entry.flags.disposal)).toHaveLength(3);
		expect(entriesFor(metadata, "custom-cjk").every(entry => entry.flags.cjk)).toBe(true);
		expect(
			entriesFor(metadata, "no-color-disposed").every(entry => entry.flags.noColor && entry.flags.disposal),
		).toBe(true);
		expect(
			entriesFor(metadata, "no-color-disposed").every(
				entry => entry.renderTrace.noColorDisposition === "ansi_stripped",
			),
		).toBe(true);
		expect(
			entriesFor(metadata, "no-color-disposed").every(entry => entry.renderTrace.postDisposalChanged === false),
		).toBe(true);
		expect(
			entriesFor(metadata, "no-color-disposed").every(
				entry =>
					entry.renderTrace.disposition === "late_apply_cancelled" &&
					entry.renderTrace.beforeDisposalSha256 === entry.renderTrace.postDisposalSha256 &&
					entry.renderTrace.callbackCountBeforeDisposal === entry.renderTrace.callbackCountAfterDisposal &&
					entry.renderTrace.statusCountBeforeDisposal === entry.renderTrace.statusCountAfterDisposal &&
					entry.renderTrace.requestRenderCountBeforeDisposal === entry.renderTrace.requestRenderCountAfterDisposal,
			),
		).toBe(true);
		expect(
			entriesFor(metadata, "no-color-disposed").every(
				entry =>
					entry.receipt.status === "rejected" &&
					entry.receipt.reason === "cancelled" &&
					entry.receipt.controllerRevision === 0,
			),
		).toBe(true);
		expect(
			entriesFor(metadata, "no-color-disposed").every(
				entry =>
					JSON.stringify(entry.actions) ===
					JSON.stringify([
						"render:ExecutionPresetSelectorComponent",
						"keyboard:Enter",
						"keyboard:Enter",
						"apply:pending",
						"disposal:ExecutionPresetSelectorComponent",
						"late-receipt:cancelled",
					]),
			),
		).toBe(true);

		expectActionForState(metadata, "scope-cycle", "scope:project");
		expectActionForState(metadata, "scope-cycle", "scope:user");
		expectActionForState(metadata, "apply-session", "receipt:applied");
		expectActionForState(metadata, "apply-project-committed", "scope:project");
		expectActionForState(metadata, "apply-project-committed", "receipt:committed");
		expectActionForState(metadata, "apply-user-degraded", "scope:user");
		expectActionForState(metadata, "apply-user-degraded", "receipt:degraded");
		expectActionForState(metadata, "apply-conflict", "scope:user");
		expectActionForState(metadata, "apply-conflict", "receipt:conflict");
		expectActionForState(metadata, "stale-preview", "controller:apply-default");
		expectActionForState(metadata, "stale-preview", "receipt:preview_stale");
		expectActionForState(metadata, "delete-confirm", "delete:custom-cjk");

		const terminal = await Bun.file(path.join(root, "terminal.txt")).text();
		const ansiTerminal = await Bun.file(path.join(root, "terminal-ansi.txt")).text();
		const html = await Bun.file(path.join(root, "terminal.html")).text();
		expectForbiddenSurfacesAbsent([terminal, ansiTerminal, html]);
		for (const fileName of EXECUTION_PRESET_CAPTURE_FILES) {
			expect(await Bun.file(path.join(root, fileName)).size).toBeGreaterThan(15);
		}

		const summary = await verifyExecutionPresetShowcase(root, { repoRoot, sourceHash: SOURCE_HASH });
		expect(summary).toEqual({
			keyCount: 48,
			sourceHash: SOURCE_HASH,
			sourceClosureSha256: manifest.sourceClosure.sha256,
		});
	}, 60_000);

	test("rejects terminal and metadata/manifest relation tampering after each restoration", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "g005-execution-preset-tamper-"));
		roots.push(root);
		const repoRoot = EXECUTION_PRESET_CAPTURE_DEFAULT_REPO_ROOT;
		await captureExecutionPresetShowcase(root, { repoRoot, sourceHash: SOURCE_HASH });

		const terminalPath = path.join(root, "terminal.txt");
		const originalTerminal = await Bun.file(terminalPath).text();
		await Bun.write(terminalPath, `${originalTerminal}tampered terminal\n`);
		await expect(verifyExecutionPresetShowcase(root, { repoRoot, sourceHash: SOURCE_HASH })).rejects.toThrow();
		await Bun.write(terminalPath, originalTerminal);

		const metadataPath = path.join(root, "metadata.json");
		const originalMetadata = await Bun.file(metadataPath).text();
		const metadataTampered = originalMetadata.replace(
			`"sourceHash": "${SOURCE_HASH}"`,
			'"sourceHash": "metadata-tampered-source"',
		);
		expect(metadataTampered).not.toBe(originalMetadata);
		await Bun.write(metadataPath, metadataTampered);
		await expect(verifyExecutionPresetShowcase(root, { repoRoot, sourceHash: SOURCE_HASH })).rejects.toThrow();
		await Bun.write(metadataPath, originalMetadata);

		const manifestPath = path.join(root, "manifest.json");
		const originalManifest = await Bun.file(manifestPath).text();
		const manifestTampered = originalManifest.replace(
			`"sourceHash": "${SOURCE_HASH}"`,
			'"sourceHash": "manifest-tampered-source"',
		);
		expect(manifestTampered).not.toBe(originalManifest);
		await Bun.write(manifestPath, manifestTampered);
		await expect(verifyExecutionPresetShowcase(root, { repoRoot, sourceHash: SOURCE_HASH })).rejects.toThrow();
		await Bun.write(manifestPath, originalManifest);

		const restored = await verifyExecutionPresetShowcase(root, { repoRoot, sourceHash: SOURCE_HASH });
		expect(restored.keyCount).toBe(48);
		expect(restored.sourceHash).toBe(SOURCE_HASH);
	}, 60_000);

	test("rejects each independently modified copied source-closure tree and source-hash mismatch", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "g005-execution-preset-source-"));
		const copiedRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "g005-execution-preset-repo-copy-"));
		roots.push(root, copiedRepoRoot);
		const repoRoot = EXECUTION_PRESET_CAPTURE_DEFAULT_REPO_ROOT;
		await captureExecutionPresetShowcase(root, { repoRoot, sourceHash: SOURCE_HASH });
		await copySourceClosure(repoRoot, copiedRepoRoot);

		const baseline = await verifyExecutionPresetShowcase(root, {
			repoRoot: copiedRepoRoot,
			sourceHash: SOURCE_HASH,
		});
		expect(baseline.keyCount).toBe(48);
		expect(baseline.sourceHash).toBe(SOURCE_HASH);

		const selectorPath = "packages/coding-agent/src/modes/components/execution-preset-selector.ts";
		await fs.appendFile(path.join(copiedRepoRoot, selectorPath), "\nsource-closure-selector-tamper\n");
		await expect(
			verifyExecutionPresetShowcase(root, { repoRoot: copiedRepoRoot, sourceHash: SOURCE_HASH }),
		).rejects.toThrow();
		await fs.copyFile(path.join(repoRoot, selectorPath), path.join(copiedRepoRoot, selectorPath));

		const atomicYamlPatchPath = "packages/coding-agent/src/config/atomic-yaml-patch.ts";
		await fs.appendFile(
			path.join(copiedRepoRoot, atomicYamlPatchPath),
			"\nsource-closure-atomic-yaml-patch-tamper\n",
		);
		await expect(
			verifyExecutionPresetShowcase(root, { repoRoot: copiedRepoRoot, sourceHash: SOURCE_HASH }),
		).rejects.toThrow();
		await fs.copyFile(path.join(repoRoot, atomicYamlPatchPath), path.join(copiedRepoRoot, atomicYamlPatchPath));

		const fileLockPath = "packages/coding-agent/src/config/file-lock.ts";
		await fs.appendFile(path.join(copiedRepoRoot, fileLockPath), "\nsource-closure-file-lock-tamper\n");
		await expect(
			verifyExecutionPresetShowcase(root, { repoRoot: copiedRepoRoot, sourceHash: SOURCE_HASH }),
		).rejects.toThrow();
		await fs.copyFile(path.join(repoRoot, fileLockPath), path.join(copiedRepoRoot, fileLockPath));
		const dynamicBorderPath = "packages/coding-agent/src/modes/components/dynamic-border.ts";
		await fs.appendFile(path.join(copiedRepoRoot, dynamicBorderPath), "\nsource-closure-dynamic-border-tamper\n");
		await expect(
			verifyExecutionPresetShowcase(root, { repoRoot: copiedRepoRoot, sourceHash: SOURCE_HASH }),
		).rejects.toThrow();
		await fs.copyFile(path.join(repoRoot, dynamicBorderPath), path.join(copiedRepoRoot, dynamicBorderPath));

		const redClawPath = "packages/coding-agent/src/modes/theme/defaults/red-claw.json";
		await fs.appendFile(path.join(copiedRepoRoot, redClawPath), "\nsource-closure-red-claw-tamper\n");
		await expect(
			verifyExecutionPresetShowcase(root, { repoRoot: copiedRepoRoot, sourceHash: SOURCE_HASH }),
		).rejects.toThrow();
		await fs.copyFile(path.join(repoRoot, redClawPath), path.join(copiedRepoRoot, redClawPath));

		const restored = await verifyExecutionPresetShowcase(root, {
			repoRoot: copiedRepoRoot,
			sourceHash: SOURCE_HASH,
		});
		expect(restored.sourceClosureSha256).toBe(baseline.sourceClosureSha256);
		await expect(
			verifyExecutionPresetShowcase(root, { repoRoot: copiedRepoRoot, sourceHash: "wrong-source-hash" }),
		).rejects.toThrow();
	}, 60_000);
});
