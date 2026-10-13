import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import type { SimpleStreamOptions } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

const sessions: AgentSession[] = [];
const storages: AuthStorage[] = [];
const tempDirs: TempDir[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	for (const storage of storages.splice(0)) storage.close();
	for (const tempDir of tempDirs.splice(0)) tempDir.removeSync();
});

describe("AgentSession auth metadata owner boundary", () => {
	it("omits OAuth metadata when auth storage has a registry-scoped key but the facade has no owner accessor", async () => {
		const tempDir = TempDir.createSync("@gjc-auth-metadata-owner-");
		tempDirs.push(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		storages.push(authStorage);
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "stored-oauth-access",
				refresh: "stored-oauth-refresh",
				expires: Date.now() + 60 * 60_000,
				accountId: "stored-oauth-account",
			},
		]);
		const mock = createMockModel({ responses: [{ content: ["ok"] }] });
		Object.defineProperty(mock.model, "provider", { value: "anthropic" });
		Object.defineProperty(mock.model, "api", { value: "anthropic-messages" });
		Object.defineProperty(mock.model, "baseUrl", { value: "https://api.anthropic.com" });
		let requestOptions: SimpleStreamOptions | undefined;
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], messages: [], tools: [] },
			streamFn: (model, context, options) => {
				requestOptions = options;
				return mock.stream(model, context, options);
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {
				authStorage,
				// The facade delegates a registry-scoped API key, but intentionally
				// omits getAuthStorageOwner from its compatibility surface.
				getApiKey: async () => "registry-api-key",
				getAvailable: () => [mock.model],
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
		});
		sessions.push(session);

		await session.prompt("hello");

		expect(requestOptions?.metadata).toEqual({ user_id: JSON.stringify({ session_id: session.sessionId }) });
		expect(String(requestOptions?.metadata?.user_id)).not.toContain("account_uuid");
		expect(String(requestOptions?.metadata?.user_id)).not.toContain("device_id");
	});

	it("propagates account metadata when the real registry owner is available", async () => {
		const tempDir = TempDir.createSync("@gjc-auth-metadata-owner-positive-");
		tempDirs.push(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		storages.push(authStorage);
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "stored-oauth-access",
				refresh: "stored-oauth-refresh",
				expires: Date.now() + 60 * 60_000,
				accountId: "stored-oauth-account",
			},
		]);
		const owner = {};
		// A sibling owner override makes omission or replacement of the target
		// owner observable: unscoped metadata would see an API-key override.
		authStorage.setConfigApiKey("anthropic", "sibling-api-key", { owner: {} });
		const mock = createMockModel({ responses: [{ content: ["ok"] }] });
		Object.defineProperty(mock.model, "provider", { value: "anthropic" });
		Object.defineProperty(mock.model, "api", { value: "anthropic-messages" });
		Object.defineProperty(mock.model, "baseUrl", { value: "https://api.anthropic.com" });
		let requestOptions: SimpleStreamOptions | undefined;
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], messages: [], tools: [] },
			streamFn: (model, context, options) => {
				requestOptions = options;
				return mock.stream(model, context, options);
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {
				authStorage,
				getApiKey: async () => "stored-oauth-access",
				getAvailable: () => [mock.model],
				getAuthStorageOwner: () => owner,
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
		});
		sessions.push(session);

		await session.prompt("hello");

		const userId = JSON.parse(String(requestOptions?.metadata?.user_id)) as Record<string, string>;
		expect(userId).toMatchObject({ session_id: session.sessionId, account_uuid: "stored-oauth-account" });
		expect(userId.device_id).toMatch(/^[a-f0-9]{64}$/);
	});
});
