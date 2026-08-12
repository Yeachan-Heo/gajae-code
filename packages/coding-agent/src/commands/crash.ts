/**
 * `gjc crash` — inspect local crash signatures and file an assisted, fully
 * consented bug report. Nothing leaves the machine without an explicit,
 * digest-confirmed confirmation for that exact invocation.
 */
import { Args, Command, Flags } from "@gajae-code/utils/cli";
import { runCrashListCommand, runCrashReportCommand } from "../cli/crash-cli";

export default class Crash extends Command {
	static description = "Inspect crash signatures and file an assisted bug report";
	static args = {
		action: Args.string({ description: "list | report", required: false }),
	};
	static flags = {
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON (list only)", default: false }),
	};

	static examples = ["gjc crash list", "gjc crash list --json", "gjc crash report"];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Crash);
		const action = args.action ?? "list";
		if (action === "list") {
			await runCrashListCommand(flags.json === true);
			return;
		}
		if (action !== "report") {
			process.stderr.write(`Unknown action "${action}". Expected: list, report.\n`);
			process.exitCode = 1;
			return;
		}
		const outcome = await runCrashReportCommand();
		if (outcome.status === "refused" || outcome.status === "unmatchable") process.exitCode = 1;
	}
}
