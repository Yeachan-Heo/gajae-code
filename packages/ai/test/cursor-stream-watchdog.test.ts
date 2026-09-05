import { afterEach, describe, expect, it, vi } from "bun:test";
import * as http2 from "node:http2";
import { create, toBinary } from "@bufbuild/protobuf";
import {
	createCursorMessageQueueForTest,
	cursorExecDeadlineMsForTest,
	waitForCursorWritesForTest,
	writeCursorFrameForTest,
} from "../src/providers/cursor";
import type { AgentServerMessage, InteractionUpdate } from "../src/providers/cursor/gen/agent_pb";
import {
	AgentServerMessageSchema,
	ConversationStateStructureSchema,
	ConversationTokenDetailsSchema,
	ExecServerAbortSchema,
	ExecServerControlMessageSchema,
	ExecServerMessageSchema,
	HeartbeatUpdateSchema,
	InteractionQuerySchema,
	InteractionUpdateSchema,
	PiReadExecArgsSchema,
	PiWriteExecArgsSchema,
	TextDeltaUpdateSchema,
	TokenDeltaUpdateSchema,
	TurnEndedUpdateSchema,
	WebSearchRequestQuerySchema,
} from "../src/providers/cursor/gen/agent_pb";
import { stream as streamModel, streamSimple } from "../src/stream";
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
		onPayload?: () => Promise<unknown>;
	},
): Promise<{ events: unknown[]; result: AssistantMessage }> {
	const stream = streamModel({ ...cursorModel, baseUrl }, baseContext, { apiKey: "test-token", ...options });
	const events: unknown[] = [];
	for await (const event of stream) events.push(event);
	return { events, result: await stream.result() };
}

async function collectSimpleTerminal(
	baseUrl: string,
	options: {
		streamFirstEventTimeoutMs?: number;
		streamIdleTimeoutMs?: number;
		signal?: AbortSignal;
	},
): Promise<{ events: unknown[]; result: AssistantMessage }> {
	const stream = streamSimple({ ...cursorModel, baseUrl }, baseContext, { apiKey: "test-token", ...options });
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
	it("bounds a payload hook that never settles by the first-event deadline", async () => {
		const never = Promise.withResolvers<unknown>();
		const { events, result } = await collectTerminal("http://127.0.0.1:1", {
			streamFirstEventTimeoutMs: 10,
			onPayload: () => never.promise,
		});

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("first transport event");
		expect(result.transportFailure).toMatchObject({
			kind: "transport",
			providerCode: "stream_first_event_timeout",
			requestBytes: 0,
			firstEventTimeoutMs: 10,
		});
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	});

	it("aborts a synchronously cancelled payload hook when the first-event watchdog is disabled", async () => {
		const controller = new AbortController();
		const never = Promise.withResolvers<unknown>();
		const { events, result } = await collectTerminal("http://127.0.0.1:1", {
			signal: controller.signal,
			streamFirstEventTimeoutMs: 0,
			onPayload: () => {
				controller.abort(new Error("payload hook cancelled"));
				return never.promise;
			},
		});

		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("payload hook cancelled");
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	});

	it("keeps the normal exec budget when transport idle watching is disabled", () => {
		expect(cursorExecDeadlineMsForTest(undefined)).toBe(480_000);
		expect(cursorExecDeadlineMsForTest(0)).toBe(480_000);
		expect(cursorExecDeadlineMsForTest(120_000)).toBe(480_000);
	});

	it("preserves streamSimple first-event and disabled-idle watchdog overrides", async () => {
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		});
		const controller = new AbortController();
		const pending = collectSimpleTerminal(baseUrl, {
			signal: controller.signal,
			streamFirstEventTimeoutMs: 5,
			streamIdleTimeoutMs: 0,
		});
		let timedOut = false;
		const outcome = await Promise.race([
			pending,
			Bun.sleep(250).then(() => {
				timedOut = true;
				controller.abort(new Error("streamSimple watchdog test timed out"));
				return undefined;
			}),
		]);
		if (!outcome) await pending;
		expect(timedOut).toBe(false);
		expect(outcome?.result.stopReason).toBe("error");
		expect(outcome?.result.errorMessage).toContain("first transport event");
	});

	it("preserves a streamSimple idle watchdog override", async () => {
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(
				() =>
					sendServerMessage(stream, {
						case: "interactionUpdate",
						value: create(InteractionUpdateSchema, {
							message: { case: "heartbeat", value: create(HeartbeatUpdateSchema, {}) },
						}),
					}),
				10,
			);
		});
		const controller = new AbortController();
		const pending = collectSimpleTerminal(baseUrl, {
			signal: controller.signal,
			streamFirstEventTimeoutMs: 500,
			streamIdleTimeoutMs: 5,
		});
		let timedOut = false;
		const outcome = await Promise.race([
			pending,
			Bun.sleep(250).then(() => {
				timedOut = true;
				controller.abort(new Error("streamSimple idle watchdog test timed out"));
				return undefined;
			}),
		]);
		if (!outcome) await pending;
		expect(timedOut).toBe(false);
		expect(outcome?.result.stopReason).toBe("error");
		expect(outcome?.result.errorMessage).toContain("stalled");
	});

	it("does not reserve detached-mutation capacity for ordinary execs", async () => {
		const serverStreams: http2.ServerHttp2Stream[] = [];
		const release = Promise.withResolvers<void>();
		const allStarted = Promise.withResolvers<void>();
		let executions = 0;
		const execFrame = buildServerMessageFrame({
			case: "execServerMessage",
			value: create(ExecServerMessageSchema, {
				id: 1,
				message: { case: "piReadArgs", value: create(PiReadExecArgsSchema, { path: "/tmp/quota" }) },
			}),
		});
		const turnEndedFrame = buildServerMessageFrame({
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
			}),
		});
		const endFrame = frameConnectMessage(new Uint8Array(), CONNECT_END_STREAM_FLAG);
		const baseUrl = await createCursorServer(stream => {
			serverStreams.push(stream);
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(() => stream.write(execFrame), 10);
		});
		const pending = Array.from({ length: 65 }, (_, index) =>
			collectTerminal(baseUrl, {
				conversationId: `ordinary-exec-quota-${index}`,
				streamFirstEventTimeoutMs: 500,
				streamIdleTimeoutMs: 500,
				execHandlers: {
					piRead: async call => {
						executions += 1;
						if (executions === 65) allStarted.resolve();
						await release.promise;
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
			}),
		);
		const endStreams = (): void => {
			release.resolve();
			for (const stream of serverStreams) {
				if (!stream.closed && !stream.destroyed) stream.end(Buffer.concat([turnEndedFrame, endFrame]));
			}
		};
		try {
			const admitted = await Promise.race([allStarted.promise.then(() => true), Bun.sleep(2_000).then(() => false)]);
			expect(admitted).toBe(true);
			endStreams();
			await Promise.all(pending);
			expect(executions).toBe(65);
		} finally {
			endStreams();
		}
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

	it("drops a response when request closure wins the bounded fence write race", () => {
		let closed = false;
		let closeDuringWrite = false;
		let writeCount = 0;
		const request = {
			get closed() {
				return closed;
			},
			get destroyed() {
				return closed;
			},
			get writableEnded() {
				return closed;
			},
			get writableFinished() {
				return closed;
			},
			write() {
				writeCount += 1;
				if (closeDuringWrite) {
					closed = true;
					const error = new Error("write after end") as NodeJS.ErrnoException;
					error.code = "ERR_STREAM_WRITE_AFTER_END";
					throw error;
				}
				return true;
			},
		} as unknown as http2.ClientHttp2Stream;

		expect(writeCursorFrameForTest(request, Buffer.from("first"))).toBe(true);
		closeDuringWrite = true;
		expect(writeCursorFrameForTest(request, Buffer.from("late"))).toBe(false);
		expect(writeCount).toBe(2);
	});

	it("waits for accepted outbound frames before successful request teardown", async () => {
		const listeners = new Map<string, Set<() => void>>();
		let writeCompletion: (() => void) | undefined;
		const request = {
			closed: false,
			destroyed: false,
			writableEnded: false,
			writableFinished: false,
			once(event: string, listener: () => void) {
				const eventListeners = listeners.get(event) ?? new Set<() => void>();
				eventListeners.add(listener);
				listeners.set(event, eventListeners);
				return this;
			},
			removeListener(event: string, listener: () => void) {
				listeners.get(event)?.delete(listener);
				return this;
			},
			write(_frame: Uint8Array, callback: () => void) {
				writeCompletion = callback;
				return true;
			},
		} as unknown as http2.ClientHttp2Stream;

		expect(writeCursorFrameForTest(request, Buffer.from("response"))).toBe(true);
		let settled = false;
		const wait = waitForCursorWritesForTest(request).then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		writeCompletion?.();
		await wait;
		expect(settled).toBe(true);
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

	it("accepts a valid Connect frame larger than 4 KiB within the protocol bound", async () => {
		const largeText = "x".repeat(5_000);
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			const textFrame = buildServerMessageFrame({
				case: "interactionUpdate",
				value: create(InteractionUpdateSchema, {
					message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text: largeText }) },
				}),
			});
			const terminalFrame = buildServerMessageFrame({
				case: "interactionUpdate",
				value: create(InteractionUpdateSchema, {
					message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
				}),
			});
			stream.end(
				Buffer.concat([textFrame, terminalFrame, frameConnectMessage(Buffer.from("{}"), CONNECT_END_STREAM_FLAG)]),
			);
		});

		const { result } = await collectTerminal(baseUrl, {
			streamFirstEventTimeoutMs: 100,
			streamIdleTimeoutMs: 100,
		});

		expect(result.stopReason).toBe("stop");
		expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: largeText }));
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

	it("drains a coalesced pre-boundary exec before valid Connect end-stream", async () => {
		let executions = 0;
		const releaseExec = Promise.withResolvers<void>();
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			const exec = buildServerMessageFrame({
				case: "execServerMessage",
				value: create(ExecServerMessageSchema, {
					id: 1,
					message: { case: "piReadArgs", value: create(PiReadExecArgsSchema, { path: "before.txt" }) },
				}),
			});
			const turnEnded = buildServerMessageFrame({
				case: "interactionUpdate",
				value: create(InteractionUpdateSchema, {
					message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
				}),
			});
			stream.end(Buffer.concat([exec, turnEnded, frameConnectMessage(Buffer.from("{}"), CONNECT_END_STREAM_FLAG)]));
		});
		setTimeout(() => releaseExec.resolve(), 20);

		const { result } = await collectTerminal(baseUrl, {
			streamFirstEventTimeoutMs: 100,
			streamIdleTimeoutMs: 100,
			execHandlers: {
				piRead: async call => {
					executions += 1;
					await releaseExec.promise;
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
		expect(result.errorMessage).toBeUndefined();
		expect(result.stopReason).toBe("stop");
		expect(executions).toBe(1);
	});

	it("drops a malformed frame coalesced after turnEnded", async () => {
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(() => {
				const text = buildServerMessageFrame({
					case: "interactionUpdate",
					value: create(InteractionUpdateSchema, {
						message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text: "validated" }) },
					}),
				});
				const malformedTail = frameConnectMessage(new Uint8Array([0x80]));
				stream.end(
					Buffer.concat([
						text,
						buildServerMessageFrame({
							case: "interactionUpdate",
							value: create(InteractionUpdateSchema, {
								message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
							}),
						}),
						malformedTail,
					]),
				);
			}, 10);
		});

		const { events, result } = await collectTerminal(baseUrl, {
			streamFirstEventTimeoutMs: 100,
			streamIdleTimeoutMs: 100,
		});

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "validated" }));
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	});

	it("drops an oversized header coalesced after turnEnded", async () => {
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(() => {
				const oversizedTail = Buffer.alloc(5);
				oversizedTail.writeUInt32BE(16 * 1024 * 1024 + 1, 1);
				stream.end(
					Buffer.concat([
						buildServerMessageFrame({
							case: "interactionUpdate",
							value: create(InteractionUpdateSchema, {
								message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
							}),
						}),
						oversizedTail,
					]),
				);
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

	it("rejects a valid Connect end-stream before turnEnded", async () => {
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(() => stream.end(frameConnectMessage(Buffer.from("{}"), CONNECT_END_STREAM_FLAG)), 10);
		});

		const { events, result } = await collectTerminal(baseUrl, {
			streamFirstEventTimeoutMs: 100,
			streamIdleTimeoutMs: 100,
		});

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Cursor HTTP/2 stream ended before turnEnded");
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

	it("seals exec admission at raw EOF without dispatching coalesced trailing execs", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let executions = 0;
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(() => {
				const first = buildServerMessageFrame({
					case: "execServerMessage",
					value: create(ExecServerMessageSchema, {
						id: 1,
						message: { case: "piReadArgs", value: create(PiReadExecArgsSchema, { path: "/tmp/first" }) },
					}),
				});
				const second = buildServerMessageFrame({
					case: "execServerMessage",
					value: create(ExecServerMessageSchema, {
						id: 2,
						message: { case: "piReadArgs", value: create(PiReadExecArgsSchema, { path: "/tmp/second" }) },
					}),
				});
				stream.end(Buffer.concat([first, second]));
			}, 10);
		});

		const pending = collectTerminal(baseUrl, {
			streamFirstEventTimeoutMs: 500,
			streamIdleTimeoutMs: 200,
			execHandlers: {
				piRead: async call => {
					executions += 1;
					started.resolve();
					await release.promise;
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
		await started.promise;
		await Bun.sleep(20);
		release.resolve();
		const { events, result } = await pending;

		expect(executions).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Cursor HTTP/2 stream ended before turnEnded");
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	});

	it("keeps turnEnded bookkeeping while dropping an exec coalesced after it", async () => {
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
				const trailingExec = buildServerMessageFrame({
					case: "execServerMessage",
					value: create(ExecServerMessageSchema, {
						id: 1,
						message: { case: "piReadArgs", value: create(PiReadExecArgsSchema, { path: "/tmp/late" }) },
					}),
				});
				stream.end(Buffer.concat([turnEnded, trailingExec]));
			}, 10);
		});

		const { events, result } = await collectTerminal(baseUrl, {
			streamFirstEventTimeoutMs: 500,
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

		expect(executions).toBe(0);
		expect(result.stopReason).toBe("stop");
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	});

	it("drains a held exec when a coalesced late exec follows turnEnded", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let executions = 0;
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(() => {
				const prefix = buildServerMessageFrame({
					case: "interactionUpdate",
					value: create(InteractionUpdateSchema, {
						message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text: "validated prefix" }) },
					}),
				});
				const heldExec = buildServerMessageFrame({
					case: "execServerMessage",
					value: create(ExecServerMessageSchema, {
						id: 1,
						message: { case: "piReadArgs", value: create(PiReadExecArgsSchema, { path: "/tmp/held" }) },
					}),
				});
				const turnEnded = buildServerMessageFrame({
					case: "interactionUpdate",
					value: create(InteractionUpdateSchema, {
						message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
					}),
				});
				const lateExec = buildServerMessageFrame({
					case: "execServerMessage",
					value: create(ExecServerMessageSchema, {
						id: 2,
						message: { case: "piReadArgs", value: create(PiReadExecArgsSchema, { path: "/tmp/late" }) },
					}),
				});
				stream.end(Buffer.concat([prefix, heldExec, turnEnded, lateExec, Buffer.from([0, 1, 2])]));
			}, 10);
		});

		const pending = collectTerminal(baseUrl, {
			streamFirstEventTimeoutMs: 500,
			streamIdleTimeoutMs: 100,
			execHandlers: {
				piRead: async call => {
					executions += 1;
					started.resolve();
					await release.promise;
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
		await started.promise;
		release.resolve();
		const { events, result } = await pending;

		expect(executions).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "validated prefix" }));
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
			setTimeout(
				() =>
					sendServerMessage(stream, {
						case: "conversationCheckpointUpdate",
						value: create(ConversationStateStructureSchema, {
							tokenDetails: create(ConversationTokenDetailsSchema, { usedTokens: 29 }),
						}),
					}),
				30,
			);
		});

		const { events, result } = await collectTerminal(baseUrl, {
			streamFirstEventTimeoutMs: 50,
			streamIdleTimeoutMs: 50,
		});

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("stream stalled while waiting for the next event");
		expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "partial" }));
		expect(result.usage.input).toBe(20);
		expect(result.usage.output).toBe(9);
		expect(result.usage.totalTokens).toBe(29);
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

	it("does not refresh the watchdog for unhandled control envelopes", async () => {
		let controlTimer: NodeJS.Timeout | undefined;
		const baseUrl = await createCursorServer(stream => {
			stream.on("error", () => {});
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(() => {
				sendInteractionUpdate(stream, {
					case: "heartbeat",
					value: create(HeartbeatUpdateSchema, {}),
				});
				controlTimer = setInterval(() => {
					sendServerMessage(stream, {
						case: "execServerControlMessage",
						value: create(ExecServerControlMessageSchema, {
							message: { case: "abort", value: create(ExecServerAbortSchema, { id: 1 }) },
						}),
					});
				}, 5);
			}, 5);
			stream.on("close", () => {
				if (controlTimer) clearInterval(controlTimer);
			});
		});

		const { events, result } = await collectTerminal(baseUrl, {
			streamFirstEventTimeoutMs: 100,
			streamIdleTimeoutMs: 30,
		});

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("stream stalled while waiting for the next event");
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	});

	it("does not refresh the watchdog for unhandled interaction queries", async () => {
		let queryTimer: NodeJS.Timeout | undefined;
		const baseUrl = await createCursorServer(stream => {
			stream.on("error", () => {});
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(() => {
				sendInteractionUpdate(stream, {
					case: "heartbeat",
					value: create(HeartbeatUpdateSchema, {}),
				});
				queryTimer = setInterval(() => {
					sendServerMessage(stream, {
						case: "interactionQuery",
						value: create(InteractionQuerySchema, {
							query: { case: "webSearchRequestQuery", value: create(WebSearchRequestQuerySchema, {}) },
						}),
					});
				}, 5);
			}, 5);
			stream.on("close", () => {
				if (queryTimer) clearInterval(queryTimer);
			});
		});

		const { events, result } = await collectTerminal(baseUrl, {
			streamFirstEventTimeoutMs: 100,
			streamIdleTimeoutMs: 30,
		});

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("stream stalled while waiting for the next event");
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
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
			streamFirstEventTimeoutMs: 500,
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
		const streamReady = Promise.withResolvers<void>();
		const baseUrl = await createCursorServer(stream => {
			serverStream = stream;
			streamReady.resolve();
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

		const pending = collectTerminal(baseUrl, {
			streamIdleTimeoutMs: 40,
			streamFirstEventTimeoutMs: 200,
			execHandlers: { piRead: async () => neverSettles.promise },
		});
		await streamReady.promise;
		const concatSpy = vi.spyOn(Buffer, "concat");
		const { result } = await pending;

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Cursor local exec exceeded its 160ms deadline");
		const providerConcats = concatSpy.mock.calls.filter(call => Array.isArray(call[0]) && call[0].length === 2);
		expect(providerConcats).toHaveLength(0);

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

	it("keeps a non-zero gRPC trailer authoritative after turnEnded", async () => {
		const baseUrl = await createCursorServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" }, { waitForTrailers: true });
			stream.on("wantTrailers", () => {
				stream.sendTrailers({ "grpc-status": "13", "grpc-message": "late%20failure" });
			});
			setTimeout(() => {
				sendInteractionUpdate(stream, {
					case: "turnEnded",
					value: create(TurnEndedUpdateSchema, {}),
				});
				stream.end();
			}, 10);
		});

		const { events, result } = await collectTerminal(baseUrl, {
			streamIdleTimeoutMs: 100,
			streamFirstEventTimeoutMs: 500,
		});
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("gRPC error 13: late failure");
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

	it("aborts an active exec when the request is reset", async () => {
		const observed = Promise.withResolvers<AbortSignal | undefined>();
		const baseUrl = await createCursorServer(stream => {
			stream.on("error", () => {});
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(() => {
				sendServerMessage(stream, {
					case: "execServerMessage",
					value: create(ExecServerMessageSchema, {
						id: 1,
						message: { case: "piReadArgs", value: create(PiReadExecArgsSchema, { path: "/tmp/reset" }) },
					}),
				});
				setTimeout(() => stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR), 10);
			}, 10);
		});

		const pending = collectTerminal(baseUrl, {
			streamFirstEventTimeoutMs: 500,
			streamIdleTimeoutMs: 100,
			execHandlers: {
				piRead: call => {
					observed.resolve(call.signal);
					return Promise.withResolvers<never>().promise;
				},
			},
		});
		const signal = await observed.promise;
		const { events, result } = await pending;

		expect(signal?.aborted).toBe(true);
		expect(result.stopReason).toBe("error");
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	});

	it("rejects a non-abortable mark that arrives after transport terminalization", async () => {
		const baseUrl = await createCursorServer(stream => {
			stream.on("error", () => {});
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(() => {
				sendServerMessage(stream, {
					case: "execServerMessage",
					value: create(ExecServerMessageSchema, {
						id: 1,
						message: {
							case: "piWriteArgs",
							value: create(PiWriteExecArgsSchema, { path: "archive.zip:late.txt", content: "late" }),
						},
					}),
				});
				setTimeout(() => stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR), 10);
			}, 10);
		});
		const lateMarkRejected = Promise.withResolvers<void>();
		const pending = collectTerminal(baseUrl, {
			streamIdleTimeoutMs: 100,
			streamFirstEventTimeoutMs: 500,
			execHandlers: {
				piWrite: async call => {
					await Bun.sleep(40);
					try {
						call.markNonAbortable?.();
					} catch {
						lateMarkRejected.resolve();
					}
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

		await lateMarkRejected.promise;
		const { events, result } = await pending;
		expect(result.stopReason).toBe("error");
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

	it("keeps caller-abort priority when a transport failure is already fenced", async () => {
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const baseUrl = await createCursorServer(stream => {
			stream.on("error", () => {});
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			setTimeout(() => {
				sendServerMessage(stream, {
					case: "execServerMessage",
					value: create(ExecServerMessageSchema, {
						id: 1,
						message: {
							case: "piWriteArgs",
							value: create(PiWriteExecArgsSchema, { path: "archive.zip:priority.txt", content: "next" }),
						},
					}),
				});
				setTimeout(() => stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR), 10);
			}, 10);
		});

		const pending = collectTerminal(baseUrl, {
			signal: controller.signal,
			streamFirstEventTimeoutMs: 500,
			streamIdleTimeoutMs: 100,
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
		await Bun.sleep(30);
		controller.abort(new Error("caller wins transport reset"));
		release.resolve();
		const { events, result } = await pending;

		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("caller wins transport reset");
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	});

	it("publishes a caller-abort terminal after a marked mutation settles", async () => {
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
		release.resolve();
		const { events, result } = await pending;
		expect(result.errorMessage).toBe("caller cancelled quick write");
		expect(events.filter(isTerminalEvent)).toHaveLength(1);
	});

	it("does not resume frame admission before queued work decrements pending", async () => {
		const queue = createCursorMessageQueueForTest();
		const completed = queue.enqueue(() => undefined);
		await completed;
		expect(queue.pending()).toBe(0);
	});
});
