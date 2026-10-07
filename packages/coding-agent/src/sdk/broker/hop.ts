import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as process from "node:process";
import type { Process } from "@gajae-code/natives";
import { nativeProcessBindings } from "@gajae-code/utils/native-process";
import type { BrokerHopMessage } from "./ensure";

/**
 * Windows broker hop: spawns the real broker with detached:true and reports its pid.
 *
 * The hop is needed because a broker spawned with detached:true IS still killed when the
 * parent process tree is terminated (e.g., by taskkill /T /F on Windows). Using an
 * intermediate hop process that exits after spawning the real broker allows the broker
 * to survive, because the hop's parent (the initiating client) can be killed without
 * affecting the broker (the hop's pid is no longer valid).
 *
 * Invoked by gjc internals only. Usage:
 *   gjc internal broker-hop <json-encoded-args>
 *
 * Exits with code 0 after writing the broker pid and incarnation to stdout as JSON.
 * Exits with code 1 on spawn failure (error logged to stderr).
 */

export async function runBrokerHopFromArgv(argv: string[]): Promise<void> {
	if (argv.length !== 1) fail("broker hop requires exactly one argument");
	let message: BrokerHopMessage;
	try {
		message = JSON.parse(argv[0]) as BrokerHopMessage;
	} catch (error) {
		fail(`broker hop JSON parse error: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!message.command?.file || !Array.isArray(message.command.args)) fail("broker hop message missing command");
	try {
		// stderr is opened here by path: a parent fd number is meaningless in this process.
		const stderr = message.stderrLogPath ? fs.openSync(message.stderrLogPath, "a") : "ignore";
		// The broker inherits this process's environment, which the parent set to the
		// broker environment; it is never carried on the command line.
		const child = childProcess.spawn(message.command.file, message.command.args, {
			detached: true,
			windowsHide: true,
			stdio: ["ignore", "ignore", stderr],
			env: process.env,
			...(message.cwd ? { cwd: message.cwd } : {}),
		});
		if (typeof stderr === "number") fs.closeSync(stderr);
		const spawned = Promise.withResolvers<void>();
		child.once("spawn", spawned.resolve);
		child.once("error", spawned.reject);
		await spawned.promise;
		const pid = child.pid;
		if (pid === undefined) fail("broker hop spawn succeeded but child pid unavailable");
		const childReference = getSpawnedChildReference(pid);
		if (!childReference) {
			const cleanup = await terminateUnverifiableWindowsChild(child);
			fail(`broker process identity could not be bound to the spawned child; ${cleanup}`);
		}
		const handoff = await writeBrokerHopReply(child, childReference, pid, writeBrokerHopStdout);
		if (handoff.kind === "failed") fail(handoff.reason);
		process.exit(0);
	} catch (error) {
		fail(`broker hop spawn failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

type BrokerHopWriteCallback = (error?: Error | null) => void;
type BrokerHopWriter = (chunk: string, callback: BrokerHopWriteCallback) => void;

async function writeBrokerHopReply(
	child: childProcess.ChildProcess,
	reference: Process,
	pid: number,
	write: BrokerHopWriter,
): Promise<{ kind: "written" } | { kind: "failed"; reason: string }> {
	const completion = Promise.withResolvers<void>();
	let settled = false;
	const settle = (error?: Error | null): void => {
		if (settled) return;
		settled = true;
		if (error) completion.reject(error);
		else completion.resolve();
	};
	try {
		write(`${JSON.stringify({ pid, incarnation: reference.incarnation })}\n`, settle);
	} catch (error) {
		settle(error instanceof Error ? error : new Error(String(error)));
	}
	try {
		await completion.promise;
		child.unref();
		return { kind: "written" };
	} catch (error) {
		const writeError = error instanceof Error ? error : new Error(String(error));
		const cleanup = await terminateBrokerAfterFailedHandoff(reference);
		return {
			kind: "failed",
			reason: `broker hop handoff failed for pid ${pid}: ${cleanup}; ${writeError.message}`,
		};
	}
}

export function writeBrokerHopReplyForTest(
	child: childProcess.ChildProcess,
	reference: Process,
	pid: number,
	write: BrokerHopWriter,
): Promise<{ kind: "written" } | { kind: "failed"; reason: string }> {
	return writeBrokerHopReply(child, reference, pid, write);
}

const writeBrokerHopStdout: BrokerHopWriter = (chunk, callback): void => {
	const onError = (error: Error): void => {
		process.stdout.removeListener("error", onError);
		callback(error);
	};
	process.stdout.once("error", onError);
	try {
		process.stdout.write(chunk, error => {
			process.stdout.removeListener("error", onError);
			callback(error);
		});
	} catch (error) {
		process.stdout.removeListener("error", onError);
		callback(error instanceof Error ? error : new Error(String(error)));
	}
};

/** Pin only the still-running direct child so a reused PID cannot be adopted. */
function getSpawnedChildReference(pid: number): Process | undefined {
	try {
		const reference = nativeProcessBindings().Process.fromPid(pid);
		if (!reference || reference.pid !== pid || reference.ppid !== process.pid || reference.status() !== "running")
			return undefined;
		return reference;
	} catch {
		return undefined;
	}
}

async function terminateUnverifiableWindowsChild(child: childProcess.ChildProcess): Promise<string> {
	if (process.platform !== "win32") return "no signal was sent without a verified process identity";
	if (child.exitCode !== null || child.signalCode !== null) return "the spawned child already exited";
	const exited = Promise.withResolvers<void>();
	child.once("exit", exited.resolve);
	child.once("close", exited.resolve);
	child.on("error", () => {});
	try {
		child.kill("SIGKILL");
	} catch {
		// The process handle remains exact; inspect its exit state below.
	}
	await Promise.race([exited.promise, Bun.sleep(500)]);
	return child.exitCode !== null || child.signalCode !== null
		? "the exact spawned child was terminated"
		: "termination of the exact spawned child was not confirmed";
}

async function terminateBrokerAfterFailedHandoff(reference: Process): Promise<string> {
	let cleanup: string;
	try {
		if (reference.status() === "running") reference.signalRoot(os.constants.signals.SIGKILL);
		const exited = await reference.waitForExit({ timeoutMs: 500 });
		cleanup =
			exited || reference.status() !== "running" ? "broker terminated" : "broker termination was not confirmed";
	} catch (error) {
		cleanup = `broker termination failed: ${error instanceof Error ? error.message : String(error)}`;
	}
	return cleanup;
}

function fail(message: string): never {
	process.stderr.write(`gjc: ${message}\n`);
	process.exit(1);
}
