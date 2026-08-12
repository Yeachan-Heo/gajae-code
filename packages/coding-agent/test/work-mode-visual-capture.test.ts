import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	captureWorkModeVisualShowcase,
	WORK_MODE_CAPTURE_DEFAULT_REPO_ROOT,
	WORK_MODE_CAPTURE_FILES,
	WORK_MODE_SOURCE_CLOSURE_FILES,
	WORK_MODE_SUPPLEMENTAL_IDS,
	WORK_MODE_VISUAL_CAPTURE_COUNT,
} from "../scripts/capture-work-mode-showcase";
import { verifyWorkModeVisualShowcase, WORK_MODE_EXPECTED_VISUAL_KEYS } from "../scripts/verify-work-mode-showcase";
import { CURATED_WORK_MODES } from "../src/config/work-mode-catalog";

const roots: string[] = [];

async function sourceClosureHash(repoRoot: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for (const relativePath of WORK_MODE_SOURCE_CLOSURE_FILES) {
		hasher.update(relativePath);
		hasher.update("\0");
		hasher.update(await fs.readFile(path.join(repoRoot, relativePath)));
	}
	return hasher.digest("hex");
}

afterEach(async () => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) await fs.rm(root, { recursive: true, force: true });
	}
});

describe("Work Mode G002.5 visual capture", () => {
	test("captures and verifies the complete deterministic 107-key adapter matrix", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "g0025-work-mode-"));
		roots.push(root);
		const sourceHash = "g0025-test-source";
		const repoRoot = WORK_MODE_CAPTURE_DEFAULT_REPO_ROOT;
		const manifest = await captureWorkModeVisualShowcase(root, { repoRoot, sourceHash });
		expect(manifest.keys).toHaveLength(WORK_MODE_VISUAL_CAPTURE_COUNT);
		expect(new Set(manifest.keys).size).toBe(WORK_MODE_VISUAL_CAPTURE_COUNT);
		expect(manifest.keys).toEqual(WORK_MODE_EXPECTED_VISUAL_KEYS);
		expect(manifest.entries).toHaveLength(WORK_MODE_VISUAL_CAPTURE_COUNT);
		expect(manifest.sourceClosure.files).toEqual(WORK_MODE_SOURCE_CLOSURE_FILES);
		expect(manifest.sourceClosure.files).toContain("packages/coding-agent/src/modes/components/model-selector.ts");
		expect(manifest.sourceClosure.files).toContain("packages/coding-agent/src/modes/theme/theme.ts");
		expect(manifest.sourceClosure.files).toContain("packages/coding-agent/src/modes/theme/defaults/index.ts");
		expect(manifest.sourceClosure.files).toContain("packages/coding-agent/src/modes/theme/defaults/red-claw.json");

		expect(manifest.sourceClosure.sha256).toMatch(/^[0-9a-f]{64}$/u);
		expect(manifest.sourceClosure.sha256).toBe(await sourceClosureHash(repoRoot));
		for (const fileName of WORK_MODE_CAPTURE_FILES) {
			expect(await Bun.file(path.join(root, fileName)).size).toBeGreaterThan(15);
		}
		const metadata = JSON.parse(await Bun.file(path.join(root, "metadata.json")).text()) as {
			entries: Array<{
				key: string;
				stateId: string;
				semanticStateId: string;
				semanticDetailHash: string;
				viewport: { id: string; columns: number; rows: number };
				flags: {
					noColor: boolean;
					cjk: boolean;
					focus: boolean;
					scroll: boolean;
					keyboard: boolean;
					mouse: boolean;
					disposal: boolean;
					colorBlindDisposition: string;
				};
				lineStart: number;
				lineCount: number;
				plainSha256: string;
				ansiSha256: string;
				productionRender: boolean;
				renderTraceHash: string;
				renderTrace: {
					component: string;
					theme: string;
					colorBlind: boolean;
					ansiTokenColorSet: string[];
					ansiTokenColorSetHash: string;
					beforeInteractionSha256: string;
					afterInteractionSha256: string;
					interactionChanged: boolean;
					sourceToken: "toolDiffAdded" | null;
					reason: "settings.colorBlindMode" | null;
				};
				actions: string[];
			}>;
			sourceClosure: { files: readonly string[]; sha256: string };
		};
		expect(metadata.sourceClosure).toEqual(manifest.sourceClosure);
		expect(metadata.entries.every(entry => entry.productionRender === true)).toBe(true);
		expect(metadata.entries.every(entry => entry.semanticStateId === entry.stateId)).toBe(true);
		expect(metadata.entries.every(entry => /^[0-9a-f]{64}$/u.test(entry.semanticDetailHash))).toBe(true);
		expect(metadata.entries.every(entry => /^[0-9a-f]{64}$/u.test(entry.plainSha256))).toBe(true);
		expect(metadata.entries.every(entry => /^[0-9a-f]{64}$/u.test(entry.ansiSha256))).toBe(true);
		expect(metadata.entries.every(entry => /^[0-9a-f]{64}$/u.test(entry.renderTraceHash))).toBe(true);
		expect(metadata.entries.every(entry => entry.key === `${entry.stateId}/${entry.viewport.id}`)).toBe(true);
		expect(metadata.entries.every(entry => entry.renderTrace.component === "ModelSelectorComponent")).toBe(true);
		expect(metadata.entries.every(entry => entry.renderTrace.theme === "red-claw")).toBe(true);
		expect(
			metadata.entries.every(
				entry =>
					entry.renderTrace.interactionChanged ===
					(entry.renderTrace.beforeInteractionSha256 !== entry.renderTrace.afterInteractionSha256),
			),
		).toBe(true);
		const colorBlindEntries = metadata.entries.filter(entry => entry.flags.colorBlindDisposition !== "none");
		expect(colorBlindEntries).toHaveLength(3);
		expect(colorBlindEntries.every(entry => entry.renderTrace.colorBlind === true)).toBe(true);
		expect(colorBlindEntries.every(entry => entry.renderTrace.sourceToken === "toolDiffAdded")).toBe(true);
		expect(colorBlindEntries.every(entry => entry.renderTrace.reason === "settings.colorBlindMode")).toBe(true);
		expect(colorBlindEntries.every(entry => entry.renderTrace.ansiTokenColorSet.length > 0)).toBe(true);
		expect(new Set(colorBlindEntries.map(entry => entry.renderTraceHash)).size).toBe(1);
		const firstColorBlindTrace = colorBlindEntries[0]?.renderTrace;
		expect(colorBlindEntries.map(entry => entry.renderTrace)).toEqual(
			colorBlindEntries.map(() => firstColorBlindTrace),
		);
		expect(
			metadata.entries
				.filter(entry => entry.flags.colorBlindDisposition === "none")
				.every(
					entry =>
						entry.renderTrace.colorBlind === false &&
						entry.renderTrace.sourceToken === null &&
						entry.renderTrace.reason === null,
				),
		).toBe(true);

		for (const supplemental of WORK_MODE_SUPPLEMENTAL_IDS) {
			expect(metadata.entries.some(entry => entry.stateId === supplemental)).toBe(true);
		}
		expect(metadata.entries.some(entry => entry.flags.noColor === true)).toBe(true);
		expect(metadata.entries.some(entry => entry.flags.cjk === true)).toBe(true);
		expect(metadata.entries.some(entry => entry.flags.focus === true)).toBe(true);
		expect(metadata.entries.some(entry => entry.flags.scroll === true)).toBe(true);
		expect(metadata.entries.some(entry => entry.flags.keyboard === true)).toBe(true);
		expect(metadata.entries.some(entry => entry.flags.mouse === true)).toBe(true);
		expect(metadata.entries.some(entry => entry.flags.disposal === true)).toBe(true);
		expect(metadata.entries.some(entry => entry.flags.colorBlindDisposition !== "none")).toBe(true);
		const terminal = await Bun.file(path.join(root, "terminal.txt")).text();
		const terminalLines = terminal.split("\n");
		const syntheticWorkModeLabel = /^\s*Work Mode · [^·]+ · \d+x\d+\s*$/u;
		for (const entry of metadata.entries) {
			const frame = terminalLines.slice(entry.lineStart, entry.lineStart + entry.lineCount);
			expect(frame).toHaveLength(entry.lineCount);
			expect(frame.some(line => line.includes("Model & Work Modes"))).toBe(true);
			for (const mode of CURATED_WORK_MODES) {
				expect(frame.some(line => line.includes(`${mode.label} —`))).toBe(true);
			}
			expect(frame.some(line => syntheticWorkModeLabel.test(line))).toBe(false);
			if (entry.stateId === "preview-unavailable") {
				expect(frame.some(line => /^\s*State: unavailable\b/u.test(line))).toBe(true);
				expect(frame.some(line => /^\s*Recovery: Authenticate a required provider\s*$/u.test(line))).toBe(true);
			}
			if (entry.stateId === "preview-degraded") {
				expect(frame.some(line => /^\s*State: degraded \(confirmation required\)\s*$/u.test(line))).toBe(true);
				expect(frame.some(line => /^\s*Degraded planner: role_unresolved\s*$/u.test(line))).toBe(true);
				expect(frame.some(line => /^\s*Degraded critic: role_unresolved\s*$/u.test(line))).toBe(true);
			}
			for (const action of entry.actions)
				expect(action).toMatch(/^(?:preview|scope|focus|scroll|keyboard|mouse|disposal|render):.+$/u);
			if (entry.renderTrace.interactionChanged) expect(entry.actions.length).toBeGreaterThan(0);
			if (entry.flags.focus) expect(entry.actions.some(action => action.startsWith("focus:"))).toBe(true);
			if (entry.flags.scroll) expect(entry.actions.some(action => action.startsWith("scroll:"))).toBe(true);
			if (entry.flags.keyboard) expect(entry.actions.some(action => action.startsWith("keyboard:"))).toBe(true);
			if (entry.flags.mouse) expect(entry.actions.some(action => action.startsWith("mouse:"))).toBe(true);
			if (entry.flags.disposal) expect(entry.actions.some(action => action.startsWith("disposal:"))).toBe(true);
		}
		const summary = await verifyWorkModeVisualShowcase(root, { repoRoot, sourceHash });
		expect(summary.keyCount).toBe(WORK_MODE_VISUAL_CAPTURE_COUNT);
		expect(summary.sourceHash).toBe(sourceHash);
	}, 60_000);

	test("rejects tampered terminal bytes and source-hash mismatches", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "g0025-work-mode-tamper-"));
		roots.push(root);
		const repoRoot = WORK_MODE_CAPTURE_DEFAULT_REPO_ROOT;
		await captureWorkModeVisualShowcase(root, { repoRoot, sourceHash: "g0025-tamper-source" });
		const plainPath = path.join(root, "terminal.txt");
		const original = await Bun.file(plainPath).text();
		await Bun.write(plainPath, `${original}tampered`);
		await expect(
			verifyWorkModeVisualShowcase(root, { repoRoot, sourceHash: "g0025-tamper-source" }),
		).rejects.toThrow();
		await Bun.write(plainPath, original);
		const metadataPath = path.join(root, "metadata.json");
		const metadataText = await Bun.file(metadataPath).text();
		await Bun.write(
			metadataPath,
			metadataText.replace(/"renderTraceHash": "[^"]+"/u, '"renderTraceHash": "fake-trace"'),
		);
		await expect(
			verifyWorkModeVisualShowcase(root, { repoRoot, sourceHash: "g0025-tamper-source" }),
		).rejects.toThrow();
		await Bun.write(metadataPath, metadataText);
		await expect(verifyWorkModeVisualShowcase(root, { repoRoot, sourceHash: "different-source" })).rejects.toThrow();
	}, 60_000);

	test("rejects a modified copied source-closure repository root", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "g0025-work-mode-source-closure-"));
		roots.push(root);
		const copiedRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "g0025-work-mode-repo-copy-"));
		roots.push(copiedRepoRoot);
		const repoRoot = WORK_MODE_CAPTURE_DEFAULT_REPO_ROOT;
		const sourceHash = "g0025-source-closure-source";
		await captureWorkModeVisualShowcase(root, { repoRoot, sourceHash });
		for (const relativePath of WORK_MODE_SOURCE_CLOSURE_FILES) {
			const destination = path.join(copiedRepoRoot, relativePath);
			await fs.mkdir(path.dirname(destination), { recursive: true });
			await fs.copyFile(path.join(repoRoot, relativePath), destination);
		}
		const catalogFile = WORK_MODE_SOURCE_CLOSURE_FILES.find(file => file.endsWith("/work-mode-catalog.ts"));
		if (!catalogFile) throw new Error("Work Mode source closure catalog test file is unavailable.");
		await fs.appendFile(path.join(copiedRepoRoot, catalogFile), "\nmodified source closure\n");
		await expect(verifyWorkModeVisualShowcase(root, { repoRoot: copiedRepoRoot, sourceHash })).rejects.toThrow();
		await fs.copyFile(path.join(repoRoot, catalogFile), path.join(copiedRepoRoot, catalogFile));
		const profileFile = WORK_MODE_SOURCE_CLOSURE_FILES.find(file => file.endsWith("/model-profiles.ts"));
		if (!profileFile) throw new Error("Work Mode source closure model profile test file is unavailable.");
		await fs.appendFile(path.join(copiedRepoRoot, profileFile), "\nmodified model profile source closure\n");
		await expect(verifyWorkModeVisualShowcase(root, { repoRoot: copiedRepoRoot, sourceHash })).rejects.toThrow();
		await fs.copyFile(path.join(repoRoot, profileFile), path.join(copiedRepoRoot, profileFile));
		const redClawFile = WORK_MODE_SOURCE_CLOSURE_FILES.find(file => file.endsWith("/theme/defaults/red-claw.json"));
		if (!redClawFile) throw new Error("Work Mode source closure red-claw theme file is unavailable.");
		await fs.appendFile(path.join(copiedRepoRoot, redClawFile), "\nmodified red-claw theme source closure\n");
		await expect(verifyWorkModeVisualShowcase(root, { repoRoot: copiedRepoRoot, sourceHash })).rejects.toThrow();
	}, 60_000);
});
