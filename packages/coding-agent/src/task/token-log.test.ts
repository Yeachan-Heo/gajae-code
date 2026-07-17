import { describe, expect, it } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GJC_SESSION_ACTIVITY_FILE, sessionRoot } from "../gjc-runtime/session-layout";
import {
	computeCacheHitRate,
	persistTaskTokenLog,
	readTaskTokenLogs,
	resolveTaskTokenLogDir,
	taskTokenLogFromChat,
	taskTokenLogFromUsage,
} from "./token-log";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "gjc-token-log-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("task token log", () => {
	it("maps raw chat buckets without folding cache into input", () => {
		const log = taskTokenLogFromChat(
			{
				inputTokens: 100,
				outputTokens: 20,
				cachedInputTokens: 30,
				cacheWriteTokens: 5,
				costUsd: 0.25,
			},
			{
				subagentId: "root",
				agent: "main",
				turn: 1,
				at: "2026-01-01T00:00:00.000Z",
				model: "model-a",
			},
		);

		expect(log.input).toBe(100);
		expect(log.output).toBe(20);
		expect(log.cacheRead).toBe(30);
		expect(log.cacheWrite).toBe(5);
		expect(log.totalTokens).toBe(155);
		expect(log.cost).toBe(0.25);
		expect(log.model).toBe("model-a");
	});

	it("maps zero-cache chat buckets without inventing cache tokens", () => {
		const log = taskTokenLogFromChat(
			{ inputTokens: 7, outputTokens: 3, cachedInputTokens: 0, cacheWriteTokens: 0 },
			{ subagentId: "root", turn: 2, at: "2026-01-01T00:00:02.000Z" },
		);

		expect(log.input).toBe(7);
		expect(log.output).toBe(3);
		expect(log.cacheRead).toBe(0);
		expect(log.cacheWrite).toBe(0);
		expect(log.totalTokens).toBe(10);
	});

	it("keeps large cache-only reads out of input and hits the cache-rate upper boundary", () => {
		const log = taskTokenLogFromChat(
			{ inputTokens: 0, outputTokens: 2, cachedInputTokens: 1_000_000_000, cacheWriteTokens: 0 },
			{ subagentId: "root", turn: 3, at: "2026-01-01T00:00:03.000Z" },
		);

		expect(log.input).toBe(0);
		expect(log.output).toBe(2);
		expect(log.cacheRead).toBe(1_000_000_000);
		expect(log.cacheWrite).toBe(0);
		expect(log.totalTokens).toBe(1_000_000_002);
		expect(computeCacheHitRate(log.input, log.cacheRead)).toBe(1);
	});

	it("persists and reads a jsonl round trip", async () => {
		await withTempDir(async dir => {
			const first = taskTokenLogFromChat(
				{ inputTokens: 1, outputTokens: 2, cachedInputTokens: 3, cacheWriteTokens: 4 },
				{ subagentId: "root", turn: 1, at: "2026-01-01T00:00:00.000Z" },
			);
			const second = taskTokenLogFromChat(
				{ inputTokens: 5, outputTokens: 6, cachedInputTokens: 7, cacheWriteTokens: 8 },
				{ subagentId: "child", agent: "executor", turn: 1, at: "2026-01-01T00:00:01.000Z" },
			);

			await persistTaskTokenLog(first, { dir });
			await persistTaskTokenLog(second, { dir });

			expect(await readTaskTokenLogs(dir)).toEqual([first, second]);
		});
	});

	it("prefers the current session manager over a stale latest-active session", async () => {
		await withTempDir(async cwd => {
			const currentSessionId = "current-session";
			const staleSessionId = "stale-session";
			for (const [sessionId, updatedAt] of [
				[currentSessionId, "2026-01-01T00:00:00.000Z"],
				[staleSessionId, "2026-01-01T00:00:10.000Z"],
			] as const) {
				const markerPath = join(sessionRoot(cwd, sessionId), GJC_SESSION_ACTIVITY_FILE);
				await mkdir(join(markerPath, ".."), { recursive: true });
				await writeFile(
					markerPath,
					`${JSON.stringify({ session_id: sessionId, updated_at: updatedAt })}\n`,
					"utf-8",
				);
			}

			await expect(resolveTaskTokenLogDir(cwd, undefined, "")).resolves.toBe(
				join(sessionRoot(cwd, staleSessionId), "token-logs"),
			);
			await expect(resolveTaskTokenLogDir(cwd, { getSessionId: () => currentSessionId }, "")).resolves.toBe(
				join(sessionRoot(cwd, currentSessionId), "token-logs"),
			);
		});
	});

	it("missing token-log file reads as empty", async () => {
		await withTempDir(async dir => {
			expect(await readTaskTokenLogs(dir)).toEqual([]);
		});
	});

	it("subtracts cache from the aggregate ChatUsageSnapshot input bucket", () => {
		// buildUsageSnapshot sets inputTokens = rawInput + cacheRead + cacheWrite.
		// taskTokenLogFromUsage must recover the raw (cache-excluded) input.
		const log = taskTokenLogFromUsage(
			{
				inputTokens: 135,
				outputTokens: 20,
				totalTokens: 155,
				cachedInputTokens: 30,
				cacheWriteTokens: 5,
				reasoningOutputTokens: 0,
			},
			{ subagentId: "root", turn: 1, at: "2026-01-01T00:00:00.000Z", cost: { usd: 0.5 } },
		);

		expect(log.input).toBe(100);
		expect(log.cacheRead).toBe(30);
		expect(log.cacheWrite).toBe(5);
		expect(log.output).toBe(20);
		expect(log.totalTokens).toBe(155);
		expect(log.cost).toBe(0.5);
	});

	it("clamps aggregate input underflow to zero", () => {
		const log = taskTokenLogFromUsage(
			{
				inputTokens: 10,
				outputTokens: 1,
				totalTokens: 10,
				cachedInputTokens: 8,
				cacheWriteTokens: 5,
				reasoningOutputTokens: undefined,
			},
			{ subagentId: "root", turn: 1, at: "2026-01-01T00:00:00.000Z" },
		);

		expect(log.input).toBe(0);
	});

	it("skips a torn or corrupt jsonl line instead of throwing", async () => {
		await withTempDir(async dir => {
			const valid = taskTokenLogFromChat(
				{ inputTokens: 1, outputTokens: 2, cachedInputTokens: 3, cacheWriteTokens: 4 },
				{ subagentId: "root", turn: 1, at: "2026-01-01T00:00:00.000Z" },
			);
			await persistTaskTokenLog(valid, { dir });
			// A partially-flushed / corrupt trailing line must not abort the read.
			await appendFile(join(dir, "token-log.jsonl"), '{"subagentId":"root","turn":2,', "utf-8");

			expect(await readTaskTokenLogs(dir)).toEqual([valid]);
		});
	});

	it("throws when a non-empty log has no valid entries", async () => {
		await withTempDir(async dir => {
			await appendFile(join(dir, "token-log.jsonl"), "not json\n{}\n", "utf-8");
			await expect(readTaskTokenLogs(dir)).rejects.toThrow(/corrupt token-log/);
		});
	});
});
