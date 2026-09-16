import { describe, expect, it } from "bun:test";
import { DEFAULT_REPETITION_THRESHOLD, StreamRepetitionGuard } from "../src/utils/stream-repetition-guard";

/** Feed `text` through the guard in fixed-size chunks and collect what it emits. */
function feedInChunks(guard: StreamRepetitionGuard, text: string, size: number): string {
	let out = "";
	for (let i = 0; i < text.length; i += size) out += guard.feed(text.slice(i, i + size));
	return out;
}

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe("StreamRepetitionGuard", () => {
	const SENTENCE = "0.0.1 버전으로 배포 완료되었습니다";

	describe("pass-through", () => {
		it("returns a healthy chunk byte for byte", () => {
			const guard = new StreamRepetitionGuard();
			const chunk = "Let me check the deployed version before answering.\n";
			expect(guard.feed(chunk)).toBe(chunk);
			expect(guard.tripped).toBe(false);
		});

		it("reassembles a healthy stream byte for byte across chunk boundaries", () => {
			const guard = new StreamRepetitionGuard();
			const text = Array.from({ length: 60 }, (_, i) => `Step ${i}: checking file ${i}.ts\n`).join("");
			expect(feedInChunks(guard, text, 7)).toBe(text);
			expect(guard.tripped).toBe(false);
		});

		it("ignores an empty chunk", () => {
			const guard = new StreamRepetitionGuard();
			expect(guard.feed("")).toBe("");
			expect(guard.tripped).toBe(false);
		});
	});

	describe("repeated lines", () => {
		it("trips at the threshold and bounds what it emits", () => {
			const guard = new StreamRepetitionGuard();
			const emitted = feedInChunks(guard, `${SENTENCE}\n`.repeat(100), 11);

			expect(guard.tripped).toBe(true);
			expect(countOccurrences(emitted, SENTENCE)).toBeLessThanOrEqual(DEFAULT_REPETITION_THRESHOLD);
			expect(guard.trip?.kind).toBe("line");
			expect(guard.trip?.repeats).toBe(DEFAULT_REPETITION_THRESHOLD);
			expect(guard.trip?.sample).toBe(SENTENCE);
		});

		it("emits nothing at all once tripped", () => {
			const guard = new StreamRepetitionGuard();
			feedInChunks(guard, `${SENTENCE}\n`.repeat(100), 11);
			expect(guard.feed("a completely different sentence\n")).toBe("");
		});

		it("still matches when repeats differ only in surrounding whitespace", () => {
			const guard = new StreamRepetitionGuard();
			feedInChunks(guard, `  ${SENTENCE}   \n`.repeat(40), 5);
			expect(guard.tripped).toBe(true);
		});

		it("does not let blank separator lines reset the run", () => {
			const guard = new StreamRepetitionGuard();
			guard.feed(`${SENTENCE}\n\n`.repeat(40));
			expect(guard.tripped).toBe(true);
		});

		it("does not trip on a run of blank lines", () => {
			const guard = new StreamRepetitionGuard();
			guard.feed("\n".repeat(200));
			expect(guard.tripped).toBe(false);
		});

		it("resets the run when a different line interrupts it", () => {
			const guard = new StreamRepetitionGuard();
			for (let i = 0; i < 20; i++) guard.feed(`${SENTENCE}\n${SENTENCE}\nsomething else ${i}\n`);
			expect(guard.tripped).toBe(false);
		});

		it("honours a custom threshold", () => {
			const guard = new StreamRepetitionGuard({ threshold: 3 });
			const emitted = guard.feed(`${SENTENCE}\n`.repeat(50));
			expect(guard.tripped).toBe(true);
			expect(countOccurrences(emitted, SENTENCE)).toBeLessThanOrEqual(3);
		});
	});

	describe("repeated n-grams with no newline", () => {
		// The reporter's second symptom: `0.0.1 <|tool_call_end|>` ~60x, all on one line.
		it("trips on a short unit repeated with no line breaks", () => {
			const guard = new StreamRepetitionGuard();
			const emitted = feedInChunks(guard, "0.0.1 done ".repeat(200), 9);

			expect(guard.tripped).toBe(true);
			expect(guard.trip?.kind).toBe("ngram");
			expect(countOccurrences(emitted, "0.0.1 done")).toBeLessThan(200);
		});

		it("trips on a unit whose length does not divide the minimum window", () => {
			// Three tokens per unit, so no 8-token window aligns with it; the guard
			// has to find the repeat at a multiple of the unit length instead.
			const guard = new StreamRepetitionGuard();
			feedInChunks(guard, "alpha beta gamma ".repeat(200), 13);
			expect(guard.tripped).toBe(true);
			expect(guard.trip?.kind).toBe("ngram");
		});

		it("does not trip on a short repeated run below the minimum window", () => {
			const guard = new StreamRepetitionGuard();
			const text = `${"ok ".repeat(6)}and now something entirely different follows here.`;
			expect(guard.feed(text)).toBe(text);
			expect(guard.tripped).toBe(false);
		});

		it("does not trip on prose that reuses a common phrase", () => {
			const guard = new StreamRepetitionGuard();
			const text = Array.from({ length: 80 }, (_, i) => `I will now check the value of counter ${i}. `).join("");
			expect(feedInChunks(guard, text, 17)).toBe(text);
			expect(guard.tripped).toBe(false);
		});
	});

	describe("takeTrip", () => {
		it("yields the trip exactly once so the caller aborts only once", () => {
			const guard = new StreamRepetitionGuard();
			feedInChunks(guard, `${SENTENCE}\n`.repeat(100), 11);

			expect(guard.takeTrip()).toMatchObject({ kind: "line" });
			expect(guard.takeTrip()).toBeUndefined();
			// Further input after the trip must not re-arm it.
			guard.feed(`${SENTENCE}\n`.repeat(100));
			expect(guard.takeTrip()).toBeUndefined();
		});

		it("yields nothing while the stream is healthy", () => {
			const guard = new StreamRepetitionGuard();
			guard.feed("all good here\n");
			expect(guard.takeTrip()).toBeUndefined();
		});
	});
	// `feed()` closes a line only on `\n` and a token only on whitespace, so the
	// final copy of a runaway stream that ends mid-unit was never counted and the
	// turn read as healthy. `finalize()` closes the in-progress unit (#5627 r5).
	describe("finalize", () => {
		it("trips on a final line that never got its newline", () => {
			const guard = new StreamRepetitionGuard();
			for (let i = 0; i < DEFAULT_REPETITION_THRESHOLD - 1; i++) guard.feed(`${SENTENCE}\n`);
			// The threshold-completing copy arrives unterminated.
			guard.feed(SENTENCE);

			expect(guard.tripped).toBe(false);
			guard.finalize();
			expect(guard.tripped).toBe(true);
			expect(guard.trip).toMatchObject({ kind: "line" });
		});

		it("trips on a final n-gram token with no trailing whitespace", () => {
			const guard = new StreamRepetitionGuard();
			// An 8-token unit is the shortest n-gram window the detector compares,
			// and 8 x 12 = 96 tokens is the first count at which it can fire. Feed
			// 95 closed tokens, so the 96th is the one still open in the buffer.
			const unit = "a1 a2 a3 a4 a5 a6 a7 a8 ";
			// No newlines anywhere, so only the n-gram detector can catch this.
			for (let i = 0; i < DEFAULT_REPETITION_THRESHOLD - 1; i++) guard.feed(unit);
			// Last copy arrives without its trailing space: `a8` never closes.
			guard.feed(unit.trimEnd());

			expect(guard.tripped).toBe(false);
			guard.finalize();
			expect(guard.tripped).toBe(true);
			expect(guard.trip).toMatchObject({ kind: "ngram" });
		});

		it("is idempotent and still yields exactly one trip", () => {
			const guard = new StreamRepetitionGuard();
			for (let i = 0; i < DEFAULT_REPETITION_THRESHOLD - 1; i++) guard.feed(`${SENTENCE}\n`);
			guard.feed(SENTENCE);

			guard.finalize();
			guard.finalize();
			guard.finalize();

			expect(guard.takeTrip()).toMatchObject({ kind: "line" });
			expect(guard.takeTrip()).toBeUndefined();
		});

		it("does not trip a healthy stream", () => {
			const guard = new StreamRepetitionGuard();
			guard.feed("Step 1: checking a.ts\nStep 2: checking b.ts\nStep 3: done");

			guard.finalize();

			expect(guard.tripped).toBe(false);
			expect(guard.takeTrip()).toBeUndefined();
		});

		it("emits nothing", () => {
			const guard = new StreamRepetitionGuard();
			guard.feed("trailing text with no newline");
			// `finalize()` returns void: everything feed() returned is already
			// rendered by the time it runs.
			expect(guard.finalize()).toBeUndefined();
		});
	});
});
