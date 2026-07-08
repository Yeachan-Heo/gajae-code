import type { ImageContent, TextContent } from "@gajae-code/ai";
import type { InteractiveModeContext } from "../types";

/**
 * Normalize the content passed to an extension `sendUserMessage` call into a
 * plain text string plus its image attachments. Mirrors the normalization in
 * `AgentSession.sendUserMessage` (text parts joined with "\n") so the resulting
 * text matches the eventual user `message_start` payload.
 */
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
 * - Idle injections optimistically render the user message and set
 *   `optimisticUserMessageSignature`; the later user `message_start` recognizes
 *   the signature and skips both the duplicate chat add and the defensive
 *   editor clear (so a locally typed draft is preserved).
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

	ctx.optimisticUserMessageSignature = `${text}\u0000${imageCount}`;
	ctx.addMessageToChat({
		role: "user",
		content: [{ type: "text", text }, ...images],
		attribution: "user",
		timestamp: Date.now(),
	});
	ctx.ui.requestRender();
}
