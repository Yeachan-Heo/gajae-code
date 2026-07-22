import type { AgentTool, AgentToolResult } from "@gajae-code/agent-core";
import { prompt, untilAborted } from "@gajae-code/utils";
import * as z from "zod/v4";
import { discoverRuntimeSkills, type RuntimeSkillDiscoveryCandidate } from "../extensibility/runtime-skill-discovery";
import skillDiscoveryDescription from "../prompts/tools/skill-discovery.md" with { type: "text" };
import type { ToolSession } from ".";

const skillDiscoverySchema = z
	.object({
		query: z
			.string()
			.optional()
			.describe("words to match against skill name, description, source, or use conditions"),
		source: z.enum(["all", "project", "user"]).default("all").optional().describe("skill source scope to search"),
		limit: z.number().min(1).max(50).default(20).optional().describe("maximum results"),
	})
	.strict();

export type SkillDiscoveryToolInput = z.infer<typeof skillDiscoverySchema>;

export interface SkillDiscoveryToolDetails {
	candidates: RuntimeSkillDiscoveryCandidate[];
	count: number;
	/**
	 * Present only when zero candidates were returned AND discovery config gates
	 * (`skills.enabled` / `skills.enablePiProject` / `skills.enablePiUser`)
	 * prevented some or all of the requested scope from being searched. Without
	 * this, a disabled config is indistinguishable from "no skills exist".
	 */
	notice?: string;
}

export class SkillDiscoveryTool implements AgentTool<typeof skillDiscoverySchema, SkillDiscoveryToolDetails> {
	readonly name = "skill_discovery";
	readonly label = "SkillDiscovery";
	readonly summary = "Discover project and user runtime skills by thin metadata";
	readonly loadMode = "essential";
	readonly description: string;
	readonly parameters = skillDiscoverySchema;
	readonly strict = true;

	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
		this.description = prompt.render(skillDiscoveryDescription);
	}

	#getRuntimeSkillPolicy() {
		return {
			...this.#session.settings.getGroup("skills"),
			disabledExtensions: this.#session.settings.get("disabledExtensions"),
		};
	}

	static createIf(session: ToolSession): SkillDiscoveryTool | null {
		if (session.settings.get("skill.enabled") === false) return null;
		return new SkillDiscoveryTool(session);
	}

	async execute(
		_toolCallId: string,
		input: SkillDiscoveryToolInput,
		signal?: AbortSignal,
	): Promise<AgentToolResult<SkillDiscoveryToolDetails>> {
		return untilAborted(signal, async () => {
			const source = input.source ?? "all";
			const candidates = await discoverRuntimeSkills({
				cwd: this.#session.cwd,
				query: input.query,
				source,
				limit: input.limit,
				policy: this.#getRuntimeSkillPolicy(),
			});
			const details: SkillDiscoveryToolDetails = { candidates, count: candidates.length };
			if (candidates.length === 0) {
				const notice = this.#disabledPolicyNotice(source);
				if (notice) details.notice = notice;
			}
			return {
				content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
				details,
			};
		});
	}

	/**
	 * Explain an empty result that is caused by disabled discovery config rather
	 * than by an actually empty skill catalog.
	 */
	#disabledPolicyNotice(source: "all" | "project" | "user"): string | undefined {
		const policy = this.#getRuntimeSkillPolicy();
		if (policy.enabled !== true) {
			return "Runtime skill discovery is disabled: `skills.enabled` is false, so no skill directories were searched. Enable it with `gjc config set skills.enabled true` (project and user scopes additionally require `skills.enablePiProject` / `skills.enablePiUser`).";
		}
		const skipped: string[] = [];
		const commands: string[] = [];
		if ((source === "all" || source === "project") && policy.enablePiProject !== true) {
			skipped.push("project (`skills.enablePiProject` is false)");
			commands.push("`gjc config set skills.enablePiProject true`");
		}
		if ((source === "all" || source === "user") && policy.enablePiUser !== true) {
			skipped.push("user (`skills.enablePiUser` is false)");
			commands.push("`gjc config set skills.enablePiUser true`");
		}
		if (skipped.length === 0) return undefined;
		return `Skill discovery skipped disabled scope(s): ${skipped.join(", ")}. Enable them with ${commands.join(" and ")}.`;
	}
}
