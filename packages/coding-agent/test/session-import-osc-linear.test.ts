/**
 * OSC removal inside imported-text scrubbing used to rescan every unterminated
 * `ESC ]` prefix. Ralplan stage writes send the artifact body through
 * `sanitizeImportedString` on the synchronous write path.
 */

import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { sanitizeImportedString } from "../src/session-import/redact";

// OSC stops at the first BEL or ST so text between sequences stays.
const ANSI_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\](?:(?!\x1b\\)[^\x07])*(?:\x07|\x1b\\))/gu;
const UNSAFE_CONTROL =
	/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu;
const PROPERTY_SEED = 5472026;

function referenceImportedString(input: string): string {
	ANSI_ESCAPE.lastIndex = 0;
	UNSAFE_CONTROL.lastIndex = 0;
	return input.replace(ANSI_ESCAPE, "").replace(UNSAFE_CONTROL, "");
}

describe("imported OSC stripping", () => {
	it("a long run of unterminated ESC prefixes stays cheap", () => {
		// 12k prefixes cost ~0.3s and 50k cost ~5s with the old global replace.
		// 80k stays over a second on a faster machine, and a linear scan is a few ms.
		const count = 80_000;
		const body = `${"\u001b]".repeat(count)}TAIL`;
		const started = performance.now();
		const value = sanitizeImportedString(body);
		const elapsedMs = performance.now() - started;
		expect(value).toBe(`${"]".repeat(count)}TAIL`);
		expect(elapsedMs).toBeLessThan(1_000);
	}, 30_000);

	it("keeps complete OSC titles and plain artifact text unchanged", () => {
		expect(sanitizeImportedString("before \u001b]0;title\u0007after \u001b[31mcolored\u001b[0m tail")).toBe(
			"before after colored tail",
		);
		expect(sanitizeImportedString("before \u001b]8;;https://example.com/a\u001b\\after")).toBe("before after");
		const plain = "oversized artifact body without a control sequence";
		expect(sanitizeImportedString(plain)).toBe(plain);
	});

	it("preserves ordinary text between two or more terminated OSC sequences", () => {
		const between = "plan: keep this sentence";
		const input = `\u001b]0;one\u001b\\${between}\u001b]8;;https://example.com/a\u001b\\ tail \u001b]2;two\u0007`;
		expect(sanitizeImportedString(input)).toBe(`${between} tail `);
	});

	it("a long run of terminated OSC sequences stays cheap", () => {
		const count = 160_000;
		const started = performance.now();
		const belValue = sanitizeImportedString(`${"\u001b]x\u0007".repeat(count)}TAIL`);
		const stValue = sanitizeImportedString(`${"\u001b]x\u001b\\".repeat(count)}TAIL`);
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(belValue).toBe("TAIL");
		expect(stValue).toBe("TAIL");
	}, 30_000);

	it("property: OSC and CSI stripping matches bounded sequences, seed 5472026, 64 inputs", () => {
		const text = fc
			.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789 \n.,".split("")), {
				minLength: 0,
				maxLength: 20,
			})
			.map(chars => chars.join(""));
		const chunk = fc.oneof(
			text,
			fc.constant("\u001b[31m"),
			fc.constant("\u001b[0m"),
			fc.constant("\u001b[?25h"),
			fc.constant("\u001b]0;title\u0007"),
			fc.constant("\u001b]8;;https://example.com/a\u001b\\"),
			fc.constant("\u001b]foo\u001b\\bar\u0007"),
			fc.constant("\u001b]open"),
			fc.constant("\u001b[31"),
			fc.constant("\u001b"),
			fc.constant("\u0007"),
		);
		fc.assert(
			fc.property(fc.array(chunk, { minLength: 1, maxLength: 6 }), parts => {
				const input = parts.join("");
				const once = sanitizeImportedString(input);
				expect(once).toBe(referenceImportedString(input));
				expect(sanitizeImportedString(once)).toBe(once);
			}),
			{ seed: PROPERTY_SEED, numRuns: 64 },
		);
	});
});
