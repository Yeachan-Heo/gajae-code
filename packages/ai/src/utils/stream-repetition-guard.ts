/**
 * Runaway-repetition detector for a model's streamed text or thinking channel.
 *
 * Some models fall into a decode loop and emit the same sentence — or the same
 * short token run — until the turn's budget runs out. Nothing errors: the tool
 * calls in the same message still execute, and the transcript just fills with
 * dozens of identical lines (#5624).
 *
 * This is a pure state machine with no provider knowledge: `feed()` takes a
 * chunk of streamed text and returns the prefix that is safe to emit. Until it
 * trips, that prefix is the chunk itself, so a healthy stream passes through
 * byte for byte. Once it trips, it emits nothing further and {@link takeTrip}
 * hands the caller a one-shot signal to abort the request.
 *
 * Use one instance per stream **per channel**. Interleaving the visible-text
 * and reasoning channels through a single instance would splice unrelated
 * tokens into the same window and manufacture patterns that were never
 * streamed.
 */

/** Consecutive repeats of one unit that trip the guard. */
export const DEFAULT_REPETITION_THRESHOLD = 12;

/**
 * Largest accepted repetition threshold.
 *
 * Token retention is `MAX_NGRAM_TOKENS * (threshold + 1)`, so capping the
 * threshold is what makes the guard's memory bounded: at this cap it retains
 * at most 64 * 129 = 8256 tokens, against 832 at the default. That is roughly
 * ten times the default's headroom — generous for a caller who genuinely wants
 * a laxer guard — while keeping a hostile or buggy option from turning the
 * detector into an unbounded buffer (#5627 review r6).
 */
export const MAX_REPETITION_THRESHOLD = 128;

/**
 * `errorCode` stamped on a turn this guard stopped. A bounded classifier, never
 * raw model text — consumers branch on it to tell a local decode-loop stop from
 * a client cancellation or a transport fault (#5627).
 */
export const REPETITION_GUARD_ERROR_CODE = "repetition_guard_tripped";

/**
 * Wire-safe `errorMessage` for a turn this guard stopped. A literal with zero
 * interpolation — not the sample, not the channel, not the repeat count.
 *
 * The auth gateway forwards `errorMessage` to API clients on the streaming path
 * (`redactGatewayMessage` only strips credential-shaped text), so anything
 * interpolated here is raw model output published verbatim. It also reaches
 * `classifyGatewayError`, which keyword-matches on message text, so a repeated
 * `quota` or `forbidden` in a sample could pick the HTTP status (#5627 r5).
 *
 * The repeated unit is not logged either: the provider logs bounded metadata
 * only, because the default log transport persists metadata verbatim to a
 * rotating file on disk (#5627 review r6). {@link StreamRepetitionTrip.sample}
 * stays in memory for callers that want it.
 */
export const REPETITION_GUARD_STOP_MESSAGE = "Stopped the turn: the model produced runaway repeated output.";

/**
 * Shortest n-gram window compared when the repeats carry no newline to split
 * on. Requiring eight tokens keeps ordinary repetition — a run of zeroes in a
 * matrix, a ruler of dashes — from reading as a decode loop.
 */
const MIN_NGRAM_TOKENS = 8;

/**
 * Longest n-gram window compared. A unit of `u` tokens is caught at the first
 * multiple of `u` at or above {@link MIN_NGRAM_TOKENS}, so this covers every
 * repeating unit up to 57 tokens long.
 */
const MAX_NGRAM_TOKENS = 64;

/** Longest sample retained for the human-readable diagnostic. */
const MAX_SAMPLE_CHARS = 120;

export type RepetitionUnitKind = "line" | "ngram";

export interface StreamRepetitionTrip {
	/** Whether the repeats were whole lines or an n-gram inside one line. */
	readonly kind: RepetitionUnitKind;
	/** Consecutive repeats observed when the guard tripped. */
	readonly repeats: number;
	/** Normalized, truncated sample of the repeated unit, for diagnostics. */
	readonly sample: string;
}

export interface StreamRepetitionGuardOptions {
	/**
	 * Consecutive repeats that trip the guard. Defaults to 12. Normalized by
	 * {@link normalizeThreshold} — non-finite values fall back to the default,
	 * fractional values are floored, and the result is clamped into
	 * `[2, MAX_REPETITION_THRESHOLD]`.
	 */
	readonly threshold?: number;
}

function isWhitespace(ch: string): boolean {
	return ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\f" || ch === "\v";
}

/** Trim and collapse internal whitespace so re-wrapped repeats still compare equal. */
function normalize(unit: string): string {
	return unit.trim().replace(/\s+/g, " ");
}

function sampleOf(unit: string): string {
	return unit.length <= MAX_SAMPLE_CHARS ? unit : `${unit.slice(0, MAX_SAMPLE_CHARS - 1)}…`;
}

/**
 * Coerce a caller-supplied threshold into an integer the guard can actually
 * reach, and that bounds its state.
 *
 * `repetitionGuard` is public on `SimpleStreamOptions`, so this value arrives
 * from outside the package and is only typed `number` (#5627 review r6). The
 * previous `Math.max(2, value)` admitted three broken inputs:
 *
 *   - `NaN` — `Math.max(2, NaN)` is `NaN`, and every comparison against `NaN`
 *     is false, so the guard silently never tripped: detection off, no error.
 *   - `Infinity` / a huge finite value — the threshold is unreachable *and*
 *     `#maxTrackedTokens` becomes effectively unbounded, so `#tokens` grows
 *     for the whole stream while detection can never fire.
 *   - a fraction like `2.5` — an integer repeat counter never equals it, so
 *     the effective threshold silently becomes the next integer up.
 *
 * Normalizes rather than throws. This runs on the streaming hot path, and
 * turning a bad caller option into a failed request is worse than running the
 * guard at its documented default.
 */
function normalizeThreshold(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_REPETITION_THRESHOLD;
	// Floor before clamping so the counter can hit the threshold exactly.
	return Math.min(MAX_REPETITION_THRESHOLD, Math.max(2, Math.floor(value)));
}

export class StreamRepetitionGuard {
	readonly #threshold: number;
	/** Tokens are only ever inspected from the tail, so older ones can be dropped. */
	readonly #maxTrackedTokens: number;

	#line = "";
	#lastLine = "";
	#lineRepeats = 0;
	#tokens: string[] = [];
	#token = "";
	#trip: StreamRepetitionTrip | undefined;
	#tripTaken = false;
	#finalized = false;

	constructor(options?: StreamRepetitionGuardOptions) {
		this.#threshold = normalizeThreshold(options?.threshold);
		// Derived from the *normalized* threshold, never the raw option, so the
		// capacity is finite by construction and provably at most
		// `MAX_NGRAM_TOKENS * (MAX_REPETITION_THRESHOLD + 1)` for every input.
		this.#maxTrackedTokens = MAX_NGRAM_TOKENS * (this.#threshold + 1);
	}

	/**
	 * The threshold actually in force — the caller's option after
	 * {@link normalizeThreshold}, which may differ from what was passed.
	 */
	get threshold(): number {
		return this.#threshold;
	}

	get tripped(): boolean {
		return this.#trip !== undefined;
	}

	get trip(): StreamRepetitionTrip | undefined {
		return this.#trip;
	}

	/**
	 * Returns the trip exactly once, then `undefined` forever. Callers drive a
	 * one-shot side effect (aborting the request) off this, so the once-only
	 * latch lives here rather than being re-implemented at each call site.
	 */
	takeTrip(): StreamRepetitionTrip | undefined {
		if (!this.#trip || this.#tripTaken) return undefined;
		this.#tripTaken = true;
		return this.#trip;
	}

	/**
	 * Feed a chunk of streamed text. Returns the portion safe to emit: the whole
	 * chunk while healthy, the prefix up to the repeat that tripped the guard on
	 * the chunk that trips it, and nothing at all after that.
	 */
	feed(text: string): string {
		if (this.#trip || text.length === 0) return "";
		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			if (isWhitespace(ch)) {
				this.#closeToken();
				if (ch === "\n") {
					this.#closeLine();
				} else {
					this.#line += ch;
				}
			} else {
				this.#line += ch;
				this.#token += ch;
			}
			// Cut after the character that completed the offending repeat, so the
			// caller still renders a bounded `threshold` copies and no more.
			if (this.#trip) return text.slice(0, i + 1);
		}
		return text;
	}

	/**
	 * Close the in-progress unit at end of stream and run detection once more.
	 *
	 * `feed()` only closes a token on whitespace and a line on `\n`, so a stream
	 * whose final repeat arrives without a trailing newline left the last copy
	 * uncounted and the turn read as a healthy completion (#5627 review r5).
	 *
	 * Emits nothing — everything `feed()` returned has already been rendered by
	 * the time this runs. A trip found here therefore classifies the turn while
	 * the last copy is already on screen; that is intended. Idempotent.
	 */
	finalize(): void {
		if (this.#finalized || this.#trip) return;
		this.#finalized = true;
		// Token first: the trailing partial must enter `#tokens` so the n-gram
		// scan sees it before the line comparison closes the buffer.
		this.#closeToken();
		this.#closeLine();
	}

	#closeLine(): void {
		const line = normalize(this.#line);
		this.#line = "";
		// Blank lines separate repeats in some transcripts; they must not reset
		// the run, and an all-blank stretch must not read as a repeat of itself.
		if (line.length === 0) return;
		if (line === this.#lastLine) {
			this.#lineRepeats += 1;
			if (this.#lineRepeats >= this.#threshold) {
				this.#trip = { kind: "line", repeats: this.#lineRepeats, sample: sampleOf(line) };
			}
			return;
		}
		this.#lastLine = line;
		this.#lineRepeats = 1;
	}

	#closeToken(): void {
		if (this.#token.length === 0) return;
		this.#tokens.push(this.#token);
		this.#token = "";
		if (this.#tokens.length > this.#maxTrackedTokens) {
			this.#tokens = this.#tokens.slice(-MAX_NGRAM_TOKENS * this.#threshold);
		}
		this.#detectNgramLoop();
	}

	/**
	 * Looks for a tail made of `threshold` back-to-back copies of the same
	 * window. Scanning every window size from {@link MIN_NGRAM_TOKENS} up means
	 * any repeating unit is caught at some multiple of its own length, so the
	 * unit length itself never has to be guessed.
	 */
	#detectNgramLoop(): void {
		const total = this.#tokens.length;
		const maxWindow = Math.min(MAX_NGRAM_TOKENS, Math.floor(total / this.#threshold));
		for (let window = MIN_NGRAM_TOKENS; window <= maxWindow; window++) {
			let matched = true;
			for (let copy = 1; copy < this.#threshold && matched; copy++) {
				const start = total - window * (copy + 1);
				for (let k = 0; k < window; k++) {
					if (this.#tokens[start + k] !== this.#tokens[start + window + k]) {
						matched = false;
						break;
					}
				}
			}
			if (matched) {
				this.#trip = {
					kind: "ngram",
					repeats: this.#threshold,
					sample: sampleOf(this.#tokens.slice(total - window).join(" ")),
				};
				return;
			}
		}
	}
}
