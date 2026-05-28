import { Command } from "@gajae-code/utils/cli";
import {
	GJC_SESSION_FILE_ENV,
	isUltragoalCreateGoalsInvocation,
	readUltragoalGjcObjective,
	writeCurrentSessionGoalModeState,
	writePendingGoalModeRequest,
} from "../gjc-runtime/goal-mode-request";
import {
	buildUltragoalHudSummary,
	getUltragoalStatus,
	readUltragoalLedger,
	runNativeUltragoalCommand,
} from "../gjc-runtime/ultragoal-runtime";
import { syncSkillActiveState } from "../skill-state/active-state";

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
		try {
			const summary = await getUltragoalStatus(process.cwd());
			const ledger = await readUltragoalLedger(process.cwd());
			await syncSkillActiveState({
				cwd: process.cwd(),
				skill: "ultragoal",
				active: summary.exists && summary.status !== "complete",
				phase: summary.status,
				hud: buildUltragoalHudSummary(summary, ledger.at(-1)),
				source: "gjc-ultragoal",
			});
		} catch {
			// HUD sync is best-effort and must not change command semantics.
		}
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
