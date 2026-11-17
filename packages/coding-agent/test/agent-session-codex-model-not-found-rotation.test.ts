import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { type Model, streamSimple } from "@gajae-code/ai";
import * as oauth from "@gajae-code/ai/utils/oauth";
import type { OAuthCredentials } from "@gajae-code/ai/utils/oauth/types";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";

// The live Codex backend now labels the account-specific model rejection with
// `code=model_not_found` instead of `code=invalid_request_error`. The session must
// still rotate to the next unpinned OAuth account instead of ending the user turn.
const providerMessage = "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.";

const solModel: Model<"openai-codex-responses"> = {
	id: "gpt-6.1-sol",
	name: "GPT-6.1 Sol",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	preferWebsockets: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272_000,
	maxTokens: 128_000,
};

function codexToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

function completedSse(text: string): string {
	return `${[
		`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } })}`,
		`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
		`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}`,
		`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text }] } })}`,
		`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
	].join("\n\n")}\n\n`;
}

function modelNotFoundSse(): string {
	return `data: ${JSON.stringify({ type: "error", error: { code: "model_not_found", message: providerMessage } })}\n\n`;
}

describe("AgentSession Codex account rejection labelled model_not_found", () => {
	const originalFetch = global.fetch;
	const originalAgentDir = getAgentDir();
	let tempDir: string;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let requestAccounts: string[];
	// Which stored account is selected first is not part of this contract, so the
	// fixture rejects whichever account is asked first and admits a different one.
	let rejectAllAccounts: boolean;

	beforeEach(async () => {
		requestAccounts = [];
		rejectAllAccounts = false;
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-codex-model-not-found-"));
		setAgentDir(tempDir);
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
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
		vi.spyOn(oauth, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials["openai-codex"] as OAuthCredentials | undefined;
			if (!credential?.accountId) return null;
			return { apiKey: codexToken(credential.accountId), newCredentials: credential };
		});
		global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : input.toString();
			const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
			const accountId = headers.get("chatgpt-account-id") ?? "missing";
			// OAuth refresh and other side requests are outside this contract.
			if (url !== "https://chatgpt.com/backend-api/codex/responses") {
				return new Response("not found", { status: 404 });
			}
			requestAccounts.push(accountId);
			const entitled = !rejectAllAccounts && requestAccounts.length > 1 && accountId !== requestAccounts[0];
			const sse = entitled ? completedSse("rotated account succeeded") : modelNotFoundSse();
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as unknown as typeof fetch;

		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const agent = new Agent({
			initialState: { model: solModel, systemPrompt: [], tools: [] },
			// Resolve the credential per request the way the SDK does, so a rotation
			// that re-binds the session credential is what the next request carries.
			getApiKey: () => modelRegistry.getApiKey(solModel, session.credentialSessionId),
			// The real provider stream: the rejection must be classified by the Codex
			// provider itself, not by a hand-written transport fact in the fixture.
			streamFn: streamSimple,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.baseDelayMs": 1 }),
			modelRegistry,
		});
		await session.setModel(solModel);
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		global.fetch = originalFetch;
		setAgentDir(originalAgentDir);
		vi.restoreAllMocks();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("rotates to the next unpinned OAuth account instead of surfacing the rejection", async () => {
		await expect(session.prompt("hello")).resolves.toBeUndefined();

		expect(requestAccounts).toHaveLength(2);
		expect(new Set(requestAccounts)).toEqual(new Set(["acct-first", "acct-second"]));
		expect(session.agent.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "rotated account succeeded" }],
		});
	});

	test("stops after one rotation and surfaces the provider rejection when no account is entitled", async () => {
		rejectAllAccounts = true;

		await expect(session.prompt("hello")).resolves.toBeUndefined();

		expect(requestAccounts).toHaveLength(2);
		expect(new Set(requestAccounts)).toEqual(new Set(["acct-first", "acct-second"]));
		expect(session.agent.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: `Codex error event: ${providerMessage} (code=model_not_found)`,
		});
	});
});
