import type { MCPServerConnection, MCPToolCallResult } from "../../runtime-mcp";
import { callTool, connectToServer, disconnectServer } from "../../runtime-mcp";
import { createExactPrefixCommandBridge } from "./prefix-command-bridge";
import type { ExtensionContext, InputEvent, InputEventResult } from "./types";

const OUROBOROS_CLI_ENV = "OUROBOROS_CLI";
const INTERVIEW_COMMAND = "ooo interview";
const INTERVIEW_TOOL = "ouroboros_interview";
const INTERVIEW_SESSION_PATTERN = /^interview_[A-Za-z0-9_-]+$/;

interface OuroborosOooBridgeOptions {
	connect?: typeof connectToServer;
	callTool?: typeof callTool;
	disconnect?: typeof disconnectServer;
}

interface InterviewState {
	sessionId: string;
}

interface OuroborosOooBridgeHandler {
	(event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult>;
	reset(): Promise<void>;
}

function resolveOuroborosCommand(): string {
	return process.env[OUROBOROS_CLI_ENV]?.trim() || "ouroboros";
}

function interviewArgument(text: string): string | undefined {
	if (text === INTERVIEW_COMMAND) return "";
	if (text.startsWith(`${INTERVIEW_COMMAND} `) || text.startsWith(`${INTERVIEW_COMMAND}\t`)) {
		return text.slice(INTERVIEW_COMMAND.length).trim();
	}
	return undefined;
}

function isOooCommand(text: string): boolean {
	return text === "ooo" || text.startsWith("ooo ") || text.startsWith("ooo\t");
}

function isBuiltInControlInput(text: string): boolean {
	return text === "." || text === "c" || text.startsWith("/");
}

function resetsInterviewState(text: string): boolean {
	return /^\/(?:clear|drop|exit|new|quit)(?:\s|$)/.test(text);
}

function resultText(result: MCPToolCallResult): string {
	return result.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("\n\n")
		.trim();
}

function resultMeta(result: MCPToolCallResult): Record<string, unknown> {
	return result._meta ?? {};
}

function resultSessionId(result: MCPToolCallResult, text: string): string | undefined {
	const metadataSessionId = resultMeta(result).session_id;
	if (typeof metadataSessionId === "string" && INTERVIEW_SESSION_PATTERN.test(metadataSessionId)) {
		return metadataSessionId;
	}
	const textSessionId = /\bSession(?: ID)?:\s*(interview_[A-Za-z0-9_-]+)/.exec(text)?.[1];
	return textSessionId && INTERVIEW_SESSION_PATTERN.test(textSessionId) ? textSessionId : undefined;
}

function resultCompleted(result: MCPToolCallResult): boolean {
	const meta = resultMeta(result);
	return meta.completed === true || meta.phase === "complete";
}

export function createOuroborosOooBridge(options: OuroborosOooBridgeOptions = {}): OuroborosOooBridgeHandler {
	const connect = options.connect ?? connectToServer;
	const invoke = options.callTool ?? callTool;
	const disconnect = options.disconnect ?? disconnectServer;
	let interview: InterviewState | undefined;
	let interviewCaptureActive = false;
	let activeConnection: MCPServerConnection | undefined;
	let pendingConnection: Promise<MCPServerConnection> | undefined;
	let activeOperationAbort: AbortController | undefined;
	let lifecycleGeneration = 0;
	let operationTail: Promise<void> = Promise.resolve();

	const commandBridge = createExactPrefixCommandBridge({
		prefix: "ooo",
		command: resolveOuroborosCommand(),
		args: ["dispatch", "--runtime", "gjc"],
	});

	function assertCurrent(generation: number, signal: AbortSignal | undefined): void {
		if (generation !== lifecycleGeneration || signal?.aborted) {
			throw signal?.reason instanceof Error ? signal.reason : new Error("Ouroboros interview operation cancelled");
		}
	}

	async function disconnectSafely(connection: MCPServerConnection | undefined): Promise<void> {
		if (!connection) return;
		try {
			await disconnect(connection);
		} catch {
			// State is already fenced. A dead transport must not keep ordinary input captured.
		}
	}

	async function resetInterview(): Promise<void> {
		lifecycleGeneration++;
		interviewCaptureActive = false;
		const operationAbort = activeOperationAbort;
		activeOperationAbort = undefined;
		operationAbort?.abort(new Error("Ouroboros interview reset"));
		const connectionToClose = activeConnection;
		interview = undefined;
		activeConnection = undefined;
		pendingConnection = undefined;
		await disconnectSafely(connectionToClose);
	}

	async function connection(ctx: ExtensionContext, generation: number): Promise<MCPServerConnection> {
		assertCurrent(generation, ctx.signal);
		if (activeConnection) return activeConnection;
		const pending =
			pendingConnection ??
			connect(
				"ouroboros-ooo-bridge",
				{
					type: "stdio",
					command: resolveOuroborosCommand(),
					args: ["mcp", "serve", "--runtime", "gjc"],
					cwd: ctx.cwd,
				},
				{ signal: ctx.signal },
			);
		pendingConnection = pending;
		try {
			const connected = await pending;
			try {
				assertCurrent(generation, ctx.signal);
			} catch (error) {
				await disconnectSafely(connected);
				throw error;
			}
			activeConnection = connected;
			return connected;
		} finally {
			if (pendingConnection === pending) pendingConnection = undefined;
		}
	}

	async function runInterview(text: string, ctx: ExtensionContext): Promise<InputEventResult> {
		const operationAbort = new AbortController();
		activeOperationAbort = operationAbort;
		const operationSignal = ctx.signal ? AbortSignal.any([ctx.signal, operationAbort.signal]) : operationAbort.signal;
		const operationContext: ExtensionContext = { ...ctx, signal: operationSignal };
		const generation = lifecycleGeneration;
		const abortHandler = () => {
			void resetInterview();
		};
		ctx.signal?.addEventListener("abort", abortHandler, { once: true });
		try {
			const interviewConnection = await connection(operationContext, generation);
			const commandArgument = interviewArgument(text);
			const args: Record<string, unknown> = { cwd: ctx.cwd };
			if (interview) {
				args.session_id = interview.sessionId;
				const answer = commandArgument === undefined ? text.trim() : commandArgument;
				if (answer) args.answer = answer;
			} else {
				args.initial_context = commandArgument ?? "";
			}

			const result = await invoke(interviewConnection, INTERVIEW_TOOL, args, { signal: operationSignal });
			assertCurrent(generation, operationSignal);
			const output = resultText(result);
			if (result.isError) throw new Error(output || "Ouroboros interview failed");

			const sessionId = resultSessionId(result, output);
			if (!resultCompleted(result)) {
				if (!sessionId) throw new Error("Ouroboros interview response did not include a session ID");
				interview = { sessionId };
			} else {
				await resetInterview();
			}
			return output ? { handled: true, text: output } : { handled: true };
		} catch (error) {
			await resetInterview();
			if (!ctx.signal?.aborted) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui?.notify(message, "error");
			}
			return { handled: true };
		} finally {
			ctx.signal?.removeEventListener("abort", abortHandler);
			if (activeOperationAbort === operationAbort) activeOperationAbort = undefined;
		}
	}

	function enqueueInterview(
		text: string,
		ctx: ExtensionContext,
		explicitInterview: boolean,
	): Promise<InputEventResult> {
		const submissionGeneration = lifecycleGeneration;
		const operation = operationTail.then(async () => {
			if (submissionGeneration !== lifecycleGeneration) return { handled: true };
			if (!explicitInterview && !interviewCaptureActive && !interview) return { handled: true };
			return runInterview(text, ctx);
		});
		operationTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	const handler = async (event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult> => {
		if (event.source !== undefined && event.source !== "interactive") return {};
		if (isBuiltInControlInput(event.text)) {
			if (resetsInterviewState(event.text)) await resetInterview();
			return {};
		}
		const argument = interviewArgument(event.text);
		const explicitInterview = argument !== undefined;
		if (explicitInterview) interviewCaptureActive = true;
		if (explicitInterview || ((interviewCaptureActive || interview) && !isOooCommand(event.text))) {
			return enqueueInterview(event.text, ctx, explicitInterview);
		}
		return commandBridge(event, ctx);
	};

	return Object.assign(handler, { reset: resetInterview });
}
