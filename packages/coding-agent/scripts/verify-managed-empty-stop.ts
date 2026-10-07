import {
	assertExecutedScenarios,
	parseHarnessPort,
	runManagedEmptyStopScenario,
	scenarioNames,
} from "../test/helpers/managed-empty-stop-harness";

export async function main(args = process.argv.slice(2)): Promise<number> {
	let executed = 0;
	try {
		const scenarios = scenarioNames(args);
		const port = parseHarnessPort();
		for (const scenario of scenarios) {
			executed++;
			const report = await runManagedEmptyStopScenario(scenario, port);
			process.stdout.write(`PASS ${scenario}: ${report.providerModels.join(" -> ")}, ${report.terminal.status}\n`);
		}
		assertExecutedScenarios(executed);
		return 0;
	} catch (error) {
		process.stderr.write(`FAIL managed-empty-stop: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	} finally {
		process.stdout.write(`managed-empty-stop: executed ${executed} scenario(s)\n`);
	}
}

if (import.meta.main) process.exitCode = await main();
