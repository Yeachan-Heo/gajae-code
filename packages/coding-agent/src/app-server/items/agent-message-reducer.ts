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
	sources: Set<string>;
	lastObservedMessage?: AssistantMessage;
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

function sourceIdentities(message: AssistantMessage): readonly string[] {
	const identities: string[] = [];
	if (message.responseId) identities.push(`response:${message.responseId}`);
	const entryId = getSessionMessageEntryId(message);
	if (entryId) identities.push(`entry:${entryId}`);
	return identities;
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
				return this.#acceptAgentEnd(event.messages, event.stopReason);
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
		const allowObservedFallback = this.#allowsObservedFallback(outcome.kind);
		for (const item of this.#items.values()) {
			if (
				item.state === "open" &&
				!item.authoritativeMessage &&
				!assignments.has(item.id) &&
				!(allowObservedFallback && item.lastObservedMessage)
			) {
				throw new Error(`Cannot terminalize agent-message item ${item.id}: no authoritative message`);
			}
		}
		for (const [itemId, message] of assignments) {
			const item = this.#items.get(itemId);
			if (item?.state === "open") this.#setAuthoritative(item, message);
		}
		const notifications = this.#closeOpenItems(allowObservedFallback);
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
		const sources = sourceIdentities(message);
		const implicit = this.#onlyOpenImplicitItem();
		if (implicit && this.#isSourceCompatible(implicit, sources)) {
			implicit.implicitStart = false;
			this.#rememberMessage(message, implicit.id, sources);
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
			if (this.#items.size > 0 && sourceIdentities(event.message).length === 0) return [];
			item = this.#createItem(event.message, true);
			notifications.push(this.#startedNotification(item));
		}
		if (item.state === "completed") return notifications;
		this.#setObserved(item, event.message);

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
		const item = this.#findItem(message, false) ?? this.#adoptPersistedTerminalIdentity(message);
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

	#acceptAgentEnd(
		messages: readonly AgentMessage[],
		stopReason: "completed" | "paused" | "cancelled" | "maintenance" | undefined,
	): readonly WireNotification[] {
		const authoritative = messages.filter(isAssistantMessage);
		const assignments = this.#resolveAuthoritativeAssignments(authoritative);
		for (const [itemId, source] of assignments) {
			const item = this.#items.get(itemId);
			if (item?.state === "open") this.#setAuthoritative(item, source);
		}
		return this.#closeOpenItems(this.#allowsObservedFallback(stopReason));
	}

	#createItem(message: AssistantMessage, implicitStart: boolean): ItemState {
		const sources = sourceIdentities(message);
		const identity = sources[0];
		const id = identity ? `agent-message:${identity}` : this.#fallbackItemId();
		const item: ItemState = {
			id,
			text: extractAssistantText(message),
			sources: new Set(sources),
			lastObservedMessage: message,
			startedAtMs: this.#clock(),
			state: "open",
			implicitStart,
		};
		this.#items.set(id, item);
		this.#rememberMessage(message, item.id, sources);
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
		const sources = sourceIdentities(message);
		const mappedItemIds = new Set<string>();
		for (const source of sources) {
			const itemId = this.#sourceToItem.get(source);
			if (itemId) mappedItemIds.add(itemId);
		}
		if (mappedItemIds.size > 1) throw new Error("Agent-message identities resolve to different items");
		const mappedItemId = mappedItemIds.values().next().value;
		if (mappedItemId) {
			const item = this.#items.get(mappedItemId);
			if (item && this.#isSourceCompatible(item, sources)) {
				this.#rememberMessage(message, item.id, sources);
				return item;
			}
		}

		const rememberedId = this.#messageToItem.get(message);
		if (rememberedId) {
			const item = this.#items.get(rememberedId);
			if (item && this.#isSourceCompatible(item, sources)) {
				this.#rememberMessage(message, item.id, sources);
				return item;
			}
		}
		if (!allowOpenFallback) return undefined;
		const openItems = Array.from(this.#items.values()).filter(item => item.state === "open");
		if (openItems.length !== 1 || this.#items.size !== 1) return undefined;
		const item = openItems[0];
		if (!this.#isSourceCompatible(item, sources)) return undefined;
		this.#rememberMessage(message, item.id, sources);
		return item;
	}

	#isSourceCompatible(item: ItemState, sources: readonly string[]): boolean {
		if (sources.length === 0 || item.sources.size === 0) return true;
		return sources.some(source => item.sources.has(source));
	}

	#rememberMessage(message: AssistantMessage, itemId: string, sources: readonly string[]): void {
		const item = this.#items.get(itemId);
		if (!item || !this.#isSourceCompatible(item, sources)) return;
		for (const source of sources) {
			const existingItemId = this.#sourceToItem.get(source);
			if (existingItemId !== undefined && existingItemId !== itemId)
				throw new Error(`Agent-message identity ${source} already belongs to another item`);
		}
		for (const source of sources) {
			item.sources.add(source);
			this.#sourceToItem.set(source, itemId);
		}
		this.#messageToItem.set(message, itemId);
	}

	#adoptPersistedTerminalIdentity(message: AssistantMessage): ItemState | undefined {
		const sources = sourceIdentities(message);
		if (
			!sources.some(source => source.startsWith("entry:")) ||
			sources.some(source => source.startsWith("response:"))
		)
			return undefined;
		const openItems = Array.from(this.#items.values()).filter(item => item.state === "open");
		if (openItems.length !== 1) return undefined;
		const item = openItems[0];
		if (!Array.from(item.sources).some(source => source.startsWith("response:"))) return undefined;
		for (const source of sources) {
			const existingItemId = this.#sourceToItem.get(source);
			if (existingItemId !== undefined && existingItemId !== item.id) return undefined;
		}
		for (const source of sources) {
			item.sources.add(source);
			this.#sourceToItem.set(source, item.id);
		}
		this.#messageToItem.set(message, item.id);
		return item;
	}

	#setObserved(item: ItemState, message: AssistantMessage): void {
		const sources = sourceIdentities(message);
		if (!this.#isSourceCompatible(item, sources))
			throw new Error(`Cannot correlate agent-message source for item ${item.id}`);
		this.#rememberMessage(message, item.id, sources);
		item.lastObservedMessage = message;
		item.text = extractAssistantText(message);
	}

	#setAuthoritative(item: ItemState, message: AssistantMessage): void {
		this.#setObserved(item, message);
		item.authoritativeMessage = message;
	}

	#fallbackItemId(): string {
		this.#fallbackSequence += 1;
		return `agent-message:${this.#threadId}:${this.#turnId}:${this.#fallbackSequence}`;
	}

	#allowsObservedFallback(
		policy: AgentMessageTurnOutcomeKind | "paused" | "cancelled" | "maintenance" | undefined,
	): boolean {
		return (
			policy === "interrupted" ||
			policy === "failed" ||
			policy === "paused" ||
			policy === "cancelled" ||
			policy === "maintenance"
		);
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

	#closeOpenItems(allowObservedFallback = false): readonly WireNotification[] {
		for (const item of this.#items.values()) {
			if (
				item.state === "open" &&
				!item.authoritativeMessage &&
				!(allowObservedFallback && item.lastObservedMessage)
			) {
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
			const transitioned = this.#adoptPersistedTerminalIdentity(message);
			if (transitioned) {
				if (!assignments.has(transitioned.id)) assignments.set(transitioned.id, message);
				continue;
			}
			if (openItems.length === 0) continue;
			if (openItems.length !== 1 || !this.#isSourceCompatible(openItems[0], sourceIdentities(message))) {
				throw new Error(`Cannot correlate authoritative agent-message state for turn ${this.#turnId}`);
			}
			if (!assignments.has(openItems[0].id)) assignments.set(openItems[0].id, message);
		}
		return assignments;
	}
}
