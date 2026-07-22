import type { ToolSession } from "../../tools";
import type { ExecutorBackend, ExecutorBackendExecOptions, ExecutorBackendResult } from "../backend";
import { executePython, type PythonExecutorOptions } from "./executor";
import { checkPythonKernelAvailability } from "./kernel";

const PYTHON_SESSION_PREFIX = "python:";

function namespaceSessionId(sessionId: string): string {
	return sessionId.startsWith(PYTHON_SESSION_PREFIX) ? sessionId : `${PYTHON_SESSION_PREFIX}${sessionId}`;
}

function readSetting<T>(session: ToolSession, key: string): T | undefined {
	const settings = session.settings as { get?: (key: string) => T | undefined } | undefined;
	return settings?.get?.(key);
}

export default {
	id: "python",
	label: "Python",
	highlightLang: "python",

	async isAvailable(session: ToolSession): Promise<boolean> {
		const availability = await checkPythonKernelAvailability(session.cwd);
		return availability.ok;
	},

	async execute(code: string, opts: ExecutorBackendExecOptions): Promise<ExecutorBackendResult> {
		const kernelMode = readSetting<PythonExecutorOptions["kernelMode"]>(opts.session, "python.kernelMode");
		const executorOptions: PythonExecutorOptions = {
			cwd: opts.cwd,
			deadlineMs: opts.deadlineMs,
			signal: opts.signal,
			sessionId: namespaceSessionId(opts.sessionId),
			kernelMode,
			sessionFile: undefined,
			artifactsDir: undefined,
			kernelOwnerId: opts.kernelOwnerId,
			reset: opts.reset,
			artifactPath: opts.artifactPath,
			artifactId: opts.artifactId,
			onChunk: opts.onChunk,
			toolSession: opts.session,
		};
		const result = await executePython(code, executorOptions);
		return {
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			artifactId: result.artifactId,
			totalLines: result.totalLines,
			totalBytes: result.totalBytes,
			outputLines: result.outputLines,
			outputBytes: result.outputBytes,
			displayOutputs: result.displayOutputs,
		};
	},
} satisfies ExecutorBackend;
