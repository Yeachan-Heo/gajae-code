import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import * as compactionModule from "@gajae-code/agent-core/compaction";
import { getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import { assistantMsg, userMsg } from "./utilities";

/**
 * Issue #697: auto-compaction must follow the active/custom provider route
 * instead of silently requiring OpenAI. A user on a custom Anthropic-capable
 * provider should compact through that provider; and when that provider's
 * compaction credential is unusable, compaction must NOT silently fall back to
 * an unrelated provider (e.g. a stray OpenAI key with no remaining credit) just
 * because OpenAI models exist in the bundled catalog. Cross-provider compaction
 * is only reached when explicitly configured via `modelRoles`.
 */
describe("#697 auto-compaction respects the active custom provider", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;

	function writeCustomProviderModels(): string {
		const modelsPath = path.join(tempDir.path(), "models.json");
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					myproxy: {
						baseUrl: "https://myproxy.example/v1",
						apiKeyEnv: "MYPROXY_API_KEY",
						api: "anthropic-messages",
						auth: "apiKey",
						models: [
							{
								id: "claude-sonnet-4-5",
								name: "Claude via myproxy",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 200000,
								maxTokens: 8192,
							},
						],
					},
				},
			}),
		);
		return modelsPath;
	}

	function seedConversation(): void {
		for (const [u, a] of [
			["first question", "first answer"],
			["second question", "second answer"],
		] as const) {
			const um = userMsg(u);
			const am = assistantMsg(a);
			session.agent.appendMessage(um);
			session.sessionManager.appendMessage(um);
			session.agent.appendMessage(am);
			session.sessionManager.appendMessage(am);
		}
	}

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-697-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) await session.dispose();
		authStorage?.close();
		tempDir.removeSync();
	});

	it("compacts through the active custom provider model using its own credential", async () => {
		const modelsPath = writeCustomProviderModels();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage, modelsPath);
		const configError = modelRegistry.getError();
		if (configError) throw new Error(`models config error: ${configError.message}`);

		const currentModel = modelRegistry.find("myproxy", "claude-sonnet-4-5");
		if (!currentModel) throw new Error("expected myproxy model to load");

		// Only the custom provider has a usable credential — OpenAI must never be needed.
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model =>
			model.provider === "myproxy" ? "myproxy-secret" : undefined,
		);

		const agent = new Agent({
			initialState: { model: currentModel, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const settings = Settings.isolated({ "compaction.keepRecentTokens": 1 });
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(() => {});
		seedConversation();

		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model, key) => ({
			summary: "ok",
			shortSummary: "ok short",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 1,
			details: { provider: model.provider, key },
		}));

		await session.compact();

		expect(compactSpy).toHaveBeenCalled();
		const [, model, key] = compactSpy.mock.calls[0]!;
		expect(`${model.provider}/${model.id}`).toBe("myproxy/claude-sonnet-4-5");
		expect(key).toBe("myproxy-secret");
		// Regression: no OpenAI attempt anywhere in the candidate chain.
		expect(compactSpy.mock.calls.every(([, m]) => m.provider === "myproxy")).toBe(true);
	});

	it("does not fall back to OpenAI when the active provider cannot compact and only a stray OpenAI credential exists", async () => {
		const modelsPath = writeCustomProviderModels();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage, modelsPath);
		const configError = modelRegistry.getError();
		if (configError) throw new Error(`models config error: ${configError.message}`);

		const currentModel = modelRegistry.find("myproxy", "claude-sonnet-4-5");
		// gpt-4.1 has a far larger context window (1M+) than the custom provider's
		// 200k, so it would win the "largest-context" last-resort fallback sort.
		const strayOpenAi = getBundledModel("openai", "gpt-4.1");
		if (!currentModel || !strayOpenAi) throw new Error("expected test models to exist");

		// Both providers carry a credential — only an OpenAI *route* (not a missing
		// key) is the failure mode under test, so order/provider-scope must decide.
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model => {
			if (model.provider === "myproxy") return "myproxy-secret";
			if (model.provider === "openai") return "stray-openai-key";
			return undefined;
		});
		// Make the stray OpenAI model "available" so the fallback could reach it.
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([currentModel, strayOpenAi]);

		const agent = new Agent({
			initialState: { model: currentModel, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const settings = Settings.isolated({ "compaction.keepRecentTokens": 1 });
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(() => {});
		seedConversation();

		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (_preparation, model) => {
			if (model.provider === "myproxy") {
				// Simulate the active provider's compaction credential being unusable.
				throw new Error("Summarization failed: 503 auth_unavailable: no auth available (providers=myproxy)");
			}
			// Reaching any other provider (OpenAI) is the bug we are guarding against.
			throw new Error(`Unexpected compaction provider attempted: ${model.provider}/${model.id}`);
		});

		const error = await session.compact().catch(err => err);

		expect(error).toBeInstanceOf(Error);
		// Never attempted OpenAI.
		expect(compactSpy.mock.calls.some(([, model]) => model.provider === "openai")).toBe(false);
		expect(compactSpy.mock.calls.every(([, model]) => model.provider === "myproxy")).toBe(true);
		// Fails with a clear, provider-specific error pointing at the active route,
		// not a leaked auth_unavailable and not a silent OpenAI dependency.
		expect((error as Error).message).toContain(
			"Compaction requires usable credentials for myproxy/claude-sonnet-4-5",
		);
		expect((error as Error).message).not.toMatch(/auth_unavailable/i);
		expect((error as Error).message).not.toMatch(/openai/i);
	});

	it("still allows cross-provider compaction fallback when explicitly configured via modelRoles", async () => {
		const modelsPath = writeCustomProviderModels();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage, modelsPath);
		const configError = modelRegistry.getError();
		if (configError) throw new Error(`models config error: ${configError.message}`);

		const currentModel = modelRegistry.find("myproxy", "claude-sonnet-4-5");
		const roleFallback = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!currentModel || !roleFallback) throw new Error("expected test models to exist");

		const settings = Settings.isolated({ "compaction.keepRecentTokens": 1 });
		settings.setModelRole("default", `${roleFallback.provider}/${roleFallback.id}`);

		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model => {
			if (model.provider === "myproxy") return "myproxy-secret";
			if (model.provider === "anthropic") return "anthropic-token";
			return undefined;
		});
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([currentModel, roleFallback]);

		const agent = new Agent({
			initialState: { model: currentModel, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(() => {});
		seedConversation();

		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			if (model.provider === "myproxy") {
				throw new Error("Summarization failed: 503 auth_unavailable: no auth available (providers=myproxy)");
			}
			return {
				summary: "fallback summary",
				shortSummary: "fallback short",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 1,
				details: { provider: model.provider },
			};
		});

		const result = await session.compact();

		expect(result.summary).toBe("fallback summary");
		expect(compactSpy.mock.calls.map(([, model]) => `${model.provider}/${model.id}`)).toEqual([
			"myproxy/claude-sonnet-4-5",
			`${roleFallback.provider}/${roleFallback.id}`,
		]);
	});
});
