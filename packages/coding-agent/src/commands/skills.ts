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
	};

	static examples = [
		"# List bundled workflow skills\n  gjc skills list",
		"# Read an embedded workflow skill without requiring .gjc files\n  gjc skills read ultragoal",
		"# Machine-readable embedded skill content\n  gjc skills read ralplan --json",
		"# Show filesystem-discovered skills (project and user) with diagnostics\n  gjc skills discover",
		"# Show only project-scope skills (project .gjc/skills locations)\n  gjc skills discover --source project --json",
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
			},
		};
		await runSkillsCommand(cmd);
	}
}
