import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentOptions, type AgentTool } from "@gajae-code/agent-core";
import { type AssistantMessage, getBundledModel, type Model, type ToolCall } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import type { Rule } from "@gajae-code/coding-agent/capability/rule";
import { activateModelProfile } from "@gajae-code/coding-agent/config/model-profile-activation";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { TtsrManager } from "@gajae-code/coding-agent/export/ttsr";
import { AgentSession, type AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import { z } from "zod";

const selector = (model: Model) => `${model.provider}/${model.id}`;
const RULE_CONTENT = "TTSR-CHAIN-REMINDER: never pass --danger.";

function chainRule(partial: Partial<Rule> = {}): Rule {
	return {
		name: "no-danger",
		path: "/tmp/no-danger.md",
		content: RULE_CONTENT,
		condition: ["--danger"],
		scope: ["tool:probe"],
		interruptMode: "tool-only",
		repeatMode: "once",
		_source: { provider: "test", providerName: "test", path: "/tmp/no-danger.md", level: "project" },
		...partial,
	};
}

let fixedTimestamp: number | undefined;

function assistant(model: Model, content: AssistantMessage["content"], stopReason: "toolUse" | "stop") {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: fixedTimestamp ?? Date.now(),
	} satisfies AssistantMessage;
}

/** Streams a tool call whose arguments arrive in several deltas, like a real provider. */
function toolCallStream(model: Model, call: ToolCall, argDeltas: string[]): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message = assistant(model, [call], "toolUse");
		stream.push({ type: "start", partial: message });
		stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
		for (const delta of argDeltas) stream.push({ type: "toolcall_delta", contentIndex: 0, delta, partial: message });
		stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
		stream.push({ type: "done", reason: "toolUse", message });
		stream.end();
	});
	return stream;
}

function textStream(model: Model, text: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message = assistant(model, [{ type: "text", text }], "stop");
		stream.push({ type: "start", partial: message });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		stream.push({ type: "done", reason: "stop", message });
		stream.end();
	});
	return stream;
}

describe("TTSR under a managed default fallback chain", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@ttsr-fallback-chain-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");
	});

	afterEach(async () => {
		fixedTimestamp = undefined;
		await session?.dispose();
		session = undefined;
		authStorage.close();
		tempDir.removeSync();
	});

	type Turn = { call: ToolCall; deltas: string[] } | { text: string };
	async function setup(
		chain: boolean,
		options: { rules?: Rule[]; turns?: Turn[]; assistantStartDelayMs?: number } = {},
	) {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled test models");
		const modelsPath = path.join(tempDir.path(), "models.yml");
		const mapping = chain ? `[${selector(primary)}, ${selector(fallback)}]` : selector(primary);
		await Bun.write(
			modelsPath,
			`profiles:\n  ttsr-chain:\n    required_providers: [anthropic, openai]\n    model_mapping:\n      default: ${mapping}\n`,
		);
		const registry = new ModelRegistry(authStorage, modelsPath);
		const executed: unknown[] = [];
		const probe: AgentTool = {
			name: "probe",
			label: "Probe",
			description: "probe",
			parameters: z.object({ command: z.string() }),
			async execute(_toolCallId, args) {
				executed.push(args);
				return { content: [{ type: "text" as const, text: "probe ok" }] };
			},
		};
		const blocked: ToolCall = {
			type: "toolCall",
			id: "call-blocked",
			name: "probe",
			arguments: { command: "run --danger now" },
		};
		const defaultTurns: Turn[] = [
			{ call: blocked, deltas: ['{"command":"run', " --danger", " a", " b", " c", ' now"}'] },
		];
		const managedFlags: Array<boolean | undefined> = [];
		let assistantStarts = 0;
		const contexts: string[] = [];
		let turn = 0;
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [probe], messages: [] },
			convertToLlm,
			streamFn: ((model, context, streamOptions) => {
				managedFlags.push(streamOptions?.fallbackManaged);
				contexts.push(JSON.stringify(context.messages));
				const scripted = (options.turns ?? defaultTurns)[turn++] ?? { text: "Done" };
				return "call" in scripted
					? toolCallStream(model, scripted.call, scripted.deltas)
					: textStream(model, scripted.text);
			}) satisfies AgentOptions["streamFn"],
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.baseDelayMs": 1 });
		const ttsrManager = new TtsrManager({ interruptMode: "always", contextMode: "keep" });
		for (const rule of options.rules ?? [chainRule()]) ttsrManager.addRule(rule);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: registry,
			ttsrManager,
			toolRegistry: new Map([[probe.name, probe]]),
			...(options.assistantStartDelayMs !== undefined
				? {
						// A slow extension hook on assistant message_start: its delivery is awaited,
						// while that stream's message_update handlers do not wait for it.
						extensionRunner: new Proxy(
							{
								emit: async (event: { type: string; message?: { role?: string } }) => {
									// The first stream starts promptly; later streams start slowly.
									if (
										event.type === "message_start" &&
										event.message?.role === "assistant" &&
										assistantStarts++ > 0
									)
										await Bun.sleep(options.assistantStartDelayMs ?? 0);
								},
								hasHandlers: (eventType: string) => eventType === "message_start",
							} as Record<PropertyKey, unknown>,
							// Every other runner hook is a no-op.
							{ get: (target, key) => (key in target ? target[key] : async () => undefined) },
						) as never,
					}
				: {}),
		});
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));
		await activateModelProfile({ session, modelRegistry: registry, settings, profileName: "ttsr-chain" });
		return { session, events, executed, managedFlags, contexts, settle };
		async function settle(expectedCalls: number) {
			const target = session!;
			await target.waitForIdle();
			for (
				let i = 0;
				i < 200 && (managedFlags.length < expectedCalls || target.isStreaming || target.isTtsrAbortPending);
				i++
			)
				await Bun.sleep(10);
			await target.waitForIdle();
		}
	}

	for (const chain of [false, true]) {
		it(`interrupts the matching tool call once and aborts its message (${chain ? "chain" : "single model"})`, async () => {
			const { session: target, events, executed, managedFlags, contexts, settle } = await setup(chain);
			await target.prompt("run the probe");
			// The TTSR resume is a delayed post-prompt task; wait for its turn to finish.
			await settle(2);

			expect(managedFlags[0]).toBe(chain ? true : undefined);
			const triggered = events.filter(event => event.type === "ttsr_triggered");
			expect(triggered).toHaveLength(1);
			const assistantEnds = events.flatMap(event =>
				event.type === "message_end" && event.message.role === "assistant"
					? [event.message as AssistantMessage]
					: [],
			);
			expect(assistantEnds[0]?.stopReason).toBe("aborted");
			expect(executed).toEqual([]);
			// The TTSR resume re-requests the turn with the rule injected and finishes normally.
			expect(managedFlags).toHaveLength(2);
			expect(contexts[0]).not.toContain(RULE_CONTENT);
			expect(contexts[1]).toContain(RULE_CONTENT);
			expect(assistantEnds.at(-1)?.stopReason).toBe("stop");
		});
		it(`checks the next assistant stream again even when it reuses the interrupted timestamp (${chain ? "chain" : "single model"})`, async () => {
			fixedTimestamp = 1_700_000_000_000;
			const otherRule = chainRule({
				name: "no-other",
				path: "/tmp/no-other.md",
				condition: ["--other"],
				content: "TTSR-OTHER-REMINDER",
			});
			const call = (id: string, command: string): ToolCall => ({
				type: "toolCall",
				id,
				name: "probe",
				arguments: { command },
			});
			const {
				session: target,
				events,
				executed,
				settle,
			} = await setup(chain, {
				rules: [chainRule(), otherRule],
				turns: [
					// The interrupted stream also carries --other after the match: it must stay suppressed.
					{ call: call("c1", "x --danger y --other"), deltas: ['{"command":"x', " --danger", " y --other", '"}'] },
					// The resumed stream reuses the same timestamp and must still be checked.
					{ call: call("c2", "x --other"), deltas: ['{"command":"x', " --other", '"}'] },
				],
			});
			await target.prompt("run the probe");
			await settle(3);

			const triggered = events.flatMap(event =>
				event.type === "ttsr_triggered" ? [event.rules.map(rule => rule.name)] : [],
			);
			expect(triggered).toEqual([["no-danger"], ["no-other"]]);
			expect(executed).toEqual([]);
		});

		it(`checks the next assistant stream while a slow message_start hook is still running (${chain ? "chain" : "single model"})`, async () => {
			const otherRule = chainRule({
				name: "no-other",
				path: "/tmp/no-other.md",
				condition: ["--other"],
				content: "TTSR-OTHER-REMINDER",
			});
			const call = (id: string, command: string): ToolCall => ({
				type: "toolCall",
				id,
				name: "probe",
				arguments: { command },
			});
			const {
				session: target,
				events,
				executed,
				settle,
			} = await setup(chain, {
				assistantStartDelayMs: 50,
				rules: [chainRule(), otherRule],
				turns: [
					// The interrupted stream also carries --other after the match: it must stay suppressed.
					{ call: call("c1", "x --danger y --other"), deltas: ['{"command":"x', " --danger", " y --other", '"}'] },
					// The resumed stream reuses the same timestamp and must still be checked.
					{ call: call("c2", "x --other"), deltas: ['{"command":"x', " --other", '"}'] },
				],
			});
			await target.prompt("run the probe");
			await settle(3);

			const triggered = events.flatMap(event =>
				event.type === "ttsr_triggered" ? [event.rules.map(rule => rule.name)] : [],
			);
			expect(triggered).toEqual([["no-danger"], ["no-other"]]);
			expect(executed).toEqual([]);
		});
	}

	// The managed path publishes staged terminal snapshots; the unmanaged path already shares
	// its accepted message with subscribers, which this change does not alter.
	it("keeps the dispatched tool call private from terminal event subscribers (chain)", async () => {
		const safe: ToolCall = { type: "toolCall", id: "c-safe", name: "probe", arguments: { command: "safe" } };
		const {
			session: target,
			executed,
			settle,
		} = await setup(true, {
			rules: [],
			turns: [{ call: safe, deltas: ['{"command":"safe"}'] }],
		});
		target.subscribe(event => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			for (const block of (event.message as AssistantMessage).content) {
				if (block.type === "toolCall") block.arguments = { command: "tampered" };
			}
		});
		await target.prompt("run the probe");
		await settle(2);
		expect(executed).toEqual([{ command: "safe" }]);
	});
});
