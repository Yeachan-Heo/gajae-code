/**
 * Check for and install updates.
 */
import { Command, Flags } from "@gajae-code/utils/cli";
import { runUpdateCommand } from "../cli/update-cli";
import { initTheme } from "../modes/theme/theme";

export default class Update extends Command {
	static description = "Check for and install updates";

	static flags = {
		force: Flags.boolean({ char: "f", description: "Force update", default: false }),
		check: Flags.boolean({ char: "c", description: "Check for updates without installing", default: false }),
		pre: Flags.boolean({
			description: 'Opt into the pre-release channel (npm dist-tag "next")',
			default: false,
		}),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Update);
		await initTheme();
		await runUpdateCommand({ force: flags.force, check: flags.check, pre: flags.pre });
	}
}
