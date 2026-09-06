/**
 * Check for and install updates.
 */
import { getProjectDir } from "@gajae-code/utils";
import { Args, Command, Flags } from "@gajae-code/utils/cli";
import { runUpdateCommand, runVerifiedRuntimeRecovery } from "../cli/update-cli";
import { Settings } from "../config/settings";
import {
	isUpdateChannel,
	resolveMachineLocalUpdateChannel,
	UPDATE_CHANNELS,
	type UpdateChannel,
} from "../config/update-channel";
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

	static args = {
		action: Args.string({
			description: "Internal post-update recovery action (update-recovery)",
			required: false,
			options: ["update-recovery"],
		}),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Update);
		if (args.action === "update-recovery") {
			await runVerifiedRuntimeRecovery();
			return;
		}
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
			// Update selection is machine-local: a project `.gjc/config.yml`
			// startup.updateChannel override must never silently pick the
			// global release channel, so read the user/global layer only and
			// fall back to the stable schema default when it is unset.
			channel = resolveMachineLocalUpdateChannel(settings);
		}
		await initTheme();
		await runUpdateCommand({ force: flags.force, check: flags.check, channel });
	}
}
