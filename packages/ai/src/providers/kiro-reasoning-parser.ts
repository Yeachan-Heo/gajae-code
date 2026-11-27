/**
 * Shared parser for Kiro native reasoning events (reasoningContentEvent).
 * Used by both kiro-codewhisperer.ts (OAuth) and kiro-api-key.ts (API key).
 *
 * Manages the lifecycle of a single active thinking block per reasoning event stream:
 * - Creates a new block when reasoning begins
 * - Closes exactly once when transitioning to text/tool
 * - Reopens for subsequent reasoning runs
 */
import type { AssistantMessage, ThinkingContent } from "../types";
import type { AssistantMessageEventStream } from "../utils/event-stream";

type Block = { type: string; index?: number };

/** Native reasoning request fields Kiro forwards to the model. */
export type KiroAdditionalModelRequestFields =
	| { thinking: { type: "adaptive"; display: "summarized" }; output_config: { effort: string } }
	| { reasoning: { effort: string } };

/** Wire shape Kiro expects on assistantResponseMessage.reasoningContent. */
export type KiroReasoningContent = { signature: string } | { redactedContent: string };

const SIGNATURE_TAG = "kiro:signature:";
const REDACTED_TAG = "kiro:redactedContent:";

/** Tag a native reasoning signature/redactedContent for storage on a thinking block. */
export function encodeKiroThinkingSignature(ev: { signature?: string; redactedContent?: string }): string | undefined {
	if (ev.signature) return `${SIGNATURE_TAG}${ev.signature}`;
	if (ev.redactedContent) return `${REDACTED_TAG}${ev.redactedContent}`;
	return undefined;
}

/**
 * Decode the Kiro reasoning payload to replay for one assistant turn: the last
 * thinking block carrying a nonempty Kiro tag wins; other providers' signatures
 * and unknown tags are ignored.
 */
export function kiroReasoningContentForReplay(content: string | readonly unknown[]): KiroReasoningContent | undefined {
	if (typeof content === "string") return undefined;
	let result: KiroReasoningContent | undefined;
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const thinking = block as Partial<ThinkingContent>;
		if (thinking.type !== "thinking" || !thinking.thinkingSignature) continue;
		const sig = thinking.thinkingSignature;
		if (sig.startsWith(SIGNATURE_TAG) && sig.length > SIGNATURE_TAG.length) {
			result = { signature: sig.slice(SIGNATURE_TAG.length) };
		} else if (sig.startsWith(REDACTED_TAG) && sig.length > REDACTED_TAG.length) {
			result = { redactedContent: sig.slice(REDACTED_TAG.length) };
		}
	}
	return result;
}

interface ReasoningContentEventPayload {
	text?: string;
	signature?: string;
	redactedContent?: string;
}

export interface ReasoningBlockState {
	activeThinkingIndex: number | undefined;
}

export function createReasoningBlockState(): ReasoningBlockState {
	return { activeThinkingIndex: undefined };
}

/**
 * Parse a reasoningContentEvent and emit thinking-related stream events.
 * Creates or reuses the current thinking block; emits thinking_start on first event.
 * The block is closed when a text or tool event arrives (via closeReasoningBlock).
 */
export function parseReasoningContentEventHelper(
	ev: ReasoningContentEventPayload,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: ReasoningBlockState,
): void {
	// Validate inputs
	if (ev.text !== undefined && typeof ev.text !== "string") {
		throw new Error("Kiro reasoning text must be a string");
	}
	if (ev.signature !== undefined && typeof ev.signature !== "string") {
		throw new Error("Kiro reasoning signature must be a string");
	}
	if (ev.redactedContent !== undefined && typeof ev.redactedContent !== "string") {
		throw new Error("Kiro reasoning redactedContent must be a string");
	}

	if (!ev.text && !ev.signature && !ev.redactedContent) {
		return; // Nothing to process
	}

	// Get or create the active thinking block
	let thinkingIndex = state.activeThinkingIndex;
	if (thinkingIndex === undefined) {
		// No active block: create a new one
		thinkingIndex = blocks.length;
		const thinkingBlock: ThinkingContent & { index: number } = {
			type: "thinking",
			thinking: "",
			index: thinkingIndex,
		};
		blocks.push(thinkingBlock);
		state.activeThinkingIndex = thinkingIndex;
		stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
	}

	const block = blocks[thinkingIndex] as ThinkingContent;

	// Append text content
	if (typeof ev.text === "string" && ev.text) {
		block.thinking += ev.text;
		stream.push({
			type: "thinking_delta",
			contentIndex: thinkingIndex,
			delta: ev.text,
			partial: output,
		});
	}

	const signature = encodeKiroThinkingSignature(ev);
	if (signature) block.thinkingSignature = signature;
}

/**
 * Close the active reasoning block by emitting thinking_end.
 * Called exactly once when a text or tool event arrives.
 * Subsequent reasoning events will start a new block.
 */
export function closeReasoningBlock(
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: ReasoningBlockState,
): void {
	const thinkingIndex = state.activeThinkingIndex;
	if (thinkingIndex !== undefined && thinkingIndex < blocks.length) {
		const block = blocks[thinkingIndex];
		if (block.type === "thinking") {
			stream.push({
				type: "thinking_end",
				contentIndex: thinkingIndex,
				content: (block as ThinkingContent).thinking,
				partial: output,
			});
		}
	}
	// Clear the active block so the next reasoning event starts fresh
	state.activeThinkingIndex = undefined;
}
