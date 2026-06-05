import { Command } from "@gajae-code/utils/cli";
import {
	GJC_SESSION_FILE_ENV,
	isUltragoalCreateGoalsInvocation,
	readUltragoalGjcObjective,
	writeCurrentSessionGoalModeState,
	writePendingGoalModeRequest,
} from "../gjc-runtime/goal-mode-request";
import { runNativeUltragoalCommand } from "../gjc-runtime/ultragoal-runtime";

export default class Ultragoal extends Command {
	static description = "Run native GJC Ultragoal workflow commands";
	static strict = false;
	static examples = ["$ gjc ultragoal status --json"];

	async run(): Promise<void> {
		const shouldActivateGoalMode = isUltragoalCreateGoalsInvocation(this.argv);
		const result = await runNativeUltragoalCommand(this.argv);
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		process.exitCode = result.status;
		if (result.status !== 0 || !shouldActivateGoalMode) return;

		const cwd = process.cwd();
		const { objective, goalsPath } = await readUltragoalGjcObjective(cwd);
		await writeCurrentSessionGoalModeState({
			sessionFile: process.env[GJC_SESSION_FILE_ENV],
			objective,
		});
		await writePendingGoalModeRequest({ cwd, objective, goalsPath });
	}
}
