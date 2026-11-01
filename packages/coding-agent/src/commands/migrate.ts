/**
 * Import MCP servers, skills, slash commands, and instructions from other coding agents into GJC.
 */
import { Command, Flags } from "@gajae-code/utils/cli";
import { type MigrateCommandArgs, runMigrateCommand } from "../cli/migrate-cli";

export default class Migrate extends Command {
	static description = "Import MCP servers, skills, slash commands, and instructions from other coding agents";

	static examples = [
		"gjc migrate --from claude-code",
		"gjc migrate --from codex --from opencode",
		"gjc migrate --from all --dry-run --json",
		"gjc migrate --from claude-code --project --force",
	];

	static flags = {
		from: Flags.string({
			description: "Source agent to import from (repeatable): claude-code | codex | opencode | all",
			multiple: true,
			required: true,
		}),
		project: Flags.boolean({
			description: "Write to the project scope (./.gjc) instead of the user scope (~/.gjc)",
			default: false,
		}),
		force: Flags.boolean({
			description: "Overwrite existing skills, commands, MCP servers, or instruction files instead of skipping them",
			default: false,
		}),
		"dry-run": Flags.boolean({ description: "Preview the migration without writing anything", default: false }),
		json: Flags.boolean({ char: "j", description: "Emit a machine-readable JSON report", default: false }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Migrate);
		const cmd: MigrateCommandArgs = {
			from: flags.from ?? [],
			project: flags.project,
			force: flags.force,
			dryRun: flags["dry-run"],
			json: flags.json,
		};
		await runMigrateCommand(cmd);
	}
}
