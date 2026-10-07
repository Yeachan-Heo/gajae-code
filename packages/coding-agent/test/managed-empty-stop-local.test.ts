import { expect, test } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { tagSdkLifecycleObserver } from "../src/extensibility/extensions/function-hooks-internal";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { EventBus } from "../src/utils/event-bus";
import { type EmptyStopScenario, handleProviderRequest } from "./helpers/managed-empty-stop-harness";

// Local session integration: real provider HTTP/SSE, without launching the SDK
// broker or running the connected verification scenarios owned by the tester.
test.each([
	"fallback-enabled",
	"untyped-fallback",
	"fallback-disabled",
	"untyped-disabled",
	"nonzero-usage",
] as const)("local session preserves empty-stop request boundary: %s", async (scenario: EmptyStopScenario) => {
	const models: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: request => handleProviderRequest(request, scenario, models),
	});
	const auth = await AuthStorage.create(":memory:");
	let session: AgentSession | undefined;
	let observedStarts = 0;
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
		const manager = SessionManager.inMemory();
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			api => {
				api.on(
					"agent_start",
					tagSdkLifecycleObserver(() => {
						observedStarts++;
					}),
				);
			},
			process.cwd(),
			new EventBus(),
			runtime,
			"sdk-lifecycle-observer-test",
		);
		const runner = new ExtensionRunner([extension], runtime, process.cwd(), manager, registry, undefined, settings);
		const agent = new Agent({
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			getApiKey: provider => registry.getApiKeyForProvider(provider),
		});
		session = new AgentSession({
			agent,
			settings,
			sessionManager: manager,
			modelRegistry: registry,
			extensionRunner: runner,
		});
		session.setConfiguredModelChain(
			"default",
			scenario === "nonzero-usage" || scenario.endsWith("disabled")
				? ["empty-stop-fixture/primary"]
				: ["empty-stop-fixture/primary", "empty-stop-fixture/fallback"],
			"test",
		);
		await session.prompt("Exercise empty stop");
		await session.waitForIdle();
		const failed = scenario.endsWith("disabled");
		expect(models).toEqual(scenario === "nonzero-usage" || failed ? ["primary"] : ["primary", "fallback"]);
		expect(observedStarts).toBe(1);
		const assistants = session.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(assistants).toHaveLength(1);
		expect(assistants[0].stopReason).toBe(failed ? "error" : "stop");
		expect(assistants[0].content).toEqual(
			scenario === "nonzero-usage" || failed ? [] : [{ type: "text", text: "fallback-ok" }],
		);
	} finally {
		await session?.dispose();
		auth.close();
		server.stop(true);
	}
}, 15_000);
