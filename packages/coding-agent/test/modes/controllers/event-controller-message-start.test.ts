import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { TextContent, UserMessage } from "@gajae-code/ai";
import { EventController } from "@gajae-code/coding-agent/modes/controllers/event-controller";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { UiHelpers } from "@gajae-code/coding-agent/modes/utils/ui-helpers";
import type { CustomMessage } from "@gajae-code/coding-agent/session/messages";
import { Container } from "@gajae-code/tui";

beforeAll(() => {
	initTheme();
});

function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		attribution: "user",
		timestamp: Date.now(),
	};
}

function createContext(options: {
	editorText: string;
	optimisticSignature?: string;
	locallySubmittedSignatures?: string[];
	injectedSignatures?: Array<[string, number]>;
}) {
	let currentEditorText = options.editorText;
	const setText = vi.fn((text: string) => {
		currentEditorText = text;
	});
	const editor = {
		setText,
		getText: () => currentEditorText,
	};
	const addMessageToChat = vi.fn();
	const updatePendingMessagesDisplay = vi.fn();
	const ctx = {
		isInitialized: true,
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		ui: { requestRender: vi.fn() },
		editor,
		addMessageToChat,
		updatePendingMessagesDisplay,
		getUserMessageText: (message: UserMessage) =>
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((c): c is TextContent => c.type === "text")
						.map(c => c.text)
						.join(""),
		optimisticUserMessageSignature: options.optimisticSignature,
		locallySubmittedUserSignatures: new Set<string>(options.locallySubmittedSignatures ?? []),
		optimisticInjectedSignatures: new Map<string, number>(options.injectedSignatures ?? []),
	} as unknown as InteractiveModeContext;
	return { ctx, editor, setText, addMessageToChat, updatePendingMessagesDisplay };
}

describe("EventController message_start (user role)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("preserves an in-progress editor draft when delivering a queued submission", async () => {
		// Reproduces the bug: user sends a message during streaming (queued) and then
		// types a follow-up draft. When the queue drains and message_start fires,
		// the editor MUST keep the draft.
		const message = createUserMessage("queued during streaming");
		const signature = "queued during streaming\u00000";
		const { ctx, editor, setText, addMessageToChat, updatePendingMessagesDisplay } = createContext({
			editorText: "draft typed after queuing",
			locallySubmittedSignatures: [signature],
		});
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "message_start", message });

		expect(setText).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("draft typed after queuing");
		// Queued message was not optimistically rendered, so it must still land in chat.
		expect(addMessageToChat).toHaveBeenCalledWith(message);
		// Pending list always refreshes so the dequeued entry disappears.
		expect(updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		// Signature is consumed so a future external message with the same shape still clears.
		expect(ctx.locallySubmittedUserSignatures.has(signature)).toBe(false);
	});

	it("clears the editor for user messages that did not originate from this session", async () => {
		// Counter-case: an external/programmatic user message must still trigger the
		// defensive editor reset so the next prompt starts clean.
		const message = createUserMessage("external prompt");
		const { ctx, setText, addMessageToChat } = createContext({
			editorText: "stale text",
		});
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "message_start", message });

		expect(setText).toHaveBeenCalledWith("");
		expect(addMessageToChat).toHaveBeenCalledWith(message);
	});

	it("preserves the editor for an optimistic submission and skips the duplicate chat add", async () => {
		// Optimistic path already added the user message to chat and cleared the
		// editor at submit time. message_start must not re-add or re-clear.
		const message = createUserMessage("optimistic send");
		const signature = "optimistic send\u00000";
		const { ctx, setText, addMessageToChat } = createContext({
			editorText: "",
			optimisticSignature: signature,
			locallySubmittedSignatures: [signature],
		});
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "message_start", message });

		expect(addMessageToChat).not.toHaveBeenCalled();
		expect(setText).not.toHaveBeenCalled();
		expect(ctx.optimisticUserMessageSignature).toBeUndefined();
	});

	it("prefers local optimistic slot over matching injected map entry", async () => {
		const message = createUserMessage("coexisting optimistic");
		const signature = "coexisting optimistic\u00000";
		const { ctx, setText, addMessageToChat } = createContext({
			editorText: "",
			optimisticSignature: signature,
			locallySubmittedSignatures: [signature],
			injectedSignatures: [[signature, 1]],
		});
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "message_start", message });

		expect(addMessageToChat).not.toHaveBeenCalled();
		expect(setText).not.toHaveBeenCalled();
		expect(ctx.optimisticUserMessageSignature).toBeUndefined();
		expect(ctx.optimisticInjectedSignatures.get(signature)).toBe(1);
		expect(ctx.optimisticInjectedSignatures.size).toBe(1);
	});

	it("consumes a pending injected optimistic signature and preserves the draft", async () => {
		// Injected (e.g. Telegram) messages record a pending injected optimistic signature
		// (counting Map) via applyInjectedUserSubmission. message_start must consume it,
		// skip the duplicate chat add, and NOT clear the local draft.
		const message = createUserMessage("remote injected");
		const signature = "remote injected\u00000";
		const { ctx, editor, setText, addMessageToChat } = createContext({
			editorText: "local draft in progress",
			injectedSignatures: [[signature, 1]],
		});
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "message_start", message });

		expect(addMessageToChat).not.toHaveBeenCalled();
		expect(setText).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("local draft in progress");
		expect(ctx.optimisticInjectedSignatures.size).toBe(0);
	});

	it("de-dupes two back-to-back idle injections without duplicating chat or clearing the draft", async () => {
		// Regression for the single-slot race: two idle injections were optimistically
		// rendered before the first message_start; with a single slot the first message_start
		// re-added a duplicate bubble and cleared the draft. The counting Map fixes this.
		const first = createUserMessage("first remote");
		const second = createUserMessage("second remote");
		const { ctx, editor, setText, addMessageToChat } = createContext({
			editorText: "local draft in progress",
			injectedSignatures: [
				["first remote\u00000", 1],
				["second remote\u00000", 1],
			],
		});
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "message_start", message: first });
		await controller.handleEvent({ type: "message_start", message: second });

		// Neither injected message_start re-adds a bubble (both were rendered optimistically).
		expect(addMessageToChat).not.toHaveBeenCalled();
		// The local draft is never cleared by either injected message_start.
		expect(setText).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("local draft in progress");
		// Both pending injected signatures are fully consumed.
		expect(ctx.optimisticInjectedSignatures.size).toBe(0);
	});

	it("consumes only the injected map and leaves a coexisting local optimistic slot untouched", async () => {
		// Coexistence guard: a local optimistic submission is pending (single slot) while an
		// injected message with a DIFFERENT signature arrives. The injected message_start must
		// consume only the injected map entry and must NOT clear the unrelated local slot.
		const injectedMessage = createUserMessage("remote injected");
		const injectedSignature = "remote injected\u00000";
		const localSignature = "local pending\u00000";
		const { ctx, editor, setText, addMessageToChat } = createContext({
			editorText: "local draft in progress",
			optimisticSignature: localSignature,
			injectedSignatures: [[injectedSignature, 1]],
		});
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "message_start", message: injectedMessage });

		expect(addMessageToChat).not.toHaveBeenCalled();
		expect(setText).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("local draft in progress");
		// The local optimistic slot is NOT cleared by the injected match.
		expect(ctx.optimisticUserMessageSignature).toBe(localSignature);
		// The injected entry is consumed.
		expect(ctx.optimisticInjectedSignatures.size).toBe(0);
	});
});

function createIrcMessage(timestamp: number): CustomMessage<{ from: string; message: string }> {
	return {
		role: "custom",
		customType: "irc:incoming",
		content: "Ready",
		display: true,
		details: { from: "0-Main", message: "Ready" },
		timestamp,
	};
}

function createIrcContext() {
	const chatContainer = new Container();
	const requestRender = vi.fn();
	const ctx = {
		isInitialized: true,
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		ui: { requestRender },
		chatContainer,
		session: {},
	} as unknown as InteractiveModeContext;
	const helpers = new UiHelpers(ctx);
	const addMessageToChat: InteractiveModeContext["addMessageToChat"] = vi.fn((message, options) =>
		helpers.addMessageToChat(message, options),
	);
	ctx.addMessageToChat = addMessageToChat;
	return { ctx, chatContainer, requestRender, addMessageToChat };
}

describe("EventController IRC expiry", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("renders IRC messages immediately and removes their components after the TTL", async () => {
		vi.useFakeTimers();
		const message = createIrcMessage(1);
		const { ctx, chatContainer, requestRender } = createIrcContext();
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "irc_message", message });

		expect(chatContainer.children).toHaveLength(2);
		expect(requestRender).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(9_999);
		expect(chatContainer.children).toHaveLength(2);

		vi.advanceTimersByTime(1);
		expect(chatContainer.children).toHaveLength(0);
		expect(requestRender).toHaveBeenCalledTimes(2);
	});

	it("does not schedule duplicate expiry for duplicate IRC events", async () => {
		vi.useFakeTimers();
		const message = createIrcMessage(2);
		const { ctx, chatContainer, addMessageToChat } = createIrcContext();
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "irc_message", message });
		await controller.handleEvent({ type: "irc_message", message });

		expect(addMessageToChat).toHaveBeenCalledTimes(1);
		expect(chatContainer.children).toHaveLength(2);
		vi.advanceTimersByTime(10_000);
		expect(chatContainer.children).toHaveLength(0);
	});

	it("clears pending IRC expiry timers on dispose", async () => {
		vi.useFakeTimers();
		const message = createIrcMessage(3);
		const { ctx, chatContainer, requestRender } = createIrcContext();
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "irc_message", message });
		controller.dispose();
		vi.advanceTimersByTime(10_000);

		expect(chatContainer.children).toHaveLength(2);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});
});
