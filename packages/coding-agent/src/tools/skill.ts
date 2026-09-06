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
 * Canonical workflow chaining is refused unless the caller's phase permits it:
 * the generic terminal set `{complete, completed, handoff, failed, cancelled,
 * canceled, inactive}`, the caller's manifest-declared terminal states (e.g.
 * ralplan `final`), or — for autoresearch only — any phase with a declared
 * handoff edge (`intake`/`research`/`verdict`): a research mission never
 * mutates and guards no approval gate, its mission state is durable, so an
 * ongoing or verdict-complete mission may hand off to planning at any point.
 * ralplan/ultragoal keep the explicit write-to-handoff step for live phases:
 * their mid-flight chaining is exactly what the approval-gate guard blocks.
 */

import type { AgentTool, AgentToolResult } from "@gajae-code/agent-core";
import { prompt, untilAborted } from "@gajae-code/utils";
import * as z from "zod/v4";
import { resolveSubskillActivationForSkillInvocation } from "../extensibility/gjc-plugins";
import { findRuntimeSkillByName } from "../extensibility/runtime-skill-discovery";
import { buildSkillPromptMessage } from "../extensibility/skills";
import { runNativeStateCommand } from "../gjc-runtime/state-runtime";
import { getSkillManifest } from "../gjc-runtime/workflow-manifest";
import skillDescription from "../prompts/tools/skill.md" with { type: "text" };
import { SKILL_PROMPT_MESSAGE_TYPE } from "../session/messages";
import { isCanonicalGjcWorkflowSkill } from "../skill-state/active-state";
import {
	getSkillFilesystemIdentity,
	isCanonicalGjcWorkflowSkillFilesystemAlias,
} from "../skill-state/canonical-skills";
import type { ToolSession } from ".";
import { ToolError } from "./tool-errors";

const TERMINAL_PHASES = new Set(["complete", "completed", "handoff", "failed", "cancelled", "canceled", "inactive"]);

/**
 * Whether the active canonical workflow's phase permits chaining into another
 * skill. Generic terminal phases always chain; manifest terminal states cover
 * skill-specific termini the generic set misses (ralplan "final"); and
 * autoresearch chains from any phase with a manifest handoff edge because a
 * research mission is safely abandonable mid-flight (read-only, durable
 * mission state, no approval gate). ralplan/ultragoal deliberately stay
 * blocked in live phases so mid-consensus or mid-execution chaining still
 * requires the explicit write-to-handoff step.
 */
function phasePermitsChain(skill: string, phase: string): boolean {
	if (TERMINAL_PHASES.has(phase)) return true;
	if (!isCanonicalGjcWorkflowSkill(skill)) return false;
	const manifest = getSkillManifest(skill);
	if (manifest.terminalStates.includes(phase)) return true;
	if (skill !== "autoresearch") return false;
	return manifest.transitions.some(transition => transition.from === phase && transition.to === "handoff");
}

const skillSchema = z.object({
	name: z.string().describe("skill name as it appears in /skill:<name>"),
	args: z.string().describe("argument string passed to the skill").optional(),
});

function normalizeSkillName(name: string | undefined): string {
	return (name ?? "").trim();
}

const SKILL_NAME_GLOB_PATTERN = /[*?[\]{}]/;
const MAX_AVAILABLE_SKILL_NAMES = 50;
const MAX_AVAILABLE_SKILL_CHARS = 2048;

function formatAvailableSkills(skills: readonly { name: string }[]): string {
	const names = [...new Set(skills.map(skill => skill.name))].sort();
	const visible: string[] = [];
	let visibleChars = 0;
	for (let index = 0; index < names.length && visible.length < MAX_AVAILABLE_SKILL_NAMES; index++) {
		const name = names[index];
		const separatorChars = visible.length > 0 ? 2 : 0;
		const omittedAfterAdding = names.length - (visible.length + 1);
		const markerChars = omittedAfterAdding > 0 ? `, … (+${omittedAfterAdding} more)`.length : 0;
		if (visibleChars + separatorChars + name.length + markerChars > MAX_AVAILABLE_SKILL_CHARS) break;
		visible.push(name);
		visibleChars += separatorChars + name.length;
	}
	const omitted = names.length - visible.length;
	const marker = omitted > 0 ? `… (+${omitted} more)` : "";
	return visible.length > 0 && marker ? `${visible.join(", ")}, ${marker}` : visible.join(", ") || marker;
}

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
			if (
				isCanonicalGjcWorkflowSkillFilesystemAlias(requestedName) &&
				getSkillFilesystemIdentity(requestedName) !== requestedName.toLowerCase()
			) {
				throw new ToolError(`skill tool: refusing filesystem alias for bundled workflow skill "${requestedName}"`);
			}
			const activeState = this.#session.getActiveSkillState?.();
			const activeSkill = normalizeSkillName(activeState?.skill);
			if (activeSkill && requestedName === activeSkill) {
				throw new ToolError(
					`skill tool: refusing to chain into currently active skill "${requestedName}". Follow the active skill instructions instead of invoking it recursively.`,
				);
			}

			const agentDir =
				this.#session.getSessionAgentDir?.() ??
				(this.#session.home === undefined ? this.#session.settings.getAgentDir() : undefined);
			const skill =
				skills.find(s => s.name === requestedName) ??
				(await findRuntimeSkillByName(
					this.#session.cwd,
					requestedName,
					this.#getRuntimeSkillPolicy(),
					this.#session.home,
					agentDir,
					this.#session.profileAuthority,
				));
			if (!skill) {
				const available = formatAvailableSkills(skills);
				const hint =
					available.length > 0
						? ` Available: ${available}. Use skill_discovery to find project/user runtime skills.`
						: " Use skill_discovery to find project/user runtime skills.";
				throw new ToolError(`skill tool: unknown skill "${requestedName}".${hint}`);
			}

			// Phase guard + atomic native handoff only apply to canonical workflow
			// skills. Runtime project/user skills do not have a native mode-state,
			// so there is no `gjc state <skill>` command to run for them.
			if (activeSkill && isCanonicalGjcWorkflowSkill(activeSkill)) {
				const phase = (this.#session.getActiveSkillPhase?.() ?? "running").trim().toLowerCase();
				if (!phasePermitsChain(activeSkill, phase)) {
					throw new ToolError(
						`skill tool: refusing to chain from "${activeSkill}" (phase=${phase}) into "${requestedName}". Run gjc state ${activeSkill} handoff --to ${requestedName} --json directly, or finalize the current skill first (gjc state ${activeSkill} write --input '{"current_phase":"handoff"}' --json) before chaining.`,
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
