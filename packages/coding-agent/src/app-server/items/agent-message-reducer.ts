import type { AgentMessage } from "@gajae-code/agent-core";
import type { AssistantMessage, TextContent } from "@gajae-code/ai";
import type { AgentSessionEvent } from "../../session/agent-session";
import { getSessionMessageEntryId } from "../../session/session-manager";

export interface AgentMessageReducerOptions {
	threadId: string;
	turnId: string;
	clock: () => number;
}

export interface AgentMessageItem {
	readonly type: "agentMessage";
	readonly id: string;
	readonly text: string;
	readonly phase: null;
	readonly memoryCitation: null;
}

export interface ItemStartedNotification {
	method: "item/started";
	params: {
		item: AgentMessageItem;
		threadId: string;
		turnId: string;
		startedAtMs: number;
	};
}

export interface AgentMessageDeltaNotification {
	method: "item/agentMessage/delta";
	params: {
		threadId: string;
		turnId: string;
		itemId: string;
		delta: string;
	};
}

export interface ItemCompletedNotification {
	method: "item/completed";
	params: {
		item: AgentMessageItem;
		threadId: string;
		turnId: string;
		completedAtMs: number;
	};
}

export type WireNotification = ItemStartedNotification | AgentMessageDeltaNotification | ItemCompletedNotification;

export type AgentMessageTurnOutcomeKind = "completed" | "interrupted" | "failed";

export interface AgentMessageTurnOutcome {
	kind: AgentMessageTurnOutcomeKind;
	messages?: readonly AgentMessage[];
}

interface ItemState {
	id: string;
	text: string;
	authoritativeMessage?: AssistantMessage;
	startedAtMs: number;
	completedAtMs?: number;
	state: "open" | "completed";
	implicitStart: boolean;
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return typeof message === "object" && message !== null && "role" in message && message.role === "assistant";
}

function extractAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

function sourceIdentity(message: AssistantMessage): string | undefined {
	const entryId = getSessionMessageEntryId(message);
	if (entryId) return `entry:${entryId}`;
	if (message.responseId) return `response:${message.responseId}`;
	return undefined;
}

export class AgentMessageReducer {
	readonly #threadId: string;
	readonly #turnId: string;
	readonly #clock: () => number;
	readonly #items = new Map<string, ItemState>();
	readonly #sourceToItem = new Map<string, string>();
	readonly #messageToItem = new WeakMap<object, string>();
	#fallbackSequence = 0;

	constructor(options: AgentMessageReducerOptions) {
		this.#threadId = options.threadId;
		this.#turnId = options.turnId;
		this.#clock = options.clock;
	}

	get openItemCount(): number {
		let count = 0;
		for (const item of this.#items.values()) {
			if (item.state === "open") count += 1;
		}
		return count;
	}

	accept(event: AgentSessionEvent): readonly WireNotification[] {
		switch (event.type) {
			case "message_start":
				return this.#acceptMessageStart(event.message);
			case "message_update":
				return this.#acceptMessageUpdate(event);
			case "message_end":
				return this.#acceptMessageEnd(event.message);
			case "turn_end":
				return this.#acceptTurnEnd(event.message);
			case "agent_end":
				return this.#acceptAgentEnd(event.messages);
			case "agent_start":
			case "turn_start":
			case "tool_execution_start":
			case "tool_execution_update":
			case "tool_execution_end":
			case "auto_compaction_start":
			case "auto_compaction_end":
			case "auto_retry_start":
			case "auto_retry_end":
			case "model_fallback_switched":
			case "ttsr_triggered":
			case "todo_reminder":
			case "todo_auto_clear":
			case "irc_message":
			case "subagent_steer_message":
			case "notice":
			case "thinking_level_changed":
			case "goal_updated":
				return [];
		}
	}

	completeTurn(outcome: AgentMessageTurnOutcome): readonly WireNotification[] {
		const authoritative = (outcome.messages ?? []).filter(isAssistantMessage);
		const assignments = this.#resolveAuthoritativeAssignments(authoritative);
		for (const item of this.#items.values()) {
			if (item.state === "open" && !item.authoritativeMessage && !assignments.has(item.id)) {
				throw new Error(`Cannot terminalize agent-message item ${item.id}: no authoritative message`);
			}
		}
		for (const [itemId, message] of assignments) {
			const item = this.#items.get(itemId);
			if (item?.state === "open") this.#setAuthoritative(item, message);
		}
		const notifications = this.#closeOpenItems();
		if (this.openItemCount !== 0) {
			throw new Error(`Agent-message turn ${this.#turnId} completed with open items`);
		}
		return notifications;
	}

	#acceptMessageStart(message: AgentMessage): readonly WireNotification[] {
		if (!isAssistantMessage(message)) return [];
		const existing = this.#findItem(message, false);
		if (existing) {
			if (existing.state === "open") existing.implicitStart = false;
			return [];
		}
		const implicit = this.#onlyOpenImplicitItem();
		if (implicit) {
			implicit.implicitStart = false;
			this.#rememberMessage(message, implicit.id, sourceIdentity(message));
			return [];
		}
		const item = this.#createItem(message, false);
		return [this.#startedNotification(item)];
	}

	#acceptMessageUpdate(event: Extract<AgentSessionEvent, { type: "message_update" }>): readonly WireNotification[] {
		if (!isAssistantMessage(event.message)) return [];
		let item = this.#findItem(event.message, true);
		const notifications: WireNotification[] = [];
		if (!item) {
			if (this.#items.size > 0 && sourceIdentity(event.message) === undefined) return [];
			item = this.#createItem(event.message, true);
			notifications.push(this.#startedNotification(item));
		}
		if (item.state === "completed") return notifications;
		this.#setAuthoritative(item, event.message);
		const assistantEvent = event.assistantMessageEvent;
		if (assistantEvent.type === "done") this.#setAuthoritative(item, assistantEvent.message);
		if (assistantEvent.type === "text_delta" && assistantEvent.delta.length > 0) {
			notifications.push(this.#deltaNotification(item.id, assistantEvent.delta));
		} else if (assistantEvent.type === "error") {
			this.#setAuthoritative(item, assistantEvent.error);
			const delta = assistantEvent.error.errorMessage ?? "Unknown error";
			if (delta.length > 0) notifications.push(this.#deltaNotification(item.id, delta));
		}
		return notifications;
	}

	#acceptMessageEnd(message: AgentMessage): readonly WireNotification[] {
		if (!isAssistantMessage(message)) return [];
		const item = this.#findItem(message, false);
		if (!item || item.state === "completed") return [];
		this.#setAuthoritative(item, message);
		return this.#closeItem(item);
	}

	#acceptTurnEnd(message: AgentMessage): readonly WireNotification[] {
		const authoritative = isAssistantMessage(message) ? [message] : [];
		const assignments = this.#resolveAuthoritativeAssignments(authoritative);
		for (const [itemId, source] of assignments) {
			const item = this.#items.get(itemId);
			if (item?.state === "open") this.#setAuthoritative(item, source);
		}
		return this.#closeOpenItems();
	}

	#acceptAgentEnd(messages: readonly AgentMessage[]): readonly WireNotification[] {
		const authoritative = messages.filter(isAssistantMessage);
		const assignments = this.#resolveAuthoritativeAssignments(authoritative);
		for (const [itemId, source] of assignments) {
			const item = this.#items.get(itemId);
			if (item?.state === "open") this.#setAuthoritative(item, source);
		}
		return this.#closeOpenItems();
	}

	#createItem(message: AssistantMessage, implicitStart: boolean): ItemState {
		const source = sourceIdentity(message);
		const id = source ? `agent-message:${source}` : this.#fallbackItemId();
		const item: ItemState = {
			id,
			text: extractAssistantText(message),
			startedAtMs: this.#clock(),
			state: "open",
			implicitStart,
		};
		this.#items.set(id, item);
		this.#rememberMessage(message, item.id, source);
		return item;
	}

	#onlyOpenImplicitItem(): ItemState | undefined {
		const openItems = Array.from(this.#items.values()).filter(item => item.state === "open");
		if (openItems.length !== 1 || !openItems[0].implicitStart) return undefined;
		return openItems[0];
	}

	#startedNotification(item: ItemState): ItemStartedNotification {
		return {
			method: "item/started",
			params: {
				item: this.#wireItem(item),
				threadId: this.#threadId,
				turnId: this.#turnId,
				startedAtMs: item.startedAtMs,
			},
		};
	}

	#findItem(message: AssistantMessage, allowOpenFallback: boolean): ItemState | undefined {
		const source = sourceIdentity(message);
		if (source) {
			const itemId = this.#sourceToItem.get(source);
			if (itemId) return this.#items.get(itemId);
		}
		const rememberedId = this.#messageToItem.get(message);
		if (rememberedId) return this.#items.get(rememberedId);
		if (!allowOpenFallback) return undefined;
		const openItems = Array.from(this.#items.values()).filter(item => item.state === "open");
		if (openItems.length !== 1 || this.#items.size !== 1) return undefined;
		const item = openItems[0];
		this.#rememberMessage(message, item.id, source);
		return item;
	}

	#rememberMessage(message: AssistantMessage, itemId: string, source: string | undefined): void {
		this.#messageToItem.set(message, itemId);
		if (source) this.#sourceToItem.set(source, itemId);
	}

	#setAuthoritative(item: ItemState, message: AssistantMessage): void {
		item.authoritativeMessage = message;
		item.text = extractAssistantText(message);
		this.#rememberMessage(message, item.id, sourceIdentity(message));
	}

	#fallbackItemId(): string {
		this.#fallbackSequence += 1;
		return `agent-message:${this.#threadId}:${this.#turnId}:${this.#fallbackSequence}`;
	}

	#deltaNotification(itemId: string, delta: string): AgentMessageDeltaNotification {
		return {
			method: "item/agentMessage/delta",
			params: { threadId: this.#threadId, turnId: this.#turnId, itemId, delta },
		};
	}

	#closeItem(item: ItemState): readonly WireNotification[] {
		if (item.state === "completed") return [];
		item.state = "completed";
		item.completedAtMs = this.#clock();
		return [
			{
				method: "item/completed",
				params: {
					item: this.#wireItem(item),
					threadId: this.#threadId,
					turnId: this.#turnId,
					completedAtMs: item.completedAtMs,
				},
			},
		];
	}

	#closeOpenItems(): readonly WireNotification[] {
		for (const item of this.#items.values()) {
			if (item.state === "open" && !item.authoritativeMessage) {
				throw new Error(`Cannot terminalize agent-message item ${item.id}: no authoritative message`);
			}
		}
		const notifications: WireNotification[] = [];
		for (const item of this.#items.values()) {
			if (item.state === "open") notifications.push(...this.#closeItem(item));
		}
		return notifications;
	}

	#wireItem(item: ItemState): AgentMessageItem {
		return {
			type: "agentMessage",
			id: item.id,
			text: item.text,
			phase: null,
			memoryCitation: null,
		};
	}

	#resolveAuthoritativeAssignments(messages: readonly AssistantMessage[]): Map<string, AssistantMessage> {
		const assignments = new Map<string, AssistantMessage>();
		const openItems = Array.from(this.#items.values()).filter(item => item.state === "open");
		for (const message of messages) {
			const known = this.#findItem(message, false);
			if (known) {
				if (known.state === "open" && !assignments.has(known.id)) assignments.set(known.id, message);
				continue;
			}
			if (openItems.length === 0) continue;
			if (openItems.length !== 1) {
				throw new Error(`Cannot correlate authoritative agent-message state for turn ${this.#turnId}`);
			}
			if (!assignments.has(openItems[0].id)) assignments.set(openItems[0].id, message);
		}
		return assignments;
	}
}
