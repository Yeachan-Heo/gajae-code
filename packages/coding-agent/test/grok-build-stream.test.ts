import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Api, Context, Model, SimpleStreamOptions } from "@gajae-code/ai";
import type { FetchImpl } from "@gajae-code/ai/core";
import * as openaiResponses from "@gajae-code/ai/providers/openai-responses";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { streamGrokCli } from "../src/defaults/gjc/extensions/grok-cli-vendor/src/provider/stream";
import {
	getGrokCliVersion,
	resetVersionCache,
} from "../src/defaults/gjc/extensions/grok-cli-vendor/src/provider/version-manager";

describe("Grok Build stream wrapper", () => {
	beforeEach(() => {
		resetVersionCache();
	});

	it("forwards requests through OpenAI responses with Grok Build headers", () => {
		const captured: { model?: Model<Api>; options?: unknown } = {};
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
			spy.mockRestore();
		}
	});

	it("uses version manager for x-grok-client-version header instead of hardcoded 0.2.33", () => {
		const captured: { model?: Model<Api>; options?: unknown } = {};
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
			spy.mockRestore();
		}
	});

	it("includes sessionId in x-grok-conv-id header when provided", () => {
		const captured: { options?: unknown } = {};
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
			spy.mockRestore();
		}
	});

	it("omits x-grok-conv-id header when sessionId is not provided", () => {
		const captured: { options?: unknown } = {};
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
			spy.mockRestore();
		}
	});

	it("retries once with the version learned from a 426 response", async () => {
		const captured: { options?: SimpleStreamOptions } = {};
		const calls: Array<{ input: Parameters<FetchImpl>[0]; init?: RequestInit }> = [];
		const baseFetch = async (input: Parameters<FetchImpl>[0], init?: RequestInit): Promise<Response> => {
			calls.push({ input, init });
			return calls.length === 1
				? new Response("Your Grok CLI version (1.0.13) is outdated. Please update to version 1.2.3 or later", {
						status: 426,
					})
				: new Response("ok", { status: 200 });
		};
		const spy = spyOn(openaiResponses, "streamOpenAIResponses").mockImplementation((_model, _context, options) => {
			captured.options = options as SimpleStreamOptions;
			return new AssistantMessageEventStream();
		});
		try {
			const model = {
				provider: "grok-build",
				id: "grok-composer-2.5-fast",
				api: "grok-cli-responses",
			} as Model<Api>;
			const context = { messages: [], systemPrompt: [] } as unknown as Context;
			streamGrokCli(model, context, { fetch: baseFetch } as SimpleStreamOptions);

			const wrappedFetch = captured.options?.fetch;
			if (!wrappedFetch) throw new Error("expected wrapped fetch");
			const headers = new Headers(captured.options?.headers);
			headers.set("content-type", "application/json");
			const response = await wrappedFetch("https://api.x.ai/v1/responses", {
				method: "POST",
				headers,
				body: "{}",
			});

			expect(response.status).toBe(200);
			expect(calls).toHaveLength(2);
			expect(new Headers(calls[0]?.init?.headers).get("x-grok-client-version")).toBe("1.0.13");
			expect(new Headers(calls[1]?.init?.headers).get("x-grok-client-version")).toBe("1.2.3");
			expect(new Headers(calls[1]?.init?.headers).get("content-type")).toBe("application/json");
			expect(calls[1]?.init?.body).toBe("{}");
		} finally {
			spy.mockRestore();
		}
	});

	it("does not retry a second 426 and keeps its body available", async () => {
		const captured: { options?: SimpleStreamOptions } = {};
		const calls: RequestInit[] = [];
		const baseFetch = async (_input: Parameters<FetchImpl>[0], init?: RequestInit): Promise<Response> => {
			if (init) calls.push(init);
			return calls.length === 1
				? new Response("Your Grok CLI version (1.0.13) is outdated. Please update to version 1.2.3 or later", {
						status: 426,
					})
				: new Response("Your Grok CLI version (1.2.3) is outdated. Please update to version 1.3.0 or later", {
						status: 426,
					});
		};
		const spy = spyOn(openaiResponses, "streamOpenAIResponses").mockImplementation((_model, _context, options) => {
			captured.options = options as SimpleStreamOptions;
			return new AssistantMessageEventStream();
		});
		try {
			const model = {
				provider: "grok-build",
				id: "grok-composer-2.5-fast",
				api: "grok-cli-responses",
			} as Model<Api>;
			const context = { messages: [], systemPrompt: [] } as unknown as Context;
			streamGrokCli(model, context, { fetch: baseFetch } as SimpleStreamOptions);

			const wrappedFetch = captured.options?.fetch;
			if (!wrappedFetch) throw new Error("expected wrapped fetch");
			const response = await wrappedFetch("https://api.x.ai/v1/responses", {
				method: "POST",
				headers: captured.options?.headers,
				body: "{}",
			});

			expect(response.status).toBe(426);
			expect(await response.text()).toContain("version 1.3.0 or later");
			expect(calls).toHaveLength(2);
			expect(getGrokCliVersion()).toBe("1.3.0");
		} finally {
			spy.mockRestore();
		}
	});

	it("forwards the original model and awaits the complete response callback contract", async () => {
		const captured: { options?: SimpleStreamOptions } = {};
		const callbackGate = Promise.withResolvers<void>();
		let received: Parameters<NonNullable<SimpleStreamOptions["onResponse"]>> | undefined;
		const onResponse: NonNullable<SimpleStreamOptions["onResponse"]> = (...args) => {
			received = args;
			return callbackGate.promise;
		};
		const spy = spyOn(openaiResponses, "streamOpenAIResponses").mockImplementation((_model, _context, options) => {
			captured.options = options as SimpleStreamOptions;
			return new AssistantMessageEventStream();
		});
		try {
			const model = {
				provider: "grok-build",
				id: "grok-composer-2.5-fast",
				api: "grok-cli-responses",
			} as Model<Api>;
			const context = { messages: [], systemPrompt: [] } as unknown as Context;
			streamGrokCli(model, context, { onResponse } as SimpleStreamOptions);

			const callback = captured.options?.onResponse;
			if (!callback) throw new Error("expected wrapped response callback");
			const metadata = { status: 200, headers: {} } as Parameters<NonNullable<SimpleStreamOptions["onResponse"]>>[0];
			const responseModel = { ...model, api: "openai-responses" } as Model<Api>;
			const scope: NonNullable<SimpleStreamOptions["attemptScope"]> = {
				attemptId: "attempt-1",
				generation: 1,
				lineage: "root",
			};
			const signal = new AbortController().signal;
			let callbackSettled = false;
			const callbackPromise = Promise.resolve(callback(metadata, responseModel, scope, signal)).then(() => {
				callbackSettled = true;
			});

			expect(received).toEqual([metadata, model, scope, signal]);
			expect(received?.[1]).toBe(model);
			expect(received?.[2]).toBe(scope);
			expect(received?.[3]).toBe(signal);
			expect(callbackSettled).toBe(false);
			callbackGate.resolve();
			await callbackPromise;
			expect(callbackSettled).toBe(true);
		} finally {
			spy.mockRestore();
		}
	});
});
