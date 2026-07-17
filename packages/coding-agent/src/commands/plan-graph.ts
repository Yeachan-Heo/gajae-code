import { Command } from "@gajae-code/utils/cli";
import { runNativePlanGraphCommand } from "../gjc-runtime/plan-graph-runtime";

export default class PlanGraph extends Command {
	static description =
		"Derive a mermaid dependency DAG from a plan document's Plan Steps table (deterministic, idempotent)";
	static strict = false;
	static examples = [
		"$ gjc plan-graph .gjc/_session-abc/plans/ralplan/run-1/pending-approval.md",
		"$ gjc plan-graph plan.md --check",
		"$ gjc plan-graph plan.md --format ascii",
		"$ gjc plan-graph plan.md --json",
	];

	async run(): Promise<void> {
		const result = await runNativePlanGraphCommand(this.argv, process.cwd());
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		process.exitCode = result.status;
	}
}
