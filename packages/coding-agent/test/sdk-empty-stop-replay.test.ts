import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { initializeExtensions } from "../src/modes/runtime-init";
import { createAgentSession } from "../src/sdk/session";
import type { AgentSessionEvent } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { EMPTY_STOP_SCENARIOS, handleProviderRequest } from "./helpers/managed-empty-stop-harness";

describe("SDK empty-stop replay (local HTTP adapter only)", () => {
	it.each([...EMPTY_STOP_SCENARIOS])("settles %s with accepted-only lifecycle", async scenario => {
		const fallbackDisabled = scenario === "fallback-disabled" || scenario === "untyped-disabled";
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-empty-stop-"));
		const auth = await AuthStorage.create(path.join(cwd, "auth.db"));
		const models: string[] = [];
		const runtimeErrors: string[] = [];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: string | URL | Request, init?: RequestInit) => {
					const request = input instanceof Request ? input : new Request(input.toString(), init);
					expect(new URL(request.url).host).toBe("empty-stop.test");
					return handleProviderRequest(request, scenario, models);
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);
		try {
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"contextPromotion.enabled": false,
				"todo.reminders": false,
				"fallback.maxAttempts": 1,
				"retry.enabled": false,
			});
			settings.setModelRole("default", "empty-stop-fixture/primary");
			const registry = new ModelRegistry(auth, path.join(cwd, "models.yml"), settings);
			registry.registerProvider("empty-stop-fixture", {
				baseUrl: "http://empty-stop.test/v1",
				api: "openai-completions",
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
			if (!primary) throw new Error("Fixture primary model missing");
			const { session } = await createAgentSession({
				cwd,
				agentDir: cwd,
				settings,
				authStorage: auth,
				modelRegistry: registry,
				model: primary,
				sessionManager: SessionManager.inMemory(cwd),
				disableExtensionDiscovery: true,
				enableMcpAutoload: false,
				enableLsp: false,
				skipPythonPreflight: true,
				deferOptionalModelRefresh: true,
				toolNames: ["__none__"],
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
			});
			try {
				session.setConfiguredModelChain(
					"default",
					fallbackDisabled
						? ["empty-stop-fixture/primary"]
						: ["empty-stop-fixture/primary", "empty-stop-fixture/fallback"],
					"local-test",
				);
				await initializeExtensions(session, {
					reportSendError: (_action, error) => {
						throw error;
					},
					reportRuntimeError: error => {
						runtimeErrors.push(error.error);
					},
				});
				const events: AgentSessionEvent[] = [];
				const unsubscribe = session.subscribe(event => events.push(event));
				try {
					await session.prompt("Exercise empty stop");
					await session.waitForIdle();
				} finally {
					unsubscribe();
				}
				const assistants = session.messages.filter(message => message.role === "assistant");
				expect(runtimeErrors).toEqual([]);
				expect(assistants).toHaveLength(1);
				if (fallbackDisabled) {
					expect(models).toEqual(["primary"]);
					expect(session.model?.id).toBe("primary");
					expect(assistants[0].stopReason).toBe("error");
					expect(assistants[0].errorMessage).toBeTruthy();
					expect(assistants[0].usage).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
				} else if (scenario === "nonzero-usage") {
					expect(models).toEqual(["primary"]);
					expect(session.model?.id).toBe("primary");
					expect(assistants[0].stopReason).toBe("stop");
					expect(assistants[0].errorMessage).toBeUndefined();
					expect(assistants[0].usage.input).toBe(1);
				} else {
					expect(models).toEqual(["primary", "fallback"]);
					expect(session.model?.id).toBe("fallback");
					expect(assistants[0].errorMessage).toBeUndefined();
					expect(assistants[0]).toMatchObject({
						content: [{ type: "text", text: "fallback-ok" }],
						stopReason: "stop",
					});
				}
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
				expect(events.filter(event => event.type === "model_fallback_switched").map(event => event.reason)).toEqual(
					fallbackDisabled || scenario === "nonzero-usage" ? [] : ["server"],
				);
			} finally {
				await session.dispose();
			}
		} finally {
			fetchSpy.mockRestore();
			auth.close();
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 30_000);
});
