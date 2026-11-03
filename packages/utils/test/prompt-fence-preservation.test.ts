import { expect, it } from "bun:test";
import { format } from "../src/prompt";

it("fence-looking line with trailing info is not a closer", () => {
	const s = ["```markdown", "```not-a-closer", "| literal | value |", "```"].join("\n");
	expect(format(s)).toBe(s);
});
it("normal outside table compaction remains enabled", () => {
	expect(format("| literal | value |")).toBe("|literal|value|");
});

it("keeps nested indented prompt fences protected and resumes outside formatting", () => {
	const source = "  ````markdown\n  ```ts\n  | literal | value |\n  ```\n  ````\n| outside | value |";
	expect(format(source)).toBe("  ````markdown\n  ```ts\n  | literal | value |\n  ```\n  ````\n|outside|value|");
});
it("keeps unterminated fenced content literal and accepts a longer closing fence", () => {
	expect(format("~~~\n```\n| literal | value |")).toBe("~~~\n```\n| literal | value |");
	expect(format("```\n| literal | value |\n````\n| outside | value |")).toBe(
		"```\n| literal | value |\n````\n|outside|value|",
	);
});

it("preserves literal ASCII operators in nested code when symbol replacement is enabled", () => {
	const source = ["````markdown", "```ts", "x => x != 0", "```", "````"].join("\n");
	expect(format(source, { replaceAsciiSymbols: true })).toBe(source);
});
it("preserves literal normative text in nested code when RFC normalization is enabled", () => {
	const source = ["~~~~markdown", "~~~", "MUST NOT alter", "~~~", "~~~~"].join("\n");
	expect(format(source, { normalizeRfc2119: true })).toBe(source);
});

it("does not open a backtick fence with backticks in its info string", () => {
	expect(format("```ts `invalid`\n| outside | value |")).toBe("```ts `invalid`\n|outside|value|");
});
it("preserves legacy deeply indented fences rather than adding CommonMark indentation parsing", () => {
	expect(format("    ```\n| literal | value |\n    ```\n| outside | value |")).toBe(
		"    ```\n| literal | value |\n    ```\n|outside|value|",
	);
});
