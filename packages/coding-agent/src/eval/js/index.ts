import type { ToolSession } from "../../tools";
import type { ExecutorBackend, ExecutorBackendExecOptions, ExecutorBackendResult } from "../backend";
import { executeJs } from "./executor";

const JS_SESSION_PREFIX = "js:";

function namespaceSessionId(sessionId: string): string {
	return sessionId.startsWith(JS_SESSION_PREFIX) ? sessionId : `${JS_SESSION_PREFIX}${sessionId}`;
}

export default {
	id: "js",
	label: "JavaScript",
	highlightLang: "javascript",

	async isAvailable(_session: ToolSession): Promise<boolean> {
		return true;
	},

	async execute(code: string, opts: ExecutorBackendExecOptions): Promise<ExecutorBackendResult> {
		const result = await executeJs(code, {
			cwd: opts.cwd,
			deadlineMs: opts.deadlineMs,
			signal: opts.signal,
			sessionId: namespaceSessionId(opts.sessionId),
			ownerId: opts.kernelOwnerId,
			sessionFile: opts.sessionFile,
			reset: opts.reset,
			artifactPath: opts.artifactPath,
			artifactId: opts.artifactId,
			onChunk: opts.onChunk,
			session: opts.session,
		});
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
