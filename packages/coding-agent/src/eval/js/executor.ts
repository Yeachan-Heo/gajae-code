import { DEFAULT_MAX_BYTES, OutputSink } from "../../session/streaming-output";
import type { ToolSession } from "../../tools";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../../tools/output-meta";
import { ToolError } from "../../tools/tool-errors";
import { executeInVmContext, type JsDisplayOutput } from "./context-manager";

export interface JsExecutorOptions {
	timeoutMs?: number;
	deadlineMs?: number;
	onChunk?: (chunk: string) => Promise<void> | void;
	signal?: AbortSignal;
	sessionId: string;
	ownerId?: string;
	reset?: boolean;
	sessionFile?: string;
	artifactPath?: string;
	artifactId?: string;
	session: ToolSession;
}

export interface JsResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	artifactId?: string;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	displayOutputs: JsDisplayOutput[];
}

function getExecutionTimeoutMs(options: Pick<JsExecutorOptions, "deadlineMs" | "timeoutMs">): number | undefined {
	if (options.deadlineMs !== undefined) {
		return Math.max(1, options.deadlineMs - Date.now());
	}
	return options.timeoutMs;
}

/**
 * The QuickJS runtime enforces the cell deadline itself (interrupt handler + wait timer) and
 * keeps its context alive. The host timeout is only a backstop for a wedged worker, so it fires
 * this much later than the in-worker deadline.
 */
const HOST_TIMEOUT_GRACE_MS = 2_000;

function isTimeoutError(error: unknown): boolean {
	return error instanceof Error && error.name === "TimeoutError";
}

function isAbortError(error: unknown): boolean {
	return (
		(error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) ||
		(error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
	);
}

export async function executeJs(code: string, options: JsExecutorOptions): Promise<JsResult> {
	const displayOutputs: JsDisplayOutput[] = [];
	const outputSink = new OutputSink({
		artifactPath: options.artifactPath,
		artifactId: options.artifactId,
		spillThreshold: DEFAULT_MAX_BYTES,
		headBytes: resolveOutputSinkHeadBytes(options.session.settings),
		maxColumns: resolveOutputMaxColumns(options.session.settings),
		onChunk: chunk => options.onChunk?.(chunk),
	});
	const timeoutMs = getExecutionTimeoutMs(options);
	const hasTimeout = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0;
	const deadlineMs = hasTimeout ? Date.now() + timeoutMs : undefined;
	const timeoutSignal = hasTimeout ? AbortSignal.timeout(timeoutMs + HOST_TIMEOUT_GRACE_MS) : undefined;
	const signal =
		options.signal && timeoutSignal
			? AbortSignal.any([options.signal, timeoutSignal])
			: (options.signal ?? timeoutSignal);

	try {
		await executeInVmContext({
			sessionKey: options.sessionId,
			ownerId: options.ownerId,
			session: options.session,
			reset: options.reset,
			code,
			filename: `js-cell-${crypto.randomUUID()}.js`,
			timeoutMs,
			deadlineMs,
			runState: {
				signal,
				onText: chunk => outputSink.push(chunk),
				onDisplay: output => {
					displayOutputs.push(output);
				},
			},
		});
		const summary = await outputSink.dump();
		return {
			output: summary.output,
			exitCode: 0,
			cancelled: false,
			truncated: summary.truncated,
			artifactId: summary.artifactId,
			totalLines: summary.totalLines,
			totalBytes: summary.totalBytes,
			outputLines: summary.outputLines,
			outputBytes: summary.outputBytes,
			displayOutputs,
		};
	} catch (error) {
		if (signal?.aborted || isAbortError(error)) {
			const timeoutReason = timeoutSignal?.aborted || isTimeoutError(error) ? "Command timed out" : "";
			if (timeoutReason) {
				outputSink.push(timeoutReason);
			}
			const summary = await outputSink.dump();
			return {
				output: summary.output,
				exitCode: undefined,
				cancelled: true,
				truncated: summary.truncated,
				artifactId: summary.artifactId,
				totalLines: summary.totalLines,
				totalBytes: summary.totalBytes,
				outputLines: summary.outputLines,
				outputBytes: summary.outputBytes,
				displayOutputs,
			};
		}
		const message =
			error instanceof ToolError || (error instanceof Error && error.name === "ToolError")
				? error.message
				: error instanceof Error
					? (error.stack ?? error.message)
					: String(error);
		outputSink.push(message);
		const summary = await outputSink.dump();
		return {
			output: summary.output,
			exitCode: 1,
			cancelled: false,
			truncated: summary.truncated,
			artifactId: summary.artifactId,
			totalLines: summary.totalLines,
			totalBytes: summary.totalBytes,
			outputLines: summary.outputLines,
			outputBytes: summary.outputBytes,
			displayOutputs,
		};
	}
}
