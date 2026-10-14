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
	/** Resolve the current working directory for each admitted invocation. */
	getCwd?: () => string;
	/** Session settings used for Python runtime policy. */
	settings?: SettingsType;
	/** Resolve the session file associated with each admitted invocation. */
	getSessionFile?: () => string | null;
	/** Resolve the GJC session id used for the kernel owner and transcript paths. */
	getSessionId: () => string | null;
	/** Register cleanup with the current logical session lifecycle. */
	registerSessionCleanup: (cleanup: () => Promise<void> | void) => (() => void) | undefined;
	/** Reject execution after the owning session has begun disposal. */
	assertEvalExecutionAllowed?: () => void;
	/** Track this whole invocation through its transcript append. */
	trackEvalExecution?: <T>(execution: Promise<T>, abortController: AbortController) => Promise<T>;
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

interface PythonGeneration {
	readonly sessionId: string;
	readonly ownerId: string;
	readonly abortControllers: Set<AbortController>;
	readonly completions: Set<Promise<void>>;
	readonly transcripts: Map<string, PythonKernelTranscript>;
	unregisterCleanup?: () => void;
	cleanupPromise?: Promise<void>;
}

interface PythonInvocationContext {
	readonly cwd: string;
	readonly sessionFile: string | null;
	readonly sessionId: string;
	readonly ownerId: string;
	readonly settings: SettingsType;
	readonly generation: PythonGeneration;
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
	const activeGenerations = new Map<string, PythonGeneration>();

	const transcriptFor = (
		generation: PythonGeneration,
		context: Pick<PythonInvocationContext, "cwd" | "sessionId">,
		kernelInstanceId: string,
	): PythonKernelTranscript => {
		const key = JSON.stringify([context.cwd, context.sessionId, kernelInstanceId]);
		let transcript = generation.transcripts.get(key);
		if (!transcript) {
			transcript = openPythonKernelTranscript({
				cwd: context.cwd,
				sessionId: context.sessionId,
				kernelInstanceId,
			});
			generation.transcripts.set(key, transcript);
		}
		return transcript;
	};

	const retireGeneration = (generation: PythonGeneration): Promise<void> => {
		if (generation.cleanupPromise) return generation.cleanupPromise;
		const cleanup = Promise.withResolvers<void>();
		generation.cleanupPromise = cleanup.promise;
		const completions = [...generation.completions];
		const controllers = [...generation.abortControllers];
		if (activeGenerations.get(generation.sessionId) === generation) {
			activeGenerations.delete(generation.sessionId);
		}

		let ownerCleanup: Promise<void>;
		try {
			// Core registers pending operations by this existing owner label before
			// availability work begins, so this synchronous call also captures work
			// that has not acquired a kernel yet.
			ownerCleanup = disposeKernelSessionsByOwner(generation.ownerId);
		} catch (error) {
			ownerCleanup = Promise.reject(error);
		}
		for (const controller of controllers) controller.abort();
		void (async () => {
			const results = await Promise.allSettled([ownerCleanup, ...completions]);
			const coreResult = results[0]!;
			if (coreResult.status === "rejected") throw coreResult.reason;
			generation.unregisterCleanup?.();
			generation.unregisterCleanup = undefined;
			generation.transcripts.clear();
		})().then(cleanup.resolve, error => {
			if (generation.cleanupPromise === cleanup.promise) generation.cleanupPromise = undefined;
			cleanup.reject(error);
		});
		return cleanup.promise;
	};

	const generationFor = (sessionId: string): PythonGeneration => {
		const current = activeGenerations.get(sessionId);
		if (current) return current;
		const generation: PythonGeneration = {
			sessionId,
			ownerId: pythonKernelOwnerId(sessionId),
			abortControllers: new Set(),
			completions: new Set(),
			transcripts: new Map(),
		};
		activeGenerations.set(sessionId, generation);
		try {
			const unregister = input.registerSessionCleanup(() => retireGeneration(generation));
			if (typeof unregister === "function") generation.unregisterCleanup = unregister;
		} catch (error) {
			activeGenerations.delete(sessionId);
			throw error;
		}
		return generation;
	};

	const appendTranscript = async (
		context: PythonInvocationContext,
		transcript: PythonKernelTranscript | undefined,
		code: string,
		result: TranscriptExecutionResult,
	): Promise<string | undefined> => {
		const record: PythonTranscriptRecord = {
			timestamp: new Date().toISOString(),
			code,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
		};
		try {
			const target = transcript ?? transcriptFor(context.generation, context, crypto.randomUUID());
			await target.append(record);
			return undefined;
		} catch (error) {
			const message = errorMessage(error);
			logger.warn("Python transcript append failed", { sessionId: context.sessionId, error: message });
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
			if (params.action === "clear") {
				const generation = generationFor(sessionId);
				await retireGeneration(generation);
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

			const cwd = input.getCwd?.() ?? input.cwd;
			const sessionFile = input.getSessionFile?.() ?? null;
			const settings = input.settings ?? Settings.instance;
			input.assertEvalExecutionAllowed?.();
			const contextGeneration = generationFor(sessionId);
			const context: PythonInvocationContext = {
				cwd,
				sessionFile,
				sessionId,
				ownerId: contextGeneration.ownerId,
				settings,
				generation: contextGeneration,
			};
			const abortController = new AbortController();
			const abortFromCaller = (): void => abortController.abort(signal?.reason);
			if (signal?.aborted) abortFromCaller();
			else signal?.addEventListener("abort", abortFromCaller, { once: true });
			contextGeneration.abortControllers.add(abortController);

			let trackingAccepted = false;
			const execution = Promise.resolve()
				.then(async (): Promise<AgentToolResult> => {
					if (!trackingAccepted) throw new Error("Python execution was not admitted by its owning session.");
					input.assertEvalExecutionAllowed?.();
					let transcript: PythonKernelTranscript | undefined;
					try {
						const result = await executePython(code, {
							cwd: context.cwd,
							settings: context.settings,
							sessionFile: context.sessionFile ?? undefined,
							kernelMode: "session",
							sessionId: context.ownerId,
							kernelOwnerId: context.ownerId,
							artifactsDir: sessionIpykernelsArtifactsDir(context.cwd, context.sessionId),
							signal: abortController.signal,
							onKernelStart: kernelInstanceId => {
								transcript = transcriptFor(context.generation, context, kernelInstanceId);
							},
						});
						const appendFailure = await appendTranscript(context, transcript, code, {
							output: result.output,
							exitCode: result.exitCode ?? null,
							cancelled: result.cancelled,
							truncated: result.truncated,
						});
						const output = result.output.length > 0 ? result.output : "(no output)";
						return { content: [{ type: "text", text: appendFailureTrailer(output, appendFailure) }] };
					} catch (error) {
						const output = errorMessage(error);
						const appendFailure = await appendTranscript(context, transcript, code, {
							output,
							exitCode: null,
							cancelled: isCancellationError(error, abortController.signal),
							truncated: false,
						});
						return {
							content: [{ type: "text", text: appendFailureTrailer(output, appendFailure) }],
							isError: true,
						};
					}
				})
				.finally(() => {
					signal?.removeEventListener("abort", abortFromCaller);
					contextGeneration.abortControllers.delete(abortController);
				});
			const settled = execution.then(
				() => {},
				() => {},
			);
			contextGeneration.completions.add(settled);
			void settled.then(() => contextGeneration.completions.delete(settled));

			let completion: Promise<AgentToolResult>;
			try {
				completion = input.trackEvalExecution ? input.trackEvalExecution(execution, abortController) : execution;
				trackingAccepted = true;
			} catch (error) {
				abortController.abort(error);
				signal?.removeEventListener("abort", abortFromCaller);
				contextGeneration.abortControllers.delete(abortController);
				void execution.catch(() => {});
				throw error;
			}
			return await completion;
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
