import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentProtocolHandler } from "../../src/internal-urls/agent-protocol";
import { ArtifactProtocolHandler } from "../../src/internal-urls/artifact-protocol";
import { buildTaskReceipt, findRawTaskLeakKeys } from "../../src/task/receipt";
import type { SingleResult, TaskToolDetails } from "../../src/task/types";

const authorizedDirs: string[] = [];
const LEAK_SENTINEL = "LEAK_SENTINEL_DO_NOT_DIGEST";

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lifecycle-resolver-test-"));
	authorizedDirs.push(dir);
	return dir;
}

async function writeAgentOutput(dir: string, id: string, content: string): Promise<string> {
	const file = path.join(dir, `${id}.md`);
	const bytes = Buffer.from(content, "utf8");
	await Bun.write(file, bytes);
	await Bun.write(
		`${file}.meta.json`,
		JSON.stringify({
			id,
			kind: "agent-output",
			sizeBytes: bytes.byteLength,
			lineCount: content.split("\n").length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			createdAt: new Date().toISOString(),
		}),
	);
	return file;
}

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
		output: "receipt preview",
		stderr: "",
		truncated: false,
		durationMs: 10,
		tokens: 20,
		...overrides,
	};
}

function resolveContext(dir = authorizedDirs[0]) {
	return { getArtifactsDir: () => dir ?? null, getAuthorizedArtifactsDirs: () => authorizedDirs };
}

function resolveAgent(id: string, dir?: string) {
	return new AgentProtocolHandler().resolve(new URL(`agent://${id}`) as never, resolveContext(dir));
}

function resolveArtifact(id: string, dir?: string) {
	return new ArtifactProtocolHandler().resolve(new URL(`artifact://${id}`) as never, resolveContext(dir));
}

afterEach(async () => {
	while (authorizedDirs.length > 0) {
		const dir = authorizedDirs.pop()!;
		await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("lifecycle resolver hardening", () => {
	it("resolves a registered resumed-session agent output only through explicit agent:// with metadata verification", async () => {
		const dir = await makeTempDir();
		const content = "full resumed output\nkept outside default receipt";
		const file = await writeAgentOutput(dir, "18-Resume", content);
		const raw = makeRaw({
			id: "18-Resume",
			output: content,
			outputPath: file,
			outputMeta: {
				lineCount: content.split("\n").length,
				charCount: content.length,
				byteSize: Buffer.byteLength(content),
				sha256: createHash("sha256").update(content).digest("hex"),
			},
		});

		const receipt = buildTaskReceipt(raw);
		expect(receipt.outputRef?.uri).toBe("agent://18-Resume");
		expect(receipt.preview).toBe("Task completed; output stored in agent://18-Resume (2 lines, 48 bytes).");
		expect(receipt.outputRef).toMatchObject({ sizeBytes: Buffer.byteLength(content), lineCount: 2 });
		await expect(resolveAgent("18-Resume")).resolves.toMatchObject({ content });

		await Bun.write(`${file}.meta.json`, JSON.stringify({ id: "18-Resume", kind: "agent-output" }));
		await expect(resolveAgent("18-Resume")).rejects.toThrow(/malformed metadata/);
	});

	it("fails closed instead of serving a first match when two sessions contain the same agent output id", async () => {
		const first = await makeTempDir();
		const second = await makeTempDir();
		await writeAgentOutput(first, "42-Collision", `first ${LEAK_SENTINEL}`);
		await writeAgentOutput(second, "42-Collision", "second verified content");

		await expect(resolveAgent("42-Collision")).rejects.toThrow(/ambiguous id/);
	});

	it("fails closed instead of serving a first numeric-prefix artifact match across sessions", async () => {
		const first = await makeTempDir();
		const second = await makeTempDir();
		await Bun.write(path.join(first, "7.bash.log"), `first ${LEAK_SENTINEL}`);
		await Bun.write(path.join(second, "7.eval.log"), "second content");

		await expect(resolveArtifact("7")).rejects.toThrow(/ambiguous id/);
	});

	it("keeps export/replay default task details receipt-only for persisted task result shapes", async () => {
		const dir = await makeTempDir();
		const fullOutput = `small preview\n${"A".repeat(8192)}`;
		const file = await writeAgentOutput(dir, "3-Export", fullOutput);
		const receipt = buildTaskReceipt(
			makeRaw({
				id: "3-Export",
				output: fullOutput,
				outputPath: file,
				outputMeta: {
					lineCount: fullOutput.split("\n").length,
					charCount: fullOutput.length,
					byteSize: Buffer.byteLength(fullOutput),
					sha256: createHash("sha256").update(fullOutput).digest("hex"),
				},
			}),
		);
		const persisted = {
			type: "toolResult",
			toolName: "task",
			content: [{ type: "text", text: "Task completed. Full output: agent://3-Export" }],
			details: { projectAgentsDir: null, results: [receipt], totalDurationMs: 10 } satisfies TaskToolDetails,
		};

		expect(findRawTaskLeakKeys(persisted.details)).toEqual([]);
		expect(JSON.stringify(persisted.details)).not.toContain(LEAK_SENTINEL);
		expect(JSON.stringify(persisted.details)).not.toContain("A".repeat(2001));
	});

	it("resolves a nested task receipt outputRef through its registered .md sidecar", async () => {
		const dir = await makeTempDir();
		const nestedContent = "nested full artifact";
		const file = await writeAgentOutput(dir, "6-Parent.0-Nested", nestedContent);
		const nestedReceipt = buildTaskReceipt(
			makeRaw({
				id: "6-Parent.0-Nested",
				output: nestedContent,
				outputPath: file,
				outputMeta: {
					lineCount: 1,
					charCount: nestedContent.length,
					byteSize: Buffer.byteLength(nestedContent),
					sha256: createHash("sha256").update(nestedContent).digest("hex"),
				},
			}),
		);

		expect(nestedReceipt.outputRef?.uri).toBe("agent://6-Parent.0-Nested");
		await expect(resolveAgent("6-Parent.0-Nested")).resolves.toMatchObject({ content: nestedContent });
	});

	it("fails closed when the agent output metadata sidecar is absent", async () => {
		const dir = await makeTempDir();
		const file = await writeAgentOutput(dir, "9-Legacy", "legacy content");
		await fs.rm(`${file}.meta.json`);
		await expect(resolveAgent("9-Legacy")).rejects.toThrow(/missing metadata/);

		await writeAgentOutput(dir, "10-Tampered", "tampered content");
		await Bun.write(`${path.join(dir, "10-Tampered.md")}.meta.json`, JSON.stringify({ id: "different" }));
		await expect(resolveAgent("10-Tampered")).rejects.toThrow(/malformed metadata/);
	});

	it("rejects agent:// ids containing path separators or traversal", async () => {
		await makeTempDir();
		const malicious = (rawHost: string) =>
			new AgentProtocolHandler().resolve({
				rawHost,
				hostname: rawHost,
				pathname: "",
				searchParams: new URLSearchParams(),
				href: `agent://${rawHost}`,
			} as never);
		await expect(malicious("../../etc/passwd")).rejects.toThrow(/invalid id/);
		await expect(malicious("..")).rejects.toThrow(/invalid id/);
		await expect(malicious("a/b")).rejects.toThrow(/invalid id/);
	});
});
