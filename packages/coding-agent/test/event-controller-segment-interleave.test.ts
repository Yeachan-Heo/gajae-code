/**
 * Regression tests for assistant segment splitting (reasoning↔tool interleaving).
 *
 * A streaming assistant message shaped [thinking, toolCall, thinking] used to
 * render as [thinking+thinking] above [tool row]: the streaming component is
 * created once at message_start and `updateContent` re-renders the whole
 * message in place, while tool components append below. The fix cuts a new
 * assistant segment component below the tool rows whenever visible thinking/
 * text arrives after the latest toolCall, and `updateContent` (including the
 * final message_end render) only receives the active segment's slice.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@gajae-code/ai";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { AssistantMessageComponent } from "@gajae-code/coding-agent/modes/components/assistant-message";
import { EventController } from "@gajae-code/coding-agent/modes/controllers/event-controller";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import type { AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { TempDir } from "@gajae-code/utils";

function makeAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

const toolCall = { type: "toolCall", id: "tc-1", name: "bash", arguments: { cmd: "ls" } } as const;

function createFixture() {
	const addChild = vi.fn();
	const initialComponent = new AssistantMessageComponent(undefined, false, () => {});
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: { requestRender: vi.fn() },
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		chatContainer: { addChild },
		streamingComponent: initialComponent,
		streamingMessage: undefined as AssistantMessage | undefined,
		hideThinkingBlock: false,
		// Prepopulated so the tool-component creation path (out of scope here)
		// stays inert and addChild calls reflect segment cuts only.
		pendingTools: new Map([
			["tc-1", { updateArgs: vi.fn(), setArgsComplete: vi.fn() }],
			["tc-2", { updateArgs: vi.fn(), setArgsComplete: vi.fn() }],
		]),
		session: { isTtsrAbortPending: false, retryAttempt: 0, getToolByName: () => undefined },
	} as unknown as InteractiveModeContext;

	const controller = new EventController(ctx);
	return { controller, ctx, addChild, initialComponent };
}

async function update(controller: EventController, message: AssistantMessage): Promise<void> {
	await controller.handleEvent({ type: "message_update", message } as AgentSessionEvent);
}

describe("EventController assistant segment split (reasoning↔tool interleaving)", () => {
	let tempDir: TempDir;

	beforeAll(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-segment-interleave-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		initTheme();
	});

	afterAll(() => {
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("keeps a tool-free message in the original component (no segment cut)", async () => {
		const { controller, ctx, addChild, initialComponent } = createFixture();
		const spy = vi.spyOn(AssistantMessageComponent.prototype, "updateContent");

		await update(controller, makeAssistantMessage([{ type: "thinking", thinking: "pondering" }]));

		expect(addChild).not.toHaveBeenCalled();
		expect(ctx.streamingComponent).toBe(initialComponent);
		const rendered = spy.mock.calls.at(-1)?.[0] as AssistantMessage;
		expect(rendered.content).toHaveLength(1);
		spy.mockRestore();
	});

	it("cuts a new segment when visible thinking arrives after a toolCall", async () => {
		const { controller, ctx, addChild, initialComponent } = createFixture();
		const spy = vi.spyOn(AssistantMessageComponent.prototype, "updateContent");

		await update(
			controller,
			makeAssistantMessage([
				{ type: "thinking", thinking: "before" },
				toolCall,
				{ type: "thinking", thinking: "after" },
			]),
		);

		// A fresh component was appended below the tool rows and became the
		// streaming target; it renders only the post-tool slice.
		expect(addChild).toHaveBeenCalledTimes(1);
		expect(ctx.streamingComponent).not.toBe(initialComponent);
		expect(addChild.mock.calls[0][0]).toBe(ctx.streamingComponent);
		const rendered = spy.mock.calls.at(-1)?.[0] as AssistantMessage;
		expect(rendered.content).toEqual([{ type: "thinking", thinking: "after" }]);
		spy.mockRestore();
	});

	it("does not cut a segment while post-tool content is still invisible (whitespace)", async () => {
		const { controller, ctx, addChild, initialComponent } = createFixture();

		await update(
			controller,
			makeAssistantMessage([{ type: "thinking", thinking: "before" }, toolCall, { type: "text", text: "  " }]),
		);

		expect(addChild).not.toHaveBeenCalled();
		expect(ctx.streamingComponent).toBe(initialComponent);
	});

	it("keeps streaming into the active segment without cutting again", async () => {
		const { controller, ctx, addChild } = createFixture();
		const spy = vi.spyOn(AssistantMessageComponent.prototype, "updateContent");

		await update(
			controller,
			makeAssistantMessage([
				{ type: "thinking", thinking: "before" },
				toolCall,
				{ type: "thinking", thinking: "after" },
			]),
		);
		const segmentComponent = ctx.streamingComponent;
		await update(
			controller,
			makeAssistantMessage([
				{ type: "thinking", thinking: "before" },
				toolCall,
				{ type: "thinking", thinking: "after, extended" },
			]),
		);

		expect(addChild).toHaveBeenCalledTimes(1); // no second cut
		expect(ctx.streamingComponent).toBe(segmentComponent);
		const rendered = spy.mock.calls.at(-1)?.[0] as AssistantMessage;
		expect(rendered.content).toEqual([{ type: "thinking", thinking: "after, extended" }]);
		spy.mockRestore();
	});

	it("cuts again for a second toolCall followed by visible text", async () => {
		const { controller, addChild } = createFixture();
		const spy = vi.spyOn(AssistantMessageComponent.prototype, "updateContent");
		const secondTool = { ...toolCall, id: "tc-2" };

		await update(
			controller,
			makeAssistantMessage([{ type: "thinking", thinking: "a" }, toolCall, { type: "thinking", thinking: "b" }]),
		);
		await update(
			controller,
			makeAssistantMessage([
				{ type: "thinking", thinking: "a" },
				toolCall,
				{ type: "thinking", thinking: "b" },
				secondTool,
				{ type: "text", text: "done" },
			]),
		);

		expect(addChild).toHaveBeenCalledTimes(2);
		const rendered = spy.mock.calls.at(-1)?.[0] as AssistantMessage;
		expect(rendered.content).toEqual([{ type: "text", text: "done" }]);
		spy.mockRestore();
	});

	it("final render on message_end stays scoped to the active segment", async () => {
		const { controller, ctx } = createFixture();
		const message = makeAssistantMessage([
			{ type: "thinking", thinking: "before" },
			toolCall,
			{ type: "text", text: "final answer" },
		]);

		await update(controller, message);
		const spy = vi.spyOn(AssistantMessageComponent.prototype, "updateContent");
		ctx.streamingMessage = message;
		await controller.handleEvent({ type: "message_end", message } as AgentSessionEvent);

		const rendered = spy.mock.calls.at(0)?.[0] as AssistantMessage;
		expect(rendered.content).toEqual([{ type: "text", text: "final answer" }]);
		spy.mockRestore();
	});
});
