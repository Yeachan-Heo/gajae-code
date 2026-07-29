import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import type { AssistantMessage } from "@gajae-code/ai";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { EDIT_MODE_STRATEGIES, type PerFileDiffPreview } from "@gajae-code/coding-agent/edit";
import { AssistantMessageComponent } from "@gajae-code/coding-agent/modes/components/assistant-message";
import type {
	ToolExecutionComponent,
	ToolExecutionHandle,
} from "@gajae-code/coding-agent/modes/components/tool-execution";
import { EventController } from "@gajae-code/coding-agent/modes/controllers/event-controller";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { type Component, Container, Text } from "@gajae-code/tui";

function createContext(handle: ToolExecutionHandle): {
	ctx: InteractiveModeContext;
	addMessageToChat: Mock<() => Component[]>;
	recordVisibleTranscriptMutation: Mock<() => void>;
} {
	const addMessageToChat = vi.fn<() => Component[]>(() => []);
	const recordVisibleTranscriptMutation = vi.fn();
	const ctx = {
		isInitialized: true,
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		ui: { requestRender: vi.fn() },
		pendingTools: new Map([["tool-1", handle]]),
		addMessageToChat,
		recordVisibleTranscriptMutation,
		settings: { get: () => true },
		toolOutputExpanded: false,
		chatContainer: new Container(),
		session: { getToolByName: vi.fn() },
		sessionManager: { getCwd: vi.fn(() => process.cwd()) },
	} as unknown as InteractiveModeContext;
	return { ctx, addMessageToChat, recordVisibleTranscriptMutation };
}

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempts = 0; attempts < 50; attempts++) {
		if (condition()) return;
		await Promise.resolve();
	}
	throw new Error("Preview computation did not reach the expected state");
}

const applyPatch = [
	"*** Begin Patch",
	"*** Update File: preview.ts",
	"@@",
	"-const value = 1;",
	"+const value = 2;",
	"*** End Patch",
].join("\n");

const preview: PerFileDiffPreview[] = [
	{ path: "preview.ts", diff: "@@ -1 +1 @@\n-const value = 1;\n+const value = 2;" },
];

describe("EventController viewport output revision", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await initTheme(false);
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("does not record a controller revision when an observed apply_patch preview resolves absent", async () => {
		await Settings.init({ inMemory: true });
		const requests: Array<PromiseWithResolvers<PerFileDiffPreview[] | null | undefined>> = [];
		vi.spyOn(EDIT_MODE_STRATEGIES.apply_patch, "computeDiffPreview").mockImplementation(() => {
			const request = Promise.withResolvers<PerFileDiffPreview[] | null | undefined>();
			requests.push(request);
			return request.promise as Promise<PerFileDiffPreview[] | null>;
		});
		const placeholder: ToolExecutionHandle = {
			updateArgs: vi.fn(),
			updateResult: vi.fn(),
			setArgsComplete: vi.fn(),
			setExpanded: vi.fn(),
		};
		const { ctx, recordVisibleTranscriptMutation } = createContext(placeholder);
		ctx.pendingTools = new Map();
		const controller = new EventController(ctx);

		await controller.handleEvent({
			type: "tool_execution_start",
			toolName: "apply_patch",
			toolCallId: "preview-1",
			args: { input: applyPatch },
		} as never);
		const component = ctx.pendingTools.get("preview-1") as ToolExecutionComponent;
		await waitFor(() => requests.length === 1);
		recordVisibleTranscriptMutation.mockClear();
		requests[0]!.resolve(preview);
		await waitFor(() => recordVisibleTranscriptMutation.mock.calls.length === 1);
		const visibleBefore = component.render(80);
		recordVisibleTranscriptMutation.mockClear();
		expect(component.consumeVisibleTranscriptChange()).toBe(false);

		component.updateArgs({ input: `${applyPatch}\n` });
		await waitFor(() => requests.length === 2);
		expect(component.consumeVisibleTranscriptChange()).toBe(false);
		requests[1]!.resolve(undefined);
		await Promise.resolve();

		expect(component.render(80)).toEqual(visibleBefore);
		expect(recordVisibleTranscriptMutation).not.toHaveBeenCalled();
		expect(component.consumeVisibleTranscriptChange()).toBe(false);
	});

	it("records one revision for a synchronous event only when its handle reports visible output", async () => {
		const handle: ToolExecutionHandle = {
			updateArgs: vi.fn(),
			updateResult: vi.fn(),
			setArgsComplete: vi.fn(),
			setExpanded: vi.fn(),
			consumeVisibleTranscriptChange: vi.fn(() => true),
		};
		const { ctx, recordVisibleTranscriptMutation } = createContext(handle);
		const controller = new EventController(ctx);

		await controller.handleEvent({
			type: "tool_execution_update",
			toolCallId: "tool-1",
			partialResult: { content: [], details: {} },
		} as never);

		expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(1);
		expect(handle.updateResult).toHaveBeenCalledTimes(1);
		expect(handle.consumeVisibleTranscriptChange).toHaveBeenCalledTimes(1);
	});

	it("does not revise for a synchronous no-op projection", async () => {
		const handle: ToolExecutionHandle = {
			updateArgs: vi.fn(),
			updateResult: vi.fn(),
			setArgsComplete: vi.fn(),
			setExpanded: vi.fn(),
			consumeVisibleTranscriptChange: vi.fn(() => false),
		};
		const { ctx, recordVisibleTranscriptMutation } = createContext(handle);
		const controller = new EventController(ctx);

		await controller.handleEvent({
			type: "tool_execution_update",
			toolCallId: "tool-1",
			partialResult: { content: [], details: {} },
		} as never);

		expect(recordVisibleTranscriptMutation).not.toHaveBeenCalled();
	});

	it("serializes overlapping changed and no-op events so each flush retains its own change state", async () => {
		const handle: ToolExecutionHandle = {
			updateArgs: vi.fn(),
			updateResult: vi.fn(),
			setArgsComplete: vi.fn(),
			setExpanded: vi.fn(),
			consumeVisibleTranscriptChange: vi
				.fn(() => true)
				.mockReturnValueOnce(true)
				.mockReturnValueOnce(false),
		};
		const { ctx, recordVisibleTranscriptMutation } = createContext(handle);
		const initialization = Promise.withResolvers<void>();
		ctx.isInitialized = false;
		ctx.init = vi.fn(async () => {
			await initialization.promise;
			ctx.isInitialized = true;
		});
		const controller = new EventController(ctx);
		const event = {
			type: "tool_execution_update",
			toolCallId: "tool-1",
			partialResult: { content: [], details: {} },
		};

		const changed = controller.handleEvent(event as never);
		const noOp = controller.handleEvent(event as never);
		await Promise.resolve();
		initialization.resolve();
		await Promise.all([changed, noOp]);

		expect(handle.updateResult).toHaveBeenCalledTimes(2);
		expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(1);
	});

	it("does not revise duplicate read args or results, but records a changed read result once", async () => {
		const handle: ToolExecutionHandle = {
			updateArgs: vi.fn(),
			updateResult: vi.fn(),
			setArgsComplete: vi.fn(),
			setExpanded: vi.fn(),
		};
		const { ctx, recordVisibleTranscriptMutation } = createContext(handle);
		await Settings.init({ inMemory: true });
		ctx.pendingTools = new Map();
		const controller = new EventController(ctx);
		const start = {
			type: "tool_execution_start",
			toolName: "read",
			toolCallId: "read-1",
			args: { path: "/tmp/example.ts" },
		};
		const result = {
			type: "tool_execution_end",
			toolName: "read",
			toolCallId: "read-1",
			result: { content: [{ type: "text", text: "updated content" }] },
			isError: false,
		};

		await controller.handleEvent(start as never);
		expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(1);
		recordVisibleTranscriptMutation.mockClear();

		await controller.handleEvent(start as never);
		expect(recordVisibleTranscriptMutation).not.toHaveBeenCalled();

		await controller.handleEvent(result as never);
		expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(1);
		recordVisibleTranscriptMutation.mockClear();

		await controller.handleEvent(result as never);
		expect(recordVisibleTranscriptMutation).not.toHaveBeenCalled();
	});

	describe("message start visible revisions", () => {
		it("records a displayed custom message once", async () => {
			const handle: ToolExecutionHandle = {
				updateArgs: vi.fn(),
				updateResult: vi.fn(),
				setArgsComplete: vi.fn(),
				setExpanded: vi.fn(),
			};
			const { ctx, addMessageToChat, recordVisibleTranscriptMutation } = createContext(handle);
			addMessageToChat.mockReturnValue([new Text("hook output", 1, 0)]);
			const controller = new EventController(ctx);

			await controller.handleEvent({
				type: "message_start",
				message: { role: "custom", customType: "hook", timestamp: 1, content: "hook output", display: true },
			} as never);
			await controller.handleEvent({
				type: "message_start",
				message: { role: "custom", customType: "hook", timestamp: 1, content: "hook output", display: true },
			} as never);

			expect(ctx.addMessageToChat).toHaveBeenCalledTimes(1);
			expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(1);
		});

		it("does not revise a hidden custom message", async () => {
			const handle: ToolExecutionHandle = {
				updateArgs: vi.fn(),
				updateResult: vi.fn(),
				setArgsComplete: vi.fn(),
				setExpanded: vi.fn(),
			};
			const { ctx, addMessageToChat, recordVisibleTranscriptMutation } = createContext(handle);
			addMessageToChat.mockReturnValue([]);
			const controller = new EventController(ctx);

			await controller.handleEvent({
				type: "message_start",
				message: {
					role: "custom",
					customType: "hook",
					timestamp: 2,
					content: "hidden hook output",
					display: false,
				},
			} as never);

			expect(ctx.addMessageToChat).toHaveBeenCalledTimes(1);
			expect(recordVisibleTranscriptMutation).not.toHaveBeenCalled();
		});

		it("does not revise an empty assistant mount until visible content arrives", async () => {
			await Settings.init({ inMemory: true });
			const handle: ToolExecutionHandle = {
				updateArgs: vi.fn(),
				updateResult: vi.fn(),
				setArgsComplete: vi.fn(),
				setExpanded: vi.fn(),
			};
			const { ctx, recordVisibleTranscriptMutation } = createContext(handle);
			const controller = new EventController(ctx);
			const empty = assistantMessage("");
			const visible = assistantMessage("visible text");

			await controller.handleEvent({ type: "message_start", message: empty } as never);
			expect(recordVisibleTranscriptMutation).not.toHaveBeenCalled();
			await controller.handleEvent({ type: "message_update", message: visible } as never);
			expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(1);
		});
	});

	it("records a message_update read group once after message_start when args are duplicated", async () => {
		const handle: ToolExecutionHandle = {
			updateArgs: vi.fn(),
			updateResult: vi.fn(),
			setArgsComplete: vi.fn(),
			setExpanded: vi.fn(),
		};
		const { ctx, recordVisibleTranscriptMutation } = createContext(handle);
		await Settings.init({ inMemory: true });
		ctx.pendingTools = new Map();
		const message = assistantMessage("");
		message.content = [
			{
				type: "toolCall",
				id: "read-message-update",
				name: "read",
				arguments: { path: "/tmp/example.ts" },
			},
		] as never;
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "message_start", message } as never);
		recordVisibleTranscriptMutation.mockClear();
		await controller.handleEvent({ type: "message_update", message } as never);
		expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(1);
		recordVisibleTranscriptMutation.mockClear();

		await controller.handleEvent({ type: "message_update", message } as never);
		expect(recordVisibleTranscriptMutation).not.toHaveBeenCalled();
	});
});

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("completion visible revisions", () => {
	it("consumes each completed tool projection once when it changed", async () => {
		const handle: ToolExecutionHandle = {
			updateArgs: vi.fn(),
			updateResult: vi.fn(),
			setArgsComplete: vi.fn(),
			setExpanded: vi.fn(),
			consumeVisibleTranscriptChange: vi.fn(() => true),
		};
		const { ctx, recordVisibleTranscriptMutation } = createContext(handle);
		const message = assistantMessage("done");
		ctx.streamingMessage = message;
		ctx.streamingComponent = { updateContent: vi.fn(), setUsageInfo: vi.fn() } as never;
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "message_end", message } as never);

		expect(handle.setArgsComplete).toHaveBeenCalledWith("tool-1");
		expect(handle.consumeVisibleTranscriptChange).toHaveBeenCalledTimes(1);
		expect(recordVisibleTranscriptMutation).toHaveBeenCalledTimes(1);
	});

	it("does not revise completion for an unchanged tool projection", async () => {
		const handle: ToolExecutionHandle = {
			updateArgs: vi.fn(),
			updateResult: vi.fn(),
			setArgsComplete: vi.fn(),
			setExpanded: vi.fn(),
			consumeVisibleTranscriptChange: vi.fn(() => false),
		};
		const { ctx, recordVisibleTranscriptMutation } = createContext(handle);
		const message = assistantMessage("done");
		ctx.streamingMessage = message;
		ctx.streamingComponent = { updateContent: vi.fn(), setUsageInfo: vi.fn() } as never;
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "message_end", message } as never);

		expect(handle.setArgsComplete).toHaveBeenCalledWith("tool-1");
		expect(handle.consumeVisibleTranscriptChange).toHaveBeenCalledTimes(1);
		expect(recordVisibleTranscriptMutation).not.toHaveBeenCalled();
	});

	it("reports final Markdown semantics for the same source when usage is hidden", async () => {
		await Settings.init({ inMemory: true });
		const message = assistantMessage("same markdown source");
		const onVisibleMutation = vi.fn();
		const component = new AssistantMessageComponent(message, false, undefined, undefined, onVisibleMutation);

		component.updateContent(message, { streaming: true });
		onVisibleMutation.mockClear();
		component.updateContent(message, { streaming: false });

		expect(onVisibleMutation).toHaveBeenCalledTimes(1);
	});
});
