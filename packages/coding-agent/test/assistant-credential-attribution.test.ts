import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { registerCustomApi, unregisterCustomApis } from "@gajae-code/ai/api-registry";
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

type Outcome = "ok" | "quota";

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
		for (const failed of assistants.filter(message => message.stopReason === "error")) {
			expect(failed.credentialId).toBe(rowFor(firstKey ?? ""));
		}
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
});
