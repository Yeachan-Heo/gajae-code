/**
 * Check for and install updates.
 */
import { getProjectDir } from "@gajae-code/utils";
import { Command, Flags } from "@gajae-code/utils/cli";
import { runUpdateCommand } from "../cli/update-cli";
import { Settings } from "../config/settings";
import { isUpdateChannel, UPDATE_CHANNELS, type UpdateChannel } from "../config/update-channel";
import { initTheme } from "../modes/theme/theme";

export default class Update extends Command {
	static description = "Check for and install updates";

	static flags = {
		force: Flags.boolean({ char: "f", description: "Force update", default: false }),
		check: Flags.boolean({ char: "c", description: "Check for updates without installing", default: false }),
		channel: Flags.string({
			description: `Release channel to update from (${UPDATE_CHANNELS.join(" or ")}); defaults to the startup.updateChannel setting`,
		}),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Update);
		let channel: UpdateChannel | undefined;
		if (flags.channel !== undefined) {
			if (!isUpdateChannel(flags.channel)) {
				process.stderr.write(
					`Invalid --channel "${flags.channel}". Expected one of: ${UPDATE_CHANNELS.join(", ")}.\n`,
				);
				process.exit(1);
			}
			channel = flags.channel;
		} else {
			const settings = await Settings.init({ cwd: getProjectDir() });
			const configured = settings.get("startup.updateChannel");
			if (isUpdateChannel(configured)) {
				channel = configured;
			} else {
				// A hand-edited invalid value degrades to the schema default instead of
				// leaking into output or the registry lookup.
				process.stderr.write(
					`Ignoring invalid startup.updateChannel "${configured}". Expected one of: ${UPDATE_CHANNELS.join(", ")}; using stable.\n`,
				);
				channel = "stable";
			}
		}
		await initTheme();
		await runUpdateCommand({ force: flags.force, check: flags.check, channel });
	}
}
