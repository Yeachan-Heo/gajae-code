import { Args, Command, Flags } from "@gajae-code/utils/cli";
import { type MasterCommandAction, parseMasterArgs, runMasterCommand } from "../cli/master-cli";

const ACTIONS: readonly MasterCommandAction[] = ["create", "list", "configure"];

export default class Master extends Command {
	static description = "Create, list, and configure master sessions";
	static strict = true;

	static args = {
		action: Args.string({
			description: "Master action (create, list, configure)",
			required: false,
			options: [...ACTIONS],
		}),
		name: Args.string({ description: "Canonical master name", required: false }),
	};

	static flags = {
		workdir: Flags.string({ description: "Canonical master workdir (create only)" }),
		"max-concurrent-workers": Flags.integer({ description: "Positive worker capacity (default: 3)" }),
		json: Flags.boolean({ description: "Emit JSON output (list only)" }),
	};

	async run(): Promise<void> {
		await this.parse(Master);
		const command = parseMasterArgs(["master", ...this.argv]);
		if (command === undefined) throw new Error("Unable to parse master command.");
		await runMasterCommand(command);
	}
}
