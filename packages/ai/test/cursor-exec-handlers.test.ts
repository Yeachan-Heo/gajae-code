import { describe, expect, it } from "bun:test";
import {
	buildCursorHistoryForTest,
	buildCursorSystemPromptJsons,
	resolveExecHandler,
	streamCursor,
} from "../src/providers/cursor";
import type { AgentRunRequest } from "../src/providers/cursor/gen/agent_pb";
import type { Context, Model } from "../src/types";

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

function captureCursorPayload(context: Context): Promise<AgentRunRequest> {
	const { promise, resolve, reject } = Promise.withResolvers<AgentRunRequest>();
	streamCursor(cursorModel, context, {
		apiKey: "test-token",
		onPayload: payload => {
			if (isAgentRunRequest(payload)) {
				resolve(payload);
			} else {
				reject(new Error("Cursor payload was not an AgentRunRequest"));
			}
			throw new Error("stop after capturing Cursor payload");
		},
	});
	return promise;
}

function isAgentRunRequest(payload: unknown): payload is AgentRunRequest {
	return !!payload && typeof payload === "object" && "$typeName" in payload;
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
});

describe("Cursor system prompt encoding", () => {
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
