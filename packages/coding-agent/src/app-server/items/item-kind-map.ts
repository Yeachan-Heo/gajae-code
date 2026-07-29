import type { AssistantMessageEvent } from "@gajae-code/ai";
import type { ThreadItem } from "../../../vendor/codex-app-server-schema/stable/typescript/v2/ThreadItem";
import { mapToolKind } from "../../modes/acp/acp-event-mapper";
import { parseMCPToolName } from "../../runtime-mcp/tool-bridge";
import type { AgentSessionEvent } from "../../session/agent-session";

/** The only item kinds available in the pinned stable ThreadItem union. */
export type CatalogItemType = ThreadItem["type"];

/** Canonical GJC tool categories returned by mapToolKind. */
export type GjcToolKind = "read" | "edit" | "delete" | "move" | "execute" | "search" | "fetch" | "think" | "other";

export interface ItemKindMapping {
	readonly type: CatalogItemType | null;
	readonly reason: string;
}

export interface ClassifiedItemKind extends ItemKindMapping {
	readonly kind: GjcToolKind;
	readonly source: "tool" | "event" | "assistant-message-event";
	readonly mapped: boolean;
}

/**
 * Fixed, reviewed policy for categories that do not have an honest stable
 * ThreadItem representation. `type: null` is deliberate: there is no hidden
 * third state between a catalog mapping and this list.
 */
export const FIXED_UNMAPPED_ITEM_KINDS = Object.freeze([
	{
		kind: "read",
		type: null,
		reason: "The stable ThreadItem union has no local file-read item; commandExecution would misrepresent a read.",
	},
	{
		kind: "search",
		type: null,
		reason: "The stable ThreadItem union has no local search item; commandExecution would misrepresent a search.",
	},
	{
		kind: "other",
		type: null,
		reason:
			"Unknown and GJC control tools have no proven stable ThreadItem shape; fail closed instead of inventing one.",
	},
] as const);

/**
 * Exhaustive category-to-catalog map. Tool names are intentionally absent from
 * this table; mapToolKind remains the single GJC tool-name authority.
 */
export const ITEM_KIND_MAP: Readonly<Record<GjcToolKind, ItemKindMapping>> = Object.freeze({
	read: FIXED_UNMAPPED_ITEM_KINDS[0],
	edit: {
		type: "fileChange",
		reason: "Edit-family tools are represented by the stable fileChange item.",
	},
	delete: {
		type: "fileChange",
		reason: "Delete-family tools are represented by the stable fileChange item.",
	},
	move: {
		type: "fileChange",
		reason: "Move-family tools are represented by the stable fileChange item.",
	},
	execute: {
		type: "commandExecution",
		reason: "Shell/eval execution is represented by the stable commandExecution item.",
	},
	search: FIXED_UNMAPPED_ITEM_KINDS[1],
	fetch: {
		type: "webSearch",
		reason: "The canonical fetch category is represented by the stable webSearch item.",
	},
	think: {
		type: "plan",
		reason: "Todo/think tools are represented by the stable plan item.",
	},
	other: FIXED_UNMAPPED_ITEM_KINDS[2],
});

function mcpToolParts(toolName: string): { server: string; tool: string } | undefined {
	if (!toolName.startsWith("mcp__")) return undefined;
	const remainder = toolName.slice("mcp__".length);
	const doubleSeparator = remainder.indexOf("__");
	if (doubleSeparator > 0 && doubleSeparator < remainder.length - 2) {
		return { server: remainder.slice(0, doubleSeparator), tool: remainder.slice(doubleSeparator + 2) };
	}
	const parsed = parseMCPToolName(toolName);
	return parsed ? { server: parsed.serverName, tool: parsed.toolName } : undefined;
}

/**
 * Real GJC tools that `mapToolKind` reports as `other` but which have a genuine pinned
 * `ThreadItem` type. Listing them by name is what keeps the fixed unmapped list truthful: a family
 * only stays unmapped when the pinned union really cannot represent it.
 */
const NAMED_OTHER_TOOL_ITEMS: Readonly<Record<string, { readonly type: ThreadItem["type"]; readonly reason: string }>> =
	Object.freeze({
		// Verified against the generated stable `item/started` validator: it REJECTS an
		// `imageGeneration` item (that shape is not in the v2 item surface) but ACCEPTS
		// `dynamicToolCall`. So image generation stays unmapped and these route through the
		// pinned generic tool-call item instead.
		computer: {
			type: "dynamicToolCall",
			reason: "Computer control has no dedicated type; dynamicToolCall is the pinned generic tool-call item.",
		},
		generate_image: {
			type: "dynamicToolCall",
			reason:
				"The v2 item surface has no imageGeneration item, so image generation uses the generic tool-call item.",
		},
	});

/**
 * Classify a concrete GJC tool using the canonical mapToolKind authority. MCP names and the
 * named-tool table above are the explicitly proven exceptions inside the `other` bucket.
 */
export function classifyGjcTool(toolName: string): ClassifiedItemKind & {
	readonly mcp?: { readonly server: string; readonly tool: string };
} {
	const mappedKind = mapToolKind(toolName);
	const kind = mappedKind === "switch_mode" ? "other" : mappedKind;
	const mapping = ITEM_KIND_MAP[kind];
	const mcp = kind === "other" ? mcpToolParts(toolName) : undefined;
	if (mcp) {
		return {
			kind,
			source: "tool",
			type: "mcpToolCall",
			mapped: true,
			reason: "Namespaced MCP tools carry the server/tool identity required by the stable mcpToolCall item.",
			mcp,
		};
	}
	// `mapToolKind` collapses every non-file, non-shell tool into `other`, but a few real GJC tools
	// DO have a dedicated pinned type. Mapping them by name here keeps the unmapped list honest:
	// `other` stays unmapped as a category, while these named tools are represented faithfully.
	const named = NAMED_OTHER_TOOL_ITEMS[toolName];
	if (kind === "other" && named) return { kind, source: "tool", type: named.type, mapped: true, reason: named.reason };
	return {
		kind,
		source: "tool",
		type: mapping.type,
		mapped: mapping.type !== null,
		reason: mapping.reason,
	};
}

export type GjcEventType = AgentSessionEvent["type"];
export type AssistantMessageEventType = AssistantMessageEvent["type"];

/** Exhaustive top-level source-event catalog used by inventory and coverage tests. */
export const ITEM_EVENT_KIND_MAP: Readonly<Record<GjcEventType, ItemKindMapping>> = Object.freeze({
	agent_start: { type: null, reason: "Agent lifecycle boundary does not itself emit a ThreadItem." },
	agent_end: {
		type: null,
		reason: "Agent termination is a lifecycle boundary; item ownership is handled by the reducer.",
	},
	turn_start: { type: null, reason: "Internal GJC turn boundaries do not represent Codex ThreadItems." },
	turn_end: { type: null, reason: "Internal GJC turn boundaries must not terminalize a Codex turn." },
	message_start: { type: null, reason: "Message envelopes are classified by their role and inner content." },
	message_update: {
		type: null,
		reason: "Assistant inner events are classified by the assistant-message-event catalog.",
	},
	message_end: { type: null, reason: "Message envelopes are classified by their role and tool identity." },
	tool_execution_start: { type: null, reason: "Concrete tool names are classified through mapToolKind at runtime." },
	tool_execution_update: { type: null, reason: "Concrete tool names are classified through mapToolKind at runtime." },
	tool_execution_end: { type: null, reason: "Concrete tool names are classified through mapToolKind at runtime." },
	auto_compaction_start: { type: null, reason: "Compaction maintenance is not a ThreadItem lifecycle." },
	auto_compaction_end: { type: null, reason: "Compaction maintenance is not a ThreadItem lifecycle." },
	auto_retry_start: { type: null, reason: "Retry maintenance is not a ThreadItem lifecycle." },
	auto_retry_end: { type: null, reason: "Retry maintenance is not a ThreadItem lifecycle." },
	ttsr_triggered: { type: null, reason: "Prompt-rule metadata is not a ThreadItem lifecycle." },
	todo_reminder: { type: "plan", reason: "Todo reminders update the stable plan item." },
	todo_auto_clear: { type: "plan", reason: "Todo auto-clear updates the stable plan item." },
	irc_message: { type: null, reason: "IRC control messages are not ThreadItems." },
	subagent_steer_message: { type: null, reason: "Subagent steering metadata is not a ThreadItem." },
	notice: { type: null, reason: "Notices are control-plane metadata, not ThreadItems." },
	model_fallback_switched: { type: null, reason: "Model fallback metadata is not a ThreadItem." },
	thinking_level_changed: { type: null, reason: "Thinking-level metadata is not a ThreadItem." },
	goal_updated: { type: null, reason: "Goal metadata is not a ThreadItem." },
});

/** Exhaustive inner assistant event catalog. Tool calls are resolved by their concrete name. */
export const ASSISTANT_MESSAGE_EVENT_KIND_MAP: Readonly<Record<AssistantMessageEventType, ItemKindMapping>> =
	Object.freeze({
		start: { type: null, reason: "Assistant stream envelope does not itself create a ThreadItem." },
		text_start: { type: null, reason: "Assistant text belongs to the reviewed agent-message family." },
		text_delta: { type: null, reason: "Assistant text belongs to the reviewed agent-message family." },
		text_end: { type: null, reason: "Assistant text belongs to the reviewed agent-message family." },
		thinking_start: { type: "reasoning", reason: "Thinking content is represented by the stable reasoning item." },
		thinking_delta: { type: "reasoning", reason: "Thinking content is represented by the stable reasoning item." },
		thinking_end: { type: "reasoning", reason: "Thinking content is represented by the stable reasoning item." },
		reasoning_summary_start: {
			type: "reasoning",
			reason: "Reasoning summaries are represented by the stable reasoning item.",
		},
		reasoning_summary_delta: {
			type: "reasoning",
			reason: "Reasoning summaries are represented by the stable reasoning item.",
		},
		reasoning_summary_end: {
			type: "reasoning",
			reason: "Reasoning summaries are represented by the stable reasoning item.",
		},
		toolcall_start: {
			type: null,
			reason: "The concrete tool name is required before selecting a stable ThreadItem type.",
		},
		toolcall_delta: {
			type: null,
			reason: "The concrete tool name is required before selecting a stable ThreadItem type.",
		},
		toolcall_end: {
			type: null,
			reason: "The concrete tool name is required before selecting a stable ThreadItem type.",
		},
		done: { type: null, reason: "Assistant stream completion is a boundary, not a ThreadItem." },
		error: { type: null, reason: "Assistant stream errors are handled by the owning item or turn family." },
		toolChoiceIncapability: { type: null, reason: "Tool-choice capability metadata is not a ThreadItem." },
	});

export function classifyGjcEvent(type: GjcEventType): ClassifiedItemKind {
	const mapping = ITEM_EVENT_KIND_MAP[type];
	return {
		kind: "other",
		source: "event",
		type: mapping.type,
		mapped: mapping.type !== null,
		reason: mapping.reason,
	};
}

export function classifyAssistantMessageEvent(type: AssistantMessageEventType): ClassifiedItemKind {
	const mapping = ASSISTANT_MESSAGE_EVENT_KIND_MAP[type];
	return {
		kind: "other",
		source: "assistant-message-event",
		type: mapping.type,
		mapped: mapping.type !== null,
		reason: mapping.reason,
	};
}
