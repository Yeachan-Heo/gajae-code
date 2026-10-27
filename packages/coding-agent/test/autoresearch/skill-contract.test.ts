import { describe, expect, it } from "bun:test";
import { getDefaultGjcDefinitions } from "@gajae-code/coding-agent/defaults/gjc-defaults";

const autoresearchSkill = getDefaultGjcDefinitions().find(
	definition => definition.kind === "skill" && definition.name === "autoresearch",
);
if (!autoresearchSkill) throw new Error("missing bundled autoresearch skill");

function section(content: string, start: string, end: string): string {
	const startIndex = content.indexOf(start);
	const endIndex = content.indexOf(end, startIndex + start.length);
	if (startIndex === -1 || endIndex === -1) throw new Error(`missing skill section boundary: ${start}`);
	return content.slice(startIndex, endIndex);
}

describe("autoresearch skill intake and verdict handoff", () => {
	it("asks once for materially ambiguous intake before writing the mission", () => {
		const intake = section(autoresearchSkill.content, "### Intake clarification (ask point 1)", "## Mode");

		expect(intake).toContain("research question, success criterion, or scope is ambiguous");
		expect(intake).toContain("Before writing the mission artifact");
		expect(intake).toContain("A listed `ask` tool alone is not enough");
		expect(intake).toContain("call `ask` exactly once");
		expect(intake).toContain(
			"runtime description explicitly says an interactive or remote answer channel is available",
		);
		expect(intake).toContain("`Refine the spec` and `Proceed with stated assumptions`");
		expect(intake.indexOf("Before writing the mission artifact")).toBeLessThan(
			intake.indexOf("call `ask` exactly once"),
		);
		expect((autoresearchSkill.content.match(/call `ask` exactly once/g) ?? []).length).toBe(2);
	});

	it("asks for the handoff only after the persisted verdict and pauses the matching goal", () => {
		const handoff = section(autoresearchSkill.content, "- **Verdict handoff (ask point 2)**", "- **Complete**");
		const afterHandoff = section(autoresearchSkill.content, "- **After the handoff answer**", "- **Drop**");

		expect(handoff).toContain("structured receipt is persisted");
		expect(handoff).toContain("call `ask` exactly once");
		expect(handoff).toContain("`ask` tool description reports an interactive or remote answer channel");
		expect(handoff).toContain("`requireExplicitAnswer: true`");
		expect(handoff).toContain('goal({"op":"pause"})');
		expect(handoff).toContain("`ralplan` — plan follow-up research or a decision from the findings");
		expect(handoff).toContain("`deep-interview` — clarify or refine the research scope");
		expect(handoff).toContain("`Implementation plan (approval required)`");
		expect(handoff).toContain("`stop` — end without another workflow");
		expect(afterHandoff).toContain(
			"`ralplan` plans follow-up research or a decision; it is not the implementation choice",
		);
		expect(afterHandoff).toContain("waits for its explicit execution approval before product-code changes");
		expect(afterHandoff).toContain("the `skill` tool retires the conclusive autoresearch working set");
		expect(afterHandoff).toContain("while preserving the callee's active workflow state");
		expect(handoff.indexOf("structured receipt is persisted")).toBeLessThan(
			handoff.indexOf("call `ask` exactly once"),
		);
	});

	it("does not ask non-interactively and records bounded fallback assumptions", () => {
		const intake = section(autoresearchSkill.content, "### Intake clarification (ask point 1)", "## Mode");
		const handoff = section(autoresearchSkill.content, "- **Verdict handoff (ask point 2)**", "- **Complete**");

		expect(intake).toContain("If no answer channel is available");
		expect(intake).toContain("do not call or simulate `ask`");
		expect(intake).toContain("persist each one in the mission's `assumptions` array");
		expect(intake).toContain("--assumption <text>");
		expect(handoff).toContain("use the recorded no-handoff assumption");
		expect(handoff).toContain("do not call or simulate `ask`");
	});
});
