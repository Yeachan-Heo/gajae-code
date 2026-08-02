import { afterEach, describe, expect, it } from "bun:test";
import { registerCustomApi, unregisterCustomApis } from "@gajae-code/ai";
import { streamSimple } from "@gajae-code/ai/stream";
import type { Api, AssistantMessage, Context, Model, Usage } from "@gajae-code/ai/types";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";

const SOURCE_ID = "stream-auth-forbidden-test";
const API = "stream-auth-forbidden-test" as Api;

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: API,
		provider: "test-provider",
		model: "test-model",
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function model(): Model<Api> {
	return {
		id: "test-model",
		name: "test-model",
		api: API,
		provider: "test-provider",
		baseUrl: "mock://",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1024,
		maxTokens: 1024,
	};
}

const context: Context = {
	systemPrompt: [],
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

/**
 * `forbidden` must never become an auth retry.
 *
 * Both capture exits are covered: the error-EVENT path and the THROWN-error
 * path. The thrown case deliberately uses the nested `error.transportFailure`
 * carrier, which is the shape this repository actually throws and which the
 * shared `transportFailureFacts` extractor does not dereference.
 */
describe("streamSimple — forbidden auth failures never reach onAuthError", () => {
	afterEach(() => {
		unregisterCustomApis(SOURCE_ID);
	});

	it("vetoes the EVENT exit for a 401 carrying providerCode forbidden", async () => {
		let requests = 0;
		let authCalls = 0;
		registerCustomApi(
			API,
			() => {
				requests += 1;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({
						type: "error",
						reason: "error",
						error: {
							...assistant(),
							stopReason: "error",
							errorMessage: "401 forbidden",
							errorStatus: 401,
							transportFailure: { kind: "transport", status: 401, providerCode: "forbidden" },
						},
					});
					stream.end({ ...assistant(), stopReason: "error", errorMessage: "401 forbidden", errorStatus: 401 });
				});
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: "pinned-key",
			onAuthError: async () => {
				authCalls += 1;
				return "rotated-key";
			},
		});
		for await (const _event of stream) {
			// drain
		}

		expect(authCalls).toBe(0);
		expect(requests).toBe(1);
	});

	it("vetoes the THROW exit for a nested carrier with providerCode forbidden", async () => {
		let requests = 0;
		let authCalls = 0;
		registerCustomApi(
			API,
			() => {
				requests += 1;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() =>
					stream.fail(
						// Exactly the carrier shape the repo throws elsewhere.
						Object.assign(new Error("Error: 401 forbidden"), {
							status: 401,
							transportFailure: { kind: "transport", status: 401, providerCode: "forbidden" },
						}),
					),
				);
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: "pinned-key",
			onAuthError: async () => {
				authCalls += 1;
				return "rotated-key";
			},
		});

		await expect(stream.result()).rejects.toMatchObject({ status: 401 });
		expect(authCalls).toBe(0);
		// Exactly one upstream attempt: no rotation, no replay.
		expect(requests).toBe(1);
	});

	it("still retries a plain 401 with no forbidden code (contrast case)", async () => {
		let requests = 0;
		let authCalls = 0;
		const keys: string[] = [];
		registerCustomApi(
			API,
			(_model, _context, options) => {
				requests += 1;
				keys.push((options as { apiKey?: string }).apiKey ?? "");
				const stream = new AssistantMessageEventStream();
				if (requests === 1) {
					queueMicrotask(() => stream.fail(Object.assign(new Error("401 authentication_error"), { status: 401 })));
				} else {
					queueMicrotask(() => stream.end(assistant()));
				}
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: "old-key",
			onAuthError: async () => {
				authCalls += 1;
				return "new-key";
			},
		});
		for await (const _event of stream) {
			// drain
		}

		expect(authCalls).toBe(1);
		expect(keys).toEqual(["old-key", "new-key"]);
	});

	it("vetoes a bare 403 thrown without a carrier", async () => {
		let authCalls = 0;
		registerCustomApi(
			API,
			() => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => stream.fail(Object.assign(new Error("403 forbidden"), { status: 403 })));
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: "pinned-key",
			onAuthError: async () => {
				authCalls += 1;
				return "rotated-key";
			},
		});

		await expect(stream.result()).rejects.toMatchObject({ status: 403 });
		expect(authCalls).toBe(0);
	});

	it("captures a 403 whose typed code says credential, because the code wins over status", async () => {
		// The classifier gives a typed provider code precedence over the HTTP
		// status. The capture exits must agree with it, otherwise a recoverable
		// credential failure returned as 403 is silently never retried.
		let requests = 0;
		let authCalls = 0;
		registerCustomApi(
			API,
			() => {
				requests += 1;
				const stream = new AssistantMessageEventStream();
				if (requests === 1) {
					queueMicrotask(() =>
						stream.fail(
							Object.assign(new Error("403 invalid_api_key"), {
								status: 403,
								transportFailure: { kind: "transport", status: 403, providerCode: "invalid_api_key" },
							}),
						),
					);
				} else {
					queueMicrotask(() => stream.end(assistant()));
				}
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: "old-key",
			onAuthError: async () => {
				authCalls += 1;
				return "new-key";
			},
		});
		for await (const _event of stream) {
			// drain
		}

		expect(authCalls).toBe(1);
		expect(requests).toBe(2);
	});

	it("vetoes a 401 whose typed code says forbidden, because the code wins over status", async () => {
		let requests = 0;
		let authCalls = 0;
		registerCustomApi(
			API,
			() => {
				requests += 1;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() =>
					stream.fail(
						Object.assign(new Error("401 forbidden"), {
							status: 401,
							transportFailure: { kind: "transport", status: 401, providerCode: "forbidden" },
						}),
					),
				);
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: "pinned-key",
			onAuthError: async () => {
				authCalls += 1;
				return "rotated-key";
			},
		});

		await expect(stream.result()).rejects.toMatchObject({ status: 401 });
		expect(authCalls).toBe(0);
		expect(requests).toBe(1);
	});
});
