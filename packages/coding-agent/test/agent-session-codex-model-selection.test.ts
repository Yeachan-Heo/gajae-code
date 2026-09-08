import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import type { AssistantMessage, Model, UsageProvider } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import * as oauth from "@gajae-code/ai/utils/oauth";
import type { OAuthCredentials } from "@gajae-code/ai/utils/oauth/types";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";

const initialModel: Model = {
	id: "gpt-5.5",
	name: "GPT-5.5",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272_000,
	maxTokens: 128_000,
};

const selectedModel: Model = {
	...initialModel,
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
};

describe("AgentSession Codex model selection", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let usageFetches = 0;
	let streamCalls = 0;
	let failAfterRotation = false;

	const usageProvider: UsageProvider = {
		id: "openai-codex",
		async fetchUsage(params) {
			usageFetches += 1;
			return {
				provider: "openai-codex",
				fetchedAt: Date.now(),
				limits: [],
				metadata: { accountId: params.credential.accountId, planType: "plus" },
			};
		},
	};

	beforeEach(async () => {
		usageFetches = 0;
		streamCalls = 0;
		failAfterRotation = false;
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-codex-model-selection-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"), {
			usageProviderResolver: provider => (provider === "openai-codex" ? usageProvider : undefined),
		});
		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				access: "access-acct-plus",
				refresh: "refresh-acct-plus",
				expires: Date.now() + 60 * 60 * 1000,
				accountId: "acct-plus",
				email: "plus@example.com",
			},
		]);
		vi.spyOn(oauth, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials["openai-codex"] as OAuthCredentials | undefined;
			if (!credential) return null;
			return { apiKey: `api-${credential.accountId ?? "unknown"}`, newCredentials: credential };
		});

		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const agent = new Agent({
			initialState: { model: initialModel, systemPrompt: [], tools: [] },
			streamFn: model => {
				const call = ++streamCalls;
				const failed = call === 1 || failAfterRotation;
				const stream = new AssistantMessageEventStream();
				const message: AssistantMessage = {
					role: "assistant",
					content: failed ? [] : [{ type: "text", text: "rotated account succeeded" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: failed ? "error" : "stop",
					errorMessage: failed
						? "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account."
						: undefined,
					errorStatus: failed ? 400 : undefined,
					transportFailure: failed
						? {
								kind: "transport",
								status: 400,
								providerCode: "invalid_request_error",
								openaiErrorCode: "invalid_request_error",
								credentialModelUnavailable: true,
							}
						: undefined,
					timestamp: Date.now(),
				};
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					if (failed) stream.push({ type: "error", reason: "error", error: message });
					else stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		sessionManager = SessionManager.inMemory(tempDir);
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		vi.restoreAllMocks();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("allows a Plus-labeled credential to bind Sol so the provider can decide availability", async () => {
		await expect(session.setModel(selectedModel)).resolves.toBeUndefined();

		expect(session.model).toBe(selectedModel);
		expect(sessionManager.getEntries().filter(entry => entry.type === "model_change")).toHaveLength(1);
		expect(usageFetches).toBe(0);
	});

	test("retries once with the next unpinned OAuth credential after account-specific model rejection", async () => {
		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				access: "access-acct-first",
				refresh: "refresh-acct-first",
				expires: Date.now() + 60 * 60 * 1000,
				accountId: "acct-first",
				email: "first@example.com",
			},
			{
				type: "oauth",
				access: "access-acct-second",
				refresh: "refresh-acct-second",
				expires: Date.now() + 60 * 60 * 1000,
				accountId: "acct-second",
				email: "second@example.com",
			},
		]);
		await session.setModel(selectedModel);

		await expect(session.prompt("hello")).resolves.toBeUndefined();

		expect(streamCalls).toBe(2);
		expect(session.agent.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "rotated account succeeded" }],
		});
	});

	test("does not rotate again after the one account-specific rejection retry", async () => {
		failAfterRotation = true;
		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				access: "access-acct-first",
				refresh: "refresh-acct-first",
				expires: Date.now() + 60 * 60 * 1000,
				accountId: "acct-first",
				email: "first@example.com",
			},
			{
				type: "oauth",
				access: "access-acct-second",
				refresh: "refresh-acct-second",
				expires: Date.now() + 60 * 60 * 1000,
				accountId: "acct-second",
				email: "second@example.com",
			},
		]);
		await session.setModel(selectedModel);

		await expect(session.prompt("hello")).resolves.toBeUndefined();

		expect(streamCalls).toBe(2);
		expect(session.agent.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
		});
	});
});
