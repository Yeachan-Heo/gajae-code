import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import {
	type AgentEvent,
	type AgentTool,
	type AgentToolContext,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	bindDispatchedToolIdentity,
} from "@gajae-code/agent-core";
import type {
	CursorMcpCall,
	CursorShellStreamCallbacks,
	CursorExecHandlers as ICursorExecHandlers,
	ToolResultMessage,
} from "@gajae-code/ai/core";
import {
	piEscapeRegexLiteral,
	piJoinPath,
	piLimit,
	piLsPath,
	piReadPath,
	piTimeout,
} from "@gajae-code/ai/providers/cursor/exec-modern";
import { sanitizeText } from "@gajae-code/utils";
import { resolveToCwd } from "./tools/path-utils";

/**
 * Emitter for events this bridge produces.
 *
 * `dispatchedTool` is the tool object the bridge SELECTED and is about to execute — passed
 * alongside the event, never inside it, so the object never reaches an AgentEvent field, a
 * serialized payload, or any wire envelope. The handler binds it as provenance (object
 * identity only) at this producer boundary, because it is the only place that knows which
 * object actually ran: a consumer re-resolving `toolName` later reads a mutable registry.
 * Synthetic operations that execute no AgentTool pass nothing and stay unbound.
 */
type CursorExecEventEmitter = (event: AgentEvent, dispatchedTool?: AgentTool) => void;

interface CursorExecBridgeOptions {
	cwd: string;
	tools: Map<string, AgentTool>;
	getEditReplaceTool?: () => AgentTool | undefined;
	createSearchTool?: (options: { context?: number; totalMatchLimit?: number }) => AgentTool | undefined;
	getToolContext?: () => AgentToolContext | undefined;
	emitEvent?: CursorExecEventEmitter;
	createEventEmitter?: () => ((event: AgentEvent) => void) | undefined;
}

function createToolResultMessage(
	toolCallId: string,
	toolName: string,
	result: AgentToolResult<unknown>,
	isError: boolean,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: result.content,
		details: result.details,
		isError,
		timestamp: Date.now(),
	};
}

function buildToolErrorResult(message: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

/** Admission markers are control flow, not user-facing tool failures. */
function isCursorExecAdmissionClosedError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { name?: unknown }).name === "CursorExecAdmissionClosedError"
	);
}

async function executeTool(
	options: CursorExecBridgeOptions,
	toolName: string,
	toolCallId: string,
	args: Record<string, unknown>,
	overrideTool?: AgentTool,
	execSignal?: AbortSignal,
	markNonAbortable?: () => void,
): Promise<ToolResultMessage> {
	if (execSignal?.aborted) throw cursorAbortError(execSignal);
	const tool = overrideTool ?? options.tools.get(toolName);
	if (!tool) {
		const result = buildToolErrorResult(`Tool "${toolName}" not available`);
		return createToolResultMessage(toolCallId, toolName, result, true);
	}
	// `tool` is the object this call will run; pass it so the start event carries proven
	// provenance instead of a name a consumer would have to re-resolve later.
	options.emitEvent?.({ type: "tool_execution_start", toolCallId, toolName, args }, tool);

	let result: AgentToolResult<unknown>;
	let isError = false;

	const onUpdate: AgentToolUpdateCallback<unknown> | undefined = options.emitEvent
		? partialResult => {
				const sanitizedResult: AgentToolResult<unknown> = {
					content: partialResult.content.map(c => (c.type === "text" ? { ...c, text: sanitizeText(c.text) } : c)),
					details: partialResult.details,
				};
				options.emitEvent?.({
					type: "tool_execution_update",
					toolCallId,
					toolName,
					args,
					partialResult: sanitizedResult,
				});
			}
		: undefined;

	try {
		if (execSignal?.aborted) throw cursorAbortError(execSignal);
		const toolContext = options.getToolContext?.();
		if (execSignal?.aborted) throw cursorAbortError(execSignal);
		if (tool.nonAbortable) markNonAbortable?.();
		result = await tool.execute(
			toolCallId,
			args as Record<string, unknown>,
			// Non-abortable tools receive NO signal, matching agent-loop.ts: their
			// returned promise must represent actual mutation settlement, so an
			// untilAborted(signal, ...) rejection cannot make the settlement fence
			// publish the terminal while the mutation is still running.
			tool.nonAbortable ? undefined : (execSignal ?? undefined),
			onUpdate,
			toolContext,
		);
	} catch (error) {
		if (isCursorExecAdmissionClosedError(error)) throw error;
		const message = error instanceof Error ? error.message : String(error);
		result = buildToolErrorResult(message);
		isError = true;
	}
	isError ||= result.isError === true;

	const sanitizedFinalResult: AgentToolResult<unknown> = {
		content: result.content.map(c => (c.type === "text" ? { ...c, text: sanitizeText(c.text) } : c)),
		details: result.details,
	};
	options.emitEvent?.({ type: "tool_execution_end", toolCallId, toolName, result: sanitizedFinalResult, isError });

	return createToolResultMessage(toolCallId, toolName, result, isError);
}

async function executeDelete(
	options: CursorExecBridgeOptions,
	pathArg: string,
	toolCallId: string,
	execSignal?: AbortSignal,
	markNonAbortable?: () => void,
) {
	const toolName = "delete";
	if (execSignal?.aborted) throw cursorAbortError(execSignal);
	// Register the non-abortable mutation before notifying observers: a synchronous
	// tool_execution_start subscriber may abort the run.
	markNonAbortable?.();
	options.emitEvent?.({ type: "tool_execution_start", toolCallId, toolName, args: { path: pathArg } });
	if (execSignal?.aborted) throw cursorAbortError(execSignal);
	// Delete is a filesystem mutation with no cooperative cancellation point:
	// mark it non-abortable so the settlement fence publishes the exec terminal
	// only once the unlink is final, matching write/edit dispatch.

	const absolutePath = resolveToCwd(pathArg, options.cwd);
	let isError = false;
	let result: AgentToolResult<unknown>;

	try {
		let fileStat: fs.Stats | undefined;
		try {
			fileStat = fs.statSync(absolutePath);
		} catch {
			throw new Error(`File not found: ${pathArg}`);
		}
		if (!fileStat.isFile()) {
			throw new Error(`Path is not a file: ${pathArg}`);
		}

		fs.rmSync(absolutePath);

		const sizeText = fileStat.size ? ` (${fileStat.size} bytes)` : "";
		const message = `Deleted ${pathArg}${sizeText}`;
		result = { content: [{ type: "text", text: message }], details: {} };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		result = buildToolErrorResult(message);
		isError = true;
	}

	options.emitEvent?.({ type: "tool_execution_end", toolCallId, toolName, result, isError });
	return createToolResultMessage(toolCallId, toolName, result, isError);
}

function decodeToolCallId(toolCallId?: string): string {
	return toolCallId && toolCallId.length > 0 ? toolCallId : randomUUID();
}

function decodeMcpArgs(rawArgs: Record<string, Uint8Array>): Record<string, unknown> {
	const decoded: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(rawArgs)) {
		const text = new TextDecoder().decode(value);
		try {
			decoded[key] = JSON.parse(text);
		} catch {
			decoded[key] = text;
		}
	}
	return decoded;
}

function formatMcpToolErrorMessage(toolName: string, availableTools: string[]): string {
	const list = availableTools.length > 0 ? availableTools.join(", ") : "none";
	return `MCP tool "${toolName}" not found. Available tools: ${list}`;
}

/**
 * Cursor's wire protocol carries shell timeouts in milliseconds — the
 * model-facing parameter is `block_until_ms`, and `ShellArgs.hard_timeout` is
 * likewise documented in ms — while the bash tool's `timeout` is seconds.
 * Passing the raw value through made a requested 30 s wait (30000 ms) arrive
 * as 30000 s and clamp to the 3600 s ceiling, i.e. an accidental 1-hour
 * timeout on a blocking command. Convert, rounding sub-second values up to 1 s
 * so a tiny requested wait does not collapse to "no timeout".
 */
function shellTimeoutSeconds(timeout: number | undefined): number | undefined {
	if (!timeout || timeout <= 0) return undefined;
	return Math.max(1, Math.ceil(timeout / 1000));
}

function cursorAbortError(signal: AbortSignal): Error {
	const reason = signal.reason;
	return reason instanceof Error ? reason : new Error("Request was aborted");
}

export class CursorExecHandlers implements ICursorExecHandlers {
	constructor(private options: CursorExecBridgeOptions) {
		// Bind every native handler so methods stay instance-safe when invoked
		// detached/unbound by the Cursor provider (e.g. `const read = handlers.read`).
		// Without this, `this.#optionsForCall()` throws "undefined is not an object".
		this.read = this.read.bind(this);
		this.ls = this.ls.bind(this);
		this.grep = this.grep.bind(this);
		this.write = this.write.bind(this);
		this.delete = this.delete.bind(this);
		this.shell = this.shell.bind(this);
		this.shellStream = this.shellStream.bind(this);
		this.diagnostics = this.diagnostics.bind(this);
		this.mcp = this.mcp.bind(this);
		this.piRead = this.piRead.bind(this);
		this.piBash = this.piBash.bind(this);
		this.piEdit = this.piEdit.bind(this);
		this.piWrite = this.piWrite.bind(this);
		this.piGrep = this.piGrep.bind(this);
		this.piFind = this.piFind.bind(this);
		this.piLs = this.piLs.bind(this);
	}

	#optionsForCall(): CursorExecBridgeOptions {
		const emit = this.options.createEventEmitter ? this.options.createEventEmitter() : this.options.emitEvent;
		// Producer boundary: bind the selected object to the event BEFORE it leaves this
		// bridge, so the run-scoped Agent emitter (and every consumer after it) receives an
		// event whose provenance is already proven and never re-resolved from a registry
		// that may have been replaced in the meantime.
		const emitWithIdentity: CursorExecEventEmitter | undefined = emit
			? (event: AgentEvent, dispatchedTool?: AgentTool) => {
					bindDispatchedToolIdentity(event, dispatchedTool);
					emit(event);
				}
			: undefined;
		return {
			...this.options,
			emitEvent: emitWithIdentity,
		};
	}

	async read(
		args: Parameters<NonNullable<ICursorExecHandlers["read"]>>[0],
		signal?: AbortSignal,
		markNonAbortable?: () => void,
	) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const toolResultMessage = await executeTool(
			this.#optionsForCall(),
			"read",
			toolCallId,
			{ path: args.path },
			undefined,
			signal,
			markNonAbortable,
		);
		return toolResultMessage;
	}

	async ls(
		args: Parameters<NonNullable<ICursorExecHandlers["ls"]>>[0],
		signal?: AbortSignal,
		markNonAbortable?: () => void,
	) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		// Redirect ls to read tool, which handles directories
		const toolResultMessage = await executeTool(
			this.#optionsForCall(),
			"read",
			toolCallId,
			{ path: args.path },
			undefined,
			signal,
			markNonAbortable,
		);
		return toolResultMessage;
	}

	async grep(args: Parameters<NonNullable<ICursorExecHandlers["grep"]>>[0], signal?: AbortSignal) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		// Cursor's native Glob tool arrives as a grep exec with a glob but no content
		// pattern. The search tool requires a non-empty pattern, so an empty pattern
		// means "list files matching this glob" — route that to find instead of
		// throwing "Pattern must not be empty".
		const pattern = typeof args.pattern === "string" ? args.pattern : "";
		if (pattern.trim().length === 0) {
			if (args.glob) {
				const globPath = `${args.path || "."}/${args.glob}`;
				return executeTool(this.#optionsForCall(), "find", toolCallId, { paths: [globPath] }, undefined, signal);
			}
			const result = buildToolErrorResult(
				"Cursor grep request rejected: pattern must not be empty. Provide a non-empty search pattern.",
			);
			return createToolResultMessage(toolCallId, "search", result, true);
		}
		const searchPath = args.glob ? `${args.path || "."}/${args.glob}` : args.path || ".";
		const toolResultMessage = await executeTool(
			this.#optionsForCall(),
			"search",
			toolCallId,
			{
				pattern,
				paths: [searchPath],
				i: args.caseInsensitive || undefined,
			},
			undefined,
			signal,
		);
		return toolResultMessage;
	}

	async write(
		args: Parameters<NonNullable<ICursorExecHandlers["write"]>>[0],
		signal?: AbortSignal,
		markNonAbortable?: () => void,
	) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const content = args.fileText ?? new TextDecoder().decode(args.fileBytes ?? new Uint8Array());
		const toolResultMessage = await executeTool(
			this.#optionsForCall(),
			"write",
			toolCallId,
			{
				path: args.path,
				content,
			},
			undefined,
			signal,
			markNonAbortable,
		);
		return toolResultMessage;
	}

	async delete(
		args: Parameters<NonNullable<ICursorExecHandlers["delete"]>>[0],
		signal?: AbortSignal,
		markNonAbortable?: () => void,
	) {
		if (signal?.aborted) throw cursorAbortError(signal);
		const toolCallId = decodeToolCallId(args.toolCallId);
		const toolResultMessage = await executeDelete(
			this.#optionsForCall(),
			args.path,
			toolCallId,
			signal,
			markNonAbortable,
		);
		return toolResultMessage;
	}

	async shell(
		args: Parameters<NonNullable<ICursorExecHandlers["shell"]>>[0],
		signal?: AbortSignal,
		markNonAbortable?: () => void,
	) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const timeoutSeconds = shellTimeoutSeconds(args.timeout);
		const toolResultMessage = await executeTool(
			this.#optionsForCall(),
			"bash",
			toolCallId,
			{
				command: args.command,
				cwd: args.workingDirectory || undefined,
				timeout: timeoutSeconds,
			},
			undefined,
			signal,
			markNonAbortable,
		);
		return toolResultMessage;
	}

	async shellStream(
		args: Parameters<NonNullable<ICursorExecHandlers["shellStream"]>>[0],
		callbacks: CursorShellStreamCallbacks,
		signal?: AbortSignal,
		markNonAbortable?: () => void,
	) {
		if (signal?.aborted) throw cursorAbortError(signal);
		const options = this.#optionsForCall();
		const toolCallId = decodeToolCallId(args.toolCallId);
		const toolName = "bash";
		const tool = options.tools.get(toolName);
		if (!tool) {
			const result = buildToolErrorResult(`Tool "${toolName}" not available`);
			return createToolResultMessage(toolCallId, toolName, result, true);
		}

		const timeoutSeconds = shellTimeoutSeconds(args.timeout);
		const toolArgs: Record<string, unknown> = {
			command: args.command,
			cwd: args.workingDirectory || undefined,
			timeout: timeoutSeconds,
		};

		options.emitEvent?.({ type: "tool_execution_start", toolCallId, toolName, args: toolArgs }, tool);
		if (signal?.aborted) throw cursorAbortError(signal);

		let result: AgentToolResult<unknown>;
		let isError = false;

		let rawText = "";
		let sanitizedRawText = "";
		let streamedSanitizedText = "";
		let canStreamSanitizedDelta = true;
		const onUpdate: AgentToolUpdateCallback<unknown> = partialResult => {
			const newRawText = partialResult.content.map(c => (c.type === "text" ? c.text : "")).join("");
			if (newRawText === rawText) {
				return;
			}
			rawText = newRawText;
			sanitizedRawText = sanitizeText(newRawText);
			const sanitizedPartialResult: AgentToolResult<unknown> = {
				content: [{ type: "text" as const, text: sanitizedRawText }],
				details: partialResult.details,
			};
			options.emitEvent?.({
				type: "tool_execution_update",
				toolCallId,
				toolName,
				args: toolArgs,
				partialResult: sanitizedPartialResult,
			});
			if (!canStreamSanitizedDelta) {
				return;
			}
			if (sanitizedRawText.startsWith(streamedSanitizedText)) {
				const sanitizedDelta = sanitizedRawText.slice(streamedSanitizedText.length);
				streamedSanitizedText = sanitizedRawText;
				if (sanitizedDelta) {
					callbacks.onStdout(sanitizedDelta);
				}
				return;
			}
			// Cursor's shell-stream callback is append-only. Once the sanitized snapshot
			// stops being a prefix extension, we can no longer repair the stream safely.
			// Keep emitting full snapshots via tool_execution_update, but stop stdout deltas.
			canStreamSanitizedDelta = false;
		};

		try {
			const nonAbortable = tool.nonAbortable === true;
			const toolContext = options.getToolContext?.();
			if (signal?.aborted) throw cursorAbortError(signal);
			if (nonAbortable) markNonAbortable?.();
			result = await tool.execute(toolCallId, toolArgs, nonAbortable ? undefined : signal, onUpdate, toolContext);
		} catch (error) {
			if (isCursorExecAdmissionClosedError(error)) throw error;
			const message = error instanceof Error ? error.message : String(error);
			result = buildToolErrorResult(message);
			isError = true;
		}

		// onUpdate may not fire for every chunk — flush any remaining output
		// from the final result that wasn't already streamed.
		const finalRawText = result.content.map(c => (c.type === "text" ? c.text : "")).join("");
		if (finalRawText !== rawText) {
			rawText = finalRawText;
			sanitizedRawText = sanitizeText(finalRawText);
		}
		if (canStreamSanitizedDelta && sanitizedRawText.startsWith(streamedSanitizedText)) {
			const finalDelta = sanitizedRawText.slice(streamedSanitizedText.length);
			streamedSanitizedText = sanitizedRawText;
			if (finalDelta) {
				callbacks.onStdout(finalDelta);
			}
		}

		const sanitizedFinalResult: AgentToolResult<unknown> = {
			content: result.content.map(c => (c.type === "text" ? { ...c, text: sanitizeText(c.text) } : c)),
			details: result.details,
		};
		options.emitEvent?.({
			type: "tool_execution_end",
			toolCallId,
			toolName,
			result: sanitizedFinalResult,
			isError,
		});
		return createToolResultMessage(toolCallId, toolName, result, isError);
	}

	async piRead(call: Parameters<NonNullable<ICursorExecHandlers["piRead"]>>[0]) {
		const composed = piReadPath(call.args.path, call.args.offset, call.args.limit);
		if (composed === null) {
			return createToolResultMessage(call.toolCallId, "read", { content: [{ type: "text", text: "" }] }, false);
		}
		return executeTool(
			this.#optionsForCall(),
			"read",
			call.toolCallId,
			{ path: composed },
			undefined,
			call.signal,
			call.markNonAbortable,
		);
	}

	async piBash(call: Parameters<NonNullable<ICursorExecHandlers["piBash"]>>[0]) {
		return executeTool(
			this.#optionsForCall(),
			"bash",
			call.toolCallId,
			{
				command: call.args.command,
				timeout: piTimeout(call.args.timeout),
			},
			undefined,
			call.signal,
			call.markNonAbortable,
		);
	}

	async piEdit(call: Parameters<NonNullable<ICursorExecHandlers["piEdit"]>>[0]) {
		const edits = call.args.edits.map(edit => ({
			old_text: edit.oldText,
			new_text: edit.newText,
		}));
		return executeTool(
			this.#optionsForCall(),
			"edit",
			call.toolCallId,
			{ path: call.args.path, edits },
			this.options.getEditReplaceTool?.(),
			call.signal,
			call.markNonAbortable,
		);
	}

	async piWrite(call: Parameters<NonNullable<ICursorExecHandlers["piWrite"]>>[0]) {
		return executeTool(
			this.#optionsForCall(),
			"write",
			call.toolCallId,
			{
				path: call.args.path,
				content: call.args.content,
			},
			undefined,
			call.signal,
			call.markNonAbortable,
		);
	}

	async piGrep(call: Parameters<NonNullable<ICursorExecHandlers["piGrep"]>>[0]) {
		const { pattern, path, glob, ignoreCase, literal, context, limit } = call.args;
		const perCallSearch = this.options.createSearchTool?.({
			context: context === undefined ? undefined : Math.max(0, Math.floor(context)),
			totalMatchLimit: piLimit(limit),
		});
		const args: Record<string, unknown> = {
			pattern: literal === true ? piEscapeRegexLiteral(pattern) : pattern,
			paths: [glob ? piJoinPath(path, glob) : path || "."],
		};
		if (ignoreCase === true) args.i = true;
		return executeTool(this.#optionsForCall(), "search", call.toolCallId, args, perCallSearch, call.signal);
	}

	async piFind(call: Parameters<NonNullable<ICursorExecHandlers["piFind"]>>[0]) {
		const { pattern, path, limit } = call.args;
		return executeTool(
			this.#optionsForCall(),
			"find",
			call.toolCallId,
			{
				paths: [piJoinPath(path, pattern)],
				limit: piLimit(limit),
			},
			undefined,
			call.signal,
		);
	}

	async piLs(call: Parameters<NonNullable<ICursorExecHandlers["piLs"]>>[0]) {
		return executeTool(
			this.#optionsForCall(),
			"read",
			call.toolCallId,
			{
				path: piLsPath(call.args.path),
			},
			undefined,
			call.signal,
			call.markNonAbortable,
		);
	}

	async diagnostics(args: Parameters<NonNullable<ICursorExecHandlers["diagnostics"]>>[0], signal?: AbortSignal) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const toolResultMessage = await executeTool(
			this.#optionsForCall(),
			"lsp",
			toolCallId,
			{
				action: "diagnostics",
				file: args.path,
			},
			undefined,
			signal,
		);
		return toolResultMessage;
	}

	async mcp(call: CursorMcpCall, signal?: AbortSignal, markNonAbortable?: () => void) {
		const options = this.#optionsForCall();
		const toolName = call.toolName || call.name;
		const toolCallId = decodeToolCallId(call.toolCallId);
		const tool = options.tools.get(toolName);
		if (!tool) {
			const availableTools = Array.from(options.tools.keys()).filter(name => name.startsWith("mcp__"));
			const message = formatMcpToolErrorMessage(toolName, availableTools);
			const result = buildToolErrorResult(message);
			return createToolResultMessage(toolCallId, toolName, result, true);
		}

		const args = Object.keys(call.args ?? {}).length > 0 ? call.args : decodeMcpArgs(call.rawArgs ?? {});
		const toolResultMessage = await executeTool(
			options,
			toolName,
			toolCallId,
			args,
			undefined,
			signal,
			markNonAbortable,
		);
		return toolResultMessage;
	}
}
