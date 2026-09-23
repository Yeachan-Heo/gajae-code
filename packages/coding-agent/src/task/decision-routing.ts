import { createHash } from "node:crypto";
import type { ThinkingLevel } from "@gajae-code/agent-core/thinking";
import type { AuthStorage, Model } from "@gajae-code/ai/core";
import { normalizeTierSelector } from "../config/autorouting";
import { AUTOROUTING_SELECTOR_MAX_LENGTH } from "../config/autorouting-contract";
import { formatModelString } from "../config/model-resolver";
import { splitSelectorThinkingSuffix } from "../thinking";
import type { TaskDecisionObservationInput } from "./decision-collection";
import type {
	DecisionCandidates,
	DecisionErrorCode,
	DecisionOutcome,
	DecisionProvider,
	DecisionTier,
} from "./decision-model";
import { JevDecisionProvider, KevDecisionProvider } from "./decision-providers";

export interface TaskDecisionProviderSelection {
	readonly provider?: DecisionProvider;
	readonly providerName: "kev" | "jev";
	readonly mode: "shadow" | "routing";
	readonly decisionModel: string;
	readonly timeoutMs: number;
	readonly setupError?: DecisionErrorCode;
}
export interface TaskDecisionRoutingContext extends TaskDecisionProviderSelection {
	readonly role: string;
	readonly assignment: string;
	readonly candidates: DecisionCandidates;
	readonly tierSelectors: Readonly<Partial<Record<DecisionTier, string>>>;
	readonly tierEfforts: Readonly<Partial<Record<DecisionTier, ThinkingLevel>>>;
	readonly candidateTiers: readonly DecisionTier[];
	readonly snapshotHash: string;
}

export function createTaskDecisionProvider(options: {
	settings: { get(key: string): unknown };
	authStorage?: AuthStorage;
	credentialSessionId?: string;
}): TaskDecisionProviderSelection | undefined {
	if (options.settings.get("task.decision.enabled") !== true) return undefined;
	const configuredProvider = options.settings.get("task.decision.provider") ?? "kev";
	const configuredMode = options.settings.get("task.decision.mode") ?? "shadow";
	const providerName = configuredProvider === "jev" ? "jev" : "kev";
	const mode = configuredMode === "routing" ? "routing" : "shadow";
	const model =
		providerName === "jev" ? "jev-latest" : (options.settings.get("task.decision.kevModel") ?? "kev-latest");
	const timeoutMs = options.settings.get("task.decision.timeoutMs") ?? 5000;
	const decisionModel = typeof model === "string" ? model.slice(0, 256) : "kev-latest";
	const base = {
		providerName,
		mode,
		decisionModel,
		timeoutMs: typeof timeoutMs === "number" ? timeoutMs : 5000,
	} as const;
	if (
		!["kev", "jev"].includes(String(configuredProvider)) ||
		!["shadow", "routing"].includes(String(configuredMode)) ||
		typeof model !== "string" ||
		!model ||
		model.length > 256 ||
		typeof timeoutMs !== "number" ||
		!Number.isInteger(timeoutMs) ||
		timeoutMs < 1 ||
		timeoutMs > 60_000
	) {
		return { ...base, setupError: "invalid_configuration" };
	}
	try {
		if (providerName === "jev") {
			if (!options.authStorage) return { ...base, setupError: "credential_unavailable" };
			return {
				...base,
				provider: new JevDecisionProvider({
					authStorage: options.authStorage,
					credentialSessionId: options.credentialSessionId,
					timeoutMs,
				}),
			};
		}
		// No endpoint is configurable: the local provider reaches the owned service
		// through its authenticated control socket or not at all.
		return { ...base, provider: new KevDecisionProvider({ model, timeoutMs }) };
	} catch {
		return { ...base, setupError: "invalid_configuration" };
	}
}

export function buildTaskDecisionContext(input: {
	role: string;
	assignment: string;
	tierMap?: Readonly<Partial<Record<DecisionTier, readonly string[]>>>;
	routingSnapshot?: readonly Model[];
	provider: TaskDecisionProviderSelection;
}): TaskDecisionRoutingContext {
	const snapshot = input.routingSnapshot ?? [];
	const tierSelectors: Partial<Record<DecisionTier, string>> = {};
	const tierEfforts: Partial<Record<DecisionTier, ThinkingLevel>> = {};
	const candidates: Partial<Record<DecisionTier, string>> = {};
	for (const tier of ["fast", "balanced", "strong"] as const) {
		for (const configured of input.tierMap?.[tier] ?? []) {
			if (configured.length > AUTOROUTING_SELECTOR_MAX_LENGTH) continue;
			const normalized = normalizeTierSelector(configured, snapshot);
			if (!("pinned" in normalized)) continue;
			const literalModel = snapshot.some(model => formatModelString(model) === normalized.pinned);
			const effort = literalModel ? undefined : splitSelectorThinkingSuffix(normalized.pinned).thinkingLevel;
			tierSelectors[tier] = normalized.pinned;
			if (effort !== undefined) tierEfforts[tier] = effort;
			candidates[tier] = normalized.pinned;
			break;
		}
	}
	return Object.freeze({
		...input.provider,
		role: input.role,
		assignment: input.assignment,
		candidates: Object.freeze(candidates),
		tierSelectors: Object.freeze(tierSelectors),
		tierEfforts: Object.freeze(tierEfforts),
		candidateTiers: Object.freeze(Object.keys(candidates) as DecisionTier[]),
		snapshotHash: createHash("sha256").update(JSON.stringify({ tierSelectors, tierEfforts })).digest("hex"),
	});
}

export function applyTaskDecision(
	context: TaskDecisionRoutingContext,
	outcome: DecisionOutcome,
): {
	selector?: string;
	tier?: DecisionTier;
	effort?: ThinkingLevel;
	errorCode?: DecisionErrorCode;
} {
	if (!outcome.result) return { errorCode: outcome.error.code };
	const tier = outcome.result.choice;
	const selector = context.tierSelectors[tier];
	if (!selector) return { errorCode: "invalid_candidate" };
	return { selector, tier, effort: context.tierEfforts[tier] };
}

export function decisionObservation(
	context: TaskDecisionRoutingContext,
	outcome: DecisionOutcome,
	latencyMs: number,
	observationId: string,
	effectiveSelector?: string,
	effectiveEffort?: string,
): TaskDecisionObservationInput {
	const mapped = applyTaskDecision(context, outcome);
	return {
		observation_id: observationId,
		provider: context.providerName,
		mode: context.mode,
		requested_model: context.decisionModel,
		candidate_tiers: context.candidateTiers,
		...(outcome.result
			? {
					recommended_tier: outcome.result.choice,
					probabilities: { ...outcome.result.probabilities },
					confidence: outcome.result.confidence,
					reported_model: outcome.result.reportedModel,
				}
			: {}),
		latency_ms: latencyMs,
		error_code: mapped.errorCode,
		effective_selector: effectiveSelector,
		effective_effort: effectiveEffort,
		snapshot_hash: context.snapshotHash,
	};
}
