import type { JsonValue } from "../../../vendor/codex-app-server-schema/stable/typescript/serde_json/JsonValue";
import type { CommandAction } from "../../../vendor/codex-app-server-schema/stable/typescript/v2/CommandAction";
import type { CommandExecutionOutputDeltaNotification as CodexCommandExecutionOutputDeltaNotification } from "../../../vendor/codex-app-server-schema/stable/typescript/v2/CommandExecutionOutputDeltaNotification";
import type { FileChangeOutputDeltaNotification as CodexFileChangeOutputDeltaNotification } from "../../../vendor/codex-app-server-schema/stable/typescript/v2/FileChangeOutputDeltaNotification";
import type { FileChangePatchUpdatedNotification as CodexFileChangePatchUpdatedNotification } from "../../../vendor/codex-app-server-schema/stable/typescript/v2/FileChangePatchUpdatedNotification";
import type { ItemCompletedNotification as CodexItemCompletedNotification } from "../../../vendor/codex-app-server-schema/stable/typescript/v2/ItemCompletedNotification";
import type { ItemStartedNotification as CodexItemStartedNotification } from "../../../vendor/codex-app-server-schema/stable/typescript/v2/ItemStartedNotification";
import type { McpToolCallProgressNotification as CodexMcpToolCallProgressNotification } from "../../../vendor/codex-app-server-schema/stable/typescript/v2/McpToolCallProgressNotification";
import type { PlanDeltaNotification as CodexPlanDeltaNotification } from "../../../vendor/codex-app-server-schema/stable/typescript/v2/PlanDeltaNotification";
import type { ReasoningSummaryPartAddedNotification as CodexReasoningSummaryPartAddedNotification } from "../../../vendor/codex-app-server-schema/stable/typescript/v2/ReasoningSummaryPartAddedNotification";
import type { ReasoningSummaryTextDeltaNotification as CodexReasoningSummaryTextDeltaNotification } from "../../../vendor/codex-app-server-schema/stable/typescript/v2/ReasoningSummaryTextDeltaNotification";
import type { ReasoningTextDeltaNotification as CodexReasoningTextDeltaNotification } from "../../../vendor/codex-app-server-schema/stable/typescript/v2/ReasoningTextDeltaNotification";
import type { ThreadItem } from "../../../vendor/codex-app-server-schema/stable/typescript/v2/ThreadItem";
import type { AgentSessionEvent } from "../../session/agent-session";
import { stableValidators } from "../protocol-source/schema-validators.generated";
import { type ClassifiedItemKind, classifyGjcTool } from "./item-kind-map";

export interface ToolItemReducerOptions {
	readonly threadId: string;
	readonly turnId: string;
	/** Milliseconds since the Unix epoch, matching item notification fields. */
	readonly clock: () => number;
}

export type ItemStartedNotification = {
	method: "item/started";
	params: CodexItemStartedNotification;
};

export type ItemCompletedNotification = {
	method: "item/completed";
	params: CodexItemCompletedNotification;
};

export type CommandExecutionOutputDeltaNotification = {
	method: "item/commandExecution/outputDelta";
	params: CodexCommandExecutionOutputDeltaNotification;
};

export type FileChangeOutputDeltaNotification = {
	method: "item/fileChange/outputDelta";
	params: CodexFileChangeOutputDeltaNotification;
};

export type FileChangePatchUpdatedNotification = {
	method: "item/fileChange/patchUpdated";
	params: CodexFileChangePatchUpdatedNotification;
};

export type McpToolCallProgressNotification = {
	method: "item/mcpToolCall/progress";
	params: CodexMcpToolCallProgressNotification;
};

export type PlanDeltaNotification = {
	method: "item/plan/delta";
	params: CodexPlanDeltaNotification;
};

export type ReasoningSummaryPartAddedNotification = {
	method: "item/reasoning/summaryPartAdded";
	params: CodexReasoningSummaryPartAddedNotification;
};

export type ReasoningSummaryTextDeltaNotification = {
	method: "item/reasoning/summaryTextDelta";
	params: CodexReasoningSummaryTextDeltaNotification;
};

export type ReasoningTextDeltaNotification = {
	method: "item/reasoning/textDelta";
	params: CodexReasoningTextDeltaNotification;
};

export type WireNotification =
	| ItemStartedNotification
	| ItemCompletedNotification
	| CommandExecutionOutputDeltaNotification
	| FileChangeOutputDeltaNotification
	| FileChangePatchUpdatedNotification
	| McpToolCallProgressNotification
	| PlanDeltaNotification
	| ReasoningSummaryPartAddedNotification
	| ReasoningSummaryTextDeltaNotification
	| ReasoningTextDeltaNotification;

export type ToolItemTurnOutcomeKind = "completed" | "interrupted" | "failed";

export interface ToolItemTurnOutcome {
	readonly kind: ToolItemTurnOutcomeKind;
}

type ReasoningItem = Extract<ThreadItem, { type: "reasoning" }>;
type PlanItem = Extract<ThreadItem, { type: "plan" }>;
type CommandExecutionItem = Extract<ThreadItem, { type: "commandExecution" }>;
type FileChangeItem = Extract<ThreadItem, { type: "fileChange" }>;
type McpToolCallItem = Extract<ThreadItem, { type: "mcpToolCall" }>;
type WebSearchItem = Extract<ThreadItem, { type: "webSearch" }>;
type ToolCatalogItem = CommandExecutionItem | FileChangeItem | McpToolCallItem | WebSearchItem | PlanItem;

type BaseState<TItem extends ThreadItem = ThreadItem> = {
	readonly id: string;
	readonly sequence: number;
	readonly startedAtMs: number;
	state: "open" | "completed";
	completedAtMs?: number;
	item: TItem;
};

type MappedToolClassification = ClassifiedItemKind & {
	readonly type: ToolCatalogItem["type"];
	readonly mcp?: { readonly server: string; readonly tool: string };
};

type ToolState = BaseState<ToolCatalogItem> & {
	readonly family: "tool";
	readonly toolCallId: string;
	readonly toolName: string;
	readonly classification: MappedToolClassification;
	args: JsonValue;
	lastOutput: string;
	lastProgress: string;
	lastChangesSignature: string;
	isError: boolean;
};

type ReasoningState = BaseState<ReasoningItem> & {
	readonly family: "reasoning";
	readonly key: string;
	readonly contentIndex: number;
	rawText: string;
	summaryText: string;
	rawOpen: boolean;
	summaryOpen: boolean;
	summaryPartAdded: boolean;
};

type PlanState = BaseState<PlanItem> & {
	readonly family: "plan";
	text: string;
};

type ItemState = ToolState | ReasoningState | PlanState;

type ToolResultLike = {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly content?: unknown;
	readonly details?: unknown;
	readonly isError?: boolean;
};

type ToolCallLike = {
	readonly id: string;
	readonly name: string;
	readonly arguments?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function stringProperty(value: unknown, ...keys: readonly string[]): string | undefined {
	const object = asRecord(value);
	if (!object) return undefined;
	for (const key of keys) {
		const candidate = object[key];
		if (typeof candidate === "string") return candidate;
	}
	return undefined;
}

function numberProperty(value: unknown, ...keys: readonly string[]): number | undefined {
	const object = asRecord(value);
	if (!object) return undefined;
	for (const key of keys) {
		const candidate = object[key];
		if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
	}
	return undefined;
}

function jsonValue(value: unknown): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (Array.isArray(value)) return value.map(entry => jsonValue(entry));
	const object = asRecord(value);
	if (!object) return null;
	const normalized: { [key: string]: JsonValue } = {};
	for (const key of Object.keys(object).sort()) {
		if (object[key] !== undefined) normalized[key] = jsonValue(object[key]);
	}
	return normalized;
}

function textFromContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value
			.map(entry => {
				const object = asRecord(entry);
				return object && typeof object.text === "string" ? object.text : "";
			})
			.filter(text => text.length > 0)
			.join("\n");
	}
	const object = asRecord(value);
	if (!object) return "";
	if (typeof object.text === "string") return object.text;
	for (const key of ["output", "stdout", "stderr", "message"] as const) {
		if (typeof object[key] === "string") return object[key];
	}
	if (object.content !== undefined) return textFromContent(object.content);
	if (object.result !== undefined) return textFromContent(object.result);
	return "";
}

function suffix(previous: string, snapshot: string | undefined, delta: string | undefined): string {
	if (snapshot !== undefined) {
		if (snapshot === previous) return "";
		if (snapshot.startsWith(previous)) return snapshot.slice(previous.length);
		return snapshot;
	}
	if (!delta || previous.endsWith(delta)) return "";
	return delta;
}

function commandSource(value: unknown): CommandExecutionItem["source"] {
	const source = stringProperty(value, "source");
	if (source === "userShell" || source === "unifiedExecStartup" || source === "unifiedExecInteraction") return source;
	return "agent";
}

function normalizeCommandActions(value: unknown): Array<CommandAction> {
	if (!Array.isArray(value)) return [];
	const actions: Array<CommandAction> = [];
	for (const entry of value) {
		const object = asRecord(entry);
		if (!object) continue;
		const type = object.type;
		const command = typeof object.command === "string" ? object.command : "";
		if (type === "read" && typeof object.name === "string" && typeof object.path === "string") {
			actions.push({ type, command, name: object.name, path: object.path });
		} else if (
			type === "listFiles" &&
			(object.path === null || typeof object.path === "string" || object.path === undefined)
		) {
			actions.push({ type, command, path: object.path === undefined ? null : object.path });
		} else if (
			type === "search" &&
			(object.query === null || typeof object.query === "string" || object.query === undefined)
		) {
			actions.push({
				type,
				command,
				query: object.query === undefined ? null : object.query,
				path:
					object.path === undefined || object.path === null || typeof object.path === "string"
						? (object.path ?? null)
						: null,
			});
		} else if (type === "unknown") {
			actions.push({ type, command });
		}
	}
	return actions;
}

function patchKind(
	value: unknown,
	fallback: ClassifiedItemKind["kind"],
): { type: "add" } | { type: "delete" } | { type: "update"; move_path: string | null } {
	const type = stringProperty(value, "type", "kind");
	if (type === "add") return { type: "add" };
	if (type === "delete") return { type: "delete" };
	const movePath = stringProperty(value, "move_path", "movePath", "newPath", "destination");
	if (fallback === "delete") return { type: "delete" };
	return { type: "update", move_path: movePath ?? null };
}

function normalizeFileChanges(
	value: unknown,
	fallback: ClassifiedItemKind["kind"],
): Array<FileChangeItem["changes"][number]> {
	const changes: Array<FileChangeItem["changes"][number]> = [];
	if (Array.isArray(value)) {
		for (const entry of value) {
			const object = asRecord(entry);
			if (!object) continue;
			const path = stringProperty(object, "path", "file", "filePath", "oldPath");
			if (!path) continue;
			changes.push({
				path,
				kind: patchKind(object, fallback),
				diff: stringProperty(object, "diff", "unifiedDiff", "patch") ?? "",
			});
		}
	} else {
		const object = asRecord(value);
		if (object) {
			for (const [path, entry] of Object.entries(object).sort(([left], [right]) => left.localeCompare(right))) {
				const detail = asRecord(entry);
				changes.push({
					path,
					kind: patchKind(detail, fallback),
					diff: stringProperty(detail, "diff", "unifiedDiff", "patch") ?? "",
				});
			}
		}
	}
	return changes;
}

function extractFileChanges(
	args: unknown,
	result: unknown,
	fallback: ClassifiedItemKind["kind"],
): Array<FileChangeItem["changes"][number]> {
	const resultDetails = asRecord(asRecord(result)?.details);
	const argsObject = asRecord(args);
	const candidates: unknown[] = [
		resultDetails?.changes,
		resultDetails?.fileChanges,
		asRecord(result)?.changes,
		asRecord(result)?.fileChanges,
		argsObject?.changes,
		argsObject?.fileChanges,
	];
	for (const candidate of candidates) {
		const changes = normalizeFileChanges(candidate, fallback);
		if (changes.length > 0) return changes;
	}
	const path = stringProperty(args, "path", "file", "filePath", "oldPath");
	if (!path) return [];
	return [{ path, kind: patchKind(args, fallback), diff: "" }];
}

function extractPlanText(args: unknown, result: unknown): string {
	const details = asRecord(asRecord(result)?.details);
	const candidate =
		details?.phases ??
		details?.todos ??
		asRecord(result)?.phases ??
		asRecord(args)?.phases ??
		asRecord(args)?.todos ??
		args;
	const value = jsonValue(candidate);
	return JSON.stringify(value);
}

function normalizeWebSearchAction(value: unknown): WebSearchItem["action"] {
	const object = asRecord(value);
	if (!object) return null;
	const type = object.type;
	if (type === "search") {
		const query = typeof object.query === "string" ? object.query : null;
		const queries = Array.isArray(object.queries)
			? object.queries.filter((entry): entry is string => typeof entry === "string")
			: null;
		return { type, query, queries };
	}
	if (type === "openPage" || type === "open_page")
		return { type: "openPage", url: typeof object.url === "string" ? object.url : null };
	if (type === "findInPage" || type === "find_in_page") {
		return {
			type: "findInPage",
			url: typeof object.url === "string" ? object.url : null,
			pattern: typeof object.pattern === "string" ? object.pattern : null,
		};
	}
	if (type === "other") return { type };
	return null;
}

function extractWebSearchResults(result: unknown): Array<JsonValue> | null {
	const details = asRecord(asRecord(result)?.details);
	const candidate = details?.results ?? asRecord(result)?.results;
	return Array.isArray(candidate) ? candidate.map(entry => jsonValue(entry)) : null;
}

function toolCallFromValue(value: unknown): ToolCallLike | undefined {
	const object = asRecord(value);
	if (!object) return undefined;
	const id = object.id;
	const name = object.name;
	if (typeof id !== "string" || typeof name !== "string" || id.length === 0 || name.length === 0) return undefined;
	return { id, name, arguments: object.arguments };
}

function toolCallFromPartial(partial: unknown, contentIndex: number): ToolCallLike | undefined {
	const content = asRecord(partial)?.content;
	if (!Array.isArray(content)) return undefined;
	return toolCallFromValue(content[contentIndex]);
}

function toolResultFromMessage(value: unknown): ToolResultLike | undefined {
	const object = asRecord(value);
	if (object?.role !== "toolResult") return undefined;
	const toolCallId = object.toolCallId;
	const toolName = object.toolName;
	if (
		typeof toolCallId !== "string" ||
		typeof toolName !== "string" ||
		toolCallId.length === 0 ||
		toolName.length === 0
	)
		return undefined;
	return {
		toolCallId,
		toolName,
		content: object.content,
		details: object.details,
		isError: object.isError === true,
	};
}

function itemTypeIsTool(type: ThreadItem["type"]): type is ToolCatalogItem["type"] {
	return (
		type === "commandExecution" ||
		type === "fileChange" ||
		type === "mcpToolCall" ||
		type === "webSearch" ||
		type === "plan"
	);
}

function isMappedToolClassification(
	value: ClassifiedItemKind & { readonly mcp?: { readonly server: string; readonly tool: string } },
): value is MappedToolClassification {
	return value.type !== null && itemTypeIsTool(value.type);
}

function validated<T extends WireNotification>(notification: T): T {
	const validator = stableValidators.serverNotificationParams[notification.method];
	if (!validator?.(notification.params)) {
		throw new Error(`Invalid stable ${notification.method} params emitted by tool-item reducer`);
	}
	return notification;
}

export class ToolItemReducer {
	readonly #threadId: string;
	readonly #turnId: string;
	readonly #clock: () => number;
	readonly #items = new Map<string, ItemState>();
	readonly #toolCallToItem = new Map<string, string>();
	#sequence = 0;
	#fallbackSequence = 0;
	readonly #fallbackReasoningByContentIndex = new Map<number, string>();

	constructor(options: ToolItemReducerOptions) {
		this.#threadId = options.threadId;
		this.#turnId = options.turnId;
		this.#clock = options.clock;
	}

	get openItemCount(): number {
		return this.#orderedItems().filter(item => item.state === "open").length;
	}

	/** Stable start order is also the final item order used by projection callers. */
	get items(): readonly ThreadItem[] {
		return this.#orderedItems().map(item => item.item);
	}

	accept(event: AgentSessionEvent): readonly WireNotification[] {
		switch (event.type) {
			case "message_update":
				return this.#acceptMessageUpdate(event);
			case "message_start":
				return this.#acceptMessageEnvelope(event.message, false);
			case "message_end":
				return this.#acceptMessageEnvelope(event.message, true);
			case "tool_execution_start":
				return this.#acceptToolExecutionStart(event.toolCallId, event.toolName, event.args);
			case "tool_execution_update":
				return this.#acceptToolExecutionUpdate(event.toolCallId, event.toolName, event.args, event.partialResult);
			case "tool_execution_end":
				return this.#acceptToolExecutionEnd(
					event.toolCallId,
					event.toolName,
					event.result,
					event.isError === true || asRecord(event.result)?.isError === true,
				);
			case "turn_end":
				return event.toolResults.flatMap(result => this.#acceptToolResultMessage(result));
			case "todo_reminder":
				return this.#acceptTodoReminder(event.todos);
			case "todo_auto_clear":
				return this.#acceptTodoAutoClear();
			case "agent_start":
				return [];
			case "agent_end":
				if (event.stopReason === "maintenance") return [];
				return this.completeTurn({ kind: event.stopReason === "completed" ? "completed" : "interrupted" });
			case "turn_start":
			case "auto_compaction_start":
			case "auto_compaction_end":
			case "auto_retry_start":
			case "auto_retry_end":
			case "model_fallback_switched":
			case "ttsr_triggered":
			case "irc_message":
			case "subagent_steer_message":
			case "notice":
			case "thinking_level_changed":
			case "goal_updated":
				return [];
		}
	}

	completeTurn(outcome: ToolItemTurnOutcome): readonly WireNotification[] {
		const open = this.#orderedItems().filter(item => item.state === "open");
		if (outcome.kind === "completed" && open.length > 0) {
			throw new Error(`Cannot terminalize tool items for turn ${this.#turnId}: no authoritative terminal event`);
		}
		const notifications: WireNotification[] = [];
		for (const state of open) {
			if (state.family === "tool") {
				state.isError = outcome.kind !== "completed";
				state.item = this.#terminalToolItem(state, state.isError);
			} else if (state.family === "reasoning") {
				state.rawOpen = false;
				state.summaryOpen = false;
			} else {
				state.item = { ...state.item, text: state.text };
			}
			notifications.push(...this.#complete(state));
		}
		return notifications;
	}
	#acceptMessageEnvelope(value: unknown, terminal: boolean): readonly WireNotification[] {
		const toolResult = toolResultFromMessage(value);
		if (toolResult) return this.#acceptToolResultMessage(value);
		const object = asRecord(value);
		if (object?.role !== "assistant" || !Array.isArray(object.content)) return [];
		const notifications: WireNotification[] = [];
		for (let contentIndex = 0; contentIndex < object.content.length; contentIndex += 1) {
			const block = object.content[contentIndex];
			const call = toolCallFromValue(block);
			if (call) notifications.push(...this.#acceptModelToolCall(call, value));
			if (asRecord(block)?.type !== "thinking") continue;
			const thinking = stringProperty(block, "thinking");
			if (thinking === undefined) continue;
			const ensured = this.#ensureReasoning(value, contentIndex);
			if (!ensured.state || ensured.state.state === "completed") continue;
			notifications.push(...this.#acceptReasoningDelta(value, contentIndex, thinking, "raw"));
			ensured.state.rawOpen = !terminal;
			if (terminal) notifications.push(...this.#complete(ensured.state));
		}
		return notifications;
	}

	#acceptMessageUpdate(event: Extract<AgentSessionEvent, { type: "message_update" }>): readonly WireNotification[] {
		const messageEvent = event.assistantMessageEvent;
		switch (messageEvent.type) {
			case "thinking_start":
				return this.#acceptReasoningStart(messageEvent.partial, messageEvent.contentIndex, "raw");
			case "reasoning_summary_start":
				return this.#acceptReasoningStart(messageEvent.partial, messageEvent.contentIndex, "summary");
			case "thinking_delta":
				return this.#acceptReasoningDelta(
					messageEvent.partial,
					messageEvent.contentIndex,
					messageEvent.delta,
					"raw",
				);
			case "reasoning_summary_delta":
				return this.#acceptReasoningDelta(
					messageEvent.partial,
					messageEvent.contentIndex,
					messageEvent.delta,
					"summary",
				);
			case "thinking_end":
				return this.#acceptReasoningEnd(
					messageEvent.partial,
					messageEvent.contentIndex,
					messageEvent.content,
					"raw",
				);
			case "reasoning_summary_end":
				return this.#acceptReasoningEnd(
					messageEvent.partial,
					messageEvent.contentIndex,
					messageEvent.content,
					"summary",
				);
			case "toolcall_start": {
				const call = toolCallFromPartial(messageEvent.partial, messageEvent.contentIndex);
				return call ? this.#acceptModelToolCall(call, messageEvent.partial) : [];
			}
			case "toolcall_delta": {
				const call = toolCallFromPartial(messageEvent.partial, messageEvent.contentIndex);
				return call ? this.#acceptModelToolCall(call, messageEvent.partial) : [];
			}
			case "toolcall_end": {
				const call = toolCallFromValue(messageEvent.toolCall);
				return call ? this.#acceptModelToolCall(call, messageEvent.partial) : [];
			}
			case "start":
			case "text_start":
			case "text_delta":
			case "text_end":
			case "done":
			case "error":
			case "toolChoiceIncapability":
				return [];
		}
	}

	#acceptModelToolCall(call: ToolCallLike, partial: unknown): readonly WireNotification[] {
		/*
		 * `toolcall_start` is authoritative when model output is available: it gives
		 * the stable call id before execution. `tool_execution_start` only enriches
		 * that state (or acts as a fallback for non-streaming/replayed output), so
		 * one logical call can never emit two item/started notifications.
		 */
		const started = this.#startTool(
			call.id,
			call.name,
			call.arguments ?? toolCallFromPartial(partial, 0)?.arguments ?? {},
		);
		if (!started.state) return started.notifications;
		this.#applyToolObservation(started.state, call.arguments, undefined, false);
		return started.notifications;
	}

	#acceptToolExecutionStart(toolCallId: string, toolName: string, args: unknown): readonly WireNotification[] {
		const started = this.#startTool(toolCallId, toolName, args);
		if (!started.state) return started.notifications;
		this.#applyToolObservation(started.state, args, undefined, false);
		return started.notifications;
	}

	#acceptToolExecutionUpdate(
		toolCallId: string,
		toolName: string,
		args: unknown,
		partialResult: unknown,
	): readonly WireNotification[] {
		const started = this.#startTool(toolCallId, toolName, args);
		if (!started.state) return started.notifications;
		const notifications = [...started.notifications];
		notifications.push(...this.#applyToolObservation(started.state, args, partialResult, false));
		return notifications;
	}

	#acceptToolExecutionEnd(
		toolCallId: string,
		toolName: string,
		result: unknown,
		isError: boolean,
	): readonly WireNotification[] {
		const state = this.#toolState(toolCallId, toolName);
		if (!state || state.state === "completed") return [];
		const notifications = [...this.#applyToolObservation(state, undefined, result, isError)];
		state.item = this.#terminalToolItem(state, isError);
		notifications.push(...this.#complete(state));
		return notifications;
	}

	#acceptToolResultMessage(value: unknown): readonly WireNotification[] {
		const result = toolResultFromMessage(value);
		if (!result) return [];
		const state = this.#toolState(result.toolCallId, result.toolName);
		if (!state || state.state === "completed") return [];
		const notifications = [...this.#applyToolObservation(state, undefined, result, result.isError === true)];
		state.item = this.#terminalToolItem(state, result.isError === true);
		notifications.push(...this.#complete(state));
		return notifications;
	}

	#startTool(
		toolCallId: string,
		toolName: string,
		args: unknown,
	): { state?: ToolState; notifications: WireNotification[] } {
		if (toolCallId.length === 0 || toolName.length === 0) return { notifications: [] };
		const classification = classifyGjcTool(toolName);
		if (!isMappedToolClassification(classification)) {
			return { notifications: [] };
		}
		const existingId = this.#toolCallToItem.get(toolCallId);
		if (existingId) {
			const existing = this.#items.get(existingId);
			if (existing?.family !== "tool") throw new Error(`Tool call ${toolCallId} resolved to an ambiguous item`);
			if (existing.toolName !== toolName || existing.item.type !== classification.type) {
				throw new Error(`Tool call ${toolCallId} changed identity from ${existing.toolName} to ${toolName}`);
			}
			return { state: existing, notifications: [] };
		}
		const state = this.#newToolState(toolCallId, toolName, classification, args);
		this.#items.set(state.id, state);
		this.#toolCallToItem.set(toolCallId, state.id);
		return { state, notifications: [this.#started(state)] };
	}

	#newToolState(
		toolCallId: string,
		toolName: string,
		classification: ClassifiedItemKind & {
			readonly type: Exclude<ToolCatalogItem["type"], "reasoning">;
			readonly mcp?: { readonly server: string; readonly tool: string };
		},
		args: unknown,
	): ToolState {
		const id = `tool-item:${toolCallId}`;
		const normalizedArgs = jsonValue(args);
		let item: ToolCatalogItem;
		switch (classification.type) {
			case "commandExecution":
				item = {
					type: classification.type,
					id,
					pluginId: null,
					scriptPath: null,
					command: stringProperty(args, "command", "cmd") ?? toolName,
					cwd: stringProperty(args, "cwd", "workingDirectory", "workdir") ?? ".",
					processId: stringProperty(args, "processId", "process_id") ?? null,
					source: commandSource(args),
					status: "inProgress",
					commandActions: normalizeCommandActions(asRecord(args)?.commandActions),
					aggregatedOutput: null,
					exitCode: null,
					durationMs: null,
				};
				break;
			case "fileChange":
				item = {
					type: classification.type,
					id,
					changes: extractFileChanges(args, undefined, classification.kind),
					status: "inProgress",
				};
				break;
			case "mcpToolCall":
				item = {
					type: classification.type,
					id,
					server: classification.mcp?.server ?? stringProperty(args, "server", "serverName") ?? "unknown",
					tool: classification.mcp?.tool ?? stringProperty(args, "tool", "toolName") ?? toolName,
					status: "inProgress",
					arguments: normalizedArgs,
					appContext: null,
					pluginId: null,
					result: null,
					error: null,
					durationMs: null,
				};
				break;
			case "webSearch":
				item = {
					type: classification.type,
					id,
					query: stringProperty(args, "query", "q") ?? "",
					action: normalizeWebSearchAction(asRecord(args)?.action),
					results: null,
				};
				break;
			case "plan":
				item = { type: classification.type, id, text: extractPlanText(args, undefined) };
				break;
		}
		return {
			family: "tool",
			id,
			sequence: ++this.#sequence,
			startedAtMs: this.#clock(),
			state: "open",
			item,
			toolCallId,
			toolName,
			classification,
			args: normalizedArgs,
			lastOutput: "",
			lastProgress: "",
			lastChangesSignature: JSON.stringify(item.type === "fileChange" ? item.changes : []),
			isError: false,
		};
	}

	#toolState(toolCallId: string, toolName: string): ToolState | undefined {
		const id = this.#toolCallToItem.get(toolCallId);
		if (!id) return undefined;
		const state = this.#items.get(id);
		if (state?.family !== "tool") return undefined;
		if (state.toolName !== toolName) throw new Error(`Tool call ${toolCallId} resolved to an ambiguous tool name`);
		return state;
	}

	#applyToolObservation(state: ToolState, args: unknown, result: unknown, isError: boolean): WireNotification[] {
		if (state.state === "completed") return [];
		if (args !== undefined) state.args = jsonValue(args);
		state.isError = state.isError || isError;
		const notifications: WireNotification[] = [];
		const output = textFromContent(result);
		switch (state.item.type) {
			case "commandExecution": {
				const nextOutput = output || state.lastOutput;
				const delta = suffix(state.lastOutput, output || undefined, undefined);
				state.lastOutput = nextOutput;
				const details = asRecord(asRecord(result)?.details);
				const commandActions = normalizeCommandActions(asRecord(args)?.commandActions);
				state.item = {
					...state.item,
					command: stringProperty(args, "command", "cmd") ?? state.item.command,
					cwd: stringProperty(args, "cwd", "workingDirectory", "workdir") ?? state.item.cwd,
					processId: stringProperty(args, "processId", "process_id") ?? state.item.processId,
					commandActions: commandActions.length > 0 ? commandActions : state.item.commandActions,
					aggregatedOutput: nextOutput.length > 0 ? nextOutput : null,
					exitCode:
						numberProperty(details, "exitCode") ?? numberProperty(result, "exitCode") ?? state.item.exitCode,
					durationMs: numberProperty(details, "durationMs") ?? state.item.durationMs,
					status: state.isError ? "failed" : "inProgress",
				};
				if (delta.length > 0) {
					notifications.push(
						validated({
							method: "item/commandExecution/outputDelta",
							params: { threadId: this.#threadId, turnId: this.#turnId, itemId: state.id, delta },
						}),
					);
				}
				break;
			}
			case "fileChange": {
				const changes = extractFileChanges(state.args, result, state.classification.kind);
				if (changes.length > 0) {
					const signature = JSON.stringify(changes);
					state.item = { ...state.item, changes, status: state.isError ? "failed" : "inProgress" };
					if (signature !== state.lastChangesSignature) {
						state.lastChangesSignature = signature;
						notifications.push(
							validated({
								method: "item/fileChange/patchUpdated",
								params: { threadId: this.#threadId, turnId: this.#turnId, itemId: state.id, changes },
							}),
						);
					}
				}
				const delta = suffix(state.lastOutput, output || undefined, undefined);
				state.lastOutput = output || state.lastOutput;
				if (delta.length > 0) {
					notifications.push(
						validated({
							method: "item/fileChange/outputDelta",
							params: { threadId: this.#threadId, turnId: this.#turnId, itemId: state.id, delta },
						}),
					);
				}
				break;
			}
			case "mcpToolCall": {
				const details = asRecord(asRecord(result)?.details);
				const progress =
					stringProperty(result, "message", "progress") ?? stringProperty(details, "message", "progress");
				if (progress && progress !== state.lastProgress) {
					state.lastProgress = progress;
					notifications.push(
						validated({
							method: "item/mcpToolCall/progress",
							params: { threadId: this.#threadId, turnId: this.#turnId, itemId: state.id, message: progress },
						}),
					);
				}
				const resultValue = asRecord(result)?.result ?? result;
				const resultRecord = asRecord(resultValue);
				const normalizedResult =
					resultRecord && Array.isArray(resultRecord.content)
						? {
								content: resultRecord.content.map(entry => jsonValue(entry)),
								structuredContent:
									resultRecord.structuredContent === undefined
										? null
										: jsonValue(resultRecord.structuredContent),
								_meta: resultRecord._meta === undefined ? null : jsonValue(resultRecord._meta),
							}
						: resultValue === undefined
							? null
							: { content: [jsonValue(resultValue)], structuredContent: null, _meta: null };
				const errorMessage =
					output ||
					stringProperty(result, "errorMessage", "message") ||
					stringProperty(asRecord(result)?.error, "message") ||
					(state.isError ? "MCP tool call failed" : undefined);
				state.item = {
					...state.item,
					arguments: state.args,
					result: state.isError ? null : normalizedResult,
					error: state.isError ? { message: errorMessage ?? "MCP tool call failed" } : null,
					status: state.isError ? "failed" : "inProgress",
					durationMs: numberProperty(details, "durationMs") ?? state.item.durationMs,
				};
				break;
			}
			case "webSearch": {
				const details = asRecord(asRecord(result)?.details);
				state.item = {
					...state.item,
					query: stringProperty(args, "query", "q") ?? state.item.query,
					action: normalizeWebSearchAction(asRecord(args)?.action ?? details?.action ?? asRecord(result)?.action),
					results: extractWebSearchResults(result) ?? state.item.results,
				};
				break;
			}
			case "plan": {
				const nextText =
					result === undefined ? extractPlanText(state.args, undefined) : extractPlanText(state.args, result);
				const delta = suffix(state.lastOutput, nextText, undefined);
				state.lastOutput = nextText;
				state.item = { ...state.item, text: nextText };
				if (delta.length > 0) {
					notifications.push(
						validated({
							method: "item/plan/delta",
							params: { threadId: this.#threadId, turnId: this.#turnId, itemId: state.id, delta },
						}),
					);
				}
				break;
			}
		}
		return notifications;
	}

	#terminalToolItem(state: ToolState, isError: boolean): ToolCatalogItem {
		const durationMs = Math.max(0, this.#clock() - state.startedAtMs);
		switch (state.item.type) {
			case "commandExecution":
				return {
					...state.item,
					status: isError ? "failed" : "completed",
					durationMs: state.item.durationMs ?? durationMs,
				};
			case "fileChange":
				return { ...state.item, status: isError ? "failed" : "completed" };
			case "mcpToolCall":
				return {
					...state.item,
					status: isError ? "failed" : "completed",
					durationMs: state.item.durationMs ?? durationMs,
				};
			case "webSearch":
				return state.item;
			case "plan":
				return state.item;
		}
		return state.item;
	}

	#acceptReasoningStart(partial: unknown, contentIndex: number, mode: "raw" | "summary"): readonly WireNotification[] {
		const ensured = this.#ensureReasoning(partial, contentIndex);
		if (!ensured.state || ensured.state.state === "completed") return ensured.notifications;
		if (mode === "raw") ensured.state.rawOpen = true;
		else ensured.state.summaryOpen = true;
		return ensured.notifications;
	}

	#acceptReasoningDelta(
		partial: unknown,
		contentIndex: number,
		delta: string,
		mode: "raw" | "summary",
	): readonly WireNotification[] {
		const ensured = this.#ensureReasoning(partial, contentIndex);
		if (!ensured.state || ensured.state.state === "completed") return ensured.notifications;
		const notifications = [...ensured.notifications];
		const block = this.#partialContent(partial, contentIndex);
		if (mode === "raw") {
			const appended = suffix(ensured.state.rawText, stringProperty(block, "thinking"), delta);
			ensured.state.rawText += appended;
			ensured.state.item = {
				...ensured.state.item,
				content: ensured.state.rawText.length > 0 ? [ensured.state.rawText] : [],
			};
			if (appended.length > 0) {
				notifications.push(
					validated({
						method: "item/reasoning/textDelta",
						params: {
							threadId: this.#threadId,
							turnId: this.#turnId,
							itemId: ensured.state.id,
							delta: appended,
							contentIndex,
						},
					}),
				);
			}
		} else {
			const summaryIndex = ensured.state.item.summary.length > 0 ? ensured.state.item.summary.length - 1 : 0;
			const appended = suffix(ensured.state.summaryText, stringProperty(block, "thinking"), delta);
			ensured.state.summaryText += appended;
			ensured.state.item = {
				...ensured.state.item,
				summary: ensured.state.summaryText.length > 0 ? [ensured.state.summaryText] : [],
			};
			if (appended.length > 0) {
				// A client cannot apply a delta to a summary part it has not been told about, so the
				// one-time part-added notification must precede the first delta for that index.
				if (!ensured.state.summaryPartAdded) {
					ensured.state.summaryPartAdded = true;
					notifications.push(
						validated({
							method: "item/reasoning/summaryPartAdded",
							params: {
								threadId: this.#threadId,
								turnId: this.#turnId,
								itemId: ensured.state.id,
								summaryIndex,
							},
						}),
					);
				}
				notifications.push(
					validated({
						method: "item/reasoning/summaryTextDelta",
						params: {
							threadId: this.#threadId,
							turnId: this.#turnId,
							itemId: ensured.state.id,
							delta: appended,
							summaryIndex,
						},
					}),
				);
			}
		}
		return notifications;
	}

	#acceptReasoningEnd(
		partial: unknown,
		contentIndex: number,
		content: string,
		mode: "raw" | "summary",
	): readonly WireNotification[] {
		const notifications = [...this.#acceptReasoningDelta(partial, contentIndex, content, mode)];
		const state = this.#reasoningStateForPartial(partial, contentIndex);
		if (!state || state.state === "completed") return notifications;
		if (mode === "raw") state.rawOpen = false;
		else {
			state.summaryOpen = false;
			if (!state.summaryPartAdded && state.summaryText.length > 0) {
				state.summaryPartAdded = true;
				notifications.push(
					validated({
						method: "item/reasoning/summaryPartAdded",
						params: { threadId: this.#threadId, turnId: this.#turnId, itemId: state.id, summaryIndex: 0 },
					}),
				);
			}
		}
		if (!state.rawOpen && !state.summaryOpen) notifications.push(...this.#complete(state));
		return notifications;
	}

	#partialContent(partial: unknown, contentIndex: number): unknown {
		const content = asRecord(partial)?.content;
		return Array.isArray(content) ? content[contentIndex] : undefined;
	}

	#reasoningKey(partial: unknown, contentIndex: number): string | undefined {
		const responseId = stringProperty(partial, "responseId");
		const timestamp = numberProperty(partial, "timestamp");
		if (responseId !== undefined) return `${responseId}:content:${contentIndex}`;
		if (timestamp !== undefined) return `timestamp:${timestamp}:content:${contentIndex}`;
		return undefined;
	}

	#reasoningState(key: string): ReasoningState | undefined {
		for (const state of this.#items.values()) {
			if (state.family === "reasoning" && state.key === key) return state;
		}
		return undefined;
	}

	#reasoningStateForPartial(partial: unknown, contentIndex: number): ReasoningState | undefined {
		const key = this.#reasoningKey(partial, contentIndex);
		if (key !== undefined) return this.#reasoningState(key);
		const open = this.#orderedItems().filter(
			(state): state is ReasoningState =>
				state.family === "reasoning" && state.state === "open" && state.contentIndex === contentIndex,
		);
		if (open.length > 1) return undefined;
		if (open.length === 1) return open[0];
		const fallbackId = this.#fallbackReasoningByContentIndex.get(contentIndex);
		const fallback = fallbackId ? this.#items.get(fallbackId) : undefined;
		return fallback?.family === "reasoning" ? fallback : undefined;
	}

	#ensureReasoning(
		partial: unknown,
		contentIndex: number,
	): { state?: ReasoningState; notifications: WireNotification[] } {
		const existing = this.#reasoningStateForPartial(partial, contentIndex);
		if (existing) return { state: existing, notifications: [] };
		const identity = this.#reasoningKey(partial, contentIndex);
		if (
			identity === undefined &&
			this.#orderedItems().filter(
				(state): state is ReasoningState =>
					state.family === "reasoning" && state.state === "open" && state.contentIndex === contentIndex,
			).length > 1
		)
			return { notifications: [] };
		const key = identity ?? `fallback:${++this.#fallbackSequence}:content:${contentIndex}`;
		const id = `reasoning:${this.#turnId}:${key}`;
		const state: ReasoningState = {
			family: "reasoning",
			id,
			sequence: ++this.#sequence,
			startedAtMs: this.#clock(),
			state: "open",
			item: { type: "reasoning", id, summary: [], content: [] },
			key,
			contentIndex,
			rawText: "",
			summaryText: "",
			rawOpen: false,
			summaryOpen: false,
			summaryPartAdded: false,
		};
		this.#items.set(id, state);
		if (identity === undefined) this.#fallbackReasoningByContentIndex.set(contentIndex, id);
		return { state, notifications: [this.#started(state)] };
	}

	#acceptTodoReminder(todos: readonly unknown[]): readonly WireNotification[] {
		const ensured = this.#ensurePlan();
		if (!ensured.state || ensured.state.state === "completed") return ensured.notifications;
		const nextText = JSON.stringify(jsonValue(todos));
		const delta = suffix(ensured.state.text, nextText, undefined);
		ensured.state.text = nextText;
		ensured.state.item = { ...ensured.state.item, text: nextText };
		if (delta.length > 0) {
			ensured.notifications.push(
				validated({
					method: "item/plan/delta",
					params: { threadId: this.#threadId, turnId: this.#turnId, itemId: ensured.state.id, delta },
				}),
			);
		}
		return ensured.notifications;
	}

	#acceptTodoAutoClear(): readonly WireNotification[] {
		const ensured = this.#ensurePlan();
		if (!ensured.state || ensured.state.state === "completed") return ensured.notifications;
		const delta = suffix(ensured.state.text, "[]", undefined);
		ensured.state.text = "[]";
		ensured.state.item = { ...ensured.state.item, text: "[]" };
		if (delta.length > 0) {
			ensured.notifications.push(
				validated({
					method: "item/plan/delta",
					params: { threadId: this.#threadId, turnId: this.#turnId, itemId: ensured.state.id, delta },
				}),
			);
		}
		return ensured.notifications;
	}

	#ensurePlan(): { state?: PlanState; notifications: WireNotification[] } {
		for (const state of this.#items.values()) {
			if (state.family === "plan" && state.state === "open") return { state, notifications: [] };
		}
		this.#fallbackSequence += 1;
		const id = `plan:${this.#turnId}:${this.#fallbackSequence}`;
		const state: PlanState = {
			family: "plan",
			id,
			sequence: ++this.#sequence,
			startedAtMs: this.#clock(),
			state: "open",
			item: { type: "plan", id, text: "" },
			text: "",
		};
		this.#items.set(id, state);
		return { state, notifications: [this.#started(state)] };
	}

	#started(state: ItemState): ItemStartedNotification {
		return validated({
			method: "item/started",
			params: { item: state.item, threadId: this.#threadId, turnId: this.#turnId, startedAtMs: state.startedAtMs },
		});
	}

	#complete(state: ItemState): readonly WireNotification[] {
		if (state.state === "completed") return [];
		state.state = "completed";
		state.completedAtMs = this.#clock();
		return [
			validated({
				method: "item/completed",
				params: {
					item: state.item,
					threadId: this.#threadId,
					turnId: this.#turnId,
					completedAtMs: state.completedAtMs,
				},
			}),
		];
	}

	#orderedItems(): ItemState[] {
		return Array.from(this.#items.values()).sort(
			(left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id),
		);
	}
}
