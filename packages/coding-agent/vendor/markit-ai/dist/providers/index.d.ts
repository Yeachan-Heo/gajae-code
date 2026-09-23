import type { MarkitConfig } from "../config.js";
import type { MarkitOptions } from "../types.js";
import type { Provider } from "./types.js";
export type { Provider, ProviderConfig, ResolvedConfig } from "./types.js";
/**
 * Register a custom provider.
 */
export declare function registerProvider(provider: Provider): void;
/**
 * Get a provider by name.
 */
export declare function getProvider(name: string): Provider | undefined;
/**
 * List all registered provider names.
 */
export declare function listProviders(): string[];
/**
 * Build describe/transcribe functions from config.
 * Resolves provider, API key, model, and base URL automatically.
 */
export declare function createLlmFunctions(config: MarkitConfig, prompt?: string): MarkitOptions;
