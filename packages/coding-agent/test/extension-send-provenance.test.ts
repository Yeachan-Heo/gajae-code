import { describe, expect, it, vi } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { initializeExtensions } from "../src/modes/runtime-init";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

/**
 * An extension send is an INDEPENDENT producer, never a continuation of the
 * current turn. The trusted adapter must classify it as `origin: "external"` so
 * a terminal abort preserves it instead of dropping it as turn-owned work —
 * and it must do so in HEADLESS runtimes too, not only the interactive one.
 */
describe("extension send provenance", () => {
	async function createSession() {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model");
		const mock = createMockModel({ handler: { content: ["ok"] } });
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
		return { session, authStorage };
	}

	it("classifies a headless extension send as external, matching the interactive adapter", async () => {
		const { session, authStorage } = await createSession();
		try {
			const sendSpy = vi.spyOn(session, "sendCustomMessage").mockResolvedValue(undefined);
			let actions: { sendMessage: (message: unknown, options?: unknown) => void } | undefined;
			// A minimal runner: capture the action set the headless initializer installs.
			const runner = {
				initialize: (installed: typeof actions) => {
					actions = installed;
				},
				onError: () => {},
				emit: async () => undefined,
				getExtensionPaths: () => [],
			};
			Object.defineProperty(session, "extensionRunner", { configurable: true, get: () => runner });

			await initializeExtensions(session, {
				reportSendError: () => {},
				reportRuntimeError: () => {},
			});
			if (!actions) throw new Error("Expected the headless initializer to install extension actions");

			actions.sendMessage(
				{ customType: "ext", content: "from an extension", display: false, attribution: "agent" },
				{ deliverAs: "steer" },
			);

			expect(sendSpy).toHaveBeenCalledTimes(1);
			const [, options] = sendSpy.mock.calls[0] ?? [];
			expect(options).toMatchObject({ deliverAs: "steer", origin: "external" });
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
});
