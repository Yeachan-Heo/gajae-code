import { describe, expect, it } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import {
	ANTHROPIC_OMITTED_IMAGE_PLACEHOLDER,
	isAnthropicImageUnprocessableError,
	streamAnthropic,
} from "@gajae-code/ai/providers/anthropic";
import type { AssistantMessage, Context, Model, ProviderSessionState, ToolResultMessage } from "@gajae-code/ai/types";

/**
 * A truncated JPEG (no end-of-image marker) fails local resizing, is forwarded
 * unchanged, and Anthropic answers every request that carries it with
 * `400 Could not process image`. The image is a tool result, so it stays in
 * history: without omission each retry, each fallback model, and each later
 * user prompt resends it and the session is unusable.
 */
const model: Model<"anthropic-messages"> = {
	api: "anthropic-messages",
	provider: "anthropic",
	id: "claude-sonnet-4-6",
	name: "Claude Sonnet 4.6",
	baseUrl: "https://api.anthropic.com",
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 8_192,
	contextWindow: 200_000,
	reasoning: false,
};

/** Rejection body captured from the API for the truncated JPEG. */
const IMAGE_REJECTION =
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"Could not process image"},"request_id":"req_011Cg5dJvecx1fDDZChLHTPM"}';

const BAD_IMAGE = Buffer.from("bad image payload").toBase64();
const OLD_IMAGE = Buffer.from("older healthy image").toBase64();

type MockRequest = {
	withResponse(): Promise<{
		data: AsyncIterable<Record<string, unknown>>;
		response: Response;
		request_id: string | null;
	}>;
};

function rejecting(): MockRequest {
	return {
		async withResponse(): Promise<never> {
			const error = new Error(IMAGE_REJECTION);
			(error as { status?: number }).status = 400;
			throw error;
		},
	};
}

function succeeding(): MockRequest {
	const response = new Response(null, { status: 200, headers: { "request-id": "req_ok" } });
	const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
	const events: Record<string, unknown>[] = [
		{ type: "message_start", message: { id: "msg_ok", usage } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "recovered" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
		{ type: "message_stop" },
	];
	return {
		async withResponse() {
			return {
				data: {
					async *[Symbol.asyncIterator]() {
						for (const event of events) yield event;
					},
				},
				response,
				request_id: "req_ok",
			};
		},
	};
}

/** Rejects any body that still carries BAD_IMAGE, accepts the rest. */
function imageAwareClient(bodies: string[]): Anthropic {
	const create = ((body: unknown) => {
		const serialized = JSON.stringify(body);
		bodies.push(serialized);
		return (serialized.includes(BAD_IMAGE) ? rejecting() : succeeding()) as never;
	}) as unknown as Anthropic["messages"]["create"];
	return { messages: { create } } as Anthropic;
}

function assistantCall(id: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.jpg` } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function imageResult(id: string, data: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [
			{ type: "text", text: "Read image file [image/jpeg]" },
			{ type: "image", data, mimeType: "image/jpeg" },
		],
		isError: false,
		timestamp: Date.now(),
	};
}

function contextWithImages(...followUps: string[]): Context {
	return {
		messages: [
			{ role: "user", content: "look at these", timestamp: Date.now() },
			assistantCall("toolu_old"),
			imageResult("toolu_old", OLD_IMAGE),
			assistantCall("toolu_bad"),
			imageResult("toolu_bad", BAD_IMAGE),
			...followUps.map(text => ({ role: "user" as const, content: text, timestamp: Date.now() })),
		],
	};
}

describe("Anthropic unprocessable image recovery", () => {
	it("classifies only the image rejection", () => {
		expect(isAnthropicImageUnprocessableError(Object.assign(new Error(IMAGE_REJECTION), { status: 400 }))).toBe(true);
		expect(
			isAnthropicImageUnprocessableError(
				Object.assign(new Error('400 {"error":{"type":"invalid_request_error","message":"prompt is too long"}}'), {
					status: 400,
				}),
			),
		).toBe(false);
		expect(
			isAnthropicImageUnprocessableError(Object.assign(new Error("Could not process image"), { status: 500 })),
		).toBe(false);
	});

	it("unmanaged: resends once without the newest image and keeps older images", async () => {
		const bodies: string[] = [];
		const result = await streamAnthropic(model, contextWithImages(), {
			client: imageAwareClient(bodies),
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(bodies).toHaveLength(2);
		expect(bodies[1]).not.toContain(BAD_IMAGE);
		expect(bodies[1]).toContain(OLD_IMAGE);
		expect(bodies[1]).toContain(ANTHROPIC_OMITTED_IMAGE_PLACEHOLDER);
	});

	it("managed: surfaces the rejection once, then the next attempt and later turns omit the image", async () => {
		const bodies: string[] = [];
		const client = imageAwareClient(bodies);
		const providerSessionState = new Map<string, ProviderSessionState>();

		const first = await streamAnthropic(model, contextWithImages(), {
			client,
			fallbackManaged: true,
			providerSessionState,
		}).result();
		// The fallback controller owns retries: no resend inside a managed attempt.
		expect(first.stopReason).toBe("error");
		expect(bodies).toHaveLength(1);

		const retry = await streamAnthropic(model, contextWithImages(), {
			client,
			fallbackManaged: true,
			providerSessionState,
		}).result();
		expect(retry.stopReason).toBe("stop");
		expect(bodies[1]).not.toContain(BAD_IMAGE);
		expect(bodies[1]).toContain(OLD_IMAGE);

		// The rejected image is still in history on the next user prompt.
		const nextTurn = await streamAnthropic(model, contextWithImages("dan.kimhaejun gh계정에서 관리중인데"), {
			client,
			fallbackManaged: true,
			providerSessionState,
		}).result();
		expect(nextTurn.stopReason).toBe("stop");
		expect(bodies).toHaveLength(3);
		expect(bodies[2]).not.toContain(BAD_IMAGE);
	});

	it("escalates to every image when the newest one was not the culprit, then stops", async () => {
		const bodies: string[] = [];
		const create = ((body: unknown) => {
			bodies.push(JSON.stringify(body));
			return rejecting() as never;
		}) as unknown as Anthropic["messages"]["create"];
		const result = await streamAnthropic(model, contextWithImages(), {
			client: { messages: { create } } as Anthropic,
		}).result();

		expect(result.stopReason).toBe("error");
		// original, newest omitted, all omitted; no further image repair
		expect(bodies.length).toBeGreaterThanOrEqual(3);
		expect(bodies[1]).not.toContain(BAD_IMAGE);
		expect(bodies[1]).toContain(OLD_IMAGE);
		expect(bodies[2]).not.toContain(OLD_IMAGE);
		for (const body of bodies.slice(3)) expect(body).toBe(bodies[2]);
	});
});
