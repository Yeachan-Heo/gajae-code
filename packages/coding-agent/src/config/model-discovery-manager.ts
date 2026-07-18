import {
	type Api,
	applyFinalCodexGpt56ContextCap,
	createModelManager,
	type Model,
	type ModelRefreshStrategy,
	readModelCache,
} from "@gajae-code/ai";

export interface DiscoveryProvider {
	provider: string;
	optional?: boolean;
}

export type ProviderDiscoveryStatus = "idle" | "ok" | "empty" | "cached" | "unavailable" | "unauthenticated";

export interface ProviderDiscoveryState {
	provider: string;
	status: ProviderDiscoveryStatus;
	optional: boolean;
	stale: boolean;
	fetchedAt?: number;
	models: string[];
	error?: string;
}

export interface DiscoveryRefreshToken {
	provider: string;
	generation: number;
}

/** A generation-guarded, immutable result for the registry to merge into its catalog. */
export interface DiscoveryMergeInput {
	provider: string;
	token: DiscoveryRefreshToken;
	current: boolean;
	models: readonly Model<Api>[];
	state: ProviderDiscoveryState;
	warning?: string;
}

export interface ProviderDiscoveryCallbacks<TProvider extends DiscoveryProvider> {
	cacheDbPath?: string;
	requiresAuth: (provider: TProvider) => boolean;
	peekApiKey: (provider: TProvider) => Promise<string | undefined>;
	isAuthenticated: (apiKey: string | undefined) => boolean;
	fetchModels: (provider: TProvider) => Promise<Model<Api>[]>;
}

/** Owns configured discovery inputs, status, cache lifecycle, and refresh generations. */
export class ModelDiscoveryManager<TProvider extends DiscoveryProvider> {
	#providers: TProvider[] = [];
	#states = new Map<string, ProviderDiscoveryState>();
	#refreshGenerations = new Map<string, number>();
	#lastWarnings = new Map<string, string>();

	reset(): void {
		for (const provider of this.#providers) this.#invalidate(provider.provider);
		this.#providers = [];
		this.#states.clear();
		this.#lastWarnings.clear();
	}

	setProviders(providers: readonly TProvider[]): void {
		const previousProviderIds = new Set(this.#providers.map(provider => provider.provider));
		this.#providers = providers.map(provider => this.#snapshot(provider));
		for (const provider of this.#providers) previousProviderIds.add(provider.provider);
		for (const providerId of previousProviderIds) this.#invalidate(providerId);
		this.#states.clear();
		this.#lastWarnings.clear();
	}

	addProvider(provider: TProvider): void {
		this.#providers.push(this.#snapshot(provider));
		this.#invalidate(provider.provider);
		this.#states.delete(provider.provider);
		this.#lastWarnings.delete(provider.provider);
	}

	get providers(): readonly TProvider[] {
		return this.#providers.map(provider => this.#snapshot(provider));
	}

	providerIds(): Set<string> {
		return new Set(this.#providers.map(provider => provider.provider));
	}

	getState(provider: string): ProviderDiscoveryState | undefined {
		const state = this.#states.get(provider);
		return state === undefined ? undefined : this.#snapshot(state);
	}

	loadCached(provider: TProvider, cacheDbPath?: string): readonly Model<Api>[] {
		const cache = readModelCache<Api>(provider.provider, 24 * 60 * 60 * 1000, Date.now, cacheDbPath);
		const models = applyFinalCodexGpt56ContextCap(cache?.models ?? []);
		this.#states.set(provider.provider, {
			provider: provider.provider,
			status: cache ? "cached" : "idle",
			optional: provider.optional ?? false,
			stale: cache ? !cache.fresh || !cache.authoritative : false,
			fetchedAt: cache?.updatedAt,
			models: models.map(model => model.id),
		});
		return this.#snapshot(models);
	}

	beginRefresh(provider: string): DiscoveryRefreshToken {
		return { provider, generation: this.#invalidate(provider) };
	}

	isCurrent(token: DiscoveryRefreshToken): boolean {
		return (
			this.#refreshGenerations.get(token.provider) === token.generation &&
			this.#providers.some(provider => provider.provider === token.provider)
		);
	}

	async discover(
		provider: TProvider,
		strategy: ModelRefreshStrategy,
		callbacks: ProviderDiscoveryCallbacks<TProvider>,
	): Promise<DiscoveryMergeInput> {
		const token = this.beginRefresh(provider.provider);
		const cached = readModelCache<Api>(provider.provider, 24 * 60 * 60 * 1000, Date.now, callbacks.cacheDbPath);
		const cachedModels = applyFinalCodexGpt56ContextCap(cached?.models ?? []);
		const unauthenticated = (models: readonly Model<Api>[]): DiscoveryMergeInput =>
			this.#complete(token, models, {
				provider: provider.provider,
				status: "unauthenticated",
				optional: provider.optional ?? false,
				stale: cached !== null,
				fetchedAt: cached?.updatedAt,
				models: models.map(model => model.id),
			});

		if (callbacks.requiresAuth(provider)) {
			const apiKey = await callbacks.peekApiKey(provider);
			if (!this.isCurrent(token)) return this.#stale(token);
			if (!callbacks.isAuthenticated(apiKey)) return unauthenticated(cachedModels);
		}

		let error: string | undefined;
		const manager = createModelManager<Api>({
			providerId: provider.provider,
			staticModels: [],
			cacheDbPath: callbacks.cacheDbPath,
			cacheTtlMs: 24 * 60 * 60 * 1000,
			canPublishCache: () => this.isCurrent(token),
			fetchDynamicModels: async () => {
				try {
					return await callbacks.fetchModels(provider);
				} catch (cause) {
					error = cause instanceof Error ? cause.message : String(cause);
					return null;
				}
			},
		});
		const result = await manager.refresh(strategy);
		if (!this.isCurrent(token)) return this.#stale(token);
		const status: ProviderDiscoveryStatus = error
			? result.models.length > 0
				? "cached"
				: "unavailable"
			: strategy === "offline"
				? cached
					? "cached"
					: "idle"
				: result.models.length > 0
					? "ok"
					: "empty";
		const state: ProviderDiscoveryState = {
			provider: provider.provider,
			status,
			optional: provider.optional ?? false,
			stale: result.stale || status === "cached",
			fetchedAt: error ? cached?.updatedAt : Date.now(),
			models: result.models.map(model => model.id),
			error,
		};
		return this.#complete(token, result.models, state, error);
	}

	#complete(
		token: DiscoveryRefreshToken,
		models: readonly Model<Api>[],
		state: ProviderDiscoveryState,
		error?: string,
	): DiscoveryMergeInput {
		const current = this.isCurrent(token);
		if (current) this.#states.set(token.provider, this.#snapshot(state));
		const warning = current && error && this.#lastWarnings.get(token.provider) !== error ? error : undefined;
		if (current) {
			if (error) this.#lastWarnings.set(token.provider, error);
			else this.#lastWarnings.delete(token.provider);
		}
		return this.#snapshot({ provider: token.provider, token, current, models, state, warning });
	}

	#stale(token: DiscoveryRefreshToken): DiscoveryMergeInput {
		return this.#snapshot({
			provider: token.provider,
			token,
			current: false,
			models: [],
			state: this.#states.get(token.provider) ?? {
				provider: token.provider,
				status: "idle",
				optional: false,
				stale: false,
				models: [],
			},
		});
	}

	#invalidate(provider: string): number {
		const generation = (this.#refreshGenerations.get(provider) ?? 0) + 1;
		this.#refreshGenerations.set(provider, generation);
		return generation;
	}

	#snapshot<T>(value: T): T {
		return structuredClone(value);
	}
}
