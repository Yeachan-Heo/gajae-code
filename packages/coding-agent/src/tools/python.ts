import type { AgentTool, AgentToolResult } from "@gajae-code/agent-core";
import { type Static, z } from "@gajae-code/ai/core";
import { logger } from "@gajae-code/utils";
import { Settings, type Settings as SettingsType } from "../config/settings";
import { disposeKernelSessionsByOwner, executePython } from "../eval/py/executor";
import type { ToolDefinition } from "../extensibility/extensions/types";
import { applyToolProxy } from "../extensibility/tool-proxy";
import {
	openPythonKernelTranscript,
	type PythonKernelTranscript,
	type PythonTranscriptRecord,
} from "../gjc-runtime/python-transcript";
import { sessionIpykernelsArtifactsDir } from "../gjc-runtime/session-layout";
import pythonToolDescription from "../prompts/tools/python.md" with { type: "text" };

export const PYTHON_TOOL_NAME = "python";

export function pythonKernelOwnerId(sessionId: string): string {
	return `python:${sessionId}`;
}

export interface SessionPythonToolInput {
	/** Working directory for kernel execution (session cwd). */
	cwd: string;
	/** Return the current session cwd after a rescope. */
	getCwd?: () => string;
	/** Session settings used for Python runtime policy. */
	settings?: SettingsType;
	/** Resolve the current session settings after a cwd rescope. */
	getSettings?: () => SettingsType;
	/** Resolve the GJC session id used for the kernel owner and transcript paths. */
	getSessionId: () => string | null;
	/** Register cleanup with the current logical session lifecycle. */
	registerSessionCleanup: (cleanup: () => Promise<void> | void) => void;
}

const paramsSchema = z.object({
	action: z
		.enum(["execute", "clear"])
		.default("execute")
		.describe(
			'"execute" runs `code` in the persistent per-session REPL and is the default. "clear" disposes this session\'s kernel; the next execute starts a fresh kernel.',
		),
	code: z
		.string()
		.optional()
		.describe('Python source to execute when action is "execute" (required then, ignored for "clear").'),
});

const NO_SESSION_ERROR = "Python requires a GJC session id. Start or resume a session before using this tool.";

interface TranscriptExecutionResult {
	output: string;
	exitCode: number | null;
	cancelled: boolean;
	truncated: boolean;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isCancellationError(error: unknown, signal: AbortSignal | undefined): boolean {
	return (
		signal?.aborted === true ||
		(error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) ||
		(error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
	);
}

function appendFailureTrailer(output: string, appendFailure: string | undefined): string {
	if (appendFailure === undefined) return output;
	const trailer = `[transcript append failed: ${appendFailure}]`;
	return output.length > 0 ? `${output}\n${trailer}` : trailer;
}

export function createSessionPythonTool(input: SessionPythonToolInput): AgentTool {
	let armedForSession: string | null = null;
	const seenOwnerIds = new Set<string>();
	let currentTranscript: PythonKernelTranscript | null = null;
	let activeCwd = input.cwd;

	const armCleanupForSession = (sessionId: string): void => {
		if (armedForSession === sessionId) return;
		input.registerSessionCleanup(async () => {
			await Promise.all([...seenOwnerIds].map(ownerId => disposeKernelSessionsByOwner(ownerId)));
			seenOwnerIds.clear();
			currentTranscript = null;
			armedForSession = null;
		});
		armedForSession = sessionId;
	};

	const appendTranscript = async (
		sessionId: string,
		code: string,
		result: TranscriptExecutionResult,
	): Promise<string | undefined> => {
		if (currentTranscript === null) {
			currentTranscript = openPythonKernelTranscript({
				cwd: activeCwd,
				sessionId,
				kernelInstanceId: crypto.randomUUID(),
			});
		}
		const record: PythonTranscriptRecord = {
			timestamp: new Date().toISOString(),
			code,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
		};
		try {
			await currentTranscript.append(record);
			return undefined;
		} catch (error) {
			const message = errorMessage(error);
			logger.warn("Python transcript append failed", { sessionId, error: message });
			return message;
		}
	};

	const definition: ToolDefinition<typeof paramsSchema> = {
		name: PYTHON_TOOL_NAME,
		label: "Python",
		description: pythonToolDescription,
		parameters: paramsSchema,
		defaultInactive: true,
		concurrency: "exclusive",
		async execute(
			_toolCallId: string,
			params: Static<typeof paramsSchema>,
			signal?: AbortSignal,
		): Promise<AgentToolResult> {
			const sessionId = input.getSessionId();
			if (sessionId === null) {
				return {
					content: [{ type: "text", text: NO_SESSION_ERROR }],
					isError: true,
				};
			}
			armCleanupForSession(sessionId);
			const ownerId = pythonKernelOwnerId(sessionId);
			const cwd = input.getCwd?.() ?? input.cwd;
			if (cwd !== activeCwd) {
				await disposeKernelSessionsByOwner(ownerId);
				currentTranscript = null;
				activeCwd = cwd;
			}
			if (params.action === "clear") {
				await disposeKernelSessionsByOwner(ownerId);
				currentTranscript = null;
				return {
					content: [{ type: "text", text: "Python kernel cleared; the next execute starts a fresh kernel." }],
				};
			}
			const code = params.code;
			if (code === undefined) {
				return {
					content: [{ type: "text", text: 'Missing required "code" parameter for action "execute".' }],
					isError: true,
				};
			}

			seenOwnerIds.add(ownerId);
			try {
				const activeSettings = input.getSettings?.() ?? input.settings ?? Settings.instance;
				const result = await executePython(code, {
					cwd,
					settings: activeSettings,
					kernelMode: "session",
					sessionId: ownerId,
					kernelOwnerId: ownerId,
					artifactsDir: sessionIpykernelsArtifactsDir(cwd, sessionId),
					signal,
					onKernelStart: kernelInstanceId => {
						if (currentTranscript?.kernelInstanceId !== kernelInstanceId) {
							currentTranscript = openPythonKernelTranscript({
								cwd,
								sessionId,
								kernelInstanceId,
							});
						}
					},
				});
				const appendFailure = await appendTranscript(sessionId, code, {
					output: result.output,
					exitCode: result.exitCode ?? null,
					cancelled: result.cancelled,
					truncated: result.truncated,
				});
				const output = result.output.length > 0 ? result.output : "(no output)";
				return { content: [{ type: "text", text: appendFailureTrailer(output, appendFailure) }] };
			} catch (error) {
				const output = errorMessage(error);
				const appendFailure = await appendTranscript(sessionId, code, {
					output,
					exitCode: null,
					cancelled: isCancellationError(error, signal),
					truncated: false,
				});
				return {
					content: [{ type: "text", text: appendFailureTrailer(output, appendFailure) }],
					isError: true,
				};
			}
		},
	};
	const agentTool = {
		async execute(
			toolCallId: string,
			params: Static<typeof paramsSchema>,
			signal?: AbortSignal,
		): Promise<AgentToolResult> {
			return definition.execute(toolCallId, params, signal, undefined, undefined as never);
		},
	} as AgentTool;
	applyToolProxy(definition, agentTool);
	return agentTool;
}
