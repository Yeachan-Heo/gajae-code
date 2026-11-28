import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Message } from "@gajae-code/ai/types";
import { stripCredentialIds } from "@gajae-code/ai/utils/credential-id";
import fc from "fast-check";

const usage = {
	input: 1,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const userArb: fc.Arbitrary<Message> = fc.record({
	role: fc.constant("user" as const),
	content: fc.string({ maxLength: 20 }),
	timestamp: fc.nat(),
});

const developerArb: fc.Arbitrary<Message> = fc.record({
	role: fc.constant("developer" as const),
	content: fc.string({ maxLength: 20 }),
	timestamp: fc.nat(),
});

const toolResultArb: fc.Arbitrary<Message> = fc.record({
	role: fc.constant("toolResult" as const),
	toolCallId: fc.string({ minLength: 1, maxLength: 8 }),
	toolName: fc.constantFrom("bash", "read"),
	content: fc.array(fc.record({ type: fc.constant("text" as const), text: fc.string({ maxLength: 10 }) }), {
		maxLength: 2,
	}),
	isError: fc.boolean(),
	timestamp: fc.nat(),
});

const assistantArb: fc.Arbitrary<Message> = fc
	.record({
		text: fc.string({ maxLength: 20 }),
		credentialId: fc.option(fc.nat({ max: 1_000 }), { nil: undefined }),
		errorMessage: fc.option(fc.string({ maxLength: 10 }), { nil: undefined }),
		timestamp: fc.nat(),
	})
	.map(
		({ text, credentialId, errorMessage, timestamp }): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-5",
			usage,
			stopReason: errorMessage === undefined ? "stop" : "error",
			timestamp,
			...(errorMessage === undefined ? {} : { errorMessage }),
			...(credentialId === undefined ? {} : { credentialId }),
		}),
	);

const messagesArb = fc.array(fc.oneof(userArb, developerArb, toolResultArb, assistantArb), { maxLength: 12 });

const carriesCredentialId = (message: Message) =>
	message.role === "assistant" && Object.hasOwn(message, "credentialId");

describe("stripCredentialIds", () => {
	it("removes credentialId from assistant messages and preserves everything else", () => {
		fc.assert(
			fc.property(messagesArb, messages => {
				const snapshot = structuredClone(messages);
				const out = stripCredentialIds(messages);

				// The input array and its messages are untouched.
				expect(messages).toEqual(snapshot);
				expect(out).toHaveLength(messages.length);
				for (let index = 0; index < messages.length; index++) {
					const input = messages[index] as Message;
					const output = out[index] as Message;
					expect(Object.hasOwn(output, "credentialId")).toBe(false);
					if (carriesCredentialId(input)) {
						// Only messages that carry the field are copied, minus that one field.
						expect(output).not.toBe(input);
						const { credentialId: _credentialId, ...rest } = input as AssistantMessage;
						expect(output).toEqual(rest);
					} else {
						expect(output).toBe(input);
					}
				}
				if (!messages.some(carriesCredentialId)) expect(out).toBe(messages);
				else expect(out).not.toBe(messages);
			}),
			{ numRuns: 500 },
		);
	});
});
