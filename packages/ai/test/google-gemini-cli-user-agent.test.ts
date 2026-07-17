import { afterEach, describe, expect, it } from "bun:test";
import { getGeminiCliUserAgent } from "../src/providers/google-gemini-cli";
import { DEFAULT_GEMINI_CLI_VERSION } from "../src/providers/google-gemini-headers";

describe("Google Gemini CLI user agent", () => {
	const originalGjcVersion = process.env.GJC_AI_GEMINI_CLI_VERSION;
	const originalPiVersion = process.env.PI_AI_GEMINI_CLI_VERSION;

	afterEach(() => {
		if (originalGjcVersion === undefined) {
			delete process.env.GJC_AI_GEMINI_CLI_VERSION;
		} else {
			process.env.GJC_AI_GEMINI_CLI_VERSION = originalGjcVersion;
		}
		if (originalPiVersion === undefined) {
			delete process.env.PI_AI_GEMINI_CLI_VERSION;
		} else {
			process.env.PI_AI_GEMINI_CLI_VERSION = originalPiVersion;
		}
	});

	it("uses the current Gemini CLI version by default", () => {
		delete process.env.GJC_AI_GEMINI_CLI_VERSION;
		delete process.env.PI_AI_GEMINI_CLI_VERSION;

		expect(getGeminiCliUserAgent("gemini-2.5-flash")).toContain(
			`GeminiCLI/${DEFAULT_GEMINI_CLI_VERSION}/gemini-2.5-flash`,
		);
	});

	it("prefers the documented GJC Gemini CLI version override", () => {
		process.env.GJC_AI_GEMINI_CLI_VERSION = "9.8.7";
		process.env.PI_AI_GEMINI_CLI_VERSION = "1.2.3";

		expect(getGeminiCliUserAgent("gemini-2.5-flash")).toContain("GeminiCLI/9.8.7/gemini-2.5-flash");
	});

	it("keeps the legacy PI Gemini CLI version override as a fallback", () => {
		delete process.env.GJC_AI_GEMINI_CLI_VERSION;
		process.env.PI_AI_GEMINI_CLI_VERSION = "1.2.3";

		expect(getGeminiCliUserAgent("gemini-2.5-flash")).toContain("GeminiCLI/1.2.3/gemini-2.5-flash");
	});
});
