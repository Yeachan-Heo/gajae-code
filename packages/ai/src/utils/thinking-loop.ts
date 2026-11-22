/**
 * Thinking-loop guard for Gemini reasoning-summary header runaway.
 *
 * Gemini models (notably `gemini-3.5-flash` via OpenRouter) occasionally fall
 * into a degenerate reasoning loop: they re-emit the same paragraph intent over
 * and over with cosmetic wording drift ("Confirming Safety", "Verifying
 * Completion", …), burning the entire output budget without ever calling a tool
 * or answering.
 *
 * This detector tracks consecutive Gemini reasoning-summary headers (markdown
 * headings or bold lines) and signals when the count reaches the threshold,
 * allowing the caller to interrupt the stream with a reminder to issue a tool call.
 * Paragraph lines between titles do NOT reset the run; leaving the reasoning
 * channel does via {@link GeminiHeaderRunDetector.reset}.
 */

/**
 * Error code when Gemini header runaway detector fires and aborts the stream.
 * Classified as terminal in retry policy to prevent replay of the same context.
 */
export const GEMINI_HEADER_RUNAWAY_ERROR_CODE = "gemini_header_runaway";

/**
 * Consecutive Gemini thought-summary headers in one uninterrupted reasoning
 * stream that trips the tool-call reminder. Gemini occasionally narrates a long
 * chain of titled summaries ("Examining Result Handling", "Refining Result
 * Rendering", …) without ever calling a tool, burning the whole budget on
 * planning.
 *
 * Set well above legitimate hard-problem depth: a capable model can emit ~10
 * distinct, progressing hypotheses in a single reasoning block before acting (and
 * a false trip is costly — the interrupt discards the whole reasoning turn). A
 * real narration runaway burns dozens-to-hundreds of titles, so this still trips
 * fast on the actual pathology.
 */
export const GEMINI_HEADER_RUNAWAY_THRESHOLD = 64;

/**
 * True when a model is a Gemini model (either direct Google API or via proxy like
 * Bizrouter, GitHub Copilot, etc.). Checks model ID for Gemini branding. Used to
 * gate reasoning-header runaway detection to Gemini only, not all reasoning models.
 */
export function isGeminiModel(modelId: string): boolean {
	return /gemini/i.test(modelId);
}

/**
 * True when a single trimmed line is a Gemini reasoning-summary title: a markdown
 * ATX heading (`## …`) or a whole-line bold / bold-italic run (`**Title**`,
 * `***Title***`). Inline emphasis inside prose never matches — the bold run must
 * span the entire line.
 */
export function isReasoningSummaryHeader(line: string): boolean {
	return /^#{1,6}[ \t]+\S/.test(line) || /^\*{2,3}.+\*{2,3}$/.test(line);
}

/**
 * Counts consecutive Gemini reasoning-summary headers across a streamed thinking
 * block. {@link push} returns true exactly once — when the running header count
 * first reaches {@link GEMINI_HEADER_RUNAWAY_THRESHOLD} — and the caller then
 * interrupts the stream and reminds the model to issue a tool call. Paragraph
 * lines between titles do NOT reset the run (Gemini emits header + paragraph per
 * thought, so the run IS the number of summaries); leaving the reasoning channel
 * does, via {@link reset} on a new thinking block / prose / tool call.
 */
/**
 * Error thrown when Gemini header runaway detector fires.
 * Carries the error code for classification in the retry policy.
 */
export class GeminiHeaderRunawayError extends Error {
	readonly errorCode = GEMINI_HEADER_RUNAWAY_ERROR_CODE;
	readonly count: number;

	constructor(message: string, count: number) {
		super(message);
		this.name = "GeminiHeaderRunawayError";
		this.count = count;
	}
}

export class GeminiHeaderRunDetector {
	/** Thinking text not yet split into completed lines. */
	#pending = "";
	/** Summary-title lines seen in the current run. */
	#count = 0;
	/** Latches after the first threshold hit so each run fires at most once. */
	#fired = false;

	/** Feed a thinking delta. Returns true the first time the run hits the threshold. */
	push(delta: string): boolean {
		if (this.#fired || !delta) return false;
		this.#pending += delta;
		let nl = this.#pending.indexOf("\n");
		while (nl !== -1) {
			const line = this.#pending.slice(0, nl).trim();
			this.#pending = this.#pending.slice(nl + 1);
			if (line !== "" && isReasoningSummaryHeader(line) && ++this.#count >= GEMINI_HEADER_RUNAWAY_THRESHOLD) {
				this.#fired = true;
				return true;
			}
			nl = this.#pending.indexOf("\n");
		}
		return false;
	}

	/** Number of summary titles counted in the current run (for the reminder/log). */
	get count(): number {
		return this.#count;
	}

	/** Re-arm for a fresh reasoning block: clears the buffer, count, and latch. */
	reset(): void {
		this.#pending = "";
		this.#count = 0;
		this.#fired = false;
	}
}
