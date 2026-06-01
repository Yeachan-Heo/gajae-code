import { Command } from "@gajae-code/utils/cli";
import { runNativeStateCommand } from "../gjc-runtime/state-runtime";

export default class State extends Command {
	static description = "Read or update GJC workflow state receipts under .gjc/state";
	static strict = false;
	static examples = [
		'$ gjc state read --input \'{"mode":"deep-interview"}\' --json',
		'$ gjc state write --input \'{"state":{"interview_id":"abc"}}\' --mode deep-interview --json',
		"$ gjc state clear --mode deep-interview",
		"$ gjc state deep-interview read --json",
		'$ gjc state ralplan write --input \'{"phase":"approval","active":true}\' --json',
		"$ gjc state team contract",
		"$ gjc state deep-interview handoff --to ralplan --json",
	];

	async run(): Promise<void> {
		const result = await runNativeStateCommand(this.argv);
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		process.exitCode = result.status;
	}
}
