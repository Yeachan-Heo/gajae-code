import { beforeAll, describe, expect, it } from "bun:test";
import { loadContract, type PreregistrationContract } from "../bench/multisession/contract";
import {
	type Characterization,
	evaluate,
	type Report,
	type ReportGate,
	renderMarkdown,
} from "../bench/multisession/report";
import {
	type BrokerBaselineRecord,
	type ChurnRecord,
	type CohortSample,
	REQUIRED_WORKLOAD_EVENTS,
	type RepRecord,
	type RunnerEvent,
} from "../bench/multisession/types";

const REPETITIONS = 5;
const DRIVER_FOOTPRINT = 10;
let contract: PreregistrationContract;

beforeAll(async () => {
	contract = await loadContract();
});

function sample(tick: number, driverFootprint: number, rootFootprint: number): CohortSample {
	const members: CohortSample["members"] = [
		member(100, "driver-incarnation", "driver", driverFootprint),
		member(200, "root-incarnation", "root", rootFootprint),
	];
	const total = driverFootprint + rootFootprint;
	return {
		t: tick * 1000,
		tick,
		phase: tick === 3 ? "post-close" : "active:mixed-workload",
		complete: true,
		incompleteReasons: [],
		members,
		excluded: [],
		armTotal: total,
		armRssTotal: total,
		driverFootprint,
	};
}

function member(
	pid: number,
	incarnation: string,
	reason: "driver" | "root",
	physFootprint: number,
): CohortSample["members"][number] {
	return {
		pid,
		incarnation,
		reason,
		flags: [],
		read: { status: "ok", pid, incarnation, physFootprint, rss: physFootprint },
	};
}

function runnerEvents(options: {
	latencyMs: number;
	turnCount: number;
	durationMs: number;
	lagMs: number;
}): RunnerEvent[] {
	const events: RunnerEvent[] = [];
	for (let sessionIndex = 0; sessionIndex < 5; sessionIndex += 1) {
		events.push({ type: "phase", sessionIndex, phase: "ready", t: 0 });
		events.push({ type: "phase", sessionIndex, phase: "active:mixed-workload", t: 1000 });
		events.push({ type: "phase", sessionIndex, phase: "idle", t: 1000 + options.durationMs });
		events.push({ type: "lag", sessionIndex, samplesMs: [options.lagMs] });
		for (const event of REQUIRED_WORKLOAD_EVENTS) events.push({ type: "workload", sessionIndex, event });
	}
	for (let turn = 0; turn < options.turnCount; turn += 1) {
		const startedAt = 1100 + turn * 200;
		events.push({
			type: "turn",
			sessionIndex: turn % 5,
			turn,
			startedAt,
			endedAt: startedAt + options.latencyMs,
			ok: true,
		});
	}
	return events;
}

function makeRep(
	arm: "standalone" | "worker",
	repIndex: number,
	options: {
		memoryRoot: number;
		teardownRoot: number;
		latencyMs?: number;
		lagMs?: number;
		coldReadyMs?: number;
		turnCount?: number;
		durationMs?: number;
	},
): RepRecord {
	return {
		arm,
		n: 5,
		rep: repIndex,
		samples: [
			sample(1, DRIVER_FOOTPRINT, options.memoryRoot),
			sample(2, DRIVER_FOOTPRINT, options.memoryRoot),
			sample(3, DRIVER_FOOTPRINT, options.teardownRoot),
		],
		gatedWindowTicks: [1, 2],
		teardownTick: 3,
		runnerEvents: runnerEvents({
			latencyMs: options.latencyMs ?? 100,
			turnCount: options.turnCount ?? 10,
			durationMs: options.durationMs ?? 10000,
			lagMs: options.lagMs ?? 50,
		}),
		coldReadyMs: Array.from({ length: 5 }, () => options.coldReadyMs ?? 100),
		warmAdmissionMs: [],
		visibilityCheck: { passed: true },
		orphans: { owned: [], unresolved: [], complete: true, errors: [] },
	};
}

function makeChurn(arm: "standalone" | "worker", firstFootprint: number, lastFootprint: number): ChurnRecord {
	const hostFootprints = Array.from({ length: 20 }, (_, index) => (index === 19 ? lastFootprint : firstFootprint));
	return {
		arm,
		cycleSamples: hostFootprints.map((footprint, index) => sample(index + 1, DRIVER_FOOTPRINT, footprint!)),
		hostFootprints,
		cycleErrors: hostFootprints.map(() => []),
		completedCycles: hostFootprints.length,
		orphans: { owned: [], unresolved: [], complete: true, errors: [] },
	};
}

function makeBroker(): BrokerBaselineRecord {
	return {
		reps: Array.from({ length: REPETITIONS }, () => ({
			samples: Array.from({ length: 30 }, () => 10),
			complete: true,
		})),
		b: 10,
	};
}

function makeInput(contractValue: PreregistrationContract) {
	return {
		contract: contractValue,
		standalone: Array.from({ length: REPETITIONS }, (_, index) =>
			makeRep("standalone", index + 1, { memoryRoot: 90, teardownRoot: 0 }),
		),
		worker: Array.from({ length: REPETITIONS }, (_, index) =>
			makeRep("worker", index + 1, { memoryRoot: 35, teardownRoot: 11.5, latencyMs: 110, turnCount: 9 }),
		),
		churn: { standalone: makeChurn("standalone", 20, 22), worker: makeChurn("worker", 10, 11) },
		broker: makeBroker(),
		fidelity: { equal: true },
		characterization: "equal" as Characterization,
	};
}

function gate(report: Report, name: string): ReportGate {
	const selected = report.gates.find(candidate => candidate.name === name);
	expect(selected).toBeDefined();
	return selected!;
}

function withGatedRoot(rep: RepRecord, footprint: number): RepRecord {
	return {
		...rep,
		samples: rep.samples.map(current =>
			current.tick === 1 || current.tick === 2 ? sample(current.tick, current.driverFootprint!, footprint) : current,
		),
	};
}
function withGatedRoots(rep: RepRecord, rootFootprints: number[]): RepRecord {
	const ticks = rootFootprints.map((_, index) => index + 10);
	const samples = rootFootprints.map((footprint, index) => sample(ticks[index]!, DRIVER_FOOTPRINT, footprint));
	const teardown = rep.samples.find(current => current.tick === rep.teardownTick)!;
	return { ...rep, samples: [...samples, teardown], gatedWindowTicks: ticks };
}

function withTeardownRoot(rep: RepRecord, footprint: number): RepRecord {
	return {
		...rep,
		samples: rep.samples.map(current =>
			current.tick === rep.teardownTick ? sample(current.tick, current.driverFootprint!, footprint) : current,
		),
	};
}

function withTurnLatency(rep: RepRecord, latencyMs: number): RepRecord {
	return {
		...rep,
		runnerEvents: rep.runnerEvents.map(event =>
			event.type === "turn" ? { ...event, endedAt: event.startedAt + latencyMs } : event,
		),
	};
}

function withThroughput(rep: RepRecord, turnCount: number, durationMs = 10000): RepRecord {
	const events: RunnerEvent[] = rep.runnerEvents
		.filter(event => event.type !== "turn")
		.map(event => (event.type === "phase" && event.phase === "idle" ? { ...event, t: 1000 + durationMs } : event));
	for (let turn = 0; turn < turnCount; turn += 1) {
		const startedAt = 1100 + turn * 200;
		events.push({ type: "turn", sessionIndex: turn % 5, turn, startedAt, endedAt: startedAt + 100, ok: true });
	}
	return { ...rep, runnerEvents: events };
}

function withLag(rep: RepRecord, lagMs: number): RepRecord {
	return {
		...rep,
		runnerEvents: rep.runnerEvents.map(event => (event.type === "lag" ? { ...event, samplesMs: [lagMs] } : event)),
	};
}

function withColdReadiness(rep: RepRecord, readinessMs: number): RepRecord {
	return { ...rep, coldReadyMs: Array.from({ length: 5 }, () => readinessMs) };
}

function withChurnEnd(record: ChurnRecord, footprint: number): ChurnRecord {
	return {
		...record,
		hostFootprints: record.hostFootprints.map((current, index) => (index === 19 ? footprint : current)),
		cycleSamples: record.cycleSamples.map((current, index) =>
			index === 19 ? sample(current.tick, DRIVER_FOOTPRINT, footprint) : current,
		),
	};
}

describe("multi-session report gates", () => {
	it("passes every gate exactly at its preregistered boundary", () => {
		const report = evaluate(makeInput(contract));
		expect(gate(report, "turn latency").worker).toBe(110);
		expect(gate(report, "throughput").worker).toBe(0.9);
		expect(report.verdict).toBe("pass");
		for (const name of [
			"memory",
			"turn latency",
			"throughput",
			"event-loop lag",
			"cold readiness",
			"teardown",
			"churn",
			"orphans",
			"fidelity",
		]) {
			expect(gate(report, name).verdict).toBe("pass");
		}
		expect(gate(report, "memory").standalone).toBe(110);
		expect(gate(report, "memory").worker).toBe(55);
		expect(gate(report, "teardown").worker).toBe(11.5);
		expect(gate(report, "churn").worker).toBeCloseTo(0.1);
	});
	it("passes when the Worker sampled peak is exactly equal to standalone", () => {
		const input = makeInput(contract);
		input.worker = input.worker.map(rep => withGatedRoots(rep, [10, 10, 10, 90]));
		const memory = gate(evaluate(input), "memory");
		expect(memory.verdict).toBe("pass");
		expect(memory.worker).toBeLessThanOrEqual(memory.standalone! * 0.5);
	});

	it("fails just beyond the memory-mean boundary", () => {
		const input = makeInput(contract);
		input.worker = input.worker.map(rep => withGatedRoot(rep, 36));
		expect(gate(evaluate(input), "memory").verdict).toBe("fail");
	});
	it("fails when the sampled peak regresses even though the gated mean meets its threshold", () => {
		const input = makeInput(contract);
		input.worker = input.worker.map(rep => withGatedRoots(rep, [10, 10, 10, 91]));
		const memory = gate(evaluate(input), "memory");
		expect(memory.verdict).toBe("fail");
		expect(memory.worker!).toBeLessThanOrEqual(memory.standalone! * 0.5);
	});

	it("fails just beyond the p95 turn-latency boundary", () => {
		const input = makeInput(contract);
		input.worker = input.worker.map(rep => withTurnLatency(rep, 110.001));
		expect(gate(evaluate(input), "turn latency").verdict).toBe("fail");
	});

	it("fails just beyond the throughput boundary", () => {
		const input = makeInput(contract);
		input.worker = input.worker.map(rep => withThroughput(rep, 9, 10001));
		expect(gate(evaluate(input), "throughput").verdict).toBe("fail");
	});

	it("fails just beyond the event-loop lag boundary", () => {
		const input = makeInput(contract);
		input.worker = input.worker.map(rep => withLag(rep, 50.001));
		expect(gate(evaluate(input), "event-loop lag").verdict).toBe("fail");
	});

	it("fails when cold readiness is just slower", () => {
		const input = makeInput(contract);
		input.worker = input.worker.map(rep => withColdReadiness(rep, 100.001));
		expect(gate(evaluate(input), "cold readiness").verdict).toBe("fail");
	});

	it("fails just beyond the Broker-relative teardown boundary", () => {
		const input = makeInput(contract);
		input.worker = input.worker.map(rep => withTeardownRoot(rep, 11.5001));
		expect(gate(evaluate(input), "teardown").verdict).toBe("fail");
	});

	it("fails just beyond 10% Worker churn growth", () => {
		const input = makeInput(contract);
		input.churn.worker = withChurnEnd(input.churn.worker!, 11.01);
		expect(gate(evaluate(input), "churn").verdict).toBe("fail");
	});

	it("fails the zero-orphan and equal-fidelity gates when either boundary is crossed", () => {
		const orphaned = makeInput(contract);
		orphaned.worker[0]!.orphans.owned.push(9876);
		expect(gate(evaluate(orphaned), "orphans").verdict).toBe("fail");

		const unequal = makeInput(contract);
		unequal.fidelity.equal = false;
		expect(gate(evaluate(unequal), "fidelity").verdict).toBe("fail");
	});

	it("uses driver-inclusive armTotal once and fails the boundary that would pass without D", () => {
		const driver = 10;
		const standaloneWithoutDriver = 100;
		const workerWithoutDriver = 40;
		const broker = 20;
		expect(workerWithoutDriver + broker).toBeLessThanOrEqual(0.5 * (standaloneWithoutDriver + broker));
		expect(workerWithoutDriver + driver + broker).toBeGreaterThan(0.5 * (standaloneWithoutDriver + driver + broker));

		const input = makeInput(contract);
		input.broker = {
			reps: Array.from({ length: 5 }, () => ({ samples: Array.from({ length: 30 }, () => 20), complete: true })),
			b: broker,
		};
		input.standalone = input.standalone.map(rep => withGatedRoot(rep, standaloneWithoutDriver));
		input.worker = input.worker.map(rep => withGatedRoot(rep, workerWithoutDriver));
		const report = evaluate(input);
		expect(gate(report, "memory").verdict).toBe("fail");
		expect(gate(report, "memory").standalone).toBe(standaloneWithoutDriver + driver + broker);
		expect(gate(report, "memory").worker).toBe(workerWithoutDriver + driver + broker);
		const sampleWithDriver = input.worker[0]!.samples[0]!;
		expect(sampleWithDriver.members.filter(entry => entry.reason === "driver")).toHaveLength(1);
		expect(sampleWithDriver.armTotal).toBe(
			sampleWithDriver.members.reduce(
				(sum, entry) => sum + (entry.read.status === "ok" ? entry.read.physFootprint : 0),
				0,
			),
		);
	});

	it("invalidates a rep with one incomplete active-window sample and cannot claim enough evidence", () => {
		const input = makeInput(contract);
		const rep = input.worker[0]!;
		input.worker[0] = {
			...rep,
			samples: rep.samples.map(current =>
				current.tick === 1 ? { ...current, complete: false, incompleteReasons: ["raced footprint read"] } : current,
			),
		};
		const report = evaluate(input);
		expect(report.reps.find(item => item.arm === "worker" && item.rep === 1)).toMatchObject({ valid: false });
		expect(gate(report, "memory").verdict).toBe("insufficient-evidence");
		expect(report.verdict).toBe("insufficient-evidence");
	});

	it("invalidates a missing scheduled tick at the would-be sampled peak", () => {
		const input = makeInput(contract);
		input.worker[0] = {
			...input.worker[0]!,
			samples: input.worker[0]!.samples.filter(current => current.tick !== 2),
		};
		const report = evaluate(input);
		const invalid = report.reps.find(item => item.arm === "worker" && item.rep === 1);
		expect(invalid?.valid).toBe(false);
		expect(invalid?.reasons).toContain("gated-window tick 2 is missing or duplicated");
		expect(gate(report, "memory").verdict).toBe("insufficient-evidence");
	});

	it("makes teardown and cycle-20 churn gates insufficient on incomplete operands", () => {
		const teardownInput = makeInput(contract);
		const teardownRep = teardownInput.worker[0]!;
		teardownInput.worker[0] = {
			...teardownRep,
			samples: teardownRep.samples.map(current =>
				current.tick === 3 ? { ...current, complete: false, incompleteReasons: ["unresolved ownership"] } : current,
			),
		};
		expect(gate(evaluate(teardownInput), "teardown").verdict).toBe("insufficient-evidence");

		const churnInput = makeInput(contract);
		const churn = churnInput.churn.worker!;
		churnInput.churn.worker = {
			...churn,
			cycleSamples: churn.cycleSamples.map((current, index) =>
				index === 19 ? { ...current, complete: false, incompleteReasons: ["unresolved read"] } : current,
			),
		};
		expect(gate(evaluate(churnInput), "churn").verdict).toBe("insufficient-evidence");
	});

	it("invalidates a rep missing a required workload event for one session", () => {
		const input = makeInput(contract);
		const rep = input.worker[0]!;
		input.worker[0] = {
			...rep,
			runnerEvents: rep.runnerEvents.filter(
				event => !(event.type === "workload" && event.sessionIndex === 2 && event.event === "compaction"),
			),
		};
		const report = evaluate(input);
		const invalid = report.reps.find(item => item.arm === "worker" && item.rep === 1);
		expect(invalid?.valid).toBe(false);
		expect(invalid?.reasons).toContain("session 2 is missing required workload event compaction");
	});

	it("uses the capability label rule and renders the gate and eligibility evidence", () => {
		const equal = evaluate(makeInput(contract));
		expect(equal.capabilityLabel).toBe("full-capability");
		const unavailableInput = makeInput(contract);
		unavailableInput.characterization = "unavailable";
		const unavailable = evaluate(unavailableInput);
		expect(unavailable.capabilityLabel).toBe("isolation-model opportunity evidence");
		const markdown = renderMarkdown(unavailable);
		expect(markdown).toContain("| memory | pass |");
		expect(markdown).toContain("## Repetition eligibility");
		// Passing gates without an equal characterization never claim an all-gates pass.
		expect(unavailable.verdict).toBe("pass (isolation-model opportunity evidence only)");
		const differsInput = makeInput(contract);
		differsInput.characterization = "differs";
		expect(evaluate(differsInput).verdict).toBe("pass (isolation-model opportunity evidence only)");
		expect(equal.verdict).toBe("pass");
	});

	it("accepts a non-driver member that exited before its read, but not an absent driver", () => {
		const exited = (current: CohortSample): CohortSample => ({
			...current,
			members: [
				...current.members,
				{
					pid: 300,
					incarnation: "gone",
					reason: "root",
					flags: [],
					read: { status: "absent", pid: 300 },
				},
			],
		});
		// A standalone child that exited before its read: every gate stays evaluable.
		const accepted = makeInput(contract);
		accepted.standalone = accepted.standalone.map(rep => ({ ...rep, samples: rep.samples.map(exited) }));
		const acceptedReport = evaluate(accepted);
		for (const name of ["memory", "turn latency", "throughput", "event-loop lag", "cold readiness", "teardown"]) {
			expect(gate(acceptedReport, name).verdict).toBe("pass");
		}
		expect(acceptedReport.verdict).toBe("pass");

		// The Worker host itself gone at teardown: no live host read, so teardown is unproven.
		const hostGone = makeInput(contract);
		hostGone.worker = hostGone.worker.map(rep => ({
			...rep,
			samples: rep.samples.map(current =>
				current.tick === rep.teardownTick
					? {
							...current,
							members: current.members.map(item =>
								item.reason === "root" ? { ...item, read: { status: "absent" as const, pid: item.pid } } : item,
							),
							armTotal: DRIVER_FOOTPRINT,
							armRssTotal: DRIVER_FOOTPRINT,
						}
					: current,
			),
		}));
		expect(gate(evaluate(hostGone), "teardown").verdict).toBe("insufficient-evidence");

		const driverGone = makeInput(contract);
		driverGone.worker = driverGone.worker.map(rep => ({
			...rep,
			samples: rep.samples.map(current => ({
				...current,
				members: current.members.map(item =>
					item.reason === "driver" ? { ...item, read: { status: "absent" as const, pid: item.pid } } : item,
				),
			})),
		}));
		expect(gate(evaluate(driverGone), "memory").verdict).toBe("insufficient-evidence");
	});

	it("never accepts a broker baseline shorter than 30 one-second samples", () => {
		const input = makeInput(contract);
		input.broker = {
			reps: Array.from({ length: REPETITIONS }, () => ({
				samples: Array.from({ length: 29 }, () => 10),
				complete: true,
			})),
			b: 10,
		};
		expect(gate(evaluate(input), "memory").verdict).toBe("insufficient-evidence");
	});

	it("makes churn insufficient when any cycle failed a session or stopped early", () => {
		const failedInput = makeInput(contract);
		const failedChurn = failedInput.churn.worker!;
		failedInput.churn.worker = {
			...failedChurn,
			cycleErrors: failedChurn.cycleErrors.map((errors, index) =>
				index === 7 ? ["session 37: model error"] : errors,
			),
		};
		const failedGate = gate(evaluate(failedInput), "churn");
		expect(failedGate.verdict).toBe("insufficient-evidence");
		expect(failedGate.detail).toContain("Cycle 8");

		const midInput = makeInput(contract);
		const midChurn = midInput.churn.worker!;
		midInput.churn.worker = {
			...midChurn,
			cycleSamples: midChurn.cycleSamples.map((current, index) =>
				index === 9 ? { ...current, complete: false, incompleteReasons: ["unresolved-ownership"] } : current,
			),
		};
		expect(gate(evaluate(midInput), "churn").verdict).toBe("insufficient-evidence");

		const shortInput = makeInput(contract);
		shortInput.churn.worker = { ...shortInput.churn.worker!, completedCycles: 19 };
		expect(gate(evaluate(shortInput), "churn").verdict).toBe("insufficient-evidence");
	});

	it("treats a failed marker visibility self-check as an invalid rep and insufficient evidence", () => {
		const input = makeInput(contract);
		input.worker[2] = {
			...input.worker[2]!,
			visibilityCheck: { passed: false, reason: "marker-not-visible:4242:argv-only" },
		};
		const report = evaluate(input);
		expect(report.reps.find(item => item.arm === "worker" && item.rep === 3)?.valid).toBe(false);
		expect(gate(report, "memory").verdict).toBe("insufficient-evidence");
		expect(report.verdict).toBe("insufficient-evidence");
	});

	it("makes orphans insufficient when a receipt could not prove completeness", () => {
		const input = makeInput(contract);
		input.churn.worker = {
			...input.churn.worker!,
			orphans: { owned: [], unresolved: [], complete: false, errors: ["process-list-failed"] },
		};
		expect(gate(evaluate(input), "orphans").verdict).toBe("insufficient-evidence");
	});
});
