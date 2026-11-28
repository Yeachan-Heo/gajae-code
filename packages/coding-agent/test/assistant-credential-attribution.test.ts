import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import { registerCustomApi, unregisterCustomApis } from "@gajae-code/ai/api-registry";
import { Effort } from "@gajae-code/ai/model-thinking";
import { getBundledModel } from "@gajae-code/ai/models";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@gajae-code/ai/types";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { trackTempDirs } from "./helpers/tracked-temp-dirs";

const SOURCE_ID = "assistant-credential-attribution-test";
const API = "assistant-credential-attribution-test" as Api;
const PROVIDER = "anthropic";
const tempDirs = trackTempDirs();

type Outcome = "ok" | "quota" | "auth";

function providerMessage(model: Model<Api>, outcome: Outcome): AssistantMessage {
	return {
		role: "assistant",
		content: outcome === "ok" ? [{ type: "text", text: "accepted" }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 3,
			output: outcome === "ok" ? 2 : 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: outcome === "ok" ? 5 : 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: outcome === "ok" ? "stop" : "error",
		...(outcome === "quota"
			? {
					errorMessage: "The usage limit has been reached (code=usage_limit_reached)",
					errorStatus: 429,
					transportFailure: { kind: "transport" as const, status: 429, providerCode: "usage_limit_reached" },
				}
			: {}),
		...(outcome === "auth"
			? {
					errorMessage: "401 invalid_api_key",
					errorStatus: 401,
					transportFailure: { kind: "transport" as const, status: 401, providerCode: "invalid_api_key" },
				}
			: {}),
		timestamp: Date.now(),
	};
}

/**
 * Fake provider behind the real `streamSimple` custom-API dispatch. It sees the
 * exact key the session resolved, so the credential under test is the one the
 * session's own selection, failover, and retry logic chose.
 */
function registerProvider(outcomeFor: (apiKey: string | undefined) => Outcome): string[] {
	const keys: string[] = [];
	registerCustomApi(
		API,
		(model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
			keys.push(String(options?.apiKey));
			const stream = new AssistantMessageEventStream();
			const outcome = outcomeFor(options?.apiKey);
			queueMicrotask(() => {
				const message = providerMessage(model, outcome);
				stream.push({ type: "start", partial: message });
				if (outcome === "ok") {
					stream.push({ type: "text_start", contentIndex: 0, partial: message });
					stream.push({ type: "text_delta", contentIndex: 0, delta: "accepted", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				} else {
					stream.push({ type: "error", reason: "error", error: message });
				}
			});
			return stream;
		},
		SOURCE_ID,
	);
	return keys;
}

function testModel(): Model<Api> {
	const bundled = getBundledModel(PROVIDER, "claude-sonnet-4-5");
	if (!bundled) throw new Error("Expected bundled anthropic model");
	return { ...bundled, api: API };
}

async function createHarness(
	sessionManager: SessionManager,
	authStorage: AuthStorage,
	dir: string,
): Promise<AgentSession> {
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		authStorage,
		sessionManager,
		model: testModel(),
		settings: Settings.isolated({ "compaction.enabled": false, "retry.baseDelayMs": 1 }),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	});
	return session;
}

function rowIdForKey(authStorage: AuthStorage, key: string): number {
	const row = authStorage
		.exportSnapshot()
		.credentials.find(
			entry => entry.provider === PROVIDER && entry.credential.type === "api_key" && entry.credential.key === key,
		);
	if (!row) throw new Error("Expected a stored credential row for the test key");
	return row.id;
}

async function persistedAssistants(sessionManager: SessionManager): Promise<Array<Record<string, unknown>>> {
	await sessionManager.flush();
	const file = sessionManager.getSessionFile();
	if (!file) throw new Error("Expected a persisted session file");
	const lines = (await Bun.file(file).text()).split("\n").filter(line => line.trim() !== "");
	return lines
		.map(line => JSON.parse(line) as { type?: string; message?: Record<string, unknown> })
		.filter(entry => entry.type === "message" && entry.message?.role === "assistant")
		.map(entry => entry.message as Record<string, unknown>);
}

describe("assistant message credential attribution through a real session", () => {
	const sessions: AgentSession[] = [];
	const authStorages: AuthStorage[] = [];

	afterEach(async () => {
		while (sessions.length > 0) await sessions.pop()?.dispose();
		while (authStorages.length > 0) authStorages.pop()?.close();
		unregisterCustomApis(SOURCE_ID);
		vi.restoreAllMocks();
	});

	async function setup(credentials: string[]): Promise<{
		dir: string;
		authStorage: AuthStorage;
		sessionManager: SessionManager;
		session: AgentSession;
	}> {
		const dir = tempDirs.tempDirSync("@assistant-credential-attribution-").path();
		const authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
		authStorages.push(authStorage);
		if (credentials.length > 0) {
			await authStorage.set(
				PROVIDER,
				credentials.map(key => ({ type: "api_key" as const, key })),
			);
		}
		const sessionManager = SessionManager.create(dir, dir);
		const session = await createHarness(sessionManager, authStorage, dir);
		sessions.push(session);
		return { dir, authStorage, sessionManager, session };
	}

	it("records the stored credential row on a successful turn", async () => {
		const keys = registerProvider(() => "ok");
		const { authStorage, sessionManager, session } = await setup(["stored-key-a"]);

		await session.prompt("hello");
		await session.waitForIdle();

		expect(keys).toEqual(["stored-key-a"]);
		const assistants = await persistedAssistants(sessionManager);
		expect(assistants).toHaveLength(1);
		expect(assistants[0]?.stopReason).toBe("stop");
		expect(assistants[0]?.credentialId).toBe(rowIdForKey(authStorage, "stored-key-a"));
	});

	it("leaves the field absent for an external runtime key", async () => {
		const keys = registerProvider(() => "ok");
		const { authStorage, sessionManager, session } = await setup(["stored-key-a"]);
		authStorage.setRuntimeApiKey(PROVIDER, "runtime-override-key");

		await session.prompt("hello");
		await session.waitForIdle();

		expect(keys).toEqual(["runtime-override-key"]);
		const assistants = await persistedAssistants(sessionManager);
		expect(assistants).toHaveLength(1);
		expect(assistants[0]?.stopReason).toBe("stop");
		expect("credentialId" in (assistants[0] ?? {})).toBe(false);
	});

	it("attributes the failed attempt to the first row and the retried success to the second row", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		let firstKey: string | undefined;
		const keys = registerProvider(apiKey => {
			firstKey ??= apiKey;
			return apiKey === firstKey ? "quota" : "ok";
		});
		const { authStorage, sessionManager, session } = await setup(["stored-key-a", "stored-key-b"]);

		await session.prompt("hello");
		await session.waitForIdle();

		expect(keys).toHaveLength(2);
		expect(new Set(keys)).toEqual(new Set(["stored-key-a", "stored-key-b"]));
		const [failedKey, retriedKey] = keys as [string, string];
		const assistants = await persistedAssistants(sessionManager);
		const failed = assistants.find(message => message.stopReason === "error");
		const succeeded = assistants.find(message => message.stopReason === "stop");
		expect(failed?.credentialId).toBe(rowIdForKey(authStorage, failedKey));
		expect(succeeded?.credentialId).toBe(rowIdForKey(authStorage, retriedKey));
		expect(succeeded?.credentialId).not.toBe(failed?.credentialId);
		// The live agent state agrees with what was persisted.
		const live = session.agent.state.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(live.at(-1)?.credentialId).toBe(rowIdForKey(authStorage, retriedKey));
	});

	it("attributes an auth-retried turn to the replacement row, not the rejected one", async () => {
		let rejectedKey: string | undefined;
		const keys = registerProvider(apiKey => {
			rejectedKey ??= apiKey;
			return apiKey === rejectedKey ? "auth" : "ok";
		});
		const { authStorage, sessionManager, session } = await setup(["stored-key-a", "stored-key-b"]);
		// Resolve both rows up front: invalidating the rejected key may retire its row.
		const rowByKey = new Map(
			["stored-key-a", "stored-key-b"].map(key => [key, rowIdForKey(authStorage, key)] as const),
		);
		const invalidate = vi.spyOn(authStorage, "invalidateCredentialMatching");

		await session.prompt("hello");
		await session.waitForIdle();

		// The 401 runs the session's onAuthError (invalidate the key, resolve the other row) inside streamSimple.
		expect(keys).toHaveLength(2);
		expect(new Set(keys)).toEqual(new Set(["stored-key-a", "stored-key-b"]));
		const [failedKey, retriedKey] = keys as [string, string];
		const failedRow = rowByKey.get(failedKey);
		const retriedRow = rowByKey.get(retriedKey);
		expect(retriedRow).not.toBe(failedRow);
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(invalidate.mock.calls[0]?.slice(0, 2)).toEqual([PROVIDER, failedKey]);
		const assistants = await persistedAssistants(sessionManager);
		// The captured auth failure is retried, not surfaced, so it is never persisted.
		expect(assistants).toHaveLength(1);
		expect(assistants[0]?.stopReason).toBe("stop");
		expect(assistants[0]?.credentialId).toBe(retriedRow);
		expect(assistants.some(message => message.credentialId === failedRow)).toBe(false);
		const live = session.agent.state.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(live.map(message => message.credentialId)).toEqual([retriedRow]);
	});

	it("attributes each managed-fallback attempt to the credential row that served it", async () => {
		const provider = "credential-attribution-fixture";
		const dir = tempDirs.tempDirSync("@assistant-credential-attribution-managed-").path();
		const authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
		authStorages.push(authStorage);
		await authStorage.set(provider, [
			{ type: "api_key", key: "managed-key-a" },
			{ type: "api_key", key: "managed-key-b" },
		]);
		const requests: Array<{ model: string; key: string }> = [];
		let firstKey: string | undefined;
		registerCustomApi(
			API,
			(model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				const key = String(options?.apiKey);
				requests.push({ model: model.id, key });
				firstKey ??= key;
				const stream = new AssistantMessageEventStream();
				const message = providerMessage(model, key === firstKey && model.id === "primary" ? "quota" : "ok");
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					if (message.stopReason === "stop") stream.push({ type: "done", reason: "stop", message });
					else stream.push({ type: "error", reason: "error", error: message });
				});
				return stream;
			},
			SOURCE_ID,
		);
		const modelRegistry = new ModelRegistry(authStorage, path.join(dir, "models.yml"));
		modelRegistry.registerProvider(provider, {
			baseUrl: "https://credential-attribution.example.test/v1",
			api: API,
			// Satisfies the registration contract; the turn authenticates with the stored api_key rows.
			oauth: {
				name: "Credential Attribution Fixture",
				login: async () => {
					throw new Error("login is not used by this fixture");
				},
			},
			models: ["primary", "secondary"].map(id => ({
				id,
				name: id,
				reasoning: false,
				input: ["text" as const],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
			})),
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.baseDelayMs": 1 });
		settings.set("modelRoles", { default: [`${provider}/primary`, `${provider}/secondary`] });
		const sessionManager = SessionManager.create(dir, dir);
		const { session } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			authStorage,
			modelRegistry,
			sessionManager,
			modelPattern: `${provider}/primary`,
			settings,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		sessions.push(session);

		await session.prompt("hello");
		await session.waitForIdle();

		// Managed fallback rotates the primary model to the untried row instead of
		// switching models; the retried request must name that row, not the first.
		expect(requests.map(request => request.model)).toEqual(["primary", "primary"]);
		expect(requests[1]?.key).not.toBe(firstKey);
		const rowFor = (key: string): number => {
			const row = authStorage
				.exportSnapshot()
				.credentials.find(
					entry =>
						entry.provider === provider && entry.credential.type === "api_key" && entry.credential.key === key,
				);
			if (!row) throw new Error("Expected a stored credential row for the test key");
			return row.id;
		};
		const assistants = await persistedAssistants(sessionManager);
		const succeeded = assistants.filter(message => message.stopReason === "stop");
		expect(succeeded).toHaveLength(1);
		const served = requests.at(-1);
		if (!served) throw new Error("Expected a served request");
		expect(succeeded[0]?.model).toBe(served.model);
		expect(succeeded[0]?.credentialId).toBe(rowFor(served.key));
		// The failed attempt is discarded by the managed transaction, so the only
		// persisted turn is the one served by the rotated row.
		expect(assistants.filter(message => message.stopReason === "error")).toHaveLength(0);
		expect(succeeded[0]?.credentialId).not.toBe(rowFor(firstKey ?? ""));
	});

	it("keeps the serving credential on a turn aborted mid-stream", async () => {
		const started = Promise.withResolvers<void>();
		registerCustomApi(
			API,
			(model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				const stream = new AssistantMessageEventStream();
				const message = providerMessage(model, "ok");
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "text_start", contentIndex: 0, partial: message });
					stream.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial: message });
					started.resolve();
				});
				options?.signal?.addEventListener("abort", () => stream.fail(new Error("Request was aborted")), {
					once: true,
				});
				return stream;
			},
			SOURCE_ID,
		);
		const { authStorage, sessionManager, session } = await setup(["stored-key-a"]);

		const prompt = session.prompt("hello");
		await started.promise;
		await Bun.sleep(10);
		await session.abort();
		await prompt.catch(() => undefined);
		await session.waitForIdle();

		const assistants = await persistedAssistants(sessionManager);
		const aborted = assistants.find(message => message.stopReason === "aborted");
		expect(aborted).toBeDefined();
		expect(aborted?.credentialId).toBe(rowIdForKey(authStorage, "stored-key-a"));
	});

	it("loads a pre-attribution session file and attributes only new turns", async () => {
		const keys = registerProvider(() => "ok");
		const { dir, authStorage, sessionManager, session } = await setup(["stored-key-a"]);
		await session.prompt("first turn");
		await session.waitForIdle();
		await sessionManager.flush();
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("Expected a persisted session file");
		await session.dispose();
		sessions.pop();

		// Rewrite the file as an older build would have written it: no credentialId.
		const legacy = (await Bun.file(file).text())
			.split("\n")
			.filter(line => line.trim() !== "")
			.map(line => {
				const entry = JSON.parse(line) as { type?: string; message?: Record<string, unknown> };
				if (entry.type === "message" && entry.message) delete entry.message.credentialId;
				return JSON.stringify(entry);
			})
			.join("\n");
		const legacyFile = path.join(dir, "legacy-session.jsonl");
		await fs.writeFile(legacyFile, `${legacy}\n`);
		expect(legacy).not.toContain("credentialId");

		const reopened = await SessionManager.open(legacyFile, dir);
		const restored = reopened
			.buildSessionContext()
			.messages.filter((message): message is AssistantMessage => message.role === "assistant");
		expect(restored).toHaveLength(1);
		expect(restored[0]?.content).toEqual([{ type: "text", text: "accepted" }]);
		expect(restored[0]?.credentialId).toBeUndefined();

		const resumed = await createHarness(reopened, authStorage, dir);
		sessions.push(resumed);
		await resumed.prompt("second turn");
		await resumed.waitForIdle();

		expect(keys).toEqual(["stored-key-a", "stored-key-a"]);
		const assistants = await persistedAssistants(reopened);
		expect(assistants).toHaveLength(2);
		expect("credentialId" in (assistants[0] ?? {})).toBe(false);
		expect(assistants[1]?.credentialId).toBe(rowIdForKey(authStorage, "stored-key-a"));
	});

	it("replays the previous account's signed and redacted thinking unchanged after an account move mid tool loop", async () => {
		const dir = tempDirs.tempDirSync("@assistant-credential-attribution-anthropic-").path();
		await Bun.write(path.join(dir, "notes.txt"), "tool output\n");
		const authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
		authStorages.push(authStorage);
		const storedKeys = ["sk-ant-api03-attribution-row-a", "sk-ant-api03-attribution-row-b"];
		await authStorage.set(
			PROVIDER,
			storedKeys.map(key => ({ type: "api_key" as const, key })),
		);
		// Resolve both rows up front: invalidating the rejected key may retire its row.
		const rowByKey = new Map(storedKeys.map(key => [key, rowIdForKey(authStorage, key)] as const));
		const bundled = getBundledModel(PROVIDER, "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled anthropic model");
		const model = bundled as Model<"anthropic-messages">;

		const requests: Array<{ key: string; body: string }> = [];
		let firstKey: string | undefined;
		const sse = (events: Array<Record<string, unknown>>) =>
			new Response(
				events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		const usageEvent = { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (!url.includes("/v1/messages")) throw new Error(`unexpected request to ${url}`);
			const headers = new Headers(init?.headers);
			const key = headers.get("x-api-key") ?? headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
			const raw = init?.body;
			const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : (raw as Uint8Array);
			const body = new TextDecoder().decode(bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes);
			requests.push({ key, body });
			firstKey ??= key;
			if (requests.length === 1) {
				// Account A answers with signed thinking, redacted thinking and a tool call.
				return sse([
					{ type: "message_start", message: { id: "msg_a", usage: { ...usageEvent, output_tokens: 0 } } },
					{
						type: "content_block_start",
						index: 0,
						content_block: { type: "thinking", thinking: "", signature: "" },
					},
					{
						type: "content_block_delta",
						index: 0,
						delta: { type: "thinking_delta", thinking: "row A reasoning" },
					},
					{
						type: "content_block_delta",
						index: 0,
						delta: { type: "signature_delta", signature: "sig_row_a_turn" },
					},
					{ type: "content_block_stop", index: 0 },
					// A text block separates the thinking blocks so the adjacent-thinking
					// collapse (issue #4416) keeps both.
					{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "checking" } },
					{ type: "content_block_stop", index: 1 },
					{
						type: "content_block_start",
						index: 2,
						content_block: { type: "redacted_thinking", data: "redacted_row_a_turn" },
					},
					{ type: "content_block_stop", index: 2 },
					{
						type: "content_block_start",
						index: 3,
						content_block: { type: "tool_use", id: "toolu_attr_1", name: "read", input: {} },
					},
					{
						type: "content_block_delta",
						index: 3,
						delta: { type: "input_json_delta", partial_json: JSON.stringify({ path: "notes.txt" }) },
					},
					{ type: "content_block_stop", index: 3 },
					{
						type: "message_delta",
						delta: { stop_reason: "tool_use" },
						usage: { ...usageEvent, output_tokens: 5 },
					},
					{ type: "message_stop" },
				]);
			}
			if (key === firstKey) {
				// The tool-result continuation is rejected for account A; the session's
				// auth retry moves the same request to account B.
				return new Response(
					JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }),
					{ status: 401, headers: { "content-type": "application/json" } },
				);
			}
			return sse([
				{ type: "message_start", message: { id: "msg_b", usage: { ...usageEvent, output_tokens: 0 } } },
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
				{ type: "content_block_stop", index: 0 },
				{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { ...usageEvent, output_tokens: 1 } },
				{ type: "message_stop" },
			]);
		}) as typeof fetch);

		const sessionManager = SessionManager.create(dir, dir);
		const { session } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			authStorage,
			sessionManager,
			model,
			thinkingLevel: Effort.High,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.baseDelayMs": 1 }),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		sessions.push(session);

		await session.prompt("read notes.txt");
		await session.waitForIdle();

		const servedByB = requests.filter(request => request.key !== firstKey);
		expect(servedByB.length).toBeGreaterThan(0);
		expect(new Set(requests.map(request => request.key))).toEqual(new Set(storedKeys));
		for (const request of servedByB) {
			// The credential row does not decide replay: B receives A's thinking verbatim
			// and the provider decides what the signature is valid for.
			const body = JSON.parse(request.body) as {
				messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
			};
			const turnA = body.messages.find(
				message =>
					message.role === "assistant" &&
					Array.isArray(message.content) &&
					message.content.some(block => block.type === "tool_use" && block.id === "toolu_attr_1"),
			);
			expect(turnA?.content).toEqual([
				{ type: "thinking", thinking: "row A reasoning", signature: "sig_row_a_turn" },
				expect.objectContaining({ type: "text", text: "checking" }),
				{ type: "redacted_thinking", data: "redacted_row_a_turn" },
				expect.objectContaining({ type: "tool_use", id: "toolu_attr_1", name: "read" }),
			]);
		}
		const rowA = rowByKey.get(firstKey ?? "");
		const rowB = rowByKey.get(servedByB[0]?.key ?? "");
		expect(rowA).toBeDefined();
		expect(rowB).toBeDefined();
		expect(rowB).not.toBe(rowA);
		const assistants = await persistedAssistants(sessionManager);
		expect(assistants.map(message => message.stopReason)).toEqual(["toolUse", "stop"]);
		expect(assistants.map(message => message.credentialId)).toEqual([rowA, rowB]);
	}, 30_000);
});
