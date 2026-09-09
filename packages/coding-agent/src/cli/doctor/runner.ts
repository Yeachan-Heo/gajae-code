import { randomUUID } from "node:crypto";
import { VERSION } from "@gajae-code/utils/dirs";
import type { DoctorOptions } from "./args";
import { BASIC_DOCTOR_COLLECTORS, type DoctorCollector, doctorCheck } from "./checks";
import { createDoctorContext, type DoctorContext } from "./context";
import { collectPluginTargets } from "./plugin-targets";
import { collectDoctorProbe } from "./probe-client";
import { executeSelectedDoctorRepair, planSelectedDoctorRepair } from "./repairs";
import { finalizeReport } from "./report";
import { collectServiceTargets } from "./service-targets";
import type { DoctorCheck, DoctorCoverage, DoctorRepair, DoctorReport } from "./types";

const NATIVE_COLLECTOR: DoctorCollector = {
	id: "native",
	dependsOn: [],
	timeoutMs: 5_000,
	async collect(context) {
		const result = await collectDoctorProbe(context, "native");
		return [
			doctorCheck("native.exports", `t1:native:${context.installRoot.rootId}`, {
				execution:
					result.status === "timeout" ? "timeout" : result.status === "cancelled" ? "cancelled" : "completed",
				health: result.status === "completed" ? "ok" : result.status === "failed" ? "error" : "unknown",
				evidenceLevel: "observed",
				reasonCode: result.reasonCode,
				evidence: { runtimeProbed: result.status === "completed" },
				remediationIds: context.compiled ? ["install.restore-binary"] : [],
			}),
		];
	},
};

const PROJECTION_COLLECTOR: DoctorCollector = {
	id: "projection",
	dependsOn: ["config"],
	timeoutMs: 5_000,
	async collect(context) {
		const result = await collectDoctorProbe(context, "projection");
		if (result.status === "completed" && result.receipt) return [...result.receipt.checks];
		return [
			doctorCheck("projection.coverage", `t1:projection:${context.agentRoot.rootId}`, {
				execution:
					result.status === "timeout" ? "timeout" : result.status === "cancelled" ? "cancelled" : "blocked",
				health: "unknown",
				evidenceLevel: "observed",
				reasonCode: result.reasonCode,
				dependsOn: ["config"],
			}),
		];
	},
};

const SERVICE_COLLECTOR: DoctorCollector = {
	id: "service",
	dependsOn: [],
	timeoutMs: 3_000,
	collect: collectServiceTargets,
};
const PLUGIN_COLLECTOR: DoctorCollector = {
	id: "plugin",
	dependsOn: [],
	timeoutMs: 3_000,
	collect: collectPluginTargets,
};
const COLLECTORS: readonly DoctorCollector[] = [
	...BASIC_DOCTOR_COLLECTORS,
	SERVICE_COLLECTOR,
	PLUGIN_COLLECTOR,
	NATIVE_COLLECTOR,
	PROJECTION_COLLECTOR,
];

function coverage(checks: readonly DoctorCheck[], requested: number): DoctorCoverage {
	return {
		requested,
		expanded: checks.length,
		attempted: checks.filter(check => check.execution !== "not_selected").length,
		completed: checks.filter(check => check.execution === "completed").length,
		blocked: checks.filter(check => check.execution === "blocked" || check.execution === "cancelled").length,
		timedOut: checks.filter(check => check.execution === "timeout").length,
		unsupported: checks.filter(check => check.execution === "unsupported").length,
	};
}

function collectFailure(
	context: DoctorContext,
	collector: DoctorCollector,
	execution: "blocked" | "cancelled" | "timeout",
	reasonCode: string,
): DoctorCheck[] {
	return [
		doctorCheck(`${collector.id}.coverage`, `t1:inspection:${context.agentRoot.rootId}:${collector.id}`, {
			execution,
			health: "unknown",
			evidenceLevel: "observed",
			reasonCode,
			dependsOn: collector.dependsOn,
		}),
	];
}

async function runCollector(context: DoctorContext, collector: DoctorCollector): Promise<DoctorCheck[]> {
	if (context.options.signal?.aborted) return collectFailure(context, collector, "cancelled", "cancelled");
	const started = performance.now();
	const remaining = Math.min(collector.timeoutMs, context.deadline - started);
	if (remaining <= 0) return collectFailure(context, collector, "timeout", "deadline_exceeded");
	const expired = Promise.withResolvers<DoctorCheck[]>();
	const timer = setTimeout(
		() => expired.resolve(collectFailure(context, collector, "timeout", "collector_timeout")),
		remaining,
	);
	try {
		const checks = await Promise.race([
			collector.collect(context).catch(() => collectFailure(context, collector, "blocked", "collector_failed")),
			expired.promise,
		]);
		return checks.map(check => ({ ...check, durationMs: Math.round(performance.now() - started) }));
	} finally {
		clearTimeout(timer);
	}
}

function selectedCollectors(options: DoctorOptions): { collectors: DoctorCollector[]; error?: string } {
	const wanted = new Set<string>();
	const registry = new Map(COLLECTORS.map(collector => [collector.id, collector]));
	const add = (id: string) => {
		if (wanted.has(id)) return;
		const collector = registry.get(id);
		if (!collector) return;
		wanted.add(id);
		for (const dependency of collector.dependsOn) add(dependency);
	};
	if (options.checks.length === 0) {
		for (const collector of COLLECTORS)
			if (options.mode !== "dry-run" || (collector.id !== "native" && collector.id !== "projection"))
				add(collector.id);
	} else {
		for (const selector of options.checks) {
			const id = selector.split(".")[0];
			if (!registry.has(id)) return { collectors: [], error: "unknown_check" };
			add(id);
		}
	}
	if (options.repair) {
		const domain = options.repair.split(".")[0];
		add(domain === "install" ? "installation" : domain);
	}
	return { collectors: COLLECTORS.filter(collector => wanted.has(collector.id)) };
}

interface CollectedSelection {
	readonly checks: DoctorCheck[];
	readonly acceptedSelectors: string[];
	readonly invocationError?: string;
}

async function collectSelectedChecks(context: DoctorContext): Promise<CollectedSelection> {
	const options = context.options;
	const selected = selectedCollectors(options);
	const results = new Map<string, DoctorCheck[]>();
	const pending = [...selected.collectors];
	while (pending.length > 0) {
		const available = pending.filter(collector => collector.dependsOn.every(dependency => results.has(dependency)));
		if (available.length === 0) {
			for (const collector of pending)
				results.set(collector.id, collectFailure(context, collector, "blocked", "dependency_unavailable"));
			break;
		}
		const batch = available.slice(0, 3);
		await Promise.all(
			batch.map(async collector => {
				pending.splice(pending.indexOf(collector), 1);
				const failedDependency = collector.dependsOn.some(dependency =>
					results.get(dependency)?.some(check => check.execution !== "completed" || check.health === "error"),
				);
				const checks = failedDependency
					? collectFailure(context, collector, "blocked", "dependency_failed")
					: await runCollector(context, collector);
				results.set(collector.id, checks);
			}),
		);
	}
	const collectedChecks = selected.collectors.flatMap(collector => results.get(collector.id) ?? []);
	const registryIds = new Set(COLLECTORS.map(collector => collector.id));
	const explicitGroups = new Set(options.checks.map(selector => selector.split(".")[0]));
	const acceptedSelectors = options.checks.filter(
		selector => registryIds.has(selector) || collectedChecks.some(check => check.id === selector),
	);
	const unresolvedSelectors = options.checks.filter(selector => !acceptedSelectors.includes(selector));
	const unresolvedInspection = unresolvedSelectors.some(selector =>
		results.get(selector.split(".")[0])?.some(check => check.execution !== "completed"),
	);
	const invocationError =
		selected.error ?? (unresolvedSelectors.length > 0 && !unresolvedInspection ? "unknown_check" : undefined);
	const checks =
		options.checks.length === 0
			? collectedChecks
			: selected.collectors.flatMap(collector => {
					const items = results.get(collector.id) ?? [];
					if (!explicitGroups.has(collector.id) || options.checks.includes(collector.id)) return items;
					return items.filter(
						check =>
							options.checks.includes(check.id) ||
							check.targetId === options.targetId ||
							(unresolvedInspection && check.execution !== "completed"),
					);
				});
	return { checks, acceptedSelectors, invocationError };
}

/** Diagnose first; only a resolved, authorized single action can enter its domain transaction. */
export async function collectDoctorReport(options: DoctorOptions): Promise<DoctorReport> {
	const started = performance.now();
	const runId = options.runId ?? randomUUID();
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(runId)) throw new Error("invalid_doctor_run_id");
	const context = createDoctorContext(options);
	const before = await collectSelectedChecks(context);
	let checks = before.checks;
	let currentChecks = checks;
	let invocationError = before.invocationError;
	const repairs: DoctorRepair[] = [];
	const plan = planSelectedDoctorRepair(context, checks);
	if (plan && !invocationError) {
		if (plan.readiness.includes("target_resolution_incomplete")) {
			checks = [
				...checks,
				doctorCheck("repair.target_resolution", plan.targetId, {
					execution: "blocked",
					health: "unknown",
					evidenceLevel: "not_probed",
					reasonCode: "target_resolution_incomplete",
				}),
			];
			currentChecks = checks;
		}
		if (plan.reasonCode === "unknown_target" || plan.reasonCode === "action_target_mismatch")
			invocationError = plan.reasonCode;
		if (options.mode !== "fix" || invocationError) {
			repairs.push(plan);
		} else {
			const result = await executeSelectedDoctorRepair(context, runId, plan, async () => {
				const remaining = context.deadline - performance.now();
				if (remaining <= 0)
					return [
						doctorCheck("repair.postcheck", plan.targetId, {
							execution: "timeout",
							health: "unknown",
							evidenceLevel: "not_probed",
							reasonCode: "postcheck_deadline_exceeded",
						}),
					];
				const freshContext = createDoctorContext({ ...options, mode: "diagnose", timeoutMs: remaining });
				const fresh = await collectSelectedChecks(freshContext);
				return fresh.checks;
			});
			invocationError = result.invocationError;
			if (result.afterChecks?.length) {
				const historical = before.checks.map(check => ({ ...check, id: `before.${check.id}` }));
				currentChecks = [...result.afterChecks];
				checks = [...historical, ...currentChecks];
				repairs.push({
					...result.repair,
					beforeCheckIds: historical.map(check => check.id),
					afterCheckIds: currentChecks.map(check => check.id),
				});
			} else {
				repairs.push(result.repair);
			}
		}
	}
	return finalizeReport({
		runId,
		mode: options.mode,
		generatedAt: new Date().toISOString(),
		durationMs: Math.round(performance.now() - started),
		subject: {
			gjcVersion: VERSION,
			platform: process.platform,
			arch: process.arch,
			channel: context.compiled ? "standalone" : "source",
			scope: options.scope,
			rootIds: [
				...new Set([
					context.agentRoot.rootId,
					context.installRoot.rootId,
					...context.sources.map(source => source.root.rootId),
				]),
			],
		},
		selection: { checks: before.acceptedSelectors, repair: options.repair, targetId: options.targetId },
		coverage: coverage(currentChecks, options.checks.length || currentChecks.length),
		checks,
		repairs,
		invocationError,
		interrupted: options.signal?.aborted || repairs.some(repair => repair.reasonCode === "cancelled"),
		limits: { fileBytes: 1024 * 1024, probeOutputBytes: 64 * 1024, timeoutMs: options.timeoutMs ?? 15_000 },
	});
}
