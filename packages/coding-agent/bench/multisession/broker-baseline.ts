import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { brokerOwnerForTest, ensureBroker, type EnsureBrokerSettings } from "../../src/sdk/broker/ensure";
import type { BrokerDiscovery } from "../../src/sdk/broker/discovery";
import {
	observeProcessIncarnation,
	type ProcessIncarnationObservation,
} from "../../src/sdk/broker/process-incarnation";
import { sampleProcess } from "./footprint";
import type { BrokerBaselineRecord, FootprintRead } from "./types";

interface BrokerOwnerStop {
	stop(): Promise<void>;
}

export interface BrokerBaselineDeps {
	ensureBroker?: (settings: EnsureBrokerSettings) => Promise<BrokerDiscovery>;
	brokerOwnerForTest?: (agentDir: string) => BrokerOwnerStop | undefined;
	sampleProcess?: (pid: number) => FootprintRead;
	observeProcessIncarnation?: (pid: number) => ProcessIncarnationObservation;
	sleep?: (ms: number) => Promise<void>;
	mkdtemp?: (prefix: string) => Promise<string>;
	removeTempDir?: (directory: string) => Promise<void>;
	env?: NodeJS.ProcessEnv;
}

const DENIED_ENV_NAMES = new Set([
	"GJC_AGENT_DIR",
	"GJC_BENCH_COHORT",
	"GJC_MASTER_CAPABILITY",
	"GJC_SDK_TEST_BROKER_SIGNAL_DIR",
]);
const ALLOWED_ENV_NAMES = new Set([
	"BUN_INSTALL",
	"HOME",
	"LANG",
	"LOGNAME",
	"PATH",
	"SHELL",
	"TERM",
	"TMPDIR",
	"USER",
]);
const BROKER_EXIT_VERIFY_MS = 2_000;
const BROKER_EXIT_POLL_MS = 20;

function sanitizedEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(input)) {
		const normalized = name.toUpperCase();
		if (value === undefined || DENIED_ENV_NAMES.has(normalized)) continue;
		if (normalized.startsWith("LC_")) {
			environment[name] = value;
			continue;
		}
		if (!ALLOWED_ENV_NAMES.has(normalized)) continue;
		environment[name] = value;
	}
	return environment;
}

function median(values: number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

async function waitForBrokerIdentityToExit(
	pid: number,
	incarnation: string,
	observe: (pid: number) => ProcessIncarnationObservation,
	sleep: (ms: number) => Promise<void>,
): Promise<void> {
	const deadline = performance.now() + BROKER_EXIT_VERIFY_MS;
	while (performance.now() < deadline) {
		const observation = observe(pid);
		if (observation.status === "absent") return;
		if (observation.status === "present" && observation.incarnation !== incarnation) return;
		await sleep(BROKER_EXIT_POLL_MS);
	}
	throw new Error(`Owned broker identity ${pid}/${incarnation} did not disappear after stop`);
}

/** Measure the isolated Broker once per repetition and release only its retained owner. */
export async function measureBrokerBaseline(options: {
	reps: number;
	seconds: number;
	deps?: BrokerBaselineDeps;
}): Promise<BrokerBaselineRecord> {
	if (!Number.isSafeInteger(options.reps) || options.reps < 1) throw new Error("Broker baseline reps must be positive");
	if (!Number.isSafeInteger(options.seconds) || options.seconds < 1) throw new Error("Broker baseline seconds must be positive");

	const deps = options.deps ?? {};
	const ensure = deps.ensureBroker ?? ensureBroker;
	const ownerForDir = deps.brokerOwnerForTest ?? brokerOwnerForTest;
	const sample = deps.sampleProcess ?? sampleProcess;
	const observe = deps.observeProcessIncarnation ?? observeProcessIncarnation;
	const sleep = deps.sleep ?? Bun.sleep;
	const makeTempDir = deps.mkdtemp ?? (prefix => fs.mkdtemp(prefix));
	const removeTempDir = deps.removeTempDir ?? (directory => fs.rm(directory, { recursive: true, force: true }));
	const env = sanitizedEnvironment(deps.env ?? process.env);
	const means: number[] = [];
	const reps: BrokerBaselineRecord["reps"] = [];

	for (let repIndex = 0; repIndex < options.reps; repIndex++) {
		const agentDir = await makeTempDir(path.join(os.tmpdir(), "gjc-bench-broker-baseline-"));
		let discovery: BrokerDiscovery | undefined;
		let owner: BrokerOwnerStop | undefined;
		let canRemoveDirectory = false;
		let sampleRecord: BrokerBaselineRecord["reps"][number] | undefined;
		let failure: unknown;
		try {
			discovery = await ensure({ agentDir, env: { ...env } });
			owner = ownerForDir(agentDir);
			if (!owner) throw new Error("ensureBroker resolved without a locally owned Broker stop handle");
			const samples: Array<number | null> = [];
			for (let tick = 0; tick < options.seconds; tick++) {
				if (tick > 0) await sleep(1_000);
				const read = sample(discovery.pid);
				samples.push(
					read.status === "ok" &&
						read.incarnation === discovery.incarnation &&
						Number.isSafeInteger(read.physFootprint) &&
						read.physFootprint >= 0
						? read.physFootprint
						: null,
				);
			}
			const complete = samples.every(value => value !== null);
			sampleRecord = { samples, complete };
			if (complete) means.push(samples.reduce<number>((total, value) => total + value!, 0) / samples.length);
		} catch (error) {
			failure = error;
		} finally {
			owner = ownerForDir(agentDir) ?? owner;
			if (owner) {
				try {
					await owner.stop();
					if (discovery) {
						await waitForBrokerIdentityToExit(discovery.pid, discovery.incarnation, observe, sleep);
					}
					canRemoveDirectory = true;
				} catch (error) {
					failure ??= error;
				}
			} else if (!discovery) {
				canRemoveDirectory = true;
			} else {
				failure ??= new Error("Broker discovery had no exact owned stop handle; refusing to remove its temp directory");
			}
			if (canRemoveDirectory) {
				try {
					await removeTempDir(agentDir);
				} catch (error) {
					failure ??= error;
				}
			}
		}
		if (failure !== undefined) throw failure;
		if (!sampleRecord) throw new Error("Broker baseline repetition ended without a sample record");
		reps.push(sampleRecord);
	}

	const enoughCompleteReps = options.reps < 5 || means.length >= 5;
	const everyRepComplete = reps.every(rep => rep.complete);
	return {
		reps,
		b: everyRepComplete && enoughCompleteReps ? median(means) : null,
	};
}
