import { describe, expect, test } from "bun:test";
import { createDesktopStreamRedactor } from "../src/stream-redactor";

const MARKER = "[redacted]";
const FAILURE = "Desktop stream redaction failed; output was withheld.";
const identity = (text: string): string => text;

function expectWholeSurrogates(text: string): void {
	for (let index = 0; index < text.length; index++) {
		const unit = text.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = text.charCodeAt(++index);
			expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
		} else {
			expect(unit < 0xdc00 || unit > 0xdfff).toBe(true);
		}
	}
}

function expectChunks(secrets: readonly string[], chunks: readonly string[], expected: string): void {
	const stream = createDesktopStreamRedactor(secrets, identity);
	let output = "";
	for (const chunk of chunks) {
		const piece = stream.push(chunk);
		expectWholeSurrogates(piece);
		output += piece;
		// Exact-prefix checking catches even a matched tail leaked on a later push.
		expect(expected.startsWith(output)).toBe(true);
	}
	const final = stream.finish();
	expectWholeSurrogates(final);
	output += final;
	expect(output).toBe(expected);
	for (const secret of secrets) {
		if (secret) expect(output).not.toContain(secret);
	}
}

function expectEverySplit(secrets: readonly string[], source: string, expected: string): void {
	for (let split = 0; split <= source.length; split++) {
		expectChunks(secrets, [source.slice(0, split), source.slice(split)], expected);
	}
	// split("") deliberately includes pushes between UTF-16 surrogate halves.
	expectChunks(secrets, source.split(""), expected);
}

describe("desktop host streaming secret redactor", () => {
	test("masks a known key at every split, including one-character pushes and repeated occurrences", () => {
		expectEverySplit(
			["private-token"],
			"start:private-token:middle:private-token:end",
			`start:${MARKER}:middle:${MARKER}:end`,
		);
	});

	test("matches multiline keys without treating newlines as release boundaries", () => {
		const key = "-----BEGIN KEY-----\nsecret-line\r\nlast-line\n-----END KEY-----";
		expectEverySplit([key], `header\n${key}\nfooter`, `header\n${MARKER}\nfooter`);
		expectChunks(["abc\ndef"], ["abc\n", "d", "e", "f", "\nvisible"], `${MARKER}\nvisible`);
	});

	test("unions overlapping matches, self-overlap and prefix keys instead of exposing their tails", () => {
		expectEverySplit(["abc", "cdef", "defg"], "left:abcdefg:right", `left:${MARKER}:right`);
		expectEverySplit(["abc", "abcdef", "bcdefg"], "abcdefg!", `${MARKER}!`);
		expectEverySplit(["aba"], "abababa!", `${MARKER}!`);
		expectEverySplit(["abc", "b", "cde"], "abcde!", `${MARKER}!`);
	});

	test("masks several distinct keys while preserving intervening inert text", () => {
		const keys = ["first-key", "second\nkey", "third-key"];
		const source = "<script>first-key</script> second\nkey & third-key / first-key";
		const expected = `<script>${MARKER}</script> ${MARKER} & ${MARKER} / ${MARKER}`;
		expectEverySplit(keys, source, expected);
	});

	test("keeps a single marker across adjacent secrets and arbitrarily many masked releases", () => {
		const stream = createDesktopStreamRedactor(["abcdefgh"], identity);
		expect(stream.push("abcdefgh")).toBe(MARKER);
		for (const character of "ijklmno") expect(stream.push(character)).toBe("");
		expect(stream.push("p")).toBe("i");
		expect(stream.finish()).toBe("jklmnop");
		expectEverySplit(["abc", "xyz"], "abcxyzabc:xyz", `${MARKER}:${MARKER}`);
	});

	test("carries retained masks into new overlapping matches on subsequent pushes", () => {
		const stream = createDesktopStreamRedactor(["abcd", "defg"], identity);
		expect(stream.push("abcd")).toBe(MARKER);
		expect(stream.push("e")).toBe("");
		expect(stream.push("f")).toBe("");
		expect(stream.push("g")).toBe("");
		expect(stream.push("!")).toBe("");
		expect(stream.finish()).toBe("!");
	});

	test("preserves Unicode pairs in secrets and visible context at every UTF-16 boundary", () => {
		expectEverySplit(["🔐private\n🔑"], "😀before🔐private\n🔑after👩‍💻", `😀before${MARKER}after👩‍💻`);
		expectEverySplit(["xyz"], "A😀B👩‍💻C", "A😀B👩‍💻C");
		expectChunks([], ["A", "\ud83d", "", "\ude00", "B"], "A😀B");
	});

	test("masks both halves when a known secret itself is one surrogate unit", () => {
		const high = "\ud83d";
		const low = "\ude00";
		expectEverySplit([high], "left😀right", `left${MARKER}right`);
		expectEverySplit([low], "left😀right", `left${MARKER}right`);
	});

	test("ignores empty keys and snapshots the supplied known-secret array", () => {
		expectChunks(["", "", "token", "token"], ["to", "ken", "!"], `${MARKER}!`);
		const keys = ["original-key"];
		const stream = createDesktopStreamRedactor(keys, identity);
		keys[0] = "late-key";
		keys.push("newly-learned-key");
		const output = stream.push("original-key late-key newly-learned-key") + stream.finish();
		expect(output).toBe(`${MARKER} late-key newly-learned-key`);
		expect(output).not.toContain("original-key");
	});

	test("finishes empty input, flushes incomplete nonmatches, and masks matches completed at finish", () => {
		expectChunks([], [], "");
		expectChunks(["token"], ["", "", ""], "");
		expectChunks(["token"], ["tok"], "tok");
		expectChunks(["token"], ["token"], MARKER);
		const stream = createDesktopStreamRedactor([], identity);
		expect(stream.finish()).toBe("");
		expect(() => stream.push("must-not-escape")).toThrow(FAILURE);
		expect(() => stream.finish()).toThrow(FAILURE);
	});

	test("keeps pending overlap bounded while releasing long streams before finish", () => {
		const secret = `secret:${"k".repeat(90)}`;
		const stream = createDesktopStreamRedactor([secret], identity);
		let received = "";
		let emitted = "";
		for (let index = 0; index < 200; index++) {
			const chunk = index % 2 ? "😀plain-text" : "visible-text";
			received += chunk;
			emitted += stream.push(chunk);
			expect(received.startsWith(emitted)).toBe(true);
			expect(received.length - emitted.length).toBeGreaterThanOrEqual(Math.min(received.length, secret.length - 1));
			expect(received.length - emitted.length).toBeLessThanOrEqual(secret.length);
			expectWholeSurrogates(emitted);
		}
		expect(emitted.length).toBeGreaterThan(1_000);
		expect(emitted + stream.finish()).toBe(received);
	});

	test("supports the maximum secret size with bounded overlap and rejects larger keys", () => {
		const key = "q".repeat(65_536);
		expectChunks([key], [key.slice(0, -1), key.slice(-1), "!"], `${MARKER}!`);
		expect(() => createDesktopStreamRedactor([`${key}q`], identity)).toThrow(FAILURE);
	});

	test("applies the host whole-text redactor only after known-key masking, including finish", () => {
		const calls: string[] = [];
		const stream = createDesktopStreamRedactor(["secret"], text => {
			calls.push(text);
			expect(text).not.toContain("secret");
			return text.toUpperCase();
		});
		const output = stream.push("secret") + stream.push(" public") + stream.finish();
		expect(calls.join("")).toBe(`${MARKER} public`);
		expect(output).toBe("[REDACTED] PUBLIC");
	});

	test("fails closed on invalid construction inputs without reporting their contents", () => {
		for (const invalid of [null, undefined, "private-token", {}, ["ok", 42], [null], Array(1)]) {
			expect(() => createDesktopStreamRedactor(invalid as unknown as readonly string[], identity)).toThrow(FAILURE);
		}
		for (const invalid of [null, undefined, "not-a-function", {}]) {
			expect(() => createDesktopStreamRedactor([], invalid as unknown as (text: string) => string)).toThrow(FAILURE);
		}
	});

	test("invalid push input permanently withholds pending content", () => {
		for (const invalid of [null, undefined, 42, {}, ["private-token"]]) {
			const stream = createDesktopStreamRedactor(["private-token"], identity);
			expect(stream.push("private-")).toBe("");
			expect(() => stream.push(invalid as unknown as string)).toThrow(FAILURE);
			expect(() => stream.push("token")).toThrow(FAILURE);
			expect(() => stream.finish()).toThrow(FAILURE);
		}
	});

	test("throws a content-free error and permanently fails when the whole-text callback throws", () => {
		const stream = createDesktopStreamRedactor(["private-token"], () => {
			throw new Error("private-token must never appear in the public error");
		});
		expect(() => stream.push("private-token")).toThrow(FAILURE);
		expect(() => stream.push("visible")).toThrow(FAILURE);
		expect(() => stream.finish()).toThrow(FAILURE);
	});

	test("a finish-time callback failure cannot return the pending tail", () => {
		const stream = createDesktopStreamRedactor(["private-token"], () => {
			throw new Error("callback failed");
		});
		expect(stream.push("private-")).toBe("");
		expect(() => stream.finish()).toThrow(FAILURE);
		expect(() => stream.push("token")).toThrow(FAILURE);
	});

	test("non-string whole-text callback results poison the stream instead of falling back", () => {
		for (const invalid of [undefined, null, 42, {}, Promise.resolve("unsafe")]) {
			const callback = (() => invalid) as unknown as (text: string) => string;
			const stream = createDesktopStreamRedactor(["secret"], callback);
			expect(() => stream.push("secret")).toThrow(FAILURE);
			expect(() => stream.finish()).toThrow(FAILURE);
		}
	});

	test("rejects reentrancy even when the callback catches the nested failure", () => {
		let reenter: () => void = () => {};
		const stream = createDesktopStreamRedactor([], text => {
			try {
				reenter();
			} catch {
				/* Outer emission must still fail closed. */
			}
			return text;
		});
		reenter = () => {
			stream.push("nested-content");
		};
		expect(() => stream.push("outer-content")).toThrow(FAILURE);
		expect(() => stream.finish()).toThrow(FAILURE);
	});
});
