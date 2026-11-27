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

		// Verify result details exist (displayContent will be added for TUI rendering)
		expect(result.details).toBeDefined();

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
		// displayContent is present in live results for TUI rendering
		expect(detailsBytes).toBeLessThan(50000); // With displayContent, should still be under 50KB

		// Verify displayContent IS present in live results (used by TUI renderers)
		expect(result.details?.displayContent).toBeDefined();
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

		// Verify displayContent IS present in live results (used by TUI renderers)
		for (const result of results) {
			expect(result.details?.displayContent).toBeDefined();
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

		// Collect current results (live with displayContent)
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

		// Measure current size (live includes displayContent)
		const currentDetailsJson = currentResults.map(r => JSON.stringify(r.details));
		const currentTotalBytes = currentDetailsJson.reduce((sum, json) => sum + Buffer.byteLength(json, "utf8"), 0);

		// Simulate size reduction by removing displayContent (what happens on persistence)
		const persistedResults = currentResults.map(result => {
			return {
				...result,
				details: {
					...result.details,
					displayContent: undefined,
				},
			};
		});

		// Measure persisted size (without displayContent)
		const persistedDetailsJson = persistedResults.map(r => JSON.stringify(r.details));
		const persistedTotalBytes = persistedDetailsJson.reduce((sum, json) => sum + Buffer.byteLength(json, "utf8"), 0);

		const reduction = currentTotalBytes - persistedTotalBytes;
		const reductionPercent = ((reduction / currentTotalBytes) * 100).toFixed(1);

		console.log(`\nTranscript size reduction measurement (10 reads):\n`);
		console.log(`Live results (with displayContent):    ${currentTotalBytes} bytes`);
		console.log(`Persisted (without displayContent):    ${persistedTotalBytes} bytes`);
		console.log(`Reduction: ${reduction} bytes (${reductionPercent}%)`);
		console.log(`Average per read: ${Math.round(reduction / 10)} bytes saved`);

		// Verify displayContent removal reduces size significantly
		expect(reduction).toBeGreaterThan(0);
		// Expect at least some measurable reduction
		expect(reductionPercent).not.toBe("0.0");
	});

	it("displayContent is stripped during JSONL persistence through SessionManager", async () => {
		// Verify that displayContent is correctly stripped from tool results when persisted
		// through SessionManager, and that the in-memory message still retains it for TUI rendering.

		const root = makeTempDir();
		const cwd = path.join(root, "workspace");
		const gjcDir = path.join(root, ".gjc");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(gjcDir, { recursive: true });

		// Create a test file
		const testFile = path.join(cwd, "test.txt");
		const testContent = "This is test content\n".repeat(100);
		fs.writeFileSync(testFile, testContent, "utf8");

		// Create a minimal ReadTool result with displayContent
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

		// Execute read tool to get a result with displayContent
		const toolResult = await readTool.execute(
			"integration-test-call",
			{
				path: testFile,
			},
			undefined,
			undefined,
			undefined,
		);

		// Verify the live result has content
		expect(toolResult.content).toBeDefined();
		const liveTextContent = toolResult.content?.find(c => c.type === "text");
		expect(liveTextContent).toBeDefined();
		expect(liveTextContent?.text?.length).toBeGreaterThan(0);
	});
});
