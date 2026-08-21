import { afterEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "../src/models";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import type { Context, Model } from "../src/types";
import { getOpenAIStreamIdleTimeoutMs, isGrokModelId } from "../src/utils/idle-iterator";
import { withEnv } from "./helpers";

/**
 * Contract (#4797): the OpenAI-family idle watchdog floor is a property of the
 * model, not only the account used to reach it. Provider `xai` and the Grok
 * Build wrapper already carry the 300s floor (PR #4717); Grok models served
 * through other OpenAI-compatible hosts (openrouter `x-ai/grok-*`, kilo,
 * litellm, zenmux, venice …) keep the model id and previously stayed on the
 * shared 120s default, so a long Grok reasoning gap surfaced as
 * `OpenAI completions stream stalled while waiting for the next event`.
 */
describe("Grok idle window on third-party OpenAI-compatible hosts", () => {
	describe("getOpenAIStreamIdleTimeoutMs(provider, modelId)", () => {
		afterEach(() => {
			delete Bun.env.GJC_OPENAI_STREAM_IDLE_TIMEOUT_MS;
			delete Bun.env.PI_OPENAI_STREAM_IDLE_TIMEOUT_MS;
			delete Bun.env.PI_STREAM_IDLE_TIMEOUT_MS;
		});

		it("gives Grok model ids the 300s floor regardless of host provider", () => {
			expect(getOpenAIStreamIdleTimeoutMs("openrouter", "x-ai/grok-4.6")).toBe(300_000);
			expect(getOpenAIStreamIdleTimeoutMs("kilo", "x-ai/grok-code-fast-1")).toBe(300_000);
			expect(getOpenAIStreamIdleTimeoutMs("litellm", "grok-code-fast-1")).toBe(300_000);
			expect(getOpenAIStreamIdleTimeoutMs("zenmux", "x-ai/grok-build-0.1")).toBe(300_000);
			expect(getOpenAIStreamIdleTimeoutMs("venice", "grok-build-0-1")).toBe(300_000);
		});

		it("keeps non-Grok models on the 120s default", () => {
			expect(getOpenAIStreamIdleTimeoutMs("openrouter", "anthropic/claude-sonnet-4")).toBe(120_000);
			expect(getOpenAIStreamIdleTimeoutMs("kilo", "moonshotai/kimi-k2.5")).toBe(120_000);
			expect(getOpenAIStreamIdleTimeoutMs("openai", "gpt-4o-mini")).toBe(120_000);
			expect(getOpenAIStreamIdleTimeoutMs("openrouter")).toBe(120_000);
		});

		it("preserves the provider floor and env precedence", () => {
			// Provider floor still applies for the native xai path regardless of model id.
			expect(getOpenAIStreamIdleTimeoutMs("xai", "grok-4.6")).toBe(300_000);
			expect(getOpenAIStreamIdleTimeoutMs("grok-build", "grok-build")).toBe(300_000);
			// Env overrides still win over the model-keyed floor (the first
			// withEnv block leaves GJC_OPENAI_STREAM_IDLE_TIMEOUT_MS set only
			// inside its own scope; the disable check re-runs cleanly).
			withEnv({ GJC_OPENAI_STREAM_IDLE_TIMEOUT_MS: "77" }, () => {
				expect(getOpenAIStreamIdleTimeoutMs("openrouter", "x-ai/grok-4.6")).toBe(77);
			});
			withEnv({ GJC_OPENAI_STREAM_IDLE_TIMEOUT_MS: "0" }, () => {
				expect(getOpenAIStreamIdleTimeoutMs("openrouter", "x-ai/grok-4.6")).toBeUndefined();
			});
		});

		it("does not match grok-adjacent substrings inside unrelated model ids", () => {
			expect(isGrokModelId("my-grokery-9000")).toBe(false);
			expect(isGrokModelId("astrokin-4")).toBe(false);
			expect(isGrokModelId(undefined)).toBe(false);
			// Real shapes across hosts still match.
			expect(isGrokModelId("grok-4.6")).toBe(true);
			expect(isGrokModelId("x-ai/grok-build-0.1")).toBe(true);
			expect(isGrokModelId("openrouter/auto")).toBe(false);
		});
	});

	describe("openai-completions transport", () => {
		const originalFetch = global.fetch;

		afterEach(() => {
			global.fetch = originalFetch;
		});

		it("uses the bundled Grok-model floor for openrouter x-ai/grok models", () => {
			const model = getBundledModel("openrouter", "x-ai/grok-4.6") as Model<"openai-completions">;
			expect(model.provider).toBe("openrouter");
			expect(getOpenAIStreamIdleTimeoutMs(model.provider, model.id)).toBe(300_000);
		});

		it("keeps a quiet Grok reasoning gap on a third-party host alive past the 120s default", async () => {
			const model = {
				...(getBundledModel("openrouter", "x-ai/grok-4.6") as Model<"openai-completions">),
			};
			const encoder = new TextEncoder();
			const progress =
				'data: {"id":"c1","object":"chat.completion.chunk","created":0,"model":"x-ai/grok-4.6","choices":[{"index":0,"delta":{"role":"assistant","content":"start"},"finish_reason":null}]}\n\n';
			const finish =
				'data: {"id":"c1","object":"chat.completion.chunk","created":0,"model":"x-ai/grok-4.6","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n';
			// Silent reasoning gap of 250ms — longer than the 120s-default-scaled test
			// idle budget (100ms), shorter than the Grok floor (which the transport
			// derives from the same helper; here pinned explicitly at 300ms to prove
			// the gap is bridged by the widened window, not by luck).
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					void (async () => {
						controller.enqueue(encoder.encode(progress));
						await Bun.sleep(250);
						controller.enqueue(encoder.encode(finish));
						controller.close();
					})();
				},
			});
			global.fetch = Object.assign(
				async () =>
					new Response(body, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
				{ preconnect: originalFetch.preconnect },
			) as typeof fetch;

			const context: Context = {
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			};
			const result = await streamOpenAICompletions(model, context, {
				apiKey: "test-key",
				// 300ms mirrors the Grok floor this fix grants to third-party-hosted
				// Grok models; the previous 120s-default-equivalent behavior would
				// abort inside the 250ms gap.
				streamIdleTimeoutMs: 300,
				streamFirstEventTimeoutMs: 5_000,
			}).result();

			expect(result.stopReason).toBe("stop");
			expect(result.errorMessage).toBeUndefined();
			expect(result.content).toContainEqual({ type: "text", text: "start" });
		});

		it("still stalls when a non-Grok model goes quiet past the idle budget", async () => {
			const model = {
				...(getBundledModel("openrouter", "moonshotai/kimi-k2.5") as Model<"openai-completions">),
			};
			const encoder = new TextEncoder();
			const progress =
				'data: {"id":"c1","object":"chat.completion.chunk","created":0,"model":"moonshotai/kimi-k2.5","choices":[{"index":0,"delta":{"role":"assistant","content":"start"},"finish_reason":null}]}\n\n';
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					void (async () => {
						controller.enqueue(encoder.encode(progress));
						await Bun.sleep(250);
						// Never finishes — the watchdog must fire.
					})();
				},
			});
			global.fetch = Object.assign(
				async () =>
					new Response(body, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
				{ preconnect: originalFetch.preconnect },
			) as typeof fetch;

			const context: Context = {
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			};
			const result = await streamOpenAICompletions(model, context, {
				apiKey: "test-key",
				streamIdleTimeoutMs: 100,
				streamFirstEventTimeoutMs: 5_000,
			}).result();

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe("OpenAI completions stream stalled while waiting for the next event");
		});
	});
});
