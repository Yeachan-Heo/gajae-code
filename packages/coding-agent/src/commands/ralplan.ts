import { Command } from "@gajae-code/utils/cli";
import { runNativeRalplanCommand } from "../gjc-runtime/ralplan-runtime";

export default class Ralplan extends Command {
	static description = "Run native GJC RALPLAN consensus planning workflow";
	static strict = false;
	static examples = [
		'$ gjc ralplan "<task description>"',
		'$ gjc ralplan --interactive --deliberate "<task description>"',
		'$ gjc ralplan --write --stage planner --stage_n 1 --artifact "<markdown or path>"',
		"$ gjc ralplan --write --stage critic --stage_n 1 --artifact-env GJC_RALPLAN_ARTIFACT",
	];

	async run(): Promise<void> {
		const result = await runNativeRalplanCommand(this.argv, process.cwd());
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		process.exitCode = result.status;
	}
}
