import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Api, Context, Model, SimpleStreamOptions } from "@gajae-code/ai";
import * as openaiResponses from "@gajae-code/ai/providers/openai-responses";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { streamGrokCli } from "../src/defaults/gjc/extensions/grok-cli-vendor/src/provider/stream";
import { resetVersionCache } from "../src/defaults/gjc/extensions/grok-cli-vendor/src/provider/version-manager";

describe("Grok Build stream wrapper", () => {
	beforeEach(() => {
		resetVersionCache();
	});

	it("forwards requests through OpenAI responses with Grok Build headers", () => {
		const captured: { model?: Model<Api>; options?: unknown } = {};
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					tag_name: "v1.0.13",
				}),
				{ status: 200 },
			),
		);
		const spy = spyOn(openaiResponses, "streamOpenAIResponses").mockImplementation((model, _context, options) => {
			captured.model = model as Model<Api>;
			captured.options = options as unknown;
			return new AssistantMessageEventStream();
		});
		try {
			const model = {
				provider: "grok-build",
				id: "grok-composer-2.5-fast",
				api: "grok-cli-responses",
			} as Model<Api>;
			const context = { messages: [], systemPrompt: [] } as unknown as Context;

			const stream = streamGrokCli(model, context, {
				sessionId: "session-123",
				headers: { "x-test": "ok" },
			} as SimpleStreamOptions);

			expect(stream).toBeInstanceOf(AssistantMessageEventStream);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(captured.model?.provider).toBe("grok-build");
			expect(captured.model?.id).toBe("grok-composer-2.5-fast");
			expect(captured.model?.api).toBe("openai-responses");
			expect((captured.options as { headers?: Record<string, string> } | undefined)?.headers).toMatchObject({
				"x-test": "ok",
				"x-grok-client-identifier": "gjc-grok-cli",
				"x-grok-conv-id": "session-123",
				"x-grok-model-override": "grok-composer-2.5-fast",
				"x-xai-token-auth": "xai-grok-cli",
			});
		} finally {
			fetchSpy.mockRestore();
			spy.mockRestore();
		}
	});

	it("uses version manager for x-grok-client-version header instead of hardcoded 0.2.33", () => {
		const captured: { model?: Model<Api>; options?: unknown } = {};
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					tag_name: "v1.0.13",
				}),
				{ status: 200 },
			),
		);
		const spy = spyOn(openaiResponses, "streamOpenAIResponses").mockImplementation((model, _context, options) => {
			captured.model = model as Model<Api>;
			captured.options = options as unknown;
			return new AssistantMessageEventStream();
		});
		try {
			const model = {
				provider: "grok-build",
				id: "grok-composer-2.5-fast",
				api: "grok-cli-responses",
			} as Model<Api>;
			const context = { messages: [], systemPrompt: [] } as unknown as Context;

			streamGrokCli(model, context, {
				sessionId: "session-123",
			} as SimpleStreamOptions);

			const headers = (captured.options as { headers?: Record<string, string> } | undefined)?.headers;
			expect(headers).toBeDefined();

			// The version should NOT be the old hardcoded 0.2.33
			const version = headers?.["x-grok-client-version"];
			expect(version).toBeDefined();
			expect(version).not.toBe("0.2.33");

			// Should be at least 1.0.13 (fallback or fetched)
			expect(version).toBe("1.0.13");
		} finally {
			fetchSpy.mockRestore();
			spy.mockRestore();
		}
	});

	it("includes sessionId in x-grok-conv-id header when provided", () => {
		const captured: { options?: unknown } = {};
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					tag_name: "v1.0.13",
				}),
				{ status: 200 },
			),
		);
		const spy = spyOn(openaiResponses, "streamOpenAIResponses").mockImplementation((_model, _context, options) => {
			captured.options = options as unknown;
			return new AssistantMessageEventStream();
		});
		try {
			const model = {
				provider: "grok-build",
				id: "grok-composer-2.5-fast",
				api: "grok-cli-responses",
			} as Model<Api>;
			const context = { messages: [], systemPrompt: [] } as unknown as Context;

			streamGrokCli(model, context, {
				sessionId: "custom-session-id",
			} as SimpleStreamOptions);

			const headers = (captured.options as { headers?: Record<string, string> } | undefined)?.headers;
			expect(headers?.["x-grok-conv-id"]).toBe("custom-session-id");
		} finally {
			fetchSpy.mockRestore();
			spy.mockRestore();
		}
	});

	it("omits x-grok-conv-id header when sessionId is not provided", () => {
		const captured: { options?: unknown } = {};
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					tag_name: "v1.0.13",
				}),
				{ status: 200 },
			),
		);
		const spy = spyOn(openaiResponses, "streamOpenAIResponses").mockImplementation((_model, _context, options) => {
			captured.options = options as unknown;
			return new AssistantMessageEventStream();
		});
		try {
			const model = {
				provider: "grok-build",
				id: "grok-composer-2.5-fast",
				api: "grok-cli-responses",
			} as Model<Api>;
			const context = { messages: [], systemPrompt: [] } as unknown as Context;

			streamGrokCli(model, context, {} as SimpleStreamOptions);

			const headers = (captured.options as { headers?: Record<string, string> } | undefined)?.headers;
			expect(headers?.["x-grok-conv-id"]).toBeUndefined();
		} finally {
			fetchSpy.mockRestore();
			spy.mockRestore();
		}
	});
});
