import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import type { Model, UsageProvider } from "@gajae-code/ai";
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

const solModel: Model = {
	...initialModel,
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
};

describe("AgentSession Codex model entitlement", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let sessionManager: SessionManager;

	const usageProvider: UsageProvider = {
		id: "openai-codex",
		async fetchUsage(params) {
			return {
				provider: "openai-codex",
				fetchedAt: Date.now(),
				limits: [],
				metadata: { accountId: params.credential.accountId, planType: "plus" },
			};
		},
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-codex-entitlement-"));
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
		const agent = new Agent({ initialState: { model: initialModel, systemPrompt: [], tools: [] } });
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

	test("binds Sol for a Plus-labelled account and defers entitlement to the provider", async () => {
		const entriesBefore = sessionManager.getEntries();

		await session.setModel(solModel);

		expect(session.model).toBe(solModel);
		expect(sessionManager.getEntries().length).toBeGreaterThan(entriesBefore.length);
	});
});
