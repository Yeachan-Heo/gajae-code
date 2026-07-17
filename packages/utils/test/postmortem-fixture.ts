import * as fs from "node:fs";

import * as logger from "../src/logger";
import * as postmortem from "../src/postmortem";

logger.setTransports({ console: true, file: false });

type ExitListener = (code?: number) => unknown;

interface EpipeDetails {
	fd?: number;
	syscall?: string;
}

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

function epipeError(message: string, details: EpipeDetails): Error {
	return Object.assign(new Error(message), { code: "EPIPE", ...details });
}

async function throwFromTimer(error: Error): Promise<void> {
	setTimeout(() => {
		throw error;
	}, 10);
	await Bun.sleep(2_000);
}

function writeUntilStdoutPipeBreaks(): void {
	for (let i = 0; i < 256; i++) {
		process.stdout.write(`${"x".repeat(8192)}\n`);
	}
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
	postmortem.register("fixture-non-exit-recursion", async () => {
		count++;
		await postmortem.cleanup();
	});

	await postmortem.cleanup();
	await Bun.sleep(20);
	writeResult({ count });
}

async function runQuitReentryWaitsForCleanup(): Promise<void> {
	let count = 0;
	let cleanupFinished = false;
	let exitBeforeCleanupFinished = false;
	const originalExit = process.exit;
	process.exit = (() => {
		exitBeforeCleanupFinished = !cleanupFinished;
	}) as typeof process.exit;

	try {
		postmortem.register("fixture-quit-reentry-slow", async () => {
			count++;
			await Bun.sleep(20);
			cleanupFinished = true;
		});
		postmortem.register("fixture-quit-reentry", () => {
			count++;
			void postmortem.quit();
		});

		await postmortem.cleanup();
	} finally {
		process.exit = originalExit;
	}

	writeResult({ count, exitBeforeCleanupFinished });
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

async function runBrokenPipeStdoutWrite(): Promise<void> {
	// The test harness runs this scenario as `bun fixture.ts ... | true`, so the
	// stdout pipe's read end is closed almost immediately. Under Bun the write
	// below throws EPIPE synchronously from a timer and reaches the postmortem
	// uncaughtException handler without a fixture-side catch.
	await Bun.sleep(50);
	setTimeout(writeUntilStdoutPipeBreaks, 10);
	await Bun.sleep(2_000);
}

async function runBrokenPipeUnhandledRejection(): Promise<void> {
	// A synchronous stdout EPIPE inside a promise continuation becomes an
	// unhandled rejection. The postmortem stdout marker must preserve ownership.
	await Bun.sleep(50);
	setTimeout(() => {
		void Promise.resolve().then(writeUntilStdoutPipeBreaks);
	}, 10);
	await Bun.sleep(2_000);
}

async function runStdoutFdUnhandledRejection(): Promise<void> {
	const error = {
		code: "EPIPE",
		fd: process.stdout.fd,
		syscall: "write",
	};
	void Promise.reject(error);
	await Bun.sleep(2_000);
}

async function runStdoutFdMissingSyscallEpipe(): Promise<void> {
	await throwFromTimer(epipeError("fixture: stdout fd EPIPE without syscall", { fd: process.stdout.fd }));
}

async function runQuietCleanupFailure(resultPath: string | undefined): Promise<void> {
	if (!resultPath) throw new Error("quiet cleanup fixture requires a result path");

	let count = 0;
	postmortem.register("fixture-quiet-cleanup-failure", async () => {
		count++;
		await Bun.write(resultPath, JSON.stringify({ count }));
		// This second real stdout EPIPE arrives while the first quiet handler is
		// awaiting cleanup. It must be ignored without diagnostic recursion.
		setTimeout(() => {
			process.stdout.write("repeat quiet cleanup EPIPE\n");
		}, 0);
		await Bun.sleep(20);
		throw new Error("fixture: quiet cleanup failure");
	});
	await runBrokenPipeStdoutWrite();
}

async function runQuietCleanupThenOrdinaryFatal(resultPath: string | undefined): Promise<void> {
	if (!resultPath) throw new Error("quiet cleanup fixture requires a result path");

	let count = 0;
	postmortem.register("fixture-quiet-cleanup-ordinary-fatal", async () => {
		count++;
		await Bun.write(resultPath, JSON.stringify({ count }));
		setTimeout(() => {
			throw new Error("fixture: ordinary fatal during quiet cleanup");
		}, 0);
		await Bun.sleep(20);
	});
	await runBrokenPipeStdoutWrite();
}

async function runQuietCleanupLateRegistration(resultPath: string | undefined): Promise<void> {
	if (!resultPath) throw new Error("quiet cleanup fixture requires a result path");

	let count = 0;
	postmortem.register("fixture-quiet-cleanup-late-registration", async () => {
		count++;
		postmortem.register("fixture-quiet-late-registration", () => {
			count++;
		});
		await Bun.sleep(20);
		await Bun.write(resultPath, JSON.stringify({ count }));
	});
	await runBrokenPipeStdoutWrite();
}

async function runOrdinaryFatalThenBrokenPipe(resultPath: string | undefined): Promise<void> {
	if (!resultPath) throw new Error("ordinary fatal fixture requires a result path");

	let count = 0;
	postmortem.register("fixture-ordinary-fatal-then-broken-pipe", async () => {
		count++;
		await Bun.write(resultPath, JSON.stringify({ count }));
		setTimeout(writeUntilStdoutPipeBreaks, 0);
		await Bun.sleep(20);
		throw new Error("fixture: ordinary cleanup failure");
	});
	await throwFromTimer(new Error("fixture: ordinary fatal before quiet EPIPE"));
}

async function runSocketSendEpipe(): Promise<void> {
	await throwFromTimer(epipeError("fixture: socket send EPIPE", { fd: process.stdout.fd, syscall: "send" }));
}

async function runUnrelatedFdWriteEpipe(): Promise<void> {
	await throwFromTimer(epipeError("fixture: unrelated fd write EPIPE", { fd: process.stderr.fd, syscall: "write" }));
}

async function runMissingFdWriteEpipe(): Promise<void> {
	await throwFromTimer(epipeError("fixture: missing fd write EPIPE", { syscall: "write" }));
}

async function runInvalidFdWriteEpipe(): Promise<void> {
	await throwFromTimer(epipeError("fixture: invalid fd write EPIPE", { fd: -1, syscall: "write" }));
}

async function runClosedFdWriteEpipe(): Promise<void> {
	const fd = fs.openSync("/dev/null", "r");
	fs.closeSync(fd);
	await throwFromTimer(epipeError("fixture: closed fd write EPIPE", { fd, syscall: "write" }));
}

async function runReusedFdWriteEpipe(): Promise<void> {
	const staleFd = fs.openSync("/dev/null", "r");
	fs.closeSync(staleFd);
	const reusedFd = fs.openSync("/dev/null", "r");
	await throwFromTimer(epipeError("fixture: reused fd write EPIPE", { fd: reusedFd, syscall: "write" }));
}

async function runDestroyedStreamError(): Promise<void> {
	const error = Object.assign(new Error("fixture: destroyed stream"), {
		code: "ERR_STREAM_DESTROYED",
		fd: process.stdout.fd,
		syscall: "write",
	});
	await throwFromTimer(error);
}

async function runNonPipeUncaughtException(): Promise<void> {
	await throwFromTimer(new Error("fixture: genuine fatal error"));
}

async function runNonPipeUnhandledRejection(): Promise<void> {
	void Promise.reject(new Error("fixture: genuine rejected fatal error"));
	await Bun.sleep(2_000);
}

const scenario = process.argv[2];
switch (scenario) {
	case "exit-reentry-while-running":
		await runExitReentryWhileRunning();
		break;
	case "non-exit-recursive-cleanup":
		await runNonExitRecursiveCleanup();
		break;
	case "quit-reentry-waits-for-cleanup":
		await runQuitReentryWaitsForCleanup();
		break;
	case "completed-cleanup-exit-noop":
		await runCompletedCleanupExitNoop();
		break;
	case "broken-pipe-stdout-write":
		await runBrokenPipeStdoutWrite();
		break;
	case "broken-pipe-unhandled-rejection":
		await runBrokenPipeUnhandledRejection();
		break;
	case "stdout-fd-unhandled-rejection":
		await runStdoutFdUnhandledRejection();
		break;
	case "stdout-fd-missing-syscall-epipe":
		await runStdoutFdMissingSyscallEpipe();
		break;
	case "quiet-cleanup-failure":
		await runQuietCleanupFailure(process.argv[3]);
		break;
	case "quiet-cleanup-ordinary-fatal":
		await runQuietCleanupThenOrdinaryFatal(process.argv[3]);
		break;
	case "quiet-cleanup-late-registration":
		await runQuietCleanupLateRegistration(process.argv[3]);
		break;
	case "ordinary-fatal-then-broken-pipe":
		await runOrdinaryFatalThenBrokenPipe(process.argv[3]);
		break;
	case "socket-send-epipe":
		await runSocketSendEpipe();
		break;
	case "unrelated-fd-write-epipe":
		await runUnrelatedFdWriteEpipe();
		break;
	case "missing-fd-write-epipe":
		await runMissingFdWriteEpipe();
		break;
	case "invalid-fd-write-epipe":
		await runInvalidFdWriteEpipe();
		break;
	case "closed-fd-write-epipe":
		await runClosedFdWriteEpipe();
		break;
	case "reused-fd-write-epipe":
		await runReusedFdWriteEpipe();
		break;
	case "destroyed-stream-error":
		await runDestroyedStreamError();
		break;
	case "non-pipe-uncaught-exception":
		await runNonPipeUncaughtException();
		break;
	case "non-pipe-unhandled-rejection":
		await runNonPipeUnhandledRejection();
		break;
	default:
		throw new Error(`unknown postmortem fixture scenario: ${scenario ?? "(missing)"}`);
}
