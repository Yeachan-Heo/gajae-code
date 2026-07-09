/**
 * Skill Tool — agent-initiated skill chaining.
 *
 * Lets the agent hand off to another available skill in the current turn. The
 * callee's SKILL.md is dispatched through the same custom-message path used by
 * `/skill:<name>` typing, as a user-attribution message delivered same-turn
 * (without `deliverAs: "nextTurn"`). When the caller is one of the canonical
 * workflow skills, the tool first runs the native state handoff so workflow
 * mode-state and `skill-active-state.json` transition atomically. Runtime
 * project/user skills have no native workflow mode-state, so they are dispatched
 * directly and tracked by the prompt observer instead.
 *
 * Canonical workflow chaining is refused unless the caller's `current_phase` is
 * in `{complete, completed, handoff, failed, cancelled, canceled, inactive}`.
 * The agent declares readiness either by writing `current_phase: "handoff"` to
 * its mode-state or by running the handoff verb directly.
 */

import type { AgentTool, AgentToolResult } from "@gajae-code/agent-core";
import { prompt, untilAborted } from "@gajae-code/utils";
import * as z from "zod/v4";
import { resolveSubskillActivationForSkillInvocation } from "../extensibility/gjc-plugins";
import { findRuntimeSkillByName } from "../extensibility/runtime-skill-discovery";
import { buildSkillPromptMessage } from "../extensibility/skills";
import { runNativeStateCommand } from "../gjc-runtime/state-runtime";
import skillDescription from "../prompts/tools/skill.md" with { type: "text" };
import { SKILL_PROMPT_MESSAGE_TYPE } from "../session/messages";
import { isCanonicalGjcWorkflowSkill } from "../skill-state/active-state";
import type { ToolSession } from ".";
import { ToolError } from "./tool-errors";

const TERMINAL_PHASES = new Set(["complete", "completed", "handoff", "failed", "cancelled", "canceled", "inactive"]);

const skillSchema = z.object({
	name: z.string().describe("skill name as it appears in /skill:<name>"),
	args: z.string().describe("argument string passed to the skill").optional(),
});

function normalizeSkillName(name: string | undefined): string {
	return (name ?? "").trim();
}

const SKILL_NAME_GLOB_PATTERN = /[*?[\]{}]/;

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
	readonly summary = "Chain into another available skill in the current turn";
	readonly loadMode = "essential";
	readonly description: string;
	readonly parameters = skillSchema;
	readonly strict = true;

	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
		this.description = prompt.render(skillDescription);
	}

	#getRuntimeSkillPolicy() {
		return {
			...this.#session.settings.getGroup("skills"),
			disabledExtensions: this.#session.settings.get("disabledExtensions"),
		};
	}

	static createIf(session: ToolSession): SkillTool | null {
		// The tool can only chain when the session can deliver the same-turn
		// custom message. Without `sendCustomMessage` (e.g. minimal tool
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
			const requestedName = normalizeSkillName(input.name);
			if (!requestedName) {
				throw new ToolError("skill tool: `name` is required");
			}
			// Fail fast on glob/wildcard names (e.g. `*`). A model that sees the
			// `--skills '*'` launch filter may echo the glob into the skill tool.
			// Without this guard `*` slips through to the generic unknown-skill
			// path only because no skill is literally named `*`, so a future
			// odd skill name could get dispatched — and the actionable signal
			// that names are concrete (not globs) is lost. Reject before any
			// dispatch or handoff state mutation so the call ends immediately
			// instead of spawning skill work that burns the whole turn budget.
			if (SKILL_NAME_GLOB_PATTERN.test(requestedName)) {
				throw new ToolError(
					`skill tool: "${requestedName}" is not a valid skill name. The name must be a single concrete skill (e.g. "ralplan"), not a glob or wildcard pattern. Pass one exact skill name as shown in /skill:<name>.`,
				);
			}
			const activeState = this.#session.getActiveSkillState?.();
			const activeSkill = normalizeSkillName(activeState?.skill);
			if (activeSkill && requestedName === activeSkill) {
				throw new ToolError(
					`skill tool: refusing to chain into currently active skill "${requestedName}". Follow the active skill instructions instead of invoking it recursively.`,
				);
			}

			const skill =
				skills.find(s => s.name === requestedName) ??
				(await findRuntimeSkillByName(this.#session.cwd, requestedName, this.#getRuntimeSkillPolicy()));
			if (!skill) {
				const available = skills.map(s => s.name).sort();
				const hint =
					available.length > 0
						? ` Available: ${available.join(", ")}. Use skill_discovery to find project/user runtime skills.`
						: " Use skill_discovery to find project/user runtime skills.";
				throw new ToolError(`skill tool: unknown skill "${requestedName}".${hint}`);
			}

			// Phase guard + atomic native handoff only apply to canonical workflow
			// skills. Runtime project/user skills do not have a native mode-state,
			// so there is no `gjc state <skill>` command to run for them.
			if (activeSkill && isCanonicalGjcWorkflowSkill(activeSkill)) {
				const phase = (this.#session.getActiveSkillPhase?.() ?? "running").trim().toLowerCase();
				if (!TERMINAL_PHASES.has(phase)) {
					throw new ToolError(
						`skill tool: refusing to chain from "${activeSkill}" (phase=${phase}) into "${requestedName}". Finalize the current skill (gjc state ${activeSkill} write --input '{"current_phase":"handoff"}' --json) or run gjc state ${activeSkill} handoff --to ${requestedName} --json directly before chaining.`,
					);
				}
				const cwd = this.#session.cwd;
				const sessionId = activeState?.session_id?.trim();
				const handoffArgs = ["handoff", "--mode", activeSkill, "--to", requestedName, "--json"];
				if (sessionId) {
					handoffArgs.push("--session-id", sessionId);
				}
				const handoff = await runNativeStateCommand(handoffArgs, cwd);
				if (handoff.status !== 0) {
					throw new ToolError(
						`skill tool: handoff failed (status=${handoff.status}): ${(handoff.stderr ?? "").trim() || "no detail"}`,
					);
				}
			}

			const args = (input.args ?? "").trim();
			const activationResult = await resolveSubskillActivationForSkillInvocation({
				cwd: this.#session.cwd,
				sessionId: this.#session.getSessionId?.() ?? activeState?.session_id?.trim() ?? undefined,
				skillName: skill.name,
				args,
			});
			const built = await buildSkillPromptMessage(skill, activationResult.cleanedArgs, {
				subskillActivation: activationResult.activation,
				subskillActivationSet: activationResult.activeSubskillsToPersist,
				cwd: this.#session.cwd,
				sessionId: this.#session.getSessionId?.() ?? activeState?.session_id?.trim() ?? undefined,
			});

			await sendCustomMessage(
				{
					customType: SKILL_PROMPT_MESSAGE_TYPE,
					content: built.message,
					display: true,
					details: built.details,
					attribution: "user",
				},
				{ triggerTurn: false },
			);

			const summary = JSON.stringify({
				callee: skill.name,
				path: skill.filePath,
				args: activationResult.cleanedArgs || undefined,
				lineCount: built.details.lineCount,
			});
			return {
				content: [{ type: "text", text: summary }],
				details: {
					name: skill.name,
					path: skill.filePath,
					args: activationResult.cleanedArgs || undefined,
					lineCount: built.details.lineCount,
				},
			};
		});
	}
}
