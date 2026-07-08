import { describe, expect, it, vi } from "bun:test";
import type { ImageContent, TextContent } from "@gajae-code/ai";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import {
	applyInjectedUserSubmission,
	consumeInjectedOptimisticSignature,
	incrementInjectedOptimisticSignature,
	normalizeInjectedUserContent,
} from "@gajae-code/coding-agent/modes/utils/injected-user-submission";

function createContext() {
	const addToHistory = vi.fn();
	const setText = vi.fn();
	const addMessageToChat = vi.fn();
	const updatePendingMessagesDisplay = vi.fn();
	const requestRender = vi.fn();
	const optimisticInjectedSignatures = new Map<string, number>();
	const ctx = {
		editor: { addToHistory, setText },
		addMessageToChat,
		updatePendingMessagesDisplay,
		ui: { requestRender },
		optimisticUserMessageSignature: undefined,
		optimisticInjectedSignatures,
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		addToHistory,
		setText,
		addMessageToChat,
		updatePendingMessagesDisplay,
		requestRender,
		optimisticInjectedSignatures,
	};
}

const image: ImageContent = { type: "image", data: "AAAA", mimeType: "image/png" };

describe("normalizeInjectedUserContent", () => {
	it("returns string content unchanged with no images", () => {
		expect(normalizeInjectedUserContent("hello from telegram")).toEqual({
			text: "hello from telegram",
			images: [],
			imageCount: 0,
		});
	});

	it("joins text parts with newlines and collects images from array content", () => {
		const content: (TextContent | ImageContent)[] = [
			{ type: "text", text: "line one" },
			image,
			{ type: "text", text: "line two" },
		];
		expect(normalizeInjectedUserContent(content)).toEqual({
			text: "line one\nline two",
			images: [image],
			imageCount: 1,
		});
	});
	it("keeps image-only content as empty text with image count", () => {
		expect(normalizeInjectedUserContent([image])).toEqual({
			text: "",
			images: [image],
			imageCount: 1,
		});
	});

	it("joins multiple text parts and counts multiple images", () => {
		const secondImage: ImageContent = { type: "image", data: "BBBB", mimeType: "image/jpeg" };
		const content: (TextContent | ImageContent)[] = [
			{ type: "text", text: "line one" },
			image,
			{ type: "text", text: "line two" },
			secondImage,
		];

		expect(normalizeInjectedUserContent(content)).toEqual({
			text: "line one\nline two",
			images: [image, secondImage],
			imageCount: 2,
		});
	});
});

describe("injected optimistic signature counting", () => {
	it("increments and consumes with multiplicity, deleting the key at zero", () => {
		const { ctx, optimisticInjectedSignatures } = createContext();
		const sig = "dup\u00000";

		expect(consumeInjectedOptimisticSignature(ctx, sig)).toBe(false);

		incrementInjectedOptimisticSignature(ctx, sig);
		incrementInjectedOptimisticSignature(ctx, sig);
		incrementInjectedOptimisticSignature(ctx, sig);
		expect(optimisticInjectedSignatures.get(sig)).toBe(3);

		expect(consumeInjectedOptimisticSignature(ctx, sig)).toBe(true);
		expect(optimisticInjectedSignatures.get(sig)).toBe(2);
		expect(consumeInjectedOptimisticSignature(ctx, sig)).toBe(true);
		expect(optimisticInjectedSignatures.get(sig)).toBe(1);
		expect(consumeInjectedOptimisticSignature(ctx, sig)).toBe(true);
		expect(optimisticInjectedSignatures.has(sig)).toBe(false);
	});
});

describe("applyInjectedUserSubmission", () => {
	it("records history and renders optimistically for an idle injection", () => {
		const {
			ctx,
			addToHistory,
			setText,
			addMessageToChat,
			updatePendingMessagesDisplay,
			requestRender,
			optimisticInjectedSignatures,
		} = createContext();

		applyInjectedUserSubmission(ctx, { content: "idle telegram prompt", queued: false });

		expect(addToHistory).toHaveBeenCalledTimes(1);
		expect(addToHistory).toHaveBeenCalledWith("idle telegram prompt");
		// Idle injections record a pending injected optimistic signature in the counting
		// Map, leaving the single local slot untouched.
		expect(optimisticInjectedSignatures.get("idle telegram prompt\u00000")).toBe(1);
		expect(ctx.optimisticUserMessageSignature).toBeUndefined();
		expect(addMessageToChat).toHaveBeenCalledTimes(1);
		expect(addMessageToChat.mock.calls[0][0]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "idle telegram prompt" }],
			attribution: "user",
		});
		expect(requestRender).toHaveBeenCalled();
		// Idle injection must not clear the editor draft or touch the pending list.
		expect(setText).not.toHaveBeenCalled();
		expect(updatePendingMessagesDisplay).not.toHaveBeenCalled();
	});
	it("records image-only idle injection without clearing the editor", () => {
		const {
			ctx,
			addToHistory,
			setText,
			addMessageToChat,
			updatePendingMessagesDisplay,
			optimisticInjectedSignatures,
		} = createContext();

		applyInjectedUserSubmission(ctx, { content: [image], queued: false });

		expect(addToHistory).toHaveBeenCalledTimes(1);
		expect(addToHistory).toHaveBeenCalledWith("");
		// imageCount is 1, matching EventController's signature (event-controller.ts:288-292).
		expect(optimisticInjectedSignatures.get("\u00001")).toBe(1);
		expect(ctx.optimisticUserMessageSignature).toBeUndefined();
		expect(addMessageToChat).toHaveBeenCalledTimes(1);
		expect(addMessageToChat.mock.calls[0][0]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "" }, image],
			attribution: "user",
		});
		expect(setText).not.toHaveBeenCalled();
		expect(updatePendingMessagesDisplay).not.toHaveBeenCalled();
	});

	it("records history and refreshes pending display only for a busy/queued injection", () => {
		const {
			ctx,
			addToHistory,
			setText,
			addMessageToChat,
			updatePendingMessagesDisplay,
			requestRender,
			optimisticInjectedSignatures,
		} = createContext();

		applyInjectedUserSubmission(ctx, { content: "busy telegram prompt", queued: true });

		expect(addToHistory).toHaveBeenCalledTimes(1);
		expect(addToHistory).toHaveBeenCalledWith("busy telegram prompt");
		expect(updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalled();
		// Queued injection must not optimistically render, record a signature, or clear the editor.
		expect(addMessageToChat).not.toHaveBeenCalled();
		expect(optimisticInjectedSignatures.size).toBe(0);
		expect(ctx.optimisticUserMessageSignature).toBeUndefined();
		expect(setText).not.toHaveBeenCalled();
	});
});
