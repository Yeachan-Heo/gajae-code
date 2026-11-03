import { expect, it } from "bun:test";
import { expandPromptTemplate } from "../src/config/prompt-templates";

function expand(content: string) {
	return expandPromptTemplate("/probe", [{ name: "probe", description: "", content, source: "project" }]);
}
it("preserves literal table padding in four-backtick user template containing three-backtick example", () => {
	const s = ["````markdown", "```ts", "| literal | value |", "```", "````"].join("\n");
	expect(expand(s)).toBe(s);
});
it("a backtick fence does not close a tilde fence", () => {
	const s = ["~~~markdown", "```", "| literal | value |", "```", "~~~"].join("\n");
	expect(expand(s)).toBe(s);
});
