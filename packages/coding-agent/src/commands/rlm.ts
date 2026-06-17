/**
 * `gjc rlm` — opt-in Jupyter-style research session with a persistent Python kernel.
 */
import { Command } from "@gajae-code/utils/cli";
import { runRlmCommand } from "../rlm";

export default class Rlm extends Command {
	static description = "Opt-in research session: persistent Python kernel, live notebook, synthesized report";
	static strict = false;
	static examples = [
		"# Start an interactive research session\n  gjc rlm",
		'# Seed the session with an initial question\n  gjc rlm "What drives the spike in the orders table?"',
		"# Point the session at a data description\n  gjc rlm --data ./datasets/DATA.md",
	];

	async run(): Promise<void> {
		await runRlmCommand(this.argv);
	}
}
