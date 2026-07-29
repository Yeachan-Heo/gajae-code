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
test("mismatched source identities keep an implicit update item distinct from a delayed start", () => {
	const r = reducer([10, 20, 30, 40]);
	const sourceA = assistant("A partial", "response-A");
	const sourceBStart = assistant("B start", "response-B");
	const sourceAFinal = assistant("A final", "response-A");
	const sourceBFinal = assistant("B final", "response-B");
	const notifications = [
		...r.accept(messageUpdate(sourceA, "A partial")),
		...r.accept(messageStart(sourceBStart)),
		...r.accept(messageEnd(sourceBFinal)),
		...r.accept(messageEnd(sourceAFinal)),
	];

	const startedIds = notifications
		.filter((notification): notification is ItemStartedNotification => notification.method === "item/started")
		.map(notification => notification.params.item.id);
	const completedIds = notifications
		.filter((notification): notification is ItemCompletedNotification => notification.method === "item/completed")
		.map(notification => notification.params.item.id);
	expect(startedIds).toEqual(["agent-message:response:response-A", "agent-message:response:response-B"]);
	expect(new Set(startedIds).size).toBe(2);
	expect(completedIds).toEqual(["agent-message:response:response-B", "agent-message:response:response-A"]);
	expect(new Set(completedIds)).toEqual(new Set(startedIds));
	expect(notifications.filter(notification => notification.method === "item/completed")).toHaveLength(2);
	expect(r.openItemCount).toBe(0);
	expectValidNotifications(notifications);
});

test("an identified delta can start a later item after an earlier item completed", () => {
	const r = reducer([1, 2, 3, 4]);
	const first = assistant("first", "response-first");
	const second = assistant("second", "response-second");
	r.accept(messageStart(first));
	r.accept(messageEnd(first));

	const notifications = [...r.accept(messageUpdate(second, "second")), ...r.accept(messageEnd(second))];

	expect(methods(notifications)).toEqual(["item/started", "item/agentMessage/delta", "item/completed"]);
	expect(completed(notifications).params.item.text).toBe("second");
	expect(r.openItemCount).toBe(0);
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
	expectValidNotifications(first);
	const replay = [
		...r.accept(messageStart(initial)),
		...r.accept(messageUpdate(final, "done")),
		...r.accept(messageEnd(final)),
	];

	expect(methods(replay)).toEqual([]);
	expect(r.accept(messageUpdate(final, "late"))).toEqual([]);
	expect(r.openItemCount).toBe(0);
});

test("distinct messages with identical fields stay distinct without durable identity", () => {
	const r = reducer([1, 2, 3, 4]);
	const first = assistant("same", undefined, 1);
	const second = assistant("same", undefined, 1);
	const notifications = [
		...r.accept(messageStart(first)),
		...r.accept(messageStart(second)),
		...r.accept(messageEnd(first)),
		...r.accept(messageEnd(second)),
	];

	expect(methods(notifications)).toEqual(["item/started", "item/started", "item/completed", "item/completed"]);
	const startedIds = notifications
		.filter((notification): notification is ItemStartedNotification => notification.method === "item/started")
		.map(notification => notification.params.item.id);
	expect(new Set(startedIds).size).toBe(2);
	expect(r.openItemCount).toBe(0);
	expectValidNotifications(notifications);
});

test("an update with multiple open items fails closed instead of choosing the first", () => {
	const r = reducer([1, 2]);
	const first = assistant("", "open-one");
	const second = assistant("", "open-two");
	const unknown = assistant("delta", undefined, 2);
	const startedNotifications = [...r.accept(messageStart(first)), ...r.accept(messageStart(second))];

	expect(methods(startedNotifications)).toEqual(["item/started", "item/started"]);
	expect(r.accept(messageUpdate(unknown, "delta"))).toEqual([]);
	expect(r.accept(messageEnd(unknown))).toEqual([]);
	expect(r.openItemCount).toBe(2);
});

test("completeTurn refuses ambiguous authoritative state for multiple open items", () => {
	const r = reducer([1, 2]);
	const first = assistant("first", "open-one");
	const second = assistant("second", "open-two");
	r.accept(messageStart(first));
	r.accept(messageStart(second));

	const unknown = assistant("final", undefined, 3);
	expect(() => r.completeTurn({ kind: "completed", messages: [unknown] })).toThrow(
		"Cannot correlate authoritative agent-message state",
	);
	expect(r.openItemCount).toBe(2);
});

test("a message_end without a started lifecycle is omitted", () => {
	const r = reducer();
	expect(r.accept(messageEnd(assistant("never started", "never-started")))).toEqual([]);
	expect(r.openItemCount).toBe(0);
});

test("interrupted turns may fall back to the last observed message, while completed turns fail closed", () => {
	const interrupted = reducer([1, 2]);
	const initial = assistant("initial", "response-no-final");
	interrupted.accept(messageStart(initial));

	const interruptedNotifications = interrupted.completeTurn({ kind: "interrupted" });
	expect(methods(interruptedNotifications)).toEqual(["item/completed"]);
	expect(completed(interruptedNotifications).params.item.text).toBe("initial");
	expect(interrupted.openItemCount).toBe(0);
	expectValidNotifications(interruptedNotifications);

	const completedTurn = reducer([3, 4]);
	const completedStartNotifications = completedTurn.accept(messageStart(initial));
	expectValidNotifications(completedStartNotifications);
	expect(() => completedTurn.completeTurn({ kind: "completed" })).toThrow("no authoritative message");
	expect(completedTurn.openItemCount).toBe(1);
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
	const secondStart = assistant("partial failure", "response-failed");
	const secondFinal = assistant("failed answer", "response-failed");
	second.accept(messageStart(secondStart));
	const closed = second.completeTurn({ kind: "failed", messages: [secondFinal] });
	expect(methods(closed)).toEqual(["item/completed"]);
	expect(completed(closed).params.item.text).toBe("failed answer");
	expect(second.openItemCount).toBe(0);
	expectValidNotifications(closed);
});
test("cancelled agent_end closes a message_start snapshot before the first delta", () => {
	const r = reducer([10, 20]);
	const start = assistant("start snapshot", "response-cancelled");
	const notifications = [
		...r.accept(messageStart(start)),
		...r.accept({ type: "agent_end", messages: [], stopReason: "cancelled" }),
	];

	expect(methods(notifications)).toEqual(["item/started", "item/completed"]);
	expect(completed(notifications).params.item.text).toBe("start snapshot");
	expect(r.openItemCount).toBe(0);
	expectValidNotifications(notifications);
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

test("a persisted entry identity aliases the existing response identity across live completion and replay", () => {
	const liveStart = assistant("", "response-persisted", 10);
	const persistedFinal = assistant("persisted final", "response-persisted", 10);
	associateSessionMessageEntryId(persistedFinal, "entry-persisted");

	const live = reducer([1, 2]);
	const liveNotifications = [...live.accept(messageStart(liveStart)), ...live.accept(messageEnd(persistedFinal))];
	expectValidNotifications(liveNotifications);
	expect(started(liveNotifications).params.item.id).toBe("agent-message:response:response-persisted");
	expect(completed(liveNotifications).params.item.text).toBe("persisted final");

	const replayStart = assistant("", "response-persisted", 10);
	const replayFinal = assistant("persisted final", "response-persisted", 10);
	associateSessionMessageEntryId(replayStart, "entry-persisted");
	associateSessionMessageEntryId(replayFinal, "entry-persisted");
	const replay = reducer([1, 2]);
	const replayNotifications = [...replay.accept(messageStart(replayStart)), ...replay.accept(messageEnd(replayFinal))];
	expectValidNotifications(replayNotifications);
	expect(started(replayNotifications).params.item.id).toBe(started(liveNotifications).params.item.id);
	expect(replay.openItemCount).toBe(0);
});

test("two assistant messages use distinct deterministic fallback ids and replay identically", () => {
	const first = assistant("first", undefined, 1);
	const second = assistant("second", undefined, 2);
	const events: AgentSessionEvent[] = [
		messageStart(first),
		messageEnd(first),
		messageStart(second),
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
	const replayFirst = assistant("first", undefined, 1);
	const replaySecond = assistant("second", undefined, 2);
	const replayIds = run([
		messageStart(replayFirst),
		messageEnd(replayFirst),
		messageStart(replaySecond),
		messageEnd(replaySecond),
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
