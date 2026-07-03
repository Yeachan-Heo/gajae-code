/**
 * Phase 6 — C layer.
 *
 * Asserts `EventController.#handleMessageEnd`'s render labeling for the three
 * abort-classification paths:
 *
 *   C1  errorMessage = SILENT_ABORT_MARKER + aborted
 *       → `updateContent` receives a message with `stopReason: "stop"`;
 *         `errorMessage` is NOT overwritten.
 *   C2  errorMessage = undefined + aborted + no TTSR flag
 *       → `streamingMessage.errorMessage` is set to "Operation aborted";
 *         `updateContent` receives the original message ref.
 *   C3  isTtsrAbortPending = true + aborted
 *       → `updateContent` receives a message with `stopReason: "stop"`;
 *         `errorMessage` is NOT set (TTSR existing behavior unchanged).
 */
import { describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@gajae-code/ai";
import { EventController } from "@gajae-code/coding-agent/modes/controllers/event-controller";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import type { AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { SILENT_ABORT_MARKER } from "@gajae-code/coding-agent/session/messages";

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "draft" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "aborted",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
		...overrides,
	};
}

function createFixture(opts: {
	streamingMessage: AssistantMessage;
	isTtsrAbortPending?: boolean;
	retryAttempt?: number;
}) {
	const updateContent = vi.fn();
	const setUsageInfo = vi.fn();
	const streamingComponent = { updateContent, setUsageInfo };
	const requestRender = vi.fn();

	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: { requestRender },
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		streamingComponent,
		streamingMessage: opts.streamingMessage,
		pendingTools: new Map(),
		session: {
			isTtsrAbortPending: opts.isTtsrAbortPending ?? false,
			retryAttempt: opts.retryAttempt ?? 0,
		},
	} as unknown as InteractiveModeContext;

	const controller = new EventController(ctx);
	return { controller, ctx, streamingComponent, requestRender };
}

describe("EventController #handleMessageEnd abort labeling", () => {
	it("C1: SILENT_ABORT_MARKER + aborted -> updateContent stopReason='stop', errorMessage NOT overwritten", async () => {
		const message = makeAssistantMessage({
			stopReason: "aborted",
			errorMessage: SILENT_ABORT_MARKER,
		});
		const { controller, ctx, streamingComponent } = createFixture({ streamingMessage: message });

		const event: Extract<AgentSessionEvent, { type: "message_end" }> = {
			type: "message_end",
			message,
		};
		await controller.handleEvent(event);

		// `updateContent` was called once with a copy whose `stopReason` is "stop".
		// The marker on errorMessage is preserved unchanged on that display copy.
		expect(streamingComponent.updateContent).toHaveBeenCalledTimes(1);
		const arg = streamingComponent.updateContent.mock.calls[0]![0] as AssistantMessage;
		expect(arg.stopReason).toBe("stop");
		expect(arg.errorMessage).toBe(SILENT_ABORT_MARKER);

		// Per the silent-abort contract: the controller must NOT overwrite errorMessage
		// with the operator-facing string. The marker is what drives replay-side
		// suppression, so it has to survive on the persisted message.
		expect(message.errorMessage).toBe(SILENT_ABORT_MARKER);
		// And the streamingMessage on ctx was cleared after the handler ran (lifecycle
		// guard — kept for completeness).
		expect(ctx.streamingMessage).toBeUndefined();
	});

	it("C2: errorMessage undefined + aborted + no TTSR -> errorMessage='Operation aborted', updateContent receives original ref", async () => {
		const message = makeAssistantMessage({ stopReason: "aborted", errorMessage: undefined });
		const { controller, streamingComponent } = createFixture({
			streamingMessage: message,
			isTtsrAbortPending: false,
		});

		await controller.handleEvent({ type: "message_end", message });

		// Operator-facing label was stamped in-place on the streaming message ref.
		expect(message.errorMessage).toBe("Operation aborted");

		// `updateContent` saw the original streaming message ref (no `{...streamingMessage, stopReason:"stop"}` spread).
		expect(streamingComponent.updateContent).toHaveBeenCalledTimes(1);
		const arg = streamingComponent.updateContent.mock.calls[0]![0] as AssistantMessage;
		expect(arg).toBe(message);
		expect(arg.stopReason).toBe("aborted");
		expect(arg.errorMessage).toBe("Operation aborted");
	});

	it("C3: isTtsrAbortPending=true + aborted -> updateContent stopReason='stop', errorMessage NOT set", async () => {
		const message = makeAssistantMessage({ stopReason: "aborted", errorMessage: undefined });
		const { controller, streamingComponent } = createFixture({
			streamingMessage: message,
			isTtsrAbortPending: true,
		});

		await controller.handleEvent({ type: "message_end", message });

		// TTSR keeps its existing flag-only render path — `errorMessage` stays undefined,
		// and the display copy gets `stopReason: "stop"`.
		expect(message.errorMessage).toBeUndefined();
		expect(streamingComponent.updateContent).toHaveBeenCalledTimes(1);
		const arg = streamingComponent.updateContent.mock.calls[0]![0] as AssistantMessage;
		expect(arg.stopReason).toBe("stop");
		expect(arg.errorMessage).toBeUndefined();
	});
	it("C4: provider stream idle abort -> preserves root cause and remediation hint after retry", async () => {
		const message = makeAssistantMessage({
			stopReason: "aborted",
			errorMessage: "Anthropic stream stalled while waiting for the next event",
		});
		const { controller, streamingComponent } = createFixture({
			streamingMessage: message,
			isTtsrAbortPending: false,
			retryAttempt: 1,
		});

		await controller.handleEvent({ type: "message_end", message });

		expect(message.errorMessage).toBe(
			"Aborted after 1 retry attempt: Anthropic stream stalled while waiting for the next event. Hint: set GJC_STREAM_IDLE_TIMEOUT_MS=300000 for slow reasoning/proxy streams, or GJC_STREAM_IDLE_TIMEOUT_MS=0 to disable the watchdog.",
		);
		expect(streamingComponent.updateContent).toHaveBeenCalledTimes(1);
		const arg = streamingComponent.updateContent.mock.calls[0]![0] as AssistantMessage;
		expect(arg).toBe(message);
		expect(arg.stopReason).toBe("aborted");
		expect(arg.errorMessage).toContain("GJC_STREAM_IDLE_TIMEOUT_MS=300000");
	});

	it("C5: replayed formatted abort label -> does not double-prefix or duplicate hints", async () => {
		const formatted =
			"Aborted after 1 retry attempt: Anthropic stream stalled while waiting for the next event. Hint: set GJC_STREAM_IDLE_TIMEOUT_MS=300000 for slow reasoning/proxy streams, or GJC_STREAM_IDLE_TIMEOUT_MS=0 to disable the watchdog.";
		const message = makeAssistantMessage({
			stopReason: "aborted",
			errorMessage: formatted,
		});
		const { controller, streamingComponent } = createFixture({
			streamingMessage: message,
			isTtsrAbortPending: false,
			retryAttempt: 0,
		});

		await controller.handleEvent({ type: "message_end", message });

		expect(message.errorMessage).toBe(formatted);
		expect(streamingComponent.updateContent).toHaveBeenCalledTimes(1);
		const arg = streamingComponent.updateContent.mock.calls[0]![0] as AssistantMessage;
		expect(arg).toBe(message);
		expect(arg.errorMessage).toBe(formatted);
	});
});
