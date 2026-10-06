import type { Api, AssistantMessage, Model } from "../types";

/** This module is intentionally outside the package export map. */
const PROVIDER_SAFETY_STOP_ADAPTER_BRAND = Symbol("provider-safety-stop-adapter-brand");
const PROVIDER_SAFETY_STOP_INVOCATION_BRAND = Symbol("provider-safety-stop-invocation-brand");
const PROVIDER_SAFETY_STOP_INVOCATION_KEY = Symbol("provider-safety-stop-invocation");

interface ModelIdentitySnapshot {
	api?: string;
	provider?: string;
	id?: string;
	baseUrl?: string;
}

const trustedProviderSafetyStopModels = new WeakMap<object, ModelIdentitySnapshot>();

/** Compute the expected baseUrl after stripping userinfo, query, and hash. */
function computeStrippedBaseUrl(baseUrl: string | undefined): string | undefined {
	if (!baseUrl) return baseUrl;
	try {
		const parsed = new URL(baseUrl);
		parsed.username = "";
		parsed.password = "";
		parsed.search = "";
		parsed.hash = "";
		return parsed.toString().replace(/\/$/, "");
	} catch {
		return undefined;
	}
}

/** Register an immutable catalog identity for first-party provider dispatch. */
export function registerProviderSafetyStopModel(model: Model<Api>): void {
	try {
		const snapshot: ModelIdentitySnapshot = {
			api: (model as { api?: string }).api,
			provider: (model as { provider?: string }).provider,
			id: (model as { id?: string }).id,
			baseUrl: (model as { baseUrl?: string }).baseUrl,
		};
		trustedProviderSafetyStopModels.set(model, snapshot);
	} catch {
		// A malformed/hostile model must remain fallback-eligible.
	}
}

/**
 * Register a finalized clone as trusted when the original catalog model is trusted.
 * Called internally only when a model is cloned during finalization.
 * Only trusts the clone if the original is in the trusted registry and the clone's
 * identity matches or is a valid baseUrl derivation of the original's.
 * Package-internal only; external consumers cannot import from adapter-internals.
 */
export function registerTrustedModelCloneInternal(original: object, clone: object): void {
	const originalSnapshot = trustedProviderSafetyStopModels.get(original);
	if (!originalSnapshot) return;

	// Clone's api, provider, and id must match exactly
	const cloneApi = (clone as { api?: string }).api;
	const cloneProvider = (clone as { provider?: string }).provider;
	const cloneId = (clone as { id?: string }).id;
	const cloneBaseUrl = (clone as { baseUrl?: string }).baseUrl;

	if (
		cloneApi !== originalSnapshot.api ||
		cloneProvider !== originalSnapshot.provider ||
		cloneId !== originalSnapshot.id
	) {
		// Identity mismatch: clone is not trusted
		return;
	}

	// BaseUrl must either match exactly or be the result of stripping userinfo/query/hash
	if (cloneBaseUrl !== originalSnapshot.baseUrl) {
		const expectedStrippedUrl = computeStrippedBaseUrl(originalSnapshot.baseUrl);
		if (cloneBaseUrl !== expectedStrippedUrl) {
			// BaseUrl mismatch and not a valid derivation: clone is not trusted
			return;
		}
	}

	// Clone is trusted: snapshot its current state
	const cloneSnapshot: ModelIdentitySnapshot = {
		api: cloneApi,
		provider: cloneProvider,
		id: cloneId,
		baseUrl: cloneBaseUrl,
	};
	trustedProviderSafetyStopModels.set(clone, cloneSnapshot);
}

/** Verify that a model is the unchanged identity of a bundled catalog entry. */
export function isProviderSafetyStopModelTrusted(model: unknown): boolean {
	if (typeof model !== "object" || model === null) return false;
	const snapshot = trustedProviderSafetyStopModels.get(model);
	if (!snapshot) return false;

	// All identity fields must match exactly
	const modelApi = (model as { api?: string }).api;
	const modelProvider = (model as { provider?: string }).provider;
	const modelId = (model as { id?: string }).id;
	const modelBaseUrl = (model as { baseUrl?: string }).baseUrl;

	return (
		modelApi === snapshot.api &&
		modelProvider === snapshot.provider &&
		modelId === snapshot.id &&
		modelBaseUrl === snapshot.baseUrl
	);
}

export type ProviderSafetyStopAdapterCapability = {
	readonly [PROVIDER_SAFETY_STOP_ADAPTER_BRAND]: true;
};

/** The one unforgeable capability shared by first-party adapter parse sites. */
export const PROVIDER_SAFETY_STOP_ADAPTER_CAPABILITY = Object.freeze({
	[PROVIDER_SAFETY_STOP_ADAPTER_BRAND]: true,
}) as ProviderSafetyStopAdapterCapability;

export type ProviderSafetyStopAdapterInvocation = {
	readonly [PROVIDER_SAFETY_STOP_INVOCATION_BRAND]: true;
};

export const PROVIDER_SAFETY_STOP_ADAPTER_INVOCATION = Object.freeze({
	[PROVIDER_SAFETY_STOP_INVOCATION_BRAND]: true,
}) as ProviderSafetyStopAdapterInvocation;

function hasCallerTransport(options: object): boolean {
	try {
		return Reflect.get(options, "fetch") !== undefined || Reflect.get(options, "client") !== undefined;
	} catch {
		return true;
	}
}

/** Attach runtime-owned adapter authority only when no caller transport seam is present. */
export function withProviderSafetyStopAdapterInvocation<T extends object>(options: T): T {
	if (hasCallerTransport(options)) return options;
	return { ...options, [PROVIDER_SAFETY_STOP_INVOCATION_KEY]: PROVIDER_SAFETY_STOP_ADAPTER_INVOCATION } as T;
}

export function isProviderSafetyStopAdapterInvocation(value: unknown): ProviderSafetyStopAdapterInvocation | undefined {
	if (!value || typeof value !== "object") return undefined;
	try {
		return Reflect.get(value, PROVIDER_SAFETY_STOP_INVOCATION_KEY) === PROVIDER_SAFETY_STOP_ADAPTER_INVOCATION
			? PROVIDER_SAFETY_STOP_ADAPTER_INVOCATION
			: undefined;
	} catch {
		return undefined;
	}
}

/** Copy an existing runtime invocation token across a first-party wrapper boundary. */
export function copyProviderSafetyStopAdapterInvocation<T extends object>(source: unknown, destination: T): T {
	return isProviderSafetyStopAdapterInvocation(source)
		? ({ ...destination, [PROVIDER_SAFETY_STOP_INVOCATION_KEY]: PROVIDER_SAFETY_STOP_ADAPTER_INVOCATION } as T)
		: destination;
}

const authenticatedProviderSafetyStops = new WeakSet<object>();

/**
 * Structured refusal vocabulary per first-party adapter. The Google entries
 * mirror the closed lists in `google-shared.ts`.
 */
const STRUCTURED_REFUSAL_SIGNALS: ReadonlySet<string> = new Set([
	// anthropic-messages: stop_reason / stop_details.type
	"refusal",
	"sensitive",
	// openai-completions: finish_reason / error.code
	"content_filter",
	// google-generative-ai: candidate finishReason
	"SAFETY",
	"IMAGE_SAFETY",
	"PROHIBITED_CONTENT",
	"IMAGE_PROHIBITED_CONTENT",
	"SPII",
	"BLOCKLIST",
	"RECITATION",
	"IMAGE_RECITATION",
	"MODEL_ARMOR",
	// google-generative-ai: promptFeedback.blockReason
	"JAILBREAK",
	// kiro-codewhisperer: stop_details.refusal.category
	"CYBER",
	"VIOLENCE",
	"ILLEGAL",
]);

/**
 * Mint terminal authority only from a first-party adapter parse site. The
 * capability is branded by a module-private symbol and is not available from
 * the public `@gajae-code/ai` surface. Caller-controlled transport seams are
 * also not trusted adapter invocations: an injected fetch or SDK client can
 * fabricate a refusal without any provider contact, so adapter call sites
 * pass those seams explicitly and fail closed when one is present. An
 * unrecognized structured signal fails closed, so adapter mistakes remain
 * fallback-eligible.
 */
export function mintProviderSafetyStop(
	message: AssistantMessage,
	signal: string,
	capability: ProviderSafetyStopAdapterCapability,
	callerTransport?: unknown,
	adapterInvocation?: ProviderSafetyStopAdapterInvocation,
): boolean {
	if (
		capability !== PROVIDER_SAFETY_STOP_ADAPTER_CAPABILITY ||
		callerTransport !== undefined ||
		adapterInvocation !== PROVIDER_SAFETY_STOP_ADAPTER_INVOCATION ||
		!STRUCTURED_REFUSAL_SIGNALS.has(signal)
	)
		return false;
	authenticatedProviderSafetyStops.add(message);
	message.errorKind = "provider_safety_stop";
	return true;
}

/** Identity check for terminal provider safety-stop authority. */
export function isProviderSafetyStopAuthenticated(message: unknown): boolean {
	return typeof message === "object" && message !== null && authenticatedProviderSafetyStops.has(message);
}

/**
 * Drop terminal authority for a message. Exposing revocation publicly is
 * safe by construction: it can only remove authority, never grant it, so a
 * hostile caller cannot use it to forge a stop — only to degrade a genuine
 * one to an ordinary fallback-eligible error. The managed runtime uses it to
 * expire marks once a stop has been adjudicated, before the committed
 * message is exposed to later stream dispatches (#4777 review follow-up).
 */
export function revokeProviderSafetyStop(message: unknown): void {
	if (typeof message !== "object" || message === null) return;
	authenticatedProviderSafetyStops.delete(message);
}
