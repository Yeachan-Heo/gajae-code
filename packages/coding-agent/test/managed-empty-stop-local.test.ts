import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai";
import { classifyFallbackTrigger } from "@gajae-code/ai/utils/fallback-transport";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import type { ExtensionFactory } from "../src/extensibility/extensions/types";
import { createAgentSession } from "../src/sdk";
import { createSdkSessionRuntimeExtension } from "../src/sdk/host/session-runtime";
import { AgentSession, type AgentSessionEvent } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { type SessionEntry, SessionManager } from "../src/session/session-manager";
import { EventBus } from "../src/utils/event-bus";
import {
	assertManagedTranscript,
	type EmptyStopScenario,
	handleProviderRequest,
} from "./helpers/managed-empty-stop-harness";

// Local session integration: real provider HTTP/SSE, without launching the SDK
// broker or running the connected WebSocket verification scenarios.
test.each([
	...["fallback-enabled", "untyped-fallback", "fallback-disabled", "untyped-disabled", "nonzero-usage"].flatMap(
		scenario => [
			{ scenario: scenario as EmptyStopScenario, initialization: "direct" as const, nonzeroFallback: false },
			{ scenario: scenario as EmptyStopScenario, initialization: "sdk" as const, nonzeroFallback: false },
		],
	),
	// A single-model boundary cannot detect accidental fallback admission.
	// Keep the same one-request/no-switch expectations with a usable tail.
	{ scenario: "nonzero-usage" as const, initialization: "direct" as const, nonzeroFallback: true },
	{ scenario: "nonzero-usage" as const, initialization: "sdk" as const, nonzeroFallback: true },
])("local session preserves empty-stop request boundary: %j", async ({ scenario, initialization, nonzeroFallback }) => {
	const models: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: request => handleProviderRequest(request, scenario, models),
	});
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-empty-stop-local-"));
	const auth = await AuthStorage.create(":memory:");
	let session: AgentSession | undefined;
	try {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"contextPromotion.enabled": false,
			"todo.reminders": false,
			"fallback.maxAttempts": 1,
			"retry.enabled": false,
			"retry.baseDelayMs": 1,
			"fallback.circuitCooldownMs": 0,
		});
		const registry = new ModelRegistry(auth, undefined, settings);
		registry.registerProvider("empty-stop-fixture", {
			api: "openai-completions",
			baseUrl: `http://127.0.0.1:${server.port}/v1`,
			apiKey: "fixture-only-key",
			models: ["primary", "fallback"].map(id => ({
				id,
				name: id,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32768,
				maxTokens: 4096,
			})),
		});
		const primary = registry.find("empty-stop-fixture", "primary");
		expect(primary).toBeDefined();
		if (!primary) throw new Error("Missing local provider model");
		const manager =
			initialization === "sdk"
				? SessionManager.create(root, SessionManager.managedDestination(root, root))
				: SessionManager.inMemory();
		const sdkObserver: ExtensionFactory = api => {
			// Register on the runner that actually drives each session. Without
			// session_start, production lifecycle observation needs no transport.
			createSdkSessionRuntimeExtension(api, {
				agentDir: root,
				createTransport: () => {
					throw new Error("Local integration must not launch an SDK transport");
				},
			});
		};
		if (initialization === "direct") {
			const runtime = new ExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				sdkObserver,
				root,
				new EventBus(),
				runtime,
				"sdk-lifecycle-observer-test",
			);
			const runner = new ExtensionRunner([extension], runtime, root, manager, registry, undefined, settings);
			const agent = new Agent({
				initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
				getApiKey: async () => registry.getApiKeyForProvider("empty-stop-fixture"),
			});
			session = new AgentSession({
				agent,
				settings,
				sessionManager: manager,
				modelRegistry: registry,
				extensionRunner: runner,
			});
		} else {
			({ session } = await createAgentSession({
				cwd: root,
				agentDir: root,
				model: primary,
				authStorage: auth,
				settings,
				sessionManager: manager,
				modelRegistry: registry,
				disableExtensionDiscovery: true,
				extensions: [sdkObserver],
				enableMCP: false,
				enableMcpAutoload: false,
				enableLsp: false,
				skipPythonPreflight: true,
				deferOptionalModelRefresh: true,
				// Retain the connected harness's default tools and managed destination.
				// An empty tool selection can hide startup/prompt wiring regressions.
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
			}));
		}
		expect(session.extensionRunner?.hasHandlers("agent_start")).toBe(true);
		session.setConfiguredModelChain(
			"default",
			(scenario === "nonzero-usage" && !nonzeroFallback) || scenario.endsWith("disabled")
				? ["empty-stop-fixture/primary"]
				: ["empty-stop-fixture/primary", "empty-stop-fixture/fallback"],
			"test",
		);
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));
		await session.prompt("Exercise empty stop");
		await session.waitForIdle();
		const failed = scenario.endsWith("disabled");
		expect(models).toEqual(scenario === "nonzero-usage" || failed ? ["primary"] : ["primary", "fallback"]);
		const assistants = session.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(assistants).toHaveLength(1);
		expect(assistants[0].stopReason).toBe(failed ? "error" : "stop");
		expect(assistants[0].content).toEqual(
			scenario === "nonzero-usage" || failed ? [] : [{ type: "text", text: "fallback-ok" }],
		);
		expect(
			events
				.filter(
					event =>
						event.type === "turn_end" ||
						event.type === "agent_end" ||
						((event.type === "message_start" || event.type === "message_end") &&
							event.message.role === "assistant"),
				)
				.map(event => event.type),
		).toEqual(["message_start", "message_end", "turn_end", "agent_end"]);
		const switches = events.filter(event => event.type === "model_fallback_switched");
		if (failed) {
			expect(assistants[0].usage.totalTokens).toBe(0);
			expect(assistants[0].errorMessage).toMatch(/empty response with zero token usage/i);
			if (scenario === "untyped-disabled") {
				expect(assistants[0].errorKind).toBe("local_empty_response");
			} else {
				expect(assistants[0].transportFailure?.providerCode).toBe("empty_response");
				expect(classifyFallbackTrigger(assistants[0].transportFailure).class).toBe("server");
			}
		} else if (scenario === "nonzero-usage") {
			expect(assistants[0].usage.totalTokens).toBeGreaterThan(0);
		} else {
			expect(session.model?.id).toBe("fallback");
			expect(switches.map(({ from, to, reason }) => ({ from, to, reason }))).toEqual([
				{ from: "empty-stop-fixture/primary", to: "empty-stop-fixture/fallback", reason: "server" },
			]);
		}
		if (failed || scenario === "nonzero-usage") {
			expect(session.model?.id).toBe("primary");
			expect(switches).toEqual([]);
		}
		if (initialization === "sdk") {
			await manager.ensureOnDisk();
			await manager.flush();
			const transcript = manager.getSessionFile();
			expect(transcript).toBeDefined();
			if (!transcript) throw new Error("Missing managed transcript");
			const entries = Bun.JSONL.parse(await Bun.file(transcript).text()) as SessionEntry[];
			const persistedAssistants = entries.flatMap(entry =>
				entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : [],
			);
			expect(persistedAssistants).toEqual(assistants);
			await assertManagedTranscript(manager, assistants);
		}
	} finally {
		try {
			await session?.dispose();
		} finally {
			auth.close();
			server.stop(true);
			await fs.rm(root, { recursive: true, force: true });
		}
	}
}, 15_000);
