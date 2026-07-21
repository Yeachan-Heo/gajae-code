import { Command } from "@gajae-code/utils/cli";
import { parseUsageRawArgv, renderUsageHelp, runUsageCommand, writeUsageError } from "../cli/usage-cli";

export default class Usage extends Command {
	static description = "View live OpenAI Codex usage for stored GJC credentials";
	static delegateHelp = true;
	static strict = false;

	async run(): Promise<void> {
		const parsed = parseUsageRawArgv(this.argv);
		if (parsed.kind === "help") {
			process.stdout.write(renderUsageHelp(this.config.bin));
			return;
		}
		if (parsed.kind === "error") {
			writeUsageError(parsed.message);
			process.exitCode = 2;
			return;
		}
		await runUsageCommand(parsed.args);
	}
}
