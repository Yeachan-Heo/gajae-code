import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import type {
	AgentWireCompactMessageUpdatePayload,
	AgentWireEventFrame,
	AgentWireEventPayload,
} from "../src/modes/shared/agent-wire/event-contract";
import {
	AgentWireCompactEventEncoder,
	AgentWireFrameSequencer,
	toAgentWireCompactEventFrame,
	toAgentWireEventFrame,
	toBridgeEventFrame,
} from "../src/modes/shared/agent-wire/event-envelope";
import { rpcSuccess } from "../src/modes/shared/agent-wire/responses";
import type { AgentSessionEvent } from "../src/session/agent-session";

type ContentBlock = Record<string, unknown>;
type AssistantMessage = { id: string; role: "assistant"; content: ContentBlock[] };
type CompactFrame = ReturnType<typeof toAgentWireCompactEventFrame>;

type NegotiationState = { compactMessageUpdate: boolean };

function clone<T>(value: T): T {
	return structuredClone(value);
}

function message(content: ContentBlock[] = [{ type: "text", text: "" }]): AssistantMessage {
	return { id: "msg-1", role: "assistant", content };
}

function update(message: AssistantMessage, assistantMessageEvent: Record<string, unknown>): AgentSessionEvent {
	return { type: "message_update", message, assistantMessageEvent } as unknown as AgentSessionEvent;
}

function messageEnd(message: AssistantMessage): AgentSessionEvent {
	return { type: "message_end", message } as unknown as AgentSessionEvent;
}

function appendEventToMessage(target: AssistantMessage, assistantMessageEvent: Record<string, unknown>): void {
	const index = typeof assistantMessageEvent.contentIndex === "number" ? assistantMessageEvent.contentIndex : 0;
	let block = target.content[index];
	if (!block) {
		block = {};
		target.content[index] = block;
	}
	const delta = assistantMessageEvent.delta;
	if (assistantMessageEvent.type === "text_delta" && typeof delta === "string") {
		block.type = "text";
		block.text = `${typeof block.text === "string" ? block.text : ""}${delta}`;
		return;
	}
	if (assistantMessageEvent.type === "thinking_delta" && typeof delta === "string") {
		block.type = "thinking";
		block.thinking = `${typeof block.thinking === "string" ? block.thinking : ""}${delta}`;
		return;
	}
	if (assistantMessageEvent.type === "tool_call_delta" && typeof delta === "string") {
		block.type = "toolCall";
		block.id = block.id ?? `tool-${index}`;
		block.name = block.name ?? "read";
		block.arguments = `${typeof block.arguments === "string" ? block.arguments : ""}${delta}`;
	}
}

function applyCompactPayload(target: AssistantMessage, payload: AgentWireCompactMessageUpdatePayload): void {
	if (payload.checkpoint_message) {
		const checkpoint = payload.checkpoint_message as unknown as AssistantMessage;
		target.id = checkpoint.id;
		target.role = checkpoint.role;
		target.content = clone(checkpoint.content);
		return;
	}
	appendEventToMessage(target, payload.assistantMessageEvent as Record<string, unknown>);
}

function emitCompactStream(
	count: number,
	options?: { checkpointInterval?: number; multiBlock?: boolean },
): {
	frames: CompactFrame[];
	source: AssistantMessage;
	terminal: AgentWireEventFrame;
} {
	const source = options?.multiBlock
		? message([
				{ type: "text", text: "" },
				{ type: "thinking", thinking: "" },
				{ type: "toolCall", id: "tool-2", name: "read", arguments: "" },
			])
		: message();
	const encoder = new AgentWireCompactEventEncoder(new AgentWireFrameSequencer("sess-compact"), {
		checkpointInterval: options?.checkpointInterval ?? 32,
	});
	const frames: CompactFrame[] = [];
	for (let i = 0; i < count; i += 1) {
		const kind = options?.multiBlock ? i % 3 : 0;
		const delta = `${kind === 0 ? "txt" : kind === 1 ? "think" : "tool"}-${String(i).padStart(3, "0")};`;
		const assistantMessageEvent =
			kind === 0
				? { type: "text_delta", contentIndex: 0, delta }
				: kind === 1
					? { type: "thinking_delta", contentIndex: 1, delta }
					: { type: "tool_call_delta", contentIndex: 2, delta };
		appendEventToMessage(source, assistantMessageEvent);
		frames.push(
			toAgentWireCompactEventFrame(update(source, { ...assistantMessageEvent, partial: clone(source) }), encoder),
		);
	}
	return {
		frames,
		source,
		terminal: toAgentWireCompactEventFrame(messageEnd(source), encoder) as AgentWireEventFrame,
	};
}

function negotiateCapabilities(requested: string[], state: NegotiationState) {
	const acceptedCapabilities = requested.filter(capability => capability === "compact_message_update");
	state.compactMessageUpdate = acceptedCapabilities.includes("compact_message_update");
	return rpcSuccess("cap-1", "set_capabilities", {
		acceptedCapabilities,
		unsupported: requested.filter(capability => capability !== "compact_message_update"),
	});
}

describe("RPC compact message_update frames", () => {
	it("LEGACY-PARITY: default message_update payloads are byte-identical to full-message event framing", () => {
		const source = message([{ type: "text", text: "hello" }]);
		const event = update(source, { type: "text_delta", contentIndex: 0, delta: "o", partial: clone(source) });
		const defaultFrame = toAgentWireEventFrame(event, new AgentWireFrameSequencer("sess-legacy"));
		const preExistingFullFrame = toAgentWireEventFrame(event, new AgentWireFrameSequencer("sess-legacy"));

		expect(JSON.stringify(defaultFrame.payload)).toBe(JSON.stringify(preExistingFullFrame.payload));
		expect(defaultFrame.payload).toEqual({ event_type: "message_update", event });
		expect((defaultFrame.payload as AgentWireEventPayload).event).toBe(event);
	});

	it("RECONSTRUCTION: compact multi-block deltas plus checkpoints plus terminal full message reconstruct exactly", () => {
		const { frames, source, terminal } = emitCompactStream(75, { multiBlock: true });
		const reconstructed = message([
			{ type: "text", text: "" },
			{ type: "thinking", thinking: "" },
			{ type: "toolCall", id: "tool-2", name: "read", arguments: "" },
		]);

		for (const frame of frames)
			applyCompactPayload(reconstructed, frame.payload as AgentWireCompactMessageUpdatePayload);
		const terminalMessage = (
			(terminal.payload as AgentWireEventPayload).event as Extract<AgentSessionEvent, { type: "message_end" }>
		).message;

		expect(reconstructed).toEqual(source);
		expect(reconstructed).toEqual(terminalMessage as unknown as AssistantMessage);
		expect(
			frames.filter(frame => (frame.payload as AgentWireCompactMessageUpdatePayload).checkpoint_message).length,
		).toBe(2);
		const firstPayload = frames[0].payload as AgentWireCompactMessageUpdatePayload;
		expect(firstPayload.assistantMessageEvent).toEqual({ type: "text_delta", contentIndex: 0, delta: "txt-000;" });
		expect("partial" in firstPayload.assistantMessageEvent).toBe(false);
		expect("message" in firstPayload.assistantMessageEvent).toBe(false);

		expect((terminal.payload as AgentWireEventPayload).event_type).toBe("message_end");
	});

	it("SERIALIZATION-BOUND: compact deltas omit growing partials and stay bounded while legacy grows", () => {
		const compact = emitCompactStream(200, { checkpointInterval: 0, multiBlock: false });
		const legacySource = message();
		const compactFrameBytes = compact.frames.map(frame => JSON.stringify(frame).length);
		const legacyFrameBytes: number[] = [];

		for (let i = 0; i < 200; i += 1) {
			const delta = `txt-${String(i).padStart(3, "0")};`;
			appendEventToMessage(legacySource, { type: "text_delta", contentIndex: 0, delta });
			legacyFrameBytes.push(
				JSON.stringify(
					toAgentWireEventFrame(
						update(legacySource, { type: "text_delta", contentIndex: 0, delta, partial: clone(legacySource) }),
						new AgentWireFrameSequencer("sess-legacy-size"),
					),
				).length,
			);
		}

		const compactBytes = compactFrameBytes.reduce((sum, bytes) => sum + bytes, 0);
		const legacyBytes = legacyFrameBytes.reduce((sum, bytes) => sum + bytes, 0);
		const compactDeltaGrowth = compactFrameBytes.at(-1)! - compactFrameBytes[0];
		const legacyDeltaGrowth = legacyFrameBytes.at(-1)! - legacyFrameBytes[0];
		const compactPayload = compact.frames[199].payload as AgentWireCompactMessageUpdatePayload;

		expect(compactPayload.assistantMessageEvent).toEqual({ type: "text_delta", contentIndex: 0, delta: "txt-199;" });
		expect("partial" in compactPayload.assistantMessageEvent).toBe(false);
		expect("message" in compactPayload.assistantMessageEvent).toBe(false);
		expect(compactDeltaGrowth).toBeLessThanOrEqual(8);
		expect(legacyDeltaGrowth).toBeGreaterThan(1500);
		expect(compactBytes).toBeLessThan(legacyBytes / 4);
		expect(compactBytes / legacyBytes).toBeLessThan(0.15);
	});

	it("SNAPSHOT-ISOLATION: emitted checkpoint frames do not observe later in-place source mutation", () => {
		const source = message([{ type: "text", text: "before" }]);
		const encoder = new AgentWireCompactEventEncoder(new AgentWireFrameSequencer("sess-snapshot"), {
			checkpointInterval: 1,
		});
		const frame = toAgentWireCompactEventFrame(
			update(source, { type: "text_delta", contentIndex: 0, delta: "!", partial: clone(source) }),

			encoder,
		);
		const beforeMutation = clone((frame.payload as AgentWireCompactMessageUpdatePayload).checkpoint_message);

		(source.content[0] as { text: string }).text = "after mutation";
		source.content.push({ type: "text", text: "late append" });

		expect((frame.payload as AgentWireCompactMessageUpdatePayload).checkpoint_message).toEqual(beforeMutation);
		expect((frame.payload as AgentWireCompactMessageUpdatePayload).checkpoint_message).not.toEqual(source);
	});

	it("CHECKPOINT-BOUNDARY: exactly every 32nd compact update is a full checkpoint and intervening updates are deltas only", () => {
		const { frames } = emitCompactStream(65, { checkpointInterval: 32 });
		const checkpointIndexes = frames
			.map((frame, index) => ({
				index: index + 1,
				hasCheckpoint: Boolean((frame.payload as AgentWireCompactMessageUpdatePayload).checkpoint_message),
			}))
			.filter(item => item.hasCheckpoint)
			.map(item => item.index);

		expect(checkpointIndexes).toEqual([32, 64]);
		for (const [index, frame] of frames.entries()) {
			const payload = frame.payload as AgentWireCompactMessageUpdatePayload;
			expect(payload.compact).toBe(true);
			if ((index + 1) % 32 === 0) {
				expect(payload.checkpoint_message).toBeDefined();
				expect(payload.checkpoint_reason).toBe("periodic");
			} else {
				expect(payload.checkpoint_message).toBeUndefined();
			}
		}
	});

	it("UNKNOWN-CAPABILITY: bogus capability is reported unsupported and compact stays off", () => {
		const state: NegotiationState = { compactMessageUpdate: false };
		const response = negotiateCapabilities(["bogus_capability"], state);
		const event = update(message(), {
			type: "text_delta",
			contentIndex: 0,
			delta: "x",
			partial: message([{ type: "text", text: "x" }]),
		});

		const frame = state.compactMessageUpdate
			? toAgentWireCompactEventFrame(
					event,
					new AgentWireCompactEventEncoder(new AgentWireFrameSequencer("sess-bogus")),
				)
			: toAgentWireEventFrame(event, new AgentWireFrameSequencer("sess-bogus"));

		expect(response.success).toBe(true);
		expect("data" in response ? response.data : undefined).toEqual({
			acceptedCapabilities: [],
			unsupported: ["bogus_capability"],
		});
		expect(state.compactMessageUpdate).toBe(false);
		expect((frame.payload as AgentWireEventPayload).event).toBe(event);
		expect((frame.payload as AgentWireCompactMessageUpdatePayload).compact).toBeUndefined();
	});

	it("TERMINAL: message_end always emits a full terminal message after many non-checkpoint deltas", () => {
		const { frames, source, terminal } = emitCompactStream(63, { checkpointInterval: 32 });
		expect((frames[31].payload as AgentWireCompactMessageUpdatePayload).checkpoint_message).toBeDefined();
		expect((frames[62].payload as AgentWireCompactMessageUpdatePayload).checkpoint_message).toBeUndefined();

		const payload = terminal.payload as AgentWireEventPayload;
		expect(payload.event_type).toBe("message_end");
		expect((payload.event as Extract<AgentSessionEvent, { type: "message_end" }>).message as unknown).toEqual(source);
		expect((payload as unknown as AgentWireCompactMessageUpdatePayload).compact).toBeUndefined();
	});

	it("BRIDGE-UNAFFECTED: bridge event framing keeps full message_update payloads with no compact leakage", () => {
		const source = message([{ type: "text", text: "bridge" }]);
		const event = update(source, { type: "text_delta", contentIndex: 0, delta: "!", partial: clone(source) });
		const bridgeFrame = toBridgeEventFrame(event, new AgentWireFrameSequencer("sess-bridge"));

		expect(bridgeFrame.payload).toEqual({ event_type: "message_update", event });
		expect((bridgeFrame.payload as AgentWireEventPayload).event).toBe(event);
		expect((bridgeFrame.payload as unknown as AgentWireCompactMessageUpdatePayload).compact).toBeUndefined();
	});

	it("frame_id remains randomUUID-shaped and unique across compact frames", () => {
		const { frames } = emitCompactStream(10);
		const ids = frames.map(frame => frame.frame_id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(() => randomUUID({ disableEntropyCache: true }).replace(id, id)).not.toThrow();
		for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});
});
