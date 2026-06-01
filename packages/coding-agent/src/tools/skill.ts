/**
 * Skill Tool — agent-initiated skill chaining.
 *
 * Lets a skill prompt the agent to hand off to another available skill once the
 * current turn completes. The chained skill's SKILL.md is dispatched through
 * the same custom-message path used by `/skill:<name>` typing and the
 * subagent `autoloadSkills` mechanic — queued as a user-attribution message
 * delivered with `deliverAs: "nextTurn"`, so the current skill finishes
 * cleanly before the next one activates.
 */

import type { AgentTool, AgentToolResult } from "@gajae-code/agent-core";
import { prompt, untilAborted } from "@gajae-code/utils";
import * as z from "zod/v4";
import { buildSkillPromptMessage } from "../extensibility/skills";
import skillDescription from "../prompts/tools/skill.md" with { type: "text" };
import { SKILL_PROMPT_MESSAGE_TYPE } from "../session/messages";
import type { ToolSession } from ".";
import { ToolError } from "./tool-errors";

const skillSchema = z.object({
	name: z.string().describe("skill name as it appears in /skill:<name>"),
	args: z.string().describe("argument string passed to the skill").optional(),
});

type SkillToolInput = z.infer<typeof skillSchema>;

export interface SkillToolDetails {
	name: string;
	path: string;
	args?: string;
	lineCount: number;
}

export class SkillTool implements AgentTool<typeof skillSchema, SkillToolDetails> {
	readonly name = "skill";
	readonly label = "Skill";
	readonly summary = "Chain into another available skill on the next turn";
	readonly loadMode = "discoverable";
	readonly description: string;
	readonly parameters = skillSchema;
	readonly strict = true;

	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
		this.description = prompt.render(skillDescription);
	}

	static createIf(session: ToolSession): SkillTool | null {
		// The tool can only chain when the session can deliver the queued
		// next-turn message. Without `sendCustomMessage` (e.g. minimal tool
		// harnesses in tests) there is nothing useful to do.
		if (!session.sendCustomMessage) return null;
		const skills = session.skills ?? [];
		if (skills.length === 0) return null;
		return new SkillTool(session);
	}

	async execute(
		_toolCallId: string,
		input: SkillToolInput,
		signal?: AbortSignal,
	): Promise<AgentToolResult<SkillToolDetails>> {
		return untilAborted(signal, async () => {
			const sendCustomMessage = this.#session.sendCustomMessage;
			if (!sendCustomMessage) {
				throw new ToolError("skill tool: session has no custom-message bridge");
			}
			const skills = this.#session.skills ?? [];
			const requestedName = input.name.trim();
			if (!requestedName) {
				throw new ToolError("skill tool: `name` is required");
			}
			const skill = skills.find(s => s.name === requestedName);
			if (!skill) {
				const available = skills.map(s => s.name).sort();
				const hint = available.length > 0 ? ` Available: ${available.join(", ")}` : "";
				throw new ToolError(`skill tool: unknown skill "${requestedName}".${hint}`);
			}

			const args = (input.args ?? "").trim();
			const built = await buildSkillPromptMessage(skill, args);

			await sendCustomMessage(
				{
					customType: SKILL_PROMPT_MESSAGE_TYPE,
					content: built.message,
					display: true,
					details: built.details,
					attribution: "user",
				},
				{ deliverAs: "nextTurn", triggerTurn: false },
			);

			const summary = args
				? `Queued /skill:${skill.name} ${args} for the next turn.`
				: `Queued /skill:${skill.name} for the next turn.`;
			return {
				content: [{ type: "text", text: summary }],
				details: {
					name: skill.name,
					path: skill.filePath,
					args: args || undefined,
					lineCount: built.details.lineCount,
				},
			};
		});
	}
}
