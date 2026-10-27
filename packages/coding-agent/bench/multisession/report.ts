import {
	REQUIRED_WORKLOAD_EVENTS,
	type ArmKind,
	type BrokerBaselineRecord,
	type ChurnRecord,
	type CohortSample,
	type GateVerdict,
	type RepRecord,
	type RunnerEvent,
} from "./types";
import type { PreregistrationContract } from "./contract";

export type Characterization = "equal" | "differs" | "unavailable";
export type CapabilityLabel = "full-capability" | "isolation-model opportunity evidence";
export type OverallVerdict =
	| "pass"
	| "pass (isolation-model opportunity evidence only)"
	| `stop at Phase A: ${string}`
	| "insufficient-evidence";

export interface ReportGate {
	name: string;
	verdict: GateVerdict;
	standalone: number | null;
	worker: number | null;
	threshold: string;
	detail: string;
}

export interface RepEligibility {
	arm: "standalone" | "worker";
	n: number;
	rep: number;
	valid: boolean;
	reasons: string[];
}

export interface Report {
	verdict: OverallVerdict;
	capabilityLabel: CapabilityLabel;
	characterization: Characterization;
	gates: ReportGate[];
	reps: RepEligibility[];
}

interface RepMetrics {
	turnLatencyP95: number;
	throughput: number;
	lagP95: number;
	coldReadiness: number;
	teardownHostFootprint: number;
}

interface Measurement {
	value: number | null;
	detail?: string;
	passesThreshold?: boolean;
}


export function evaluate(input: {
	contract: PreregistrationContract;
	standalone: RepRecord[];
	worker: RepRecord[];
	churn: { standalone?: ChurnRecord; worker?: ChurnRecord };
	broker: BrokerBaselineRecord;
	fidelity: { equal: boolean };
	characterization: Characterization;
}): Report {
	const eligibility = [
		...input.standalone.map(rep => ({ rep, reasons: invalidReasons(rep) })),
		...input.worker.map(rep => ({ rep, reasons: invalidReasons(rep) })),
	];
	const reps: RepEligibility[] = eligibility.map(({ rep, reasons }) => ({
		arm: rep.arm,
		n: rep.n,
		rep: rep.rep,
		valid: reasons.length === 0,
		reasons,
	}));
	const minimum = input.contract.thresholds.minimumValidRepsPerArm;
	const concurrency = input.contract.experiment.comparisonConcurrency;
	const eligibleStandalone = eligibleReps(input.standalone, reps, concurrency);
	const eligibleWorker = eligibleReps(input.worker, reps, concurrency);
	const brokerB = validBrokerBaseline(input.broker, minimum);
	const gates: ReportGate[] = [];

	const standaloneMemory = measurements(eligibleStandalone, rep => memoryMetrics(rep, brokerB)?.mean ?? null, minimum);
	const workerMemory = measurements(eligibleWorker, rep => memoryMetrics(rep, brokerB)?.mean ?? null, minimum);
	const standalonePeak = measurements(eligibleStandalone, rep => memoryMetrics(rep, brokerB)?.peak ?? null, minimum);
	const workerPeak = measurements(eligibleWorker, rep => memoryMetrics(rep, brokerB)?.peak ?? null, minimum);
	gates.push(compareGate({
		name: "memory",
		standalone: standaloneMemory,
		worker: workerMemory,
		threshold: `Worker gated mean ≤ ${input.contract.thresholds.memory.workerToStandaloneMeanMaximum} × standalone gated mean; sampled peak must not regress`,
		missingDetail: brokerB === null ? "Broker baseline B needs five complete baseline repetitions" : `At least ${minimum} valid N=${concurrency} repetitions per arm are required`,
		passes: (standalone, worker) => {
			const sPeak = medianOfMeasurements(standalonePeak);
			const wPeak = medianOfMeasurements(workerPeak);
			return worker <= standalone * input.contract.thresholds.memory.workerToStandaloneMeanMaximum && sPeak !== null && wPeak !== null && wPeak <= sPeak;
		},
		detail: (standalone, worker) => {
			const sPeak = medianOfMeasurements(standalonePeak);
			const wPeak = medianOfMeasurements(workerPeak);
			return `gated means include B once and use armTotal (which already includes the driver); sampled peak medians: standalone ${format(sPeak)}, worker ${format(wPeak)}. Gated mean medians: standalone ${format(standalone)}, worker ${format(worker)}.`;
		},
	}));

	const standaloneLatency = measurements(eligibleStandalone, rep => repMetrics(rep, input.contract)?.turnLatencyP95 ?? null, minimum);
	const workerLatency = measurements(eligibleWorker, rep => repMetrics(rep, input.contract)?.turnLatencyP95 ?? null, minimum);
	gates.push(compareGate({
		name: "turn latency",
		standalone: standaloneLatency,
		worker: workerLatency,
		threshold: `Worker p95 ≤ standalone p95 × (1 + ${input.contract.thresholds.turnLatency.maximumRelativeIncrease})`,
		missingDetail: `At least ${minimum} valid N=${concurrency} repetitions per arm with turn events are required`,
		passes: (standalone, worker) => worker <= standalone * (1 + input.contract.thresholds.turnLatency.maximumRelativeIncrease),
		detail: (standalone, worker) => `Median of per-repetition nearest-rank p95 turn latencies in ms: standalone ${format(standalone)}, worker ${format(worker)}.`,
	}));

	const standaloneThroughput = measurements(eligibleStandalone, rep => repMetrics(rep, input.contract)?.throughput ?? null, minimum);
	const workerThroughput = measurements(eligibleWorker, rep => repMetrics(rep, input.contract)?.throughput ?? null, minimum);
	gates.push(compareGate({
		name: "throughput",
		standalone: standaloneThroughput,
		worker: workerThroughput,
		threshold: `Worker throughput ≥ standalone throughput × (1 + ${input.contract.thresholds.throughput.minimumRelativeChange})`,
		missingDetail: `At least ${minimum} valid N=${concurrency} repetitions per arm with a complete active window are required`,
		passes: (standalone, worker) => worker >= standalone * (1 + input.contract.thresholds.throughput.minimumRelativeChange),
		detail: (standalone, worker) => `Median of per-repetition completed-ok-turns per active-window second: standalone ${format(standalone)}, worker ${format(worker)}.`,
	}));

	const standaloneLag = measurements(eligibleStandalone, rep => repMetrics(rep, input.contract)?.lagP95 ?? null, minimum);
	const workerLag = measurements(eligibleWorker, rep => repMetrics(rep, input.contract)?.lagP95 ?? null, minimum);
	gates.push(absoluteGate({
		name: "event-loop lag",
		standalone: standaloneLag,
		worker: workerLag,
		threshold: `Both arm medians ≤ ${input.contract.thresholds.eventLoopLag.maximumP95Ms}ms`,
		missingDetail: `At least ${minimum} valid N=${concurrency} repetitions per arm with lag samples for every session are required`,
		limit: input.contract.thresholds.eventLoopLag.maximumP95Ms,
		detail: (standalone, worker) => `Median of per-repetition maximum thread p95 values in ms: standalone ${format(standalone)}, worker ${format(worker)}.`,
	}));

	const standaloneReadiness = measurements(eligibleStandalone, rep => repMetrics(rep, input.contract)?.coldReadiness ?? null, minimum);
	const workerReadiness = measurements(eligibleWorker, rep => repMetrics(rep, input.contract)?.coldReadiness ?? null, minimum);
	gates.push(compareGate({
		name: "cold readiness",
		standalone: standaloneReadiness,
		worker: workerReadiness,
		threshold: "Worker median must not exceed standalone median",
		missingDetail: `At least ${minimum} valid N=${concurrency} repetitions per arm with readiness for every session are required`,
		passes: (standalone, worker) => worker <= standalone * (1 + input.contract.thresholds.coldReadiness.maximumRelativeIncrease),
		detail: (standalone, worker) => `Median of per-repetition session-readiness medians in ms (Worker first session includes host spawn): standalone ${format(standalone)}, worker ${format(worker)}.`,
	}));

	const standaloneTeardown = measurements(eligibleStandalone, rep => repMetrics(rep, input.contract)?.teardownHostFootprint ?? null, minimum);
	const workerTeardown = measurements(eligibleWorker, rep => repMetrics(rep, input.contract)?.teardownHostFootprint ?? null, minimum);
	gates.push(absoluteGate({
		name: "teardown",
		standalone: standaloneTeardown,
		worker: workerTeardown,
		threshold: `Worker host footprint ≤ B × ${input.contract.thresholds.teardown.workerHostFootprintMultiplierOfBrokerBaseline} at ${input.contract.thresholds.teardown.sampleDelayAfterFifthCloseMs}ms after the fifth close`,
		missingDetail: brokerB === null ? "Broker baseline B needs five complete baseline repetitions" : `At least ${minimum} valid N=${concurrency} repetitions per arm with a complete post-close sample are required`,
		limit: brokerB === null ? null : brokerB * input.contract.thresholds.teardown.workerHostFootprintMultiplierOfBrokerBaseline,
		detail: (standalone, worker) => `Standalone root footprint is reported for residue comparison; Worker host-root median is compared with B. B=${format(brokerB)}, standalone=${format(standalone)}, worker=${format(worker)}.`,
	}));

	const churnLimit = input.contract.thresholds.churn.maximumCycle20GrowthOverCycle1;
	const churnResult = evaluateChurn(input.churn.worker, input.contract.thresholds.churn.cycles, churnLimit);
	const standaloneChurn = evaluateChurn(input.churn.standalone, input.contract.thresholds.churn.cycles, churnLimit);
	gates.push({
		name: "churn",
		verdict: churnResult.value === null ? "insufficient-evidence" : churnResult.passesThreshold ? "pass" : "fail",
		standalone: standaloneChurn.value,
		worker: churnResult.value,
		threshold: `Worker host cycle ${input.contract.thresholds.churn.cycles} footprint growth over cycle 1 ≤ ${churnLimit * 100}%`,
		detail: churnResult.value === null
			? churnResult.detail ?? "Worker cycle-1/cycle-20 samples or host footprints are incomplete"
			: `Worker host growth is ${format(churnResult.value * 100)}%; standalone ${standaloneChurn.value === null ? "not available" : `${format(standaloneChurn.value * 100)}%`} is retained for residue comparison only. ${churnResult.detail ?? ""}`.trim(),
	});

	const orphanGate = evaluateOrphans(input.standalone, input.worker, input.churn, reps, minimum, concurrency, input.contract);
	gates.push(orphanGate);
	gates.push({
		name: "fidelity",
		verdict: input.fidelity.equal ? "pass" : "fail",
		standalone: input.fidelity.equal ? 1 : 0,
		worker: input.fidelity.equal ? 1 : 0,
		threshold: "Runner fidelity must be equal",
		detail: input.fidelity.equal ? "Normalized fidelity evidence is equal." : "Normalized fidelity evidence differs.",
	});

	const failedGate = gates.find(gate => gate.verdict === "fail");
	// capabilityLabelRule.claimRule: only an equal real-host characterization permits
	// an all-gates-pass claim; otherwise passing gates are opportunity evidence only.
	const verdict: OverallVerdict = failedGate
		? `stop at Phase A: ${failedGate.name}`
		: gates.some(gate => gate.verdict === "insufficient-evidence")
			? "insufficient-evidence"
			: input.characterization === "equal"
				? "pass"
				: "pass (isolation-model opportunity evidence only)";
	return {
		verdict,
		capabilityLabel: input.characterization === "equal" ? "full-capability" : "isolation-model opportunity evidence",
		characterization: input.characterization,
		gates,
		reps,
	};
}

export function renderMarkdown(report: Report): string {
	const lines = [
		"# RFC #6247 Phase A multi-session memory report",
		"",
		`- **Verdict:** ${report.verdict}`,
		`- **Capability label:** ${report.capabilityLabel}`,
		`- **Characterization:** ${report.characterization}`,
		"",
		"## Gates",
		"",
		"| Gate | Verdict | Standalone | Worker | Threshold | Detail |",
		"| --- | --- | ---: | ---: | --- | --- |",
	];
	for (const gate of report.gates) {
		lines.push(`| ${escapeCell(gate.name)} | ${gate.verdict} | ${format(gate.standalone)} | ${format(gate.worker)} | ${escapeCell(gate.threshold)} | ${escapeCell(gate.detail)} |`);
	}
	lines.push("", "## Repetition eligibility", "", "| Arm | N | Rep | Valid | Reasons |", "| --- | ---: | ---: | --- | --- |");
	for (const rep of report.reps) {
		lines.push(`| ${rep.arm} | ${rep.n} | ${rep.rep} | ${rep.valid ? "yes" : "no"} | ${escapeCell(rep.reasons.join("; ") || "—")} |`);
	}
	return `${lines.join("\n")}\n`;
}

function invalidReasons(rep: RepRecord): string[] {
	const reasons: string[] = [];
	if (rep.invalidReason !== undefined) reasons.push(`invalidReason: ${rep.invalidReason}`);
	if (!rep.visibilityCheck.passed) reasons.push(`visibility check failed${rep.visibilityCheck.reason ? `: ${rep.visibilityCheck.reason}` : ""}`);
	if (!Number.isInteger(rep.n) || rep.n < 1) reasons.push("invalid session count");
	if (rep.gatedWindowTicks.length === 0) reasons.push("gated window has no scheduled ticks");
	const expected = new Set(rep.gatedWindowTicks);
	if (expected.size !== rep.gatedWindowTicks.length) reasons.push("gated window contains duplicate scheduled ticks");
	for (const tick of expected) {
		const atTick = rep.samples.filter(sample => sample.tick === tick);
		if (atTick.length !== 1) {
			reasons.push(`gated-window tick ${tick} is missing or duplicated`);
		} else if (!isSampleComplete(atTick[0]!)) {
			reasons.push(`gated-window tick ${tick} is incomplete`);
		}
	}
	if (rep.teardownTick === null) {
		reasons.push("post-close teardown tick is missing");
	} else {
		const teardown = rep.samples.filter(sample => sample.tick === rep.teardownTick);
		if (teardown.length !== 1 || !isSampleComplete(teardown[0]!)) reasons.push("post-close teardown sample is incomplete");
	}
	for (let sessionIndex = 0; sessionIndex < rep.n; sessionIndex += 1) {
		const events = rep.runnerEvents.filter((event): event is Extract<RunnerEvent, { type: "workload" }> => event.type === "workload" && event.sessionIndex === sessionIndex);
		for (const required of REQUIRED_WORKLOAD_EVENTS) {
			if (!events.some(event => event.event === required)) reasons.push(`session ${sessionIndex} is missing required workload event ${required}`);
		}
	}
	return [...new Set(reasons)];
}

function isSampleComplete(sample: CohortSample): boolean {
	if (!sample.complete || sample.incompleteReasons.length > 0 || sample.armTotal === null || !validFootprint(sample.armTotal)) return false;
	if (sample.driverFootprint === null || !validFootprint(sample.driverFootprint)) return false;
	if (sample.members.length === 0) return false;
	let memberTotal = 0;
	let driverCount = 0;
	let driverTotal = 0;
	const identities = new Set<string>();
	for (const member of sample.members) {
		// Same policy as Cohort.sample: an OS-confirmed exit between ownership scan and
		// read holds no memory, so it contributes nothing whoever owned it.
		if (member.read.status === "absent" && member.reason !== "driver") continue;
		if (member.reason === "unresolved-ownership" || member.read.status !== "ok" || !validFootprint(member.read.physFootprint)) return false;
		if (member.pid !== member.read.pid || member.incarnation !== member.read.incarnation) return false;
		const identity = `${member.read.pid}:${member.read.incarnation}`;
		if (identities.has(identity)) return false;
		identities.add(identity);
		memberTotal += member.read.physFootprint;
		if (member.reason === "driver") {
			driverCount += 1;
			driverTotal = member.read.physFootprint;
		}
	}
	return driverCount === 1 && driverTotal === sample.driverFootprint && memberTotal === sample.armTotal;
}

function eligibleReps(repetitions: RepRecord[], eligibility: RepEligibility[], concurrency: number): RepRecord[] {
	const validKeys = new Set(eligibility.filter(item => item.valid).map(item => `${item.arm}:${item.n}:${item.rep}`));
	return repetitions.filter(rep => rep.n === concurrency && validKeys.has(`${rep.arm}:${rep.n}:${rep.rep}`));
}

/** Registered B observation length: 30 one-second samples per repetition. */
export const BROKER_BASELINE_SECONDS = 30;

function validBrokerBaseline(broker: BrokerBaselineRecord, minimum: number): number | null {
	if (broker.b === null || !validFootprint(broker.b)) return null;
	// Shortened diagnostic baselines (--seconds < 30) are never eligible.
	const complete = broker.reps.filter(
		rep =>
			rep.complete &&
			rep.samples.length >= BROKER_BASELINE_SECONDS &&
			rep.samples.every(sample => sample !== null && validFootprint(sample)),
	);
	return complete.length >= minimum ? broker.b : null;
}

function memoryMetrics(rep: RepRecord, brokerB: number | null): { mean: number; peak: number } | null {
	if (brokerB === null) return null;
	const expectedTicks = new Set(rep.gatedWindowTicks);
	const samples = rep.samples.filter(sample => expectedTicks.has(sample.tick));
	if (samples.length !== expectedTicks.size || samples.some(sample => !isSampleComplete(sample))) return null;
	const totals = samples.map(sample => sample.armTotal!);
	const mean = totals.reduce((sum, total) => sum + total, 0) / totals.length;
	const peak = Math.max(...totals);
	return { mean: mean + brokerB, peak: peak + brokerB };
}

function repMetrics(rep: RepRecord, contract: PreregistrationContract): RepMetrics | null {
	const turns = rep.runnerEvents.filter((event): event is Extract<RunnerEvent, { type: "turn" }> => event.type === "turn");
	const turnLatencies = turns.map(turn => turn.endedAt - turn.startedAt);
	if (turnLatencies.length === 0 || turnLatencies.some(value => !Number.isFinite(value) || value < 0)) return null;
	const turnLatencyP95 = percentile(turnLatencies, contract.thresholds.turnLatency.percentile);
	const window = activeWindow(rep.runnerEvents, rep.n);
	if (window === null || window.end <= window.start) return null;
	const completedTurns = turns.filter(turn => turn.ok && turn.startedAt >= window.start && turn.endedAt <= window.end).length;
	const throughput = completedTurns / ((window.end - window.start) / 1000);
	const lagBySession = new Map<number, number[]>();
	for (const event of rep.runnerEvents) {
		if (event.type !== "lag") continue;
		const samples = lagBySession.get(event.sessionIndex) ?? [];
		samples.push(...event.samplesMs);
		lagBySession.set(event.sessionIndex, samples);
	}
	const perThreadLag: number[] = [];
	for (let sessionIndex = 0; sessionIndex < rep.n; sessionIndex += 1) {
		const samples = lagBySession.get(sessionIndex);
		if (!samples || samples.length === 0 || samples.some(value => !Number.isFinite(value) || value < 0)) return null;
		perThreadLag.push(percentile(samples, contract.thresholds.eventLoopLag.percentile));
	}
	const coldReadiness = rep.coldReadyMs.slice(0, rep.n);
	if (coldReadiness.length !== rep.n || coldReadiness.some(value => !Number.isFinite(value) || value < 0)) return null;
	const teardown = rep.samples.find(sample => sample.tick === rep.teardownTick);
	if (!teardown || !isSampleComplete(teardown)) return null;
	const teardownHostFootprint = hostResidueFootprint(teardown, rep.arm);
	if (teardownHostFootprint === null) return null;
	return {
		turnLatencyP95,
		throughput,
		lagP95: Math.max(...perThreadLag),
		coldReadiness: median(coldReadiness),
		teardownHostFootprint,
	};
}

/**
 * Worker arm: the resident host root's footprint, which must be a live read.
 * Standalone: owned residue beyond the driver; a member the OS confirmed exited
 * holds nothing (the same policy as sample completeness).
 */
export function hostResidueFootprint(sample: CohortSample, arm: ArmKind): number | null {
	let total = 0;
	let liveHosts = 0;
	for (const member of sample.members) {
		if (arm === "worker" ? member.reason !== "root" : member.reason === "driver") continue;
		if (arm === "standalone" && member.read.status === "absent") continue;
		if (member.read.status !== "ok") return null;
		total += member.read.physFootprint;
		liveHosts += 1;
	}
	return arm === "worker" && liveHosts === 0 ? null : total;
}

function activeWindow(events: RunnerEvent[], sessionCount: number): { start: number; end: number } | null {
	const windows: Array<{ start: number; end: number }> = [];
	for (let sessionIndex = 0; sessionIndex < sessionCount; sessionIndex += 1) {
		const phases = events
			.filter((event): event is Extract<RunnerEvent, { type: "phase" }> => event.type === "phase" && event.sessionIndex === sessionIndex)
			.sort((left, right) => left.t - right.t);
		const activeTimes = phases.filter(event => event.phase.startsWith("active:")).map(event => event.t);
		if (activeTimes.length === 0) return null;
		const lastActive = Math.max(...activeTimes);
		const endEvent = phases.find(event => (event.phase === "idle" || event.phase === "disposing") && event.t > lastActive);
		if (!endEvent) return null;
		windows.push({ start: Math.min(...activeTimes), end: endEvent.t });
	}
	return { start: Math.min(...windows.map(window => window.start)), end: Math.max(...windows.map(window => window.end)) };
}

function evaluateChurn(churn: ChurnRecord | undefined, cycles: number, maximumGrowth: number): Measurement {
	if (!churn) return { value: null, detail: "Churn record is missing" };
	if (churn.completedCycles < cycles || churn.cycleSamples.length < cycles || churn.cycleErrors.length < cycles) {
		return { value: null, detail: `Expected ${cycles} completed cycles, got ${churn.completedCycles}` };
	}
	// Every cycle must run its full workload cleanly and sample completely; a cycle
	// that failed or sampled partially means the growth ratio measures something else.
	const failedCycle = churn.cycleErrors.slice(0, cycles).findIndex(errors => errors.length > 0);
	if (failedCycle >= 0) {
		return { value: null, detail: `Cycle ${failedCycle + 1} had session failures: ${churn.cycleErrors[failedCycle]!.join("; ")}` };
	}
	const incompleteCycle = churn.cycleSamples.slice(0, cycles).findIndex(sample => !isSampleComplete(sample));
	if (incompleteCycle >= 0) return { value: null, detail: `Cycle ${incompleteCycle + 1} post-close sample is incomplete` };
	const firstHost = churn.hostFootprints[0];
	const lastHost = churn.hostFootprints[cycles - 1];
	if (firstHost === undefined || lastHost === undefined || firstHost === null || lastHost === null || !validFootprint(firstHost) || !validFootprint(lastHost) || firstHost === 0) {
		return { value: null, detail: "Cycle-1 or cycle-20 host footprint is missing or invalid" };
	}
	return {
		value: lastHost / firstHost - 1,
		passesThreshold: lastHost <= firstHost * (1 + maximumGrowth),
		detail: "Host footprints are compared at the post-close phase point.",
	};
}

function evaluateOrphans(
	standalone: RepRecord[],
	worker: RepRecord[],
	churn: { standalone?: ChurnRecord; worker?: ChurnRecord },
	reps: RepEligibility[],
	minimum: number,
	concurrency: number,
	contract: PreregistrationContract,
): ReportGate {
	const validCount = (arm: "standalone" | "worker"): number => reps.filter(rep => rep.arm === arm && rep.n === concurrency && rep.valid).length;
	if (validCount("standalone") < minimum || validCount("worker") < minimum || !churn.standalone || !churn.worker) {
		return {
			name: "orphans",
			verdict: "insufficient-evidence",
			standalone: null,
			worker: null,
			threshold: "Zero owned and unresolved-ownership orphans in both arms and churn records",
			detail: `At least ${minimum} valid N=${concurrency} reps per arm and both churn orphan receipts are required.`,
		};
	}
	const receipts = [
		...standalone.filter(rep => rep.n === concurrency).map(rep => rep.orphans),
		...worker.filter(rep => rep.n === concurrency).map(rep => rep.orphans),
		churn.standalone.orphans,
		churn.worker.orphans,
	];
	if (receipts.some(receipt => !receipt.complete)) {
		return {
			name: "orphans",
			verdict: "insufficient-evidence",
			standalone: null,
			worker: null,
			threshold: "Zero owned and unresolved-ownership orphans in both arms and churn records",
			detail: "At least one orphan receipt comes from an incomplete process enumeration and cannot prove zero.",
		};
	}
	const orphanCount = (repetitions: RepRecord[]): number => repetitions
		.filter(rep => rep.n === concurrency)
		.reduce((sum, rep) => sum + rep.orphans.owned.length + rep.orphans.unresolved.length, 0);
	const standaloneCount = orphanCount(standalone) + churn.standalone.orphans.owned.length + churn.standalone.orphans.unresolved.length;
	const workerCount = orphanCount(worker) + churn.worker.orphans.owned.length + churn.worker.orphans.unresolved.length;
	const limit = contract.thresholds.orphans.maximumOwned + contract.thresholds.orphans.maximumUnresolvedOwnership;
	const passed = standaloneCount === 0 && workerCount === 0 && limit === 0;
	return {
		name: "orphans",
		verdict: passed ? "pass" : "fail",
		standalone: standaloneCount,
		worker: workerCount,
		threshold: `Both counts must be 0 (owned ≤ ${contract.thresholds.orphans.maximumOwned}; unresolved ownership ≤ ${contract.thresholds.orphans.maximumUnresolvedOwnership})`,
		detail: `Owned plus unresolved-ownership orphan receipts: standalone ${standaloneCount}, worker ${workerCount}.`,
	};
}

function measurements(repetitions: RepRecord[], measure: (rep: RepRecord) => number | null, minimum: number): Measurement {
	if (repetitions.length < minimum) return { value: null };
	const values = repetitions.map(measure);
	if (values.some(value => value === null || !Number.isFinite(value))) return { value: null };
	const numbers = values.filter((value): value is number => value !== null);
	return { value: median(numbers) };
}

function compareGate(input: {
	name: string;
	standalone: Measurement;
	worker: Measurement;
	threshold: string;
	missingDetail: string;
	passes: (standalone: number, worker: number) => boolean;
	detail: (standalone: number, worker: number) => string;
}): ReportGate {
	const standalone = input.standalone.value;
	const worker = input.worker.value;
	if (standalone === null || worker === null) {
		return { name: input.name, verdict: "insufficient-evidence", standalone, worker, threshold: input.threshold, detail: input.missingDetail };
	}
	return {
		name: input.name,
		verdict: input.passes(standalone, worker) ? "pass" : "fail",
		standalone,
		worker,
		threshold: input.threshold,
		detail: input.detail(standalone, worker),
	};
}

function absoluteGate(input: {
	name: string;
	standalone: Measurement;
	worker: Measurement;
	threshold: string;
	missingDetail: string;
	limit: number | null;
	detail: (standalone: number | null, worker: number | null) => string;
}): ReportGate {
	const standalone = input.standalone.value;
	const worker = input.worker.value;
	if (standalone === null || worker === null || input.limit === null) {
		return { name: input.name, verdict: "insufficient-evidence", standalone, worker, threshold: input.threshold, detail: input.missingDetail };
	}
	const passed = input.name === "event-loop lag" ? standalone <= input.limit && worker <= input.limit : worker <= input.limit;
	return {
		name: input.name,
		verdict: passed ? "pass" : "fail",
		standalone,
		worker,
		threshold: input.threshold,
		detail: input.detail(standalone, worker),
	};
}

function medianOfMeasurements(measurement: Measurement): number | null {
	return measurement.value;
}

function percentile(values: number[], proportion: number): number {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.max(0, Math.ceil(proportion * sorted.length) - 1)]!;
}

function median(values: number[]): number {
	const ordered = [...values].sort((left, right) => left - right);
	const middle = Math.floor(ordered.length / 2);
	return ordered.length % 2 === 0 ? (ordered[middle - 1]! + ordered[middle]!) / 2 : ordered[middle]!;
}

function validFootprint(value: number): boolean {
	return Number.isFinite(value) && value >= 0;
}

function format(value: number | null): string {
	return value === null ? "n/a" : Number.isFinite(value) ? String(Number(value.toPrecision(6))) : "n/a";
}

function escapeCell(value: string): string {
	return value.replaceAll("|", "\\|").replaceAll("\n", " ").replaceAll("\r", " ");
}
