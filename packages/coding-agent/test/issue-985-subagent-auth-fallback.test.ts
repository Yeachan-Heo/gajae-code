import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@gajae-code/ai";
import { kNoAuth } from "@gajae-code/coding-agent/config/model-registry";
import {
	type ModelLookupRegistry,
	resolveModelOverrideWithAuthFallback,
} from "@gajae-code/coding-agent/config/model-resolver";

/**
 * Regression test for #985.
 *
 * Reporter screenshot showed parent session on DeepSeek V4 Pro dispatching a
 * task subagent that resolved to `qwen3.6-plus-free` — an opencode-zen model
 * the user has no working credentials for. The dispatch hit a provider that
 * could not serve the model and surfaced a confusing API rejection instead of
 * silently using the parent's already-authenticated model.
 *
 * The fix: at dispatch time, if the resolved subagent model has no working
 * credentials, fall back to the parent session's active model (which by
 * definition has working auth — the parent turn is using it).
 */

const parentModel: Model<Api> = {
	id: "deepseek-v4-pro",
	name: "DeepSeek V4 Pro",
	api: "openai-completions",
	provider: "deepseek",
	baseUrl: "https://api.deepseek.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};

const unauthedTaskModel: Model<Api> = {
	id: "qwen3.6-plus-free",
	name: "Qwen3.6 Plus Free",
	api: "openai-completions",
	provider: "opencode-zen",
	baseUrl: "https://opencode.ai/zen/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};

const sharedModel: Model<Api> = {
	id: "shared-id",
	name: "Shared",
	api: "openai-completions",
	provider: "deepseek",
	baseUrl: "https://api.deepseek.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};

interface MockRegistryOptions {
	models: Model<Api>[];
	authedProviders: Set<string>;
}

function createMockRegistry(options: MockRegistryOptions): ModelLookupRegistry & {
	getApiKey(model: Model<Api>): Promise<string | undefined>;
} {
	return {
		getAvailable: () => options.models,
		getApiKey: async (model: Model<Api>) =>
			options.authedProviders.has(model.provider) ? "sk-test-token" : undefined,
	} as unknown as ModelLookupRegistry & { getApiKey(model: Model<Api>): Promise<string | undefined> };
}

describe("issue #985: subagent dispatch auth fallback", () => {
	test("falls back to parent active model when resolved subagent model has no auth", async () => {
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel],
			authedProviders: new Set(["deepseek"]), // user has DeepSeek; opencode-zen unauthed
		});

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		expect(result.authFallbackUsed).toBe(true);
		expect(result.model?.provider).toBe("deepseek");
		expect(result.model?.id).toBe("deepseek-v4-pro");
		expect(result.requestedModel?.provider).toBe("opencode-zen");
		expect(result.requestedModel?.id).toBe("qwen3.6-plus-free");
		expect(result.fallbackReason).toBe("auth_unavailable");
	});

	test("does not fall back when resolved subagent model has working auth", async () => {
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel],
			authedProviders: new Set(["deepseek", "opencode-zen"]),
		});

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.provider).toBe("opencode-zen");
		expect(result.model?.id).toBe("qwen3.6-plus-free");
		expect(result.requestedModel?.provider).toBe("opencode-zen");
		expect(result.requestedModel?.id).toBe("qwen3.6-plus-free");
		expect(result.fallbackReason).toBeUndefined();
	});

	test("returns primary unchanged when parent active model also has no auth", async () => {
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel],
			authedProviders: new Set(), // nothing authed
		});

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.provider).toBe("opencode-zen");
		expect(result.model?.id).toBe("qwen3.6-plus-free");
	});

	test("returns primary unchanged when no parent active model is provided", async () => {
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel],
			authedProviders: new Set(["deepseek"]),
		});

		const result = await resolveModelOverrideWithAuthFallback(["qwen3.6-plus-free"], undefined, registry);

		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.provider).toBe("opencode-zen");
	});

	test("does not fall back when subagent and parent resolve to the same model", async () => {
		const registry = createMockRegistry({
			models: [sharedModel],
			authedProviders: new Set(), // even with no auth, identical model means no benefit
		});

		const result = await resolveModelOverrideWithAuthFallback(["deepseek/shared-id"], "deepseek/shared-id", registry);

		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.id).toBe("shared-id");
	});

	test("treats keyless providers (kNoAuth marker) as authenticated", async () => {
		// Keyless-by-design providers (Ollama, llama.cpp, lm-studio) advertise the
		// kNoAuth sentinel from getApiKey to signal that they do not require
		// credentials. The helper treats this as authenticated so an explicitly
		// configured local model is never silently rerouted to the parent's
		// remote provider (see #1008).
		const registry: ModelLookupRegistry & { getApiKey(model: Model<Api>): Promise<string | undefined> } = {
			getAvailable: () => [parentModel, unauthedTaskModel],
			getApiKey: async (model: Model<Api>) => {
				if (model.provider === "deepseek") return "sk-test";
				if (model.provider === "opencode-zen") return kNoAuth;
				return undefined;
			},
		} as never;

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.provider).toBe("opencode-zen");
		expect(result.model?.id).toBe("qwen3.6-plus-free");
	});

	test("passes parent session id when checking role override auth", async () => {
		const sessionIds: Array<string | undefined> = [];
		const registry: ModelLookupRegistry & {
			getApiKey(model: Model<Api>, sessionId?: string): Promise<string | undefined>;
		} = {
			getAvailable: () => [parentModel, unauthedTaskModel],
			getApiKey: async (_model: Model<Api>, sessionId?: string) => {
				sessionIds.push(sessionId);
				return sessionId === "parent-session" ? "sk-session-token" : undefined;
			},
		};

		const result = await resolveModelOverrideWithAuthFallback(
			["opencode-zen/qwen3.6-plus-free"],
			"deepseek/deepseek-v4-pro",
			registry,
			undefined,
			"parent-session",
		);

		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.provider).toBe("opencode-zen");
		expect(sessionIds).toEqual(["parent-session"]);
	});
});
