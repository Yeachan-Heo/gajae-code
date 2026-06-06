import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { create } from "@bufbuild/protobuf";
import type {
	AssistantMessage,
	Context,
	CursorExecHandlerResult,
	CursorExecHandlers,
	Model,
	StreamFunction,
	StreamOptions,
	ToolResultMessage,
} from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import {
	ReadArgsSchema,
	type ReadResult,
	ShellArgsSchema,
	type ShellResult,
	WriteArgsSchema,
} from "./cursor/gen/agent_pb";

type AcpConfigValue = string | boolean;

export interface AcpAgentOptions extends StreamOptions {
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string | undefined>;
	clientCapabilities?: Partial<acp.ClientCapabilities>;
	defaultConfigOptions?: Record<string, AcpConfigValue>;
	execHandlers?: CursorExecHandlers;
}

interface TerminalRecord {
	output: string;
	exitCode: number | null;
	released: boolean;
	done: Promise<void>;
}

interface PlainReadResult {
	content?: string;
	fileText?: string;
}

interface PlainShellResult {
	output?: string;
	stdout?: string;
	stderr?: string;
	exitCode?: number | null;
}

function emptyUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function messageContentText(content: Context["messages"][number]["content"]): string {
	if (typeof content === "string") return content;
	return content
		.map(item => {
			if (item.type === "text") return item.text;
			if (item.type === "image") return `[image: ${item.mimeType}]`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function toolResultToText(toolResult: ToolResultMessage): string {
	return toolResult.content.map(item => (item.type === "text" ? item.text : `[image: ${item.mimeType}]`)).join("\n");
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function shellCommand(command: string, args: string[] | undefined): string {
	if (!args?.length) return shellQuote(command);
	return [command, ...args].map(shellQuote).join(" ");
}

function buildPromptText(context: Context): string {
	const sections: string[] = [];
	const systemText = (context.systemPrompt ?? [])
		.map(entry => entry.trim())
		.filter(Boolean)
		.join("\n\n");
	if (systemText) sections.push(`System:\n${systemText}`);
	for (const message of context.messages) {
		if (message.role === "toolResult") {
			const text = toolResultToText(message);
			if (text) sections.push(`Tool result (${message.toolName}):\n${text}`);
			continue;
		}
		const text = messageContentText(message.content);
		if (text) sections.push(`${message.role}:\n${text}`);
	}
	return sections.join("\n\n");
}

function isToolResultMessage(value: unknown): value is ToolResultMessage {
	return !!value && typeof value === "object" && (value as ToolResultMessage).role === "toolResult";
}

function splitExecResult<TResult>(result: CursorExecHandlerResult<TResult>): {
	result?: TResult;
	toolResult?: ToolResultMessage;
} {
	if (isToolResultMessage(result)) {
		return { toolResult: result };
	}
	if (result && typeof result === "object" && "result" in result) {
		const boxed = result as { result: TResult; toolResult?: ToolResultMessage };
		return { result: boxed.result, toolResult: boxed.toolResult };
	}
	return { result: result as TResult };
}

function readResultContent(result: ReadResult | PlainReadResult): string {
	if ("$typeName" in result) {
		if (result.result.case !== "success") return "";
		const output = result.result.value.output;
		if (output.case === "content") return output.value;
		if (output.case === "data") return new TextDecoder().decode(output.value);
		return "";
	}
	return result.content ?? result.fileText ?? "";
}

function readRecordFromSplit(
	result: ReadResult | PlainReadResult | undefined,
	toolResult: ToolResultMessage | undefined,
): string {
	if (result) return readResultContent(result);
	return toolResult ? toolResultToText(toolResult) : "";
}

function shellResultRecord(
	result: ShellResult | PlainShellResult | undefined,
	toolResult: ToolResultMessage | undefined,
): {
	output: string;
	exitCode: number | null;
} {
	if (!result) {
		return {
			output: toolResult ? toolResultToText(toolResult) : "",
			exitCode: toolResult?.isError ? 1 : 0,
		};
	}
	if ("$typeName" in result) {
		if (result.result.case === "success" || result.result.case === "failure") {
			const value = result.result.value;
			const output = value.interleavedOutput ?? [value.stdout, value.stderr].filter(Boolean).join("");
			return { output, exitCode: value.exitCode };
		}
		if (result.result.case === "timeout") {
			return { output: `Command timed out after ${result.result.value.timeoutMs}ms`, exitCode: 124 };
		}
		if (result.result.case === "rejected") {
			return { output: result.result.value.reason, exitCode: 1 };
		}
		if (result.result.case === "spawnError") {
			return { output: result.result.value.error, exitCode: 1 };
		}
		if (result.result.case === "permissionDenied") {
			return { output: result.result.value.error, exitCode: 1 };
		}
		return { output: "", exitCode: 0 };
	}
	return {
		output: result.output ?? [result.stdout, result.stderr].filter(Boolean).join(""),
		exitCode: result.exitCode ?? 0,
	};
}

async function runTerminalCommand(
	terminal: TerminalRecord,
	execHandlers: CursorExecHandlers,
	command: string,
	cwd: string,
	terminalId: string,
): Promise<void> {
	try {
		const { result, toolResult } = splitExecResult(
			await execHandlers.shell?.(
				create(ShellArgsSchema, {
					command,
					workingDirectory: cwd,
					toolCallId: terminalId,
				}),
			),
		);
		if (terminal.exitCode === 143) return;
		const shellResult = shellResultRecord(result, toolResult);
		terminal.output = shellResult.output;
		terminal.exitCode = shellResult.exitCode;
	} catch (error) {
		if (terminal.exitCode === 143) return;
		terminal.output = error instanceof Error ? error.message : String(error);
		terminal.exitCode = 1;
	}
}

function createClient(
	stream: AssistantMessageEventStream,
	assistant: AssistantMessage,
	execHandlers: CursorExecHandlers | undefined,
	terminals: Map<string, TerminalRecord>,
): acp.Client {
	return {
		async sessionUpdate(params) {
			const update = params.update;
			if (update.sessionUpdate !== "agent_message_chunk") return;
			const content = update.content;
			if (content.type !== "text") return;
			let contentIndex = assistant.content.length - 1;
			const last = assistant.content[contentIndex];
			if (last?.type === "text") {
				last.text += content.text;
			} else {
				assistant.content.push({ type: "text", text: content.text });
				contentIndex = assistant.content.length - 1;
				stream.push({ type: "text_start", contentIndex, partial: assistant });
			}
			stream.push({ type: "text_delta", contentIndex, delta: content.text, partial: assistant });
		},
		async requestPermission(params) {
			const option = params.options.find(candidate => candidate.kind === "allow_always") ?? params.options[0];
			if (!option) return { outcome: { outcome: "cancelled" } };
			return { outcome: { outcome: "selected", optionId: option.optionId } };
		},
		async readTextFile(params) {
			if (!execHandlers?.read) throw new Error("ACP readTextFile requested but no read handler is available");
			const { result, toolResult } = splitExecResult(
				await execHandlers.read(
					create(ReadArgsSchema, {
						path: params.path,
						toolCallId: `acp-read-${crypto.randomUUID()}`,
					}),
				),
			);
			return { content: readRecordFromSplit(result, toolResult) };
		},
		async writeTextFile(params) {
			if (!execHandlers?.write) throw new Error("ACP writeTextFile requested but no write handler is available");
			const { toolResult } = splitExecResult(
				await execHandlers.write(
					create(WriteArgsSchema, {
						path: params.path,
						fileText: params.content,
						toolCallId: `acp-write-${crypto.randomUUID()}`,
					}),
				),
			);
			if (toolResult?.isError) throw new Error(toolResultToText(toolResult) || "ACP writeTextFile failed");
			return {};
		},
		async createTerminal(params) {
			if (!execHandlers?.shell) throw new Error("ACP terminal requested but no shell handler is available");
			const terminalId = `acp-terminal-${crypto.randomUUID()}`;
			const command = shellCommand(params.command, params.args);
			const terminal: TerminalRecord = {
				output: "",
				exitCode: null,
				released: false,
				done: Promise.resolve(),
			};
			terminal.done = runTerminalCommand(terminal, execHandlers, command, params.cwd ?? process.cwd(), terminalId);
			terminals.set(terminalId, terminal);
			return { terminalId };
		},
		async terminalOutput(params) {
			const terminal = terminals.get(params.terminalId);
			if (!terminal) throw new Error(`Unknown ACP terminal: ${params.terminalId}`);
			return {
				output: terminal.output,
				truncated: false,
				exitStatus: terminal.exitCode === null ? null : { exitCode: terminal.exitCode, signal: null },
			};
		},
		async waitForTerminalExit(params) {
			const terminal = terminals.get(params.terminalId);
			if (!terminal) throw new Error(`Unknown ACP terminal: ${params.terminalId}`);
			if (terminal.exitCode === null) {
				await terminal.done;
			}
			return { exitCode: terminal.exitCode ?? 0, signal: null };
		},
		async killTerminal(params) {
			const terminal = terminals.get(params.terminalId);
			if (terminal) {
				terminal.exitCode = terminal.exitCode ?? 143;
			}
			return {};
		},
		async releaseTerminal(params) {
			const terminal = terminals.get(params.terminalId);
			if (terminal) {
				terminal.released = true;
				terminal.exitCode = terminal.exitCode ?? 143;
				terminals.delete(params.terminalId);
			}
			return {};
		},
	};
}

function buildClientCapabilities(options: AcpAgentOptions | undefined): acp.ClientCapabilities {
	return {
		fs: {
			readTextFile: true,
			writeTextFile: true,
		},
		terminal: true,
		...options?.clientCapabilities,
		_meta: {
			parameterizedModelPicker: true,
			...(options?.clientCapabilities?._meta ?? {}),
		},
	};
}

function getDefaultConfigOptions(
	model: Model<"acp-agent">,
	options: AcpAgentOptions | undefined,
): Record<string, AcpConfigValue> | undefined {
	if (options?.defaultConfigOptions) return options.defaultConfigOptions;
	if (model.provider === "cursor-acp" && model.id === "composer-2.5") {
		return {
			model: "composer-2.5",
			fast: "false",
		};
	}
	return undefined;
}

async function applyDefaultConfigOptions(
	connection: acp.ClientSideConnection,
	sessionId: string,
	defaultConfigOptions: Record<string, AcpConfigValue> | undefined,
): Promise<void> {
	if (!defaultConfigOptions) return;
	for (const [configId, value] of Object.entries(defaultConfigOptions)) {
		await connection.setSessionConfigOption({
			sessionId,
			configId,
			...(typeof value === "boolean" ? { type: "boolean" as const, value } : { value }),
		});
	}
}

function spawnAcpProcess(options: AcpAgentOptions | undefined): ChildProcessWithoutNullStreams {
	const command = options?.command ?? "cursor-agent";
	const args = options?.args ?? ["--model", "composer-2.5[fast=false]", "acp"];
	return spawn(command, args, {
		cwd: options?.cwd ?? process.cwd(),
		env: { ...process.env, ...(options?.env ?? {}) },
		stdio: ["pipe", "pipe", "pipe"],
	});
}

export const streamAcpAgent: StreamFunction<"acp-agent"> = (
	model: Model<"acp-agent">,
	context: Context,
	options?: AcpAgentOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startedAt = Date.now();
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "acp-agent",
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: startedAt,
		};
		let child: ChildProcessWithoutNullStreams | undefined;
		try {
			child = spawnAcpProcess(options);
			const acpStream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
			const terminals = new Map<string, TerminalRecord>();
			const connection = new acp.ClientSideConnection(
				() => createClient(stream, assistant, options?.execHandlers, terminals),
				acpStream,
			);

			stream.push({ type: "start", partial: assistant });
			await connection.initialize({
				protocolVersion: acp.PROTOCOL_VERSION,
				clientCapabilities: buildClientCapabilities(options),
				clientInfo: { name: "gjc", version: "0.3.0" },
			});
			const session = await connection.newSession({
				cwd: options?.cwd ?? process.cwd(),
				mcpServers: [],
			});
			await applyDefaultConfigOptions(connection, session.sessionId, getDefaultConfigOptions(model, options));
			await connection.prompt({
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: buildPromptText(context) }],
			});
			assistant.content.forEach((content, contentIndex) => {
				if (content.type === "text") {
					stream.push({ type: "text_end", contentIndex, content: content.text, partial: assistant });
				}
			});
			assistant.duration = Date.now() - startedAt;
			stream.push({ type: "done", reason: "stop", message: assistant });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			stream.fail(new Error(`ACP agent provider failed: ${message}`));
		} finally {
			child?.kill();
		}
	})();

	return stream;
};
