import { Command } from "@gajae-code/utils/cli";
import { ensureWorkflowSettingsMigrated } from "../config/settings";
import { isAutoresearchHelpInvocation, runNativeAutoresearchCommand } from "../gjc-runtime/autoresearch-runtime";

export default class Autoresearch extends Command {
	static description = "Run native GJC Autoresearch workflow commands";
	static strict = false;
	static examples = [
		"$ gjc autoresearch intake --spec <deep-interview-spec.md> --json",
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
		// retire legacy settings.json): render help before the trigger. The
		// native runtime owns help rendering because it is verb-aware — dropping
		// to a generic command-level renderer here would discard the verb and
		// hide every per-verb flag (`verdict --help`, `critic --help`, ...).
		if (isAutoresearchHelpInvocation(this.argv)) {
			const help = await runNativeAutoresearchCommand(this.argv, process.cwd());
			if (help.stdout) process.stdout.write(help.stdout);
			if (help.stderr) process.stderr.write(help.stderr);
			process.exitCode = help.status;
			return;
		}
		await ensureWorkflowSettingsMigrated(process.cwd());
		const result = await runNativeAutoresearchCommand(this.argv, process.cwd());
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		process.exitCode = result.status;
	}
}
