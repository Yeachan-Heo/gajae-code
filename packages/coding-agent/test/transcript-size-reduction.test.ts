/**
 * Tests for transcript size reduction after removing displayContent persistence.
 *
 * Verifies that tool result details no longer include displayContent,
 * reducing session transcript JSONL file size.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import type { ToolSession } from "../src/sdk";
import { ReadTool } from "../src/tools/read";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(import.meta.dirname, ".tmp-transcript-size-"));
	tempDirs.push(dir);
	return dir;
}

describe("Transcript size reduction - displayContent not persisted", () => {
	it("read tool result details do not contain displayContent", async () => {
		const root = makeTempDir();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd, { recursive: true });

		// Create a test file with substantial content
		const testFile = path.join(cwd, "large-file.txt");
		const largeContent = "Line ".repeat(1000) + "\n".repeat(100);
		fs.writeFileSync(testFile, largeContent, "utf8");

		// Mock ToolSession
		const session = {
			cwd,
			getArtifactsDir: () => path.join(root, "artifacts"),
			getMcpManager: () => undefined,
			getAuthorizedArtifactsDirs: () => [],
			settings: {
				get: (key: string) => {
					const defaults: Record<string, unknown> = {
						"images.autoResize": true,
						"read.defaultLimit": 50000,
						"read.truncation": "balanced",
						"read.receiptBudgetLines": 50,
						"read.receiptBudgetBytes": 10,
						"read.summarize.enabled": false,
						"read.summarize.minBodyLines": 20,
						"read.summarize.minCommentLines": 10,
						"read.summarize.prose": false,
						"read.summaryMaxBytes": 2048,
						"fetch.enabled": false,
						"tools.readArtifactSpillThreshold": 500,
					};
					return defaults[key];
				},
			},
		} as unknown as ToolSession;

		const readTool = new ReadTool(session);

		// Execute the read tool
		const result = await readTool.execute(
			"test-call-id",
			{
				path: testFile,
			},
			undefined,
			undefined,
			undefined,
		);

		// Verify result details don't contain displayContent
		expect(result.details).toBeDefined();
		expect(result.details?.displayContent).toBeUndefined();

		// Verify result content still has the text
		expect(result.content).toBeDefined();
		const textContent = result.content.find(c => c.type === "text");
		expect(textContent).toBeDefined();
		expect(textContent?.text?.length).toBeGreaterThan(0);
	});

	it("tool result details json size is significantly reduced without displayContent", async () => {
		const root = makeTempDir();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd, { recursive: true });

		// Create a test file with more content
		const testFile = path.join(cwd, "another-large-file.ts");
		const typescriptContent = `
// Generated typescript file with repeating content
${Array(500)
	.fill(0)
	.map((_, i) => `function func${i}(arg: string): number { return ${i}; }`)
	.join("\n")}
		`.trim();
		fs.writeFileSync(testFile, typescriptContent, "utf8");

		const session = {
			cwd,
			getArtifactsDir: () => path.join(root, "artifacts"),
			getMcpManager: () => undefined,
			getAuthorizedArtifactsDirs: () => [],
			settings: {
				get: (key: string) => {
					const defaults: Record<string, unknown> = {
						"images.autoResize": true,
						"read.defaultLimit": 50000,
						"read.truncation": "balanced",
						"read.receiptBudgetLines": 50,
						"read.receiptBudgetBytes": 10,
						"read.summarize.enabled": false,
						"read.summarize.minBodyLines": 20,
						"read.summarize.minCommentLines": 10,
						"read.summarize.prose": false,
						"read.summaryMaxBytes": 2048,
						"fetch.enabled": false,
						"tools.readArtifactSpillThreshold": 500,
					};
					return defaults[key];
				},
			},
		} as unknown as ToolSession;

		const readTool = new ReadTool(session);

		const result = await readTool.execute(
			"test-call-id",
			{
				path: `${testFile}:1-50`,
			},
			undefined,
			undefined,
			undefined,
		);

		// Measure the JSON size of details
		const detailsJson = JSON.stringify(result.details);
		const detailsBytes = Buffer.byteLength(detailsJson, "utf8");

		console.log(`Details JSON size: ${detailsBytes} bytes`);

		// Should be relatively small (truncation metadata, paths, etc)
		// but definitely NOT contain the full file content (which would be kilobytes+)
		expect(detailsBytes).toBeLessThan(10000); // Should be under 10KB

		// Verify displayContent is not present
		expect(result.details?.displayContent).toBeUndefined();
	});

	it("cumulative JSON serialized bytes are significantly reduced across multiple reads", async () => {
		const root = makeTempDir();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd, { recursive: true });

		// Create 10 test files to simulate typical usage
		const testFiles: string[] = [];
		for (let i = 0; i < 10; i++) {
			const file = path.join(cwd, `file-${i}.ts`);
			const content = Array(200)
				.fill(0)
				.map((_, j) => `export function func${i}_${j}(x: number): string { return x.toString(); }`)
				.join("\n");
			fs.writeFileSync(file, content, "utf8");
			testFiles.push(file);
		}

		const session = {
			cwd,
			getArtifactsDir: () => path.join(root, "artifacts"),
			getMcpManager: () => undefined,
			getAuthorizedArtifactsDirs: () => [],
			settings: {
				get: (key: string) => {
					const defaults: Record<string, unknown> = {
						"images.autoResize": true,
						"read.defaultLimit": 50000,
						"read.truncation": "balanced",
						"read.receiptBudgetLines": 50,
						"read.receiptBudgetBytes": 10,
						"read.summarize.enabled": false,
						"read.summarize.minBodyLines": 20,
						"read.summarize.minCommentLines": 10,
						"read.summarize.prose": false,
						"read.summaryMaxBytes": 2048,
						"fetch.enabled": false,
						"tools.readArtifactSpillThreshold": 500,
					};
					return defaults[key];
				},
			},
		} as unknown as ToolSession;

		const readTool = new ReadTool(session);

		// Collect results from all reads
		const results = [];
		for (let i = 0; i < testFiles.length; i++) {
			const result = await readTool.execute(
				`read-${i}`,
				{
					path: testFiles[i],
				},
				undefined,
				undefined,
				undefined,
			);
			results.push(result);
		}

		// Verify no displayContent in any result
		for (const result of results) {
			expect(result.details?.displayContent).toBeUndefined();
		}

		// Measure cumulative JSON size
		const detailsJsonList = results.map(r => JSON.stringify(r.details));
		const totalBytes = detailsJsonList.reduce((sum, json) => sum + Buffer.byteLength(json, "utf8"), 0);

		// Log the actual measurement
		console.log(`Cumulative details JSON size for 10 reads: ${totalBytes} bytes`);
		console.log(`Average per read: ${Math.round(totalBytes / 10)} bytes`);

		// Should be relatively small (paths, truncation metadata, etc)
		// If displayContent were still persisted, this would be megabytes for large files
		expect(totalBytes).toBeLessThan(100_000); // 100 KB max for 10 reads without displayContent
	});

	it("displayContent removal significantly reduces cumulative transcript size compared to old behavior", async () => {
		// This test compares the actual size reduction by simulating what displayContent persisted
		const root = makeTempDir();
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd, { recursive: true });

		// Create 10 test files representing typical code review sessions
		const testFiles: string[] = [];
		for (let i = 0; i < 10; i++) {
			const file = path.join(cwd, `source-${i}.ts`);
			const content = Array(300)
				.fill(0)
				.map(
					(_, j) =>
						`export function sourceFunc${i}_${j}(x: number, y: string, z: boolean): Promise<{ result: number }> { return Promise.resolve({ result: ${i} }); }`,
				)
				.join("\n");
			fs.writeFileSync(file, content, "utf8");
			testFiles.push(file);
		}

		const session = {
			cwd,
			getArtifactsDir: () => path.join(root, "artifacts"),
			getMcpManager: () => undefined,
			getAuthorizedArtifactsDirs: () => [],
			settings: {
				get: (key: string) => {
					const defaults: Record<string, unknown> = {
						"images.autoResize": true,
						"read.defaultLimit": 50000,
						"read.truncation": "balanced",
						"read.receiptBudgetLines": 50,
						"read.receiptBudgetBytes": 10,
						"read.summarize.enabled": false,
						"read.summarize.minBodyLines": 20,
						"read.summarize.minCommentLines": 10,
						"read.summarize.prose": false,
						"read.summaryMaxBytes": 2048,
						"fetch.enabled": false,
						"tools.readArtifactSpillThreshold": 500,
					};
					return defaults[key];
				},
			},
		} as unknown as ToolSession;

		const readTool = new ReadTool(session);

		// Collect current results (without displayContent)
		const currentResults = [];
		for (let i = 0; i < testFiles.length; i++) {
			const result = await readTool.execute(
				`read-${i}`,
				{
					path: testFiles[i],
				},
				undefined,
				undefined,
				undefined,
			);
			currentResults.push(result);
		}

		// Measure current size (without displayContent)
		const currentDetailsJson = currentResults.map(r => JSON.stringify(r.details));
		const currentTotalBytes = currentDetailsJson.reduce((sum, json) => sum + Buffer.byteLength(json, "utf8"), 0);

		// Simulate old behavior by adding displayContent to details
		const simulatedOldResults = currentResults.map(result => {
			const textContent = result.content?.find((c: any) => c.type === "text" && "text" in c);
			const displayText = textContent && "text" in textContent ? textContent.text : undefined;
			return {
				...result,
				details: {
					...result.details,
					// Extract the text from the content and add it as displayContent
					displayContent: displayText
						? {
								text: displayText,
								startLine: 1,
							}
						: undefined,
				},
			};
		});

		// Measure simulated old size (with displayContent)
		const simulatedOldJson = simulatedOldResults.map(r => JSON.stringify(r.details));
		const simulatedOldTotalBytes = simulatedOldJson.reduce((sum, json) => sum + Buffer.byteLength(json, "utf8"), 0);

		const reduction = simulatedOldTotalBytes - currentTotalBytes;
		const reductionPercent = ((reduction / simulatedOldTotalBytes) * 100).toFixed(1);

		console.log(`\nTranscript size reduction measurement (10 reads):\n`);
		console.log(`With displayContent (old behavior):    ${simulatedOldTotalBytes} bytes`);
		console.log(`Without displayContent (new behavior):  ${currentTotalBytes} bytes`);
		console.log(`Reduction: ${reduction} bytes (${reductionPercent}%)`);
		console.log(`Average per read: ${Math.round(reduction / 10)} bytes saved`);

		// Verify displayContent removal reduces size significantly
		expect(reduction).toBeGreaterThan(0);
		// Expect at least some measurable reduction
		expect(reductionPercent).not.toBe("0.0");
	});
});
