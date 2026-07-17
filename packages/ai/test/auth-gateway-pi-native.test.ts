import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerCustomApi, unregisterCustomApis } from "../src/api-registry";
import { startAuthGateway } from "../src/auth-gateway/server";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import { Effort } from "../src/model-thinking";
import { encodeStream, formatError, parseRequest } from "../src/providers/pi-native-server";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	Usage,
} from "../src/types";

function makeEventStream(events: AssistantMessageEvent[], final: AssistantMessage): AssistantMessageEventStream {
	async function* iter() {
		for (const e of events) yield e;
	}
	const stream = iter() as unknown as AssistantMessageEventStream;
	(stream as { result(): Promise<AssistantMessage> }).result = async () => final;
	return stream;
}

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<string[]> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
	}
	buf += decoder.decode();
	return buf.split("\n\n").filter(s => s.length > 0);
}

function parseSseLine(line: string): unknown {
	const stripped = line.replace(/^data: /, "");
	if (stripped === "[DONE]") return "[DONE]";
	return JSON.parse(stripped);
}

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function baseAssistant(overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

const baseContext: Context = {
	systemPrompt: ["you are helpful"],
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
};

const RAW_SENTINEL = "RAW_SERIALIZED_RESPONSES_REASONING";
const SUMMARY_SENTINEL = "SUMMARY_SAFE_DISPLAY_TEXT";
const OPAQUE_SIGNATURE = "opaque-provider-signature";

function responsesReasoningSignature(id: string): string {
	return JSON.stringify({
		type: "reasoning",
		id,
		content: [{ type: "reasoning_text", text: RAW_SENTINEL }],
	});
}

function reasoningMessage(provenance: "mixed" | "raw", displayText: string, id: string): AssistantMessage {
	const rawThinking = {
		type: "thinking" as const,
		thinking: displayText,
		thinkingSignature: responsesReasoningSignature(id),
		provenance,
		rawText: RAW_SENTINEL,
		...(provenance === "mixed" ? { summaryText: displayText } : {}),
	};
	return baseAssistant({
		content:
			provenance === "mixed"
				? [rawThinking, { type: "thinking", thinking: SUMMARY_SENTINEL, thinkingSignature: OPAQUE_SIGNATURE }]
				: [rawThinking],
	});
}
const SYNC_THROW_SOURCE = "auth-gateway-sync-throw-test";
const SYNC_THROW_API = "auth-gateway-sync-throw-test" as Api;

describe("pi-native parseRequest", () => {
	it("accepts modelId + context and returns canonical shape", () => {
		const parsed = parseRequest({
			modelId: "claude-sonnet-4-5",
			context: baseContext,
			options: { temperature: 0.5, reasoning: Effort.High },
			stream: false,
		});
		expect(parsed.modelId).toBe("claude-sonnet-4-5");
		expect(parsed.context).toEqual(baseContext);
		expect(parsed.options.temperature).toBe(0.5);
		expect(parsed.options.reasoning).toBe(Effort.High);
		expect(parsed.stream).toBe(false);
	});

	it("preserves fallback managed mode while dropping its local attempt token", () => {
		const parsed = parseRequest({
			modelId: "x",
			context: baseContext,
			options: { fallbackManaged: true, fallbackAttempt: { shouldNotCrossWire: true } },
		});
		expect(parsed.options.fallbackManaged).toBe(true);
		expect(parsed.options.fallbackAttempt).toBeUndefined();
	});

	it("falls back to model.id when modelId is absent (streamProxy compat)", () => {
		const parsed = parseRequest({
			model: { id: "claude-opus-4-1", provider: "anthropic", api: "anthropic-messages" },
			context: baseContext,
		});
		expect(parsed.modelId).toBe("claude-opus-4-1");
	});

	it("accepts top-level string `model` as the id (extra compat)", () => {
		const parsed = parseRequest({
			model: "gpt-5",
			context: baseContext,
		});
		expect(parsed.modelId).toBe("gpt-5");
	});

	it("defaults stream to true when omitted", () => {
		const parsed = parseRequest({ modelId: "x", context: baseContext });
		expect(parsed.stream).toBe(true);
	});

	it("drops server-controlled and unknown option keys", () => {
		const parsed = parseRequest({
			modelId: "x",
			context: baseContext,
			options: {
				temperature: 0.2,
				apiKey: "should-be-stripped",
				signal: {},
				fetch: () => {},
				onPayload: () => {},
				onResponse: () => {},
				onSseEvent: () => {},
				execHandlers: {},
				providerSessionState: new Map(),
				notARealField: "ignored",
			},
		});
		expect(parsed.options).toEqual({ temperature: 0.2 });
		expect("apiKey" in parsed.options).toBe(false);
		expect("signal" in parsed.options).toBe(false);
		expect("fetch" in parsed.options).toBe(false);
		expect("onPayload" in parsed.options).toBe(false);
		expect("notARealField" in parsed.options).toBe(false);
	});

	it("preserves headers, metadata, sessionId, thinkingBudgets", () => {
		const parsed = parseRequest({
			modelId: "x",
			context: baseContext,
			options: {
				headers: { "x-foo": "bar" },
				metadata: { user_id: "u" },
				sessionId: "explicit-session",
				thinkingBudgets: { high: 8192 },
				stopSequences: ["\n\n"],
				toolChoice: "required",
				serviceTier: "priority",
				cacheRetention: "long",
			},
		});
		expect(parsed.options.headers).toEqual({ "x-foo": "bar" });
		expect(parsed.options.metadata).toEqual({ user_id: "u" });
		expect(parsed.options.sessionId).toBe("explicit-session");
		expect(parsed.options.thinkingBudgets).toEqual({ high: 8192 });
		expect(parsed.options.stopSequences).toEqual(["\n\n"]);
		expect(parsed.options.toolChoice).toBe("required");
		expect(parsed.options.serviceTier).toBe("priority");
		expect(parsed.options.cacheRetention).toBe("long");
	});

	it("rejects missing required fields", () => {
		expect(() => parseRequest({ context: baseContext })).toThrow(/modelId/);
		expect(() => parseRequest({ modelId: "x" })).toThrow(/context/);
		expect(() => parseRequest({ modelId: "x", context: { systemPrompt: [] } })).toThrow(/messages/);
	});

	it("rejects non-object body", () => {
		expect(() => parseRequest(null)).toThrow();
		expect(() => parseRequest("hello")).toThrow();
		expect(() => parseRequest([])).toThrow();
	});

	it("validates systemPrompt and tools shape", () => {
		expect(() => parseRequest({ modelId: "x", context: { systemPrompt: "not array", messages: [] } })).toThrow(
			/systemPrompt/,
		);
		expect(() => parseRequest({ modelId: "x", context: { messages: [], tools: "not array" } })).toThrow(/tools/);
	});

	it("skips null and undefined option values", () => {
		const parsed = parseRequest({
			modelId: "x",
			context: baseContext,
			options: { temperature: null, topP: undefined, maxTokens: 100 },
		});
		expect("temperature" in parsed.options).toBe(false);
		expect("topP" in parsed.options).toBe(false);
		expect(parsed.options.maxTokens).toBe(100);
	});
});
describe("pi-native encodeStream", () => {
	it("ships every AssistantMessageEvent verbatim, terminated by [DONE]", async () => {
		// Pi-native is gjc-talks-to-gjc: the client feeds parsed events directly
		// into `AssistantMessageEventStream.push()`, so the wire IS the canonical
		// event type. No partial-stripping, no per-event re-shaping.
		const finalMessage = baseAssistant({
			content: [{ type: "text", text: "hi" }],
			usage: { ...ZERO_USAGE, input: 4, output: 2, totalTokens: 6 },
		});
		const partialAfterDelta: AssistantMessage = baseAssistant({
			content: [{ type: "text", text: "hi" }],
		});
		const events: AssistantMessageEvent[] = [
			{ type: "start", partial: baseAssistant() },
			{ type: "text_start", contentIndex: 0, partial: baseAssistant({ content: [{ type: "text", text: "" }] }) },
			{ type: "text_delta", contentIndex: 0, delta: "hi", partial: partialAfterDelta },
			{ type: "text_end", contentIndex: 0, content: "hi", partial: partialAfterDelta },
			{ type: "done", reason: "stop", message: finalMessage },
		];
		const chunks = await collectSse(encodeStream(makeEventStream(events, finalMessage)));
		const parsed = chunks.map(parseSseLine);

		// Every payload is the input event verbatim — partials, signatures,
		// usage all intact. Terminator follows `done`/`error`.
		expect(parsed.length).toBe(events.length + 1);
		for (let i = 0; i < events.length; i++) {
			expect(parsed[i]).toEqual(JSON.parse(JSON.stringify(events[i])));
		}
		expect(parsed[parsed.length - 1]).toBe("[DONE]");
	});

	it("preserves the rolling `partial` on every delta (sanity: no shrink)", async () => {
		// Guards against an accidental re-introduction of partial-stripping
		// optimization. Clients depend on `partial` being present.
		const final = baseAssistant({ content: [{ type: "text", text: "abc" }] });
		const events: AssistantMessageEvent[] = [
			{ type: "text_delta", contentIndex: 0, delta: "abc", partial: final },
			{ type: "done", reason: "stop", message: final },
		];
		const parsed = (await collectSse(encodeStream(makeEventStream(events, final)))).map(parseSseLine) as Array<
			Record<string, unknown>
		>;
		expect(parsed[0]).toHaveProperty("partial");
		expect((parsed[0] as { partial: AssistantMessage }).partial.content).toEqual([{ type: "text", text: "abc" }]);
	});

	it("stops streaming after a terminal `done` and emits [DONE] once", async () => {
		const final = baseAssistant();
		const events: AssistantMessageEvent[] = [
			{ type: "done", reason: "stop", message: final },
			// This trailing event must NOT reach the wire — terminal events end
			// the stream so the client iterator resolves cleanly.
			{ type: "text_delta", contentIndex: 0, delta: "ghost", partial: final },
		];
		const parsed = (await collectSse(encodeStream(makeEventStream(events, final)))).map(parseSseLine);
		expect(parsed.length).toBe(2);
		expect((parsed[0] as { type: string }).type).toBe("done");
		expect(parsed[1]).toBe("[DONE]");
	});

	it("forwards `error` events verbatim, then closes with [DONE]", async () => {
		const errored = baseAssistant({
			stopReason: "error",
			errorMessage: "upstream blew up",
			usage: { ...ZERO_USAGE, input: 3 },
		});
		const events: AssistantMessageEvent[] = [{ type: "error", reason: "error", error: errored }];
		const parsed = (await collectSse(encodeStream(makeEventStream(events, errored)))).map(parseSseLine);
		expect(parsed[0]).toEqual({ type: "error", reason: "error", error: JSON.parse(JSON.stringify(errored)) });
		expect(parsed[1]).toBe("[DONE]");
	});

	it("replays mixed Responses reasoning safely across start, partial, done, and error envelopes", async () => {
		const startPartial = reasoningMessage("mixed", `${SUMMARY_SENTINEL} start`, "rs-start");
		const deltaPartial = reasoningMessage("mixed", `${SUMMARY_SENTINEL} delta`, "rs-delta");
		const endPartial = reasoningMessage("mixed", `${SUMMARY_SENTINEL} end`, "rs-end");
		const completed = reasoningMessage("mixed", `${SUMMARY_SENTINEL} done`, "rs-done");
		const errored = reasoningMessage("mixed", `${SUMMARY_SENTINEL} error`, "rs-error");
		const completedEvents: AssistantMessageEvent[] = [
			{ type: "start", partial: startPartial },
			{ type: "thinking_start", contentIndex: 0, partial: startPartial },
			{ type: "thinking_delta", contentIndex: 0, delta: RAW_SENTINEL, partial: deltaPartial },
			{ type: "reasoning_summary_start", contentIndex: 0, partial: deltaPartial },
			{
				type: "reasoning_summary_delta",
				contentIndex: 0,
				delta: `${SUMMARY_SENTINEL} delta`,
				partial: deltaPartial,
			},
			{ type: "thinking_end", contentIndex: 0, content: RAW_SENTINEL, partial: endPartial },
			{ type: "reasoning_summary_end", contentIndex: 0, content: `${SUMMARY_SENTINEL} end`, partial: endPartial },
			{ type: "done", reason: "stop", message: completed },
		];
		const errorEvents: AssistantMessageEvent[] = [{ type: "error", reason: "error", error: errored }];
		const completedSource = JSON.stringify(completedEvents);
		const errorSource = JSON.stringify(errorEvents);
		const completedFrames = (await collectSse(encodeStream(makeEventStream(completedEvents, completed)))).map(
			parseSseLine,
		) as Array<Record<string, unknown>>;
		const errorFrames = (await collectSse(encodeStream(makeEventStream(errorEvents, errored)))).map(
			parseSseLine,
		) as Array<Record<string, unknown>>;

		for (const bytes of [JSON.stringify(completedFrames), JSON.stringify(errorFrames)]) {
			expect(bytes).not.toContain(RAW_SENTINEL);
			expect(bytes).toContain(SUMMARY_SENTINEL);
			expect(bytes).toContain(OPAQUE_SIGNATURE);
		}
		const summaryDelta = completedFrames.find(frame => frame.type === "reasoning_summary_delta");
		const summaryEnd = completedFrames.find(frame => frame.type === "reasoning_summary_end");
		expect((summaryDelta as { delta: string }).delta).toBe(`${SUMMARY_SENTINEL} delta`);
		expect((summaryEnd as { content: string }).content).toBe(`${SUMMARY_SENTINEL} end`);

		const projectedMessages = completedFrames.flatMap(frame => {
			if (frame.type === "done") return [frame.message as AssistantMessage];
			if (frame.type === "[DONE]") return [];
			return frame.partial ? [frame.partial as AssistantMessage] : [];
		});
		projectedMessages.push(errorFrames[0]!.error as AssistantMessage);
		for (const message of projectedMessages) {
			expect(message.content[0]).toMatchObject({ type: "thinking" });
			expect(message.content[0]).not.toHaveProperty("rawText");
			expect(message.content[0]).not.toHaveProperty("thinkingSignature");
			if ((message.content[0] as { provenance?: string }).provenance === "summary") continue;
			expect(message.content[0]).toMatchObject({ provenance: "mixed" });
			expect(message.content[1]).toMatchObject({ type: "thinking", thinkingSignature: OPAQUE_SIGNATURE });
		}

		expect(JSON.stringify(completedEvents)).toBe(completedSource);
		expect(JSON.stringify(errorEvents)).toBe(errorSource);
	});

	it("drops raw-only Responses reasoning projections without mutating replay sources", async () => {
		const startPartial = reasoningMessage("raw", RAW_SENTINEL, "rs-raw-start");
		const deltaPartial = reasoningMessage("raw", RAW_SENTINEL, "rs-raw-delta");
		const endPartial = reasoningMessage("raw", RAW_SENTINEL, "rs-raw-end");
		const completed = reasoningMessage("raw", RAW_SENTINEL, "rs-raw-done");
		const errored = reasoningMessage("raw", RAW_SENTINEL, "rs-raw-error");
		const completedEvents: AssistantMessageEvent[] = [
			{ type: "start", partial: startPartial },
			{ type: "thinking_start", contentIndex: 0, partial: startPartial },
			{ type: "thinking_delta", contentIndex: 0, delta: RAW_SENTINEL, partial: deltaPartial },
			{ type: "thinking_end", contentIndex: 0, content: RAW_SENTINEL, partial: endPartial },
			{ type: "done", reason: "stop", message: completed },
		];
		const errorEvents: AssistantMessageEvent[] = [{ type: "error", reason: "error", error: errored }];
		const completedSource = JSON.stringify(completedEvents);
		const errorSource = JSON.stringify(errorEvents);
		const completedFrames = (await collectSse(encodeStream(makeEventStream(completedEvents, completed)))).map(
			parseSseLine,
		) as Array<Record<string, unknown>>;
		const errorFrames = (await collectSse(encodeStream(makeEventStream(errorEvents, errored)))).map(
			parseSseLine,
		) as Array<Record<string, unknown>>;

		for (const bytes of [JSON.stringify(completedFrames), JSON.stringify(errorFrames)]) {
			expect(bytes).not.toContain(RAW_SENTINEL);
		}
		expect([completedFrames[0]!.type, completedFrames[1]!.type, completedFrames[2]]).toEqual([
			"start",
			"done",
			"[DONE]",
		]);
		expect((completedFrames[0]!.partial as AssistantMessage).content).toEqual([]);
		expect((completedFrames[1]!.message as AssistantMessage).content).toEqual([]);
		expect((errorFrames[0]!.error as AssistantMessage).content).toEqual([]);

		expect(JSON.stringify(completedEvents)).toBe(completedSource);
		expect(JSON.stringify(errorEvents)).toBe(errorSource);
	});

	it("withholds interrupted unprovenanced Codex Responses thinking", async () => {
		const partial = baseAssistant({
			api: "openai-codex-responses",
			provider: "openai-codex",
			content: [{ type: "thinking", thinking: RAW_SENTINEL }],
		});
		const events: AssistantMessageEvent[] = [
			{ type: "start", partial: baseAssistant() },
			{ type: "thinking_start", contentIndex: 0, partial },
			{ type: "thinking_delta", contentIndex: 0, delta: RAW_SENTINEL, partial },
			{ type: "error", reason: "error", error: partial },
		];
		const lines = await collectSse(encodeStream(makeEventStream(events, partial)));
		const frames = lines.slice(0, -1).map(parseSseLine) as Array<Record<string, unknown>>;

		expect(lines.join("\n")).not.toContain(RAW_SENTINEL);
		expect(frames.map(frame => frame.type)).toEqual(["start", "error"]);
		expect((frames[1]!.error as AssistantMessage).content).toEqual([]);
	});

	it.each([
		"raw",
		"mixed",
	] as const)("withholds unclassified thinking until a terminal $provenance partial classifies it", async provenance => {
		const earlyPartial = baseAssistant({ content: [{ type: "thinking", thinking: RAW_SENTINEL }] });
		const final = reasoningMessage(provenance, `${SUMMARY_SENTINEL} terminal`, `rs-terminal-${provenance}`);
		const events: AssistantMessageEvent[] = [
			{ type: "start", partial: baseAssistant() },
			{ type: "thinking_start", contentIndex: 0, partial: earlyPartial },
			{ type: "thinking_delta", contentIndex: 0, delta: RAW_SENTINEL, partial: earlyPartial },
			{ type: "reasoning_summary_start", contentIndex: 0, partial: earlyPartial },
			{
				type: "reasoning_summary_delta",
				contentIndex: 0,
				delta: SUMMARY_SENTINEL,
				partial: earlyPartial,
			},
			{ type: "reasoning_summary_end", contentIndex: 0, content: SUMMARY_SENTINEL, partial: earlyPartial },
			{ type: "thinking_end", contentIndex: 0, content: RAW_SENTINEL, partial: final },
			{ type: "done", reason: "stop", message: final },
		];
		const source = JSON.stringify(events);
		const lines = await collectSse(encodeStream(makeEventStream(events, final)));
		const frames = lines.slice(0, -1).map(parseSseLine) as Array<Record<string, unknown>>;

		expect(lines.join("\n")).not.toContain(RAW_SENTINEL);
		expect(lines.join("\n")).toContain(SUMMARY_SENTINEL);
		expect(frames.map(frame => frame.type)).toEqual([
			"start",
			"reasoning_summary_start",
			"reasoning_summary_delta",
			"reasoning_summary_end",
			"done",
		]);
		const summaryFrames = frames.slice(1, 4) as Array<{ partial: AssistantMessage }>;
		for (const frame of summaryFrames) {
			expect(frame.partial.content[0]).toMatchObject({
				type: "thinking",
				provenance: "summary",
			});
			expect(frame.partial.content).toHaveLength(1);
		}
		expect(summaryFrames[1]!.partial.content[0]).toMatchObject({ summaryText: SUMMARY_SENTINEL });
		expect(summaryFrames[2]!.partial.content[0]).toMatchObject({ summaryText: SUMMARY_SENTINEL });
		expect(lines.at(-1)).toBe("data: [DONE]");
		expect(JSON.stringify(events)).toBe(source);
	});

	it("flushes an opaque provider-native thinking block only after its safe final partial", async () => {
		const opaqueThinking = {
			type: "thinking" as const,
			thinking: "OPAQUE_PROVIDER_NATIVE_THINKING",
			thinkingSignature: OPAQUE_SIGNATURE,
		};

		const partial = baseAssistant({ content: [opaqueThinking] });
		const events: AssistantMessageEvent[] = [
			{ type: "start", partial: baseAssistant() },
			{ type: "thinking_start", contentIndex: 0, partial },
			{ type: "thinking_delta", contentIndex: 0, delta: "OPAQUE_DELTA", partial },
			{ type: "thinking_end", contentIndex: 0, content: "OPAQUE_PROVIDER_NATIVE_THINKING", partial },
			{ type: "done", reason: "stop", message: partial },
		];
		const source = JSON.stringify(events);
		const lines = await collectSse(encodeStream(makeEventStream(events, partial)));
		const frames = lines.slice(0, -1).map(parseSseLine) as Array<Record<string, unknown>>;

		expect(frames.map(frame => frame.type)).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"done",
		]);
		expect(lines.at(-1)).toBe("data: [DONE]");
		expect((frames[2] as { delta: string }).delta).toBe("OPAQUE_DELTA");
		expect(JSON.stringify(events)).toBe(source);
	});

	it("emits a synthetic error envelope when the source iterator throws", async () => {
		// Source-stream failures (network drop after `streamSimple` returned)
		// must not hang the client. We surface a minimal `error` event followed
		// by `[DONE]` so the iterator on the other end resolves.
		const broken = (async function* () {
			yield { type: "start", partial: baseAssistant() } satisfies AssistantMessageEvent;
			throw new Error("connection reset");
		})() as unknown as AssistantMessageEventStream;
		(broken as { result(): Promise<AssistantMessage> }).result = async () => baseAssistant();

		const parsed = (await collectSse(encodeStream(broken))).map(parseSseLine);
		expect((parsed[0] as { type: string }).type).toBe("start");
		expect(parsed[1]).toEqual({ type: "error", reason: "error", errorMessage: "connection reset" });
		expect(parsed[2]).toBe("[DONE]");
	});
});

describe("pi-native formatError", () => {
	it("emits { error: { type, message } } with the given status", async () => {
		const res = formatError(401, "authentication_error", "no credential");
		expect(res.status).toBe(401);
		expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
		expect(await res.json()).toEqual({ error: { type: "authentication_error", message: "no credential" } });
	});
});

describe("pi-native managed gateway credential failure marking", () => {
	it.each([
		{ status: 401, message: "invalid API key", classification: "auth" },
		{ status: 429, message: "rate limit exceeded", classification: "rate limit" },
	])("marks a streamed $classification failure once and rotates credentials for an explicitly managed pi-native request", async ({
		status,
		message,
	}) => {
		let upstreamRequests = 0;
		const credentials: string[] = [];
		const upstream = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: req => {
				upstreamRequests += 1;
				credentials.push(req.headers.get("authorization") ?? "");
				return new Response(JSON.stringify({ error: { message } }), {
					status,
					headers: { "Content-Type": "application/json" },
				});
			},
		});
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-gateway-managed-"));
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "auth.db"));
		const storage = new AuthStorage(store);
		const provider = "gateway-managed-test";
		const model: Model<Api> = {
			id: "gateway-managed-model",
			name: "Gateway managed test model",
			api: "openai-completions",
			provider,
			baseUrl: upstream.url.toString(),
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4_096,
		};
		await storage.set(provider, [
			{ type: "api_key", key: "gateway-key-one" },
			{ type: "api_key", key: "gateway-key-two" },
		]);
		const gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["gateway-test-token"],
			version: "test",
			storage,
			resolveModel: id => (id === model.id ? model : undefined),
			listModels: () => [model],
		});
		const request = () =>
			fetch(`${gateway.url}/v1/pi/stream`, {
				method: "POST",
				headers: { Authorization: "Bearer gateway-test-token", "Content-Type": "application/json" },
				body: JSON.stringify({
					modelId: model.id,
					context: baseContext,
					stream: true,
					options: { fallbackManaged: true },
				}),
			});
		try {
			const first = await request();
			expect(first.status).toBe(200);
			await first.text();
			expect(upstreamRequests).toBe(1);
			expect(credentials).toEqual(["Bearer gateway-key-one"]);

			const second = await request();
			expect(second.status).toBe(200);
			await second.text();
			expect(upstreamRequests).toBe(2);
			expect(credentials).toEqual(["Bearer gateway-key-one", "Bearer gateway-key-two"]);
		} finally {
			await gateway.close();
			upstream.stop(true);
			store.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
	it("replays a translated OpenAI request with a refreshed credential after an auth failure", async () => {
		let upstreamRequests = 0;
		const credentials: string[] = [];
		const upstream = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: req => {
				upstreamRequests += 1;
				credentials.push(req.headers.get("authorization") ?? "");
				if (upstreamRequests === 1) {
					return new Response(JSON.stringify({ error: { message: "invalid API key" } }), {
						status: 401,
						headers: { "Content-Type": "application/json" },
					});
				}
				return new Response(
					`${[
						'data: {"choices":[{"delta":{"content":"ok"},"index":0}]}',
						'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
						"data: [DONE]",
					].join("\n\n")}\n\n`,
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-gateway-translated-retry-"));
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "auth.db"));
		const storage = new AuthStorage(store);
		const provider = "gateway-translated-retry-test";
		const model: Model<Api> = {
			id: "gateway-translated-retry-model",
			name: "Gateway translated retry test model",
			api: "openai-completions",
			provider,
			baseUrl: upstream.url.toString(),
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4_096,
		};
		await storage.set(provider, [
			{ type: "api_key", key: "gateway-key-one" },
			{ type: "api_key", key: "gateway-key-two" },
		]);
		const gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["gateway-test-token"],
			version: "test",
			storage,
			resolveModel: id => (id === model.id ? model : undefined),
		});
		try {
			const response = await fetch(`${gateway.url}/v1/chat/completions`, {
				method: "POST",
				headers: { Authorization: "Bearer gateway-test-token", "Content-Type": "application/json" },
				body: JSON.stringify({ model: model.id, messages: [{ role: "user", content: "hi" }], stream: true }),
			});
			expect(response.status).toBe(200);
			expect(await response.text()).toContain("[DONE]");
			expect(upstreamRequests).toBe(2);
			expect(credentials).toEqual(["Bearer gateway-key-one", "Bearer gateway-key-two"]);
		} finally {
			await gateway.close();
			upstream.stop(true);
			store.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
	it("marks a synchronous explicitly managed pi-native stream failure before returning the original error", async () => {
		const keys: Array<string | undefined> = [];
		registerCustomApi(
			SYNC_THROW_API,
			(_model, _context, options) => {
				keys.push(options?.apiKey);
				throw Object.assign(new Error("invalid API key"), { status: 401 });
			},
			SYNC_THROW_SOURCE,
		);
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-gateway-sync-throw-"));
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "auth.db"));
		const storage = new AuthStorage(store);
		const provider = "gateway-sync-throw-test";
		const model: Model<Api> = {
			id: "gateway-sync-throw-model",
			name: "Gateway synchronous throw test model",
			api: SYNC_THROW_API,
			provider,
			baseUrl: "mock://",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4_096,
		};
		await storage.set(provider, [
			{ type: "api_key", key: "gateway-key-one" },
			{ type: "api_key", key: "gateway-key-two" },
		]);
		const gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["gateway-test-token"],
			version: "test",
			storage,
			resolveModel: id => (id === model.id ? model : undefined),
		});
		const request = () =>
			fetch(`${gateway.url}/v1/pi/stream`, {
				method: "POST",
				headers: { Authorization: "Bearer gateway-test-token", "Content-Type": "application/json" },
				body: JSON.stringify({
					modelId: model.id,
					context: baseContext,
					stream: true,
					options: { fallbackManaged: true },
				}),
			});
		try {
			expect((await request()).status).toBe(401);
			expect((await request()).status).toBe(401);
			expect(keys).toEqual(["gateway-key-one", "gateway-key-two"]);
		} finally {
			unregisterCustomApis(SYNC_THROW_SOURCE);
			await gateway.close();
			store.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
