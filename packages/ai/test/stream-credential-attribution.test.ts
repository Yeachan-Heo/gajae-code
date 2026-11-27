import { afterEach, describe, expect, it } from "bun:test";
import { registerCustomApi, unregisterCustomApis } from "@gajae-code/ai";
import { streamSimple } from "@gajae-code/ai/stream";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	SimpleStreamOptions,
} from "@gajae-code/ai/types";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";

const SOURCE_ID = "stream-credential-attribution-test";
const API = "stream-credential-attribution-test" as Api;

function assistant(content: string[] = []): AssistantMessage {
	return {
		role: "assistant",
		content: content.map(text => ({ type: "text" as const, text })),
		api: API,
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
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
		...overrides,
	};
}

const context: Context = {
	systemPrompt: [],
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

/** Emits start, one text delta, then `done` or a provider `error` event. */
function textStream(outcome: "done" | "error" | "auth-error"): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message = assistant(outcome === "done" ? ["ok"] : []);
		stream.push({ type: "start", partial: message });
		if (outcome === "done") {
			stream.push({ type: "text_start", contentIndex: 0, partial: message });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
			stream.push({ type: "done", reason: "stop", message });
			return;
		}
		message.stopReason = "error";
		message.errorMessage = outcome === "auth-error" ? "401 authentication_error" : "429 rate limited";
		message.errorStatus = outcome === "auth-error" ? 401 : 429;
		stream.push({ type: "error", reason: "error", error: message });
	});
	return stream;
}

function eventMessage(event: AssistantMessageEvent): AssistantMessage | undefined {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	return "partial" in event ? event.partial : undefined;
}

async function collect(stream: AssistantMessageEventStream): Promise<{
	events: AssistantMessageEvent[];
	snapshots: Array<number | undefined>;
	result: AssistantMessage;
}> {
	const events: AssistantMessageEvent[] = [];
	const snapshots: Array<number | undefined> = [];
	for await (const event of stream) {
		events.push(event);
		// Snapshot at delivery time: a later stamp on a shared object must not
		// make an early event look attributed.
		snapshots.push(eventMessage(event)?.credentialId);
	}
	return { events, snapshots, result: await stream.result() };
}

describe("streamSimple credential attribution", () => {
	afterEach(() => {
		unregisterCustomApis(SOURCE_ID);
	});

	it("records the stored credential row on every partial, the done message, and the result", async () => {
		registerCustomApi(API, () => textStream("done"), SOURCE_ID);

		const { events, snapshots, result } = await collect(
			streamSimple(model(), context, { apiKey: "stored-key", credentialId: 41 }),
		);

		expect(events.map(event => event.type)).toEqual(["start", "text_start", "text_delta", "done"]);
		expect(snapshots).toEqual([41, 41, 41, 41]);
		expect(result.credentialId).toBe(41);
		expect(JSON.parse(JSON.stringify(result)).credentialId).toBe(41);
	});

	it("records the credential row on a provider error response", async () => {
		registerCustomApi(API, () => textStream("error"), SOURCE_ID);

		const { events, snapshots, result } = await collect(
			streamSimple(model(), context, { apiKey: "stored-key", credentialId: 5 }),
		);

		expect(events.at(-1)?.type).toBe("error");
		expect(snapshots).toEqual([5, 5]);
		expect(result.stopReason).toBe("error");
		expect(result.credentialId).toBe(5);
	});

	it("leaves the field absent for an external key", async () => {
		registerCustomApi(API, () => textStream("done"), SOURCE_ID);

		const { snapshots, result } = await collect(streamSimple(model(), context, { apiKey: "external-key" }));

		expect(snapshots.every(id => id === undefined)).toBe(true);
		expect("credentialId" in result).toBe(false);
		expect(JSON.stringify(result)).not.toContain("credentialId");
	});

	it("ignores a credential row that does not describe an explicitly sent key", async () => {
		registerCustomApi(API, () => textStream("done"), SOURCE_ID);

		const { snapshots, result } = await collect(streamSimple(model(), context, { credentialId: 9 }));

		expect(snapshots.every(id => id === undefined)).toBe(true);
		expect("credentialId" in result).toBe(false);
	});

	it("attributes an auth-retry success to the replacement credential row", async () => {
		const attempts: Array<{ apiKey?: string; credentialId?: number }> = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				attempts.push({ apiKey: options?.apiKey, credentialId: options?.credentialId });
				return textStream(options?.apiKey === "first-key" ? "auth-error" : "done");
			},
			SOURCE_ID,
		);

		const { events, snapshots, result } = await collect(
			streamSimple(model(), context, {
				apiKey: "first-key",
				credentialId: 1,
				onAuthError: async () => ({ apiKey: "second-key", credentialId: 2 }),
			}),
		);

		expect(attempts).toEqual([
			{ apiKey: "first-key", credentialId: 1 },
			{ apiKey: "second-key", credentialId: 2 },
		]);
		// The buffered start of the failed attempt is discarded; everything the
		// consumer sees belongs to the replacement credential.
		expect(events.map(event => event.type)).toEqual(["start", "text_start", "text_delta", "done"]);
		expect(snapshots).toEqual([2, 2, 2, 2]);
		expect(result.credentialId).toBe(2);
	});

	it("keeps the failed credential on an auth error that is not retried", async () => {
		registerCustomApi(API, () => textStream("auth-error"), SOURCE_ID);

		const { result } = await collect(
			streamSimple(model(), context, {
				apiKey: "first-key",
				credentialId: 1,
				onAuthError: async () => undefined,
			}),
		);

		expect(result.stopReason).toBe("error");
		expect(result.credentialId).toBe(1);
	});

	it("drops attribution when an auth retry resolves an unattributed key", async () => {
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) =>
				textStream(options?.apiKey === "first-key" ? "auth-error" : "done"),
			SOURCE_ID,
		);

		const { result } = await collect(
			streamSimple(model(), context, {
				apiKey: "first-key",
				credentialId: 1,
				onAuthError: async () => "env-key",
			}),
		);

		expect(result.stopReason).toBe("stop");
		expect(result.credentialId).toBeUndefined();
	});

	it("does not fail a request whose provider message rejects the attribution write", async () => {
		registerCustomApi(
			API,
			() => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const message = Object.freeze(assistant(["ok"]));
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
			SOURCE_ID,
		);

		const { result } = await collect(streamSimple(model(), context, { apiKey: "stored-key", credentialId: 4 }));

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "ok" }]);
		expect(result.credentialId).toBeUndefined();
	});

	it("aborts the provider request when the consumer stops early", async () => {
		let providerSignal: AbortSignal | undefined;
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				providerSignal = options?.signal;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => stream.push({ type: "start", partial: assistant() }));
				providerSignal?.addEventListener("abort", () => stream.fail(new Error("Request was aborted")), {
					once: true,
				});
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, { apiKey: "stored-key", credentialId: 3 });
		const iterator = stream[Symbol.asyncIterator]();
		expect((await iterator.next()).done).toBe(false);
		await iterator.return?.();
		await Bun.sleep(0);

		expect(providerSignal?.aborted).toBe(true);
	});
});
