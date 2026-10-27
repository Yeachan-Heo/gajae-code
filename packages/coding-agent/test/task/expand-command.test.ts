import { describe, expect, it } from "bun:test";
import { expandCommand, type WorkflowCommand } from "../../src/task/commands";

function command(instructions: string): WorkflowCommand {
	return { name: "review", description: "", instructions, source: "user", filePath: "/tmp/review.md" };
}

describe("expandCommand", () => {
	it("substitutes every $@ with the task input", () => {
		expect(expandCommand(command("Review:\n$@\nThen re-check $@."), "the login fix")).toBe(
			"Review:\nthe login fix\nThen re-check the login fix.",
		);
	});

	it("inserts input containing replacement-pattern characters verbatim", () => {
		// The input was passed as a string replacement, so `$&` became `$@`, `$$`
		// collapsed to `$`, and `` $` `` / `$'` spliced the instructions before or
		// after the placeholder into the user's text.
		for (const input of ["sed s/a/$&/g", "costs $$5", "regex /^$`/", "the $' suffix", "awk '{print $1}'"]) {
			expect(expandCommand(command("Task: $@ (done)"), input)).toBe(`Task: ${input} (done)`);
		}
	});
});
