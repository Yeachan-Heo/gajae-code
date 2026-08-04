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

export function createOuroborosOooBridge(options: OuroborosOooBridgeOptions = {}) {
	const connect = options.connect ?? connectToServer;
	const invoke = options.callTool ?? callTool;
	const disconnect = options.disconnect ?? disconnectServer;
	let interview: InterviewState | undefined;
	let activeConnection: MCPServerConnection | undefined;
	let pendingConnection: Promise<MCPServerConnection> | undefined;

	const commandBridge = createExactPrefixCommandBridge({
		prefix: "ooo",
		command: resolveOuroborosCommand(),
		args: ["dispatch", "--runtime", "gjc"],
	});

	async function connection(ctx: ExtensionContext): Promise<MCPServerConnection> {
		if (activeConnection) return activeConnection;
		pendingConnection ??= connect("ouroboros-ooo-bridge", {
			type: "stdio",
			command: resolveOuroborosCommand(),
			args: ["mcp", "serve", "--runtime", "gjc"],
			cwd: ctx.cwd,
		});
		try {
			activeConnection = await pendingConnection;
			return activeConnection;
		} finally {
			pendingConnection = undefined;
		}
	}

	async function closeInterview(): Promise<void> {
		const connectionToClose = activeConnection;
		interview = undefined;
		activeConnection = undefined;
		if (connectionToClose) await disconnect(connectionToClose);
	}

	async function runInterview(text: string, ctx: ExtensionContext): Promise<InputEventResult> {
		try {
			const activeConnection = await connection(ctx);
			const commandArgument = interviewArgument(text);
			const args: Record<string, unknown> = { cwd: ctx.cwd };
			if (interview) {
				args.session_id = interview.sessionId;
				const answer = commandArgument === undefined ? text.trim() : commandArgument;
				if (answer) args.answer = answer;
			} else {
				args.initial_context = commandArgument ?? "";
			}

			const result = await invoke(activeConnection, INTERVIEW_TOOL, args);
			const output = resultText(result);
			if (result.isError) throw new Error(output || "Ouroboros interview failed");

			const sessionId = resultSessionId(result, output);
			if (!resultCompleted(result)) {
				if (!sessionId) throw new Error("Ouroboros interview response did not include a session ID");
				interview = { sessionId };
			} else {
				await closeInterview();
			}
			return output ? { handled: true, text: output } : { handled: true };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui?.notify(message, "error");
			return { handled: true };
		}
	}

	return async (event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult> => {
		if (event.source !== undefined && event.source !== "interactive") return {};
		const argument = interviewArgument(event.text);
		if (argument !== undefined || (interview && !isOooCommand(event.text))) {
			return runInterview(event.text, ctx);
		}
		return commandBridge(event, ctx);
	};
}
