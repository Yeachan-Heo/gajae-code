import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ATTENTION_WORKSPACE_CAPTURE_DEFAULT_REPO_ROOT,
	ATTENTION_WORKSPACE_CAPTURE_FILES,
	ATTENTION_WORKSPACE_SOURCE_CLOSURE_FILES,
	ATTENTION_WORKSPACE_VISUAL_CAPTURE_COUNT,
	ATTENTION_WORKSPACE_VISUAL_KEYS,
	captureAttentionWorkspaceShowcase,
} from "../scripts/capture-attention-workspace-showcase";
import {
	ATTENTION_WORKSPACE_EXPECTED_VISUAL_KEYS,
	verifyAttentionWorkspaceShowcase,
} from "../scripts/verify-attention-workspace-showcase";

const roots: string[] = [];

interface AttentionVisualMetadata {
	entries: Array<{
		key: string;
		productionRender: boolean;
		component: string;
		flags: { cjk: boolean; noColor: boolean; disposal: boolean };
		renderTrace: {
			noColorDisposition: "ansi_stripped" | "native_color";
			beforeInteractionSha256: string;
			postDisposalSha256: string | null;
			postDisposalChanged: boolean;
		};
		actions: string[];
	}>;
}

async function copySourceClosure(repoRoot: string, destinationRoot: string): Promise<void> {
	for (const relativePath of ATTENTION_WORKSPACE_SOURCE_CLOSURE_FILES) {
		const destination = path.join(destinationRoot, relativePath);
		await fs.mkdir(path.dirname(destination), { recursive: true });
		await fs.copyFile(path.join(repoRoot, relativePath), destination);
	}
}

afterEach(async () => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) await fs.rm(root, { recursive: true, force: true });
	}
});

describe("G004 attention workspace visual evidence", () => {
	test("captures and independently verifies the exact production 48-key matrix", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "g004-attention-workspace-"));
		roots.push(root);
		const repoRoot = ATTENTION_WORKSPACE_CAPTURE_DEFAULT_REPO_ROOT;
		const manifest = await captureAttentionWorkspaceShowcase(root, {
			repoRoot,
			sourceHash: "g004-visual-test-source",
		});
		expect(manifest.keys).toHaveLength(ATTENTION_WORKSPACE_VISUAL_CAPTURE_COUNT);
		expect(manifest.keys).toEqual(ATTENTION_WORKSPACE_VISUAL_KEYS);
		expect(manifest.keys).toEqual(ATTENTION_WORKSPACE_EXPECTED_VISUAL_KEYS);
		expect(manifest.entries).toHaveLength(ATTENTION_WORKSPACE_VISUAL_CAPTURE_COUNT);
		expect(manifest.entries.every(entry => entry.productionRender === true)).toBe(true);
		expect(manifest.entries.every(entry => entry.renderTrace.component === "TasksPaneComponent")).toBe(true);
		expect(manifest.entries.every(entry => entry.renderTrace.theme === "red-claw")).toBe(true);
		expect(ATTENTION_WORKSPACE_SOURCE_CLOSURE_FILES).toContain(
			"packages/coding-agent/src/modes/components/dynamic-border.ts",
		);
		expect(manifest.entries.some(entry => entry.flags.cjk)).toBe(true);
		expect(manifest.entries.some(entry => entry.flags.noColor)).toBe(true);
		expect(manifest.entries.some(entry => entry.flags.disposal)).toBe(true);
		for (const fileName of ATTENTION_WORKSPACE_CAPTURE_FILES)
			expect(await Bun.file(path.join(root, fileName)).size).toBeGreaterThan(15);
		const metadata = JSON.parse(await Bun.file(path.join(root, "metadata.json")).text()) as AttentionVisualMetadata;
		expect(
			metadata.entries.every(
				entry => entry.key.includes("/80x24") || entry.key.includes("/120x36") || entry.key.includes("/160x48"),
			),
		).toBe(true);
		expect(metadata.entries.filter(entry => entry.flags.cjk)).toHaveLength(3);
		expect(metadata.entries.filter(entry => entry.flags.noColor)).toHaveLength(3);
		expect(metadata.entries.filter(entry => entry.flags.disposal)).toHaveLength(3);
		expect(
			metadata.entries
				.filter(entry => entry.flags.noColor)
				.every(entry => entry.renderTrace.noColorDisposition === "ansi_stripped"),
		).toBe(true);
		const disposalEntries = metadata.entries.filter(entry => entry.flags.disposal);
		expect(
			disposalEntries.every(
				entry =>
					entry.renderTrace.postDisposalSha256 === entry.renderTrace.beforeInteractionSha256 &&
					entry.renderTrace.postDisposalChanged === false,
			),
		).toBe(true);
		expect(
			metadata.entries
				.filter(entry => !entry.flags.noColor)
				.every(entry => entry.renderTrace.noColorDisposition === "native_color"),
		).toBe(true);
		expect(
			metadata.entries
				.filter(entry => entry.key.startsWith("ack-pending/"))
				.every(entry => entry.actions.includes("keyboard:a")),
		).toBe(true);
		const summary = await verifyAttentionWorkspaceShowcase(root, {
			repoRoot,
			sourceHash: "g004-visual-test-source",
		});
		expect(summary.keyCount).toBe(ATTENTION_WORKSPACE_VISUAL_CAPTURE_COUNT);
		expect(summary.sourceHash).toBe("g004-visual-test-source");
	}, 60_000);

	test("rejects terminal, metadata, and source-hash tampering", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "g004-attention-workspace-tamper-"));
		roots.push(root);
		const repoRoot = ATTENTION_WORKSPACE_CAPTURE_DEFAULT_REPO_ROOT;
		const sourceHash = "g004-tamper-source";
		await captureAttentionWorkspaceShowcase(root, { repoRoot, sourceHash });
		const terminalPath = path.join(root, "terminal.txt");
		const originalTerminal = await Bun.file(terminalPath).text();
		await Bun.write(terminalPath, `${originalTerminal}tampered`);
		await expect(verifyAttentionWorkspaceShowcase(root, { repoRoot, sourceHash })).rejects.toThrow();
		await Bun.write(terminalPath, originalTerminal);

		const metadataPath = path.join(root, "metadata.json");
		const originalMetadata = await Bun.file(metadataPath).text();
		await Bun.write(metadataPath, originalMetadata.replace('"theme": "red-claw"', '"theme": "tampered"'));
		await expect(verifyAttentionWorkspaceShowcase(root, { repoRoot, sourceHash })).rejects.toThrow();
		await Bun.write(metadataPath, originalMetadata);
		await expect(verifyAttentionWorkspaceShowcase(root, { repoRoot, sourceHash: "wrong-source" })).rejects.toThrow();
	}, 60_000);

	test("rejects a modified copied source closure root", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "g004-attention-workspace-source-"));
		const copiedRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "g004-attention-workspace-repo-copy-"));
		roots.push(root, copiedRepoRoot);
		const repoRoot = ATTENTION_WORKSPACE_CAPTURE_DEFAULT_REPO_ROOT;
		const sourceHash = "g004-source-closure";
		await captureAttentionWorkspaceShowcase(root, { repoRoot, sourceHash });
		await copySourceClosure(repoRoot, copiedRepoRoot);
		const themeFile = "packages/coding-agent/src/modes/theme/defaults/red-claw.json";
		await fs.appendFile(path.join(copiedRepoRoot, themeFile), "\nmodified source closure\n");
		await expect(verifyAttentionWorkspaceShowcase(root, { repoRoot: copiedRepoRoot, sourceHash })).rejects.toThrow();
	}, 60_000);
});
