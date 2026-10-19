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
import { trustedCoordinatorEnv } from "../gjc-runtime/sidecar-bootstrap-env";
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
			// Bun has already copied the project dotenv into the environment. A
			// value that matches that snapshot must not select the transcript.
			sessionFile: trustedCoordinatorEnv(GJC_SESSION_FILE_ENV),
			objective,
			provenance,
		});
		// A matching or dynamic project declaration must not select the session.
		// Skip the write in that case: the helper falls back to the same env value.
		const sessionId = trustedCoordinatorEnv(GJC_SESSION_ID_ENV);
		if (sessionId !== undefined || !process.env[GJC_SESSION_ID_ENV]?.trim()) {
			await writePendingGoalModeRequest({
				cwd,
				objective,
				goalsPath,
				provenance,
				sessionId,
			});
		}
	}
}
