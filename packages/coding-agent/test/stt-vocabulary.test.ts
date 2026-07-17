import { describe, expect, test } from "bun:test";
import { buildSpeechVocabulary, vocabularyToWhisperPrompt } from "../src/stt/vocabulary";

describe("buildSpeechVocabulary", () => {
	test("extracts basenames without extensions from file paths", () => {
		const vocabulary = buildSpeechVocabulary({
			filePaths: ["src/stt/stt-controller.ts", "packages/tui/src/components/editor.ts"],
		});
		expect(vocabulary).toContain("stt-controller");
		expect(vocabulary).toContain("editor");
	});

	test("extra terms come first and survive the cap", () => {
		const filePaths = Array.from({ length: 300 }, (_, i) => `src/module-${i}.ts`);
		const vocabulary = buildSpeechVocabulary({ filePaths, extraTerms: ["ralplan", "useEffect"] }, 10);
		expect(vocabulary).toHaveLength(10);
		expect(vocabulary[0]).toBe("ralplan");
		expect(vocabulary[1]).toBe("useEffect");
	});

	test("drops stop terms, numbers, and short names", () => {
		const vocabulary = buildSpeechVocabulary({
			filePaths: ["src/index.ts", "docs/README.md", "a.ts", "v1.2.3.txt", "lib/utils.ts"],
		});
		expect(vocabulary).toHaveLength(0);
	});

	test("dedupes case-insensitively, keeping first spelling", () => {
		const vocabulary = buildSpeechVocabulary({
			filePaths: ["src/Editor.ts", "test/editor.test.ts"],
			extraTerms: ["editor"],
		});
		expect(vocabulary).toEqual(["editor"]);
	});

	test("is deterministic for identical input", () => {
		const input = { filePaths: ["b/beta.ts", "a/alpha.ts"], extraTerms: ["zeta"] };
		expect(buildSpeechVocabulary(input)).toEqual(buildSpeechVocabulary(input));
	});
});

describe("vocabularyToWhisperPrompt", () => {
	test("empty vocabulary yields empty prompt", () => {
		expect(vocabularyToWhisperPrompt([])).toBe("");
	});

	test("joins terms and respects the character budget", () => {
		expect(vocabularyToWhisperPrompt(["alpha", "beta"])).toBe("alpha, beta");
		const many = Array.from({ length: 500 }, (_, i) => `term${i}`);
		expect(vocabularyToWhisperPrompt(many).length).toBeLessThanOrEqual(600);
	});
});

describe("bundlePathFromExecutablePath", () => {
	test("extracts the app bundle root", async () => {
		const { bundlePathFromExecutablePath } = await import("../src/stt/backends/apple");
		expect(bundlePathFromExecutablePath("/Applications/Orca.app/Contents/MacOS/Orca")).toBe("/Applications/Orca.app");
		expect(bundlePathFromExecutablePath("/Applications/Otty.app/Contents/MacOS/Otty")).toBe("/Applications/Otty.app");
	});

	test("returns null for plain CLI chains", async () => {
		const { bundlePathFromExecutablePath } = await import("../src/stt/backends/apple");
		expect(bundlePathFromExecutablePath("/usr/bin/login")).toBeNull();
		expect(bundlePathFromExecutablePath("/opt/homebrew/bin/tmux")).toBeNull();
		expect(bundlePathFromExecutablePath("")).toBeNull();
	});
});

describe("host speech eligibility (fail-closed)", () => {
	test("classifies system, app, and unknown hosts", async () => {
		const { classifyHostBundle } = await import("../src/stt/backends/apple");
		expect(classifyHostBundle("/System/Applications/Utilities/Terminal.app")).toBe("system");
		expect(classifyHostBundle("/Applications/Orca.app")).toBe("app");
		expect(classifyHostBundle(null)).toBe("none");
	});

	test("only provable hosts are eligible; unknown is never eligible", async () => {
		const { hostClassAllowsInProcessSpeech } = await import("../src/stt/backends/apple");
		expect(hostClassAllowsInProcessSpeech("system", false)).toBe(true);
		expect(hostClassAllowsInProcessSpeech("app", true)).toBe(true);
		expect(hostClassAllowsInProcessSpeech("app", false)).toBe(false);
		expect(hostClassAllowsInProcessSpeech("none", true)).toBe(false);
		expect(hostClassAllowsInProcessSpeech("none", false)).toBe(false);
	});
});
