/**
 * Check for and install updates.
 */
import { Command, Flags } from "@gajae-code/utils/cli";

export default class Update extends Command {
	static description = "Check for and install updates";

	static flags = {
		force: Flags.boolean({ char: "f", description: "Force update", default: false }),
		check: Flags.boolean({ char: "c", description: "Check for updates without installing", default: false }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Update);
		const { initTheme } = await import("../modes/theme/theme");
		const { runUpdateCommand } = await import("../cli/update-cli");
		await initTheme();
		await runUpdateCommand({ force: flags.force, check: flags.check });
	}
}
