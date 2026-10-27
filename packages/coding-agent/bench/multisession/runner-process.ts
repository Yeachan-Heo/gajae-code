/**
 * Standalone-arm root: one OS process running exactly one session.
 *
 * argv: <sessionIndex> <rootDir> <idleMs> <variant>
 * Blocks on the driver's ack (cohort registration) before doing any work,
 * then runs the shared session runner and exits after disposal.
 */
import { driverCommands, emitToDriver } from "./channel";
import { runSession } from "./session-runner";
import type { WorkloadVariant } from "./workload";
import type { RunnerCommand } from "./types";

async function main(): Promise<void> {
	const [indexArg, rootDir, idleArg, variantArg] = process.argv.slice(2);
	const sessionIndex = Number(indexArg);
	const idleMs = Number(idleArg);
	if (!Number.isSafeInteger(sessionIndex) || !rootDir || !Number.isFinite(idleMs)) {
		throw new Error("usage: runner-process.ts <sessionIndex> <rootDir> <idleMs> <full|preflight>");
	}
	const variant = (variantArg ?? "full") as WorkloadVariant;
	const commands = driverCommands<RunnerCommand>();
	// Ack is consumed inside driverCommands; wait for `start` so the driver
	// controls the common cold-start instant across sessions.
	for await (const command of commands) {
		if (command.type === "start") break;
	}
	try {
		const { evidenceDir } = await runSession({ sessionIndex, rootDir, idleMs, emit: emitToDriver, workloadVariant: variant });
		emitToDriver({ type: "done", sessionIndex, evidenceDir });
	} catch (error) {
		emitToDriver({ type: "error", sessionIndex, message: error instanceof Error ? error.stack ?? error.message : String(error) });
		process.exitCode = 1;
	}
}

await main();
process.exit();
