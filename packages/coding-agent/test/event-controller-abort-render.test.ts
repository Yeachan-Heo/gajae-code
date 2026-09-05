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
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@gajae-code/ai";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { EventController } from "@gajae-code/coding-agent/modes/controllers/event-controller";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import type { AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { SILENT_ABORT_MARKER } from "@gajae-code/coding-agent/session/messages";
import { Container } from "@gajae-code/tui";

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
});
afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

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
	const preparations = new Set<() => void>();
	const captured: Array<() => void> = [];

	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: {
			requestRender,
			enqueueBeforeRender: (callback: () => void) => {
				preparations.add(callback);
				captured.push(callback);
				return () => {
					preparations.delete(callback);
				};
			},
		},
		chatContainer: new Container(),
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
	return { controller, ctx, streamingComponent, requestRender, preparations, captured };
}

describe("EventController #handleMessageEnd abort labeling", () => {
	for (const ending of ["success", "error", "visible", "silent", "ttsr"] as const) {
		it(`queued text cannot supersede authoritative ${ending} finalization`, async () => {
			const initial = makeAssistantMessage({ stopReason: "stop", content: [] });
			const f = createFixture({ streamingMessage: initial, isTtsrAbortPending: ending === "ttsr" });
			await f.controller.handleEvent({ type: "message_start", message: initial });
			const component = f.ctx.streamingComponent!;
			const projection = vi.spyOn(component, "updateContent");
			const setUsageInfo = component.setUsageInfo.bind(component);
			const usage = vi.spyOn(component, "setUsageInfo").mockImplementation(value => {
				// The controller's authoritative final projection precedes usage.
				expect(projection).toHaveBeenCalledTimes(1);
				setUsageInfo(value);
				// Real usage presentation reprojects the saved final message, not a queued delta.
				expect(projection).toHaveBeenCalledTimes(2);
			});
			const draft = makeAssistantMessage({ stopReason: "stop" });
			await f.controller.handleEvent({
				type: "message_update",
				message: draft,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0 },
			} as never);
			expect(projection).not.toHaveBeenCalled();
			expect(f.preparations.size).toBe(1);
			const final = makeAssistantMessage({
				content: [{ type: "text", text: "authoritative final differs from draft" }],
				stopReason: ending === "success" ? "stop" : ending === "error" ? "error" : "aborted",
				errorMessage:
					ending === "silent" ? SILENT_ABORT_MARKER : ending === "error" ? "provider failed" : undefined,
			});
			await f.controller.handleEvent({ type: "message_end", message: final });
			expect(f.preparations.size).toBe(0);
			expect(usage).toHaveBeenCalledTimes(1);
			const finalProjectionCount = projection.mock.calls.length;
			const finalRendered = component.render(80);
			f.captured[0]!();
			expect(projection).toHaveBeenCalledTimes(finalProjectionCount);
			expect(component.render(80)).toEqual(finalRendered);
			const [display, options] = projection.mock.calls[0]!;
			for (const [projectedMessage, projectedOptions] of projection.mock.calls) {
				expect(projectedMessage).toBe(display);
				expect(projectedOptions).toEqual({ streaming: false });
			}
			expect(options).toEqual({ streaming: false });
			expect(display.content).toEqual(final.content);
			expect(display.stopReason).toBe(ending === "silent" || ending === "ttsr" ? "stop" : final.stopReason);
			if (ending === "visible") expect(display.errorMessage).toBe("Operation aborted");
			if (ending === "silent") expect(final.errorMessage).toBe(SILENT_ABORT_MARKER);
			if (ending === "ttsr") expect(final.errorMessage).toBeUndefined();
			if (ending === "error") expect(display.errorMessage).toBe("provider failed");
			expect(usage).toHaveBeenCalledWith(final.usage);
			expect(f.ctx.streamingComponent).toBeUndefined();
			expect(f.ctx.streamingMessage).toBeUndefined();
			f.controller.resumeAssistantTextPresentation();
			expect(f.preparations.size).toBe(0);
			expect(projection).toHaveBeenCalledTimes(finalProjectionCount);
		});
	}

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
			"Aborted after 1 retry attempt: Anthropic stream stalled while waiting for the next event. Hint: set PI_STREAM_IDLE_TIMEOUT_MS=300000 for slow reasoning/proxy streams, or PI_STREAM_IDLE_TIMEOUT_MS=0 to disable the watchdog.",
		);
		expect(streamingComponent.updateContent).toHaveBeenCalledTimes(1);
		const arg = streamingComponent.updateContent.mock.calls[0]![0] as AssistantMessage;
		expect(arg).toBe(message);
		expect(arg.stopReason).toBe("aborted");
		expect(arg.errorMessage).toContain("PI_STREAM_IDLE_TIMEOUT_MS=300000");
	});

	it("C5: replayed formatted abort label -> does not double-prefix or duplicate hints", async () => {
		const formatted =
			"Aborted after 1 retry attempt: Anthropic stream stalled while waiting for the next event. Hint: set PI_STREAM_IDLE_TIMEOUT_MS=300000 for slow reasoning/proxy streams, or PI_STREAM_IDLE_TIMEOUT_MS=0 to disable the watchdog.";
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

	it("orphan agent_end commits the latest partial assistant before terminal cleanup", async () => {
		const initial = makeAssistantMessage({ stopReason: "stop", content: [] });
		const f = createFixture({ streamingMessage: initial });
		f.ctx.setWorkingMessage = vi.fn();
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		f.ctx.planModeController = {
			flushPendingModelSwitch: () => {
				entered.resolve();
				return gate.promise;
			},
		} as never;
		let stopped = false;
		f.ctx.isStopped = () => stopped;

		await f.controller.handleEvent({ type: "message_start", message: initial });
		const component = f.ctx.streamingComponent!;
		const partial = makeAssistantMessage({
			stopReason: "aborted",
			errorMessage: undefined,
			content: [{ type: "text", text: "partial" }],
		});
		await f.controller.handleEvent({
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0 },
		} as never);

		const pending = f.controller.handleEvent({ type: "agent_end", messages: [partial] } as never);
		await entered.promise;
		expect(f.ctx.chatContainer.hasLiveChild(component)).toBe(true);
		expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("partial");
		expect(partial.errorMessage).toBe("Operation aborted");
		expect(f.ctx.streamingComponent).toBeUndefined();
		expect(f.ctx.streamingMessage).toBeUndefined();
		f.captured[0]!();
		stopped = true;
		gate.resolve();
		await pending;
	});
});
