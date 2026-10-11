import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as process from "node:process";
import type * as stream from "node:stream";
import type { Process } from "@gajae-code/natives";
import { nativeProcessBindings } from "@gajae-code/utils/native-process";
import type { BrokerHopMessage } from "./ensure";

export const BROKER_HANDOFF_ACKNOWLEDGEMENT = "GJC_BROKER_HANDOFF_ACK\n";
export const BROKER_HANDOFF_COMMIT = "GJC_BROKER_HANDOFF_COMMIT\n";
export const BROKER_HANDOFF_ABORT = "GJC_BROKER_HANDOFF_ABORT\n";

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
 * Exits with code 0 after writing the broker pid/incarnation to stdout and
 * receiving the parent's acknowledgement. If stdin closes first, it terminates
 * the pinned broker and exits with code 1.
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
		const handoff = await writeBrokerHopReply(child, childReference, pid, writeBrokerHopStdout, () =>
			waitForBrokerHandoffAcknowledgement(process.stdin),
		);
		if (handoff.kind === "failed") fail(handoff.reason);
		process.exit(0);
	} catch (error) {
		fail(`broker hop spawn failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

type BrokerHopWriteCallback = (error?: Error | null) => void;
type BrokerHopWriter = (chunk: string, callback: BrokerHopWriteCallback) => void;
type BrokerHopAcknowledger = () => Promise<boolean>;

async function writeBrokerHopReply(
	child: childProcess.ChildProcess,
	reference: Process,
	pid: number,
	write: BrokerHopWriter,
	waitForAcknowledgement: BrokerHopAcknowledger,
): Promise<{ kind: "written" } | { kind: "failed"; reason: string }> {
	const completion = Promise.withResolvers<void>();
	const acknowledgementPromise = waitForAcknowledgement();
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
	} catch (error) {
		const writeError = error instanceof Error ? error : new Error(String(error));
		const cleanup = await terminateBrokerAfterFailedHandoff(reference);
		return {
			kind: "failed",
			reason: `broker hop handoff failed for pid ${pid}: ${cleanup}; ${writeError.message}`,
		};
	}
	let acknowledged = false;
	let acknowledgementError: string | undefined;
	try {
		acknowledged = await acknowledgementPromise;
	} catch (error) {
		acknowledgementError = error instanceof Error ? error.message : String(error);
	}
	if (!acknowledged) {
		const cleanup = await terminateBrokerAfterFailedHandoff(reference);
		return {
			kind: "failed",
			reason: `broker hop handoff was not acknowledged for pid ${pid}: ${cleanup}${acknowledgementError ? `; ${acknowledgementError}` : ""}`,
		};
	}
	child.unref();
	return { kind: "written" };
}

export function writeBrokerHopReplyForTest(
	child: childProcess.ChildProcess,
	reference: Process,
	pid: number,
	write: BrokerHopWriter,
	waitForAcknowledgement: BrokerHopAcknowledger = async () => true,
): Promise<{ kind: "written" } | { kind: "failed"; reason: string }> {
	return writeBrokerHopReply(child, reference, pid, write, waitForAcknowledgement);
}

export function waitForBrokerHandoffAcknowledgement(input: stream.Readable): Promise<boolean> {
	const acknowledgment = Promise.withResolvers<boolean>();
	let received = "";
	let settled = false;
	const finish = (accepted: boolean): void => {
		if (settled) return;
		settled = true;
		input.removeListener("data", onData);
		input.removeListener("end", onEnd);
		input.removeListener("close", onEnd);
		input.removeListener("error", onEnd);
		acknowledgment.resolve(accepted);
	};
	const onData = (chunk: Buffer | string): void => {
		received += chunk.toString();
		if (received.length > BROKER_HANDOFF_ACKNOWLEDGEMENT.length) {
			finish(false);
			return;
		}
		if (received.includes("\n")) finish(received === BROKER_HANDOFF_ACKNOWLEDGEMENT);
	};
	const onEnd = (): void => finish(false);
	input.on("data", onData);
	input.once("end", onEnd);
	input.once("close", onEnd);
	input.once("error", onEnd);
	input.resume();
	return acknowledgment.promise;
}

/** Wait for a validated identity ACK followed by the parent's publication decision. */
export function waitForBrokerHandoffDecision(input: stream.Readable, timeoutMs = 30_000): Promise<"commit" | "abort"> {
	const decision = Promise.withResolvers<"commit" | "abort">();
	let received = "";
	let settled = false;
	const finish = (value: "commit" | "abort"): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		input.removeListener("data", onData);
		input.removeListener("end", onEnd);
		input.removeListener("close", onEnd);
		input.removeListener("error", onEnd);
		decision.resolve(value);
	};
	const onData = (chunk: Buffer | string): void => {
		received += chunk.toString();
		if (received.length > BROKER_HANDOFF_ACKNOWLEDGEMENT.length + BROKER_HANDOFF_COMMIT.length) {
			finish("abort");
			return;
		}
		if (received.length < BROKER_HANDOFF_ACKNOWLEDGEMENT.length) {
			if (!BROKER_HANDOFF_ACKNOWLEDGEMENT.startsWith(received)) finish("abort");
			return;
		}
		if (!received.startsWith(BROKER_HANDOFF_ACKNOWLEDGEMENT)) {
			finish("abort");
			return;
		}
		const action = received.slice(BROKER_HANDOFF_ACKNOWLEDGEMENT.length);
		if (action === BROKER_HANDOFF_COMMIT) finish("commit");
		else if (action === BROKER_HANDOFF_ABORT) finish("abort");
		else if (!BROKER_HANDOFF_COMMIT.startsWith(action) && !BROKER_HANDOFF_ABORT.startsWith(action)) finish("abort");
	};
	const onEnd = (): void => finish("abort");
	const timer = setTimeout(() => finish("abort"), timeoutMs);
	input.on("data", onData);
	input.once("end", onEnd);
	input.once("close", onEnd);
	input.once("error", onEnd);
	input.resume();
	return decision.promise;
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
