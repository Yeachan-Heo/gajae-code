/**
 * Run Gajae Code as an ACP (Agent Client Protocol) server over stdio.
 *
 * Thin wrapper around the launch flow that forces `mode: "acp"` unless the
 * ACP terminal-auth flag asks the same command to open the interactive TUI.
 */
import { CliParseError, Command } from "@gajae-code/utils/cli";
import { parseArgs } from "../cli/args";
import { runRootCommand } from "../main";
import { prepareAcpTerminalAuthArgs } from "../modes/acp/terminal-auth";

export default class Acp extends Command {
	static description = "Run Gajae Code as an ACP (Agent Client Protocol) server over stdio";
	static strict = false;

	async run(): Promise<void> {
		const { args, terminalAuth } = prepareAcpTerminalAuthArgs(this.argv);
		const parsed = parseArgs(args);
		if (parsed.unknownFlags.size > 0) {
			throw new CliParseError(`Unknown ACP option: ${[...parsed.unknownFlags.keys()].join(", ")}`);
		}
		if (terminalAuth && parsed.mode !== undefined) {
			throw new CliParseError("--acp-terminal-auth only supports --mode acp");
		}
		if (!terminalAuth) {
			parsed.mode = "acp";
		}
		await runRootCommand(parsed, args);
	}
}
