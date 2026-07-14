import { describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { runExtensionSetModel } from "@gajae-code/coding-agent/extensibility/extensions/compact-handler";
import {
	AgentSession,
	type ModelChangeCause,
	type TemporaryModelReason,
} from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

/**
 * Model-change cause contract: every AgentSession model mutation must carry its
 * semantic cause. This covers the two callsites that previously omitted it
 * (extension setModel and the permanent role-cycle switch); the remaining
 * callsites (/model, wire, ACP, slash, activation, startup, temporary ops,
 * fallback) are covered by their own focused suites.
 */
describe("AgentSession model-change causes", () => {
	test("accepts every cause through the production mutation boundaries", async () => {
		const tempDir = TempDir.createSync("@pi-model-change-causes-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const model = {
			api: "openai-completions",
			provider: "test-provider",
			id: "test-model",
			name: "Test model",
			baseUrl: "https://example.test",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 1,
			contextWindow: 1,
		} as Model;
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: [], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
		});
		const setModel = vi.spyOn(session, "setModel");
		const setModelTemporary = vi.spyOn(session, "setModelTemporary");
		const permanentCauses = [
			"user-selection",
			"profile-activation",
			"fallback-switch",
			"restore",
			"rollback",
			"startup-override",
		] as const satisfies readonly Exclude<ModelChangeCause, "temporary-operation">[];
		const temporaryReasons = [
			"plan-mode",
			"context-promotion",
			"temporary-cycle",
			"profile-preview",
			"extension-temporary",
		] as const satisfies readonly Exclude<TemporaryModelReason, "other">[];

		try {
			for (const cause of permanentCauses) await session.setModel(model, "default", { cause });
			for (const reason of temporaryReasons) {
				await session.setModelTemporary(model, undefined, { cause: "temporary-operation", reason });
			}

			expect(setModel.mock.calls.map(([, , options]) => options?.cause)).toEqual([...permanentCauses]);
			expect(setModelTemporary.mock.calls.map(([, , options]) => options?.cause)).toEqual(
				temporaryReasons.map(() => "temporary-operation"),
			);
			expect(setModelTemporary.mock.calls.map(([, , options]) => options?.reason)).toEqual([...temporaryReasons]);
		} finally {
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		}
	});
	test("runExtensionSetModel passes user-selection cause", async () => {
		const model = { provider: "p", id: "m" } as unknown as Model;
		const calls: Array<{ role?: string; cause?: string }> = [];
		const session = {
			modelRegistry: { getApiKey: async () => "key" },
			setModel: async (_model: Model, role?: string, options?: { cause?: string }) => {
				calls.push({ role, cause: options?.cause });
			},
		};

		const ok = await runExtensionSetModel(session, model);

		expect(ok).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({ role: "default", cause: "user-selection" });
	});

	test("runExtensionSetModel returns false without an API key and does not set the model", async () => {
		const model = { provider: "p", id: "m" } as unknown as Model;
		let setModelCalled = false;
		const session = {
			modelRegistry: { getApiKey: async () => undefined },
			setModel: async () => {
				setModelCalled = true;
			},
		};

		const ok = await runExtensionSetModel(session, model);

		expect(ok).toBe(false);
		expect(setModelCalled).toBe(false);
	});
});
