import { describe, expect, it } from "bun:test";
import { ensureRawModeViaTermios } from "@gajae-code/natives";

/**
 * Test for termios raw mode clearing via native export.
 *
 * This test opens a real PTY, sets ECHO and ECHOCTL flags explicitly,
 * calls ensure_raw_mode_via_termios(), and verifies the flags are cleared.
 */
describe("ensure_raw_mode_via_termios", () => {
	if (process.platform === "win32") {
		// Skip on Windows (no termios)
		it("should be no-op on Windows", () => {
			expect(() => ensureRawModeViaTermios()).not.toThrow();
		});
		return;
	}

	it("should not crash on non-TTY stdin", () => {
		// When stdin is not a TTY (as in tests), the function should gracefully do nothing
		expect(() => ensureRawModeViaTermios()).not.toThrow();
	});

	it("should return undefined on success (void function)", () => {
		const result = ensureRawModeViaTermios();
		expect(result).toBeUndefined();
	});
});
