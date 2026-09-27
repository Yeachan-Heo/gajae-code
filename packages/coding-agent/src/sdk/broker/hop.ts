import { spawn } from "node:child_process";
import process from "node:process";

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

interface HopMessage {
	command: {
		file: string;
		args: string[];
	};
	env: Record<string, string>;
	stdio: "ignore" | number;
}

export async function runBrokerHopFromArgv(argv: string[]): Promise<void> {
	if (argv.length !== 1) {
		process.stderr.write("gjc: broker hop requires exactly one argument\n");
		process.exit(1);
	}

	let message: HopMessage;
	try {
		message = JSON.parse(argv[0]);
	} catch (error) {
		process.stderr.write(
			`gjc: broker hop JSON parse error: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exit(1);
	}

	if (!message.command || !message.command.file || !Array.isArray(message.command.args)) {
		process.stderr.write("gjc: broker hop message missing command\n");
		process.exit(1);
	}

	if (!message.env || typeof message.env !== "object") {
		process.stderr.write("gjc: broker hop message missing env\n");
		process.exit(1);
	}

	const stdioArg = message.stdio === "ignore" ? "ignore" : (message.stdio as any);

	try {
		const child = spawn(message.command.file, message.command.args, {
			detached: true,
			windowsHide: true,
			stdio: ["ignore", "ignore", stdioArg],
			env: message.env,
		});

		if (child.pid === undefined) {
			process.stderr.write("gjc: broker hop spawn succeeded but child pid unavailable\n");
			process.exit(1);
		}

		// Write the real broker pid to stdout as JSON and exit immediately.
		// The parent process reads this line to learn the real broker's pid.
		process.stdout.write(JSON.stringify({ pid: child.pid }) + "\n");
		process.exit(0);
	} catch (error) {
		process.stderr.write(`gjc: broker hop spawn failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	}
}
