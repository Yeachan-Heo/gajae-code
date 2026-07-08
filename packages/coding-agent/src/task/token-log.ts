import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ChatUsageSnapshot, CostEstimate } from "@gajae-code/agent-core";
import { sessionRoot } from "../gjc-runtime/session-layout";
import { resolveGjcSessionForRead, SessionResolutionError } from "../gjc-runtime/session-resolution";
import type { TaskTokenLog, TaskTokenMetrics } from "./types";

const TOKEN_LOG_FILE = "token-log.jsonl";

export interface TaskTokenLogChatBuckets {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cachedInputTokens: number;
	readonly cacheWriteTokens: number;
	readonly costUsd?: number;
}

export interface TaskTokenLogSessionManager {
	getSessionId(): string;
}

export interface TaskTokenLogContext {
	readonly subagentId: string;
	readonly agent?: string;
	readonly turn: number;
	readonly at: string;
	readonly model?: string;
}

export function taskTokenLogFromChat(chat: TaskTokenLogChatBuckets, ctx: TaskTokenLogContext): TaskTokenLog {
	const input = chat.inputTokens;
	const output = chat.outputTokens;
	const cacheRead = chat.cachedInputTokens;
	const cacheWrite = chat.cacheWriteTokens;
	return {
		subagentId: ctx.subagentId,
		...(ctx.agent ? { agent: ctx.agent } : {}),
		turn: ctx.turn,
		at: ctx.at,
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		...(chat.costUsd !== undefined ? { cost: chat.costUsd } : {}),
		...(ctx.model ? { model: ctx.model } : {}),
	};
}

export function taskTokenLogFromUsage(
	usage: ChatUsageSnapshot,
	ctx: TaskTokenLogContext & { readonly cost?: CostEstimate },
): TaskTokenLog {
	const costUsd = ctx.cost && "usd" in ctx.cost ? ctx.cost.usd : undefined;
	const cacheRead = usage.cachedInputTokens ?? 0;
	const cacheWrite = usage.cacheWriteTokens ?? 0;
	// `ChatUsageSnapshot.inputTokens` is the aggregate input-class bucket
	// (raw input + cacheRead + cacheWrite; see buildUsageSnapshot in the agent
	// telemetry layer). `TaskTokenLog.input` must be the cost-bearing bucket that
	// EXCLUDES cache, so subtract the cache buckets back out (clamped at 0).
	const input = Math.max(0, usage.inputTokens - cacheRead - cacheWrite);
	return taskTokenLogFromChat(
		{
			inputTokens: input,
			outputTokens: usage.outputTokens,
			cachedInputTokens: cacheRead,
			cacheWriteTokens: cacheWrite,
			...(costUsd !== undefined ? { costUsd } : {}),
		},
		ctx,
	);
}

export async function resolveTaskTokenLogDir(
	cwd: string,
	sessionManager: TaskTokenLogSessionManager | undefined,
	envSessionId: string | undefined = process.env.GJC_SESSION_ID,
): Promise<string | undefined> {
	// Prefer the canonical SessionManager id so root turns land in the SAME
	// `<session>/token-logs` dir the task executor uses for subagent turns and
	// that `gjc --fixture <id>` reads from. Fall back to the env/latest-active
	// session only when no manager id is available (e.g. lifecycle launches where
	// the SDK adopts a pre-allocated id internally). Never let a best-effort
	// telemetry side channel crash startup — swallow every SessionResolutionError.
	const managerId = sessionManager?.getSessionId();
	if (managerId) return path.join(sessionRoot(cwd, managerId), "token-logs");
	try {
		const session = await resolveGjcSessionForRead(cwd, { envSessionId });
		return path.join(session.sessionRoot, "token-logs");
	} catch (error) {
		if (error instanceof SessionResolutionError) return undefined;
		throw error;
	}
}
export async function persistTaskTokenLog(entry: TaskTokenLog, opts: { dir: string }): Promise<void> {
	await fs.mkdir(opts.dir, { recursive: true });
	await fs.appendFile(path.join(opts.dir, TOKEN_LOG_FILE), `${JSON.stringify(entry)}\n`, "utf-8");
}

export async function readTaskTokenLogs(dir: string): Promise<TaskTokenLog[]> {
	let raw: string;
	try {
		raw = await fs.readFile(path.join(dir, TOKEN_LOG_FILE), "utf-8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return [];
		throw error;
	}
	const logs: TaskTokenLog[] = [];
	let skipped = 0;
	for (const line of raw.split("\n")) {
		if (line.trim().length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			// Skip a torn/partially-flushed tail line rather than aborting the
			// entire read; concurrent appends can leave an incomplete final line.
			skipped += 1;
			continue;
		}
		if (isTaskTokenLog(parsed)) logs.push(parsed);
		else skipped += 1;
	}
	// A torn tail line alongside valid entries is tolerated, but a non-empty file
	// that yields zero valid entries is corrupt — surface it loudly rather than
	// returning [] (which a caller would render as a misleading all-zero report).
	if (logs.length === 0 && skipped > 0) {
		throw new Error(`corrupt token-log: ${skipped} unparseable line(s) and no valid entries in ${dir}`);
	}
	return logs;
}

export function computeTaskTokenMetrics(logs: readonly TaskTokenLog[]): TaskTokenMetrics {
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let totalTokens = 0;
	for (const log of logs) {
		inputTokens += log.input;
		outputTokens += log.output;
		cacheReadTokens += log.cacheRead;
		cacheWriteTokens += log.cacheWrite;
		totalTokens += log.totalTokens;
	}
	return {
		turns: logs.length,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		totalTokens,
		cacheHitRate: computeCacheHitRate(inputTokens, cacheReadTokens),
	};
}

export function computeCacheHitRate(input: number, cacheRead: number): number {
	const denominator = input + cacheRead;
	return denominator <= 0 ? 0 : cacheRead / denominator;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function isTaskTokenLog(value: unknown): value is TaskTokenLog {
	if (value === null || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.subagentId === "string" &&
		typeof record.turn === "number" &&
		typeof record.at === "string" &&
		typeof record.input === "number" &&
		typeof record.output === "number" &&
		typeof record.cacheRead === "number" &&
		typeof record.cacheWrite === "number" &&
		typeof record.totalTokens === "number"
	);
}
