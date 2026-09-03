/**
 * Billing path for a resolved binding's credential source — audit-reversible.
 * Derived from (model.api, credential-provenance) where the binding actually
 * resolves credentials, not from a provider-name allowlist.
 */
import type { Api } from "@gajae-code/ai/core";
import type { EffectiveProviderAuth } from "./provider-selection-policy";

/**
 * Label shown in the selector row + active-model line. Only the category is
 * disclosed (never the key material or project id).
 */
export type BillingPathKind = "metered-api" | "cloud-project" | "bundled";

export interface BillingPath {
	kind: BillingPathKind;
	/** Stable per-credential-source key for one-time notice dismissal. */
	dismissKey: string;
	label: string;
}

/**
 * Derive from the concrete binding (api + credential provenance).
 * - oauth/keyless/unknown => bundled (plan/proxied/kNoAuth-like)
 * - key + cloud-project api (google-vertex / bedrock) => cloud-project
 * - key + any other api (including custom OpenAI-compatible) => metered-api
 */
export function deriveBillingPath(
	provider: string,
	api: Api | string | undefined,
	effectiveAuth: EffectiveProviderAuth,
): BillingPath | undefined {
	if (effectiveAuth === "oauth" || effectiveAuth === "keyless" || effectiveAuth === "unknown") return undefined;
	if (effectiveAuth !== "key") return undefined;
	const apiKind = typeof api === "string" ? api : undefined;
	const cloudApis = new Set(["google-vertex", "bedrock-converse-stream"]);
	const isCloud = apiKind ? cloudApis.has(apiKind) : false;
	const kind: BillingPathKind = isCloud ? "cloud-project" : "metered-api";
	const label = kind === "cloud-project" ? "cloud-project billing" : "metered API";
	const dismissKey = `${kind}:${provider.trim().toLowerCase()}`;
	return { kind, dismissKey, label };
}
