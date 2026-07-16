import * as fs from "node:fs/promises";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	RenderResultOptions,
} from "@gajae-code/agent-core";
import { type Component, Text } from "@gajae-code/tui";
import { isEnoent, prompt } from "@gajae-code/utils";
import * as z from "zod/v4";
import {
	type DapBreakpointRecord,
	type DapCapabilities,
	type DapContinueOutcome,
	type DapDataBreakpointInfoResponse,
	type DapDataBreakpointRecord,
	type DapDisassembledInstruction,
	type DapEvaluateArguments,
	type DapEvaluateResponse,
	type DapFunctionBreakpointRecord,
	type DapInstructionBreakpointRecord,
	type DapModule,
	type DapScope,
	type DapSessionSummary,
	type DapSource,
	type DapStackFrame,
	type DapThread,
	type DapVariable,
	dapSessionManager,
	getAvailableAdapters,
	selectAttachAdapter,
	selectLaunchAdapter,
} from "../dap";
import type { Theme } from "../modes/theme/theme";
import debugDescription from "../prompts/tools/debug.md" with { type: "text" };
import { renderStatusLine } from "../tui";
import { CachedOutputBlock } from "../tui/output-block";
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { formatPathRelativeToCwd, resolveToCwd } from "./path-utils";
import {
	formatExpandHint,
	formatStatusIcon,
	PREVIEW_LIMITS,
	replaceTabs,
	resolveRenderCapability,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "./render-utils";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

const debugSchema = z.object({
	action: z.enum([
		"launch",
		"attach",
		"set_breakpoint",
		"remove_breakpoint",
		"set_instruction_breakpoint",
		"remove_instruction_breakpoint",
		"data_breakpoint_info",
		"set_data_breakpoint",
		"remove_data_breakpoint",
		"continue",
		"step_over",
		"step_in",
		"step_out",
		"pause",
		"evaluate",
		"stack_trace",
		"threads",
		"scopes",
		"variables",
		"disassemble",
		"read_memory",
		"write_memory",
		"modules",
		"loaded_sources",
		"custom_request",
		"output",
		"terminate",
		"sessions",
	] as const),
	program: z.string().describe("program path").optional(),
	args: z.array(z.string()).describe("program arguments").optional(),
	adapter: z.string().describe("debugger adapter (gdb, lldb-dap, debugpy, dlv)").optional(),
	cwd: z.string().optional(),
	file: z.string().describe("source file").optional(),
	line: z.number().describe("source line").optional(),
	function: z.string().describe("function name").optional(),
	name: z.string().describe("variable or data name").optional(),
	condition: z.string().describe("breakpoint condition").optional(),
	hit_condition: z.string().optional(),
	expression: z.string().describe("expression to evaluate").optional(),
	context: z.string().describe("evaluate context: watch | repl | hover | variables | clipboard").optional(),
	frame_id: z.number().optional(),
	scope_id: z.number().describe("scope variables reference").optional(),
	variable_ref: z.number().describe("variable reference").optional(),
	pid: z.number().describe("process id for attach").optional(),
	port: z.number().describe("remote attach port").optional(),
	host: z.string().describe("remote attach host").optional(),
	levels: z.number().describe("max stack frames").optional(),
	memory_reference: z.string().describe("memory reference or address").optional(),
	instruction_reference: z.string().optional(),
	instruction_count: z.number().optional(),
	instruction_offset: z.number().optional(),
	count: z.number().describe("bytes to read").optional(),
	data: z.string().describe("base64 memory payload").optional(),
	data_id: z.string().describe("data breakpoint id").optional(),
	access_type: z.enum(["read", "write", "readWrite"] as const).optional(),
	command: z.string().describe("custom dap request command").optional(),
	arguments: z.record(z.string(), z.any()).describe("custom request arguments").optional(),
	offset: z.number().optional(),
	resolve_symbols: z.boolean().optional(),
	allow_partial: z.boolean().optional(),
	start_module: z.number().optional(),
	module_count: z.number().optional(),
	timeout: z.number().describe("per-request timeout seconds").optional(),
});

export type DebugParams = z.infer<typeof debugSchema>;
export type DebugAction = DebugParams["action"];

interface DebugToolDetails {
	action: DebugAction;
	success: boolean;
	snapshot?: DapSessionSummary;
	sessions?: DapSessionSummary[];
	stackFrames?: DapStackFrame[];
	threads?: DapThread[];
	scopes?: DapScope[];
	variables?: DapVariable[];
	sources?: DapSource[];
	modules?: DapModule[];
	evaluation?: DapEvaluateResponse;
	breakpoints?: DapBreakpointRecord[];
	functionBreakpoints?: DapFunctionBreakpointRecord[];
	instructionBreakpoints?: DapInstructionBreakpointRecord[];
	dataBreakpoints?: DapDataBreakpointRecord[];
	dataBreakpointInfo?: DapDataBreakpointInfoResponse;
	disassembly?: DapDisassembledInstruction[];
	memoryAddress?: string;
	memoryData?: string;
	unreadableBytes?: number;
	bytesWritten?: number;
	customBody?: unknown;
	output?: string;
	adapter?: string;
	state?: DapContinueOutcome["state"];
	timedOut?: boolean;
	meta?: OutputMeta;
}

function formatLocation(snapshot: DapSessionSummary | undefined): string | null {
	if (!snapshot?.source?.path || snapshot.line === undefined) {
		return null;
	}
	return `${snapshot.source.path}:${snapshot.line}${snapshot.column !== undefined ? `:${snapshot.column}` : ""}`;
}

function formatSessionSnapshot(snapshot: DapSessionSummary): string[] {
	const lines = [
		`Session ${snapshot.id}`,
		`Adapter: ${snapshot.adapter}`,
		`Status: ${snapshot.status}`,
		`CWD: ${snapshot.cwd}`,
	];
	if (snapshot.program) lines.push(`Program: ${snapshot.program}`);
	if (snapshot.stopReason) lines.push(`Stop reason: ${snapshot.stopReason}`);
	if (snapshot.frameName) lines.push(`Frame: ${snapshot.frameName}`);
	if (snapshot.instructionPointerReference) {
		lines.push(`Instruction pointer: ${snapshot.instructionPointerReference}`);
	}
	const location = formatLocation(snapshot);
	if (location) lines.push(`Location: ${location}`);
	if (snapshot.needsConfigurationDone) {
		lines.push("Configuration: pending configurationDone; set breakpoints, then continue.");
	}
	if (snapshot.exitCode !== undefined) lines.push(`Exit code: ${snapshot.exitCode}`);
	return lines;
}

function formatBreakpoints(filePath: string, breakpoints: DapBreakpointRecord[]): string {
	const lines = [`Breakpoints for ${filePath}:`];
	if (breakpoints.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const breakpoint of breakpoints) {
		lines.push(
			`- line ${breakpoint.line}: ${breakpoint.verified ? "verified" : "pending"}${breakpoint.condition ? ` if ${breakpoint.condition}` : ""}${breakpoint.message ? ` (${breakpoint.message})` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatFunctionBreakpoints(breakpoints: DapFunctionBreakpointRecord[]): string {
	const lines = ["Function breakpoints:"];
	if (breakpoints.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const breakpoint of breakpoints) {
		lines.push(
			`- ${breakpoint.name}: ${breakpoint.verified ? "verified" : "pending"}${breakpoint.condition ? ` if ${breakpoint.condition}` : ""}${breakpoint.message ? ` (${breakpoint.message})` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatStackFrames(frames: DapStackFrame[]): string {
	const lines = ["Stack trace:"];
	if (frames.length === 0) {
		lines.push("(empty)");
		return lines.join("\n");
	}
	for (const frame of frames) {
		const location = frame.source?.path
			? `${frame.source.path}:${frame.line}:${frame.column}`
			: `<unknown>:${frame.line}:${frame.column}`;
		lines.push(`- #${frame.id} ${frame.name} @ ${location}`);
	}
	return lines.join("\n");
}

function formatThreads(threads: DapThread[]): string {
	const lines = ["Threads:"];
	if (threads.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const thread of threads) {
		lines.push(`- ${thread.id}: ${thread.name}`);
	}
	return lines.join("\n");
}

function formatScopes(scopes: DapScope[]): string {
	const lines = ["Scopes:"];
	if (scopes.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const scope of scopes) {
		lines.push(
			`- ${scope.name}: ref=${scope.variablesReference}, expensive=${scope.expensive ? "yes" : "no"}${scope.presentationHint ? `, hint=${scope.presentationHint}` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatVariables(variables: DapVariable[]): string {
	const lines = ["Variables:"];
	if (variables.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const variable of variables) {
		lines.push(
			`- ${variable.name} = ${variable.value}${variable.type ? ` (${variable.type})` : ""}${variable.variablesReference > 0 ? ` [ref=${variable.variablesReference}]` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatSourceLabel(source: DapSource | undefined, line?: number, column?: number): string | null {
	if (!source?.path && !source?.name) {
		return null;
	}
	const base = source.path ?? source.name ?? "<unknown>";
	if (line === undefined) {
		return base;
	}
	return `${base}:${line}${column !== undefined ? `:${column}` : ""}`;
}

function formatDisassembly(instructions: DapDisassembledInstruction[]): string {
	const lines = ["Disassembly:"];
	if (instructions.length === 0) {
		lines.push("(empty)");
		return lines.join("\n");
	}
	const addressWidth = Math.max(...instructions.map(instruction => instruction.address.length));
	const bytesWidth = Math.max(...instructions.map(instruction => instruction.instructionBytes?.length ?? 0), 2);
	for (const instruction of instructions) {
		const location = formatSourceLabel(instruction.location, instruction.line, instruction.column);
		const parts = [
			instruction.address.padEnd(addressWidth),
			(instruction.instructionBytes ?? "").padEnd(bytesWidth),
			instruction.instruction,
		];
		if (instruction.symbol) {
			parts.push(`<${instruction.symbol}>`);
		}
		if (location) {
			parts.push(`[${location}]`);
		}
		lines.push(
			parts
				.filter(part => part.length > 0)
				.join("  ")
				.trimEnd(),
		);
	}
	return lines.join("\n");
}

function formatMemoryRead(address: string, data: string | undefined, unreadableBytes?: number): string {
	const lines = [`Memory at ${address}:`];
	const buffer = data ? Buffer.from(data, "base64") : Buffer.alloc(0);
	if (buffer.length === 0) {
		lines.push("(no readable bytes)");
	} else {
		for (let offset = 0; offset < buffer.length; offset += 16) {
			const chunk = buffer.subarray(offset, offset + 16);
			const hex = Array.from(chunk, byte => byte.toString(16).padStart(2, "0")).join(" ");
			const ascii = Array.from(chunk, byte => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".")).join("");
			lines.push(
				`${(offset === 0 ? address : `+0x${offset.toString(16)}`).padEnd(18)} ${hex.padEnd(47)} |${ascii}|`,
			);
		}
	}
	if (unreadableBytes !== undefined && unreadableBytes > 0) {
		lines.push(`Unreadable bytes: ${unreadableBytes}`);
	}
	return lines.join("\n");
}

function formatTable(headers: string[], rows: string[][]): string {
	const widths = headers.map((header, index) =>
		Math.max(header.length, ...rows.map(row => (row[index] ?? "").length)),
	);
	const formatRow = (row: string[]) => row.map((cell, index) => (cell ?? "").padEnd(widths[index])).join("  ");
	return [formatRow(headers), formatRow(widths.map(width => "-".repeat(width))), ...rows.map(formatRow)].join("\n");
}

function formatModules(modules: DapModule[]): string {
	if (modules.length === 0) {
		return "Modules:\n(none)";
	}
	return [
		"Modules:",
		formatTable(
			["ID", "Name", "Path", "Symbols", "Range"],
			modules.map(module => [
				String(module.id),
				module.name,
				module.path ?? "",
				module.symbolStatus ?? "",
				module.addressRange ?? "",
			]),
		),
	].join("\n");
}

function formatLoadedSources(sources: DapSource[]): string {
	const lines = ["Loaded sources:"];
	if (sources.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const source of sources) {
		const label = source.path ?? source.name ?? "<unknown>";
		lines.push(`- ${label}${source.sourceReference !== undefined ? ` [ref=${source.sourceReference}]` : ""}`);
	}
	return lines.join("\n");
}

function formatInstructionBreakpoints(breakpoints: DapInstructionBreakpointRecord[]): string {
	const lines = ["Instruction breakpoints:"];
	if (breakpoints.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const breakpoint of breakpoints) {
		const location = `${breakpoint.instructionReference}${breakpoint.offset !== undefined ? `+${breakpoint.offset}` : ""}`;
		lines.push(
			`- ${location}: ${breakpoint.verified ? "verified" : "pending"}${breakpoint.condition ? ` if ${breakpoint.condition}` : ""}${breakpoint.hitCondition ? ` after ${breakpoint.hitCondition}` : ""}${breakpoint.message ? ` (${breakpoint.message})` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatDataBreakpointInfo(info: DapDataBreakpointInfoResponse): string {
	const lines = [`Data breakpoint info: ${info.description}`];
	lines.push(`Data ID: ${info.dataId ?? "(not available)"}`);
	if (info.accessTypes && info.accessTypes.length > 0) {
		lines.push(`Access types: ${info.accessTypes.join(", ")}`);
	}
	if (info.canPersist !== undefined) {
		lines.push(`Persistent: ${info.canPersist ? "yes" : "no"}`);
	}
	return lines.join("\n");
}

function formatDataBreakpoints(breakpoints: DapDataBreakpointRecord[]): string {
	const lines = ["Data breakpoints:"];
	if (breakpoints.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const breakpoint of breakpoints) {
		lines.push(
			`- ${breakpoint.dataId}: ${breakpoint.verified ? "verified" : "pending"}${breakpoint.accessType ? ` (${breakpoint.accessType})` : ""}${breakpoint.condition ? ` if ${breakpoint.condition}` : ""}${breakpoint.hitCondition ? ` after ${breakpoint.hitCondition}` : ""}${breakpoint.message ? ` (${breakpoint.message})` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatCustomResponse(command: string, body: unknown): string {
	let serialized = "";
	try {
		serialized = JSON.stringify(body, null, 2) ?? "null";
	} catch {
		serialized = Bun.inspect(body);
	}
	return `${command} response:\n${serialized}`;
}

function formatSessions(sessions: DapSessionSummary[]): string {
	if (sessions.length === 0) {
		return "No debug sessions.";
	}
	return sessions
		.map(session => {
			const location = formatLocation(session);
			return [
				`${session.id}: ${session.status}`,
				`  adapter=${session.adapter}`,
				`  cwd=${session.cwd}`,
				...(session.program ? [`  program=${session.program}`] : []),
				...(location ? [`  location=${location}`] : []),
				...(session.stopReason ? [`  reason=${session.stopReason}`] : []),
			].join("\n");
		})
		.join("\n\n");
}

function formatEvaluation(evaluation: DapEvaluateResponse): string {
	const lines = [`Result: ${evaluation.result}`];
	if (evaluation.type) lines.push(`Type: ${evaluation.type}`);
	if (evaluation.variablesReference > 0) {
		lines.push(`Variables ref: ${evaluation.variablesReference}`);
	}
	return lines.join("\n");
}

function buildOutcomeText(outcome: DapContinueOutcome, timeoutSec: number, verb: string): string {
	const lines = formatSessionSnapshot(outcome.snapshot);
	if (outcome.timedOut) {
		lines.push(`Program is still running after ${timeoutSec}s. Use pause to interrupt and inspect state.`);
		return lines.join("\n");
	}
	if (outcome.state === "stopped") {
		lines.push(`${verb} stopped at ${formatLocation(outcome.snapshot) ?? "unknown location"}.`);
		return lines.join("\n");
	}
	if (outcome.state === "terminated") {
		lines.push(
			`Program terminated${outcome.snapshot.exitCode !== undefined ? ` with exit code ${outcome.snapshot.exitCode}` : ""}.`,
		);
		return lines.join("\n");
	}
	lines.push("Program is running.");
	return lines.join("\n");
}

function getConfiguredAdapters(cwd: string): string {
	const adapters = getAvailableAdapters(cwd).map(adapter => adapter.name);
	return adapters.length > 0 ? adapters.join(", ") : "none";
}
async function validateLaunchProgram(program: string, cwd: string): Promise<void> {
	let isDirectory: boolean;
	try {
		isDirectory = (await fs.stat(program)).isDirectory();
	} catch (error) {
		if (isEnoent(error)) return;
		throw error;
	}
	if (!isDirectory) return;

	const displayPath = formatPathRelativeToCwd(program, cwd, { trailingSlash: true });
	throw new ToolError(
		`launch program resolves to a directory: ${displayPath}. Pass an executable file path, or for Python use adapter "debugpy" with program set to the .py file.`,
	);
}

interface DebugRenderArgs extends Partial<DebugParams> {}

function getActiveSessionSnapshot(): DapSessionSummary {
	const snapshot = dapSessionManager.getActiveSession();
	if (!snapshot) {
		throw new ToolError("No active debug session. Launch or attach first.");
	}
	return snapshot;
}

function requireCapability(capability: keyof DapCapabilities, description: string): DapSessionSummary {
	const snapshot = getActiveSessionSnapshot();
	if (dapSessionManager.getCapabilities()?.[capability] !== true) {
		throw new ToolError(`Current adapter does not support ${description}`);
	}
	return snapshot;
}

function resolveDisassemblyReference(memoryReference: string | undefined): string {
	if (memoryReference) {
		return memoryReference;
	}
	const snapshot = getActiveSessionSnapshot();
	if (snapshot.instructionPointerReference) {
		return snapshot.instructionPointerReference;
	}
	throw new ToolError(
		"disassemble requires memory_reference unless the current stop location has an instruction pointer reference",
	);
}

function summarizeDebugCall(args: DebugRenderArgs): string {
	const action = args.action ? args.action.replaceAll("_", " ") : "request";
	if (args.program) {
		return `${action} ${truncateToWidth(args.program, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.file && args.line !== undefined) {
		return `${action} ${truncateToWidth(`${args.file}:${args.line}`, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.function) {
		return `${action} ${truncateToWidth(args.function, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.expression) {
		return `${action} ${truncateToWidth(args.expression, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.command) {
		return `${action} ${truncateToWidth(args.command, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.memory_reference) {
		return `${action} ${truncateToWidth(args.memory_reference, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.instruction_reference) {
		return `${action} ${truncateToWidth(args.instruction_reference, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.data_id) {
		return `${action} ${truncateToWidth(args.data_id, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.name) {
		return `${action} ${truncateToWidth(args.name, TRUNCATE_LENGTHS.TITLE)}`;
	}
	return action;
}

export const debugToolRenderer = {
	renderCall(args: DebugRenderArgs, _options: RenderResultOptions, theme: Theme): Component {
		const text = renderStatusLine({ icon: "pending", title: "Debug", description: summarizeDebugCall(args) }, theme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: DebugToolDetails; isError?: boolean },
		options: RenderResultOptions,
		theme: Theme,
		args?: DebugRenderArgs,
	): Component {
		const outputBlock = new CachedOutputBlock();
		return {
			render(width: number): string[] {
				const action = (args?.action ?? result.details?.action ?? "debug").replaceAll("_", " ");
				const status = options.isPartial ? "running" : result.isError ? "error" : "success";
				const header = `${formatStatusIcon(status, theme, options.spinnerFrame)} Debug ${action}`;
				const summaryLines = result.details?.snapshot
					? formatSessionSnapshot(result.details.snapshot).map(line => replaceTabs(line))
					: [];
				const text = result.content.find(block => block.type === "text")?.text ?? "No output";
				const rawLines = replaceTabs(text).split("\n");
				const previewLimit = options.expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_LINES;
				const displayedLines = rawLines
					.slice(0, previewLimit)
					.map(line => truncateToWidth(line, TRUNCATE_LENGTHS.LINE));
				const remaining = rawLines.length - displayedLines.length;
				if (remaining > 0) {
					displayedLines.push(
						theme.fg(
							"muted",
							`… ${remaining} more lines ${formatExpandHint(theme, options.expanded, true, resolveRenderCapability(options))}`,
						),
					);
				}
				return outputBlock.render(
					{
						header,
						state: result.isError ? "error" : "success",
						sections: [
							...(summaryLines.length > 0
								? [{ label: theme.fg("toolTitle", "Session"), lines: summaryLines }]
								: []),
							{ label: theme.fg("toolTitle", "Output"), lines: displayedLines },
						],
						width,
						applyBg: false,
					},
					theme,
				);
			},
			invalidate() {
				outputBlock.invalidate();
			},
		};
	},
	mergeCallAndResult: true,
	inline: true,
};

export class DebugTool implements AgentTool<typeof debugSchema, DebugToolDetails> {
	readonly name = "debug";
	readonly label = "Debug";
	readonly summary = "Debug a running process with DAP (debugger adapter protocol)";
	readonly description: string;
	readonly parameters = debugSchema;
	readonly strict = true;
	readonly concurrency = "exclusive";
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(debugDescription);
	}

	static createIf(session: ToolSession): DebugTool | null {
		return session.settings.get("debug.enabled") ? new DebugTool(session) : null;
	}

	async execute(
		_toolCallId: string,
		params: DebugParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<DebugToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<DebugToolDetails>> {
		const timeoutSec = clampTimeout("debug", params.timeout);
		const timeoutSignal = AbortSignal.timeout(timeoutSec * 1000);
		const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		const details: DebugToolDetails = { action: params.action, success: true };
		const result = toolResult(details);
		switch (params.action) {
			case "launch": {
				if (!params.program) {
					throw new ToolError("program is required for launch");
				}
				const commandCwd = params.cwd ? resolveToCwd(params.cwd, this.session.cwd) : this.session.cwd;
				const program = resolveToCwd(params.program, commandCwd);
				await validateLaunchProgram(program, commandCwd);
				const adapter = selectLaunchAdapter(program, commandCwd, params.adapter);
				if (!adapter) {
					throw new ToolError(
						`No debugger adapter available. Installed adapters: ${getConfiguredAdapters(commandCwd)}`,
					);
				}
				const snapshot = await dapSessionManager.launch(
					{ adapter, program, args: params.args, cwd: commandCwd },
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = snapshot;
				details.adapter = adapter.name;
				return result.text(formatSessionSnapshot(snapshot).join("\n")).done();
			}
			case "attach": {
				if (params.pid === undefined && params.port === undefined) {
					throw new ToolError("attach requires pid or port");
				}
				const commandCwd = params.cwd ? resolveToCwd(params.cwd, this.session.cwd) : this.session.cwd;
				const adapter = selectAttachAdapter(commandCwd, params.adapter, params.port);
				if (!adapter) {
					throw new ToolError(
						`No debugger adapter available. Installed adapters: ${getConfiguredAdapters(commandCwd)}`,
					);
				}
				const snapshot = await dapSessionManager.attach(
					{ adapter, cwd: commandCwd, pid: params.pid, port: params.port, host: params.host },
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = snapshot;
				details.adapter = adapter.name;
				return result.text(formatSessionSnapshot(snapshot).join("\n")).done();
			}
			case "set_breakpoint": {
				if (params.function) {
					const response = await dapSessionManager.setFunctionBreakpoint(
						params.function,
						params.condition,
						combinedSignal,
						timeoutSec * 1000,
					);
					details.snapshot = response.snapshot;
					details.functionBreakpoints = response.breakpoints;
					return result.text(formatFunctionBreakpoints(response.breakpoints)).done();
				}
				if (!params.file || params.line === undefined) {
					throw new ToolError("set_breakpoint requires file+line or function");
				}
				const file = resolveToCwd(params.file, this.session.cwd);
				const response = await dapSessionManager.setBreakpoint(
					file,
					params.line,
					params.condition,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.breakpoints = response.breakpoints;
				return result.text(formatBreakpoints(response.sourcePath, response.breakpoints)).done();
			}
			case "remove_breakpoint": {
				if (params.function) {
					const response = await dapSessionManager.removeFunctionBreakpoint(
						params.function,
						combinedSignal,
						timeoutSec * 1000,
					);
					details.snapshot = response.snapshot;
					details.functionBreakpoints = response.breakpoints;
					return result.text(formatFunctionBreakpoints(response.breakpoints)).done();
				}
				if (!params.file || params.line === undefined) {
					throw new ToolError("remove_breakpoint requires file+line or function");
				}
				const file = resolveToCwd(params.file, this.session.cwd);
				const response = await dapSessionManager.removeBreakpoint(
					file,
					params.line,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.breakpoints = response.breakpoints;
				return result.text(formatBreakpoints(response.sourcePath, response.breakpoints)).done();
			}
			case "set_instruction_breakpoint": {
				requireCapability("supportsInstructionBreakpoints", "instruction breakpoints");
				if (!params.instruction_reference) {
					throw new ToolError("instruction_reference is required for set_instruction_breakpoint");
				}
				const response = await dapSessionManager.setInstructionBreakpoint(
					params.instruction_reference,
					params.offset,
					params.condition,
					params.hit_condition,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.instructionBreakpoints = response.breakpoints;
				return result.text(formatInstructionBreakpoints(response.breakpoints)).done();
			}
			case "remove_instruction_breakpoint": {
				requireCapability("supportsInstructionBreakpoints", "instruction breakpoints");
				if (!params.instruction_reference) {
					throw new ToolError("instruction_reference is required for remove_instruction_breakpoint");
				}
				const response = await dapSessionManager.removeInstructionBreakpoint(
					params.instruction_reference,
					params.offset,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.instructionBreakpoints = response.breakpoints;
				return result.text(formatInstructionBreakpoints(response.breakpoints)).done();
			}
			case "data_breakpoint_info": {
				requireCapability("supportsDataBreakpoints", "data breakpoints");
				if (!params.name) {
					throw new ToolError("name is required for data_breakpoint_info");
				}
				const response = await dapSessionManager.dataBreakpointInfo(
					params.name,
					params.variable_ref ?? params.scope_id,
					params.frame_id,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.dataBreakpointInfo = response.info;
				return result.text(formatDataBreakpointInfo(response.info)).done();
			}
			case "set_data_breakpoint": {
				requireCapability("supportsDataBreakpoints", "data breakpoints");
				if (!params.data_id) {
					throw new ToolError("data_id is required for set_data_breakpoint");
				}
				const response = await dapSessionManager.setDataBreakpoint(
					params.data_id,
					params.access_type,
					params.condition,
					params.hit_condition,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.dataBreakpoints = response.breakpoints;
				return result.text(formatDataBreakpoints(response.breakpoints)).done();
			}
			case "remove_data_breakpoint": {
				requireCapability("supportsDataBreakpoints", "data breakpoints");
				if (!params.data_id) {
					throw new ToolError("data_id is required for remove_data_breakpoint");
				}
				const response = await dapSessionManager.removeDataBreakpoint(
					params.data_id,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.dataBreakpoints = response.breakpoints;
				return result.text(formatDataBreakpoints(response.breakpoints)).done();
			}
			case "continue": {
				const outcome = await dapSessionManager.continue(combinedSignal, timeoutSec * 1000);
				details.snapshot = outcome.snapshot;
				details.state = outcome.state;
				details.timedOut = outcome.timedOut;
				return result.text(buildOutcomeText(outcome, timeoutSec, "Continue")).done();
			}
			case "step_over": {
				const outcome = await dapSessionManager.stepOver(combinedSignal, timeoutSec * 1000);
				details.snapshot = outcome.snapshot;
				details.state = outcome.state;
				details.timedOut = outcome.timedOut;
				return result.text(buildOutcomeText(outcome, timeoutSec, "Step over")).done();
			}
			case "step_in": {
				const outcome = await dapSessionManager.stepIn(combinedSignal, timeoutSec * 1000);
				details.snapshot = outcome.snapshot;
				details.state = outcome.state;
				details.timedOut = outcome.timedOut;
				return result.text(buildOutcomeText(outcome, timeoutSec, "Step in")).done();
			}
			case "step_out": {
				const outcome = await dapSessionManager.stepOut(combinedSignal, timeoutSec * 1000);
				details.snapshot = outcome.snapshot;
				details.state = outcome.state;
				details.timedOut = outcome.timedOut;
				return result.text(buildOutcomeText(outcome, timeoutSec, "Step out")).done();
			}
			case "pause": {
				const snapshot = await dapSessionManager.pause(combinedSignal, timeoutSec * 1000);
				details.snapshot = snapshot;
				return result.text(formatSessionSnapshot(snapshot).concat("Program paused.").join("\n")).done();
			}
			case "evaluate": {
				if (!params.expression) {
					throw new ToolError("expression is required for evaluate");
				}
				const evaluationContext = (params.context as DapEvaluateArguments["context"] | undefined) ?? "repl";
				const response = await dapSessionManager.evaluate(
					params.expression,
					evaluationContext,
					params.frame_id,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.evaluation = response.evaluation;
				return result.text(formatEvaluation(response.evaluation)).done();
			}
			case "stack_trace": {
				const response = await dapSessionManager.stackTrace(params.levels, combinedSignal, timeoutSec * 1000);
				details.snapshot = response.snapshot;
				details.stackFrames = response.stackFrames;
				return result.text(formatStackFrames(response.stackFrames)).done();
			}
			case "threads": {
				const response = await dapSessionManager.threads(combinedSignal, timeoutSec * 1000);
				details.snapshot = response.snapshot;
				details.threads = response.threads;
				return result.text(formatThreads(response.threads)).done();
			}
			case "scopes": {
				const response = await dapSessionManager.scopes(params.frame_id, combinedSignal, timeoutSec * 1000);
				details.snapshot = response.snapshot;
				details.scopes = response.scopes;
				return result.text(formatScopes(response.scopes)).done();
			}
			case "variables": {
				const variableReference = params.variable_ref ?? params.scope_id;
				if (variableReference === undefined) {
					throw new ToolError("variables requires variable_ref or scope_id");
				}
				const response = await dapSessionManager.variables(variableReference, combinedSignal, timeoutSec * 1000);
				details.snapshot = response.snapshot;
				details.variables = response.variables;
				return result.text(formatVariables(response.variables)).done();
			}
			case "disassemble": {
				requireCapability("supportsDisassembleRequest", "disassembly");
				if (params.instruction_count === undefined) {
					throw new ToolError("instruction_count is required for disassemble");
				}
				const response = await dapSessionManager.disassemble(
					resolveDisassemblyReference(params.memory_reference),
					params.instruction_count,
					params.offset,
					params.instruction_offset,
					params.resolve_symbols,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.disassembly = response.instructions;
				return result.text(formatDisassembly(response.instructions)).done();
			}
			case "read_memory": {
				requireCapability("supportsReadMemoryRequest", "memory reads");
				if (!params.memory_reference) {
					throw new ToolError("memory_reference is required for read_memory");
				}
				if (params.count === undefined) {
					throw new ToolError("count is required for read_memory");
				}
				const response = await dapSessionManager.readMemory(
					params.memory_reference,
					params.count,
					params.offset,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.memoryAddress = response.address;
				details.memoryData = response.data;
				details.unreadableBytes = response.unreadableBytes;
				return result.text(formatMemoryRead(response.address, response.data, response.unreadableBytes)).done();
			}
			case "write_memory": {
				requireCapability("supportsWriteMemoryRequest", "memory writes");
				if (!params.memory_reference) {
					throw new ToolError("memory_reference is required for write_memory");
				}
				if (!params.data) {
					throw new ToolError("data is required for write_memory");
				}
				const response = await dapSessionManager.writeMemory(
					params.memory_reference,
					params.data,
					params.offset,
					params.allow_partial,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.bytesWritten = response.bytesWritten;
				return result
					.text(
						[
							"Memory write completed.",
							...(response.bytesWritten !== undefined ? [`Bytes written: ${response.bytesWritten}`] : []),
							...(response.offset !== undefined ? [`Offset: ${response.offset}`] : []),
						].join("\n"),
					)
					.done();
			}
			case "modules": {
				requireCapability("supportsModulesRequest", "module introspection");
				const response = await dapSessionManager.modules(
					params.start_module,
					params.module_count,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.modules = response.modules;
				return result.text(formatModules(response.modules)).done();
			}
			case "loaded_sources": {
				requireCapability("supportsLoadedSourcesRequest", "loaded sources");
				const response = await dapSessionManager.loadedSources(combinedSignal, timeoutSec * 1000);
				details.snapshot = response.snapshot;
				details.sources = response.sources;
				return result.text(formatLoadedSources(response.sources)).done();
			}
			case "custom_request": {
				if (!params.command) {
					throw new ToolError("command is required for custom_request");
				}
				const response = await dapSessionManager.customRequest(
					params.command,
					params.arguments,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.customBody = response.body;
				return result.text(formatCustomResponse(params.command, response.body)).done();
			}
			case "output": {
				const response = dapSessionManager.getOutput();
				details.snapshot = response.snapshot;
				details.output = response.output;
				return result.text(response.output.length > 0 ? response.output : "(no output captured)").done();
			}
			case "terminate": {
				const snapshot = await dapSessionManager.terminate(combinedSignal, timeoutSec * 1000);
				if (!snapshot) {
					return result.text("No debug session to terminate.").done();
				}
				details.snapshot = snapshot;
				return result.text(formatSessionSnapshot(snapshot).concat("Debug session terminated.").join("\n")).done();
			}
			case "sessions": {
				const sessions = dapSessionManager.listSessions();
				details.sessions = sessions;
				return result.text(formatSessions(sessions)).done();
			}
			default:
				throw new ToolError(`Unsupported debug action: ${params.action}`);
		}
	}
}
