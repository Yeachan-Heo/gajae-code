import * as logger from "../src/logger";
import * as postmortem from "../src/postmortem";

logger.setTransports({ console: true, file: false });

type ExitListener = (code?: number) => unknown;

function getPostmortemExitListener(): ExitListener {
	const listener = process.rawListeners("exit").at(-1);
	if (!listener) {
		throw new Error("postmortem exit listener was not registered");
	}
	return listener as ExitListener;
}

function writeResult(result: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function runExitReentryWhileRunning(): Promise<void> {
	let count = 0;
	const exitListener = getPostmortemExitListener();
	postmortem.register("fixture-exit-reentry", async () => {
		count++;
		await Promise.resolve(exitListener(0));
	});

	await postmortem.cleanup();
	await Bun.sleep(20);
	writeResult({ count });
}

async function runNonExitRecursiveCleanup(): Promise<void> {
	let count = 0;
	postmortem.register("fixture-non-exit-recursion", () => {
		count++;
		void postmortem.cleanup();
	});

	await postmortem.cleanup();
	await Bun.sleep(20);
	writeResult({ count });
}

async function runCompletedCleanupExitNoop(): Promise<void> {
	let count = 0;
	const exitListener = getPostmortemExitListener();
	postmortem.register("fixture-complete-exit", () => {
		count++;
	});

	await postmortem.cleanup();
	await Promise.resolve(exitListener(0));
	await Bun.sleep(20);
	writeResult({ count });
}

const scenario = process.argv[2];
switch (scenario) {
	case "exit-reentry-while-running":
		await runExitReentryWhileRunning();
		break;
	case "non-exit-recursive-cleanup":
		await runNonExitRecursiveCleanup();
		break;
	case "completed-cleanup-exit-noop":
		await runCompletedCleanupExitNoop();
		break;
	default:
		throw new Error(`unknown postmortem fixture scenario: ${scenario ?? "(missing)"}`);
}
