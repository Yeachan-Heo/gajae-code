/**
 * Inspect bundled workflow skills and filesystem-discovered custom skills.
 */
import { Args, Command, Flags, renderCommandHelp } from "@gajae-code/utils/cli";
import { runSkillsCommand, type SkillsAction, type SkillsCommandArgs } from "../cli/skills-cli";

const ACTIONS: SkillsAction[] = ["list", "read", "discover"];

export default class Skills extends Command {
	static description = "Inspect bundled GJC workflow skills and discover custom filesystem skills";

	static args = {
		action: Args.string({
			description: "Skills action",
			required: false,
			options: ACTIONS,
		}),
		name: Args.string({
			description: "Bundled skill name to read",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		source: Flags.string({
			description: "Scope for discover: all, project, or user",
			options: ["all", "project", "user"],
			default: "all",
		}),
		limit: Flags.integer({ description: "Max discover results, clamped to 1-50 (default 50)" }),
		offset: Flags.integer({ description: "Zero-based offset into the discover results (default 0)" }),
		query: Flags.string({
			description: "Filter discover results by name, description, source, or use conditions",
		}),
	};

	static examples = [
		"# List bundled workflow skills\n  gjc skills list",
		"# Read an embedded workflow skill without requiring .gjc files\n  gjc skills read ultragoal",
		"# Machine-readable embedded skill content\n  gjc skills read ralplan --json",
		"# Show filesystem-discovered skills (project and user) with diagnostics\n  gjc skills discover",
		"# Show only project-scope skills (project .gjc/skills locations)\n  gjc skills discover --source project --json",
		"# Narrow a truncated catalog to the skills you care about\n  gjc skills discover --query ego-browser",
		"# Show only the first 10 discovered skills\n  gjc skills discover --limit 10",
		"# Page past the first 50: discover prints the exact next-page command\n  gjc skills discover --offset 50",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Skills);
		if (!args.action) {
			renderCommandHelp("gjc", "skills", Skills);
			return;
		}

		const cmd: SkillsCommandArgs = {
			action: args.action as SkillsAction,
			name: args.name,
			flags: {
				json: flags.json,
				source: (flags.source as "all" | "project" | "user" | undefined) ?? "all",
				limit: flags.limit,
				offset: flags.offset,
				query: flags.query,
			},
		};
		await runSkillsCommand(cmd);
	}
}
