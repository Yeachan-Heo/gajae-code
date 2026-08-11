import { describe, expect, it } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { streamAnthropic } from "@gajae-code/ai/providers/anthropic";
import type { AssistantMessage, Context, Model, ProviderSessionState, UserMessage } from "@gajae-code/ai/types";

/**
 * Issue #4262: the coding-agent drives every turn through `fallbackManaged`
 * prompts, and the provider's whole thinking-replay repair sits behind
 * `!options?.fallbackManaged`. A deterministic thinking rejection therefore
 * never degraded the replay in the shipping CLI: each turn rebuilt the same
 * body from the same history, the API rejected it identically, and the session
 * burned one 400 per turn forever (measured in the report at ~1 rejected 1.3 MB
 * request every 12 s, never self-healing).
 *
 * The managed contract still owns retries — the provider must not retry inside
 * a managed attempt — so the fix records the escalated repair scope on the
 * provider session state instead. The next managed attempt then builds a
 * repaired body and the session converges.
 */
const model: Model<"anthropic-messages"> = {
	api: "anthropic-messages",
	provider: "anthropic",
	id: "claude-sonnet-4-6",
	name: "Claude Sonnet 4.6",
	baseUrl: "https://api.anthropic.com",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 8_192,
	contextWindow: 200_000,
	reasoning: true,
};

/** The exact rejection body captured in the report, citing an earlier assistant message. */
const MUTATION_REJECTION =
	'{"type":"error","error":{"type":"invalid_request_error","message":"messages.13.content.16: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response."}}';
const SIGNATURE_REJECTION =
	'{"type":"error","error":{"type":"invalid_request_error","message":"messages.13.content.16: Invalid `signature` in `thinking` block"}}';
const MASKED_REJECTION =
	'{"type":"error","error":{"type":"api_error","message":"An error occurred while processing the request."}}';

type MockAnthropicRequest = {
	withResponse(): Promise<{
		data: AsyncIterable<Record<string, unknown>>;
		response: Response;
		request_id: string | null;
	}>;
};

function rejectingRequest(message: string, status = 400): MockAnthropicRequest {
	return {
		async withResponse(): Promise<never> {
			const error = new Error(message);
			(error as { status?: number }).status = status;
			throw error;
		},
	};
}

function signedAssistant(suffix: string, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: `thinking ${suffix}`, thinkingSignature: `sig_${suffix}` },
			{ type: "text", text },
		],
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
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function replayContext(): Context {
	const user: UserMessage = { role: "user", content: "first", timestamp: Date.now() };
	return {
		messages: [
			user,
			signedAssistant("early", "early answer"),
			{ ...user, content: "second", timestamp: Date.now() + 1 },
			signedAssistant("late", "late answer"),
			{ ...user, content: "next prompt", timestamp: Date.now() + 2 },
		],
	};
}

type RecordedBody = { messages?: Array<{ content?: unknown }> };

function replayedThinkingBlockTypes(body: unknown): string[] {
	const messages = (body as RecordedBody).messages ?? [];
	return messages.flatMap(message =>
		Array.isArray(message.content)
			? (message.content as Array<{ type?: string }>)
					.map(block => block.type ?? "")
					.filter(type => type === "thinking" || type === "redacted_thinking")
			: [],
	);
}

function rejectingClient(rejection: string, bodies: unknown[]): Anthropic {
	const create = ((body: unknown) => {
		bodies.push(body);
		return rejectingRequest(rejection) as never;
	}) as unknown as Anthropic["messages"]["create"];
	return { messages: { create } } as Anthropic;
}

describe("Anthropic managed thinking-replay convergence (issue #4262)", () => {
	it.each([
		["mutation", MUTATION_REJECTION],
		["invalid signature", SIGNATURE_REJECTION],
	])("converges the next managed attempt after a %s rejection", async (_label, rejection) => {
		const requestBodies: unknown[] = [];
		const client = rejectingClient(rejection, requestBodies);
		const providerSessionState = new Map<string, ProviderSessionState>();

		const first = await streamAnthropic(model, replayContext(), {
			client,
			fallbackManaged: true,
			providerSessionState,
		}).result();

		// The managed controller owns retries: the provider must not retry inside
		// the attempt, so the rejection surfaces after exactly one request.
		expect(first.stopReason).toBe("error");
		expect(requestBodies).toHaveLength(1);
		expect(replayedThinkingBlockTypes(requestBodies[0])).toEqual(["thinking", "thinking"]);

		const second = await streamAnthropic(model, replayContext(), {
			client,
			fallbackManaged: true,
			providerSessionState,
		}).result();

		// Without the recorded escalation this body is byte-identical to the first
		// one and the session 400s forever.
		expect(second.stopReason).toBe("error");
		expect(requestBodies).toHaveLength(2);
		expect(replayedThinkingBlockTypes(requestBodies[1])).toEqual([]);
		expect(JSON.stringify(requestBodies[1])).not.toContain("sig_early");
		expect(JSON.stringify(requestBodies[1])).not.toContain("sig_late");
		// Degrading the replay must not drop the turn's visible content.
		expect(JSON.stringify(requestBodies[1])).toContain("early answer");
	});

	it("keeps the escalation in force for later managed turns", async () => {
		const requestBodies: unknown[] = [];
		const client = rejectingClient(MUTATION_REJECTION, requestBodies);
		const providerSessionState = new Map<string, ProviderSessionState>();

		for (let turn = 0; turn < 3; turn++) {
			await streamAnthropic(model, replayContext(), {
				client,
				fallbackManaged: true,
				providerSessionState,
			}).result();
		}

		expect(requestBodies).toHaveLength(3);
		expect(replayedThinkingBlockTypes(requestBodies[1])).toEqual([]);
		expect(replayedThinkingBlockTypes(requestBodies[2])).toEqual([]);
	});

	it("does not degrade the replay for an unclassifiable masked rejection", async () => {
		const requestBodies: unknown[] = [];
		const client = rejectingClient(MASKED_REJECTION, requestBodies);
		const providerSessionState = new Map<string, ProviderSessionState>();

		await streamAnthropic(model, replayContext(), {
			client,
			fallbackManaged: true,
			providerSessionState,
		}).result();
		await streamAnthropic(model, replayContext(), {
			client,
			fallbackManaged: true,
			providerSessionState,
		}).result();

		// A masked `api_error` names no cause and may be a transient blip; only a
		// deterministic thinking rejection may cost the session its replay.
		expect(requestBodies).toHaveLength(2);
		expect(replayedThinkingBlockTypes(requestBodies[1])).toEqual(["thinking", "thinking"]);
	});

	it("records nothing when the managed caller shares no provider session state", async () => {
		const requestBodies: unknown[] = [];
		const client = rejectingClient(MUTATION_REJECTION, requestBodies);

		const result = await streamAnthropic(model, replayContext(), { client, fallbackManaged: true }).result();

		expect(result.stopReason).toBe("error");
		expect(requestBodies).toHaveLength(1);
	});
});
