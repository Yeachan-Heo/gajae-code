import { afterEach, describe, expect, it, vi } from "bun:test";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages";
import { streamAnthropic } from "@gajae-code/ai/providers/anthropic";
import type { CacheRetention, Context, Model, ProviderSessionState } from "@gajae-code/ai/types";
import { logger } from "@gajae-code/utils";

// Issue #5944: Anthropic-compatible proxies silently received the ~5m default TTL
// when `long` retention was requested but `compat.supportsLongCacheRetention`
// was unset. The downgrade must be visible exactly once per provider session.

const proxyModel: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "corp-anthropic",
	baseUrl: "https://proxy.example.test/anthropic",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

type Payload = MessageCreateParamsStreaming & { cache_control?: { type: string; ttl?: string } };

const context: Context = {
	systemPrompt: ["Stable instructions"],
	messages: [{ role: "user", content: "Continue", timestamp: 1 }],
};

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function capturePayload(
	model: Model<"anthropic-messages">,
	options: { cacheRetention?: CacheRetention; providerSessionState?: Map<string, ProviderSessionState> } = {},
): Promise<Payload> {
	const { promise, resolve } = Promise.withResolvers<Payload>();
	streamAnthropic(model, context, {
		apiKey: "sk-ant-api-test",
		isOAuth: false,
		signal: abortedSignal(),
		...options,
		onPayload: payload => {
			resolve(payload as Payload);
			return undefined;
		},
	});
	return promise;
}

function lastUserCacheControl(payload: Payload): { type: string; ttl?: string } | undefined {
	const content = payload.messages.at(-1)?.content;
	if (!Array.isArray(content)) return undefined;
	return (content.at(-1) as { cache_control?: { type: string; ttl?: string } } | undefined)?.cache_control;
}

function downgradeWarnings(calls: unknown[][]): unknown[][] {
	return calls.filter(call => typeof call[0] === "string" && call[0].includes("compat.supportsLongCacheRetention"));
}

describe("anthropic long cache-retention downgrade warning (#5944)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("warns once per provider session when a compatible proxy downgrades long retention", async () => {
		const warn = vi.spyOn(logger, "warn");
		const providerSessionState = new Map<string, ProviderSessionState>();

		const first = await capturePayload(proxyModel, { providerSessionState });
		await capturePayload(proxyModel, { providerSessionState });

		expect(lastUserCacheControl(first)).toEqual({ type: "ephemeral" });
		const warnings = downgradeWarnings(warn.mock.calls);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.[1]).toEqual({ provider: "corp-anthropic", model: "claude-sonnet-4-5" });

		// A fresh provider session (new conversation) surfaces the downgrade again.
		await capturePayload(proxyModel, { providerSessionState: new Map() });
		expect(downgradeWarnings(warn.mock.calls)).toHaveLength(2);
	});

	it("warns separately for each compatible provider/model sharing one provider session", async () => {
		const warn = vi.spyOn(logger, "warn");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const otherProvider = { ...proxyModel, provider: "other-anthropic", baseUrl: "https://other.example.test" };
		const otherModel = { ...proxyModel, id: "claude-opus-4-1" };

		await capturePayload(proxyModel, { providerSessionState });
		await capturePayload(otherProvider, { providerSessionState });
		await capturePayload(otherModel, { providerSessionState });
		await capturePayload(otherProvider, { providerSessionState });

		expect(downgradeWarnings(warn.mock.calls).map(call => call[1])).toEqual([
			{ provider: "corp-anthropic", model: "claude-sonnet-4-5" },
			{ provider: "other-anthropic", model: "claude-sonnet-4-5" },
			{ provider: "corp-anthropic", model: "claude-opus-4-1" },
		]);
	});

	it("stays silent when support is declared, retention is short, or no marker is generated", async () => {
		const warn = vi.spyOn(logger, "warn");

		const optedIn = await capturePayload({ ...proxyModel, compat: { supportsLongCacheRetention: true } });
		expect(lastUserCacheControl(optedIn)).toEqual({ type: "ephemeral", ttl: "1h" });

		const optedOut = await capturePayload({ ...proxyModel, compat: { supportsLongCacheRetention: false } });
		expect(lastUserCacheControl(optedOut)).toEqual({ type: "ephemeral" });

		await capturePayload(proxyModel, { cacheRetention: "short" });
		await capturePayload(proxyModel, { cacheRetention: "none" });
		await capturePayload({ ...proxyModel, compat: { promptCacheMode: "none" } });
		// Unknown non-Claude compatible endpoints generate no cache markers at all.
		await capturePayload({ ...proxyModel, id: "custom-compatible-model" });
		// Canonical Anthropic knows its own long-retention support.
		const canonical = await capturePayload({ ...proxyModel, baseUrl: "https://api.anthropic.com" });
		expect(canonical.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

		expect(downgradeWarnings(warn.mock.calls)).toHaveLength(0);
	});
});
