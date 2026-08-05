import { Command, Flags } from "@gajae-code/utils/cli";
import { runGjcGcCommand } from "../gjc-runtime/gc-runtime";

export default class Gc extends Command {
	static description = "Garbage-collect stale GJC session/PID records and optional disk caches (dry-run by default)";
	static strict = false;
	static flags = {
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON", default: false }),
		prune: Flags.boolean({ description: "Remove stale records (default: report only)", default: false }),
		force: Flags.boolean({ description: "Alias for --prune (eligible records only)", default: false }),
		"dry-run": Flags.boolean({ description: "Force report-only mode", default: false }),
		disk: Flags.boolean({
			description:
				"Opt-in disk-retention pass (natives version caches; dry-run unless --prune). Sessions/blobs/backups are follow-ups.",
			default: false,
		}),
		"natives-keep-versions": Flags.integer({
			description: "With --disk: keep the running natives version plus this many older predecessors (default: 2)",
		}),
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
		"gjc gc --disk",
		"gjc gc --disk --json",
		"gjc gc --disk --prune",
		"gjc gc --disk --natives-keep-versions 1 --prune --json",
		"gjc gc --repair-session-index --json",
	];

	async run(): Promise<void> {
		const result = await runGjcGcCommand(this.argv, process.cwd(), process.env);
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		process.exitCode = result.status;
	}
}
