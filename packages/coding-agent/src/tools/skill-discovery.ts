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
			const candidates = await discoverRuntimeSkills({
				cwd: this.#session.cwd,
				query: input.query,
				source: input.source ?? "all",
				limit: input.limit,
				policy: this.#getRuntimeSkillPolicy(),
			});
			return {
				content: [{ type: "text", text: JSON.stringify({ candidates, count: candidates.length }, null, 2) }],
				details: { candidates, count: candidates.length },
			};
		});
	}
}
