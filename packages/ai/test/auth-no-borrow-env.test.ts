import { afterEach, describe, expect, it } from "bun:test";
import { authBorrowDisabledForTest } from "@gajae-code/ai/utils/oauth/perplexity";

/**
 * `docs/environment-variables.md` advertises `GJC_AUTH_NO_BORROW` as the switch
 * that "disables macOS native-app token borrowing path in Perplexity login flow".
 * Only the legacy `PI_AUTH_NO_BORROW` was ever read, so an operator following the
 * documentation still had a token read out of the desktop application.
 *
 * The contract is presence-based, matching the documented "If set" wording: any
 * set value disables borrowing. A boolean contract would let `=0` silently
 * re-enable it, which is the wrong direction for a privacy opt-out.
 */

const KEYS = ["GJC_AUTH_NO_BORROW", "PI_AUTH_NO_BORROW"] as const;
const saved = new Map<string, string | undefined>();
for (const key of KEYS) saved.set(key, process.env[key]);

function setOnly(entries: Partial<Record<(typeof KEYS)[number], string>>): void {
	for (const key of KEYS) delete process.env[key];
	for (const [key, value] of Object.entries(entries)) process.env[key] = value;
}

afterEach(() => {
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("Perplexity native-app borrowing opt-out", () => {
	it("borrows by default when neither name is set", () => {
		setOnly({});
		expect(authBorrowDisabledForTest()).toBe(false);
	});

	it("honors the documented GJC_AUTH_NO_BORROW", () => {
		setOnly({ GJC_AUTH_NO_BORROW: "1" });
		expect(authBorrowDisabledForTest()).toBe(true);
	});

	it("still honors the legacy PI_AUTH_NO_BORROW", () => {
		setOnly({ PI_AUTH_NO_BORROW: "1" });
		expect(authBorrowDisabledForTest()).toBe(true);
	});

	it("treats any set value as an opt-out, including 0", () => {
		// Presence-based: a privacy opt-out must not be re-enabled by `=0`.
		setOnly({ GJC_AUTH_NO_BORROW: "0" });
		expect(authBorrowDisabledForTest()).toBe(true);
	});

	it("ignores an empty value, matching the previous behavior", () => {
		setOnly({ GJC_AUTH_NO_BORROW: "" });
		expect(authBorrowDisabledForTest()).toBe(false);
	});

	it("opts out when either name is set alongside the other", () => {
		setOnly({ GJC_AUTH_NO_BORROW: "1", PI_AUTH_NO_BORROW: "" });
		expect(authBorrowDisabledForTest()).toBe(true);
	});
});
