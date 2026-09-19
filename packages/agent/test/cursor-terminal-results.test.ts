import { expect, it, vi } from "bun:test";
import http2 from "node:http2";
import { create, toBinary } from "@bufbuild/protobuf";
import { Agent, type AgentEvent } from "@gajae-code/agent-core";
import { type Model, streamSimple, z } from "@gajae-code/ai";
import {
	AgentServerMessageSchema,
	ExecServerMessageSchema,
	PiWriteExecArgsSchema,
} from "@gajae-code/ai/providers/cursor/gen/agent_pb";

it("keeps completed Cursor results once through the real agent loop after a transport abort", async () => {
	const server = http2.createServer();
	const sessions = new Set<http2.ServerHttp2Session>();
	server.on("session", session => {
		sessions.add(session);
		session.on("error", () => {});
	});
	const connect = http2.connect;
	let client: http2.ClientHttp2Session | undefined;
	const spy = vi.spyOn(http2, "connect").mockImplementation(((authority, options) => {
		client = typeof options === "function" ? connect(authority, options) : connect(authority, options ?? {});
		return client;
	}) as typeof http2.connect);
	server.on("stream", (peer: http2.ServerHttp2Stream) => {
		peer.on("error", () => {});
		peer.respond({ ":status": 200, "content-type": "application/connect+proto" });
		const bytes = toBinary(
			AgentServerMessageSchema,
			create(AgentServerMessageSchema, {
				message: {
					case: "execServerMessage",
					value: create(ExecServerMessageSchema, {
						id: 1,
						message: {
							case: "piWriteArgs",
							value: create(PiWriteExecArgsSchema, { path: "fixture.txt", content: "once" }),
						},
					}),
				},
			}),
		);
		const frame = Buffer.alloc(bytes.length + 5);
		frame.writeUInt32BE(bytes.length, 1);
		frame.set(bytes, 5);
		peer.write(frame);
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing local address");
	const model: Model = {
		id: "cursor-composer-2.5",
		name: "Cursor",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: `http://127.0.0.1:${address.port}`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 1000,
	};
	let providerWrites = 0;
	let localWrites = 0;
	let requests = 0;
	const events: AgentEvent[] = [];
	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: ["test"],
			messages: [],
			tools: [
				{
					name: "write",
					label: "write",
					description: "write",
					parameters: z.object({}),
					execute: async () => {
						localWrites++;
						return { content: [] };
					},
				},
			],
		},
		cursorExecHandlers: {
			piWrite: async call => {
				providerWrites++;
				return {
					role: "toolResult",
					toolCallId: call.toolCallId,
					toolName: "write",
					content: [{ type: "text", text: "completed once" }],
					isError: false,
					timestamp: Date.now(),
				};
			},
		},
		cursorOnToolResult: async result => {
			setTimeout(() => client?.destroy(), 10);
			return result;
		},
		streamFn: (selected, context, options) => {
			requests++;
			return streamSimple(selected, context, {
				...options,
				apiKey: "local-test-key",
				streamFirstEventTimeoutMs: 10000,
			});
		},
	});
	agent.subscribe(event => events.push(event));
	try {
		await agent.prompt("write once");
		const results = agent.state.messages.filter(message => message.role === "toolResult");
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ isError: false, content: [{ type: "text", text: "completed once" }] });
		expect(providerWrites).toBe(1);
		expect(localWrites).toBe(0);
		expect(requests).toBe(1);
		expect(events.filter(event => event.type === "tool_execution_end" && event.isError)).toHaveLength(0);
		expect(agent.state.messages.some(message => message.role === "assistant" && message.stopReason === "error")).toBe(
			true,
		);
	} finally {
		spy.mockRestore();
		client?.destroy();
		for (const session of sessions) session.destroy();
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		await closed.promise;
	}
}, 15000);
