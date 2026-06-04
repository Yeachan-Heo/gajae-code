import { afterEach, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentProtocolHandler } from "../../src/internal-urls/agent-protocol";
import {
	assertNoRawTaskFields,
	buildTaskReceipt,
	findRawTaskLeakKeys,
	type RawTaskToolDetails,
	sanitizeTaskToolDetails,
	TASK_PREVIEW_MAX_BYTES,
	TASK_PREVIEW_MAX_LINES,
} from "../../src/task/receipt";
import type { SingleResult, TaskToolDetails } from "../../src/task/types";

const CANONICAL_USAGE = {
	input: 1,
	output: 2,
	cacheRead: 3,
	cacheWrite: 4,
	totalTokens: 10,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const tempDirs: string[] = [];

mock.module("../../src/internal-urls/registry-helpers", () => ({
	artifactsDirsFromRegistry: () => tempDirs,
}));

function makeRaw(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "0-Test",
		agent: "executor",
		agentSource: "bundled",
		task: "do work",
		assignment: "assignment",
		description: "description",
		exitCode: 0,
		output: "hello\nworld",
		stderr: "",
		truncated: false,
		durationMs: 10,
		tokens: 20,
		...overrides,
	};
}

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("task result receipts", () => {
	it("buildTaskReceipt omits banned keys, bounds preview, and exposes outputRef when metadata is present", () => {
		const output = Array.from({ length: TASK_PREVIEW_MAX_LINES + 5 }, (_, i) => `line ${i} ${"x".repeat(300)}`).join(
			"\n",
		);
		const sha256 = createHash("sha256").update(output).digest("hex");
		const receipt = buildTaskReceipt(
			makeRaw({
				id: "9-Agent",
				output,
				outputPath: "/tmp/9-Agent.md",
				outputMeta: {
					lineCount: output.split("\n").length,
					charCount: output.length,
					byteSize: Buffer.byteLength(output),
					sha256,
				},
				extractedToolData: {
					yield: [{ data: { overall_correctness: "patch is correct" } }],
					report_finding: [{ severity: "medium", summary: "finding summary" }],
				},
			}),
		);

		expect(receipt.previewTruncated).toBe(true);
		expect(Buffer.byteLength(receipt.preview)).toBeLessThanOrEqual(TASK_PREVIEW_MAX_BYTES);
		expect(receipt.preview.split("\n").length).toBeLessThanOrEqual(TASK_PREVIEW_MAX_LINES);
		expect(receipt.outputRef).toEqual({
			uri: "agent://9-Agent",
			sizeBytes: Buffer.byteLength(output),
			lineCount: output.split("\n").length,
			sha256,
		});
		expect(receipt.outputUnavailable).toBeUndefined();
		expect(receipt.review?.overallCorrectness).toBe("patch is correct");
		expect(receipt.review?.findingCount).toBe(1);
		expect(receipt.extractedToolCounts).toEqual({ yield: 1, report_finding: 1 });
		expect(findRawTaskLeakKeys(receipt)).toEqual([]);
	});

	it("buildTaskReceipt marks output unavailable when no artifact metadata is present", () => {
		const receipt = buildTaskReceipt(makeRaw());
		expect(receipt.outputRef).toBeUndefined();
		expect(receipt.outputUnavailable).toBe(true);
	});

	it("detects raw leak keys and allows sanitized receipt details without sentinel", () => {
		const leaky = {
			results: [
				{
					output: "LEAK_SENTINEL_DO_NOT_DIGEST",
					stderr: "LEAK_SENTINEL_DO_NOT_DIGEST",
					extractedToolData: { yield: [{ data: "LEAK_SENTINEL_DO_NOT_DIGEST" }] },
				},
			],
		};
		expect(findRawTaskLeakKeys(leaky)).toEqual(["extractedToolData", "output", "stderr"]);
		expect(() => assertNoRawTaskFields(leaky, "sentinel.surface")).toThrow(
			/sentinel\.surface.*extractedToolData.*output.*stderr/,
		);

		const sanitized: TaskToolDetails = { projectAgentsDir: null, results: [], totalDurationMs: 0 };
		expect(findRawTaskLeakKeys(sanitized)).toEqual([]);
		expect(JSON.stringify(sanitized)).not.toContain("LEAK_SENTINEL_DO_NOT_DIGEST");
		expect(() => assertNoRawTaskFields(sanitized, "clean.surface")).not.toThrow();
	});

	it("sanitizeTaskToolDetails maps raw results to receipts and preserves usage", () => {
		const raw: RawTaskToolDetails = {
			projectAgentsDir: null,
			results: [makeRaw()],
			totalDurationMs: 10,
			usage: CANONICAL_USAGE,
		};
		const sanitized = sanitizeTaskToolDetails(raw);
		expect(sanitized.usage).toBe(CANONICAL_USAGE);
		expect(sanitized.results[0]?.preview).toBe("hello\nworld");
		expect(findRawTaskLeakKeys(sanitized)).toEqual([]);
	});

	it("does not flag numeric output token counts on a canonical Usage record", () => {
		const receipt = buildTaskReceipt(makeRaw({ usage: CANONICAL_USAGE }));
		expect(receipt.usage?.output).toBe(2);
		expect(findRawTaskLeakKeys(receipt)).toEqual([]);
		expect(() => assertNoRawTaskFields(receipt, "receipt")).not.toThrow();
	});

	it("keeps the full raw output out of the receipt, exposing only a bounded preview", () => {
		const sentinel = "LEAK_SENTINEL_DO_NOT_DIGEST";
		const bigOutput = `head line\n${sentinel}${"A".repeat(64 * 1024)}`;
		const receipt = buildTaskReceipt(makeRaw({ output: bigOutput }));
		expect(Buffer.byteLength(receipt.preview)).toBeLessThanOrEqual(TASK_PREVIEW_MAX_BYTES);
		const serialized = JSON.stringify(receipt);
		expect(serialized.length).toBeLessThan(bigOutput.length);
		// The bulk 64KB run never survives beyond the bounded preview budget.
		expect(serialized).not.toContain("A".repeat(TASK_PREVIEW_MAX_BYTES + 1));
		expect(findRawTaskLeakKeys(receipt)).toEqual([]);
	});
});

describe("agent protocol metadata verification", () => {
	async function writeOutput(id: string, content: string): Promise<string> {
		const dir = await makeTempDir();
		const file = path.join(dir, `${id}.md`);
		const sha256 = createHash("sha256").update(content).digest("hex");
		await Bun.write(file, content);
		await Bun.write(
			`${file}.meta.json`,
			JSON.stringify({
				id,
				kind: "agent-output",
				sizeBytes: Buffer.byteLength(content),
				lineCount: content.split("\n").length,
				sha256,
				createdAt: new Date().toISOString(),
			}),
		);
		return file;
	}

	async function resolve(id: string) {
		return new AgentProtocolHandler().resolve(new URL(`agent://${id}`) as never);
	}

	it("resolves matching metadata and rejects hash and size mismatches", async () => {
		const file = await writeOutput("verify", "verified content");
		await expect(resolve("verify")).resolves.toMatchObject({ content: "verified content" });

		const meta = JSON.parse(await Bun.file(`${file}.meta.json`).text());
		await Bun.write(`${file}.meta.json`, JSON.stringify({ ...meta, sha256: "0".repeat(64) }));
		await expect(resolve("verify")).rejects.toThrow(/hash mismatch/);

		await Bun.write(`${file}.meta.json`, JSON.stringify({ ...meta, sizeBytes: meta.sizeBytes + 1 }));
		await expect(resolve("verify")).rejects.toThrow(/size mismatch/);
	});

	it("preserves legacy behavior when the sidecar is absent", async () => {
		const file = await writeOutput("legacy", "legacy content");
		await fs.rm(`${file}.meta.json`);
		await expect(resolve("legacy")).resolves.toMatchObject({ content: "legacy content" });
	});
});
