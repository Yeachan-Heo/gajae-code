import { beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { SkillMessageComponent } from "@gajae-code/coding-agent/modes/components/skill-message";
import * as themeModule from "@gajae-code/coding-agent/modes/theme/theme";
import {
	type CustomMessage,
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
} from "@gajae-code/coding-agent/session/messages";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await themeModule.initTheme(false, undefined, undefined, "red-claw", "blue-crab");
});

function makeMessage(details: SkillPromptDetails, content: string): CustomMessage<SkillPromptDetails> {
	return {
		role: "custom",
		customType: SKILL_PROMPT_MESSAGE_TYPE,
		content,
		display: true,
		details,
		timestamp: Date.now(),
	};
}

function render(message: CustomMessage<SkillPromptDetails>, expanded: boolean): string {
	const component = new SkillMessageComponent(message);
	component.setExpanded(expanded);
	return component
		.render(120)
		.map(line => Bun.stripANSI(line))
		.join("\n");
}

const DETAILS: SkillPromptDetails = {
	name: "deep-interview",
	path: "embedded:gjc/skills/deep-interview/SKILL.md",
	lineCount: 858,
};

describe("SkillMessageComponent rendering", () => {
	it("collapsed view shows `[skill] <name>: <args>` and no debug metadata", () => {
		const out = render(makeMessage({ ...DETAILS, args: "fix the login bug" }, "PROMPT BODY TEXT"), false);

		expect(out).toContain("[skill] deep-interview: fix the login bug");

		// Debug-only detail must be hidden when collapsed.
		expect(out).not.toContain("Skill:");
		expect(out).not.toContain("Args:");
		expect(out).not.toContain("Path:");
		expect(out).not.toContain("embedded:gjc/skills/deep-interview/SKILL.md");
		expect(out).not.toContain("858 lines");
		expect(out).not.toContain("PROMPT BODY TEXT");
	});

	it("renders just `[skill] <name>` when there are no args", () => {
		const out = render(makeMessage(DETAILS, "BODY"), false);
		expect(out).toContain("[skill] deep-interview");
		// No colon summary when the user typed nothing.
		expect(out).not.toContain("deep-interview:");
	});

	it("truncates over-long args to a single line", () => {
		const longArgs = `${"A".repeat(90)} ZZZEND`;
		const out = render(makeMessage({ ...DETAILS, args: longArgs }, "BODY"), false);
		expect(out).toContain("AAAA");
		expect(out).not.toContain("ZZZEND");
	});

	it("expanded view reveals path, line count, and full prompt body", () => {
		const out = render(makeMessage({ ...DETAILS, args: "fix the login bug" }, "PROMPT BODY TEXT"), true);

		expect(out).toContain("[skill] deep-interview: fix the login bug");
		expect(out).toContain("Path:");
		expect(out).toContain("embedded:gjc/skills/deep-interview/SKILL.md");
		expect(out).toContain("858 lines");
		expect(out).toContain("Prompt");
		expect(out).toContain("PROMPT BODY TEXT");
	});

	it("falls back to 'unknown' when name is missing", () => {
		const out = render(makeMessage({ path: "", lineCount: 0 } as unknown as SkillPromptDetails, ""), false);
		expect(out).toContain("unknown");
	});
});
