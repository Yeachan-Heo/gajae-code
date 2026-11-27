/**
 * Child for watchdog-init failure. Spawned as its own process so
 * `GJC_BROKER_LIVENESS_HARD_EXIT=1` cannot arm watchdogs in the test runner.
 *
 * Usage: bun sdk-broker-liveness-watchdog-init-child.ts <agentDir> <fail|slots|lost>
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
import { brokerDiscoveryPath } from "../src/sdk/broker/discovery";
import {
	setPublicationLivenessSlotExhaustedForTest,
	setPublicationLivenessWorkerStartFailureForTest,
	terminatePublicationLivenessWatchdogForTest,
} from "../src/sdk/broker/publication-liveness-watchdog";

async function pathExists(file: string): Promise<boolean> {
	try {
		await fs.stat(file);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

const agentDir = process.argv[2];
const mode = process.argv[3];
if (!agentDir || (mode !== "fail" && mode !== "slots" && mode !== "lost")) {
	process.stderr.write("usage: sdk-broker-liveness-watchdog-init-child <agentDir> <fail|slots|lost>\n");
	process.exit(2);
}

if (mode === "fail") setPublicationLivenessWorkerStartFailureForTest(new Error("worker failed to start"));
if (mode === "slots") setPublicationLivenessSlotExhaustedForTest(true);

const broker = new Broker({ agentDir, heartbeatTtlMs: 300 });
const lockPath = path.join(agentDir, "sdk", "broker.lock");

if (mode === "lost") {
	try {
		await broker.start();
	} catch (error) {
		process.stdout.write(
			`${JSON.stringify({
				result: "start-failed",
				message: error instanceof Error ? error.message : String(error),
			})}\n`,
		);
		process.exit(2);
	}
	terminatePublicationLivenessWatchdogForTest();
	const completed = await Promise.race([broker.completion.then(() => true), Bun.sleep(3_000).then(() => false)]);
	const terminal = broker.terminalExit;
	process.stdout.write(
		`${JSON.stringify({
			result: completed ? "exited" : "pending",
			reason: terminal?.reason ?? null,
			mode: terminal?.mode ?? null,
			memory: broker.discovery !== null,
			file: await pathExists(brokerDiscoveryPath(agentDir)),
			lock: await pathExists(lockPath),
		})}\n`,
	);
	process.exit(completed && terminal?.reason === "publication-liveness-timeout" ? 0 : 2);
}

try {
	await broker.start();
	process.stdout.write(
		`${JSON.stringify({
			result: "started",
			memory: broker.discovery !== null,
			file: await pathExists(brokerDiscoveryPath(agentDir)),
			lock: await pathExists(lockPath),
		})}\n`,
	);
	process.exit(2);
} catch (error) {
	process.stdout.write(
		`${JSON.stringify({
			result: "failed",
			message: error instanceof Error ? error.message : String(error),
			memory: broker.discovery !== null,
			file: await pathExists(brokerDiscoveryPath(agentDir)),
			lock: await pathExists(lockPath),
		})}\n`,
	);
	process.exit(0);
}
