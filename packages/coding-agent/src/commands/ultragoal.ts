import { Command } from "@gajae-code/utils/cli";
import {
	isUltragoalCreateGoalsInvocation,
	readUltragoalCodexObjective,
	writePendingGoalModeRequest,
} from "../gjc-runtime/goal-mode-request";
import { runGjcRuntimeBridge } from "./gjc-runtime-bridge";

export default class Ultragoal extends Command {
	static description = "Run private GJC Ultragoal workflow commands";
	static strict = false;
	static examples = ["$ gjc ultragoal status --json"];

	async run(): Promise<void> {
		const shouldActivateGoalMode = isUltragoalCreateGoalsInvocation(this.argv);
		const result = runGjcRuntimeBridge("ultragoal", this.argv);
		if (result.error) process.stderr.write(`${result.error}\n`);
		process.exitCode = result.status;
		if (result.status !== 0 || !shouldActivateGoalMode) return;

		const cwd = process.cwd();
		const { objective, goalsPath } = await readUltragoalCodexObjective(cwd);
		await writePendingGoalModeRequest({ cwd, objective, goalsPath });
	}
}
