import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@gajae-code/agent-core";
import * as compactionModule from "@gajae-code/agent-core/compaction";
import { getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { logger, TempDir } from "@gajae-code/utils";
import { assistantMsg, userMsg } from "./utilities";

const USAGE_LIMIT =
	"Summarization failed: Codex error event: The usage limit has been reached (code=usage_limit_reached)";
const MAX_RETRIES = 2;

/**
 * Auto-compaction used to retry a usage-limited credential row until its retries ran
 * out, even with healthy rows stored for the same provider. Compaction gates the next
 * request, so the turn path's credential rotation was never reached and the session
 * stalled until it was restarted in a fresh process.
 */
describe("auto-compaction usage limit rotates the session credential", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@compaction-usage-limit-rotation-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		// Stored rows, deliberately NO runtime API key: a runtime override counts as a
		// pin and suppresses rotation.
		await authStorage.set("openai-codex", [
			{ type: "api_key", key: "codex-key-1" },
			{ type: "api_key", key: "codex-key-2" },
		]);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
		authStorage.close();
		tempDir.removeSync();
	});

	function createSession(credentialSessionId?: string): AgentSession {
		const model = getBundledModel("openai-codex", "gpt-5.4-mini");
		if (!model) throw new Error("Expected bundled test model");
		const settings = Settings.isolated({
			"compaction.keepRecentTokens": 1,
			"retry.maxRetries": MAX_RETRIES,
			"retry.baseDelayMs": 1,
		});
		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		const created = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			credentialSessionId,
		});
		for (const [userText, assistantText] of [
			["first question", "first answer"],
			["second question", "second answer"],
		] as const) {
			const user = userMsg(userText);
			const assistant = assistantMsg(assistantText);
			created.agent.appendMessage(user);
			created.sessionManager.appendMessage(user);
			created.agent.appendMessage(assistant);
			created.sessionManager.appendMessage(assistant);
		}
		return created;
	}

	function collectCompactionEnds(target: AgentSession): Array<{ errorMessage?: string; result?: unknown }> {
		const ends: Array<{ errorMessage?: string; result?: unknown }> = [];
		target.subscribe(event => {
			if (event.type === "auto_compaction_end") ends.push(event as (typeof ends)[number]);
		});
		return ends;
	}

	function stubCompact(usageLimited: (apiKey: string, firstKey: string) => boolean) {
		let firstKey: string | undefined;
		return vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model, apiKey) => {
			firstKey ??= apiKey;
			if (usageLimited(apiKey, firstKey)) throw new Error(USAGE_LIMIT);
			return {
				summary: `summary via ${apiKey}`,
				shortSummary: "short",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 42,
				details: { provider: model.provider },
			};
		});
	}

	it("retries on another stored row instead of the exhausted one", async () => {
		session = createSession();
		const ends = collectCompactionEnds(session);
		const compactSpy = stubCompact((apiKey, firstKey) => apiKey === firstKey);
		const markUsageLimitReached = vi.spyOn(authStorage, "markUsageLimitReached");

		await session.runIdleCompaction();

		const keys = compactSpy.mock.calls.map(call => call[2]);
		expect(keys).toHaveLength(2);
		expect(keys[1]).not.toBe(keys[0]);
		expect(markUsageLimitReached).toHaveBeenCalledTimes(1);
		expect(markUsageLimitReached.mock.calls[0]?.[2]?.signal).toBeInstanceOf(AbortSignal);
		expect(markUsageLimitReached.mock.calls[0]?.[2]?.signal).toBe(compactSpy.mock.calls[0]?.[4]);
		expect(ends).toHaveLength(1);
		expect(ends[0]?.errorMessage).toBeUndefined();
		expect(ends[0]?.result).toBeDefined();
	});

	it("rotates to a credential inserted while the failed row is being marked", async () => {
		await authStorage.set("openai-codex", [{ type: "api_key", key: "codex-key-1" }]);
		const failedRow = authStorage
			.exportSnapshot()
			.credentials.find(
				entry =>
					entry.provider === "openai-codex" &&
					entry.credential.type === "api_key" &&
					entry.credential.key === "codex-key-1",
			);
		if (!failedRow) throw new Error("test setup did not create the failed credential row");
		session = createSession();
		session.settings.set("retry.enabled", false);
		session.settings.set("retry.maxRetries", 0);
		const markFailedRow = authStorage.markUsageLimitReached.bind(authStorage);
		const markUsageLimitReached = vi.spyOn(authStorage, "markUsageLimitReached");
		markUsageLimitReached.mockImplementation(async (provider, sessionId, options) => {
			const result = await markFailedRow(provider, sessionId, options);
			if (options?.rowId === failedRow.id) {
				await authStorage.set("openai-codex", [
					{ type: "api_key", key: "codex-key-1" },
					{ type: "api_key", key: "codex-key-2" },
				]);
			}
			return result;
		});
		const ends = collectCompactionEnds(session);
		const compactSpy = stubCompact(apiKey => apiKey === "codex-key-1");

		await session.runIdleCompaction();

		expect(markUsageLimitReached.mock.calls.map(call => call[2]?.rowId)).toEqual([failedRow.id]);
		const insertedRow = authStorage
			.exportSnapshot()
			.credentials.find(
				entry =>
					entry.provider === "openai-codex" &&
					entry.credential.type === "api_key" &&
					entry.credential.key === "codex-key-2",
			);
		expect(insertedRow).toBeDefined();
		if (!insertedRow) throw new Error("test setup did not retain the inserted credential row");
		expect(authStorage.isCredentialAvailable("openai-codex", insertedRow.id)).toBe(true);
		expect(compactSpy.mock.calls.map(call => call[2])).toEqual(["codex-key-1", "codex-key-2"]);
		expect(ends).toHaveLength(1);
		expect(ends[0]?.errorMessage).toBeUndefined();
		expect(ends[0]?.result).toBeDefined();
	});

	it("rotates a stored row when an env-sourced config key is also configured", async () => {
		let credentialSessionId: string | undefined;
		for (let index = 0; index < 100; index++) {
			const candidate = `compaction-env-config-${index}`;
			if (Bun.hash.xxHash32(candidate) % 2 === 0) {
				credentialSessionId = candidate;
				break;
			}
		}
		if (credentialSessionId === undefined) throw new Error("expected a session seed selecting the first credential");
		session = createSession(credentialSessionId);
		authStorage.setConfigApiKey("openai-codex", "env-configured-key", {
			envSourced: true,
			owner: session.modelRegistry.getAuthStorageOwner(),
		});
		expect(authStorage.hasLiteralConfigApiKey("openai-codex", session.modelRegistry.getAuthStorageOwner())).toBe(
			false,
		);
		const model = getBundledModel("openai-codex", "gpt-5.4-mini");
		if (!model) throw new Error("Expected bundled test model");
		const initial = await session.modelRegistry.getApiKeyWithCredentialRowId(model, credentialSessionId);
		expect(initial.apiKey).toBe("codex-key-1");
		expect(initial.credentialRowId).toBeDefined();
		const matchingRows = vi.spyOn(authStorage, "getCredentialRowIdsMatchingApiKey");
		const markUsageLimitReached = vi.spyOn(authStorage, "markUsageLimitReached");
		const ends = collectCompactionEnds(session);
		const compactSpy = stubCompact((apiKey, firstKey) => apiKey === firstKey);

		await session.runIdleCompaction();

		const keys = compactSpy.mock.calls.map(call => call[2]);
		expect(matchingRows).toHaveBeenCalled();
		expect(markUsageLimitReached).toHaveBeenCalledTimes(1);
		expect(keys).toEqual(["codex-key-1", "codex-key-2"]);
		expect(ends).toHaveLength(1);
		expect(ends[0]?.errorMessage).toBeUndefined();
		expect(ends[0]?.result).toBeDefined();
	});

	it("falls back to the retry policy when an alternate credential resolver rejects", async () => {
		authStorage.close();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"), {
			configValueResolver: async config => {
				if (config === "codex-key-2") throw new Error("sibling resolver failure");
				return config;
			},
		});
		await authStorage.set("openai-codex", [
			{ type: "api_key", key: "codex-key-1" },
			{ type: "api_key", key: "codex-key-2" },
		]);
		const dispatchedRow = authStorage
			.exportSnapshot()
			.credentials.find(
				entry =>
					entry.provider === "openai-codex" &&
					entry.credential.type === "api_key" &&
					entry.credential.key === "codex-key-1",
			);
		if (!dispatchedRow) throw new Error("test setup did not create the dispatched credential");
		let credentialSessionId: string | undefined;
		for (let index = 0; index < 100; index++) {
			const candidate = `compaction-resolver-retry-${index}`;
			try {
				const resolved = await authStorage.getApiKeyWithCredentialRowId("openai-codex", candidate);
				if (resolved.apiKey === "codex-key-1" && resolved.credentialRowId === dispatchedRow.id) {
					credentialSessionId = candidate;
					break;
				}
			} catch {
				// This candidate selected the deliberately rejecting sibling.
			}
		}
		if (credentialSessionId === undefined) throw new Error("expected a session seed selecting the healthy first row");
		session = createSession(credentialSessionId);
		const ends = collectCompactionEnds(session);
		const compactSpy = stubCompact(() => true);

		await session.runIdleCompaction();

		const keys = compactSpy.mock.calls.map(call => call[2]);
		expect(keys).toEqual(Array(MAX_RETRIES + 1).fill("codex-key-1"));
		expect(ends).toHaveLength(1);
		expect(ends[0]?.errorMessage).toContain("usage limit has been reached");
	});

	it("continues past an unrelated stored credential resolver rejection during rotation", async () => {
		authStorage.close();
		let siblingResolverCalls = 0;
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"), {
			configValueResolver: async config => {
				if (config === "codex-key-2") {
					siblingResolverCalls++;
					throw new Error("sibling resolver failure");
				}
				return config;
			},
		});
		await authStorage.set("openai-codex", [
			{ type: "api_key", key: "codex-key-1" },
			{ type: "api_key", key: "codex-key-2" },
			{ type: "api_key", key: "codex-key-3" },
		]);
		const credentials = authStorage
			.exportSnapshot()
			.credentials.filter(entry => entry.provider === "openai-codex" && entry.credential.type === "api_key");
		const dispatchedRow = credentials.find(
			entry => entry.credential.type === "api_key" && entry.credential.key === "codex-key-1",
		);
		const siblingRow = credentials.find(
			entry => entry.credential.type === "api_key" && entry.credential.key === "codex-key-2",
		);
		if (!dispatchedRow || !siblingRow) throw new Error("test setup did not create the expected credentials");
		const credentialSessionId = "compaction-resolver-isolation-0";
		session = createSession(credentialSessionId);
		const ends = collectCompactionEnds(session);
		const compactSpy = stubCompact((apiKey, firstKey) => apiKey === firstKey);
		const markUsageLimitReached = vi.spyOn(authStorage, "markUsageLimitReached");
		const warning = vi.spyOn(logger, "warn");

		await session.runIdleCompaction();

		expect(siblingResolverCalls).toBe(2);
		expect(compactSpy.mock.calls[0]?.[2]).toBe("codex-key-1");
		expect(markUsageLimitReached).toHaveBeenCalledTimes(1);
		expect(markUsageLimitReached.mock.calls[0]?.[2]?.rowId).toBe(dispatchedRow.id);
		expect(warning).toHaveBeenCalledWith("Failed to resolve stored API key while matching credential rows", {
			provider: "openai-codex",
			credentialId: siblingRow.id,
			errorType: "Error",
		});
		expect(compactSpy.mock.calls).toHaveLength(2);
		expect(compactSpy.mock.calls[1]?.[2]).toBe("codex-key-3");
		expect(warning).toHaveBeenCalledWith("Failed to resolve stored credential while rotating auto-compaction", {
			provider: "openai-codex",
			credentialId: siblingRow.id,
			errorType: "Error",
		});
		expect(ends).toHaveLength(1);
		expect(ends[0]?.errorMessage).toBeUndefined();
		expect(ends[0]?.result).toBeDefined();
	});

	it("continues preflight selection after a peer resolver rejects", async () => {
		authStorage.close();
		let rejectedPeerKey: string | undefined;
		let rejectPeerResolution = false;
		let rejectedResolverCalls = 0;
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"), {
			configValueResolver: async config => {
				if (rejectPeerResolution && config === rejectedPeerKey) {
					rejectedResolverCalls++;
					throw new Error("preflight peer resolver failure");
				}
				return config;
			},
		});
		await authStorage.set("openai-codex", [
			{ type: "api_key", key: "codex-key-1" },
			{ type: "api_key", key: "codex-key-2" },
			{ type: "api_key", key: "codex-key-3" },
		]);
		const credentialSessionId = "compaction-preflight-resolver-rejection";
		session = createSession(credentialSessionId);
		let failedRowId: number | undefined;
		let rejectedPeerRowId: number | undefined;
		let healthyPeerKey: string | undefined;
		let appliedBackoff = false;
		const markUsageLimitReached = vi.spyOn(authStorage, "markUsageLimitReached");
		const markFailedRow = authStorage.markUsageLimitReached.bind(authStorage);
		const resolveApiKey = session.modelRegistry.getApiKeyWithCredentialRowId.bind(session.modelRegistry);
		vi.spyOn(session.modelRegistry, "getApiKeyWithCredentialRowId").mockImplementation(
			async (candidate, sessionId, options) => {
				const resolved = await resolveApiKey(candidate, sessionId, options);
				if (
					!appliedBackoff &&
					options?.credentialSelector === undefined &&
					resolved.credentialRowId !== undefined
				) {
					appliedBackoff = true;
					failedRowId = resolved.credentialRowId;
					const peers = authStorage
						.exportSnapshot()
						.credentials.filter(entry => entry.provider === "openai-codex" && entry.id !== failedRowId);
					const rejectedPeer = peers[0];
					const healthyPeer = peers[1];
					if (rejectedPeer?.credential.type !== "api_key" || healthyPeer?.credential.type !== "api_key") {
						throw new Error("test setup did not find two API-key peers");
					}
					rejectedPeerKey = rejectedPeer.credential.key;
					rejectedPeerRowId = rejectedPeer.id;
					healthyPeerKey = healthyPeer.credential.key;
					await markFailedRow(candidate.provider, credentialSessionId, {
						rowId: resolved.credentialRowId,
						retryAfterMs: 60_000,
					});
					rejectPeerResolution = true;
				}
				return resolved;
			},
		);
		const warning = vi.spyOn(logger, "warn");
		const compactSpy = stubCompact(() => false);

		await session.runIdleCompaction();

		expect(appliedBackoff).toBe(true);
		expect(failedRowId).toBeDefined();
		expect(rejectedPeerRowId).toBeDefined();
		expect(healthyPeerKey).toBeDefined();
		expect(rejectedResolverCalls).toBe(1);
		if (healthyPeerKey === undefined) throw new Error("test setup did not select a healthy peer");
		expect(compactSpy.mock.calls).toHaveLength(1);
		expect(compactSpy.mock.calls[0]?.[2]).toBe(healthyPeerKey);
		expect(markUsageLimitReached).toHaveBeenCalledTimes(1);
		expect(markUsageLimitReached.mock.calls[0]?.[2]?.rowId).toBe(failedRowId);
		expect(warning).toHaveBeenCalledWith(
			"Failed to resolve stored credential while selecting auto-compaction candidate",
			{
				provider: "openai-codex",
				credentialId: rejectedPeerRowId,
				errorType: "Error",
			},
		);
	});

	it("honors a session credential selector installed during preflight peer resolution", async () => {
		authStorage.close();
		let blockPeerResolution = false;
		let peerKeyToBlock: string | undefined;
		const peerResolutionStarted = Promise.withResolvers<void>();
		const releasePeerResolution = Promise.withResolvers<void>();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"), {
			configValueResolver: async config => {
				if (blockPeerResolution && config === peerKeyToBlock) {
					peerResolutionStarted.resolve();
					await releasePeerResolution.promise;
				}
				return config;
			},
		});
		await authStorage.set("openai-codex", [
			{ type: "api_key", key: "codex-key-1" },
			{ type: "api_key", key: "codex-key-2" },
			{ type: "api_key", key: "codex-key-3" },
		]);
		const credentialSessionId = "compaction-preflight-pin-race";
		session = createSession(credentialSessionId);
		const credentials = authStorage
			.exportSnapshot()
			.credentials.filter(entry => entry.provider === "openai-codex" && entry.credential.type === "api_key");
		const markUsageLimitReached = vi.spyOn(authStorage, "markUsageLimitReached");
		const markFailedRow = authStorage.markUsageLimitReached.bind(authStorage);
		let failedRowId: number | undefined;
		let pinnedRowId: number | undefined;
		let pinnedPeerKey: string | undefined;
		let appliedBackoff = false;
		const resolveApiKey = session.modelRegistry.getApiKeyWithCredentialRowId.bind(session.modelRegistry);
		vi.spyOn(session.modelRegistry, "getApiKeyWithCredentialRowId").mockImplementation(
			async (candidate, sessionId, options) => {
				const resolved = await resolveApiKey(candidate, sessionId, options);
				if (
					!appliedBackoff &&
					options?.credentialSelector === undefined &&
					resolved.credentialRowId !== undefined
				) {
					appliedBackoff = true;
					failedRowId = resolved.credentialRowId;
					const peers = credentials.filter(entry => entry.id !== failedRowId);
					const firstPeer = peers[0];
					const pinnedPeer = peers[1];
					if (firstPeer?.credential.type !== "api_key" || pinnedPeer?.credential.type !== "api_key") {
						throw new Error("test setup did not find two API-key peers");
					}
					peerKeyToBlock = firstPeer.credential.key;
					pinnedRowId = pinnedPeer.id;
					pinnedPeerKey = pinnedPeer.credential.key;
					await markFailedRow(candidate.provider, credentialSessionId, {
						rowId: resolved.credentialRowId,
						retryAfterMs: 60_000,
					});
					blockPeerResolution = true;
				}
				return resolved;
			},
		);
		const compactSpy = stubCompact(() => false);

		const compaction = session.runIdleCompaction();
		await peerResolutionStarted.promise;
		try {
			if (pinnedRowId === undefined) throw new Error("test setup did not select a pin target");
			authStorage.setSessionCredentialSelector(
				credentialSessionId,
				"openai-codex",
				{ kind: "id", value: String(pinnedRowId) },
				session.modelRegistry.getAuthStorageOwner(),
			);
		} finally {
			releasePeerResolution.resolve();
		}
		await compaction;

		expect(appliedBackoff).toBe(true);
		expect(failedRowId).toBeDefined();
		expect(pinnedRowId).toBeDefined();
		expect(pinnedRowId).not.toBe(failedRowId);
		expect(pinnedPeerKey).toBeDefined();
		if (pinnedPeerKey === undefined) throw new Error("test setup did not select a pin target");
		expect(compactSpy.mock.calls.map(call => call[2])).toEqual([pinnedPeerKey]);
		expect(markUsageLimitReached).toHaveBeenCalledTimes(1);
		expect(markUsageLimitReached.mock.calls[0]?.[2]?.rowId).toBe(failedRowId);
	});

	it("rotates stored credentials even when automatic retries are disabled", async () => {
		session = createSession();
		session.settings.set("retry.enabled", false);
		session.settings.set("retry.maxRetries", 0);
		const ends = collectCompactionEnds(session);
		const compactSpy = stubCompact((apiKey, firstKey) => apiKey === firstKey);

		await session.runIdleCompaction();

		const keys = compactSpy.mock.calls.map(call => call[2]);
		expect(keys).toHaveLength(2);
		expect(keys[1]).not.toBe(keys[0]);
		expect(ends).toHaveLength(1);
		expect(ends[0]?.errorMessage).toBeUndefined();
		expect(ends[0]?.result).toBeDefined();
	});

	it("marks the credential used when a sibling advances the session pointer during key resolution", async () => {
		session = createSession();
		const credentialIds = authStorage
			.exportSnapshot()
			.credentials.filter(entry => entry.provider === "openai-codex")
			.map(entry => entry.id);
		const resolveApiKey = authStorage.getApiKeyWithCredentialRowId.bind(authStorage);
		let selectedRowId: number | undefined;
		let siblingRowId: number | undefined;
		let pointerAtDispatch: number | undefined;
		let advancedDuringResolution = false;
		let calls = 0;
		const markUsageLimitReached = vi.spyOn(authStorage, "markUsageLimitReached");
		vi.spyOn(authStorage, "getApiKeyWithCredentialRowId").mockImplementation(async (provider, sessionId, options) => {
			const resolved = await resolveApiKey(provider, sessionId, options);
			if (!advancedDuringResolution && provider === "openai-codex" && options?.credentialSelector === undefined) {
				advancedDuringResolution = true;
				selectedRowId = resolved.credentialRowId;
				siblingRowId = credentialIds.find(rowId => rowId !== selectedRowId);
				if (selectedRowId === undefined || siblingRowId === undefined) {
					throw new Error("expected two stored credentials and a selected compaction credential");
				}
				await authStorage.getApiKey(provider, sessionId, {
					credentialSelector: { kind: "id", value: String(siblingRowId) },
				});
			}
			return resolved;
		});
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			if (calls++ === 0) {
				pointerAtDispatch = authStorage.getSessionCredentialRowId(model.provider, session?.credentialSessionId);
				throw new Error(USAGE_LIMIT);
			}
			return {
				summary: "summary via sibling",
				shortSummary: "short",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 42,
				details: { provider: model.provider },
			};
		});

		await session.runIdleCompaction();

		expect(advancedDuringResolution).toBe(true);
		expect(pointerAtDispatch).toBe(siblingRowId);
		expect(compactSpy.mock.calls).toHaveLength(2);
		expect(compactSpy.mock.calls[1]?.[2]).not.toBe(compactSpy.mock.calls[0]?.[2]);
		expect(markUsageLimitReached).toHaveBeenCalledTimes(1);
		expect(markUsageLimitReached.mock.calls[0]?.[2]?.rowId).toBe(selectedRowId);
	});

	it("marks the dispatched row when its current key no longer matches storage", async () => {
		session = createSession();
		const resolveApiKey = session.modelRegistry.getApiKeyWithCredentialRowId.bind(session.modelRegistry);
		let dispatchedRowId: number | undefined;
		vi.spyOn(session.modelRegistry, "getApiKeyWithCredentialRowId").mockImplementation(
			async (model, sessionId, options) => {
				const resolved = await resolveApiKey(model, sessionId, options);
				if (model.provider === "openai-codex" && options?.credentialSelector === undefined) {
					dispatchedRowId = resolved.credentialRowId;
				}
				return resolved;
			},
		);
		const matchRows = vi.spyOn(authStorage, "getCredentialRowIdsMatchingApiKey").mockResolvedValue([]);
		const markUsageLimitReached = vi.spyOn(authStorage, "markUsageLimitReached");
		const compactSpy = stubCompact((apiKey, firstKey) => apiKey === firstKey);

		await session.runIdleCompaction();

		expect(dispatchedRowId).toBeDefined();
		expect(matchRows).toHaveBeenCalledTimes(1);
		expect(compactSpy.mock.calls).toHaveLength(2);
		expect(markUsageLimitReached).toHaveBeenCalledTimes(1);
		expect(markUsageLimitReached.mock.calls[0]?.[2]?.rowId).toBe(dispatchedRowId);
	});

	it("tries each row once, then falls back to the retry policy and stops", async () => {
		session = createSession();
		const ends = collectCompactionEnds(session);
		const compactSpy = stubCompact(() => true);

		await session.runIdleCompaction();

		const keys = compactSpy.mock.calls.map(call => call[2]);
		expect(new Set(keys)).toEqual(new Set(["codex-key-1", "codex-key-2"]));
		expect(keys.length).toBeLessThanOrEqual(2 + MAX_RETRIES);
		expect(ends).toHaveLength(1);
		expect(ends[0]?.errorMessage).toContain("usage limit has been reached");
	});

	it("continues past an already-failed row whose backoff expires", async () => {
		await authStorage.set("openai-codex", [
			{ type: "api_key", key: "codex-key-1" },
			{ type: "api_key", key: "codex-key-2" },
			{ type: "api_key", key: "codex-key-3" },
		]);
		const firstRow = authStorage
			.exportSnapshot()
			.credentials.find(
				entry =>
					entry.provider === "openai-codex" &&
					entry.credential.type === "api_key" &&
					entry.credential.key === "codex-key-1",
			);
		if (!firstRow) throw new Error("test setup did not create the first credential");
		let credentialSessionId: string | undefined;
		for (let index = 0; index < 100; index++) {
			const candidate = `compaction-expired-backoff-${index}`;
			const initial = await authStorage.getApiKeyWithCredentialRowId("openai-codex", candidate);
			if (initial.apiKey === "codex-key-1" && initial.credentialRowId === firstRow.id) {
				credentialSessionId = candidate;
				break;
			}
		}
		if (credentialSessionId === undefined) throw new Error("expected a session seed selecting the first credential");
		session = createSession(credentialSessionId);
		const ends = collectCompactionEnds(session);
		// Expire each row immediately so the first failed row reappears ahead of the
		// healthy third row when the second row fails.
		const markUsageLimitReached = authStorage.markUsageLimitReached.bind(authStorage);
		vi.spyOn(authStorage, "markUsageLimitReached").mockImplementation((provider, sessionId, options) =>
			markUsageLimitReached(provider, sessionId, { ...options, retryAfterMs: 0 }),
		);
		const compactSpy = stubCompact(apiKey => apiKey !== "codex-key-3");

		await session.runIdleCompaction();

		expect(compactSpy.mock.calls.map(call => call[2])).toEqual(["codex-key-1", "codex-key-2", "codex-key-3"]);
		expect(ends).toHaveLength(1);
		expect(ends[0]?.errorMessage).toBeUndefined();
		expect(ends[0]?.result).toBeDefined();
	});

	it("stays within the retry policy when two stored rows resolve to the same key", async () => {
		// Two env references to one secret: matching the failed key back to a row always
		// finds the first row, so both rows must be marked before the retry policy takes over.
		const previousA = process.env.GJC_TEST_COMPACTION_DUP_KEY_A;
		const previousB = process.env.GJC_TEST_COMPACTION_DUP_KEY_B;
		process.env.GJC_TEST_COMPACTION_DUP_KEY_A = "codex-dup-secret";
		process.env.GJC_TEST_COMPACTION_DUP_KEY_B = "codex-dup-secret";
		try {
			await authStorage.set("openai-codex", [
				{ type: "api_key", key: "GJC_TEST_COMPACTION_DUP_KEY_A" },
				{ type: "api_key", key: "GJC_TEST_COMPACTION_DUP_KEY_B" },
			]);
			const duplicateRowIds = await authStorage.getCredentialRowIdsMatchingApiKey(
				"openai-codex",
				"codex-dup-secret",
			);
			session = createSession();
			const markUsageLimitReached = vi.spyOn(authStorage, "markUsageLimitReached");
			const ends = collectCompactionEnds(session);
			let calls = 0;
			const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async () => {
				calls++;
				// Bound a regression to a fast failure instead of an endless retry.
				if (calls > 10) throw new Error("test bound: compaction kept resubmitting the same key");
				throw new Error(USAGE_LIMIT);
			});

			await session.runIdleCompaction();

			expect(duplicateRowIds).toHaveLength(2);
			expect(compactSpy.mock.calls.every(call => call[2] === "codex-dup-secret")).toBe(true);
			expect(compactSpy.mock.calls.length).toBe(1 + MAX_RETRIES);
			expect(new Set(markUsageLimitReached.mock.calls.map(call => call[2]?.rowId))).toEqual(
				new Set(duplicateRowIds),
			);
			expect(duplicateRowIds.every(rowId => !authStorage.isCredentialAvailable("openai-codex", rowId))).toBe(true);
			expect(ends[0]?.errorMessage).toContain("usage limit has been reached");

			const callsBeforeLaterCompaction = compactSpy.mock.calls.length;
			await session.runIdleCompaction();

			expect(compactSpy.mock.calls).toHaveLength(callsBeforeLaterCompaction);
			expect(ends).toHaveLength(2);
			expect(ends[1]?.errorMessage).toContain("No available stored credential");
		} finally {
			if (previousA === undefined) delete process.env.GJC_TEST_COMPACTION_DUP_KEY_A;
			else process.env.GJC_TEST_COMPACTION_DUP_KEY_A = previousA;
			if (previousB === undefined) delete process.env.GJC_TEST_COMPACTION_DUP_KEY_B;
			else process.env.GJC_TEST_COMPACTION_DUP_KEY_B = previousB;
		}
	});

	it("rotates past duplicate rows that resolve to the same key", async () => {
		const previousA = process.env.GJC_TEST_COMPACTION_DUP_KEY_A;
		const previousB = process.env.GJC_TEST_COMPACTION_DUP_KEY_B;
		process.env.GJC_TEST_COMPACTION_DUP_KEY_A = "codex-dup-secret";
		process.env.GJC_TEST_COMPACTION_DUP_KEY_B = "codex-dup-secret";
		try {
			await authStorage.set("openai-codex", [
				{ type: "api_key", key: "GJC_TEST_COMPACTION_DUP_KEY_A" },
				{ type: "api_key", key: "GJC_TEST_COMPACTION_DUP_KEY_B" },
				{ type: "api_key", key: "codex-key-3" },
			]);
			let credentialSessionId: string | undefined;
			for (let index = 0; index < 100; index++) {
				const candidate = `duplicate-key-session-${index}`;
				if (Bun.hash.xxHash32(candidate) % 3 < 2) {
					credentialSessionId = candidate;
					break;
				}
			}
			if (credentialSessionId === undefined) throw new Error("expected a session seed selecting a duplicate row");
			session = createSession(credentialSessionId);
			const duplicateRowIds = await authStorage.getCredentialRowIdsMatchingApiKey(
				"openai-codex",
				"codex-dup-secret",
			);
			const initialCredential = await authStorage.getApiKeyWithCredentialRowId(
				"openai-codex",
				session.credentialSessionId,
			);
			expect(initialCredential.apiKey).toBe("codex-dup-secret");
			const initialRowId = initialCredential.credentialRowId;
			if (initialRowId === undefined) throw new Error("expected the initial credential row ID");
			expect(duplicateRowIds).toContain(initialRowId);
			const uniqueRowIds = await authStorage.getCredentialRowIdsMatchingApiKey("openai-codex", "codex-key-3");
			const uniqueRowId = uniqueRowIds[0];
			if (uniqueRowId === undefined) throw new Error("expected a distinct third credential row");
			const markUsageLimitReached = vi.spyOn(authStorage, "markUsageLimitReached");
			const ends = collectCompactionEnds(session);
			const compactSpy = stubCompact(apiKey => apiKey === "codex-dup-secret");

			await session.runIdleCompaction();

			expect(compactSpy.mock.calls.map(call => call[2])).toEqual(["codex-dup-secret", "codex-key-3"]);
			expect(new Set(markUsageLimitReached.mock.calls.map(call => call[2]?.rowId))).toEqual(
				new Set(duplicateRowIds),
			);
			expect(duplicateRowIds).toHaveLength(2);
			expect(duplicateRowIds.every(rowId => !authStorage.isCredentialAvailable("openai-codex", rowId))).toBe(true);
			expect(authStorage.isCredentialAvailable("openai-codex", uniqueRowId)).toBe(true);
			expect(ends).toHaveLength(1);
			expect(ends[0]?.errorMessage).toBeUndefined();
		} finally {
			if (previousA === undefined) delete process.env.GJC_TEST_COMPACTION_DUP_KEY_A;
			else process.env.GJC_TEST_COMPACTION_DUP_KEY_A = previousA;
			if (previousB === undefined) delete process.env.GJC_TEST_COMPACTION_DUP_KEY_B;
			else process.env.GJC_TEST_COMPACTION_DUP_KEY_B = previousB;
		}
	});

	it("continues past a command alias that resolves to the failed key after matching", async () => {
		const aliasEnv = "GJC_TEST_COMPACTION_TRANSIENT_DUPLICATE_ALIAS";
		const previousAlias = process.env[aliasEnv];
		delete process.env[aliasEnv];
		try {
			await authStorage.set("openai-codex", [
				{ type: "api_key", key: "codex-dup-secret" },
				{ type: "api_key", key: aliasEnv },
				{ type: "api_key", key: "codex-key-3" },
			]);
			const failedRow = authStorage
				.exportSnapshot()
				.credentials.find(
					entry =>
						entry.provider === "openai-codex" &&
						entry.credential.type === "api_key" &&
						entry.credential.key === "codex-dup-secret",
				);
			const aliasRow = authStorage
				.exportSnapshot()
				.credentials.find(
					entry =>
						entry.provider === "openai-codex" &&
						entry.credential.type === "api_key" &&
						entry.credential.key === aliasEnv,
				);
			if (!failedRow || !aliasRow) throw new Error("test setup did not create both duplicate credential rows");
			let credentialSessionId: string | undefined;
			for (let index = 0; index < 100; index++) {
				const candidate = `transient-duplicate-alias-${index}`;
				const initial = await authStorage.getApiKeyWithCredentialRowId("openai-codex", candidate);
				if (initial.credentialRowId === failedRow.id) {
					credentialSessionId = candidate;
					break;
				}
			}
			if (credentialSessionId === undefined) throw new Error("expected a session seed selecting the failed key");
			session = createSession(credentialSessionId);
			session.settings.set("retry.enabled", false);
			session.settings.set("retry.maxRetries", 0);
			const resolveMatchingRows = authStorage.getCredentialRowIdsMatchingApiKey.bind(authStorage);
			vi.spyOn(authStorage, "getCredentialRowIdsMatchingApiKey").mockImplementation(async (provider, apiKey) => {
				const rowIds = await resolveMatchingRows(provider, apiKey);
				if (apiKey === "codex-dup-secret") process.env[aliasEnv] = "codex-dup-secret";
				return rowIds;
			});
			const markUsageLimitReached = vi.spyOn(authStorage, "markUsageLimitReached");
			const ends = collectCompactionEnds(session);
			const compactSpy = stubCompact(apiKey => apiKey === "codex-dup-secret");

			await session.runIdleCompaction();

			expect(compactSpy.mock.calls.map(call => call[2])).toEqual(["codex-dup-secret", "codex-key-3"]);
			expect(markUsageLimitReached.mock.calls.map(call => call[2]?.rowId)).toContain(failedRow.id);
			expect(markUsageLimitReached.mock.calls.map(call => call[2]?.rowId)).toContain(aliasRow.id);
			expect(authStorage.isCredentialAvailable("openai-codex", aliasRow.id)).toBe(false);
			expect(ends).toHaveLength(1);
			expect(ends[0]?.errorMessage).toBeUndefined();
			expect(ends[0]?.result).toBeDefined();
		} finally {
			if (previousAlias === undefined) delete process.env[aliasEnv];
			else process.env[aliasEnv] = previousAlias;
		}
	});

	it("leaves the session provider's rows alone when a fallback candidate on another provider hits the limit", async () => {
		await authStorage.set("anthropic", [
			{ type: "api_key", key: "anthropic-key-1" },
			{ type: "api_key", key: "anthropic-key-2" },
		]);
		session = createSession();
		session.settings.setModelRole("default", "anthropic/claude-sonnet-4-5");
		const ends = collectCompactionEnds(session);
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (_preparation, model) => {
			if (model.provider === "openai-codex") {
				throw new Error("Summarization failed: 503 auth_unavailable: no auth available (providers=codex)");
			}
			throw new Error(USAGE_LIMIT);
		});
		const markUsageLimitReached = vi.spyOn(authStorage, "markUsageLimitReached");

		await session.runIdleCompaction();

		expect(compactSpy.mock.calls.some(call => call[1].provider === "anthropic")).toBe(true);
		expect(markUsageLimitReached.mock.calls.filter(call => call[0] === "openai-codex")).toHaveLength(0);
		expect(ends[0]?.errorMessage).toBeDefined();
	});

	it("never rotates a credential-pinned provider", async () => {
		const pinnedRow = authStorage.exportSnapshot().credentials.find(entry => entry.provider === "openai-codex");
		if (!pinnedRow) throw new Error("Expected a stored openai-codex credential to pin");
		authStorage.setRuntimeCredentialSelector("openai-codex", { kind: "id", value: String(pinnedRow.id) });
		session = createSession();
		const ends = collectCompactionEnds(session);
		const compactSpy = stubCompact(() => true);
		const getCredentialRowIdsMatchingApiKey = vi.spyOn(authStorage, "getCredentialRowIdsMatchingApiKey");
		const markUsageLimitReached = vi.spyOn(authStorage, "markUsageLimitReached");

		await session.runIdleCompaction();

		const keys = compactSpy.mock.calls.map(call => call[2]);
		expect(keys).toHaveLength(1 + MAX_RETRIES);
		expect(new Set(keys).size).toBe(1);
		expect(getCredentialRowIdsMatchingApiKey).not.toHaveBeenCalled();
		expect(markUsageLimitReached).not.toHaveBeenCalled();
		expect(ends[0]?.errorMessage).toContain("usage limit has been reached");
	});

	it("rechecks credential pins installed while matching the failed key", async () => {
		session = createSession();
		const resolveRows = authStorage.getCredentialRowIdsMatchingApiKey.bind(authStorage);
		const getCredentialRowIdsMatchingApiKey = vi
			.spyOn(authStorage, "getCredentialRowIdsMatchingApiKey")
			.mockImplementation(async (provider, apiKey) => {
				const rowIds = await resolveRows(provider, apiKey);
				const rowId = rowIds[0];
				if (rowId === undefined) throw new Error("expected to match the failed stored credential");
				authStorage.setRuntimeCredentialSelector(provider, { kind: "id", value: String(rowId) });
				return rowIds;
			});
		const markUsageLimitReached = vi.spyOn(authStorage, "markUsageLimitReached");
		const ends = collectCompactionEnds(session);
		const compactSpy = stubCompact(() => true);

		await session.runIdleCompaction();

		const keys = compactSpy.mock.calls.map(call => call[2]);
		expect(getCredentialRowIdsMatchingApiKey).toHaveBeenCalledTimes(1);
		expect(keys).toHaveLength(1 + MAX_RETRIES);
		expect(new Set(keys).size).toBe(1);
		expect(markUsageLimitReached).not.toHaveBeenCalled();
		expect(ends).toHaveLength(1);
		expect(ends[0]?.errorMessage).toContain("usage limit has been reached");
	});

	it("does not bypass a pinned credential that is already in quota backoff", async () => {
		const credentials = authStorage.exportSnapshot().credentials.filter(entry => entry.provider === "openai-codex");
		const pinnedRow = credentials[0];
		const healthyRow = credentials[1];
		if (!pinnedRow || !healthyRow) throw new Error("Expected two stored openai-codex credentials");
		authStorage.setRuntimeCredentialSelector("openai-codex", { kind: "id", value: String(pinnedRow.id) });
		session = createSession();
		await authStorage.markUsageLimitReached("openai-codex", session.credentialSessionId, {
			rowId: pinnedRow.id,
			retryAfterMs: 60_000,
		});
		const ends = collectCompactionEnds(session);
		const compactSpy = stubCompact(() => false);

		await session.runIdleCompaction();

		expect(authStorage.isCredentialAvailable("openai-codex", pinnedRow.id)).toBe(false);
		expect(authStorage.isCredentialAvailable("openai-codex", healthyRow.id)).toBe(true);
		expect(compactSpy).not.toHaveBeenCalled();
		expect(ends[0]?.errorMessage).toContain("No available stored credential");
	});
});
