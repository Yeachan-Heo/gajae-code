import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentMessage, type AgentTool } from "@gajae-code/agent-core";
import { getBundledModel, type Message, type Model } from "@gajae-code/ai";
import { createMockModel, type MockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import * as z from "zod/v4";

// #4881 session-level reproduction: a Windows non-ASCII home path makes the
// escaped-non-ASCII wire defect structural (the Hangul rides routine absolute
// paths), so the managed escaped-args budget exhausts on ordinary turns. The
// contract under test has two halves:
//
//   1. NEVER decode-and-execute: a flagged `\uXXXX` tool call stays rejected —
//      the tool receives no arguments and durable history keeps no defective
//      tool call (#4836 disposition, accepted).
//   2. The fallback chain must not advance on escaped-args exhaustion (the
//      documented "not provider evidence" contract in agent-session.ts and
//      agent-loop.ts).
//
// On unfixed dev, half 1 passes and half 2 FAILS: this file is the independent
// regression proof for the silent opus-5 -> opus-4-6 downgrade, which #4880's
// fallback-disposition fix must turn green. This file deliberately does not
// depend on #4880's fix shape: it observes model identities and switch events,
// not the repair mechanism.

const USER = "최재필";
const HOME = `C:\\Users\\${USER}`;

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		message => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

/** A tool call whose arguments were serialized as `\uXXXX` escapes on the wire. */
function escapedPathTurn(id: string) {
	return {
		content: [
			{
				type: "toolCall" as const,
				id,
				name: "read",
				arguments: { path: `${HOME}\\.gjc\\session.json` },
				escapedNonAsciiArguments: true,
			},
		],
	};
}

const schema = z.object({ path: z.string() });

function readTool(executed: Array<Record<string, unknown>>): AgentTool<typeof schema, Record<string, never>> {
	return {
		name: "read",
		label: "Read",
		description: "Read",
		parameters: schema,
		async execute(_id, params) {
			executed.push(params as Record<string, unknown>);
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	};
}

function selector(model: Model): string {
	return `${model.provider}/${model.id}`;
}

describe("AgentSession escaped non-ASCII exhaustion on a Windows non-ASCII home (#4881)", () => {
	let tempDir: TempDir | undefined;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;

	beforeEach(() => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.restoreAllMocks();
	});

	it("never executes the escaped payload, fails closed, and does not advance the fallback chain", async () => {
		tempDir = TempDir.createSync("@gjc-escaped-windows-home-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");
		const primary = getBundledModel("anthropic", "claude-opus-5");
		const fallback = getBundledModel("anthropic", "claude-opus-4-6");
		if (!primary || !fallback) throw new Error("Expected bundled opus models");

		const modelRegistry = new ModelRegistry(authStorage);
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const executed: Array<Record<string, unknown>> = [];

		// Deterministic Hangul escaper: every wire attempt spells the home
		// path's Hangul as `\ucd5c\uc7ac\ud544`, exactly like the real Windows
		// profile in #4881. The session-level bound must stop this without
		// the chain ever leaving the user's selected model.
		const models = new Map<Model, MockModel>();
		const mockFor = (model: Model): MockModel => {
			const existing = models.get(model);
			if (existing) return existing;
			const created = createMockModel({
				handler: () => escapedPathTurn(`${selector(model)}-tc-${created.calls.length + 1}`),
			});
			models.set(model, created);
			return created;
		};

		const agent = new Agent({
			initialState: { model: primary, systemPrompt: ["test"], tools: [readTool(executed)], messages: [] },
			convertToLlm: identityConverter,
			streamFn: (model, context, options) => mockFor(model).stream(model, context, options),
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"fallback.maxAttempts": 3,
			"retry.baseDelayMs": 1,
		});
		settings.setModelRole("default", selector(primary));
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry,
		});
		// Two-entry opus-5 -> opus-4-6 chain: the exact downgrade from #4881.
		session.setConfiguredModelChain("default", [selector(primary), selector(fallback)], "test");

		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));

		await session.prompt("read the session file");
		await session.waitForIdle();

		// (1) No decode-and-execute: the flagged `\uXXXX` payload never ran.
		expect(executed).toEqual([]);

		// (2) Fail closed within the bounded budget: the run is terminal and
		// the terminal error names the escaped non-ASCII exhaustion.
		expect(session.isStreaming).toBe(false);
		const durable = manager.buildSessionContext().messages;
		const last = durable.findLast(message => message.role === "assistant");
		expect(last?.stopReason).toBe("error");
		expect(last?.errorMessage ?? "").toContain("escaped non-ASCII");
		// And no defective tool call was ever committed to durable history.
		const persistedCalls = durable.flatMap(message =>
			message.role === "assistant"
				? message.content.flatMap(block => (block.type === "toolCall" ? [block.name] : []))
				: [],
		);
		expect(persistedCalls).toEqual([]);

		// (3) The contract half that fails on unfixed dev: a wire-serialization
		// defect is not provider evidence, so the chain must stay on the
		// user's selected model. The silent downgrade is the bug (#4881
		// Problem 1, #4880's domain to fix; this is the independent proof).
		const switched = events.filter(event => event.type === "model_fallback_switched");
		expect(
			switched,
			`escaped-args exhaustion must not advance the fallback chain; observed switches: ${JSON.stringify(
				switched.map(event => ({ from: event.from, to: event.to, reason: event.reason })),
			)}`,
		).toEqual([]);

		// Every provider call stayed on the primary model.
		const calledSelectors = [...models.values()]
			.flatMap(mock => mock.calls.map(() => mock))
			.map((_, index) => undefined)
			.filter((value): value is undefined => value !== undefined);
		void calledSelectors;
		const fallbackCalls = models.get(fallback)?.calls.length ?? 0;
		const primaryCalls = models.get(primary)?.calls.length ?? 0;
		expect(fallbackCalls).toBe(0);
		expect(primaryCalls).toBeGreaterThan(0);
		// Bounded: 1 initial + 2 policy retries on the primary, never a loop.
		expect(primaryCalls).toBeLessThanOrEqual(8);

		// (4) The user's selection survives the turn: still opus-5.
		expect(selector(session.model!)).toBe(selector(primary));
	});
});
