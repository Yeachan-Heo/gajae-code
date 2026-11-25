import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentOptions } from "@gajae-code/agent-core";
import { type AssistantMessage, getBundledModel, type Model } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import * as oauth from "@gajae-code/ai/utils/oauth";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

const PROVIDER = "anthropic";
const HOUR_MS = 3_600_000;

const TOKEN_EXPIRED = { status: 401, providerCode: "token_expired" } as const;
const FORBIDDEN = { status: 403, providerCode: "forbidden" } as const;

const selector = (model: Model) => `${model.provider}/${model.id}`;

function rejectedTokenStream(
	model: Model,
	failure: { status: number; providerCode: string } = TOKEN_EXPIRED,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
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
			stopReason: "error",
			errorMessage: `${failure.status} ${failure.providerCode}: the provider rejected the access token`,
			errorStatus: failure.status,
			timestamp: Date.now(),
			transportFailure: { kind: "transport", ...failure },
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "error", reason: "error", error: message });
	});
	return stream;
}

function successfulStream(model: Model): AssistantMessageEventStream {
	return createMockModel({ responses: [{ content: ["accepted"] }] }).stream(model, {
		systemPrompt: [],
		messages: [],
		tools: [],
	});
}

function lastAssistant(session: AgentSession): AssistantMessage | undefined {
	return session.agent.state.messages.findLast((message): message is AssistantMessage => message.role === "assistant");
}

/**
 * A provider can reject an OAuth access token before its recorded expiry
 * (server-side revocation or a shortened lifetime). Expiry-driven refresh never
 * fires for such a token, so the session must force one refresh of the row and
 * replay the content-free request on the new token within the same prompt.
 */
describe("AgentSession refreshes an OAuth access token the provider rejected early", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;
	let sentKeys: string[];
	let acceptedKeys: Set<string>;
	let model: Model;
	let failure: { status: number; providerCode: string };

	beforeEach(async () => {
		tempDir = TempDir.createSync("@oauth-rejected-token-refresh-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel(PROVIDER, "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled test model");
		model = bundled;
		sentKeys = [];
		acceptedKeys = new Set();
		failure = TOKEN_EXPIRED;
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		vi.spyOn(oauth, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { apiKey: credential.access, newCredentials: credential } : null;
		});
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	function createSession(fallback?: Model): AgentSession {
		const agent = new Agent({
			getApiKey: provider => {
				if (!session) throw new Error("Session not initialized");
				return modelRegistry.getApiKeyForProvider(provider, session.credentialSessionId);
			},
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: ((requestModel, _context, options) => {
				const key = String(options?.apiKey);
				sentKeys.push(key);
				return acceptedKeys.has(key) || requestModel.provider !== PROVIDER
					? successfulStream(requestModel)
					: rejectedTokenStream(requestModel, failure);
			}) satisfies AgentOptions["streamFn"],
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.baseDelayMs": 1 });
		if (fallback) settings.set("modelRoles", { default: [selector(model), selector(fallback)] });
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		return session;
	}

	async function storeOAuthRow(access: string): Promise<number> {
		await authStorage.set(PROVIDER, [
			{
				type: "oauth",
				access,
				refresh: `${access}-refresh`,
				// Still well inside its lifetime: only a provider rejection can trigger refresh.
				expires: Date.now() + HOUR_MS,
				accountId: "account-1",
			},
		]);
		const rowId = authStorage.listCredentialInventory(PROVIDER)[0]?.id;
		if (rowId === undefined) throw new Error("Expected a stored OAuth row");
		return rowId;
	}

	it("refreshes the row once and replays the request on the fresh token", async () => {
		const rowId = await storeOAuthRow("stale-access");
		acceptedKeys.add("fresh-access");
		const refresh = vi.spyOn(oauth, "refreshOAuthToken").mockResolvedValue({
			access: "fresh-access",
			refresh: "fresh-refresh",
			expires: Date.now() + HOUR_MS,
			accountId: "account-1",
		});
		const current = createSession();

		await current.prompt("hello");
		await current.waitForIdle();

		expect(refresh).toHaveBeenCalledTimes(1);
		expect(sentKeys).toEqual(["stale-access", "fresh-access"]);
		expect(lastAssistant(current)?.stopReason).not.toBe("error");
		expect(authStorage.isCredentialAvailable(PROVIDER, rowId)).toBe(true);
		await expect(modelRegistry.getApiKeyForProvider(PROVIDER, current.credentialSessionId)).resolves.toBe(
			"fresh-access",
		);
	});

	it("disables the row when the refresh fails with invalid_grant and does not replay", async () => {
		const rowId = await storeOAuthRow("stale-access");
		const refresh = vi
			.spyOn(oauth, "refreshOAuthToken")
			.mockRejectedValue(new Error("400 invalid_grant: refresh token has been revoked"));
		const current = createSession();

		await current.prompt("hello");
		await current.waitForIdle();

		expect(refresh).toHaveBeenCalledTimes(1);
		expect(sentKeys).toEqual(["stale-access"]);
		expect(lastAssistant(current)?.stopReason).toBe("error");
		expect(authStorage.isCredentialAvailable(PROVIDER, rowId)).toBe(false);
		// The provider now has no usable login: callers report missing credentials
		// instead of resending the rejected token.
		await expect(modelRegistry.getApiKeyForProvider(PROVIDER, current.credentialSessionId)).resolves.toBeUndefined();
	});

	it("does not refresh again when the fresh token is also rejected in the same prompt", async () => {
		const rowId = await storeOAuthRow("stale-access");
		let generation = 0;
		const refresh = vi.spyOn(oauth, "refreshOAuthToken").mockImplementation(async () => {
			generation++;
			return {
				access: `fresh-access-${generation}`,
				refresh: `fresh-refresh-${generation}`,
				expires: Date.now() + HOUR_MS,
				accountId: "account-1",
			};
		});
		const current = createSession();

		await current.prompt("hello");
		await current.waitForIdle();

		expect(refresh).toHaveBeenCalledTimes(1);
		expect(sentKeys).toEqual(["stale-access", "fresh-access-1"]);
		expect(lastAssistant(current)?.stopReason).toBe("error");

		// The once-per-row budget is per prompt: the next prompt may refresh again.
		acceptedKeys.add("fresh-access-2");
		const sentBeforeSecondPrompt = sentKeys.length;
		await current.prompt("again");
		await current.waitForIdle();

		expect(refresh).toHaveBeenCalledTimes(2);
		expect(sentKeys.slice(sentBeforeSecondPrompt)).toEqual(["fresh-access-1", "fresh-access-2"]);
		expect(lastAssistant(current)?.stopReason).not.toBe("error");
		expect(authStorage.isCredentialAvailable(PROVIDER, rowId)).toBe(true);
	});

	it("leaves an API-key row untouched on the same 401", async () => {
		await authStorage.set(PROVIDER, [{ type: "api_key", key: "static-api-key" }]);
		const rowId = authStorage.listCredentialInventory(PROVIDER)[0]?.id;
		if (rowId === undefined) throw new Error("Expected a stored API-key row");
		const refresh = vi.spyOn(oauth, "refreshOAuthToken");
		const refreshRejected = vi.spyOn(authStorage, "refreshRejectedOAuthCredential");
		const current = createSession();

		await current.prompt("hello");
		await current.waitForIdle();

		expect(refresh).not.toHaveBeenCalled();
		expect(refreshRejected).not.toHaveBeenCalled();
		expect(sentKeys).toEqual(["static-api-key"]);
		expect(lastAssistant(current)?.stopReason).toBe("error");
		expect(authStorage.isCredentialAvailable(PROVIDER, rowId)).toBe(true);
	});

	it("replays on the refreshed row instead of advancing a managed fallback chain", async () => {
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!fallback) throw new Error("Expected bundled fallback model");
		authStorage.setRuntimeApiKey("openai", "openai-key");
		await storeOAuthRow("stale-access");
		acceptedKeys.add("fresh-access");
		const refresh = vi.spyOn(oauth, "refreshOAuthToken").mockResolvedValue({
			access: "fresh-access",
			refresh: "fresh-refresh",
			expires: Date.now() + HOUR_MS,
			accountId: "account-1",
		});
		const current = createSession(fallback);

		await current.prompt("hello");
		await current.waitForIdle();

		expect(refresh).toHaveBeenCalledTimes(1);
		// No request reached the fallback model's key: the chain stayed on the refreshed row.
		expect(sentKeys).toEqual(["stale-access", "fresh-access"]);
		expect(current.model?.provider).toBe(PROVIDER);
		expect(lastAssistant(current)?.stopReason).not.toBe("error");
	});

	it("never refreshes on a terminal forbidden", async () => {
		const rowId = await storeOAuthRow("stale-access");
		failure = FORBIDDEN;
		const refresh = vi.spyOn(oauth, "refreshOAuthToken");
		const current = createSession();

		await current.prompt("hello");
		await current.waitForIdle();

		expect(refresh).not.toHaveBeenCalled();
		expect(sentKeys).toEqual(["stale-access"]);
		expect(lastAssistant(current)?.stopReason).toBe("error");
		expect(authStorage.isCredentialAvailable(PROVIDER, rowId)).toBe(true);
	});
});
