import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startAuthGateway } from "../src/auth-gateway/server";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import type { Api, Context, Model } from "../src/types";
import * as oauthUtils from "../src/utils/oauth";
import type { OAuthCredentials } from "../src/utils/oauth/types";

// Auth Gateway must back off a credential only for the model the provider
// rejected when the rejection is the Codex ChatGPT-account model refusal: the
// same account still serves other models. Quota and rate-limit failures keep
// their credential-wide backoff.

const provider = "openai-codex";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

function codexModel(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-codex-responses",
		provider,
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		preferWebsockets: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
	} as Model<Api>;
}

const rejectedModel = codexModel("gpt-6.1-sol");
const otherModel = codexModel("gpt-5.5");
const models = [rejectedModel, otherModel];
const providerMessage = "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.";
const context: Context = {
	systemPrompt: ["you are helpful"],
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
};

function codexToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

type UpstreamReply = "sse_model_not_found" | "http_model_not_found" | "http_rate_limit";

function upstreamResponse(reply: UpstreamReply): Response {
	if (reply === "sse_model_not_found") {
		return new Response(
			`data: ${JSON.stringify({ type: "error", error: { code: "model_not_found", message: providerMessage } })}\n\n`,
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
	}
	if (reply === "http_model_not_found") {
		return new Response(JSON.stringify({ error: { code: "model_not_found", message: providerMessage } }), {
			status: 404,
			headers: { "content-type": "application/json" },
		});
	}
	return new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "Rate limit reached" } }), {
		status: 429,
		headers: { "content-type": "application/json", "retry-after": "60" },
	});
}

describe("auth-gateway Codex account-model rejection backoff scope", () => {
	const realFetch = globalThis.fetch;
	let tempDir = "";
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;
	let reply: UpstreamReply;
	let upstreamAccounts: string[];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-gateway-codex-scope-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "auth.db"));
		storage = new AuthStorage(store);
		await storage.set(
			provider,
			["acct-first", "acct-second"].map(accountId => ({
				type: "oauth" as const,
				access: codexToken(accountId),
				refresh: `refresh-${accountId}`,
				expires: Date.now() + 60 * 60 * 1000,
				accountId,
			})),
		);
		upstreamAccounts = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = Object.values(credentials)[0] as OAuthCredentials | undefined;
			return credential ? { apiKey: credential.access, newCredentials: credential } : null;
		});
		globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : input.toString();
			if (url === CODEX_RESPONSES_URL) {
				const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
				upstreamAccounts.push(headers.get("chatgpt-account-id") ?? "missing");
				return upstreamResponse(reply);
			}
			if (url.startsWith("https://")) return new Response("not found", { status: 404 });
			return realFetch(input, init);
		}) as unknown as typeof fetch;
	});

	afterEach(async () => {
		globalThis.fetch = realFetch;
		vi.restoreAllMocks();
		store.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	async function requestThroughGateway(options: { fallbackManaged: boolean }): Promise<number> {
		const gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			providerScope: { provider },
			bearerTokens: ["gateway-test-token"],
			version: "test",
			storage,
			hasProviderCredential: () => storage.exportSnapshot().credentials.some(entry => entry.provider === provider),
			reloadProviderCredentials: () => storage.reload(),
			validateProviderCredential: (candidateProvider: string, apiKey: string) =>
				storage
					.exportSnapshot()
					.credentials.some(
						entry =>
							entry.provider === candidateProvider &&
							entry.credential.type === "oauth" &&
							entry.credential.access === apiKey,
					),
			resolveModel: id => models.find(model => model.id === id),
			listModels: () => models,
		});
		try {
			const response = await realFetch(`${gateway.url}/v1/pi/stream`, {
				method: "POST",
				headers: { Authorization: "Bearer gateway-test-token", "Content-Type": "application/json" },
				body: JSON.stringify({
					modelId: rejectedModel.id,
					context,
					stream: true,
					options: options.fallbackManaged ? { fallbackManaged: true } : {},
				}),
			});
			await response.text();
		} finally {
			await gateway.close();
		}
		expect(upstreamAccounts).toHaveLength(1);
		const rejectedRow = store
			.listAuthCredentials(provider)
			.find(row => row.credential.type === "oauth" && row.credential.accountId === upstreamAccounts[0]);
		if (!rejectedRow) throw new Error(`No stored row for upstream account ${upstreamAccounts[0]}`);
		return rejectedRow.id;
	}

	it.each([
		["unmanaged", "SSE error event", false, "sse_model_not_found"],
		["unmanaged", "HTTP 404", false, "http_model_not_found"],
		["managed", "SSE error event", true, "sse_model_not_found"],
		["managed", "HTTP 404", true, "http_model_not_found"],
	] as const)("%s gateway path scopes a %s model_not_found ChatGPT-account rejection to the rejected model", async (_path, _shape, fallbackManaged, upstreamReply) => {
		reply = upstreamReply;
		const rowId = await requestThroughGateway({ fallbackManaged });

		expect(storage.isCredentialAvailable(provider, rowId, rejectedModel.id)).toBe(false);
		expect(storage.isCredentialAvailable(provider, rowId, otherModel.id)).toBe(true);
	});

	it("managed gateway path keeps a rate-limit backoff credential-wide", async () => {
		reply = "http_rate_limit";
		const rowId = await requestThroughGateway({ fallbackManaged: true });

		expect(storage.isCredentialAvailable(provider, rowId, rejectedModel.id)).toBe(false);
		expect(storage.isCredentialAvailable(provider, rowId, otherModel.id)).toBe(false);
	});
});
