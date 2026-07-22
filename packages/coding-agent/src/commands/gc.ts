import { Command, Flags } from "@gajae-code/utils/cli";
import { runGjcGcCommand } from "../gjc-runtime/gc-runtime";

export default class Gc extends Command {
	static description = "Garbage-collect stale GJC session/PID records (dry-run by default)";
	static strict = false;
	static flags = {
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON", default: false }),
		prune: Flags.boolean({ description: "Remove stale records (default: report only)", default: false }),
		force: Flags.boolean({ description: "Alias for --prune (eligible records only)", default: false }),
		"dry-run": Flags.boolean({ description: "Force report-only mode", default: false }),
		"repair-session-index": Flags.boolean({
			description: "Quarantine a corrupt session-index suffix and retain its valid prefix",
			default: false,
		}),
	};

	static examples = [
		"gjc gc",
		"gjc gc --json",
		"gjc gc --prune",
		"gjc gc --prune --json",
		"gjc gc --repair-session-index --json",
	];

	async run(): Promise<void> {
		const result = await runGjcGcCommand(this.argv, process.cwd(), process.env);
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		process.exitCode = result.status;
	}
}
