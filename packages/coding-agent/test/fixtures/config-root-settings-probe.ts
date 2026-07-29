/**
 * Prints the workflow settings resolved for the current working directory.
 * `GJC_CONFIG_DIR` is read at module load, so this must be a child process.
 */
import { resolveRalplanAutoHandoff, resolveRalplanMaxIterations } from "../../src/gjc-runtime/ralplan-runtime";
import { resolveUltragoalNudgeBudget } from "../../src/gjc-runtime/ultragoal-runtime";

const cwd = process.cwd();
const autoHandoff = process.argv.includes("--ralplan-auto-handoff") ? await resolveRalplanAutoHandoff(cwd) : undefined;
console.log(
	JSON.stringify({
		ralplan: await resolveRalplanMaxIterations(cwd),
		ultragoal: await resolveUltragoalNudgeBudget(cwd),
		autoHandoff,
	}),
);
