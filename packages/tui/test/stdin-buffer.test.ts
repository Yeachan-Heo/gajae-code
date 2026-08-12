/**
 * Tests for StdinBuffer
 *
 * Based on code from OpenTUI (https://github.com/anomalyco/opentui)
 * MIT License - Copyright (c) 2025 opentui
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { parseKey, setKittyProtocolActive } from "@gajae-code/tui/keys";
import { StdinBuffer } from "@gajae-code/tui/stdin-buffer";

describe("StdinBuffer", () => {
	let buffer: StdinBuffer;
	let emittedSequences: string[];

	beforeEach(() => {
		buffer = new StdinBuffer({ timeout: 10 });

		// Collect emitted sequences
		emittedSequences = [];
		buffer.on("data", (sequence: string) => {
			emittedSequences.push(sequence);
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// Helper to process data through the buffer
	function processInput(data: string | Buffer): void {
		buffer.process(data);
	}

	describe("Regular Characters", () => {
		it("should handle unicode characters", () => {
			processInput("hello \u4e16\u754c");
			expect(emittedSequences).toEqual(["h", "e", "l", "l", "o", " ", "\u4e16", "\u754c"]);
		});
		it("emits supplementary characters as complete code points", () => {
			processInput("\u{1f389}");
			expect(emittedSequences).toEqual(["\u{1f389}"]);
		});

		it("preserves ASCII, supplementary, and BMP character ordering", () => {
			processInput("a\u{1f389}\u4e16b");
			expect(emittedSequences).toEqual(["a", "\u{1f389}", "\u4e16", "b"]);
		});

		it("treats ESC plus a supplementary character as one Meta sequence", () => {
			processInput("\x1b\u{1f389}");
			expect(emittedSequences).toEqual(["\x1b\u{1f389}"]);
		});
		it("reassembles a Meta supplementary character split across string chunks", () => {
			processInput("\x1b\ud83c");
			expect(emittedSequences).toEqual([]);

			processInput("\udf89");
			expect(emittedSequences).toEqual(["\x1b\u{1f389}"]);
		});

		it("does not consume input following a malformed Meta high surrogate", () => {
			processInput("\x1b\ud83c");
			expect(emittedSequences).toEqual([]);

			processInput("x");
			expect(emittedSequences).toEqual(["\x1b\ud83c", "x"]);
		});

		it("reassembles a surrogate pair split across string chunks", () => {
			processInput("\ud83c");
			expect(emittedSequences).toEqual([]);

			processInput("\udf89");
			expect(emittedSequences).toEqual(["\u{1f389}"]);
		});
	});

	describe("Partial Escape Sequences", () => {
		it("should buffer incomplete mouse SGR sequence", () => {
			processInput("\x1b");
			expect(emittedSequences).toEqual([]);
			expect(buffer.getBuffer()).toBe("\x1b");

			processInput("[<35");
			expect(emittedSequences).toEqual([]);
			expect(buffer.getBuffer()).toBe("\x1b[<35");

			processInput(";20;5m");
			expect(emittedSequences).toEqual(["\x1b[<35;20;5m"]);
			expect(buffer.getBuffer()).toBe("");
		});

		it("should buffer incomplete CSI sequence", () => {
			processInput("\x1b[");
			expect(emittedSequences).toEqual([]);

			processInput("1;");
			expect(emittedSequences).toEqual([]);

			processInput("5H");
			expect(emittedSequences).toEqual(["\x1b[1;5H"]);
		});

		it("should buffer split across many chunks", () => {
			processInput("\x1b");
			processInput("[");
			processInput("<");
			processInput("3");
			processInput("5");
			processInput(";");
			processInput("2");
			processInput("0");
			processInput(";");
			processInput("5");
			processInput("m");

			expect(emittedSequences).toEqual(["\x1b[<35;20;5m"]);
		});

		it("should discard incomplete SGR mouse reports after timeout", async () => {
			processInput("\x1b[<35");
			expect(emittedSequences).toEqual([]);

			// Wait for timeout
			await Bun.sleep(15);

			expect(emittedSequences).toEqual([]);
		});

		it("quarantines delayed SGR suffix chunks and preserves trailing text", async () => {
			processInput("\x1b[<0;4");
			await Bun.sleep(15);
			processInput(";5Mtail");
			expect(emittedSequences).toEqual(["t", "a", "i", "l"]);
		});

		it("resynchronizes after a bounded SGR quarantine", async () => {
			processInput("\x1b[<0;");
			await Bun.sleep(15);
			processInput(`${"1".repeat(256)}tail`);
			expect(emittedSequences).toEqual(["t", "a", "i", "l"]);
		});

		it("resynchronizes immediately when the timed-out SGR suffix is already invalid", async () => {
			processInput("\x1b[<0;x");
			await Bun.sleep(15);
			expect(emittedSequences).toEqual(["x"]);
		});

		it("preserves ordinary input and bracketed paste after a malformed delayed SGR report", async () => {
			processInput("\x1b[<0;4");
			await Bun.sleep(15);
			processInput("xtext");
			expect(emittedSequences).toEqual(["x", "t", "e", "x", "t"]);

			const pasted: string[] = [];
			buffer.on("paste", text => pasted.push(text));
			emittedSequences = [];
			processInput("\x1b[<0;4");
			await Bun.sleep(15);
			processInput("\x1b[200~pasted\x1b[201~");
			expect(pasted).toEqual(["pasted"]);
		});
	});

	describe("Mixed Content", () => {
		it("should handle partial sequence with preceding characters", () => {
			processInput("abc\x1b[<35");
			expect(emittedSequences).toEqual(["a", "b", "c"]);
			expect(buffer.getBuffer()).toBe("\x1b[<35");

			processInput(";20;5m");
			expect(emittedSequences).toEqual(["a", "b", "c", "\x1b[<35;20;5m"]);
		});
	});

	describe("Kitty Keyboard Protocol", () => {
		it("should handle batched Kitty press and release", () => {
			// Press 'a', release 'a' batched together (common over SSH)
			processInput("\x1b[97u\x1b[97;1:3u");
			expect(emittedSequences).toEqual(["\x1b[97u", "\x1b[97;1:3u"]);
		});
		it("deduplicates raw supplementary characters after matching Kitty events", () => {
			processInput("\x1b[127881u\u{1f389}");
			expect(emittedSequences).toEqual(["\x1b[127881u"]);
		});
		it("continues to deduplicate matching BMP characters after Kitty events", () => {
			processInput("\x1b[97ua");
			expect(emittedSequences).toEqual(["\x1b[97u"]);
		});

		it("does not deduplicate a different supplementary character after a Kitty event", () => {
			processInput("\x1b[127881u\u{1f38a}");
			expect(emittedSequences).toEqual(["\x1b[127881u", "\u{1f38a}"]);
		});

		it("should handle multiple batched Kitty events", () => {
			// Press 'a', release 'a', press 'b', release 'b'
			processInput("\x1b[97u\x1b[97;1:3u\x1b[98u\x1b[98;1:3u");
			expect(emittedSequences).toEqual(["\x1b[97u", "\x1b[97;1:3u", "\x1b[98u", "\x1b[98;1:3u"]);
		});

		it("should handle Kitty functional keys with event type", () => {
			// Delete key release
			processInput("\x1b[3;1:3~");
			expect(emittedSequences).toEqual(["\x1b[3;1:3~"]);
		});

		it("should handle rapid typing simulation with Kitty protocol", () => {
			// Simulates typing "hi" quickly with releases interleaved
			processInput("\x1b[104u\x1b[104;1:3u\x1b[105u\x1b[105;1:3u");
			expect(emittedSequences).toEqual(["\x1b[104u", "\x1b[104;1:3u", "\x1b[105u", "\x1b[105;1:3u"]);
		});
	});
	describe("macOS Terminal.app Meta-wrapped shortcuts", () => {
		it("keeps Option arrow sequences together and parses them as Alt arrows", () => {
			setKittyProtocolActive(false);
			processInput("\x1b\x1b[A\x1b\x1b[B");
			expect(emittedSequences).toEqual(["\x1b\x1b[A", "\x1b\x1b[B"]);
			expect(emittedSequences.map(parseKey)).toEqual(["alt+up", "alt+down"]);
		});

		it("buffers a Meta-wrapped arrow split across chunks", () => {
			processInput("\x1b");
			processInput("\x1b");
			expect(emittedSequences).toEqual([]);

			processInput("[A");
			expect(emittedSequences).toEqual(["\x1b\x1b[A"]);
			expect(parseKey(emittedSequences[0]!)).toBe("alt+up");
		});
		it("keeps Option paging, function, delete, and shifted-arrow sequences atomic", () => {
			setKittyProtocolActive(false);
			processInput("\x1b\x1b[5~\x1b\x1bOP\x1b\x1b[3~\x1b\x1b[1;2A");
			expect(emittedSequences).toEqual(["\x1b\x1b[5~", "\x1b\x1bOP", "\x1b\x1b[3~", "\x1b\x1b[1;2A"]);
			expect(emittedSequences.map(parseKey)).toEqual(["alt+pageUp", "alt+f1", "alt+delete", "alt+shift+up"]);
		});
		it("keeps direct control-string prefixes atomic when split or adjacent", () => {
			const cases = [
				["\x1b[A", ["\x1b", "[A"]],
				["\x1b]0;title\x07", ["\x1b", "]0;title\x07"]],
				["\x1bP1\x1b\\", ["\x1b", "P1", "\x1b\\"]],
				["\x1b_Gf=24\x1b\\", ["\x1b", "_Gf=24", "\x1b\\"]],
				["\x1bOP", ["\x1b", "OP"]],
			] as const;

			for (const [expected, chunks] of cases) {
				buffer = new StdinBuffer({ timeout: 10 });
				emittedSequences = [];
				buffer.on("data", sequence => emittedSequences.push(sequence));
				for (const chunk of chunks) processInput(chunk);
				expect(emittedSequences).toEqual([expected]);
			}
		});
	});
	describe.each([
		{ chunks: ["\x1bi"], expected: ["\x1bi"], parsed: ["alt+i"] },
		{ chunks: ["\x1b", "i"], expected: ["\x1bi"], parsed: ["alt+i"] },
		{ chunks: ["\x1b[105;3u"], expected: ["\x1b[105;3u"], parsed: ["alt+i"] },
		{ chunks: ["\x1b[27;3;105~"], expected: ["\x1b[27;3;105~"], parsed: ["alt+i"] },
		{ chunks: ["\x1b[105;3:3u"], expected: ["\x1b[105;3:3u"], parsed: [undefined] },
	])("frames canonical key input", ({ chunks, expected, parsed }) => {
		it("emits each wire sequence exactly once", () => {
			setKittyProtocolActive(true);
			for (const chunk of chunks) processInput(chunk);
			expect(emittedSequences).toEqual([...expected]);
			expect(emittedSequences.map(parseKey)).toEqual([...parsed]);
			setKittyProtocolActive(false);
		});
	});

	it("emits bare Escape before a character that arrives after its timeout", async () => {
		buffer = new StdinBuffer({ timeout: 5 });
		emittedSequences = [];
		buffer.on("data", sequence => emittedSequences.push(sequence));

		processInput("\x1b");
		await Bun.sleep(10);
		processInput("i");

		expect(emittedSequences).toEqual(["\x1b", "i"]);
	});

	describe("Mouse Events", () => {
		it("should handle mouse press event", () => {
			processInput("\x1b[<0;10;5M");
			expect(emittedSequences).toEqual(["\x1b[<0;10;5M"]);
		});

		it("should handle mouse release event", () => {
			processInput("\x1b[<0;10;5m");
			expect(emittedSequences).toEqual(["\x1b[<0;10;5m"]);
		});

		it("should handle mouse move event", () => {
			processInput("\x1b[<35;20;5m");
			expect(emittedSequences).toEqual(["\x1b[<35;20;5m"]);
		});

		it("should handle split mouse events", () => {
			processInput("\x1b[<3");
			processInput("5;1");
			processInput("5;");
			processInput("10m");
			expect(emittedSequences).toEqual(["\x1b[<35;15;10m"]);
		});

		it("keeps trailing text after a malformed SGR report", () => {
			processInput("\x1b[<-1;4;5Mtail");
			expect(emittedSequences).toEqual(["t", "a", "i", "l"]);
		});

		it("should handle multiple mouse events", () => {
			processInput("\x1b[<35;1;1m\x1b[<35;2;2m\x1b[<35;3;3m");
			expect(emittedSequences).toEqual(["\x1b[<35;1;1m", "\x1b[<35;2;2m", "\x1b[<35;3;3m"]);
		});

		it("should handle old-style mouse sequence (ESC[M + 3 bytes)", () => {
			processInput("\x1b[M abc");
			expect(emittedSequences).toEqual(["\x1b[M ab", "c"]);
		});

		it("should buffer incomplete old-style mouse sequence", () => {
			processInput("\x1b[M");
			expect(buffer.getBuffer()).toBe("\x1b[M");

			processInput(" a");
			expect(buffer.getBuffer()).toBe("\x1b[M a");

			processInput("b");
			expect(emittedSequences).toEqual(["\x1b[M ab"]);
		});
	});

	describe("Edge Cases", () => {
		it("should handle empty input", () => {
			processInput("");
			// Empty string emits an empty data event
			expect(emittedSequences).toEqual([""]);
		});

		it("should handle lone escape character with timeout", async () => {
			processInput("\x1b");
			expect(emittedSequences).toEqual([]);

			// After timeout, should emit
			await Bun.sleep(15);
			expect(emittedSequences).toEqual(["\x1b"]);
		});

		it("should handle lone escape character with explicit flush", () => {
			processInput("\x1b");
			expect(emittedSequences).toEqual([]);

			const flushed = buffer.flush();
			expect(flushed).toEqual(["\x1b"]);
		});

		it("emits a coalesced double-Esc chunk as two Escape presses after the flush timeout", async () => {
			// tmux forwards a quick double-Esc as one "\x1b\x1b" chunk within
			// escape-time; emitting it as a single sequence parses as the unbound
			// "alt+escape" and swallows both presses (double-Esc draft clear).
			processInput("\x1b\x1b");
			expect(emittedSequences).toEqual([]);

			await Bun.sleep(15);
			expect(emittedSequences).toEqual(["\x1b", "\x1b"]);
		});

		it("emits two Esc presses split across chunks inside the flush window as two Escapes", async () => {
			processInput("\x1b");
			await Bun.sleep(5);
			processInput("\x1b");
			expect(emittedSequences).toEqual([]);

			await Bun.sleep(15);
			expect(emittedSequences).toEqual(["\x1b", "\x1b"]);
		});

		it("emits a triple-Esc chunk as three Escape presses", async () => {
			processInput("\x1b\x1b\x1b");

			await Bun.sleep(15);
			expect(emittedSequences).toEqual(["\x1b", "\x1b", "\x1b"]);
		});

		it("flushes a coalesced double-Esc explicitly as two Escapes", () => {
			processInput("\x1b\x1b");
			expect(buffer.flush()).toEqual(["\x1b", "\x1b"]);
		});

		it("keeps Option-as-Meta ESC ESC sequences atomic when the continuation is present", () => {
			// macOS Terminal "Use Option as Meta key": Option+Up arrives as ESC ESC [ A
			// in one write and must stay one sequence.
			processInput("\x1b\x1b[A");
			expect(emittedSequences).toEqual(["\x1b\x1b[A"]);
		});

		it("preserves a Meta-wrapped arrow after a preceding bare Escape", () => {
			// macOS Terminal can batch bare Escape then Option+Up as ESC ESC ESC [ A.
			// The bare Escape must not consume the Meta wrapper and turn this into
			// a destructive double-Escape gesture followed by plain Up.
			processInput("\x1b\x1b\x1b[A");
			expect(emittedSequences).toEqual(["\x1b", "\x1b\x1b[A"]);
			expect(emittedSequences.map(parseKey)).toEqual(["escape", "alt+up"]);
		});

		it("preserves a Meta-wrapped arrow when the chunk splits after the third Escape", () => {
			// Same ESC ESC ESC [ A bytes as above, but the read boundary falls after
			// the Escape run. Only the final two bytes stay buffered as the ambiguous
			// Meta candidate, so the continuation still forms the wrapper instead of a
			// plain Up after a destructive double-Escape gesture.
			vi.useFakeTimers();
			processInput("\x1b\x1b\x1b");
			expect(emittedSequences).toEqual(["\x1b"]);

			vi.advanceTimersByTime(9);
			processInput("[A");

			expect(emittedSequences).toEqual(["\x1b", "\x1b\x1b[A"]);
			expect(emittedSequences.map(parseKey)).toEqual(["escape", "alt+up"]);
		});

		it("emits three Escapes when the split continuation arrives after the flush boundary", () => {
			vi.useFakeTimers();
			processInput("\x1b\x1b\x1b");
			vi.advanceTimersByTime(10);
			processInput("[A");

			expect(emittedSequences).toEqual(["\x1b", "\x1b", "\x1b", "[", "A"]);
		});

		it("preserves a Meta-wrapped SS3 key after a preceding bare Escape", () => {
			processInput("\x1b\x1b\x1bOP");
			expect(emittedSequences).toEqual(["\x1b", "\x1b\x1bOP"]);
			expect(emittedSequences.map(parseKey)).toEqual(["escape", "alt+f1"]);
		});

		it("keeps a delayed Option continuation atomic when it arrives before the flush boundary", () => {
			vi.useFakeTimers();
			processInput("\x1b\x1b");
			vi.advanceTimersByTime(9);
			processInput("[A");

			expect(emittedSequences).toEqual(["\x1b\x1b[A"]);
		});

		it("emits separate Escapes when an Option continuation arrives after the flush boundary", () => {
			vi.useFakeTimers();
			processInput("\x1b\x1b");
			vi.advanceTimersByTime(10);
			processInput("[A");

			expect(emittedSequences).toEqual(["\x1b", "\x1b", "[", "A"]);
		});

		it("does not duplicate or lose Escapes across a cancellation cut and explicit flush", () => {
			processInput("\x1b\x1b\x1b\x1b[1;");
			expect(emittedSequences).toEqual(["\x1b", "\x1b"]);
			expect(buffer.flush()).toEqual(["\x1b\x1b[1;"]);
		});

		it("resolves an Escape run into individual presses when a bracketed paste follows", () => {
			// A paste start proves no Meta continuation is coming for the buffered
			// Escape run. Emitting the run as one sequence parses as the unbound
			// alt+escape and swallows every press.
			const pastes: string[] = [];
			buffer.on("paste", text => pastes.push(text));

			processInput("\x1b\x1b\x1b\x1b[200~hi\x1b[201~");

			expect(emittedSequences).toEqual(["\x1b", "\x1b", "\x1b"]);
			expect(emittedSequences.map(parseKey)).toEqual(["escape", "escape", "escape"]);
			expect(pastes).toEqual(["hi"]);
		});

		it("resolves an even Escape run before a bracketed paste", () => {
			const pastes: string[] = [];
			buffer.on("paste", text => pastes.push(text));

			processInput("\x1b\x1b\x1b\x1b\x1b[200~hi\x1b[201~");

			expect(emittedSequences).toEqual(["\x1b", "\x1b", "\x1b", "\x1b"]);
			expect(pastes).toEqual(["hi"]);
		});

		it("decodes an Escape run before a paste identically when the chunk splits", () => {
			const pastes: string[] = [];
			buffer.on("paste", text => pastes.push(text));

			processInput("\x1b\x1b\x1b");
			processInput("\x1b[200~hi\x1b[201~");

			expect(emittedSequences).toEqual(["\x1b", "\x1b", "\x1b"]);
			expect(pastes).toEqual(["hi"]);
		});

		it("decodes an Escape run before a paste identically byte by byte", () => {
			const pastes: string[] = [];
			buffer.on("paste", text => pastes.push(text));

			for (const byte of "\x1b\x1b\x1b\x1b[200~hi\x1b[201~") processInput(byte);

			expect(emittedSequences).toEqual(["\x1b", "\x1b", "\x1b"]);
			expect(pastes).toEqual(["hi"]);
		});

		it("decodes a long Escape run followed by a key", () => {
			// Measuring the run once keeps this linear; re-testing the whole suffix
			// while the cut advanced two bytes at a time took over a second here.
			const runLength = 50_000;
			processInput(`${"\x1b".repeat(runLength)}A`);

			expect(emittedSequences.length).toBe(runLength - 1);
			expect(emittedSequences.at(-1)).toBe("\x1b\x1bA");
			expect(emittedSequences.slice(0, -1).every(sequence => sequence === "\x1b")).toBe(true);
		});

		it("keeps only the ambiguous Meta candidate buffered across chunks", () => {
			// Retaining the whole run made every later read rescan it. Only the final
			// two bytes can still become a Meta prefix, so the rest settle immediately.
			for (let index = 0; index < 64; index++) processInput("\x1b");

			expect(emittedSequences).toEqual(Array(62).fill("\x1b"));
			expect(buffer.flush()).toEqual(["\x1b", "\x1b"]);
		});

		it("scales linearly over Escape-run length delivered byte by byte", () => {
			// The cross-chunk counterpart: rescanning the retained run on every read
			// cost 2.4s at 50k bytes before the buffered run was bounded.
			const decodePerByte = (runLength: number): number => {
				const probe = new StdinBuffer();
				probe.on("data", () => {});
				const started = Bun.nanoseconds();
				for (let index = 0; index < runLength; index++) probe.process("\x1b");
				return Bun.nanoseconds() - started;
			};
			decodePerByte(2_000);

			const small = decodePerByte(5_000);
			const large = decodePerByte(50_000);

			expect(large / Math.max(small, 1)).toBeLessThan(30);
		});

		it("scales linearly rather than quadratically over Escape-run length", () => {
			// Relative scaling, not an absolute wall-clock budget: a 10x longer run
			// costs ~10x when the run boundary is measured once, but ~100x when every
			// iteration rescans the remaining suffix.
			const decode = (runLength: number): number => {
				const probe = new StdinBuffer();
				const input = `${"\x1b".repeat(runLength)}A`;
				const started = Bun.nanoseconds();
				probe.process(input);
				return Bun.nanoseconds() - started;
			};
			decode(2_000);

			const small = decode(5_000);
			const large = decode(50_000);

			expect(large / Math.max(small, 1)).toBeLessThan(30);
		});

		it("still cuts an ESC-cancelled incomplete sequence without splitting it", async () => {
			// An incomplete alt-CSI prefix cancelled by a new ESC is not a pure
			// ESC run and must be emitted whole, exactly as before.
			processInput("\x1b\x1b[1;\x1b");

			await Bun.sleep(15);
			expect(emittedSequences).toEqual(["\x1b\x1b[1;", "\x1b"]);
		});

		it("should handle buffer input", () => {
			processInput(Buffer.from("\x1b[A"));
			expect(emittedSequences).toEqual(["\x1b[A"]);
		});

		it("should handle very long sequences", () => {
			const longSeq = `\x1b[${"1;".repeat(50)}H`;
			processInput(longSeq);
			expect(emittedSequences).toEqual([longSeq]);
		});
	});

	describe("Flush", () => {
		it("should discard incomplete SGR mouse reports on flush", () => {
			processInput("\x1b[<35");
			const flushed = buffer.flush();
			expect(flushed).toEqual([]);
			expect(buffer.getBuffer()).toBe("");
		});

		it("should return empty array if nothing to flush", () => {
			const flushed = buffer.flush();
			expect(flushed).toEqual([]);
		});
		it("returns a malformed trailing high surrogate on flush", () => {
			processInput("\ud83c");

			expect(buffer.flush()).toEqual(["\ud83c"]);
			expect(buffer.getBuffer()).toBe("");
		});

		it("should not emit incomplete SGR mouse reports via timeout", async () => {
			processInput("\x1b[<35");
			expect(emittedSequences).toEqual([]);

			// Wait for timeout to flush
			await Bun.sleep(15);

			expect(emittedSequences).toEqual([]);
		});
	});

	describe("Clear", () => {
		it("should clear buffered content without emitting", () => {
			processInput("\x1b[<35");
			expect(buffer.getBuffer()).toBe("\x1b[<35");

			buffer.clear();
			expect(buffer.getBuffer()).toBe("");
			expect(emittedSequences).toEqual([]);
		});
		it("drops a malformed trailing high surrogate on clear", () => {
			processInput("\ud83c");
			buffer.clear();

			processInput("\udf89");
			expect(emittedSequences).toEqual(["\udf89"]);
		});
	});

	describe("Bracketed Paste", () => {
		let emittedPaste: string[] = [];

		beforeEach(() => {
			buffer = new StdinBuffer({ timeout: 10 });

			// Collect emitted sequences
			emittedSequences = [];
			buffer.on("data", (sequence: string) => {
				emittedSequences.push(sequence);
			});

			// Collect paste events
			emittedPaste = [];
			buffer.on("paste", (data: string) => {
				emittedPaste.push(data);
			});
		});

		it("should emit paste event for complete bracketed paste", () => {
			const pasteStart = "\x1b[200~";
			const pasteEnd = "\x1b[201~";
			const content = "hello world";

			processInput(pasteStart + content + pasteEnd);

			expect(emittedPaste).toEqual(["hello world"]);
			expect(emittedSequences).toEqual([]); // No data events during paste
		});

		it("should handle paste arriving in chunks", () => {
			processInput("\x1b[200~");
			expect(emittedPaste).toEqual([]);

			processInput("hello ");
			expect(emittedPaste).toEqual([]);

			processInput("world\x1b[201~");
			expect(emittedPaste).toEqual(["hello world"]);
			expect(emittedSequences).toEqual([]);
		});

		it("should handle paste with input before and after", () => {
			processInput("a");
			processInput("\x1b[200~pasted\x1b[201~");
			processInput("b");

			expect(emittedSequences).toEqual(["a", "b"]);
			expect(emittedPaste).toEqual(["pasted"]);
		});

		it("emits incomplete input before a bracketed paste marker instead of dropping it", () => {
			processInput("\x1b[<35\x1b[200~pasted\x1b[201~");

			expect(emittedSequences).toEqual(["\x1b[<35"]);
			expect(emittedPaste).toEqual(["pasted"]);
			expect(buffer.getBuffer()).toBe("");
		});

		it("should handle paste with newlines", () => {
			processInput("\x1b[200~line1\nline2\nline3\x1b[201~");

			expect(emittedPaste).toEqual(["line1\nline2\nline3"]);
			expect(emittedSequences).toEqual([]);
		});

		it("should handle paste with unicode", () => {
			processInput("\x1b[200~Hello \u4e16\u754c \u{1f389}\x1b[201~");

			expect(emittedPaste).toEqual(["Hello \u4e16\u754c \u{1f389}"]);
			expect(emittedSequences).toEqual([]);
		});
	});

	describe("Destroy", () => {
		it("should clear buffer on destroy", () => {
			processInput("\x1b[<35");
			expect(buffer.getBuffer()).toBe("\x1b[<35");

			buffer.destroy();
			expect(buffer.getBuffer()).toBe("");
		});

		it("should clear pending timeouts on destroy", async () => {
			processInput("\x1b[<35");
			buffer.destroy();

			// Wait longer than timeout
			await Bun.sleep(15);

			// Should not have emitted anything
			expect(emittedSequences).toEqual([]);
		});
	});

	describe("UTF-8 multi-byte decoding (issue #454)", () => {
		let emittedPaste: string[];

		beforeEach(() => {
			buffer = new StdinBuffer({ timeout: 10 });
			emittedSequences = [];
			buffer.on("data", (sequence: string) => {
				emittedSequences.push(sequence);
			});
			emittedPaste = [];
			buffer.on("paste", (data: string) => {
				emittedPaste.push(data);
			});
		});

		it("reassembles a Korean syllable split across Buffer chunks", () => {
			const source = "화면 기록";
			const bytes = Buffer.from(source, "utf8");
			// Split inside the first 3-byte syllable (after 2 of 3 bytes).
			processInput(bytes.subarray(0, 2));
			expect(emittedSequences).toEqual([]); // decoder holds the partial prefix

			processInput(bytes.subarray(2));
			expect(emittedSequences.join("")).toBe(source);
			expect(emittedSequences.join("")).not.toContain("\uFFFD");
		});

		it("reassembles a Korean syllable when the completing chunk is one byte", () => {
			const bytes = Buffer.from("화", "utf8");
			processInput(bytes.subarray(0, 2));
			expect(emittedSequences).toEqual([]);

			processInput(bytes.subarray(2, 3));
			expect(emittedSequences.join("")).toBe("화");
			expect(emittedSequences.join("")).not.toContain("\uFFFD");
		});

		it("reassembles a Korean syllable when the leading chunk is one byte", () => {
			const bytes = Buffer.from("화", "utf8");
			processInput(bytes.subarray(0, 1));
			expect(emittedSequences).toEqual([]);

			processInput(bytes.subarray(1));
			expect(emittedSequences.join("")).toBe("화");
			expect(emittedSequences.join("")).not.toContain("\uFFFD");
		});

		it("reassembles a bracketed Korean paste split mid-syllable and mid-marker", () => {
			const content = "화면 기록";
			const full = Buffer.from(`\x1b[200~${content}\x1b[201~`, "utf8");
			// Split inside the Korean content and again inside the end marker.
			const markerStart = Buffer.byteLength("\x1b[200~", "utf8");
			processInput(full.subarray(0, markerStart + 2)); // mid first syllable
			processInput(full.subarray(markerStart + 2, full.length - 3)); // mid end marker
			processInput(full.subarray(full.length - 3));

			expect(emittedPaste).toEqual([content]);
			expect(emittedPaste.join("")).not.toContain("\uFFFD");
			expect(emittedSequences).toEqual([]); // no data events during paste
		});

		it("reassembles a large multi-line Korean paste chunked at awkward byte offsets", () => {
			const content = Array.from({ length: 40 }, (_, i) => `src/화면/기록-${i}.ts`).join("\n");
			const full = Buffer.from(`\x1b[200~${content}\x1b[201~`, "utf8");
			// Feed in fixed 5-byte chunks so most boundaries split a multi-byte char.
			for (let i = 0; i < full.length; i += 5) {
				processInput(full.subarray(i, i + 5));
			}
			expect(emittedPaste).toEqual([content]);
			expect(emittedPaste.join("")).not.toContain("\uFFFD");
		});

		it("reassembles mixed ASCII, Korean, and emoji split inside multi-byte chars", () => {
			const source = "a화b\u{1f389}c";
			const bytes = Buffer.from(source, "utf8");
			// Split inside the 3-byte Korean syllable and inside the 4-byte emoji.
			const koreanStart = 1; // after "a"
			const emojiStart = koreanStart + 3 + 1; // after Korean + "b"
			processInput(bytes.subarray(0, koreanStart + 2));
			processInput(bytes.subarray(koreanStart + 2, emojiStart + 2));
			processInput(bytes.subarray(emojiStart + 2));

			expect(emittedSequences.join("")).toBe(source);
			expect(emittedSequences.join("")).not.toContain("\uFFFD");
		});

		it("does not emit or corrupt a trailing incomplete sequence on flush", () => {
			const bytes = Buffer.from("화", "utf8");
			processInput(bytes.subarray(0, 2));
			expect(emittedSequences).toEqual([]);

			// Normal flush must not finalize the decoder: held bytes stay held.
			expect(buffer.flush()).toEqual([]);
			expect(emittedSequences).toEqual([]);

			// The completing bytes (remainder grouped with following text, as a
			// real terminal delivers them) still produce the full character.
			processInput(Buffer.concat([bytes.subarray(2), Buffer.from("x", "utf8")]));
			expect(emittedSequences.join("")).toBe("화x");
			expect(emittedSequences.join("")).not.toContain("\uFFFD");
		});

		it("resets decoder state on clear() so a stale prefix cannot complete", () => {
			const bytes = Buffer.from("화", "utf8");
			processInput(bytes.subarray(0, 2));
			buffer.clear();

			processInput(bytes.subarray(2));
			expect(emittedSequences.join("")).not.toBe("화");
		});

		it("resets decoder state on destroy() so a stale prefix cannot complete", () => {
			const bytes = Buffer.from("화", "utf8");
			processInput(bytes.subarray(0, 2));
			buffer.destroy();

			processInput(bytes.subarray(2));
			expect(emittedSequences.join("")).not.toBe("화");
		});

		it("preserves pending single-byte UTF-8 lead as meta before ASCII input", () => {
			processInput(Buffer.from([0xe1]));
			expect(emittedSequences).toEqual([]);

			processInput(Buffer.from("x"));
			expect(emittedSequences).toEqual(["\x1ba", "x"]);
			expect(emittedSequences.join("")).not.toContain("\uFFFD");
		});

		it("preserves pending single-byte UTF-8 lead as meta before control input", () => {
			processInput(Buffer.from([0xe1]));
			expect(emittedSequences).toEqual([]);

			processInput(Buffer.from("\x1b[A"));
			expect(emittedSequences).toEqual(["\x1ba", "\x1b[A"]);
			expect(emittedSequences.join("")).not.toContain("\uFFFD");
		});

		it("preserves legacy invalid single-high-byte meta conversion (ESC + byte-128)", () => {
			// Invalid UTF-8 high bytes are read as Alt/meta, not fed to the
			// decoder. 0xC1 (193) -> ESC + char(65) = ESC + "A".
			processInput(Buffer.from([0xc1]));
			expect(emittedSequences).toEqual(["\x1bA"]);
			expect(emittedSequences.join("")).not.toContain("\uFFFD");
		});
	});
	describe("Probe Reply Fragments", () => {
		const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

		it("holds an incomplete probe-reply prefix instead of flushing its fragments", async () => {
			processInput("\x1b[?62");
			await sleep(60);

			// Still held: flushing would type "ESC [ ? 6 2" into the editor.
			expect(emittedSequences).toEqual([]);

			processInput(";22;52c");
			expect(emittedSequences).toEqual(["\x1b[?62;22;52c"]);
		});

		it("restarts the hold clock while the fragment keeps growing", async () => {
			// Regression: the hold start stamp was recorded once and never refreshed,
			// so every later fragment of a long reply stream expired the hold instantly
			// and leaked character by character.
			for (const part of ["\x1b]11;", "rgb:0000", "/0000", "/0000"]) {
				processInput(part);
				await sleep(30);
			}
			expect(emittedSequences).toEqual([]);

			processInput("\x07");
			expect(emittedSequences).toEqual(["\x1b]11;rgb:0000/0000/0000\x07"]);
		});

		it("gives up on a stalled probe fragment instead of swallowing later input", async () => {
			processInput("\x1b[?62");
			await sleep(700);
			processInput("a");

			expect(emittedSequences).toEqual(["\x1b[?62", "a"]);
		});

		it("cuts an unterminated sequence at the ESC that starts the next one", () => {
			processInput("\x1b[?62\x1b[A");
			expect(emittedSequences).toEqual(["\x1b[?62", "\x1b[A"]);
		});

		it("keeps an OSC string terminator attached to its sequence", () => {
			processInput("\x1b]11;rgb:0000/0000/0000\x1b\\");
			expect(emittedSequences).toEqual(["\x1b]11;rgb:0000/0000/0000\x1b\\"]);
		});
	});
});
