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
		const expectedKeys = new Set([
			...[
				"root-statusbar",
				"picked-origin-slot",
				"palette-exact-insert",
				"separator-control",
				"separator-choice-focused",
				"separator-choice-applied",
				"option-boolean-choice-focused",
				"option-enum-choice-focused",
				"option-numeric-choice-focused",
				"option-choice-applied",
				"exit-restored",
				"confirm-persisted",
				"overflow-two-row-warning",
			].map(state => `${state}/80x32/unicode-color`),
			"overflow-two-row-warning/48x40/unicode-color",
			"narrow-cjk/48x40/unicode-color",
			...[
				"root-statusbar",
				"picked-origin-slot",
				"separator-choice-focused",
				"option-boolean-choice-focused",
				"option-enum-choice-focused",
				"option-numeric-choice-focused",
			].map(state => `${state}/80x32/ascii-no-color`),
		]);
		expect(new Set(keys).size).toBe(STATUS_LINE_CUSTOM_EDITOR_SHOWCASE_EXPECTED_ENTRY_COUNT);
		expect(new Set(keys)).toEqual(expectedKeys);
	});

	it("renders required editor witnesses from the production settings selector", async () => {
		const root = await renderStatusLineCustomEditorShowcase(STATUS_LINE_CUSTOM_EDITOR_SHOWCASE_ENTRIES[0]);
		const picked = await renderStatusLineCustomEditorShowcase({
			stateId: "picked-origin-slot",
			columns: 80,
			rows: 32,
			renderMode: "ascii-no-color",
		});
		const choice = await renderStatusLineCustomEditorShowcase({
			stateId: "separator-choice-focused",
			columns: 80,
			rows: 32,
			renderMode: "ascii-no-color",
		});
		const narrow = await renderStatusLineCustomEditorShowcase({
			stateId: "overflow-two-row-warning",
			columns: 48,
			rows: 40,
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

			const manifestText = await Bun.file(path.join(outputRoot, "manifest.json")).text();
			const manifest = JSON.parse(manifestText) as { sourceHead: string; sourceHash: string; captureActor: string };
			const manifestSha256 = new Bun.CryptoHasher("sha256").update(manifestText).digest("hex");
			await Bun.write(
				path.join(outputRoot, "independent-review.json"),
				`${JSON.stringify(
					{
						reviewer: `${manifest.captureActor}-independent`,
						reviewerAssociation: "MEMBER",
						verdict: "approved",
						evidence: "https://github.com/Yeachan-Heo/gajae-code/pull/5278#pullrequestreview-1",
						manifestSha256,
						sourceHash: manifest.sourceHash,
						headSha: manifest.sourceHead,
					},
					null,
					2,
				)}\n`,
			);
			const approvedVerify = Bun.spawnSync({
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
			expect(approvedVerify.exitCode).toBe(0);
		} finally {
			await fs.rm(outputRoot, { recursive: true, force: true });
		}
	}, 15_000);
});
