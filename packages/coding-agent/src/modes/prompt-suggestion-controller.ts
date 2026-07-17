import { logger } from "@gajae-code/utils";
import { generatePromptSuggestion } from "../utils/prompt-suggestion";
import type { InteractiveModeContext } from "./types";

/**
 * Owns the ghost-text next-prompt prediction lifecycle for interactive mode.
 *
 * After each agent turn ends (and only when `promptSuggestions` is enabled
 * and the composer is empty), a smol-model prediction of the user's next
 * prompt is generated in the background. The result renders as dim ghost
 * text in the empty composer via the autocomplete provider's inline hint;
 * Tab accepts it, typing dismisses it, and a new turn clears it.
 */
export class PromptSuggestionController {
	#ctx: InteractiveModeContext;
	#current: string | null = null;
	/** Monotonic token; bumping it invalidates any in-flight generation. */
	#generation = 0;

	constructor(ctx: InteractiveModeContext) {
		this.#ctx = ctx;
	}

	/** Current suggestion to render as ghost text, or null. */
	get current(): string | null {
		return this.#current;
	}

	/** Drop the current suggestion and invalidate any in-flight generation. */
	clear(): void {
		this.#generation++;
		if (this.#current === null) return;
		this.#current = null;
		this.#ctx.ui.requestRender();
	}

	/** A new agent turn started; any pending suggestion is stale. */
	onAgentStart(): void {
		this.clear();
	}

	/**
	 * Editor content changed. A non-empty composer means the user is writing
	 * their own prompt: dismiss the suggestion and cancel pending generation.
	 */
	notifyEditorChanged(text: string): void {
		if (text.length > 0) this.clear();
	}

	/**
	 * Agent turn ended; kick off background generation when the feature is
	 * enabled and the composer is idle and empty.
	 */
	onAgentEnd(): void {
		if (!this.#ctx.settings.get("promptSuggestions")) return;
		if (this.#ctx.shutdownRequested) return;
		if (this.#ctx.session.isStreaming) return;
		if (this.#ctx.editor.getText().trim() !== "") return;

		const generation = ++this.#generation;
		void generatePromptSuggestion(
			this.#ctx.session.messages,
			this.#ctx.session.modelRegistry,
			this.#ctx.settings,
			this.#ctx.session.sessionId,
			this.#ctx.session.model,
			provider => this.#ctx.session.agent.metadataForProvider(provider),
		)
			.then(suggestion => {
				if (generation !== this.#generation) return;
				if (!suggestion) return;
				// The world may have moved on while the model was thinking.
				if (this.#ctx.session.isStreaming) return;
				if (this.#ctx.editor.getText().trim() !== "") return;
				this.#current = suggestion;
				this.#ctx.ui.requestRender();
			})
			.catch(error => {
				logger.debug("prompt-suggestion: generation failed", { error: String(error) });
			});
	}

	/**
	 * Tab handler for the composer: accept the suggestion when the composer
	 * is empty. Returns true when Tab was consumed.
	 */
	tryAcceptOnTab(text: string): boolean {
		const suggestion = this.#current;
		if (!suggestion || text.trim() !== "") return false;
		// setText fires onChange with non-empty text, which clears #current.
		this.#ctx.editor.setText(suggestion);
		this.clear();
		this.#ctx.ui.requestRender();
		return true;
	}
}
