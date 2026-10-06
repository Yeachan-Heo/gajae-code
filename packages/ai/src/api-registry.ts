/**
 * Custom API provider registry.
 *
 * Allows extensions to register streaming functions for custom API types
 * (e.g., "vertex-Anthropic model-api") that are not built into stream.ts.
 */
import type {
	Api,
	AssistantMessageEventStream,
	Context,
	KnownApi,
	Model,
	SimpleStreamOptions,
	StreamOptions,
} from "./types";

const BUILTIN_APIS = new Set<KnownApi>([
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
	"anthropic-messages",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-gemini-cli",
	"google-vertex",
	"ollama-chat",
	"cursor-agent",
	"devin-acp",
	"kiro-codewhisperer-stream",
]);

export type CustomStreamFn = (
	model: Model<Api>,
	context: Context,
	options?: StreamOptions,
) => AssistantMessageEventStream;
export type CustomStreamSimpleFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface RegisteredCustomApi {
	stream: CustomStreamFn;
	streamSimple: CustomStreamSimpleFn;
	sourceId?: string;
}

function assertCustomApiName(api: string): void {
	if (BUILTIN_APIS.has(api as KnownApi)) {
		throw new Error(`Cannot register custom API "${api}": built-in API names are reserved.`);
	}
}

/**
 * Owns custom API handlers for one execution scope. Snapshots copy the registry
 * metadata while deliberately retaining the registered callback references.
 */
export class CustomApiRegistry {
	#entries = new Map<string, RegisteredCustomApi>();
	#disposed = false;

	static assertActive(registry: CustomApiRegistry): void {
		if (typeof registry !== "object" || registry === null || !(#entries in registry)) {
			throw new TypeError("Invalid custom API registry capability.");
		}
		if (registry.#disposed) {
			throw new Error("Custom API registry has been disposed.");
		}
	}

	register(api: string, streamSimple: CustomStreamSimpleFn, sourceId?: string, stream?: CustomStreamFn): void {
		CustomApiRegistry.assertActive(this);
		assertCustomApiName(api);
		this.#entries.set(api, {
			stream: stream ?? ((model, context, options) => streamSimple(model, context, options as SimpleStreamOptions)),
			streamSimple,
			sourceId,
		});
	}

	get(api: string): RegisteredCustomApi | undefined {
		CustomApiRegistry.assertActive(this);
		const entry = this.#entries.get(api);
		return entry ? { ...entry } : undefined;
	}

	unregisterSource(sourceId: string): void {
		CustomApiRegistry.assertActive(this);
		for (const [api, entry] of this.#entries) {
			if (entry.sourceId === sourceId) this.#entries.delete(api);
		}
	}

	clear(): void {
		CustomApiRegistry.assertActive(this);
		this.#entries.clear();
	}

	snapshot(): CustomApiRegistry {
		CustomApiRegistry.assertActive(this);
		const snapshot = new CustomApiRegistry();
		for (const [api, entry] of this.#entries) snapshot.#entries.set(api, { ...entry });
		return snapshot;
	}

	dispose(): void {
		if (typeof this !== "object" || this === null || !(#entries in this)) {
			throw new TypeError("Invalid custom API registry capability.");
		}
		if (this.#disposed) return;
		this.#entries.clear();
		this.#disposed = true;
	}
}

const globalCustomApiRegistry = new CustomApiRegistry();

/**
 * Resolve a custom API provider in the supplied scope. Omitting the registry
 * deliberately selects the process-wide public library registry.
 */
export function resolveCustomApi(api: string, registry?: CustomApiRegistry): RegisteredCustomApi | undefined {
	const scope = registry === undefined ? globalCustomApiRegistry : registry;
	CustomApiRegistry.assertActive(scope);
	return scope.get(api);
}

/**
 * Register a custom API streaming function in the process-wide library registry.
 */
export function registerCustomApi(
	api: string,
	streamSimple: CustomStreamSimpleFn,
	sourceId?: string,
	stream?: CustomStreamFn,
): void {
	globalCustomApiRegistry.register(api, streamSimple, sourceId, stream);
}

/**
 * Get a custom API provider by API identifier from the process-wide library registry.
 */
export function getCustomApi(api: string): RegisteredCustomApi | undefined {
	return globalCustomApiRegistry.get(api);
}

/**
 * Remove all custom APIs registered by a specific source (e.g., extension path).
 */
export function unregisterCustomApis(sourceId: string): void {
	globalCustomApiRegistry.unregisterSource(sourceId);
}

/**
 * Clear all custom API registrations from the process-wide library registry.
 */
export function clearCustomApis(): void {
	globalCustomApiRegistry.clear();
}
