import { Command } from "@gajae-code/utils/cli";
import { ensureWorkflowSettingsMigrated } from "../config/settings";
import {
	GJC_SESSION_FILE_ENV,
	GJC_SESSION_ID_ENV,
	isUltragoalCreateGoalsInvocation,
	readUltragoalGjcObjective,
	writeCurrentSessionGoalModeState,
	writePendingGoalModeRequest,
} from "../gjc-runtime/goal-mode-request";
import { isUltragoalHelpInvocation, runNativeUltragoalCommand } from "../gjc-runtime/ultragoal-runtime";

export default class Ultragoal extends Command {
	static description = "Run native GJC Ultragoal workflow commands";
	static strict = false;
	static examples = ["$ gjc ultragoal status --json"];
	static delegateHelp = true;

	async run(): Promise<void> {
		// A read-only help request must not perform the workflow-settings
		// migration (which can create/drain agent.db, write config.yml, and
		// retire legacy settings.json): render help before the trigger. The
		// native runtime owns help rendering because it is verb-aware — dropping
		// to a generic command-level renderer here would discard the verb and
		// hide every per-verb flag (`review --help`, `checkpoint --help`, ...).
		if (isUltragoalHelpInvocation(this.argv)) {
			const help = await runNativeUltragoalCommand(this.argv);
			if (help.stdout) process.stdout.write(help.stdout);
			if (help.stderr) process.stderr.write(help.stderr);
			process.exitCode = help.status;
			return;
		}
		await ensureWorkflowSettingsMigrated(process.cwd());
		const isReviewStart = this.argv.includes("review") && this.argv.includes("review-start");
		const shouldActivateGoalMode = isUltragoalCreateGoalsInvocation(this.argv);
		const result = await runNativeUltragoalCommand(this.argv);
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		process.exitCode = result.status;
		if (result.status !== 0 || (!shouldActivateGoalMode && !isReviewStart)) return;
		if (isReviewStart && !result.createdReviewPlan && (result.reviewBlockerGoalIds?.length ?? 0) === 0) return;

		const cwd = process.cwd();
		const { objective, goalsPath, provenance } = await readUltragoalGjcObjective(cwd);

		await writeCurrentSessionGoalModeState({
			sessionFile: process.env[GJC_SESSION_FILE_ENV],
			objective,
			provenance,
		});
		await writePendingGoalModeRequest({
			cwd,
			objective,
			goalsPath,
			provenance,
			sessionId: process.env[GJC_SESSION_ID_ENV],
		});
	}
}
