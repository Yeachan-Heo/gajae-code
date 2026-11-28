/**
 * AgentLoop calls `getApiKey(provider)` before `streamFn`.
 * Resolve/stream already use `getApiKey(model)`. If those two lookups diverge,
 * the child dies locally (~8ms, 0 tokens, sanitized "Agent run failed.")
 * and never reaches the working model-scoped path (#5081).
 */
export type SessionApiKeyModel = {
	provider: string;
	baseUrl?: string;
};

/** A resolved key plus the stored credential row that supplied it, when any. */
export type SessionApiKeyLookup = {
	apiKey: string | undefined;
	credentialRowId: number | undefined;
};

export type SessionApiKeyRegistry = {
	getApiKeyWithCredentialRowId(
		model: SessionApiKeyModel,
		sessionId?: string,
		options?: { signal?: AbortSignal },
	): Promise<SessionApiKeyLookup>;
	getApiKeyForProviderWithCredentialRowId(
		provider: string,
		sessionId?: string,
		baseUrl?: string,
		options?: { signal?: AbortSignal },
	): Promise<SessionApiKeyLookup>;
};

export type SessionApiKeyResolution = {
	apiKey: string;
	/** Stored credential row behind `apiKey`; undefined for runtime, config, env, or fallback keys. */
	credentialRowId: number | undefined;
	credentialSessionId: string | undefined;
};

export type SessionApiKeyCredentialType = "api_key" | "oauth" | undefined;

export function isStableSessionApiKeyCredentialType(
	previous: SessionApiKeyCredentialType,
	replacement: SessionApiKeyCredentialType,
): boolean {
	return previous === replacement;
}

export function resolveLiveSessionApiKeyModel(
	live: SessionApiKeyModel | undefined,
	captured: SessionApiKeyModel | undefined,
	provider: string,
): SessionApiKeyModel | undefined {
	if (live?.provider === provider) return live;
	if (captured?.provider === provider) return captured;
	return undefined;
}

async function lookupOnce(
	registry: SessionApiKeyRegistry,
	provider: string,
	sessionId: string | undefined,
	model: SessionApiKeyModel | undefined,
	signal: AbortSignal | undefined,
): Promise<SessionApiKeyLookup> {
	signal?.throwIfAborted();
	const matchingModel = model?.provider === provider ? model : undefined;
	const options = signal ? { signal } : undefined;
	let lookup: SessionApiKeyLookup | undefined;
	if (matchingModel) {
		lookup = await registry.getApiKeyWithCredentialRowId(matchingModel, sessionId, options);
		signal?.throwIfAborted();
	}
	if (!lookup?.apiKey) {
		lookup = await registry.getApiKeyForProviderWithCredentialRowId(
			provider,
			sessionId,
			matchingModel?.baseUrl,
			options,
		);
		signal?.throwIfAborted();
	}
	return lookup;
}

export async function lookupSessionApiKey(
	registry: SessionApiKeyRegistry,
	provider: string,
	sessionId: string | undefined,
	model: SessionApiKeyModel | undefined,
	allowUnscopedRetry = true,
	signal?: AbortSignal,
): Promise<SessionApiKeyResolution> {
	let lookup = await lookupOnce(registry, provider, sessionId, model, signal);
	// Architect children inherit the parent SID. Direct `-p --no-session` does
	// not. Scoped miss then global/broker hit is the remaining 0-token death
	// after #5105 (jsonl: Agent run failed / output 0).
	if (!lookup.apiKey && sessionId && allowUnscopedRetry) {
		lookup = await lookupOnce(registry, provider, undefined, model, signal);
		if (lookup.apiKey) {
			return { apiKey: lookup.apiKey, credentialRowId: lookup.credentialRowId, credentialSessionId: undefined };
		}
	}
	if (!lookup.apiKey) {
		throw Object.assign(new Error(`No API key found for provider "${provider}"`), {
			code: "provider_unavailable",
		});
	}
	return { apiKey: lookup.apiKey, credentialRowId: lookup.credentialRowId, credentialSessionId: sessionId };
}
