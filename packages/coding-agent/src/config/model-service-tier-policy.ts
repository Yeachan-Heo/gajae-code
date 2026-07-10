import { type Provider, type ResolvedServiceTier, resolveServiceTier, type ServiceTier } from "@gajae-code/ai";

/** Persisted per-model policy values. `inherit` is runtime-only. */
export type ModelServiceTierOverride = "on" | "off";
export type ModelServiceTierDecision = ModelServiceTierOverride | "inherit";

export type ModelServiceTierOverrides = Record<string, ModelServiceTierOverride>;

/** The canonical key for a resolved model. Keep provider identity in the key. */
export function formatModelServiceTierOverrideKey(provider: string, model: string): string {
	return `${provider}/${model}`;
}

/** Removes malformed persisted entries without changing the caller's object. */
export function sanitizeModelServiceTierOverrides(value: unknown): ModelServiceTierOverrides {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	const result: ModelServiceTierOverrides = {};
	for (const [key, override] of Object.entries(value)) {
		if (key.length > 0 && (override === "on" || override === "off")) result[key] = override;
	}
	return result;
}

export interface ModelServiceTierPolicyStatus {
	rawBaseline: ServiceTier | undefined;
	rawRequestTier: ServiceTier | undefined;
	providerResolvedTier: ResolvedServiceTier | undefined;
	decision: ModelServiceTierDecision;
	effectiveTier: ResolvedServiceTier | undefined;
	overrideKey: string;
	override: ModelServiceTierOverride | undefined;
}

/** Resolve raw intent and the exact provider/model override without mutation. */
export function resolveModelServiceTierPolicy(args: {
	rawBaseline: ServiceTier | undefined;
	provider: Provider | undefined;
	model: string;
	overrides?: unknown;
	decision?: ModelServiceTierDecision;
}): ModelServiceTierPolicyStatus {
	const overrideKey =
		args.provider === undefined ? args.model : formatModelServiceTierOverrideKey(args.provider, args.model);
	const override = sanitizeModelServiceTierOverrides(args.overrides)[overrideKey];
	const decision = args.decision ?? override ?? "inherit";
	const providerResolvedTier = resolveServiceTier(args.rawBaseline, args.provider);
	const rawRequestTier = decision === "on" ? "priority" : args.rawBaseline;
	const effectiveTier =
		decision === "on"
			? "priority"
			: decision === "off" && providerResolvedTier === "priority"
				? undefined
				: providerResolvedTier;
	return {
		rawBaseline: args.rawBaseline,
		rawRequestTier,
		providerResolvedTier,
		decision,
		effectiveTier,
		overrideKey,
		override,
	};
}

export const getModelServiceTierOverrideKey = formatModelServiceTierOverrideKey;
export const sanitizeModelServiceTierOverrideSettings = sanitizeModelServiceTierOverrides;
export const resolveModelServiceTier = resolveModelServiceTierPolicy;
