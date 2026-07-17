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
