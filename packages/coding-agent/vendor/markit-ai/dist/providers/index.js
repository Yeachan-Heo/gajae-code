import { anthropic } from "./anthropic.js";
import { openai } from "./openai.js";
const providers = {
    openai,
    anthropic,
};
/**
 * Register a custom provider.
 */
export function registerProvider(provider) {
    providers[provider.name] = provider;
}
/**
 * Get a provider by name.
 */
export function getProvider(name) {
    return providers[name];
}
/**
 * List all registered provider names.
 */
export function listProviders() {
    return Object.keys(providers);
}
/**
 * Resolve config + env vars into a ResolvedConfig for a provider.
 */
function resolve(provider, config) {
    // API key: env vars (in provider priority order) > config file
    const apiKey = provider.envKeys.reduce((found, key) => found || process.env[key], undefined) || config.llm?.apiKey;
    if (!apiKey)
        return null;
    return {
        apiKey,
        apiBase: (config.llm?.apiBase || provider.defaultBase).replace(/\/+$/, ""),
        model: process.env.MARKIT_MODEL || config.llm?.model || provider.defaultModel,
        transcriptionModel: config.llm?.transcriptionModel || provider.defaultTranscriptionModel,
    };
}
const BASE_PROMPT = "Describe this image in detail.";
/**
 * Build describe/transcribe functions from config.
 * Resolves provider, API key, model, and base URL automatically.
 */
export function createLlmFunctions(config, prompt) {
    const providerName = config.llm?.provider || "openai";
    const provider = providers[providerName];
    if (!provider) {
        throw new Error(`Unknown provider '${providerName}'. Available: ${Object.keys(providers).join(", ")}`);
    }
    const resolved = resolve(provider, config);
    if (!resolved)
        return {};
    const fullPrompt = prompt ? `${BASE_PROMPT}\n\n${prompt}` : BASE_PROMPT;
    return provider.create(resolved, fullPrompt);
}
