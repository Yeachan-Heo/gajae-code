import { describe, expect, it } from "bun:test";
import {
	clearAnthropicFastModeFallback,
	isAnthropicFastModeUnsupportedError,
	streamAnthropic,
} from "@gajae-code/ai/providers/anthropic";
import type { Context, Model, ProviderSessionState, ServiceTier } from "@gajae-code/ai/types";
import { hookFetch } from "@gajae-code/utils";

function makeAnthropicModel(id: string): Model<"anthropic-messages"> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	};
}

const CONTEXT: Context = {
	systemPrompt: ["Stay concise."],
	messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
};

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

type CaptureOptions = {
	serviceTier?: ServiceTier;
	providerSessionState?: Map<string, ProviderSessionState>;
};

function capturePayload(model: Model<"anthropic-messages">, opts: CaptureOptions): Promise<unknown> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamAnthropic(model, CONTEXT, {
		apiKey: "sk-ant-oat-test",
		isOAuth: true,
		signal: abortedSignal(),
		serviceTier: opts.serviceTier,
		providerSessionState: opts.providerSessionState,
		onPayload: payload => resolve(payload),
	});
	return promise;
}

async function capturePayloadAndHeaders(
	model: Model<"anthropic-messages">,
	opts: CaptureOptions,
): Promise<{ payload: unknown; headers: Headers | undefined }> {
	let payload: unknown;
	let headers: Headers | undefined;
	using _hook = hookFetch(async (_input, init) => {
		headers = new Headers(init?.headers);
		const events = [
			{
				type: "message_start",
				message: {
					id: "msg_fast_mode_test",
					type: "message",
					role: "assistant",
					model: model.id,
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 1, output_tokens: 0 },
				},
			},
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
			{ type: "content_block_stop", index: 0 },
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 1 },
			},
			{ type: "message_stop" },
		];
		const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	});
	await streamAnthropic(model, CONTEXT, {
		apiKey: "sk-ant-oat-test",
		isOAuth: true,
		serviceTier: opts.serviceTier,
		providerSessionState: opts.providerSessionState,
		onPayload: requestPayload => {
			payload = requestPayload;
		},
	}).result();
	return { payload, headers };
}

describe("Anthropic priority service tier → speed='fast'", () => {
	it("sets speed='fast' for Claude Opus 4.7 when serviceTier='priority'", async () => {
		const payload = (await capturePayload(makeAnthropicModel("claude-opus-4-7"), {
			serviceTier: "priority",
		})) as { speed?: string };
		expect(payload.speed).toBe("fast");
	});

	it("sets speed='fast' for Claude Opus 4.6 when serviceTier='priority'", async () => {
		const payload = (await capturePayload(makeAnthropicModel("claude-opus-4-6"), {
			serviceTier: "priority",
		})) as { speed?: string };
		expect(payload.speed).toBe("fast");
	});

	it("omits fast mode for Haiku 5.5 before provider retries are needed", async () => {
		for (const serviceTier of ["priority", "claude-only"] as const) {
			const { payload, headers } = await capturePayloadAndHeaders(makeAnthropicModel("claude-haiku-5-5"), {
				serviceTier,
			});
			expect((payload as { speed?: string }).speed).toBeUndefined();
			expect(headers?.get("anthropic-beta") ?? "").not.toContain("fast-mode-2026-02-01");
		}
	});

	it("keeps server-side fast-mode fallback for unclassified models", async () => {
		// Unknown model ids remain server-validated so future models do not need an
		// SDK release merely to attempt fast mode.
		const payload = (await capturePayload(makeAnthropicModel("claude-opus-4-5"), {
			serviceTier: "priority",
		})) as { speed?: string };
		expect(payload.speed).toBe("fast");
	});

	it("omits speed when serviceTier is unset", async () => {
		const payload = (await capturePayload(makeAnthropicModel("claude-opus-4-7"), {
			serviceTier: undefined,
		})) as Record<string, unknown>;
		expect(payload.speed).toBeUndefined();
	});

	it("omits speed for non-priority tiers (`flex`, `scale`, `auto`, `default`)", async () => {
		for (const tier of ["flex", "scale", "auto", "default"] as const) {
			const payload = (await capturePayload(makeAnthropicModel("claude-opus-4-7"), {
				serviceTier: tier,
			})) as Record<string, unknown>;
			expect(payload.speed).toBeUndefined();
		}
	});

	it("sets speed='fast' on direct anthropic when serviceTier='claude-only'", async () => {
		const payload = (await capturePayload(makeAnthropicModel("claude-opus-4-7"), {
			serviceTier: "claude-only",
		})) as { speed?: string };
		expect(payload.speed).toBe("fast");
	});

	it("omits speed when serviceTier='openai-only' on an anthropic model", async () => {
		// Scoped to OpenAI — on this anthropic request, the scope doesn't match,
		// so `speed` must not be set on the wire.
		const payload = (await capturePayload(makeAnthropicModel("claude-opus-4-7"), {
			serviceTier: "openai-only",
		})) as Record<string, unknown>;
		expect(payload.speed).toBeUndefined();
	});
});

describe("clearAnthropicFastModeFallback", () => {
	it("is a no-op when no provider session state map is passed", () => {
		expect(() => clearAnthropicFastModeFallback(undefined)).not.toThrow();
	});

	it("is a no-op when the anthropic state entry hasn't been materialized", () => {
		const map = new Map<string, ProviderSessionState>();
		clearAnthropicFastModeFallback(map);
		expect(map.size).toBe(0);
	});

	it("flips fastModeDisabled back to false without touching unrelated flags", () => {
		const map = new Map<string, ProviderSessionState>();
		const state = {
			strictToolsDisabled: true,
			fastModeDisabled: true,
			close: () => {},
		} as ProviderSessionState & { strictToolsDisabled: boolean; fastModeDisabled: boolean };
		map.set("anthropic-messages", state);

		clearAnthropicFastModeFallback(map);

		expect(state.fastModeDisabled).toBe(false);
		// Strict-tools learning survives — only the fast-mode flag is reset.
		expect(state.strictToolsDisabled).toBe(true);
	});
});

describe("isAnthropicFastModeUnsupportedError", () => {
	function makeStatusError(status: number, message: string): Error {
		const err = new Error(message) as Error & { status: number };
		err.status = status;
		return err;
	}

	it("detects 400 invalid_request_error when the model rejects `speed`", () => {
		const err = makeStatusError(
			400,
			'400 {"type":"error","error":{"type":"invalid_request_error","message":"\'claude-opus-4-5-20251101\' does not support the `speed` parameter."}}',
		);
		expect(isAnthropicFastModeUnsupportedError(err)).toBe(true);
	});

	it("detects 429 rate_limit_error when fast mode requires extra usage", () => {
		// Regression: prior to this fix, 429 with rate_limit_error fell through to
		// the generic retry path and looped forever instead of dropping `speed: fast`.
		const err = makeStatusError(
			429,
			'429 {"type":"error","error":{"type":"rate_limit_error","message":"Extra usage is required for fast mode."}}',
		);
		expect(isAnthropicFastModeUnsupportedError(err)).toBe(true);
	});

	it("ignores unrelated 429 rate limits", () => {
		const err = makeStatusError(
			429,
			'429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your account\'s rate limit."}}',
		);
		expect(isAnthropicFastModeUnsupportedError(err)).toBe(false);
	});

	it("ignores unrelated 400 invalid_request errors", () => {
		const err = makeStatusError(
			400,
			'400 {"type":"error","error":{"type":"invalid_request_error","message":"messages: at least one message is required"}}',
		);
		expect(isAnthropicFastModeUnsupportedError(err)).toBe(false);
	});
});
