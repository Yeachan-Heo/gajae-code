import { logger } from "@gajae-code/utils";
import { generatePromptSuggestion } from "../utils/prompt-suggestion";
import type { InteractiveModeContext } from "./types";

/** Codex cancels a suggestion request that has not finished within 30 seconds. */
export const PROMPT_SUGGESTION_TIMEOUT_MS = 30_000;

/**
 * Owns the next-prompt suggestion lifecycle for interactive mode, mirroring the
 * Codex TUI prompt suggestions (openai/codex#47929).
 *
 * After a turn completes normally (and only when `promptSuggestions` is enabled,
 * nothing is queued, and no side chat is open), an ephemeral turn on the session's
 * own model predicts the user's next message. The suggestion lives outside the
 * draft: it renders as dim ghost text only while the composer is empty, no turn
 * runs, and no autocomplete popup is open; Tab accepts it only in that state.
 * Escape, a submission, a new turn, a session switch, or the 30-second deadline
 * cancels it. A newer request always supersedes an older one, so a late result
 * can never capture input.
 */
export class PromptSuggestionController {
	#ctx: InteractiveModeContext;
	#current: string | null = null;
	#pending: AbortController | null = null;

	constructor(ctx: InteractiveModeContext) {
		this.#ctx = ctx;
	}

	/** Current suggestion text, or null while pending or absent (regardless of visibility). */
	get current(): string | null {
		return this.#current;
	}

	/**
	 * The suggestion only while it can be shown: no task running and no
	 * autocomplete popup (Codex `visible_prompt_suggestion`). Ghost rendering and
	 * Tab acceptance both go through this so Tab never inserts hidden text.
	 */
	get visible(): string | null {
		if (this.#current === null) return null;
		if (this.#ctx.session.isStreaming || this.#ctx.editor.isShowingAutocomplete()) return null;
		return this.#current;
	}

	/** True while a suggestion is pending or available. */
	get active(): boolean {
		return this.#pending !== null || this.#current !== null;
	}

	/** Cancel any pending request and drop the current suggestion. */
	clear(): void {
		const pending = this.#pending;
		this.#pending = null;
		pending?.abort();
		if (this.#current === null) return;
		this.#current = null;
		this.#ctx.ui.requestRender();
	}

	/** A new agent turn started; any suggestion is stale. */
	onAgentStart(): void {
		this.clear();
	}

	/**
	 * Escape handler. Consumes the key and cancels the suggestion when one is
	 * pending or available; returns false otherwise. While a turn is streaming the
	 * stale suggestion is dropped but Esc falls through to interrupt the turn; with
	 * a draft in the composer it is dropped and Esc falls through to the draft-clear
	 * gesture, so a hidden suggestion never costs an extra keypress.
	 */
	tryCancelOnEscape(): boolean {
		if (!this.active) return false;
		this.clear();
		return !this.#ctx.session.isStreaming && this.#ctx.editor.getText() === "";
	}

	/**
	 * Agent run ended. Request a suggestion only after a run that positively
	 * reports `completed` and whose final assistant message neither failed nor was
	 * aborted. Error terminals can omit `stopReason`, so undefined is not success.
	 */
	onAgentEnd(stopReason?: string): void {
		this.clear();
		if (!this.#ctx.settings.get("promptSuggestions")) return;
		if (stopReason !== "completed") return;
		if (this.#ctx.shutdownRequested) return;
		const session = this.#ctx.session;
		if (session.isStreaming) return;
		const lastAssistant = session.getLastAssistantMessage();
		if (!lastAssistant || lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted") return;
		if (session.getQueuedMessageEntries().length > 0 || this.#ctx.compactionQueuedMessages.length > 0) return;
		if (this.#ctx.hasActiveBtw()) return;

		const pending = new AbortController();
		this.#pending = pending;
		// The deadline retires this request immediately, whether or not the provider settles.
		const timer = setTimeout(() => {
			if (this.#pending === pending) this.#pending = null;
			pending.abort();
		}, PROMPT_SUGGESTION_TIMEOUT_MS);
		timer.unref?.();
		void generatePromptSuggestion(session, pending.signal)
			.then(text => {
				if (this.#pending !== pending) return;
				this.#pending = null;
				if (pending.signal.aborted || !text) return;
				this.#current = text;
				this.#ctx.ui.requestRender();
			})
			.catch(error => {
				if (this.#pending === pending) this.#pending = null;
				if (!pending.signal.aborted) {
					logger.debug("prompt-suggestion: generation failed", { error: String(error) });
				}
			})
			.finally(() => clearTimeout(timer));
	}

	/**
	 * Tab handler for the composer: accept the suggestion when the composer is
	 * empty. Returns true when Tab was consumed.
	 */
	tryAcceptOnTab(text: string): boolean {
		const suggestion = this.visible;
		if (!suggestion || text !== "") return false;
		this.clear();
		this.#ctx.editor.setText(suggestion);
		return true;
	}
}
