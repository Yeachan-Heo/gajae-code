import type { ImageContent, TextContent } from "@gajae-code/ai/core";
import type { InteractiveModeContext } from "../types";

/**
 * Normalize the content passed to an extension `sendUserMessage` call into a
 * plain text string plus its image attachments. Mirrors the normalization in
 * `AgentSession.sendUserMessage` (text parts joined with "\n") so the resulting
 * text matches the eventual user `message_start` payload.
 */
/**
 * Validate extension `sendUserMessage` content at the owning interactive
 * boundary, before session delivery and UI bookkeeping. Returns a typed
 * `invalid_input` Error when the content container or any array element is
 * absent/null/malformed — exactly the shapes that would make
 * `normalizeInjectedUserContent`'s `for-of` dereference (`part.type`) throw an
 * untyped TypeError synchronously before the caller's `send.catch` is attached
 * (unhandled rejection → resident crash).
 */
export function extensionUserMessageContentError(content: string | (TextContent | ImageContent)[]): Error | undefined {
	if (typeof content === "string") {
		if (content.trim().length === 0)
			return Object.assign(new Error("Prompt must not be empty."), { code: "invalid_input" });
		return undefined;
	}
	if (!Array.isArray(content)) {
		return Object.assign(new Error("sendUserMessage requires string or content-array content."), {
			code: "invalid_input",
		});
	}
	for (const part of content) {
		if (part === null || typeof part !== "object") {
			return Object.assign(new Error("sendUserMessage content array contains a null or non-object part."), {
				code: "invalid_input",
			});
		}
	}
	const text = content
		.filter((part): part is TextContent => part.type === "text")
		.map(part => part.text)
		.join("\n");
	const hasUsableImage = content.some(
		(part): part is ImageContent =>
			part.type === "image" && typeof part.data === "string" && part.data.trim().length > 0,
	);
	if (text.trim().length === 0 && !hasUsableImage)
		return Object.assign(new Error("Prompt must not be empty."), { code: "invalid_input" });
	return undefined;
}
export function normalizeInjectedUserContent(content: string | (TextContent | ImageContent)[]): {
	text: string;
	images: ImageContent[];
	imageCount: number;
} {
	if (typeof content === "string") {
		return { text: content, images: [], imageCount: 0 };
	}
	const textParts: string[] = [];
	const images: ImageContent[] = [];
	for (const part of content) {
		if (part.type === "text") textParts.push(part.text);
		else images.push(part);
	}
	const text = textParts.join("\n");
	return { text, images, imageCount: images.length };
}

/**
 * Record a remotely/programmatically injected user message (e.g. Telegram
 * inbound routed through the extension API) into the interactive TUI, so it is
 * captured in prompt history and shown immediately instead of only appearing
 * once the eventual `message_start` event lands.
 *
 * Local TUI submissions never reach this path (they go through
 * `session.prompt(...)` / `startPendingSubmission`), so this cannot double-add
 * local prompt history.
 *
 * - Always adds the injected text to editor prompt history.
 * - Idle injections optimistically render the user message and record a pending
 *   injected optimistic signature (a counting Map, so multiple idle injections
 *   before the first `message_start` do not clobber each other); the later user
 *   `message_start` consumes one count and skips both the duplicate chat add and
 *   the defensive editor clear (so a locally typed draft is preserved).
 * - Busy/queued injections refresh the pending-message display, which the
 *   caller has already populated by invoking `session.sendUserMessage(...)`
 *   before this helper.
 *
 * This helper never clears the editor text.
 */
export function applyInjectedUserSubmission(
	ctx: InteractiveModeContext,
	input: { content: string | (TextContent | ImageContent)[]; queued: boolean },
): void {
	const { text, images, imageCount } = normalizeInjectedUserContent(input.content);
	ctx.editor.addToHistory(text);

	if (input.queued) {
		ctx.updatePendingMessagesDisplay();
		ctx.ui.requestRender();
		return;
	}

	incrementInjectedOptimisticSignature(ctx, `${text}\u0000${imageCount}`);
	ctx.addMessageToChat({
		role: "user",
		content: [{ type: "text", text }, ...images],
		attribution: "user",
		timestamp: Date.now(),
	});
	ctx.ui.requestRender();
}

/**
 * Record one pending optimistic render for an injected user message.
 *
 * Injected sends are fire-and-forget and multiple idle injections can be
 * rendered before the first `message_start` arrives, so a counting Map (not a
 * single slot) tracks how many optimistic renders are outstanding per signature.
 */
export function incrementInjectedOptimisticSignature(ctx: InteractiveModeContext, signature: string): void {
	ctx.optimisticInjectedSignatures.set(signature, (ctx.optimisticInjectedSignatures.get(signature) ?? 0) + 1);
}

/**
 * Consume one pending injected optimistic render for `signature`. Decrements the
 * count (deleting the key at zero) and returns whether one was outstanding.
 */
export function consumeInjectedOptimisticSignature(ctx: InteractiveModeContext, signature: string): boolean {
	const count = ctx.optimisticInjectedSignatures.get(signature) ?? 0;
	if (count <= 0) return false;
	if (count === 1) ctx.optimisticInjectedSignatures.delete(signature);
	else ctx.optimisticInjectedSignatures.set(signature, count - 1);
	return true;
}
