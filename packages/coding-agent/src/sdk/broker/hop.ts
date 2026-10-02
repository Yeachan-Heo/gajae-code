import { spawn } from "node:child_process";
import * as fs from "node:fs";
import process from "node:process";
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
 * Exits with code 0 after writing the broker pid to stdout as JSON.
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
		const child = spawn(message.command.file, message.command.args, {
			detached: true,
			windowsHide: true,
			stdio: ["ignore", "ignore", stderr],
			env: process.env,
			...(message.cwd ? { cwd: message.cwd } : {}),
		});
		if (typeof stderr === "number") fs.closeSync(stderr);
		if (child.pid === undefined) fail("broker hop spawn succeeded but child pid unavailable");
		child.unref();
		process.stdout.write(`${JSON.stringify({ pid: child.pid })}\n`, () => process.exit(0));
	} catch (error) {
		fail(`broker hop spawn failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function fail(message: string): never {
	process.stderr.write(`gjc: ${message}\n`);
	process.exit(1);
}
