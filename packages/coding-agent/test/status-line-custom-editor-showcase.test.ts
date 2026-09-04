import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	renderStatusLineCustomEditorShowcase,
	STATUS_LINE_CUSTOM_EDITOR_SHOWCASE_ENTRIES,
	STATUS_LINE_CUSTOM_EDITOR_SHOWCASE_EXPECTED_ENTRY_COUNT,
} from "./fixtures/tui/status-line-custom-editor-showcase";

describe("status line custom editor showcase", () => {
	it("defines unique canonical showcase entries", () => {
		const keys = STATUS_LINE_CUSTOM_EDITOR_SHOWCASE_ENTRIES.map(
			entry => `${entry.stateId}/${entry.columns}x${entry.rows}/${entry.renderMode}`,
		);
		expect(new Set(keys).size).toBe(STATUS_LINE_CUSTOM_EDITOR_SHOWCASE_EXPECTED_ENTRY_COUNT);
		expect(keys).toContain("root-statusbar/80x24/unicode-color");
		expect(keys).toContain("overflow-two-row-warning/48x36/unicode-color");
		expect(keys).toContain("option-numeric-choice-focused/80x24/ascii-no-color");
	});

	it("renders required editor witnesses from the production settings selector", async () => {
		const root = await renderStatusLineCustomEditorShowcase(STATUS_LINE_CUSTOM_EDITOR_SHOWCASE_ENTRIES[0]);
		const picked = await renderStatusLineCustomEditorShowcase({
			stateId: "picked-origin-slot",
			columns: 80,
			rows: 24,
			renderMode: "ascii-no-color",
		});
		const choice = await renderStatusLineCustomEditorShowcase({
			stateId: "separator-choice-focused",
			columns: 80,
			rows: 24,
			renderMode: "ascii-no-color",
		});
		const narrow = await renderStatusLineCustomEditorShowcase({
			stateId: "overflow-two-row-warning",
			columns: 48,
			rows: 36,
			renderMode: "ascii-no-color",
		});

		expect(Bun.stripANSI(root)).toContain("Simulated statusbar");
		expect(Bun.stripANSI(root)).not.toContain("Move left:");
		expect(picked).toContain("Selected: model");
		expect(picked).not.toContain("Floating ghost");
		expect(picked).not.toContain("Origin");
		expect(choice).toContain("Choices: Separator");
		expect(narrow).toContain("Warning: statusbar wrapped to 2 rows");
	});

	it("captures and verifies the deterministic artifact bundle", async () => {
		const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-status-line-showcase-"));
		try {
			const capture = Bun.spawnSync({
				cmd: [
					"bun",
					"packages/coding-agent/scripts/capture-status-line-custom-editor-showcase.ts",
					"--out",
					outputRoot,
				],
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(capture.exitCode).toBe(0);

			const verify = Bun.spawnSync({
				cmd: [
					"bun",
					"packages/coding-agent/scripts/verify-status-line-custom-editor-showcase.ts",
					"--root",
					outputRoot,
				],
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(verify.exitCode).toBe(0);

			const strictVerify = Bun.spawnSync({
				cmd: [
					"bun",
					"packages/coding-agent/scripts/verify-status-line-custom-editor-showcase.ts",
					"--root",
					outputRoot,
					"--require-independent-review",
				],
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(strictVerify.exitCode).not.toBe(0);
			expect(strictVerify.stderr.toString()).toContain("Missing approved independent review");
		} finally {
			await fs.rm(outputRoot, { recursive: true, force: true });
		}
	});
});
