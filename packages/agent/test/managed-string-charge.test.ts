import { describe, expect, it, vi } from "bun:test";
import { managedSnapshotJsonByteLength } from "../src/agent-loop";

const serializedBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

describe("managed snapshot string charge", () => {
	it("charges every string shape exactly what JSON.stringify emits", () => {
		// Every ASCII character, so each JSON escape and both edges of each escape range.
		const ascii = Array.from({ length: 0x80 }, (_, code) => String.fromCharCode(code));
		const pieces = [
			"plain ascii",
			"",
			"\r\n",
			"\b\f",
			"é",
			"한글 낱말",
			"日本語",
			"\u2028\u2029",
			"\uffff",
			"😀",
			"\u{10ffff}",
			"\ud800",
			"\udfff",
			"\udc00\ud800",
		];
		const texts = [...ascii, ...pieces, ascii.join("")];
		for (const first of pieces) for (const second of pieces) texts.push(first + second, `${first}x${second}`);
		for (const character of ascii) for (const piece of pieces) texts.push(character + piece, piece + character);
		const disagreements = texts.filter(text => managedSnapshotJsonByteLength(text) !== serializedBytes(text));
		expect(disagreements.map(text => JSON.stringify(text))).toEqual([]);
	});

	it("charges strings inside a message the same way", () => {
		const message = {
			role: "assistant",
			content: [
				{ type: "text", text: `첫 줄\n둘째 줄 "인용" \\ 끝\t${"가나다 abc\n".repeat(200)}` },
				{ type: "toolCall", name: "bash", arguments: { command: 'printf "%s\\n" "$HOME"\n', "키\n": "\ud83d" } },
			],
		};
		expect(managedSnapshotJsonByteLength(message)).toBe(serializedBytes(message));
	});

	it("does not walk a well-formed string one code point at a time", () => {
		const text = '첫 줄\n둘째 줄 "인용"\n'.repeat(50);
		const loneSurrogate = `\ud800${text}`;
		const codePointAt = vi.spyOn(String.prototype, "codePointAt");
		try {
			const measured = managedSnapshotJsonByteLength(text);
			const calls = codePointAt.mock.calls.length;
			// JSON escapes a lone surrogate and UTF-8 replaces it, so that string keeps the per-code-point loop.
			const measuredLoneSurrogate = managedSnapshotJsonByteLength(loneSurrogate);
			const loneSurrogateCalls = codePointAt.mock.calls.length - calls;
			codePointAt.mockRestore();
			expect(measured).toBe(serializedBytes(text));
			expect(calls).toBe(0);
			expect(measuredLoneSurrogate).toBe(serializedBytes(loneSurrogate));
			expect(loneSurrogateCalls).toBeGreaterThan(0);
		} finally {
			codePointAt.mockRestore();
		}
	});
});
