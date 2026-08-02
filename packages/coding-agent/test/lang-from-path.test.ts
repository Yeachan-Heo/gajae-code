import { describe, expect, test } from "bun:test";
import { getLanguageFromPath } from "@gajae-code/coding-agent/utils/lang-from-path";

describe("getLanguageFromPath", () => {
	test("prioritizes special filenames over generic extensions", () => {
		expect(getLanguageFromPath("/repo/CMakeLists.txt")).toBe("cmake");
		expect(getLanguageFromPath("/repo/Dockerfile.txt")).toBe("dockerfile");
		expect(getLanguageFromPath("/repo/.env.json")).toBe("env");
		expect(getLanguageFromPath("/repo/Makefile")).toBe("make");
		expect(getLanguageFromPath("/repo/GNUmakefile")).toBe("make");
	});
});
