import {
	type CustomizeDoctorItem,
	type CustomizeDoctorReport,
	type CustomizeDoctorSurface,
	runCustomizeDoctor,
} from "../customize-doctor";
import { createDoctorContext, type DoctorContext } from "./context";
import { canonicalDigest, pluginTargetId } from "./ids";
import type { DoctorProbeReceipt } from "./probe-types";
import { PROJECTION_RECEIPT_BUDGET_BYTES } from "./probe-types";
import type { DoctorCheck } from "./types";

const MAX_ITEMS_PER_SURFACE = 1000;

/**
 * A healthy item carries nothing the surface coverage count does not already
 * state, and its digest id is not a repair target (plugin repairs resolve their
 * targets through the dedicated plugin collector). Emitting one check per
 * healthy item is what made an ordinary operator home — 193 discovered skills —
 * exceed the probe transport budget and lose the whole projection surface, so
 * only actionable items become item checks. `suppressedOk` keeps the coverage
 * evidence honest about what was summarized rather than emitted.
 */
interface ProjectionSurfaceState {
	readonly surface: CustomizeDoctorSurface;
	readonly itemChecks: readonly DoctorCheck[];
	readonly initiallyOmitted: number;
	readonly suppressedOk: number;
}

interface SurfaceItemCounts {
	readonly emitted: number;
	readonly omitted: number;
}

function buildItemCheck(
	item: CustomizeDoctorItem,
	surface: CustomizeDoctorSurface,
	context: DoctorContext,
): DoctorCheck {
	const source = context.sources.find(candidate => candidate.scope === item.scope);
	const rootId = source?.root.rootId ?? context.agentRoot.rootId;
	const isPlugin = item.kind === "plugin-bundle";
	const family = item.provider === "gjc-bundle" ? "gjc" : "npm";
	const targetId =
		isPlugin && source
			? pluginTargetId(rootId, family, source.scope, item.name)
			: `t1:projection:${rootId}:${surface.kind}:n${canonicalDigest([item.name])}`;
	return {
		id: `projection.${surface.kind}.${rootId}.${canonicalDigest([item.name, item.provider])}`,
		targetId,
		...(source ? { scope: source.scope } : {}),
		execution: "completed",
		health:
			item.status === "rejected" || item.status === "quarantined"
				? "warning"
				: item.reason === "load-error" || item.reason === "invalid-config"
					? "error"
					: "ok",
		evidenceLevel: "observed",
		reasonCode: item.reason.replaceAll("-", "_"),
		dependsOn: ["config"],
		evidence: {
			status: item.status,
			sourceClass: item.sourceClass,
			...(item.mcp
				? {
						transport: item.mcp.transport ?? "unknown",
						enabled: item.mcp.enabled ?? true,
						autoload: item.mcp.autoload ?? true,
						hasAuth: item.mcp.hasAuth,
						runtimeProbed: false,
					}
				: {}),
		},
		remediationIds: isPlugin ? ["plugin.restore-known-artifact", "plugin.quarantine-selected"] : [],
	};
}

function itemCounts(state: ProjectionSurfaceState, shed: ReadonlySet<DoctorCheck>): SurfaceItemCounts {
	let shedCount = 0;
	for (const check of state.itemChecks) if (shed.has(check)) shedCount++;
	return {
		emitted: state.itemChecks.length - shedCount + state.suppressedOk,
		omitted: state.initiallyOmitted + shedCount,
	};
}

function buildSurfaceCoverageCheck(
	state: ProjectionSurfaceState,
	context: DoctorContext,
	shed: ReadonlySet<DoctorCheck>,
): DoctorCheck {
	const counts = itemCounts(state, shed);
	const hasWarnings = (state.surface.warnings?.length ?? 0) > 0;
	const limited = counts.omitted > 0;
	return {
		id: `projection.${state.surface.kind}.coverage`,
		targetId: `t1:projection:${context.agentRoot.rootId}:${state.surface.kind}`,
		execution: hasWarnings || limited ? "blocked" : "completed",
		health: hasWarnings || limited ? "unknown" : "ok",
		evidenceLevel: "observed",
		reasonCode: limited ? "limit_exceeded" : hasWarnings ? "projection_incomplete" : "projection_collected",
		dependsOn: ["config"],
		evidence: {
			count: state.surface.items.length,
			warningCount: state.surface.warnings?.length ?? 0,
			...(limited ? { counts: { emitted: counts.emitted, omitted: counts.omitted } } : {}),
		},
		remediationIds: [],
	};
}

function buildAggregateCoverageCheck(
	projection: CustomizeDoctorReport,
	states: readonly ProjectionSurfaceState[],
	context: DoctorContext,
	shed: ReadonlySet<DoctorCheck>,
): DoctorCheck {
	let emitted = 0;
	let omitted = 0;
	let warningCount = projection.warnings.length;
	for (const state of states) {
		const counts = itemCounts(state, shed);
		emitted += counts.emitted;
		omitted += counts.omitted;
		warningCount += state.surface.warnings?.length ?? 0;
	}
	const limited = omitted > 0;
	const incomplete = warningCount > 0;
	return {
		id: "projection.coverage",
		targetId: `t1:projection:${context.agentRoot.rootId}`,
		execution: limited || incomplete ? "blocked" : "completed",
		health: limited || incomplete ? "unknown" : "ok",
		evidenceLevel: "observed",
		reasonCode: limited ? "limit_exceeded" : incomplete ? "projection_incomplete" : "projection_collected",
		dependsOn: ["config"],
		evidence: {
			warningCount,
			...(limited ? { counts: { emitted, omitted } } : {}),
		},
		remediationIds: [],
	};
}

function buildProjectionReceipt(
	projection: CustomizeDoctorReport,
	states: readonly ProjectionSurfaceState[],
	context: DoctorContext,
	shed: ReadonlySet<DoctorCheck>,
): DoctorProbeReceipt {
	const checks: DoctorCheck[] = [];
	for (const state of states) {
		for (const itemCheck of state.itemChecks) {
			if (!shed.has(itemCheck)) checks.push(itemCheck);
		}
		checks.push(buildSurfaceCoverageCheck(state, context, shed));
	}
	checks.push(buildAggregateCoverageCheck(projection, states, context, shed));
	return { schemaVersion: 1, kind: "projection", status: "completed", reasonCode: "projection_collected", checks };
}

function serializedReceiptBytes(receipt: DoctorProbeReceipt): number {
	return Buffer.byteLength(JSON.stringify(receipt));
}

function shedFromTail(
	candidates: readonly DoctorCheck[],
	count: number,
	base: ReadonlySet<DoctorCheck>,
): Set<DoctorCheck> {
	const shed = new Set(base);
	for (const check of candidates.slice(Math.max(0, candidates.length - count))) shed.add(check);
	return shed;
}

function shedUntilWithinBudget(
	candidates: readonly DoctorCheck[],
	base: ReadonlySet<DoctorCheck>,
	buildReceipt: (shed: ReadonlySet<DoctorCheck>) => DoctorProbeReceipt,
): { shed: Set<DoctorCheck>; receipt: DoctorProbeReceipt } {
	const initialShed = new Set(base);
	const initialReceipt = buildReceipt(initialShed);
	if (serializedReceiptBytes(initialReceipt) <= PROJECTION_RECEIPT_BUDGET_BYTES || candidates.length === 0)
		return { shed: initialShed, receipt: initialReceipt };

	let low = 1;
	let high = candidates.length;
	let bestCount: number | undefined;
	while (low <= high) {
		const count = Math.floor((low + high) / 2);
		const candidateShed = shedFromTail(candidates, count, initialShed);
		const candidateReceipt = buildReceipt(candidateShed);
		if (serializedReceiptBytes(candidateReceipt) <= PROJECTION_RECEIPT_BUDGET_BYTES) {
			bestCount = count;
			high = count - 1;
		} else {
			low = count + 1;
		}
	}

	const count = bestCount ?? candidates.length;
	const shed = shedFromTail(candidates, count, initialShed);
	return { shed, receipt: buildReceipt(shed) };
}

export async function collectProjectionProbe(): Promise<DoctorProbeReceipt> {
	const context = createDoctorContext({
		mode: "diagnose",
		json: true,
		help: false,
		checks: [],
		allowRisks: [],
		yes: false,
	});
	const projection = await runCustomizeDoctor(context.cwd);
	const states: ProjectionSurfaceState[] = projection.surfaces.map(surface => {
		const items = surface.items.slice(0, MAX_ITEMS_PER_SURFACE);
		const itemChecks: DoctorCheck[] = [];
		let suppressedOk = 0;
		for (const item of items) {
			const check = buildItemCheck(item, surface, context);
			if (check.health === "ok") {
				suppressedOk += 1;
				continue;
			}
			itemChecks.push(check);
		}
		return {
			surface,
			itemChecks,
			initiallyOmitted: surface.items.length - items.length,
			suppressedOk,
		};
	});
	// Only actionable item checks remain, so shedding is a last-resort bound for
	// a surface with thousands of genuine warnings/errors, not the normal path.
	const actionableCandidates = states.flatMap(state => [...state.itemChecks]);
	const build = (shed: ReadonlySet<DoctorCheck>) => buildProjectionReceipt(projection, states, context, shed);
	let shed = new Set<DoctorCheck>();
	let receipt = build(shed);
	if (serializedReceiptBytes(receipt) > PROJECTION_RECEIPT_BUDGET_BYTES) {
		const result = shedUntilWithinBudget(actionableCandidates, shed, build);
		shed = result.shed;
		receipt = result.receipt;
	}
	return receipt;
}
