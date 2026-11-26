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
			settings: { readTruncation: "none" as const },
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
			settings: { readTruncation: "none" as const },
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
});
