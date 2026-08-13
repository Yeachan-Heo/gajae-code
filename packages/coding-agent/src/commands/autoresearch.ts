import { Command, renderCommandHelp } from "@gajae-code/utils/cli";
import { ensureWorkflowSettingsMigrated } from "../config/settings";
import { runNativeAutoresearchCommand } from "../gjc-runtime/autoresearch-runtime";

export default class Autoresearch extends Command {
	static description = "Run native GJC Autoresearch workflow commands";
	static strict = false;
	static examples = [
		"$ gjc autoresearch --spec <deep-interview-spec.md> --json",
		'$ gjc autoresearch "<goal>"',
		"$ gjc autoresearch",
		"$ gjc autoresearch read --json",
		"$ gjc autoresearch clear --json",
		"$ gjc autoresearch write --goal <goal> --mode web --slug <slug> --json",
	];
	static delegateHelp = true;

	async run(): Promise<void> {
		// A read-only help request must not perform the workflow-settings
		// migration (which can create/drain agent.db, write config.yml, and
		// retire legacy settings.json): render help before the trigger.
		if (this.argv.includes("--help") || this.argv.includes("-h")) {
			renderCommandHelp("gjc", "autoresearch", Autoresearch);
			return;
		}
		await ensureWorkflowSettingsMigrated(process.cwd());
		const result = await runNativeAutoresearchCommand(this.argv, process.cwd());
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		process.exitCode = result.status;
	}
}
