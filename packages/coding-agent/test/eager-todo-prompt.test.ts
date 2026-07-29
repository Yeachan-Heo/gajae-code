import { describe, expect, it } from "bun:test";
import eagerTodoPrompt from "../src/prompts/system/eager-todo.md" with { type: "text" };

const canonicalPayload = {
	ops: [
		{
			op: "init",
			list: [
				{
					phase: "Investigation",
					items: ["Locate relevant source and existing tests", "Reproduce failure with focused contract test"],
				},
				{ phase: "Implementation", items: ["Apply root cause fix across callsites"] },
				{ phase: "Verification", items: ["Run focused tests and static checks"] },
			],
		},
	],
};

describe("eager todo prompt contract", () => {
	it("shows the canonical phased todo_write init payload", () => {
		const example = eagerTodoPrompt.match(/```json\r?\n([^\r\n]+)\r?\n```/u)?.[1];
		expect(example).toBeDefined();

		const payload: unknown = JSON.parse(example ?? "null");
		expect(payload).toEqual(canonicalPayload);
		expect(eagerTodoPrompt).toContain("top-level `ops` array");
		expect(eagerTodoPrompt).toContain("`list`");
		expect(eagerTodoPrompt).not.toContain("task `content`");
		expect(eagerTodoPrompt).not.toContain("in_progress");
		expect(eagerTodoPrompt).not.toContain("all later tasks `pending`");
	});
});
