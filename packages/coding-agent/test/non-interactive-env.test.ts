import { describe, expect, it } from "bun:test";
import { NON_INTERACTIVE_ENV } from "../src/exec/non-interactive-env";

describe("non-interactive shell environment", () => {
	it("does not impersonate CI", () => {
		// Tools such as node-llama-cpp and test runners change behaviour on CI, and
		// an inherited per-call env cannot unset a value injected here.
		expect(NON_INTERACTIVE_ENV.CI).toBeUndefined();
		expect("CI" in NON_INTERACTIVE_ENV).toBe(false);
	});

	it("keeps the explicit prompt-suppression guards", () => {
		expect(NON_INTERACTIVE_ENV.GIT_TERMINAL_PROMPT).toBe("0");
		expect(NON_INTERACTIVE_ENV.SSH_ASKPASS).toBe("/usr/bin/false");
		expect(NON_INTERACTIVE_ENV.GH_PROMPT_DISABLED).toBe("1");
		expect(NON_INTERACTIVE_ENV.DEBIAN_FRONTEND).toBe("noninteractive");
		expect(NON_INTERACTIVE_ENV.PIP_NO_INPUT).toBe("1");
	});
});
