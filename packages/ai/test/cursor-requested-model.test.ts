import { describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { disposeCursorConversation, resolveCursorWireModelForTest, streamCursor } from "../src/providers/cursor";
import {
	type AgentClientMessage,
	AgentClientMessageSchema,
	type AgentRunRequest,
	AgentServerMessageSchema,
	InteractionUpdateSchema,
	TurnEndedUpdateSchema,
} from "../src/providers/cursor/gen/agent_pb";
import type { AssistantMessageEvent, Context, Model } from "../src/types";

const baseCursorModel: Model<"cursor-agent"> = {
	id: "cursor-composer-2.5",
	name: "Cursor Composer 2.5",
	api: "cursor-agent",
	provider: "cursor",
	baseUrl: "https://api2.cursor.sh",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
};

function cursorModel(id: string): Model<"cursor-agent"> {
	return { ...baseCursorModel, id, name: id };
}

function frameServerTurnEnded(): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
			}),
		},
	});
	const bytes = toBinary(AgentServerMessageSchema, message);
	const frame = Buffer.alloc(5 + bytes.length);
	frame.writeUInt32BE(bytes.length, 1);
	frame.set(bytes, 5);
	return frame;
}

function decodeRunRequest(chunks: Buffer[]): AgentRunRequest | undefined {
	const frame = Buffer.concat(chunks);
	if (frame.length < 5) return undefined;
	const length = frame.readUInt32BE(1);
	if (frame.length < 5 + length) return undefined;
	const message: AgentClientMessage = fromBinary(AgentClientMessageSchema, frame.subarray(5, 5 + length));
	return message.message.case === "runRequest" ? message.message.value : undefined;
}

async function captureCursorRequest(model: Model<"cursor-agent">): Promise<AgentRunRequest> {
	const server = http2.createServer();
	let dispatchCount = 0;
	let captured: AgentRunRequest | undefined;
	server.on("stream", (stream: http2.ServerHttp2Stream) => {
		dispatchCount++;
		stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		const chunks: Buffer[] = [];
		stream.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
			const request = decodeRunRequest(chunks);
			if (!request || captured) return;
			captured = request;
			stream.end(frameServerTurnEnded());
		});
	});
	const serverListening = Promise.withResolvers<void>();
	server.once("error", serverListening.reject);
	server.listen(0, "127.0.0.1", serverListening.resolve);
	await serverListening.promise;

	const conversationId = `requested-model-${crypto.randomUUID()}`;
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected TCP server address");
		const events: AssistantMessageEvent[] = [];
		for await (const event of streamCursor(
			{ ...model, baseUrl: `http://127.0.0.1:${address.port}` },
			{
				messages: [{ role: "user", content: "capture this request", timestamp: 0 }],
			} satisfies Context,
			{ apiKey: "test-token", conversationId },
		)) {
			events.push(event);
		}
		const terminalError = events.find(event => event.type === "error");
		if (terminalError?.type === "error") throw new Error(terminalError.error.errorMessage);
		expect(dispatchCount).toBe(1);
		if (!captured) throw new Error("Expected encoded Cursor run request");
		return captured;
	} finally {
		disposeCursorConversation(conversationId);
		const serverClosed = Promise.withResolvers<void>();
		server.close(error => (error ? serverClosed.reject(error) : serverClosed.resolve()));
		await serverClosed.promise;
	}
}

describe("Cursor requested model wire translation", () => {
	it.each([
		[
			"gpt-5.4-mini-low",
			{ modelId: "gpt-5.4-mini", parameters: [{ id: "reasoning", value: "low" }], translated: true },
		],
		[
			"gpt-5.6-sol-high",
			{ modelId: "gpt-5.6-sol", parameters: [{ id: "reasoning", value: "high" }], translated: true },
		],
		[
			"gpt-5.6-sol-xhigh-fast",
			{
				modelId: "gpt-5.6-sol-fast",
				parameters: [{ id: "reasoning", value: "xhigh" }],
				translated: true,
			},
		],
		[
			"gpt-5.1-codex-max-high",
			{ modelId: "gpt-5.1-codex-max", parameters: [{ id: "reasoning", value: "high" }], translated: true },
		],
	])("translates %s to Cursor requestedModel fields", (id, expected) => {
		const resolved = resolveCursorWireModelForTest(cursorModel(id));
		expect({
			modelId: resolved.modelId,
			parameters: resolved.parameters.map(parameter => ({ id: parameter.id, value: parameter.value })),
			translated: resolved.translated,
		}).toEqual(expected);
	});

	it.each([
		"gpt-5.6-sol-fast",
		"gpt-5.6-sol",
		"gpt-5.6-sol-none",
		"gpt-5.6-sol-none-fast",
		"gpt-5.1-codex-max",
		"gpt-5.1-codex-max-fast",
		"native",
		"claude-sonnet-4-5",
	])("passes through %s without a requested model translation", id => {
		const resolved = resolveCursorWireModelForTest(cursorModel(id));
		expect({
			modelId: resolved.modelId,
			parameters: resolved.parameters.map(parameter => ({ id: parameter.id, value: parameter.value })),
			translated: resolved.translated,
		}).toEqual({
			modelId: id,
			parameters: [],
			translated: false,
		});
	});

	it.each([
		"gpt-5.6-sol-fast",
		"gpt-5.6-sol",
		"gpt-5.6-sol-none",
		"gpt-5.1-codex-max",
		"native",
		"claude-sonnet-4-5",
	])("omits requestedModel from the captured AgentRunRequest for native/pass-through %s", async id => {
		const payload = await captureCursorRequest(cursorModel(id));
		expect(payload.modelDetails?.modelId).toBe(id);
		expect(payload.requestedModel).toBeUndefined();
	});
});
