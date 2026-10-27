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
		expect(intake).toContain("call `ask` exactly once");
		expect(intake).toContain("`Refine the spec` and `Proceed with stated assumptions`");
		expect(intake.indexOf("Before writing the mission artifact")).toBeLessThan(
			intake.indexOf("call `ask` exactly once"),
		);
		expect((autoresearchSkill.content.match(/call `ask` exactly once/g) ?? []).length).toBe(2);
	});

	it("asks for the handoff only after the persisted verdict and pauses the matching goal", () => {
		const handoff = section(autoresearchSkill.content, "- **Verdict handoff (ask point 2)**", "- **Complete**");

		expect(handoff).toContain("structured receipt is persisted");
		expect(handoff).toContain("call `ask` exactly once");
		expect(handoff).toContain('goal({"op":"pause"})');
		expect(handoff).toContain("`ralplan`, `deep-interview`, `implement directly`, and `stop`");
		expect(handoff.indexOf("structured receipt is persisted")).toBeLessThan(
			handoff.indexOf("call `ask` exactly once"),
		);
	});

	it("does not ask non-interactively and records bounded fallback assumptions", () => {
		const intake = section(autoresearchSkill.content, "### Intake clarification (ask point 1)", "## Mode");
		const handoff = section(autoresearchSkill.content, "- **Verdict handoff (ask point 2)**", "- **Complete**");

		expect(intake).toContain("If `ask` is unavailable");
		expect(intake).toContain("do not simulate or print an ask");
		expect(intake).toContain("persist each one in the mission's `assumptions` array");
		expect(intake).toContain("--assumption <text>");
		expect(handoff).toContain("use the recorded no-handoff assumption");
		expect(handoff).toContain("do not call or simulate it");
	});
});
