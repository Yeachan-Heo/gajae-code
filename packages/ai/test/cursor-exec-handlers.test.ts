import { describe, expect, it } from "bun:test";
import * as events from "node:events";
import * as http2 from "node:http2";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	buildCursorHistoryForTest,
	buildCursorRequestContextRules,
	buildCursorSystemPromptJsons,
	createCursorMessageQueueForTest,
	disposeCursorConversation,
	resolveExecHandler,
	storeCursorBlobForTest,
	streamCursor,
	waitForCursorWriteDrainForTest,
	waitForCursorWritesForTest,
	writeCursorFrameForTest,
} from "../src/providers/cursor";
import type { AgentRunRequest, AgentServerMessage } from "../src/providers/cursor/gen/agent_pb";
import {
	type AgentClientMessage,
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	ConversationStateStructureSchema,
	ConversationTokenDetailsSchema,
	ExecServerMessageSchema,
	InteractionUpdateSchema,
	ReadArgsSchema,
	ReadResultSchema,
	ReadSuccessSchema,
	ShellArgsSchema,
	ShellResultSchema,
	ShellSuccessSchema,
	StepTimingSchema,
	TextDeltaUpdateSchema,
	TokenDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "../src/providers/cursor/gen/agent_pb";
import type { AssistantMessageEvent, Context, CursorShellStreamCallbacks, Model } from "../src/types";

const cursorModel: Model<"cursor-agent"> = {
	id: "cursor-composer-2.5",
	name: "Cursor Composer 2.5",
	api: "cursor-agent",
	provider: "cursor",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
};

async function captureCursorPayload(context: Context): Promise<AgentRunRequest> {
	const server = http2.createServer();
	let captured: AgentRunRequest | undefined;
	server.on("stream", (stream: http2.ServerHttp2Stream) => {
		stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		const chunks: Buffer[] = [];
		stream.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
			const request = decodeRunRequest(chunks);
			if (!request || captured) return;
			captured = request;
			stream.end(frameServerMessage(createTurnEndedMessage()));
		});
	});
	const serverListening = Promise.withResolvers<void>();
	server.once("error", serverListening.reject);
	server.listen(0, "127.0.0.1", serverListening.resolve);
	await serverListening.promise;

	const conversationId = `payload-capture-${crypto.randomUUID()}`;
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected TCP server address");
		const events: AssistantMessageEvent[] = [];
		for await (const event of streamCursor({ ...cursorModel, baseUrl: `http://127.0.0.1:${address.port}` }, context, {
			apiKey: "test-token",
			conversationId,
		})) {
			events.push(event);
		}
		const terminalError = events.find(event => event.type === "error");
		if (terminalError?.type === "error") throw new Error(terminalError.error.errorMessage);
		if (!captured) throw new Error("Expected encoded Cursor run request");
		return captured;
	} finally {
		disposeCursorConversation(conversationId);
		const serverClosed = Promise.withResolvers<void>();
		server.close(error => (error ? serverClosed.reject(error) : serverClosed.resolve()));
		await serverClosed.promise;
	}
}

function frameServerMessage(message: AgentServerMessage): Buffer {
	const bytes = toBinary(AgentServerMessageSchema, message);
	return frameConnectPayload(bytes);
}

function frameConnectPayload(bytes: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + bytes.length);
	frame[0] = flags;
	frame.writeUInt32BE(bytes.length, 1);
	frame.set(bytes, 5);
	return frame;
}

function decodeClientMessages(chunks: Buffer[]): AgentClientMessage[] {
	let pending = Buffer.concat(chunks);
	const messages: AgentClientMessage[] = [];
	while (pending.length >= 5) {
		const length = pending.readUInt32BE(1);
		if (pending.length < 5 + length) break;
		messages.push(fromBinary(AgentClientMessageSchema, pending.subarray(5, 5 + length)));
		pending = pending.subarray(5 + length);
	}
	return messages;
}

function decodeRunRequest(chunks: Buffer[]): AgentRunRequest | undefined {
	for (const message of decodeClientMessages(chunks)) {
		if (message.message.case === "runRequest") return message.message.value;
	}
	return undefined;
}

function createReadExecMessage(id = 1): AgentServerMessage {
	return create(AgentServerMessageSchema, {
		message: {
			case: "execServerMessage",
			value: create(ExecServerMessageSchema, {
				id,
				message: {
					case: "readArgs",
					value: create(ReadArgsSchema, { path: "/tmp/example" }),
				},
			}),
		},
	});
}

function createTurnEndedMessage(): AgentServerMessage {
	return create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: {
					case: "turnEnded",
					value: create(TurnEndedUpdateSchema, {}),
				},
			}),
		},
	});
}

function createConversationCheckpointMessage(usedTokens?: number): AgentServerMessage {
	return create(AgentServerMessageSchema, {
		message: {
			case: "conversationCheckpointUpdate",
			value: create(ConversationStateStructureSchema, {
				...(usedTokens === undefined
					? {}
					: { tokenDetails: create(ConversationTokenDetailsSchema, { usedTokens }) }),
			}),
		},
	});
}

function createReadSuccessResult(output: string) {
	return create(ReadResultSchema, {
		result: {
			case: "success",
			value: create(ReadSuccessSchema, {
				path: "/tmp/example",
				output: { case: "content", value: output },
			}),
		},
	});
}
describe("Cursor resolveExecHandler execHandlers binding", () => {
	it("invokes handler with correct this when passed as bound method", async () => {
		const sentinel = { tag: "bound-correctly" };
		const handlers = {
			sentinel,
			async read(_args: { path: string }) {
				// Handler methods rely on 'this' (e.g. to access other handlers or state).
				// When passed without .bind(handlers), 'this' is undefined in strict mode.
				return { execResult: (this as typeof handlers).sentinel, toolResult: undefined };
			},
		};

		const { execResult } = await resolveExecHandler(
			{ path: "/tmp/foo" },
			handlers.read.bind(handlers),
			undefined,
			() => ({}),
			() => ({ tag: "rejected" }),
			() => ({ tag: "error" }),
		);

		expect(execResult).toBe(sentinel);
		expect((execResult as { tag: string }).tag).toBe("bound-correctly");
	});

	it("handler loses this when passed unbound and fails or returns wrong result", async () => {
		const sentinel = { tag: "bound-correctly" };
		const handlers = {
			sentinel,
			async read(_args: { path: string }) {
				return { execResult: (this as typeof handlers).sentinel, toolResult: undefined };
			},
		};

		// Pass method reference without .bind(handlers). In strict mode 'this' is undefined
		// when resolveExecHandler calls handler(args), so (this as any).sentinel throws.
		const { execResult } = await resolveExecHandler(
			{ path: "/tmp/foo" },
			handlers.read,
			undefined,
			() => ({}),
			() => ({ tag: "rejected" }),
			(msg: string) => ({ tag: "error", message: msg }),
		);

		// Should get error result (handler threw accessing undefined.sentinel)
		expect(execResult).toEqual({ tag: "error", message: expect.any(String) });
	});

	it("preserves the handler-provided toolResult call ID", async () => {
		const { execResult, toolResult } = await resolveExecHandler<{ path: string }, { result: string }>(
			{ path: "/tmp/foo" },
			async () => ({
				role: "toolResult",
				toolCallId: "exact-call-id",
				toolName: "read",
				content: [{ type: "text", text: "contents" }],
				isError: false,
				timestamp: 1,
			}),
			undefined,
			toolResult => ({ result: toolResult.toolCallId }),
			() => ({ result: "rejected" }),
			() => ({ result: "error" }),
		);

		expect(execResult).toEqual({ result: "exact-call-id" });
		expect(toolResult).toMatchObject({
			role: "toolResult",
			toolCallId: "exact-call-id",
			toolName: "read",
		});
	});
});

describe("Cursor server message ordering", () => {
	it("waits for a slow handler before turn completion", async () => {
		const queue = createCursorMessageQueueForTest();
		const events: string[] = [];
		let releaseSlow!: () => void;
		const slow = new Promise<void>(resolve => {
			releaseSlow = resolve;
		});

		queue.enqueue(async () => {
			await slow;
			events.push("exec-response");
		});
		const turnDone = queue.enqueue(() => {
			events.push("turn-ended");
		});
		let finalized = false;
		const finalizedPromise = queue.drain().then(() => {
			finalized = true;
		});

		await Promise.resolve();
		expect(finalized).toBe(false);
		releaseSlow();
		await turnDone;
		await finalizedPromise;
		expect(events).toEqual(["exec-response", "turn-ended"]);
	});

	it("continues in order after a rejected handler", async () => {
		const queue = createCursorMessageQueueForTest();
		const events: string[] = [];
		const rejected = queue.enqueue(async () => {
			events.push("first");
			throw new Error("handler failed");
		});
		const next = queue.enqueue(() => {
			events.push("second");
		});

		await expect(rejected).rejects.toThrow("handler failed");
		await next;
		expect(events).toEqual(["first", "second"]);
	});
});

describe("Cursor payload transport boundary", () => {
	it("awaits an async replacement and encodes nonzero 64-bit fields on the wire", async () => {
		const durationMs = 9_007_199_254_740_993n;
		const timestampMs = 9_007_199_254_740_995n;
		const server = http2.createServer();
		let dispatchCount = 0;
		let encodedReplacement: AgentRunRequest | undefined;
		server.on("stream", (stream: http2.ServerHttp2Stream) => {
			const dispatch = ++dispatchCount;
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			const chunks: Buffer[] = [];
			let handled = false;
			stream.on("data", (chunk: Buffer) => {
				chunks.push(chunk);
				const request = decodeRunRequest(chunks);
				if (!request || handled) return;
				handled = true;
				if (dispatch === 1) {
					const conversationState = create(ConversationStateStructureSchema, request.conversationState);
					conversationState.turnTimings = [create(StepTimingSchema, { durationMs, timestampMs })];
					const checkpoint = create(AgentServerMessageSchema, {
						message: {
							case: "conversationCheckpointUpdate",
							value: conversationState,
						},
					});
					stream.end(
						Buffer.concat([frameServerMessage(checkpoint), frameServerMessage(createTurnEndedMessage())]),
					);
					return;
				}
				encodedReplacement = request;
				stream.end(frameServerMessage(createTurnEndedMessage()));
			});
		});
		const serverListening = Promise.withResolvers<void>();
		server.once("error", serverListening.reject);
		server.listen(0, "127.0.0.1", serverListening.resolve);
		await serverListening.promise;

		const conversationId = `payload-replacement-${crypto.randomUUID()}`;
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected TCP server address");
			const model = { ...cursorModel, baseUrl: `http://127.0.0.1:${address.port}` };
			const firstContext: Context = {
				messages: [{ role: "user", content: "seed cached state", timestamp: 0 }],
			};
			let firstDone: Extract<AssistantMessageEvent, { type: "done" }> | undefined;
			for await (const event of streamCursor(model, firstContext, { apiKey: "test-token", conversationId })) {
				if (event.type === "error") throw new Error(event.error.errorMessage);
				if (event.type === "done") firstDone = event;
			}
			if (!firstDone) throw new Error("Expected first Cursor turn to complete");

			let hookSettled = false;
			const secondContext: Context = {
				messages: [
					...firstContext.messages,
					firstDone.message,
					{ role: "user", content: "send replacement", timestamp: 1 },
				],
			};
			for await (const event of streamCursor(model, secondContext, {
				apiKey: "test-token",
				conversationId,
				onPayload: async payload => {
					await Bun.sleep(1);
					const jsonPayload = JSON.parse(JSON.stringify(payload)) as Record<string, unknown> & {
						conversationState?: Record<string, unknown>;
					};
					hookSettled = true;
					return {
						...jsonPayload,
						customSystemPrompt: "async hook replacement",
						conversationState: {
							...jsonPayload.conversationState,
							turnTimings: [{ durationMs: durationMs.toString(), timestampMs: timestampMs.toString() }],
						},
					};
				},
			})) {
				if (event.type === "error") throw new Error(event.error.errorMessage);
			}

			expect(hookSettled).toBe(true);
			expect(dispatchCount).toBe(2);
			expect(encodedReplacement?.customSystemPrompt).toBe("async hook replacement");
			expect(encodedReplacement?.conversationState?.turnTimings[0]).toMatchObject({ durationMs, timestampMs });
		} finally {
			disposeCursorConversation(conversationId);
			const serverClosed = Promise.withResolvers<void>();
			server.close(error => (error ? serverClosed.reject(error) : serverClosed.resolve()));
			await serverClosed.promise;
		}
	});

	it("rejects a malformed replacement before opening a transport stream", async () => {
		const server = http2.createServer();
		let dispatchCount = 0;
		server.on("stream", (stream: http2.ServerHttp2Stream) => {
			dispatchCount++;
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.once("data", () => stream.end(frameServerMessage(createTurnEndedMessage())));
		});
		const serverListening = Promise.withResolvers<void>();
		server.once("error", serverListening.reject);
		server.listen(0, "127.0.0.1", serverListening.resolve);
		await serverListening.promise;

		const conversationId = `payload-rejection-${crypto.randomUUID()}`;
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected TCP server address");
			let hookSettled = false;
			const events: AssistantMessageEvent[] = [];
			for await (const event of streamCursor(
				{ ...cursorModel, baseUrl: `http://127.0.0.1:${address.port}` },
				{ messages: [{ role: "user", content: "reject replacement", timestamp: 0 }] },
				{
					apiKey: "test-token",
					conversationId,
					onPayload: async () => {
						await Bun.sleep(1);
						hookSettled = true;
						return { conversationState: { turnTimings: [{ durationMs: {} }] } };
					},
				},
			)) {
				events.push(event);
			}

			expect(hookSettled).toBe(true);
			expect(dispatchCount).toBe(0);
			const errors = events.filter(
				(event): event is Extract<AssistantMessageEvent, { type: "error" }> => event.type === "error",
			);
			expect(errors).toHaveLength(1);
			expect(errors[0].error.errorMessage).toContain("duration");
		} finally {
			disposeCursorConversation(conversationId);
			const serverClosed = Promise.withResolvers<void>();
			server.close(error => (error ? serverClosed.reject(error) : serverClosed.resolve()));
			await serverClosed.promise;
		}
	});
});

describe("Cursor request writer teardown", () => {
	it("preserves the HTTP/2 write backpressure signal and resumes on drain", async () => {
		const request = Object.assign(new events.EventEmitter(), {
			closed: false,
			destroyed: false,
			writableEnded: false,
			writableFinished: false,
			write(_frame: Uint8Array, callback: (error?: Error | null) => void) {
				callback();
				return false;
			},
		}) as unknown as http2.ClientHttp2Stream;

		expect(writeCursorFrameForTest(request, Buffer.from("response"))).toBe(false);
		const drained = waitForCursorWriteDrainForTest(request, 100);
		request.emit("drain");
		await expect(drained).resolves.toBeUndefined();
	});

	it("bounds a live HTTP/2 backpressure stall", async () => {
		let closed = false;
		let destroyed = false;
		const request = Object.assign(new events.EventEmitter(), {
			get closed() {
				return closed;
			},
			get destroyed() {
				return destroyed;
			},
			writableEnded: false,
			writableFinished: false,
			close() {
				closed = true;
			},
			destroy() {
				destroyed = true;
			},
		}) as unknown as http2.ClientHttp2Stream;

		await expect(waitForCursorWriteDrainForTest(request, 10)).rejects.toThrow(
			"Cursor request write backpressure timed out after 10ms",
		);
		expect(closed).toBe(true);
		expect(destroyed).toBe(true);
	});

	it("makes an asynchronous write callback failure observable", async () => {
		let writeCallback: ((error?: Error | null) => void) | undefined;
		const request = {
			closed: false,
			destroyed: false,
			writableEnded: false,
			writableFinished: false,
			once() {
				return this;
			},
			removeListener() {
				return this;
			},
			write(_frame: Uint8Array, callback: (error?: Error | null) => void) {
				writeCallback = callback;
				return true;
			},
		} as unknown as http2.ClientHttp2Stream;

		expect(writeCursorFrameForTest(request, Buffer.from("response"))).toBe(true);
		const drained = waitForCursorWritesForTest(request, 100);
		writeCallback?.(new Error("async write failed"));
		await expect(drained).rejects.toThrow("async write failed");
	});

	it("bounds teardown when a peer stops reading after terminal", async () => {
		let closed = false;
		let destroyed = false;
		const request = {
			get closed() {
				return closed;
			},
			get destroyed() {
				return destroyed;
			},
			writableEnded: false,
			writableFinished: false,
			once() {
				return this;
			},
			removeListener() {
				return this;
			},
			write() {
				return true;
			},
			close() {
				closed = true;
			},
			destroy() {
				destroyed = true;
			},
		} as unknown as http2.ClientHttp2Stream;

		expect(writeCursorFrameForTest(request, Buffer.from("response"))).toBe(true);
		await expect(waitForCursorWritesForTest(request, 10)).rejects.toThrow(
			"Cursor request write drain timed out after 10ms",
		);
		expect(closed).toBe(true);
		expect(destroyed).toBe(true);
	});
});

describe("Cursor hostile server storage bounds", () => {
	it("rejects queued decoded bytes beyond the aggregate budget and releases accounting", async () => {
		const release = Promise.withResolvers<void>();
		const queue = createCursorMessageQueueForTest(undefined, 10);
		const first = queue.enqueue(() => release.promise, 8);
		expect(queue.pendingBytes()).toBe(8);
		await expect(queue.enqueue(() => {}, 3)).rejects.toThrow("bounded byte capacity");
		release.resolve();
		await first;
		expect(queue.pendingBytes()).toBe(0);
	});

	it("rejects blob entry and byte growth without evicting retained values", () => {
		const blobs = new Map<string, Uint8Array>();
		expect(storeCursorBlobForTest(blobs, "a", new Uint8Array(4), { maxEntries: 2, maxBytes: 6 })).toBe(true);
		expect(storeCursorBlobForTest(blobs, "b", new Uint8Array(2), { maxEntries: 2, maxBytes: 6 })).toBe(true);
		expect(storeCursorBlobForTest(blobs, "c", new Uint8Array(1), { maxEntries: 2, maxBytes: 6 })).toBe(false);
		expect(storeCursorBlobForTest(blobs, "a", new Uint8Array(5), { maxEntries: 2, maxBytes: 6 })).toBe(false);
		expect([...blobs.entries()].map(([id, value]) => [id, value.byteLength])).toEqual([
			["a", 4],
			["b", 2],
		]);
	});
});

describe("Cursor request lifecycle", () => {
	it("applies a checkpoint delivered after turnEnded before finalizing usage", async () => {
		const server = http2.createServer();
		server.on("stream", (stream: http2.ServerHttp2Stream) => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.once("data", () => {
				stream.write(frameServerMessage(createTurnEndedMessage()));
				setTimeout(() => {
					stream.end(frameServerMessage(createConversationCheckpointMessage(321)));
				}, 5);
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});

		const conversationId = `checkpoint-late-${crypto.randomUUID()}`;
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected TCP server address");
			const events: AssistantMessageEvent[] = [];
			for await (const event of streamCursor(
				{ ...cursorModel, baseUrl: `http://127.0.0.1:${address.port}` },
				{ messages: [{ role: "user", content: "checkpoint", timestamp: 0 }] },
				{ apiKey: "test-token", conversationId },
			)) {
				events.push(event);
			}
			const done = events.find(
				(event): event is Extract<AssistantMessageEvent, { type: "done" }> => event.type === "done",
			);
			expect(done?.message.usage.input).toBe(321);
			expect(events.filter(event => event.type === "error")).toHaveLength(0);
		} finally {
			disposeCursorConversation(conversationId);
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	it("rolls back checkpoint usage when a stream fails before retry", async () => {
		const server = http2.createServer();
		let requestCount = 0;
		let retryPayload: AgentRunRequest | undefined;
		server.on("stream", (stream: http2.ServerHttp2Stream) => {
			requestCount++;
			const requestChunks: Buffer[] = [];
			stream.on("error", () => {});
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.on("data", (chunk: Buffer) => {
				requestChunks.push(chunk);
				if (requestCount === 2) retryPayload ??= decodeRunRequest(requestChunks);
			});
			stream.once("data", () => {
				if (requestCount === 1) {
					stream.write(frameServerMessage(createConversationCheckpointMessage(500)));
					setTimeout(() => stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR), 5);
					return;
				}
				stream.end(frameServerMessage(createTurnEndedMessage()));
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});

		const conversationId = `checkpoint-rollback-${crypto.randomUUID()}`;
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected TCP server address");
			const model = { ...cursorModel, baseUrl: `http://127.0.0.1:${address.port}` };
			const firstEvents: AssistantMessageEvent[] = [];
			for await (const event of streamCursor(
				model,
				{ messages: [{ role: "user", content: "first", timestamp: 0 }] },
				{ apiKey: "test-token", conversationId },
			)) {
				firstEvents.push(event);
			}
			expect(firstEvents.some(event => event.type === "error")).toBe(true);

			const secondEvents: AssistantMessageEvent[] = [];
			for await (const event of streamCursor(
				model,
				{ messages: [{ role: "user", content: "retry", timestamp: 0 }] },
				{ apiKey: "test-token", conversationId },
			)) {
				secondEvents.push(event);
			}
			const done = secondEvents.find(
				(event): event is Extract<AssistantMessageEvent, { type: "done" }> => event.type === "done",
			);
			expect(done?.message.usage.input).toBe(0);
			expect(retryPayload?.conversationState?.tokenDetails?.usedTokens ?? 0).toBe(0);
		} finally {
			disposeCursorConversation(conversationId);
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	it("does not reuse cached state after the credential authority changes", async () => {
		const server = http2.createServer();
		let requestCount = 0;
		let secondPayload: AgentRunRequest | undefined;
		server.on("stream", (stream: http2.ServerHttp2Stream) => {
			requestCount++;
			const requestChunks: Buffer[] = [];
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.on("data", (chunk: Buffer) => {
				requestChunks.push(chunk);
				if (requestCount === 2) secondPayload ??= decodeRunRequest(requestChunks);
			});
			stream.once("data", () => {
				stream.end(
					requestCount === 1
						? Buffer.concat([
								frameServerMessage(createConversationCheckpointMessage(500)),
								frameServerMessage(createTurnEndedMessage()),
							])
						: frameServerMessage(createTurnEndedMessage()),
				);
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});

		const conversationId = `credential-isolation-${crypto.randomUUID()}`;
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected TCP server address");
			const model = { ...cursorModel, baseUrl: `http://127.0.0.1:${address.port}` };
			const firstContext: Context = { messages: [{ role: "user", content: "first", timestamp: 0 }] };
			let firstDone: Extract<AssistantMessageEvent, { type: "done" }> | undefined;
			for await (const event of streamCursor(model, firstContext, { apiKey: "tenant-a", conversationId })) {
				if (event.type === "done") firstDone = event;
			}
			if (!firstDone) throw new Error("Expected first Cursor request to complete");

			const secondContext: Context = {
				messages: [...firstContext.messages, firstDone.message, { role: "user", content: "second", timestamp: 1 }],
			};
			for await (const _event of streamCursor(model, secondContext, {
				apiKey: "tenant-b",
				conversationId,
			})) {
				// Drain the request to its terminal event.
			}

			expect(secondPayload?.conversationState?.tokenDetails?.usedTokens ?? 0).toBe(0);
		} finally {
			disposeCursorConversation(conversationId);
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	it("allows a delayed inbound terminal when the watchdog is disabled", async () => {
		const server = http2.createServer();
		server.on("stream", (stream: http2.ServerHttp2Stream) => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.once("data", () => {
				stream.write(frameServerMessage(createTurnEndedMessage()));
				setTimeout(() => stream.end(), 25);
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});

		const conversationId = `checkpoint-watchdog-${crypto.randomUUID()}`;
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected TCP server address");
			const events: AssistantMessageEvent[] = [];
			for await (const event of streamCursor(
				{ ...cursorModel, baseUrl: `http://127.0.0.1:${address.port}` },
				{ messages: [{ role: "user", content: "watchdog", timestamp: 0 }] },
				{ apiKey: "test-token", conversationId, streamIdleTimeoutMs: 0 },
			)) {
				events.push(event);
			}
			expect(events.filter(event => event.type === "done")).toHaveLength(1);
			expect(events.filter(event => event.type === "error")).toHaveLength(0);
		} finally {
			disposeCursorConversation(conversationId);
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	it("ends a successful request without resetting the HTTP2 stream", async () => {
		const requestEnded = Promise.withResolvers<void>();
		let requestAborted = false;
		const server = http2.createServer();
		server.on("stream", (stream: http2.ServerHttp2Stream) => {
			stream.on("aborted", () => {
				requestAborted = true;
			});
			stream.on("end", () => requestEnded.resolve());
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.once("data", () => stream.end(frameServerMessage(createTurnEndedMessage())));
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});

		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected TCP server address");
			for await (const _event of streamCursor(
				{ ...cursorModel, baseUrl: `http://127.0.0.1:${address.port}` },
				{ messages: [{ role: "user", content: "finish", timestamp: 0 }] },
				{ apiKey: "test-token" },
			)) {
				// Drain the request to its successful terminal event.
			}
			await requestEnded.promise;
			expect(requestAborted).toBe(false);
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	it("drains an admitted exec response before completing after turnEnded", async () => {
		const { promise: releasePromise, resolve: releaseHandler } = Promise.withResolvers<void>();
		const { promise: handlerStarted, resolve: markHandlerStarted } = Promise.withResolvers<void>();
		const { promise: responseReceived, resolve: markResponseReceived } = Promise.withResolvers<void>();
		const server = http2.createServer();
		const clientResponseChunks: Buffer[] = [];

		server.on("stream", (stream: http2.ServerHttp2Stream) => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			let receivedRequest = false;
			stream.on("data", (chunk: Buffer) => {
				if (receivedRequest) {
					clientResponseChunks.push(chunk);
					const messages = decodeClientMessages(clientResponseChunks);
					if (
						messages.some(
							message =>
								message.message.case === "execClientMessage" &&
								message.message.value.message.case === "readResult",
						)
					) {
						markResponseReceived();
						stream.end();
					}
					return;
				}
				receivedRequest = true;
				const execMessage = create(AgentServerMessageSchema, {
					message: {
						case: "execServerMessage",
						value: create(ExecServerMessageSchema, {
							id: 1,
							message: {
								case: "readArgs",
								value: create(ReadArgsSchema, { path: "/tmp/example" }),
							},
						}),
					},
				});
				const turnEnded = create(AgentServerMessageSchema, {
					message: {
						case: "interactionUpdate",
						value: create(InteractionUpdateSchema, {
							message: {
								case: "turnEnded",
								value: create(TurnEndedUpdateSchema, {}),
							},
						}),
					},
				});
				stream.end(Buffer.concat([frameServerMessage(execMessage), frameServerMessage(turnEnded)]));
			});
		});

		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});

		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected TCP server address");
			const events: string[] = [];
			const model = { ...cursorModel, baseUrl: `http://127.0.0.1:${address.port}` };
			const consume = (async () => {
				for await (const event of streamCursor(
					model,
					{ messages: [{ role: "user", content: "read", timestamp: 0 }] },
					{
						apiKey: "test-token",
						execHandlers: {
							async read() {
								markHandlerStarted();
								await releasePromise;
								return {
									result: create(ReadResultSchema, {
										result: {
											case: "success",
											value: create(ReadSuccessSchema, {
												path: "/tmp/example",
												output: { case: "content", value: "ok" },
											}),
										},
									}),
									toolResult: undefined,
								};
							},
						},
					},
				)) {
					events.push(event.type);
				}
			})();

			await handlerStarted;
			expect(events).not.toContain("done");
			releaseHandler();
			await responseReceived;
			await consume;
			expect(events.filter(type => type === "done")).toHaveLength(1);
			expect(events).not.toContain("error");
			const clientMessages = decodeClientMessages(clientResponseChunks);
			const clientMessageCases = clientMessages.map(message =>
				message.message.case === "execClientMessage" ? message.message.value.message.case : message.message.case,
			);
			expect(clientMessageCases).toContain("readResult");
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	it("settles a clean turnEnded with a held exec while the HTTP/2 stream stays open", async () => {
		const { promise: releasePromise, resolve: releaseHandler } = Promise.withResolvers<void>();
		const { promise: handlerStarted, resolve: markHandlerStarted } = Promise.withResolvers<void>();
		const { promise: responseReceived, resolve: markResponseReceived } = Promise.withResolvers<void>();
		const server = http2.createServer();
		const clientResponseChunks: Buffer[] = [];
		server.on("stream", (stream: http2.ServerHttp2Stream) => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			let receivedRequest = false;
			stream.on("data", (chunk: Buffer) => {
				if (!receivedRequest) {
					receivedRequest = true;
					stream.write(
						Buffer.concat([
							frameServerMessage(createReadExecMessage()),
							frameServerMessage(createTurnEndedMessage()),
						]),
					);
					return;
				}
				clientResponseChunks.push(chunk);
				if (
					decodeClientMessages(clientResponseChunks).some(
						message =>
							message.message.case === "execClientMessage" &&
							message.message.value.message.case === "readResult",
					)
				)
					markResponseReceived();
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});

		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected TCP server address");
			const events: string[] = [];
			const consume = (async () => {
				for await (const event of streamCursor(
					{ ...cursorModel, baseUrl: `http://127.0.0.1:${address.port}` },
					{ messages: [{ role: "user", content: "read", timestamp: 0 }] },
					{
						apiKey: "test-token",
						execHandlers: {
							async read() {
								markHandlerStarted();
								await releasePromise;
								return { result: createReadSuccessResult("ok"), toolResult: undefined };
							},
						},
					},
				)) {
					events.push(event.type);
				}
			})();

			await handlerStarted;
			expect(events).not.toContain("done");
			releaseHandler();
			await responseReceived;
			await consume;
			expect(events.filter(type => type === "done")).toHaveLength(1);
			expect(events).not.toContain("error");
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	it("preserves validated progress and drops a malformed tail after a held exec turnEnded", async () => {
		const { promise: releasePromise, resolve: releaseHandler } = Promise.withResolvers<void>();
		const { promise: handlerStarted, resolve: markHandlerStarted } = Promise.withResolvers<void>();
		const server = http2.createServer();
		server.on("stream", (stream: http2.ServerHttp2Stream) => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.once("data", () => {
				const text = create(AgentServerMessageSchema, {
					message: {
						case: "interactionUpdate",
						value: create(InteractionUpdateSchema, {
							message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text: "validated" }) },
						}),
					},
				});
				stream.end(
					Buffer.concat([
						frameServerMessage(createReadExecMessage()),
						frameServerMessage(text),
						frameServerMessage(createTurnEndedMessage()),
						frameConnectPayload(Buffer.from([0x80])),
					]),
				);
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});

		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected TCP server address");
			const cursorStream = streamCursor(
				{ ...cursorModel, baseUrl: `http://127.0.0.1:${address.port}` },
				{ messages: [{ role: "user", content: "read", timestamp: 0 }] },
				{
					apiKey: "test-token",
					execHandlers: {
						async read() {
							markHandlerStarted();
							await releasePromise;
							return { result: createReadSuccessResult("ok"), toolResult: undefined };
						},
					},
				},
			);
			const events: AssistantMessageEvent[] = [];
			const consume = (async () => {
				for await (const event of cursorStream) events.push(event);
			})();

			await handlerStarted;
			releaseHandler();
			await consume;
			const result = await cursorStream.result();
			expect(result.stopReason).toBe("stop");
			expect(result.errorMessage).toBeUndefined();
			expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "validated" }));
			expect(events.filter(event => event.type === "done")).toHaveLength(1);
			expect(events.filter(event => event.type === "error")).toHaveLength(0);
		} finally {
			releaseHandler();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	it("serializes multiple admitted exec responses before turn completion", async () => {
		const { promise: releaseFirst, resolve: resolveFirst } = Promise.withResolvers<void>();
		const { promise: firstStarted, resolve: resolveFirstStarted } = Promise.withResolvers<void>();
		const server = http2.createServer();
		server.on("stream", (stream: http2.ServerHttp2Stream) => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.once("data", () => {
				const read = (id: number) =>
					create(AgentServerMessageSchema, {
						message: {
							case: "execServerMessage",
							value: create(ExecServerMessageSchema, {
								id,
								message: { case: "readArgs", value: create(ReadArgsSchema, { path: `/tmp/${id}` }) },
							}),
						},
					});
				const ended = createTurnEndedMessage();
				stream.end(
					Buffer.concat([frameServerMessage(read(1)), frameServerMessage(read(2)), frameServerMessage(ended)]),
				);
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected TCP server address");
			const calls: number[] = [];
			const consume = (async () => {
				for await (const _event of streamCursor(
					{ ...cursorModel, baseUrl: `http://127.0.0.1:${address.port}` },
					{ messages: [{ role: "user", content: "read", timestamp: 0 }] },
					{
						apiKey: "test-token",
						execHandlers: {
							async read(args) {
								const id = Number(args.path.slice(-1));
								calls.push(id);
								if (id === 1) {
									resolveFirstStarted();
									await releaseFirst;
								}
								return { result: createReadSuccessResult(String(id)), toolResult: undefined };
							},
						},
					},
				)) {
				}
			})();
			await firstStarted;
			expect(calls).toEqual([1]);
			resolveFirst();
			await consume;
			expect(calls).toEqual([1, 2]);
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	it("bounds a never-settling admitted handler after turnEnded", async () => {
		const server = http2.createServer();
		server.on("stream", (stream: http2.ServerHttp2Stream) => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.once("data", () =>
				stream.end(
					Buffer.concat([
						frameServerMessage(createReadExecMessage()),
						frameServerMessage(createReadExecMessage(2)),
						frameServerMessage(createTurnEndedMessage()),
					]),
				),
			);
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected TCP server address");
			const events: string[] = [];
			const calls: string[] = [];
			for await (const event of streamCursor(
				{ ...cursorModel, baseUrl: `http://127.0.0.1:${address.port}` },
				{ messages: [{ role: "user", content: "read", timestamp: 0 }] },
				{
					apiKey: "test-token",
					streamIdleTimeoutMs: 10,
					execHandlers: {
						async read(args) {
							calls.push(args.path);
							await new Promise<void>(() => {});
							return createReadSuccessResult("");
						},
					},
				},
			))
				events.push(event.type);
			expect(events).toContain("error");
			expect(calls).toEqual(["/tmp/example"]);
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	it("settles an abort promptly and ignores a held handler response released afterward", async () => {
		const { promise: releasePromise, resolve: releaseHandler } = Promise.withResolvers<void>();
		const { promise: handlerStarted, resolve: markHandlerStarted } = Promise.withResolvers<void>();
		const server = http2.createServer();
		server.on("stream", (stream: http2.ServerHttp2Stream) => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.once("data", () => {
				stream.write(
					frameServerMessage(
						create(AgentServerMessageSchema, {
							message: {
								case: "execServerMessage",
								value: create(ExecServerMessageSchema, {
									id: 1,
									message: {
										case: "readArgs",
										value: create(ReadArgsSchema, { path: "/tmp/example" }),
									},
								}),
							},
						}),
					),
				);
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});

		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected TCP server address");
			const controller = new AbortController();
			const events: string[] = [];
			const terminalReasons: string[] = [];
			const consume = (async () => {
				for await (const event of streamCursor(
					{ ...cursorModel, baseUrl: `http://127.0.0.1:${address.port}` },
					{ messages: [{ role: "user", content: "read", timestamp: 0 }] },
					{
						apiKey: "test-token",
						signal: controller.signal,
						execHandlers: {
							async read() {
								markHandlerStarted();
								await releasePromise;
								return {
									result: create(ReadResultSchema, {
										result: {
											case: "success",
											value: create(ReadSuccessSchema, {
												path: "/tmp/example",
												output: { case: "content", value: "late" },
											}),
										},
									}),
									toolResult: undefined,
								};
							},
						},
					},
				)) {
					events.push(event.type);
					if (event.type === "error") terminalReasons.push(event.reason);
				}
			})();

			await handlerStarted;
			controller.abort();
			await consume;
			expect(events.filter(type => type === "error")).toHaveLength(1);
			expect(terminalReasons).toEqual(["aborted"]);
			expect(events).not.toContain("done");
			releaseHandler();
			await Promise.resolve();
			expect(events.filter(type => type === "error")).toHaveLength(1);
		} finally {
			releaseHandler();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	it("makes retained shell callbacks inert when aborting a held handler", async () => {
		const { promise: releasePromise, resolve: releaseHandler } = Promise.withResolvers<void>();
		const { promise: handlerStarted, resolve: markHandlerStarted } = Promise.withResolvers<void>();
		const { promise: handlerFinished, resolve: markHandlerFinished } = Promise.withResolvers<void>();
		const { promise: firstClientFrame, resolve: markFirstClientFrame } = Promise.withResolvers<void>();
		const server = http2.createServer();
		const clientChunks: Buffer[] = [];
		server.on("stream", (stream: http2.ServerHttp2Stream) => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			let receivedRequest = false;
			stream.on("data", (chunk: Buffer) => {
				if (receivedRequest) {
					clientChunks.push(chunk);
					markFirstClientFrame();
					return;
				}
				receivedRequest = true;
				stream.write(
					frameServerMessage(
						create(AgentServerMessageSchema, {
							message: {
								case: "execServerMessage",
								value: create(ExecServerMessageSchema, {
									id: 2,
									execId: "shell-2",
									message: {
										case: "shellStreamArgs",
										value: create(ShellArgsSchema, {
											command: "printf test",
											workingDirectory: "/tmp",
										}),
									},
								}),
							},
						}),
					),
				);
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});

		let retainedCallbacks: CursorShellStreamCallbacks | undefined;
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected TCP server address");
			const controller = new AbortController();
			const events: string[] = [];
			const terminalReasons: string[] = [];
			const consume = (async () => {
				for await (const event of streamCursor(
					{ ...cursorModel, baseUrl: `http://127.0.0.1:${address.port}` },
					{ messages: [{ role: "user", content: "shell", timestamp: 0 }] },
					{
						apiKey: "test-token",
						signal: controller.signal,
						execHandlers: {
							async shellStream(_args, callbacks) {
								retainedCallbacks = callbacks;
								markHandlerStarted();
								await releasePromise;
								markHandlerFinished();
								return {
									result: create(ShellResultSchema, {
										result: {
											case: "success",
											value: create(ShellSuccessSchema, {
												command: "printf test",
												workingDirectory: "/tmp",
											}),
										},
									}),
									toolResult: undefined,
								};
							},
						},
					},
				)) {
					events.push(event.type);
					if (event.type === "error") terminalReasons.push(event.reason);
				}
			})();

			await handlerStarted;
			await firstClientFrame;
			controller.abort();
			await consume;
			const chunksAfterAbort = clientChunks.length;
			retainedCallbacks?.onStdout("late output");
			retainedCallbacks?.onStderr("late error");
			releaseHandler();
			await handlerFinished;
			expect(clientChunks).toHaveLength(chunksAfterAbort);
			expect(events.filter(type => type === "error")).toHaveLength(1);
			expect(terminalReasons).toEqual(["aborted"]);
			expect(events).not.toContain("done");
		} finally {
			releaseHandler();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	it.each([
		{
			name: "non-zero trailers",
			terminate(stream: http2.ServerHttp2Stream) {
				stream.end();
			},
			respond(stream: http2.ServerHttp2Stream) {
				stream.respond({ ":status": 200, "content-type": "application/connect+proto" }, { waitForTrailers: true });
				stream.once("wantTrailers", () => {
					stream.sendTrailers({ "grpc-status": "13", "grpc-message": "trailer failure" });
				});
			},
			error: "gRPC error 13: trailer failure",
		},
		{
			name: "Connect end-stream error",
			terminate(stream: http2.ServerHttp2Stream) {
				stream.write(
					frameConnectPayload(
						Buffer.from(JSON.stringify({ error: { code: "internal", message: "end-stream failure" } })),
						0b00000010,
					),
				);
			},
			respond(stream: http2.ServerHttp2Stream) {
				stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			},
			error: "Connect error internal: end-stream failure",
		},
		{
			name: "request/session failure",
			terminate(stream: http2.ServerHttp2Stream) {
				stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
			},
			respond(stream: http2.ServerHttp2Stream) {
				stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			},
			error: "",
		},
	])("settles $name once while an exec handler is held", async ({ terminate, respond, error }) => {
		const { promise: releasePromise, resolve: releaseHandler } = Promise.withResolvers<void>();
		const { promise: handlerStarted, resolve: markHandlerStarted } = Promise.withResolvers<void>();
		const { promise: handlerFinished, resolve: markHandlerFinished } = Promise.withResolvers<void>();
		const clientChunks: Buffer[] = [];
		const server = http2.createServer();
		let request: http2.ServerHttp2Stream | undefined;
		server.on("stream", (stream: http2.ServerHttp2Stream) => {
			request = stream;
			stream.on("error", () => {});
			respond(stream);
			let receivedRequest = false;
			stream.on("data", (chunk: Buffer) => {
				if (receivedRequest) {
					clientChunks.push(chunk);
					return;
				}
				receivedRequest = true;
				stream.write(frameServerMessage(createReadExecMessage()));
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});

		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected TCP server address");
			const events: AssistantMessageEvent[] = [];
			const consume = (async () => {
				for await (const event of streamCursor(
					{ ...cursorModel, baseUrl: `http://127.0.0.1:${address.port}` },
					{ messages: [{ role: "user", content: "read", timestamp: 0 }] },
					{
						apiKey: "test-token",
						execHandlers: {
							async read() {
								markHandlerStarted();
								await releasePromise;
								markHandlerFinished();
								return { result: createReadSuccessResult("late"), toolResult: undefined };
							},
						},
					},
				)) {
					events.push(event);
				}
			})();

			await handlerStarted;
			if (!request) throw new Error("Expected Cursor request stream");
			terminate(request);
			await consume;
			const terminalEvents = events.filter(event => event.type === "done" || event.type === "error");
			expect(terminalEvents).toHaveLength(1);
			const terminal = terminalEvents[0];
			if (terminal.type !== "error") throw new Error("Expected terminal Cursor error");
			expect(terminal.reason).toBe("error");
			if (error) expect(terminal.error.errorMessage).toContain(error);
			const framesAtTerminal = clientChunks.length;
			releaseHandler();
			await handlerFinished;
			expect(clientChunks).toHaveLength(framesAtTerminal);
		} finally {
			releaseHandler();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	it("drops an END_STREAM error tail after a validated turnEnded", async () => {
		const { promise: releasePromise, resolve: releaseHandler } = Promise.withResolvers<void>();
		const { promise: handlerStarted, resolve: markHandlerStarted } = Promise.withResolvers<void>();
		const { promise: handlerFinished, resolve: markHandlerFinished } = Promise.withResolvers<void>();
		const clientChunks: Buffer[] = [];
		const server = http2.createServer();
		server.on("stream", (stream: http2.ServerHttp2Stream) => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.on("data", (chunk: Buffer) => clientChunks.push(chunk));
			stream.once("data", () => {
				stream.write(
					Buffer.concat([
						frameServerMessage(createReadExecMessage()),
						frameServerMessage(createTurnEndedMessage()),
						frameConnectPayload(
							Buffer.from(JSON.stringify({ error: { code: "internal", message: "terminal race" } })),
							0b00000010,
						),
					]),
				);
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});

		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected TCP server address");
			const events: AssistantMessageEvent[] = [];
			const consume = (async () => {
				for await (const event of streamCursor(
					{ ...cursorModel, baseUrl: `http://127.0.0.1:${address.port}` },
					{ messages: [{ role: "user", content: "read", timestamp: 0 }] },
					{
						apiKey: "test-token",
						execHandlers: {
							async read() {
								markHandlerStarted();
								await releasePromise;
								markHandlerFinished();
								return { result: createReadSuccessResult("late"), toolResult: undefined };
							},
						},
					},
				)) {
					events.push(event);
				}
			})();

			await handlerStarted;
			releaseHandler();
			await consume;
			const terminalEvents = events.filter(event => event.type === "done" || event.type === "error");
			expect(terminalEvents).toHaveLength(1);
			const terminal = terminalEvents[0];
			if (terminal.type !== "done") throw new Error("Expected successful Cursor terminal");
			await handlerFinished;
		} finally {
			releaseHandler();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	it("drains admitted progress before a trailer terminal when exec follows it", async () => {
		const { promise: releasePromise, resolve: releaseHandler } = Promise.withResolvers<void>();
		const { promise: handlerStarted, resolve: markHandlerStarted } = Promise.withResolvers<void>();
		const server = http2.createServer();
		server.on("stream", (stream: http2.ServerHttp2Stream) => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" }, { waitForTrailers: true });
			stream.once("wantTrailers", () => {
				stream.sendTrailers({ "grpc-status": "13", "grpc-message": "buffered progress failure" });
			});
			stream.once("data", () => {
				const text = create(AgentServerMessageSchema, {
					message: {
						case: "interactionUpdate",
						value: create(InteractionUpdateSchema, {
							message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text: "partial" }) },
						}),
					},
				});
				const tokens = create(AgentServerMessageSchema, {
					message: {
						case: "interactionUpdate",
						value: create(InteractionUpdateSchema, {
							message: { case: "tokenDelta", value: create(TokenDeltaUpdateSchema, { tokens: 17 }) },
						}),
					},
				});
				const checkpoint = create(AgentServerMessageSchema, {
					message: {
						case: "conversationCheckpointUpdate",
						value: create(ConversationStateStructureSchema, {
							tokenDetails: create(ConversationTokenDetailsSchema, { usedTokens: 99 }),
						}),
					},
				});
				stream.end(
					Buffer.concat([
						frameServerMessage(text),
						frameServerMessage(tokens),
						frameServerMessage(checkpoint),
						frameServerMessage(createReadExecMessage()),
					]),
				);
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});

		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected TCP server address");
			const events: AssistantMessageEvent[] = [];
			const consume = (async () => {
				for await (const event of streamCursor(
					{ ...cursorModel, baseUrl: `http://127.0.0.1:${address.port}` },
					{ messages: [{ role: "user", content: "read", timestamp: 0 }] },
					{
						apiKey: "test-token",
						execHandlers: {
							async read() {
								markHandlerStarted();
								await releasePromise;
								return { result: createReadSuccessResult("late"), toolResult: undefined };
							},
						},
					},
				)) {
					events.push(event);
				}
			})();

			await handlerStarted;
			await consume;
			const terminalEvents = events.filter(event => event.type === "done" || event.type === "error");
			expect(terminalEvents).toHaveLength(1);
			const terminal = terminalEvents[0];
			if (terminal.type !== "error") throw new Error("Expected terminal Cursor error");
			expect(terminal.error.errorMessage).toContain("buffered progress failure");
			expect(terminal.error.content).toContainEqual(expect.objectContaining({ type: "text", text: "partial" }));
			expect(terminal.error.usage.output).toBe(17);
			releaseHandler();
		} finally {
			releaseHandler();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	it("orders normal shell frames and makes retained callbacks inert after completion", async () => {
		const { promise: shellCompleted, resolve: markShellCompleted } = Promise.withResolvers<void>();
		const server = http2.createServer();
		const clientChunks: Buffer[] = [];
		server.on("stream", (stream: http2.ServerHttp2Stream) => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			let receivedRequest = false;
			let sentTerminal = false;
			stream.on("data", (chunk: Buffer) => {
				if (!receivedRequest) {
					receivedRequest = true;
					stream.write(
						frameServerMessage(
							create(AgentServerMessageSchema, {
								message: {
									case: "execServerMessage",
									value: create(ExecServerMessageSchema, {
										id: 3,
										execId: "shell-3",
										message: {
											case: "shellStreamArgs",
											value: create(ShellArgsSchema, {
												command: "printf test",
												workingDirectory: "/tmp",
											}),
										},
									}),
								},
							}),
						),
					);
					return;
				}
				clientChunks.push(chunk);
				const messages = decodeClientMessages(clientChunks);
				const streamClosed = messages.some(
					message =>
						message.message.case === "execClientControlMessage" &&
						message.message.value.message.case === "streamClose",
				);
				if (streamClosed && !sentTerminal) {
					sentTerminal = true;
					stream.write(frameServerMessage(createTurnEndedMessage()));
					stream.end();
				}
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});

		let retainedCallbacks: CursorShellStreamCallbacks | undefined;
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected TCP server address");
			const events: AssistantMessageEvent[] = [];
			for await (const event of streamCursor(
				{ ...cursorModel, baseUrl: `http://127.0.0.1:${address.port}` },
				{ messages: [{ role: "user", content: "shell", timestamp: 0 }] },
				{
					apiKey: "test-token",
					execHandlers: {
						async shellStream(_args, callbacks) {
							retainedCallbacks = callbacks;
							callbacks.onStdout("standard output\n");
							callbacks.onStderr("standard error\n");
							markShellCompleted();
							return {
								result: create(ShellResultSchema, {
									result: {
										case: "success",
										value: create(ShellSuccessSchema, {
											command: "printf test",
											workingDirectory: "/tmp",
										}),
									},
								}),
								toolResult: undefined,
							};
						},
					},
				},
			)) {
				events.push(event);
			}
			await shellCompleted;
			const clientMessages = decodeClientMessages(clientChunks);
			const shellFrames = clientMessages.flatMap(message => {
				if (message.message.case === "execClientMessage") {
					const execMessage = message.message.value.message;
					if (execMessage.case === "shellStream") return [execMessage.value.event.case];
					if (execMessage.case === "shellResult") return ["shellResult"];
				}
				if (
					message.message.case === "execClientControlMessage" &&
					message.message.value.message.case === "streamClose"
				) {
					return ["streamClose"];
				}
				return [];
			});
			expect(shellFrames).toEqual(["start", "stdout", "stderr", "exit", "shellResult", "streamClose"]);
			expect(events.filter(event => event.type === "done")).toHaveLength(1);
			const framesAfterCompletion = clientChunks.length;
			retainedCallbacks?.onStdout("late output\n");
			retainedCallbacks?.onStderr("late error\n");
			expect(clientChunks).toHaveLength(framesAfterCompletion);
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	it("fails once when the response ends before turnEnded", async () => {
		const server = http2.createServer();
		server.on("stream", (stream: http2.ServerHttp2Stream) => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.once("data", () => stream.end());
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});

		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected TCP server address");
			const events = [];
			for await (const event of streamCursor(
				{ ...cursorModel, baseUrl: `http://127.0.0.1:${address.port}` },
				{ messages: [{ role: "user", content: "continue", timestamp: 0 }] },
				{ apiKey: "test-token" },
			)) {
				events.push(event);
			}
			expect(events.filter(event => event.type === "error")).toHaveLength(1);
			expect(events).not.toContainEqual(expect.objectContaining({ type: "done" }));
			const terminal = events.at(-1);
			if (terminal?.type !== "error") throw new Error("Expected terminal Cursor error");
			expect(terminal.error.errorMessage).toContain("Cursor stream ended before turnEnded");
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
});

describe("Cursor system prompt encoding", () => {
	it("maps normalized prompts to ordered USER/global Cursor rules", () => {
		const rules = buildCursorRequestContextRules(["Primary instructions.", "", "Developer constraints."]);

		expect(rules).toHaveLength(2);
		expect(
			rules.map(rule => ({
				fullPath: rule.fullPath,
				content: rule.content,
				source: rule.source,
				type: rule.type?.type.case,
			})),
		).toEqual([
			{
				fullPath: "/gjc/system-prompt/0.mdc",
				content: "Primary instructions.",
				source: 2,
				type: "global",
			},
			{
				fullPath: "/gjc/system-prompt/1.mdc",
				content: "Developer constraints.",
				source: 2,
				type: "global",
			},
		]);
	});

	it("does not emit rules for missing or empty system prompts", () => {
		expect(buildCursorRequestContextRules(undefined)).toEqual([]);
		expect(buildCursorRequestContextRules(["", ""])).toEqual([]);
	});

	it("emits one Cursor system blob per ordered prompt", () => {
		const jsons = buildCursorSystemPromptJsons(["Primary instructions.", "Developer constraints."]);
		expect(jsons).toHaveLength(2);
		expect(JSON.parse(jsons[0])).toEqual({ role: "system", content: "Primary instructions." });
		expect(JSON.parse(jsons[1])).toEqual({ role: "system", content: "Developer constraints." });
	});

	it("falls back to a single default system message when all entries are empty", () => {
		const jsons = buildCursorSystemPromptJsons(["", ""]);
		expect(jsons).toHaveLength(1);
		expect(JSON.parse(jsons[0])).toEqual({ role: "system", content: "You are a helpful assistant." });
	});
});
describe("Cursor request action encoding", () => {
	it("uses a resume action for empty user turns", async () => {
		const payload = await captureCursorPayload({
			messages: [{ role: "user", content: "   ", timestamp: 0 }],
		});

		expect(payload.action?.action.case).toBe("resumeAction");
	});

	it("uses a user message action for non-empty user turns", async () => {
		const payload = await captureCursorPayload({
			messages: [{ role: "user", content: "continue", timestamp: 0 }],
		});

		expect(payload.action?.action.case).toBe("userMessageAction");
	});

	it("uses a user message action with selected context for image-only user turns", async () => {
		const imageData = "aW1hZ2U=";
		const payload = await captureCursorPayload({
			messages: [
				{
					role: "user",
					content: [{ type: "image", data: imageData, mimeType: "image/png" }],
					timestamp: 0,
				},
			],
		});

		if (payload.action?.action.case !== "userMessageAction") {
			throw new Error("Expected Cursor userMessageAction");
		}
		const userMessage = payload.action.action.value.userMessage;
		expect(userMessage?.text).toBe("");
		expect(userMessage?.selectedContext?.selectedImages).toHaveLength(1);
		const selectedImage = userMessage?.selectedContext?.selectedImages[0];
		expect(selectedImage?.mimeType).toBe("image/png");
		if (selectedImage?.dataOrBlobId.case !== "data") {
			throw new Error("Expected Cursor selected image data");
		}
		expect(Array.from(selectedImage.dataOrBlobId.value)).toEqual(Array.from(Buffer.from(imageData, "base64")));
	});
});

describe("Cursor history encoding", () => {
	it("preserves image-only user turns in root prompt history and conversation turns", () => {
		const imageData = "aW1hZ2U=";
		const history = buildCursorHistoryForTest([
			{
				role: "user",
				content: [{ type: "image", data: imageData, mimeType: "image/png" }],
				timestamp: 0,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "I can see it." }],
				api: "cursor-agent",
				provider: "cursor",
				model: "cursor-composer-2.5",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 0,
			},
			{ role: "user", content: "what is in the image?", timestamp: 0 },
		]);

		expect(history.rootPromptMessagesJson).toEqual([
			{
				role: "user",
				content: [{ type: "image", image: imageData, mediaType: "image/png" }],
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "I can see it." }],
			},
		]);
		expect(history.turnUserMessagesJson).toEqual([
			expect.objectContaining({
				selectedContext: {
					selectedImages: [
						expect.objectContaining({
							mimeType: "image/png",
							data: imageData,
						}),
					],
				},
			}),
		]);
	});
});
