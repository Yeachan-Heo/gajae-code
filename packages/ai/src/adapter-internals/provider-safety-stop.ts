import type { Api, AssistantMessage, Model } from "../types";

/** This module is intentionally outside the package export map. */
const PROVIDER_SAFETY_STOP_ADAPTER_BRAND = Symbol("provider-safety-stop-adapter-brand");
const PROVIDER_SAFETY_STOP_INVOCATION_BRAND = Symbol("provider-safety-stop-invocation-brand");
const PROVIDER_SAFETY_STOP_INVOCATION_KEY = Symbol("provider-safety-stop-invocation");
const PROVIDER_SAFETY_STOP_MODEL_IDENTITY_KEY = Symbol("provider-safety-stop-model-identity");
const PROVIDER_SAFETY_STOP_WIRE_MODEL_ID_KEY = Symbol("provider-safety-stop-wire-model-id");

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

/** Check if a value is a plain object with only data properties. Rejects Proxies and non-plain prototypes. */
function isPlainDataObject(obj: unknown): boolean {
	if (typeof obj !== "object" || obj === null) return false;
	// Check prototype chain - must be Object.prototype or null
	const proto = Object.getPrototypeOf(obj);
	if (proto !== null && proto !== Object.prototype) return false;
	// Attempt to detect Proxies by using Object.getOwnPropertyNames.
	// For plain objects, this returns the property names.
	// For some Proxies, this might fail or return unexpected results.
	try {
		Object.getOwnPropertyNames(obj);
	} catch {
		// If getOwnPropertyNames throws, this is not a plain object
		return false;
	}
	// Additional Proxy detection: test if toString works without side effects
	try {
		const str = Object.prototype.toString.call(obj);
		// Must return "[object Object]" for plain objects
		if (str !== "[object Object]") return false;
	} catch {
		return false;
	}
	return true;
}

/**
 * Build and register a trusted clone from the original's snapshot.
 * This function validates optional caller-provided fields in a single read, then builds a fresh object
 * from the original's trusted identity snapshot, ensuring that trust is never based on a Proxy.
 * Non-identity fields from the provided clone are preserved in the returned object.
 *
 * Returns a clone object with trusted identity fields and optional merged fields if the original is trusted,
 * or null if the original is not trusted or validation fails.
 * Package-internal only; external consumers cannot import from adapter-internals.
 */
export function registerTrustedModelCloneInternal(
	original: object,
	clone?: object,
): { api?: string; provider?: string; id?: string; baseUrl?: string } | null {
	const originalSnapshot = trustedProviderSafetyStopModels.get(original);
	if (!originalSnapshot) return null;

	// If a clone is provided, validate it once to ensure identity fields match
	let cloneBaseUrl: string | undefined = originalSnapshot.baseUrl;
	if (clone !== undefined) {
		// Validate clone is a plain object with data properties for identity fields
		if (!isPlainDataObject(clone)) return null;
		// Each identity field must either not exist or be a data property (no accessors)
		for (const prop of ["api", "provider", "id", "baseUrl"]) {
			const desc = Object.getOwnPropertyDescriptor(clone, prop);
			if (desc && ("get" in desc || "set" in desc)) {
				// Has an accessor - reject
				return null;
			}
		}

		// Read identity fields from clone exactly once into local variables.
		// This single snapshot prevents Proxy traps from switching values on subsequent reads.
		const readApi = (clone as { api?: string }).api;
		const readProvider = (clone as { provider?: string }).provider;
		const readId = (clone as { id?: string }).id;
		const readBaseUrl = (clone as { baseUrl?: string }).baseUrl;

		// Compare only the values captured in this single read.
		// If any identity field doesn't match, reject.
		if (
			readApi !== originalSnapshot.api ||
			readProvider !== originalSnapshot.provider ||
			readId !== originalSnapshot.id
		) {
			// Identity mismatch: clone is not trusted
			return null;
		}

		// BaseUrl must either match exactly or be the result of stripping userinfo/query/hash
		if (readBaseUrl !== originalSnapshot.baseUrl) {
			const expectedStrippedUrl = computeStrippedBaseUrl(originalSnapshot.baseUrl);
			if (readBaseUrl !== expectedStrippedUrl) {
				// BaseUrl mismatch and not a valid derivation: clone is not trusted
				return null;
			}
			// Use the stripped baseUrl from the clone
			cloneBaseUrl = readBaseUrl;
		}
	}

	// Build a fresh object from the trusted snapshot.
	// This object is entirely controlled by the runtime and cannot be a Proxy.
	// Use cloneBaseUrl if it was validated (e.g., stripped version)
	const builtIdentity = {
		api: originalSnapshot.api,
		provider: originalSnapshot.provider,
		id: originalSnapshot.id,
		baseUrl: cloneBaseUrl,
	};

	// If a clone was provided, merge it with the built identity
	// (identity fields take precedence from the trusted snapshot)
	const result = clone
		? ({ ...clone, ...builtIdentity } as { api: string; provider: string; id: string; baseUrl: string | undefined })
		: builtIdentity;

	// Create a snapshot for the final result with the actual baseUrl
	const resultSnapshot: ModelIdentitySnapshot = {
		api: builtIdentity.api,
		provider: builtIdentity.provider,
		id: builtIdentity.id,
		baseUrl: cloneBaseUrl,
	};

	// Register the final result with its own snapshot
	try {
		trustedProviderSafetyStopModels.set(result, resultSnapshot);
	} catch {
		// If setting in the WeakMap fails, fail closed and don't register the clone
		return null;
	}

	return result;
}

/** Verify that a model is the unchanged identity of a bundled catalog entry. Returns the frozen snapshot if trusted, false otherwise. */
export function isProviderSafetyStopModelTrusted(model: unknown): ModelIdentitySnapshot | false {
	if (typeof model !== "object" || model === null) return false;
	const snapshot = trustedProviderSafetyStopModels.get(model);
	if (!snapshot) return false;

	// All identity fields must match exactly
	const modelApi = (model as { api?: string }).api;
	const modelProvider = (model as { provider?: string }).provider;
	const modelId = (model as { id?: string }).id;
	const modelBaseUrl = (model as { baseUrl?: string }).baseUrl;

	if (
		modelApi === snapshot.api &&
		modelProvider === snapshot.provider &&
		modelId === snapshot.id &&
		modelBaseUrl === snapshot.baseUrl
	) {
		return Object.freeze({ ...snapshot });
	}
	return false;
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

/**
 * Snapshot transport fields (fetch, client) exactly once to prevent Proxy/getter-based TOCTOU
 * where the same property returns different values on successive reads.
 * Returns { fetch, client, hasTransport }.
 */
function snapshotCallerTransport(options: object): {
	fetch: unknown;
	client: unknown;
	hasTransport: boolean;
} {
	let fetch: unknown;
	let client: unknown;
	try {
		fetch = Reflect.get(options, "fetch");
		client = Reflect.get(options, "client");
	} catch {
		// If getter throws, treat as having transport (caller-provided error handling takes precedence)
		fetch = {}; // Non-undefined to signal transport presence
	}
	const hasTransport = fetch !== undefined || client !== undefined;
	return { fetch, client, hasTransport };
}

/** Attach runtime-owned adapter authority only when no caller transport seam is present. */
export function withProviderSafetyStopAdapterInvocation<T extends object>(options: T): T {
	// Snapshot transport fields exactly once to prevent Proxy getters from returning different
	// values on successive reads (TOCTOU). After this snapshot, all authority decisions and
	// object construction MUST use only the snapshotted values, never reading from options again.
	const { fetch, client, hasTransport } = snapshotCallerTransport(options);
	if (hasTransport) return options;

	// No caller transport detected. Add the runtime adapter invocation marker.
	// Always assign fetch and client from the snapshot (even if undefined) to ensure that
	// if options is a Proxy, our snapshot values take precedence over any subsequent getter calls.
	const result = {
		...options,
		fetch,
		client,
		[PROVIDER_SAFETY_STOP_INVOCATION_KEY]: PROVIDER_SAFETY_STOP_ADAPTER_INVOCATION,
	} as T;
	return result;
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

/** Attach the validated model identity snapshot to options to prevent TOCTOU on getters. */
export function attachProviderSafetyStopModelIdentity<T extends object>(
	options: T,
	snapshot: ModelIdentitySnapshot,
	wireModelId?: string,
): T {
	if (!snapshot) return options;
	return {
		...options,
		[PROVIDER_SAFETY_STOP_MODEL_IDENTITY_KEY]: snapshot,
		[PROVIDER_SAFETY_STOP_WIRE_MODEL_ID_KEY]: wireModelId,
	} as T;
}

/** Retrieve the validated model identity snapshot from options, or null if not attached. */
export function getProviderSafetyStopModelIdentity(options: unknown): ModelIdentitySnapshot | null {
	if (!options || typeof options !== "object") return null;
	try {
		const snapshot = Reflect.get(options, PROVIDER_SAFETY_STOP_MODEL_IDENTITY_KEY);
		return snapshot && typeof snapshot === "object" ? (snapshot as ModelIdentitySnapshot) : null;
	} catch {
		return null;
	}
}

/** Retrieve the wireModelId from options, or undefined if not attached. */
export function getProviderSafetyStopWireModelId(options: unknown): string | undefined {
	if (!options || typeof options !== "object") return undefined;
	try {
		const wireModelId = Reflect.get(options, PROVIDER_SAFETY_STOP_WIRE_MODEL_ID_KEY);
		return typeof wireModelId === "string" ? wireModelId : undefined;
	} catch {
		return undefined;
	}
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
 *
 * Trust assumption: Providers that do not accept caller-controlled transport
 * seams (e.g., Kiro's kiro-codewhisperer-stream and kiro-api-key) assume that
 * globalThis.fetch is the system-provided implementation and is not replaced
 * by user code after module load. This is safe in runtime contexts (production,
 * secure integration tests) but may not hold in test environments where modules
 * are loaded once and globalThis.fetch is mocked for multiple test cases.
 * Tests must mock providers at a higher level or use the provider test harness
 * rather than relying on globalThis.fetch replacement after import.
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
