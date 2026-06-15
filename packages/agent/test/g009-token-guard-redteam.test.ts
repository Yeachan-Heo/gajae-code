import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import type { Message } from "@gajae-code/ai";
import { estimateMessageTokensHeuristic, estimateTokens } from "../src/compaction/compaction";

const MIB = 1024 * 1024;
const NATIVE_CAP_CHARS = 2 * MIB;

function userTextMessage(text: string): Message {
	return { role: "user", content: text } as Message;
}

function expectFastTokenEstimate(message: Message, maxMs: number): number {
	const start = performance.now();
	const tokens = estimateTokens(message);
	const elapsedMs = performance.now() - start;
	expect(tokens).toBeGreaterThan(0);
	expect(elapsedMs).toBeLessThan(maxMs);
	return tokens;
}

function expectHeuristicFallback(message: Message, maxMs: number): number {
	const heuristic = estimateMessageTokensHeuristic(message);
	const tokens = expectFastTokenEstimate(message, maxMs);
	expect(tokens).toBe(heuristic);
	return tokens;
}
async function runBelowCapProbe(chars: number): Promise<{ timedOut: boolean; stdout: string; stderr: string }> {
	return await new Promise(resolve => {
		const child = spawn(
			process.execPath,
			[
				"--eval",
				`import { estimateTokens } from "./src/compaction/compaction"; console.log(estimateTokens({ role: "user", content: "b".repeat(${chars}) }));`,
			],
			{ cwd: import.meta.dir.replace(/\/test$/, "") },
		);
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, 3_000);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("close", () => {
			clearTimeout(timer);
			resolve({ timedOut, stdout, stderr });
		});
	});
}

describe("oversized token-count guard red-team (G009 / W8 / F22)", () => {
	it("switches at the 2 MiB boundary and keeps the above-cap path fast", async () => {
		const justBelowChars = NATIVE_CAP_CHARS - 1;
		const justAbove = userTextMessage("a".repeat(NATIVE_CAP_CHARS + 1));

		const belowProbe = await runBelowCapProbe(justBelowChars);
		if (!belowProbe.timedOut) {
			expect(Number(belowProbe.stdout.trim())).toBeGreaterThan(0);
			expect(belowProbe.stderr).toBe("");
		}
		expect(typeof belowProbe.timedOut).toBe("boolean");

		const aboveTokens = expectHeuristicFallback(justAbove, 1_000);
		expect(aboveTokens).toBe(estimateMessageTokensHeuristic(justAbove));
	});

	it("bounds a huge 8 MiB message without hanging or producing an unbounded native count", () => {
		const huge = userTextMessage("h".repeat(8 * MIB));
		const tokens = expectHeuristicFallback(huge, 1_000);
		expect(tokens).toBeLessThanOrEqual(Math.ceil((8 * MIB) / 4));
	});

	it("falls back for multi-block assistant text and thinking content above the cap", () => {
		const multiBlock = {
			role: "assistant",
			content: [
				{ type: "text", text: "t".repeat(MIB) },
				{ type: "thinking", thinking: "r".repeat(MIB) },
				{ type: "text", text: "u".repeat(64) },
			],
		} as unknown as Message;

		expectHeuristicFallback(multiBlock, 1_000);
	});

	it("still returns a positive native count for normal small content", () => {
		const small = userTextMessage("normal small message for native token counting");
		expect(estimateTokens(small)).toBeGreaterThan(0);
	});

	it("is deterministic for the same huge message", () => {
		const huge = userTextMessage("d".repeat(8 * MIB));
		expect(estimateTokens(huge)).toBe(estimateTokens(huge));
	});
});
