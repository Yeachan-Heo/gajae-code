import { expect, test } from "bun:test";
import type { AgentMessage } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai";
import { AGENT_WIRE_EVENT_TYPES } from "../../../modes/shared/agent-wire/event-contract";
import type { AgentSessionEvent } from "../../../session/agent-session";
import { associateSessionMessageEntryId } from "../../../session/session-manager";
import {
	type AgentMessageDeltaNotification,
	AgentMessageReducer,
	type ItemCompletedNotification,
	type ItemStartedNotification,
	type WireNotification,
} from "../../items/agent-message-reducer";
import sourceEventInventory from "../../items/source-event-inventory.json" with { type: "json" };
import { stableValidators } from "../../protocol-source/schema-validators.generated";

const THREAD_ID = "thread-test";
const TURN_ID = "turn-test";

function assistant(text: string, responseId?: string, timestamp = 1): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
		...(responseId === undefined ? {} : { responseId }),
	};
}

function messageStart(message: AgentMessage): Extract<AgentSessionEvent, { type: "message_start" }> {
	return { type: "message_start", message };
}

function messageUpdate(
	message: AssistantMessage,
	delta: string,
): Extract<AgentSessionEvent, { type: "message_update" }> {
	return {
		type: "message_update",
		message,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: message },
	};
}

function messageEnd(message: AgentMessage): Extract<AgentSessionEvent, { type: "message_end" }> {
	return { type: "message_end", message };
}

function reducer(clockValues: number[] = [100, 200, 300, 400]): AgentMessageReducer {
	let index = 0;
	return new AgentMessageReducer({
		threadId: THREAD_ID,
		turnId: TURN_ID,
		clock: () => clockValues[index++] ?? clockValues.at(-1) ?? 0,
	});
}

function expectValidNotifications(notifications: readonly WireNotification[]): void {
	for (const notification of notifications) {
		const validator = stableValidators.serverNotificationParams[notification.method];
		expect(validator(notification.params), notification.method).toBe(true);
	}
}

function methods(notifications: readonly WireNotification[]): string[] {
	return notifications.map(notification => notification.method);
}

function started(notifications: readonly WireNotification[]): ItemStartedNotification {
	const notification = notifications.find(
		(candidate): candidate is ItemStartedNotification => candidate.method === "item/started",
	);
	expect(notification).toBeDefined();
	return notification!;
}

function completed(notifications: readonly WireNotification[]): ItemCompletedNotification {
	const notification = notifications.find(
		(candidate): candidate is ItemCompletedNotification => candidate.method === "item/completed",
	);
	expect(notification).toBeDefined();
	return notification!;
}

function delta(notifications: readonly WireNotification[]): AgentMessageDeltaNotification {
	const notification = notifications.find(
		(candidate): candidate is AgentMessageDeltaNotification => candidate.method === "item/agentMessage/delta",
	);
	expect(notification).toBeDefined();
	return notification!;
}

test("agent-message reducer emits one start, ordered deltas, and an authoritative completion", () => {
	const r = reducer([100, 200]);
	const first = assistant("", "response-1");
	const second = assistant("hello", "response-1");
	const final = assistant("hello world", "response-1");
	const notifications = [
		...r.accept(messageStart(first)),
		...r.accept(messageUpdate(second, "hello")),
		...r.accept(messageUpdate(final, " world")),
		...r.accept(messageEnd(final)),
	];

	expect(methods(notifications)).toEqual([
		"item/started",
		"item/agentMessage/delta",
		"item/agentMessage/delta",
		"item/completed",
	]);
	expect(notifications.filter(notification => notification.method === "item/started")).toHaveLength(1);
	expect(notifications.filter(notification => notification.method === "item/completed")).toHaveLength(1);
	expect(
		notifications
			.filter(notification => notification.method === "item/agentMessage/delta")
			.map(notification => notification.params.delta),
	).toEqual(["hello", " world"]);
	expect(started(notifications).params.startedAtMs).toBe(100);
	expect(completed(notifications).params.completedAtMs).toBe(200);
	expect(completed(notifications).params.item).toMatchObject({
		type: "agentMessage",
		id: started(notifications).params.item.id,
		text: "hello world",
		phase: null,
		memoryCitation: null,
	});
	expect(r.openItemCount).toBe(0);
	expectValidNotifications(notifications);
});

test("a delta before message_start implicitly emits exactly one start before the delta", () => {
	const r = reducer([10, 20]);
	const partial = assistant("partial", "response-before-start");
	const final = assistant("partial final", "response-before-start");
	const notifications = [...r.accept(messageUpdate(partial, "partial")), ...r.accept(messageEnd(final))];

	expect(methods(notifications)).toEqual(["item/started", "item/agentMessage/delta", "item/completed"]);
	expect(delta(notifications).params.itemId).toBe(started(notifications).params.item.id);
	expect(completed(notifications).params.item.text).toBe("partial final");
	expectValidNotifications(notifications);
});

test("duplicate lifecycle events and late deltas do not reopen or duplicate an item", () => {
	const r = reducer([1, 2]);
	const initial = assistant("", "response-duplicate");
	const final = assistant("done", "response-duplicate");
	const first = [
		...r.accept(messageStart(initial)),
		...r.accept(messageUpdate(final, "done")),
		...r.accept(messageEnd(final)),
	];
	const terminal = completed(first);
	expectValidNotifications(first);
	const mutableItem = terminal.params.item as unknown as { text: string };
	mutableItem.text = "mutated only in the notification";
	const replay = [
		...r.accept(messageStart(initial)),
		...r.accept(messageUpdate(final, "done")),
		...r.accept(messageEnd(final)),
	];

	expect(methods(replay)).toEqual([]);
	expect(r.accept(messageUpdate(final, "late"))).toEqual([]);
	expect(r.openItemCount).toBe(0);
	expect(r.snapshots).toEqual([
		{
			id: terminal.params.item.id,
			text: "done",
			startedAtMs: 1,
			completedAtMs: 2,
			state: "completed",
		},
	]);
});

test("a message_end without a started lifecycle is omitted", () => {
	const r = reducer();
	expect(r.accept(messageEnd(assistant("never started", "never-started")))).toEqual([]);
	expect(r.openItemCount).toBe(0);
});

test("agent_end and interrupted completeTurn terminalize every started item", () => {
	const r = reducer([10, 20, 30]);
	const first = assistant("in progress", "response-interrupted");
	const notifications = [
		...r.accept(messageStart(first)),
		...r.accept(messageUpdate(first, "in progress")),
		...r.accept({ type: "agent_end", messages: [], stopReason: "cancelled" }),
	];

	expect(methods(notifications)).toEqual(["item/started", "item/agentMessage/delta", "item/completed"]);
	expect(completed(notifications).params.item.text).toBe("in progress");
	expect(r.openItemCount).toBe(0);
	expectValidNotifications(notifications);

	const second = reducer([40, 50]);
	const secondMessage = assistant("failed answer", "response-failed");
	second.accept(messageStart(secondMessage));
	const closed = second.completeTurn({ kind: "failed" });
	expect(methods(closed)).toEqual(["item/completed"]);
	expect(completed(closed).params.item.text).toBe("failed answer");
	expect(second.openItemCount).toBe(0);
	expectValidNotifications(closed);
});

test("durable session entry identity wins over object identity across replay snapshots", () => {
	const liveStart = assistant("", undefined, 10);
	const liveEnd = assistant("replayed final", undefined, 10);
	const resumedStart = assistant("", undefined, 10);
	const resumedEnd = assistant("replayed final", undefined, 10);
	associateSessionMessageEntryId(liveStart, "entry-authoritative");
	associateSessionMessageEntryId(liveEnd, "entry-authoritative");
	associateSessionMessageEntryId(resumedStart, "entry-authoritative");
	associateSessionMessageEntryId(resumedEnd, "entry-authoritative");

	const first = reducer([1, 2]);
	const second = reducer([1, 2]);
	const firstNotifications = [...first.accept(messageStart(liveStart)), ...first.accept(messageEnd(liveEnd))];
	const secondNotifications = [...second.accept(messageStart(resumedStart)), ...second.accept(messageEnd(resumedEnd))];
	expectValidNotifications(firstNotifications);
	expectValidNotifications(secondNotifications);

	expect(started(firstNotifications).params.item.id).toBe("agent-message:entry:entry-authoritative");
	expect(started(secondNotifications).params.item.id).toBe(started(firstNotifications).params.item.id);
	expect(completed(secondNotifications).params.item.text).toBe("replayed final");
});

test("two assistant messages use distinct deterministic fallback ids and replay identically", () => {
	const first = assistant("first", undefined, 1);
	const second = assistant("second", undefined, 2);
	const events: AgentSessionEvent[] = [
		messageStart(first),
		messageStart(second),
		messageEnd(first),
		messageEnd(second),
	];
	const run = (sequence: readonly AgentSessionEvent[]): string[] => {
		const r = reducer([1, 2, 3, 4]);
		const notifications = sequence.flatMap(event => r.accept(event));
		expectValidNotifications(notifications);
		expect(r.openItemCount).toBe(0);
		return notifications
			.filter((notification): notification is ItemStartedNotification => notification.method === "item/started")
			.map(notification => notification.params.item.id);
	};

	const ids = run(events);
	const replayIds = run([
		messageStart(assistant("first", undefined, 1)),
		messageStart(assistant("second", undefined, 2)),
		messageEnd(assistant("first", undefined, 1)),
		messageEnd(assistant("second", undefined, 2)),
	]);
	expect(ids).toHaveLength(2);
	expect(new Set(ids).size).toBe(2);
	expect(replayIds).toEqual(ids);
});

test("turn_end uses the authoritative assistant snapshot before closing open items", () => {
	const r = reducer([11, 12]);
	const partial = assistant("streamed delta", "response-turn-end");
	const final = assistant("authoritative final", "response-turn-end");
	const notifications = [
		...r.accept(messageStart(partial)),
		...r.accept(messageUpdate(partial, "streamed delta")),
		...r.accept({ type: "turn_end", message: final, toolResults: [] }),
	];

	expect(completed(notifications).params.item.text).toBe("authoritative final");
	expect(r.openItemCount).toBe(0);
	expectValidNotifications(notifications);
});

test("assistant error updates provide authoritative terminal text without a failure-only wire field", () => {
	const r = reducer([60, 70]);
	const partial = assistant("partial", "response-error");
	const error = {
		...assistant("authoritative error state", "response-error"),
		stopReason: "error" as const,
		errorMessage: "provider failed",
	};
	const notifications: WireNotification[] = [
		...r.accept(messageStart(partial)),
		...r.accept({
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "error", reason: "error", error },
		}),
		...r.completeTurn({ kind: "failed" }),
	];

	expect(completed(notifications).params.item.text).toBe("authoritative error state");
	expect(completed(notifications).params.item).not.toHaveProperty("status");
	expect(r.openItemCount).toBe(0);
	expectValidNotifications(notifications);
});
test("source-event inventory includes every core AgentEvent discriminator", async () => {
	const source = await Bun.file(new URL("../../../../../agent/src/types.ts", import.meta.url)).text();
	const start = source.indexOf("export type AgentEvent =");
	const endMarker = source.indexOf("\nexport ", start + "export type AgentEvent =".length);
	const end = endMarker === -1 ? source.length : endMarker;
	expect(start).toBeGreaterThanOrEqual(0);
	expect(end).toBeGreaterThan(start);
	const coreSource = source.slice(start, end);
	const coreDiscriminators = Array.from(coreSource.matchAll(/\btype:\s*"([^"]+)"/g), match => match[1]);
	const inventoryDiscriminators = new Set(sourceEventInventory.events.map(event => event.discriminator));
	for (const discriminator of coreDiscriminators) {
		expect(inventoryDiscriminators.has(discriminator), discriminator).toBe(true);
	}
	const registryDiscriminators = [...AGENT_WIRE_EVENT_TYPES].sort();
	expect([...inventoryDiscriminators].sort()).toEqual(registryDiscriminators);
	expect(sourceEventInventory.source.coreEventType).toBe("AgentEvent");
	expect(sourceEventInventory.source.coreEventFile).toBe("packages/agent/src/types.ts");
	expect(sourceEventInventory.permittedUnmapped).toEqual(
		sourceEventInventory.events
			.filter(event => event.classification === "permitted-unmapped")
			.map(event => event.discriminator),
	);
});
