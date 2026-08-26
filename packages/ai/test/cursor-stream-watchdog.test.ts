import { afterEach, describe, expect, it, vi } from "bun:test";
import * as http2 from "node:http2";
import { create, toBinary } from "@bufbuild/protobuf";
import { cursorExecDeadlineMsForTest, disposeCursorConversation, streamCursor } from "../src/providers/cursor";
import type { AgentServerMessage, InteractionUpdate } from "../src/providers/cursor/gen/agent_pb";
import {
	AgentServerMessageSchema,
	ConversationStateStructureSchema,
	ExecServerMessageSchema,
	HeartbeatUpdateSchema,
	InteractionUpdateSchema,
	PiReadExecArgsSchema,
	PiWriteExecArgsSchema,
	TextDeltaUpdateSchema,
	TokenDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "../src/providers/cursor/gen/agent_pb";
import { stream as streamModel } from "../src/stream";
import type { AssistantMessage, Context, CursorExecHandlers, Model } from "../src/types";

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

const baseContext: Context = { messages: [] };
const CONNECT_END_STREAM_FLAG = 0b00000010;

let server: http2.Http2Server | undefined;

afterEach(async () => {
	vi.restoreAllMocks();
	if (!server) return;
	const closing = Promise.withResolvers<void>();
	server.close(() => closing.resolve());
	server = undefined;
	await closing.promise;
});

function frameConnectMessage(bytes: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + bytes.length);
	frame[0] = flags;
	frame.writeUInt32BE(bytes.length, 1);
	frame.set(bytes, 5);
	return frame;
}

function sendInteractionUpdate(stream: http2.ServerHttp2Stream, message: InteractionUpdate["message"]): void {
	const update = create(InteractionUpdateSchema, { message });
	sendServerMessage(stream, { case: "interactionUpdate", value: update });
}

function sendServerMessage(stream: http2.ServerHttp2Stream, message: AgentServerMessage["message"]): void {
	stream.write(buildServerMessageFrame(message));
}

function buildServerMessageFrame(message: AgentServerMessage["message"]): Buffer {
	const serverMessage = create(AgentServerMessageSchema, { message });
	return frameConnectMessage(toBinary(AgentServerMessageSchema, serverMessage));
}

async function createCursorServer(onStream: (stream: http2.ServerHttp2Stream) => void): Promise<string> {
	server = http2.createServer();
	server.on("stream", onStream);
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Cursor test server did not bind a TCP port");
	return `http://127.0.0.1:${address.port}`;
}

async function collectTerminal(
	baseUrl: string,
	options: {
		streamFirstEventTimeoutMs?: number;
		streamIdleTimeoutMs?: number;
		execHandlers?: CursorExecHandlers;
		signal?: AbortSignal;
		conversationId?: string;
	},
): Promise<{ events: unknown[]; result: AssistantMessage }> {
	const stream = streamModel({ ...cursorModel, baseUrl }, baseContext, { apiKey: "test-token", ...options });
	const events: unknown[] = [];
	for await (const event of stream) events.push(event);
	return { events, result: await stream.result() };
}

function isTerminalEvent(event: unknown): boolean {
	if (!event || typeof event !== "object") return false;
	const type = (event as { type?: unknown }).type;
	return type === "done" || type === "error";
}

describe("Cursor raw transport watchdog", () => {
	it("keeps the normal exec budget when transport idle watching is disabled", () => {
		expect(cursorExecDeadlineMsForTest(undefined)).toBe(480_000);
		expect(cursorExecDeadlineMsForTest(0)).toBe(480_000);
		expect(cursorExecDeadlineMsForTest(120_000)).toBe(480_000);
	});

	it("starts the first-event budget before large request-context rule construction", async () => {
		let requestCount = 0;
		const baseUrl = await createCursorServer(stream => {
			requestCount += 1;
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		});
		const largeContext: Context = {
			...baseContext,
			systemPrompt: ["context-rule".repeat(500_000)],
		};
		const stream = streamModel({ ...cursorModel, baseUrl }, largeContext, {
			apiKey: "test-token",
			streamFirstEventTimeoutMs: 1,
		});
		const events: unknown[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(requestCount).toBe(0);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("first transport event");
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	});

	it("does not open a credential-bearing request for a pre-aborted signal", async () => {
		let requestCount = 0;
		const baseUrl = await createCursorServer(stream => {
			requestCount += 1;
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		});
		const controller = new AbortController();
		controller.abort(new Error("pre-aborted"));

		const { events, result } = await collectTerminal(baseUrl, {
			signal: controller.signal,
			streamFirstEventTimeoutMs: 20,
		});

		expect(requestCount).toBe(0);
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("pre-aborted");
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	});

	it("normalizes only Bun's default AbortError diagnostic", async () => {
		let requestCount = 0;
		const baseUrl = await createCursorServer(stream => {
			requestCount += 1;
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		});
		const controller = new AbortController();
		controller.abort();

		const { events, result } = await collectTerminal(baseUrl, {
			signal: controller.signal,
			streamFirstEventTimeoutMs: 20,
		});

		expect(requestCount).toBe(0);
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("Request was aborted");
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	});

	it("preserves a caller-supplied AbortError diagnostic", async () => {
		let requestCount = 0;
		const baseUrl = await createCursorServer(stream => {
			requestCount += 1;
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		});
		const controller = new AbortController();
		controller.abort(new DOMException("session closed by broker", "AbortError"));

		const { events, result } = await collectTerminal(baseUrl, {
			signal: controller.signal,
			streamFirstEventTimeoutMs: 20,
		});

		expect(requestCount).toBe(0);
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("session closed by broker");
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	});

	it("closes the request when abort wins during request setup", async () => {
		const controller = new AbortController();
		let requestCount = 0;
		const baseUrl = await createCursorServer(_stream => {
			requestCount += 1;
			controller.abort(new Error("setup race abort"));
		});

		const { events, result } = await collectTerminal(baseUrl, {
			signal: controller.signal,
			streamFirstEventTimeoutMs: 100,
		});

		expect(requestCount).toBe(1);
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("setup race abort");
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	});

	it("keeps an active Connect stream alive when heartbeat and token frames arrive without normalized output", async () => {
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(
				() =>
					sendInteractionUpdate(stream, {
						case: "heartbeat",
						value: create(HeartbeatUpdateSchema, {}),
					}),
				20,
			);
			setTimeout(
				() =>
					sendInteractionUpdate(stream, {
						case: "tokenDelta",
						value: create(TokenDeltaUpdateSchema, { tokens: 7 }),
					}),
				50,
			);
			setTimeout(
				() =>
					sendServerMessage(stream, {
						case: "conversationCheckpointUpdate",
						value: create(ConversationStateStructureSchema, {}),
					}),
				65,
			);
			setTimeout(
				() =>
					sendServerMessage(stream, {
						case: "execServerMessage",
						value: create(ExecServerMessageSchema, {}),
					}),
				75,
			);
			setTimeout(
				() =>
					sendInteractionUpdate(stream, {
						case: "heartbeat",
						value: create(HeartbeatUpdateSchema, {}),
					}),
				90,
			);
			setTimeout(() => {
				sendInteractionUpdate(stream, {
					case: "turnEnded",
					value: create(TurnEndedUpdateSchema, {}),
				});
				stream.end(frameConnectMessage(Buffer.from("{}"), CONNECT_END_STREAM_FLAG));
			}, 120);
		});

		const { result } = await collectTerminal(baseUrl, {
			streamFirstEventTimeoutMs: 40,
			streamIdleTimeoutMs: 40,
		});

		expect(result.stopReason).toBe("stop");
		expect(result.usage.output).toBe(7);
		expect(result.errorMessage).toBeUndefined();
	});

	it("applies backpressure to a coalesced burst without dropping raw progress or partial usage", async () => {
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(() => {
				const frames: Buffer[] = [];
				for (let index = 0; index < 300; index += 1) {
					const message =
						index === 150
							? ({
									case: "interactionUpdate",
									value: create(InteractionUpdateSchema, {
										message: { case: "tokenDelta", value: create(TokenDeltaUpdateSchema, { tokens: 11 }) },
									}),
								} satisfies AgentServerMessage["message"])
							: ({
									case: "interactionUpdate",
									value: create(InteractionUpdateSchema, {
										message: { case: "heartbeat", value: create(HeartbeatUpdateSchema, {}) },
									}),
								} satisfies AgentServerMessage["message"]);
					frames.push(buildServerMessageFrame(message));
				}
				frames.push(
					buildServerMessageFrame({
						case: "interactionUpdate",
						value: create(InteractionUpdateSchema, {
							message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
						}),
					}),
				);
				stream.end(Buffer.concat(frames));
			}, 10);
		});

		const { events, result } = await collectTerminal(baseUrl, {
			streamFirstEventTimeoutMs: 100,
			streamIdleTimeoutMs: 100,
		});

		expect(result.stopReason).toBe("stop");
		expect(result.usage.output).toBe(11);
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	});

	it("records turnEnded when it lands exactly on the coalesced queue boundary", async () => {
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(() => {
				const frames: Buffer[] = [];
				for (let index = 0; index < 255; index += 1) {
					frames.push(
						buildServerMessageFrame({
							case: "interactionUpdate",
							value: create(InteractionUpdateSchema, {
								message: { case: "heartbeat", value: create(HeartbeatUpdateSchema, {}) },
							}),
						}),
					);
				}
				frames.push(
					buildServerMessageFrame({
						case: "interactionUpdate",
						value: create(InteractionUpdateSchema, {
							message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
						}),
					}),
				);
				stream.end(Buffer.concat(frames));
			}, 10);
		});

		const { events, result } = await collectTerminal(baseUrl, {
			streamFirstEventTimeoutMs: 100,
			streamIdleTimeoutMs: 100,
		});

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	});

	it("does not dispatch a coalesced exec frame after turnEnded", async () => {
		let executions = 0;
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(() => {
				const turnEnded = buildServerMessageFrame({
					case: "interactionUpdate",
					value: create(InteractionUpdateSchema, {
						message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
					}),
				});
				const lateExec = buildServerMessageFrame({
					case: "execServerMessage",
					value: create(ExecServerMessageSchema, {
						id: 1,
						message: {
							case: "piReadArgs",
							value: create(PiReadExecArgsSchema, { path: "late.txt" }),
						},
					}),
				});
				stream.end(Buffer.concat([turnEnded, lateExec]));
			}, 10);
		});

		const { events, result } = await collectTerminal(baseUrl, {
			streamFirstEventTimeoutMs: 100,
			streamIdleTimeoutMs: 100,
			execHandlers: {
				piRead: async call => {
					executions += 1;
					return {
						role: "toolResult",
						toolCallId: call.toolCallId,
						toolName: "read",
						content: [],
						isError: false,
						timestamp: Date.now(),
					};
				},
			},
		});

		expect(result.stopReason).toBe("stop");
		expect(executions).toBe(0);
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	});

	it("rejects an empty Connect end-stream before turnEnded", async () => {
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(() => stream.end(frameConnectMessage(new Uint8Array(), CONNECT_END_STREAM_FLAG)), 10);
		});

		const { events, result } = await collectTerminal(baseUrl, {
			streamFirstEventTimeoutMs: 100,
			streamIdleTimeoutMs: 100,
		});

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Failed to parse Connect end stream");
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	});

	it("does not dispatch an exec frame coalesced after an error end-stream", async () => {
		let executions = 0;
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(() => {
				const errorEnd = frameConnectMessage(
					new TextEncoder().encode(JSON.stringify({ error: { code: "INTERNAL", message: "late failure" } })),
					CONNECT_END_STREAM_FLAG,
				);
				const lateExec = buildServerMessageFrame({
					case: "execServerMessage",
					value: create(ExecServerMessageSchema, {
						id: 1,
						message: {
							case: "piReadArgs",
							value: create(PiReadExecArgsSchema, { path: "late.txt" }),
						},
					}),
				});
				stream.end(Buffer.concat([errorEnd, lateExec]));
			}, 10);
		});

		const { events, result } = await collectTerminal(baseUrl, {
			streamFirstEventTimeoutMs: 100,
			streamIdleTimeoutMs: 100,
			execHandlers: {
				piRead: async call => {
					executions += 1;
					return {
						role: "toolResult",
						toolCallId: call.toolCallId,
						toolName: "read",
						content: [],
						isError: false,
						timestamp: Date.now(),
					};
				},
			},
		});

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Connect error INTERNAL: late failure");
		expect(executions).toBe(0);
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	});

	it("rejects a truncated final Connect frame instead of waiting for the idle watchdog", async () => {
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(
				() =>
					sendInteractionUpdate(stream, {
						case: "heartbeat",
						value: create(HeartbeatUpdateSchema, {}),
					}),
				10,
			);
			setTimeout(() => {
				const completeFrame = buildServerMessageFrame({
					case: "interactionUpdate",
					value: create(InteractionUpdateSchema, {
						message: { case: "heartbeat", value: create(HeartbeatUpdateSchema, {}) },
					}),
				});
				stream.end(completeFrame.subarray(0, 3));
			}, 20);
		});

		const { events, result } = await collectTerminal(baseUrl, {
			streamFirstEventTimeoutMs: 100,
			streamIdleTimeoutMs: 100,
		});

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Cursor HTTP/2 stream ended with a truncated Connect frame");
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	});

	it("preserves accumulated Cursor content and usage in exactly one terminal on a silent transport timeout", async () => {
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(
				() =>
					sendInteractionUpdate(stream, {
						case: "textDelta",
						value: create(TextDeltaUpdateSchema, { text: "partial" }),
					}),
				10,
			);
			setTimeout(
				() =>
					sendInteractionUpdate(stream, {
						case: "tokenDelta",
						value: create(TokenDeltaUpdateSchema, { tokens: 9 }),
					}),
				20,
			);
		});

		const { events, result } = await collectTerminal(baseUrl, {
			streamFirstEventTimeoutMs: 50,
			streamIdleTimeoutMs: 50,
		});

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Cursor stream stalled while waiting for the next event");
		expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "partial" }));
		expect(result.usage.output).toBe(9);
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	});

	it("does not rearm after caller abort while an exec handler is pending", async () => {
		const controller = new AbortController();
		const handlerReleased = Promise.withResolvers<void>();
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(
				() =>
					sendServerMessage(stream, {
						case: "execServerMessage",
						value: create(ExecServerMessageSchema, {
							id: 1,
							message: { case: "piReadArgs", value: create(PiReadExecArgsSchema, { path: "/tmp/pending" }) },
						}),
					}),
				10,
			);
		});

		const pending = collectTerminal(baseUrl, {
			signal: controller.signal,
			streamFirstEventTimeoutMs: 40,
			streamIdleTimeoutMs: 40,
			execHandlers: {
				piRead: async () => {
					await handlerReleased.promise;
					throw new Error("expected delayed handler failure");
				},
			},
		});
		await Bun.sleep(25);
		controller.abort();
		const { events, result } = await pending;
		const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
		handlerReleased.resolve();
		for (let tick = 0; tick < 20; tick++) await Promise.resolve();

		expect(result.stopReason).toBe("aborted");
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
		expect(timeoutSpy).not.toHaveBeenCalled();
	});

	it("keeps a stream alive when a checkpoint is the only transport progress", async () => {
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(
				() =>
					sendInteractionUpdate(stream, {
						case: "heartbeat",
						value: create(HeartbeatUpdateSchema, {}),
					}),
				10,
			);
			setTimeout(
				() =>
					sendServerMessage(stream, {
						case: "conversationCheckpointUpdate",
						value: create(ConversationStateStructureSchema, {}),
					}),
				80,
			);
			setTimeout(() => {
				sendInteractionUpdate(stream, { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) });
				stream.end(frameConnectMessage(Buffer.from("{}"), CONNECT_END_STREAM_FLAG));
			}, 150);
		});

		const { result } = await collectTerminal(baseUrl, {
			streamFirstEventTimeoutMs: 200,
			streamIdleTimeoutMs: 100,
		});

		expect(result.stopReason).toBe("stop");
	});

	it("does not time out while a Cursor exec handler is still running", async () => {
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(
				() =>
					sendServerMessage(stream, {
						case: "execServerMessage",
						value: create(ExecServerMessageSchema, {
							id: 1,
							message: { case: "piReadArgs", value: create(PiReadExecArgsSchema, { path: "/tmp/slow" }) },
						}),
					}),
				10,
			);
			setTimeout(() => {
				sendInteractionUpdate(stream, { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) });
				stream.end(frameConnectMessage(Buffer.from("{}"), CONNECT_END_STREAM_FLAG));
			}, 20);
		});

		const { events, result } = await collectTerminal(baseUrl, {
			streamFirstEventTimeoutMs: 40,
			streamIdleTimeoutMs: 40,
			execHandlers: {
				piRead: async () => {
					await Bun.sleep(100);
					throw new Error("expected test handler failure");
				},
			},
		});

		expect(result.stopReason).toBe("stop");
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	});

	it("times out a truly silent Cursor transport", async () => {
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		});

		const { events, result } = await collectTerminal(baseUrl, {
			streamFirstEventTimeoutMs: 40,
			streamIdleTimeoutMs: 40,
		});

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Cursor stream timed out while waiting for the first transport event");
		expect(result.transportFailure).toMatchObject({
			kind: "transport",
			providerCode: "stream_first_event_timeout",
			requestBytes: expect.any(Number),
			firstEventElapsedMs: expect.any(Number),
			firstEventTimeoutMs: 40,
			endpointClass: "custom",
		});
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	});

	it("bounds a never-settling local exec independently from raw transport progress", async () => {
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(
				() =>
					sendServerMessage(stream, {
						case: "execServerMessage",
						value: create(ExecServerMessageSchema, {
							id: 1,
							message: { case: "piReadArgs", value: create(PiReadExecArgsSchema, { path: "/tmp/never" }) },
						}),
					}),
				10,
			);
		});
		const neverSettles = Promise.withResolvers<never>();

		const { events, result } = await collectTerminal(baseUrl, {
			streamIdleTimeoutMs: 40,
			streamFirstEventTimeoutMs: 200,
			execHandlers: { piRead: async () => neverSettles.promise },
		});

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Cursor local exec exceeded its 160ms deadline");
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	});

	it("applies bounded backpressure while a local exec blocks frame handling", async () => {
		let serverStream: http2.ServerHttp2Stream | undefined;
		const baseUrl = await createCursorServer(stream => {
			serverStream = stream;
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(() => {
				sendServerMessage(stream, {
					case: "execServerMessage",
					value: create(ExecServerMessageSchema, {
						id: 1,
						message: { case: "piReadArgs", value: create(PiReadExecArgsSchema, { path: "/tmp/flood" }) },
					}),
				});
				for (let index = 0; index < 1_000; index += 1) {
					sendInteractionUpdate(stream, {
						case: "heartbeat",
						value: create(HeartbeatUpdateSchema, {}),
					});
				}
			}, 10);
		});
		const neverSettles = Promise.withResolvers<never>();

		const { result } = await collectTerminal(baseUrl, {
			streamIdleTimeoutMs: 40,
			streamFirstEventTimeoutMs: 200,
			execHandlers: { piRead: async () => neverSettles.promise },
		});

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Cursor local exec exceeded its 160ms deadline");
		for (let tick = 0; tick < 20 && !serverStream?.closed; tick += 1) await Bun.sleep(1);
		expect(serverStream?.closed).toBe(true);
	});
	it("aborts the per-exec signal handed to the handler when the deadline fires", async () => {
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(
				() =>
					sendServerMessage(stream, {
						case: "execServerMessage",
						value: create(ExecServerMessageSchema, {
							id: 1,
							message: {
								case: "piReadArgs",
								value: create(PiReadExecArgsSchema, { path: "/tmp/deadline-abort" }),
							},
						}),
					}),
				10,
			);
		});
		const observed = Promise.withResolvers<AbortSignal | undefined>();

		const { result } = await collectTerminal(baseUrl, {
			streamIdleTimeoutMs: 40,
			streamFirstEventTimeoutMs: 500,
			execHandlers: {
				piRead: call => {
					observed.resolve(call.signal);
					return Promise.withResolvers<never>().promise;
				},
			},
		});

		const signal = await observed.promise;
		expect(signal).toBeDefined();
		for (let tick = 0; tick < 40 && !signal?.aborted; tick += 1) await Bun.sleep(5);
		expect(signal?.aborted).toBe(true);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Cursor local exec exceeded its 160ms deadline");
	});

	it("waits for a started non-abortable write before publishing a deadline terminal", async () => {
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(
				() =>
					sendServerMessage(stream, {
						case: "execServerMessage",
						value: create(ExecServerMessageSchema, {
							id: 1,
							message: {
								case: "piWriteArgs",
								value: create(PiWriteExecArgsSchema, { path: "archive.zip:entry.txt", content: "next" }),
							},
						}),
					}),
				10,
			);
		});
		const started = Promise.withResolvers<void>();
		const settleWrite = Promise.withResolvers<void>();
		let terminalPublished = false;
		const pending = collectTerminal(baseUrl, {
			streamIdleTimeoutMs: 40,
			streamFirstEventTimeoutMs: 500,
			execHandlers: {
				piWrite: async call => {
					call.markNonAbortable?.();
					started.resolve();
					await settleWrite.promise;
					return {
						role: "toolResult",
						toolCallId: call.toolCallId,
						toolName: "write",
						content: [],
						isError: false,
						timestamp: Date.now(),
					};
				},
			},
		}).then(value => {
			terminalPublished = true;
			return value;
		});
		await started.promise;
		await Bun.sleep(220);
		expect(terminalPublished).toBe(false);
		settleWrite.resolve();
		const { events, result } = await pending;
		expect(result.errorMessage).toContain("Cursor local exec exceeded its 160ms deadline");
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	});

	it("publishes a caller-abort terminal only after the non-abortable archive mutation is final", async () => {
		const controller = new AbortController();
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(
				() =>
					sendServerMessage(stream, {
						case: "execServerMessage",
						value: create(ExecServerMessageSchema, {
							id: 1,
							message: {
								case: "piWriteArgs",
								value: create(PiWriteExecArgsSchema, { path: "archive.zip:entry.txt", content: "next" }),
							},
						}),
					}),
				10,
			);
		});
		const started = Promise.withResolvers<void>();
		const settleWrite = Promise.withResolvers<void>();
		let terminalPublished = false;
		let archiveMutationCount = 0;
		let mutationCountAtTerminal: number | undefined;
		const pending = collectTerminal(baseUrl, {
			signal: controller.signal,
			streamIdleTimeoutMs: 40,
			streamFirstEventTimeoutMs: 500,
			execHandlers: {
				piWrite: async call => {
					call.markNonAbortable?.();
					started.resolve();
					await settleWrite.promise;
					archiveMutationCount += 1;
					return {
						role: "toolResult",
						toolCallId: call.toolCallId,
						toolName: "write",
						content: [],
						isError: false,
						timestamp: Date.now(),
					};
				},
			},
		}).then(value => {
			terminalPublished = true;
			mutationCountAtTerminal = archiveMutationCount;
			return value;
		});
		await started.promise;
		controller.abort(new Error("caller cancelled archive write"));
		await Bun.sleep(20);
		expect(terminalPublished).toBe(false);
		expect(archiveMutationCount).toBe(0);
		settleWrite.resolve();
		const { events, result } = await pending;
		expect(mutationCountAtTerminal).toBe(1);
		expect(archiveMutationCount).toBe(1);
		await Bun.sleep(20);
		expect(archiveMutationCount).toBe(1);
		expect(result.errorMessage).toBe("caller cancelled archive write");
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	});

	it("waits for a started non-abortable write before publishing a gRPC trailer failure", async () => {
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" }, { waitForTrailers: true });
			stream.on("wantTrailers", () => {
				stream.sendTrailers({ "grpc-status": "13", "grpc-message": "transport%20reset" });
			});
			setTimeout(
				() =>
					sendServerMessage(stream, {
						case: "execServerMessage",
						value: create(ExecServerMessageSchema, {
							id: 1,
							message: {
								case: "piWriteArgs",
								value: create(PiWriteExecArgsSchema, { path: "archive.zip:entry.txt", content: "next" }),
							},
						}),
					}),
				10,
			);
			setTimeout(() => stream.end(), 20);
		});
		const started = Promise.withResolvers<void>();
		const settleWrite = Promise.withResolvers<void>();
		let terminalPublished = false;
		const pending = collectTerminal(baseUrl, {
			streamIdleTimeoutMs: 100,
			streamFirstEventTimeoutMs: 500,
			execHandlers: {
				piWrite: async call => {
					call.markNonAbortable?.();
					started.resolve();
					await settleWrite.promise;
					return {
						role: "toolResult",
						toolCallId: call.toolCallId,
						toolName: "write",
						content: [],
						isError: false,
						timestamp: Date.now(),
					};
				},
			},
		}).then(value => {
			terminalPublished = true;
			return value;
		});

		await started.promise;
		await Bun.sleep(40);
		expect(terminalPublished).toBe(false);
		settleWrite.resolve();
		const { events, result } = await pending;
		expect(result.errorMessage).toContain("gRPC error 13: transport reset");
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	});

	it("drops buffered execs when a gRPC trailer failure closes admission", async () => {
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" }, { waitForTrailers: true });
			stream.on("wantTrailers", () => {
				stream.sendTrailers({ "grpc-status": "13", "grpc-message": "transport%20reset" });
			});
			setTimeout(() => {
				const first = buildServerMessageFrame({
					case: "execServerMessage",
					value: create(ExecServerMessageSchema, {
						id: 1,
						message: {
							case: "piWriteArgs",
							value: create(PiWriteExecArgsSchema, { path: "archive.zip:first.txt", content: "first" }),
						},
					}),
				});
				const second = buildServerMessageFrame({
					case: "execServerMessage",
					value: create(ExecServerMessageSchema, {
						id: 2,
						message: {
							case: "piWriteArgs",
							value: create(PiWriteExecArgsSchema, { path: "archive.zip:second.txt", content: "second" }),
						},
					}),
				});
				stream.write(Buffer.concat([first, second]));
				setTimeout(() => stream.end(), 10);
			}, 10);
		});
		const started = Promise.withResolvers<void>();
		const settleWrite = Promise.withResolvers<void>();
		let executionCount = 0;
		let terminalPublished = false;
		const pending = collectTerminal(baseUrl, {
			streamIdleTimeoutMs: 100,
			streamFirstEventTimeoutMs: 500,
			execHandlers: {
				piWrite: async call => {
					executionCount += 1;
					call.markNonAbortable?.();
					started.resolve();
					await settleWrite.promise;
					return {
						role: "toolResult",
						toolCallId: call.toolCallId,
						toolName: "write",
						content: [],
						isError: false,
						timestamp: Date.now(),
					};
				},
			},
		}).then(value => {
			terminalPublished = true;
			return value;
		});

		await started.promise;
		await Bun.sleep(40);
		expect(terminalPublished).toBe(false);
		settleWrite.resolve();
		const { events, result } = await pending;
		expect(executionCount).toBe(1);
		expect(result.errorMessage).toContain("gRPC error 13: transport reset");
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	});

	it("drops buffered execs when an HTTP/2 reset closes admission", async () => {
		const baseUrl = await createCursorServer(stream => {
			stream.on("error", () => {});
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(() => {
				const first = buildServerMessageFrame({
					case: "execServerMessage",
					value: create(ExecServerMessageSchema, {
						id: 1,
						message: {
							case: "piWriteArgs",
							value: create(PiWriteExecArgsSchema, { path: "archive.zip:first.txt", content: "first" }),
						},
					}),
				});
				const second = buildServerMessageFrame({
					case: "execServerMessage",
					value: create(ExecServerMessageSchema, {
						id: 2,
						message: {
							case: "piWriteArgs",
							value: create(PiWriteExecArgsSchema, { path: "archive.zip:second.txt", content: "second" }),
						},
					}),
				});
				stream.write(Buffer.concat([first, second]));
				setTimeout(() => stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR), 10);
			}, 10);
		});
		const started = Promise.withResolvers<void>();
		const settleWrite = Promise.withResolvers<void>();
		let executionCount = 0;
		const pending = collectTerminal(baseUrl, {
			streamIdleTimeoutMs: 100,
			streamFirstEventTimeoutMs: 500,
			execHandlers: {
				piWrite: async call => {
					executionCount += 1;
					call.markNonAbortable?.();
					started.resolve();
					await settleWrite.promise;
					return {
						role: "toolResult",
						toolCallId: call.toolCallId,
						toolName: "write",
						content: [],
						isError: false,
						timestamp: Date.now(),
					};
				},
			},
		});

		await started.promise;
		await Bun.sleep(40);
		settleWrite.resolve();
		const { events, result } = await pending;
		expect(executionCount).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/HTTP\/2|stream|reset|closed/i);
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	});

	it("aborts the per-exec signal when the caller aborts mid-exec", async () => {
		const controller = new AbortController();
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(
				() =>
					sendServerMessage(stream, {
						case: "execServerMessage",
						value: create(ExecServerMessageSchema, {
							id: 1,
							message: {
								case: "piReadArgs",
								value: create(PiReadExecArgsSchema, { path: "/tmp/caller-abort" }),
							},
						}),
					}),
				10,
			);
		});
		const observed = Promise.withResolvers<AbortSignal | undefined>();

		const pending = collectTerminal(baseUrl, {
			signal: controller.signal,
			streamIdleTimeoutMs: 40,
			streamFirstEventTimeoutMs: 500,
			execHandlers: {
				piRead: call => {
					observed.resolve(call.signal);
					return Promise.withResolvers<never>().promise;
				},
			},
		});
		const signal = await observed.promise;
		expect(signal).toBeDefined();
		controller.abort(new Error("caller cancelled exec"));
		const { result } = await pending;

		expect(signal?.aborted).toBe(true);
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("caller cancelled exec");
	});

	it("caps the settlement fence when a marked non-abortable mutation never settles", async () => {
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(
				() =>
					sendServerMessage(stream, {
						case: "execServerMessage",
						value: create(ExecServerMessageSchema, {
							id: 1,
							message: {
								case: "piWriteArgs",
								value: create(PiWriteExecArgsSchema, { path: "archive.zip:entry.txt", content: "next" }),
							},
						}),
					}),
				10,
			);
		});
		const started = Promise.withResolvers<void>();
		const pending = collectTerminal(baseUrl, {
			// Exec deadline = idle 40ms * 4 = 160ms; the fence grace cap is
			// max(5s, 160/4) = 5s, so a mutation that never settles still gets
			// a terminal within ~5.2s instead of hanging forever.
			streamIdleTimeoutMs: 40,
			streamFirstEventTimeoutMs: 500,
			execHandlers: {
				piWrite: async call => {
					call.markNonAbortable?.();
					started.resolve();
					await Promise.withResolvers<never>().promise;
					return {
						role: "toolResult",
						toolCallId: call.toolCallId,
						toolName: "write",
						content: [],
						isError: false,
						timestamp: Date.now(),
					};
				},
			},
		});
		await started.promise;
		const { events, result } = await pending;
		expect(result.errorMessage).toContain("Cursor local exec exceeded its 160ms deadline");
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	}, 9000);

	it("keeps later turns behind a capped mutation until the actual handler settles", async () => {
		let streamCount = 0;
		const baseUrl = await createCursorServer(stream => {
			streamCount += 1;
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(() => {
				if (streamCount === 1) {
					sendServerMessage(stream, {
						case: "execServerMessage",
						value: create(ExecServerMessageSchema, {
							id: 1,
							message: {
								case: "piWriteArgs",
								value: create(PiWriteExecArgsSchema, { path: "archive.zip:entry.txt", content: "next" }),
							},
						}),
					});
					return;
				}
				sendInteractionUpdate(stream, { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) });
				stream.end(frameConnectMessage(Buffer.from("{}"), CONNECT_END_STREAM_FLAG));
			}, 10);
		});
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const conversationId = "capped-mutation-lock";
		const first = collectTerminal(baseUrl, {
			conversationId,
			streamIdleTimeoutMs: 40,
			streamFirstEventTimeoutMs: 500,
			execHandlers: {
				piWrite: async call => {
					call.markNonAbortable?.();
					started.resolve();
					await release.promise;
					return {
						role: "toolResult",
						toolCallId: call.toolCallId,
						toolName: "write",
						content: [],
						isError: false,
						timestamp: Date.now(),
					};
				},
			},
		});
		await started.promise;
		const firstResult = await first;
		expect(firstResult.result.errorMessage).toContain("Cursor local exec exceeded its 160ms deadline");

		const second = collectTerminal(baseUrl, { conversationId, streamFirstEventTimeoutMs: 500 });
		await Bun.sleep(50);
		expect(streamCount).toBe(1);
		release.resolve();
		await second;
		expect(streamCount).toBe(2);
	}, 12_000);

	it("bounds a later turn waiting on a never-settling mutation lock", async () => {
		let streamCount = 0;
		const baseUrl = await createCursorServer(stream => {
			streamCount += 1;
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(() => {
				sendServerMessage(stream, {
					case: "execServerMessage",
					value: create(ExecServerMessageSchema, {
						id: 1,
						message: {
							case: "piWriteArgs",
							value: create(PiWriteExecArgsSchema, { path: "archive.zip:entry.txt", content: "next" }),
						},
					}),
				});
			}, 10);
		});
		const started = Promise.withResolvers<void>();
		const conversationId = `never-settling-mutation-lock-${crypto.randomUUID()}`;
		const first = collectTerminal(baseUrl, {
			conversationId,
			streamIdleTimeoutMs: 40,
			streamFirstEventTimeoutMs: 500,
			execHandlers: {
				piWrite: async call => {
					call.markNonAbortable?.();
					started.resolve();
					await Promise.withResolvers<never>().promise;
					return {
						role: "toolResult",
						toolCallId: call.toolCallId,
						toolName: "write",
						content: [],
						isError: false,
						timestamp: Date.now(),
					};
				},
			},
		});
		await started.promise;
		await first;

		const directStream = streamCursor({ ...cursorModel, baseUrl }, baseContext, {
			apiKey: "test-token",
			conversationId,
			streamFirstEventTimeoutMs: 40,
		});
		const directEvents: unknown[] = [];
		for await (const event of directStream) directEvents.push(event);
		const directResult = await directStream.result();
		expect(directResult.stopReason).toBe("error");
		expect(directResult.errorMessage).toContain(
			"Cursor stream timed out while waiting for the first transport event",
		);
		expect(directEvents.filter(isTerminalEvent)).toHaveLength(1);
		expect(streamCount).toBe(1);
	}, 9_000);

	it("retains a disposed conversation fence until the detached mutation settles", async () => {
		let streamCount = 0;
		const baseUrl = await createCursorServer(stream => {
			streamCount += 1;
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(() => {
				if (streamCount === 1) {
					sendServerMessage(stream, {
						case: "execServerMessage",
						value: create(ExecServerMessageSchema, {
							id: 1,
							message: {
								case: "piWriteArgs",
								value: create(PiWriteExecArgsSchema, { path: "archive.zip:entry.txt", content: "next" }),
							},
						}),
					});
					return;
				}
				sendInteractionUpdate(stream, { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) });
				stream.end(frameConnectMessage(Buffer.from("{}"), CONNECT_END_STREAM_FLAG));
			}, 10);
		});
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const conversationId = "disposed-mutation-lock";
		const first = collectTerminal(baseUrl, {
			conversationId,
			streamIdleTimeoutMs: 40,
			streamFirstEventTimeoutMs: 500,
			execHandlers: {
				piWrite: async call => {
					call.markNonAbortable?.();
					started.resolve();
					await release.promise;
					return {
						role: "toolResult",
						toolCallId: call.toolCallId,
						toolName: "write",
						content: [],
						isError: false,
						timestamp: Date.now(),
					};
				},
			},
		});
		await started.promise;
		await first;
		disposeCursorConversation(conversationId);

		const unrelated = streamCursor({ ...cursorModel, baseUrl }, baseContext, {
			apiKey: "test-token",
			conversationId: "unrelated-conversation",
			streamFirstEventTimeoutMs: 100,
		});
		for await (const _event of unrelated) {
		}
		const unrelatedResult = await unrelated.result();
		expect(unrelatedResult.stopReason).toBe("stop");

		const second = streamCursor({ ...cursorModel, baseUrl }, baseContext, {
			apiKey: "test-token",
			conversationId,
			streamFirstEventTimeoutMs: 40,
		});
		for await (const _event of second) {
		}
		const secondResult = await second.result();
		expect(secondResult.stopReason).toBe("error");
		expect(secondResult.errorMessage).toContain(
			"Cursor stream timed out while waiting for the first transport event",
		);
		expect(streamCount).toBe(2);
		release.resolve();
		await Bun.sleep(10);
	}, 9_000);

	it("caps the fence on caller abort without an unhandled rejection", async () => {
		const controller = new AbortController();
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(
				() =>
					sendServerMessage(stream, {
						case: "execServerMessage",
						value: create(ExecServerMessageSchema, {
							id: 1,
							message: {
								case: "piWriteArgs",
								value: create(PiWriteExecArgsSchema, { path: "archive.zip:entry.txt", content: "next" }),
							},
						}),
					}),
				10,
			);
		});
		const started = Promise.withResolvers<void>();
		try {
			const pending = collectTerminal(baseUrl, {
				signal: controller.signal,
				streamIdleTimeoutMs: 40,
				streamFirstEventTimeoutMs: 500,
				execHandlers: {
					piWrite: async call => {
						call.markNonAbortable?.();
						started.resolve();
						await Promise.withResolvers<never>().promise;
						return {
							role: "toolResult",
							toolCallId: call.toolCallId,
							toolName: "write",
							content: [],
							isError: false,
							timestamp: Date.now(),
						};
					},
				},
			});
			await started.promise;
			// Deadline (160ms) + grace cap (5s) fire while the caller abort
			// defers behind the fence: the terminal must still publish and the
			// race's `exceeded` rejection must never escape as unhandled.
			controller.abort(new Error("caller cancelled stuck mutation"));
			const { events, result } = await pending;
			expect(result.stopReason).toBe("aborted");
			expect(events.filter(isTerminalEvent)).toHaveLength(1);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	}, 9000);

	it("clears the settlement grace timer when a marked mutation settles in time", async () => {
		const controller = new AbortController();
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(
				() =>
					sendServerMessage(stream, {
						case: "execServerMessage",
						value: create(ExecServerMessageSchema, {
							id: 1,
							message: {
								case: "piWriteArgs",
								value: create(PiWriteExecArgsSchema, { path: "archive.zip:entry.txt", content: "next" }),
							},
						}),
					}),
				10,
			);
		});
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const pending = collectTerminal(baseUrl, {
			signal: controller.signal,
			streamIdleTimeoutMs: 40,
			streamFirstEventTimeoutMs: 500,
			execHandlers: {
				piWrite: async call => {
					call.markNonAbortable?.();
					started.resolve();
					await release.promise;
					return {
						role: "toolResult",
						toolCallId: call.toolCallId,
						toolName: "write",
						content: [],
						isError: false,
						timestamp: Date.now(),
					};
				},
			},
		});
		await started.promise;
		controller.abort(new Error("caller cancelled quick write"));
		// Settle inside the grace window: no cap rejection, terminal after settle.
		release.resolve();
		const { events, result } = await pending;
		expect(result.errorMessage).toBe("caller cancelled quick write");
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	});
});
