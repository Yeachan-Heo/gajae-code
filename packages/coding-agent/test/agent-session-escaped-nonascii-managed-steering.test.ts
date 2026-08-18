import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@gajae-code/agent-core";
import { ESCAPED_NONASCII_RECOVERY_PROMPT } from "@gajae-code/agent-core/agent-loop";
import { getBundledModel, type Message, type Model } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import * as z from "zod/v4";

const QUESTION = "마지막 병목";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		message => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

function escapedTurn(id: string) {
	return {
		content: [
			{
				type: "toolCall" as const,
				id,
				name: "ask",
				arguments: { question: QUESTION },
				escapedNonAsciiArguments: true,
			},
		],
	};
}

function literalTurn(id: string) {
	return { content: [{ type: "toolCall" as const, id, name: "ask", arguments: { question: QUESTION } }] };
}

const schema = z.object({ question: z.string() });

function askTool(executed: Array<Record<string, unknown>>): AgentTool<typeof schema, Record<string, never>> {
	return {
		name: "ask",
		label: "Ask",
		description: "Ask",
		parameters: schema,
		async execute(_id, params) {
			executed.push(params as Record<string, unknown>);
			return { content: [{ type: "text", text: "answered" }], details: {} };
		},
	};
}

function selector(model: Model): string {
	return `${model.provider}/${model.id}`;
}

/** Matches a user message carrying `text`, regardless of string-vs-blocks content shape. */
function hasUserText(messages: AgentMessage[], text: string): boolean {
	return messages.some(message => {
		if (message.role !== "user") return false;
		const content = message.content;
		if (typeof content === "string") return content === text;
		if (!Array.isArray(content)) return false;
		return content.some(block => block?.type === "text" && block.text === text);
	});
}

describe("AgentSession escaped non-ASCII managed steering", () => {
	let tempDir: TempDir | undefined;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
	});

	it("carries the transient steering instruction through the managed fallback retry", async () => {
		tempDir = TempDir.createSync("@gjc-escaped-managed-steering-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled test models");
		const modelRegistry = new ModelRegistry(authStorage);
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const executed: Array<Record<string, unknown>> = [];
		// Wire sequence: escaped (discarded → managed outcome, policy retry),
		// escaped again (the retry attempt rode the steering instruction but is
		// still defective → discarded again, steering already spent), then a
		// literal-UTF-8 turn on the unsteered blind retry, which executes.
		const mock = createMockModel({
			responses: [escapedTurn("tc-1"), escapedTurn("tc-2"), literalTurn("tc-3"), { content: ["done"] }],
		});
		const agent = new Agent({
			initialState: { model: primary, systemPrompt: ["test"], tools: [askTool(executed)], messages: [] },
			convertToLlm: identityConverter,
			streamFn: (model, context, options) => mock.stream(model, context, options),
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"fallback.maxAttempts": 3,
			"retry.baseDelayMs": 10,
		});
		settings.setModelRole("default", selector(primary));
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry,
		});
		// A chain of 2+ entries is what turns on fallbackManaged for the run.
		session.setConfiguredModelChain("default", [selector(primary), selector(fallback)], "test");

		await session.prompt("ask me");
		await manager.flush();

		// Four provider calls: initial, steered retry, blind retry, post-tool wrap-up.
		expect(mock.model.calls).toHaveLength(4);

		// The first retry (the policy continuation after the first discarded
		// outcome) must carry the steering instruction exactly once, and tools
		// stay enabled: the steered request is a re-request of the same logical
		// turn, not a diagnostic detour.
		const steeredRequest = mock.model.calls[1];
		expect(steeredRequest).toBeDefined();
		expect(hasUserText(steeredRequest.context.messages, ESCAPED_NONASCII_RECOVERY_PROMPT)).toBe(true);
		expect(steeredRequest.context.tools?.length ?? 0).toBeGreaterThan(0);

		// The instruction is transient: it never lands in durable history and
		// never rides a later request once spent.
		const durable = manager.buildSessionContext().messages;
		expect(hasUserText(durable, ESCAPED_NONASCII_RECOVERY_PROMPT)).toBe(false);
		for (const request of mock.model.calls.slice(2)) {
			expect(hasUserText(request.context.messages, ESCAPED_NONASCII_RECOVERY_PROMPT)).toBe(false);
		}

		// The literal call executed and every defective turn stayed out of history.
		expect(executed).toEqual([{ question: QUESTION }]);
		const persistedToolCallIds = durable.flatMap(message =>
			message.role === "assistant"
				? message.content.flatMap(block => (block.type === "toolCall" ? [block.id] : []))
				: [],
		);
		expect(persistedToolCallIds).not.toContain("tc-1");
		expect(persistedToolCallIds).not.toContain("tc-2");
		expect(persistedToolCallIds).toContain("tc-3");
	});

	it("fails closed after the managed escaped retry budget instead of looping forever", async () => {
		tempDir = TempDir.createSync("@gjc-escaped-managed-budget-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled test models");
		const modelRegistry = new ModelRegistry(authStorage);
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const executed: Array<Record<string, unknown>> = [];
		// A deterministic escaper: every wire attempt escapes, forever. Before
		// the session-level bound this looped without end — each managed
		// continuation is a fresh loop with a fresh in-loop budget and the
		// un-charged fallback chain never exhausts.
		const mock = createMockModel({
			handler: () => escapedTurn(`tc-forever-${mock.model.calls.length}`),
		});
		const agent = new Agent({
			initialState: { model: primary, systemPrompt: ["test"], tools: [askTool(executed)], messages: [] },
			convertToLlm: identityConverter,
			streamFn: (model, context, options) => mock.stream(model, context, options),
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"fallback.maxAttempts": 3,
			"retry.baseDelayMs": 10,
		});
		settings.setModelRole("default", selector(primary));
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry,
		});
		session.setConfiguredModelChain("default", [selector(primary), selector(fallback)], "test");

		await session.prompt("ask me");
		await manager.flush();

		// The run is terminal with an error, never executed anything, and the
		// provider-call count is bounded: 1 initial + 2 policy retries (the
		// first steered, the second blind), each turn then spending its own
		// in-loop resample budget is impossible here because every loop is a
		// fresh managed invocation — so the session bound is the only stop.
		expect(session.isStreaming).toBe(false);
		expect(executed).toEqual([]);
		expect(mock.model.calls.length).toBeLessThanOrEqual(8);
		const durable = manager.buildSessionContext().messages;
		const last = durable.findLast(message => message.role === "assistant");
		expect(last?.stopReason).toBe("error");
		expect(last?.errorMessage ?? "").toContain("escaped non-ASCII");
		// The steering instruction was still transient: exactly one steered
		// request, nothing durable.
		expect(hasUserText(durable, ESCAPED_NONASCII_RECOVERY_PROMPT)).toBe(false);
		const steeredRequests = mock.model.calls.filter(request =>
			hasUserText(request.context.messages, ESCAPED_NONASCII_RECOVERY_PROMPT),
		);
		expect(steeredRequests).toHaveLength(1);
	});
});
