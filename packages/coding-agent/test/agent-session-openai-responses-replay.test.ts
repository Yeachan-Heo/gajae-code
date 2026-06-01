import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai/models";
import type { AssistantMessage, Message, ProviderPayload, ProviderSessionState, Usage } from "@gajae-code/ai/types";
import { createOpenAIResponsesHistoryPayload } from "@gajae-code/ai/utils";
import type { AgentSession, ForkContextSeed } from "@gajae-code/coding-agent/session/agent-session";
import type { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import {
	type SessionEntry,
	SessionManager,
	type SessionMessageEntry,
} from "@gajae-code/coding-agent/session/session-manager";
import { Snowflake } from "@gajae-code/utils";

function createUsage(): Usage {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createUserHistoryPayload(provider = "openai"): ProviderPayload {
	return createOpenAIResponsesHistoryPayload(provider, [
		{ type: "message", role: "user", content: [{ type: "input_text", text: "Preserved user history" }] },
		{ type: "compaction", encrypted_content: "enc_preserved" },
	]);
}

function createStaleAssistantHistoryPayload(provider = "openai"): ProviderPayload {
	return createOpenAIResponsesHistoryPayload(provider, [
		{ type: "reasoning", encrypted_content: "enc_stale" },
		{
			type: "message",
			role: "assistant",
			status: "completed",
			id: "msg_stale_snapshot",
			content: [{ type: "output_text", text: "Stale native snapshot" }],
		},
	]);
}

function createStaleAssistantMessage(
	text: string,
	options: { api?: AssistantMessage["api"]; provider?: string; model?: string } = {},
): AssistantMessage {
	const { api = "openai-responses", provider = "openai", model = "gpt-5-mini" } = options;
	return {
		role: "assistant",
		content: [
			{
				type: "thinking",
				thinking: "Reasoning summary",
				thinkingSignature: JSON.stringify({
					type: "reasoning",
					id: "rs_stale",
					encrypted_content: "enc_stale",
				}),
			},
			{ type: "text", text, textSignature: "text_sig_preserved" },
			{
				type: "toolCall",
				id: "tool_call_1",
				name: "read",
				arguments: { path: "README.md" },
				thoughtSignature: "tool_sig_preserved",
			},
		],
		api,
		provider,
		model,
		usage: createUsage(),
		stopReason: "stop",
		providerPayload: createStaleAssistantHistoryPayload(provider),
		timestamp: Date.now(),
	};
}

function isSessionMessageEntry(entry: SessionEntry): entry is SessionMessageEntry {
	return entry.type === "message";
}

function getMessageEntries(sessionManager: SessionManager): SessionMessageEntry[] {
	return sessionManager.getEntries().filter(isSessionMessageEntry);
}

function getTextContent(message: Message): string | undefined {
	if (typeof message.content === "string") return message.content;
	return message.content.find(block => block.type === "text")?.text;
}

function findPersistedMessageEntry(
	sessionManager: SessionManager,
	role: Message["role"],
	text: string,
): SessionMessageEntry {
	const entry = getMessageEntries(sessionManager).find(candidate => {
		if (candidate.message.role !== role) return false;
		return getTextContent(candidate.message) === text;
	});
	if (!entry) {
		throw new Error(`Expected persisted ${role} message with text: ${text}`);
	}
	return entry;
}

function findRuntimeAssistant(session: AgentSession, text: string): AssistantMessage {
	const message = session.messages.find(
		candidate => candidate.role === "assistant" && getTextContent(candidate) === text,
	);
	if (!message || message.role !== "assistant") {
		throw new Error(`Expected runtime assistant message with text: ${text}`);
	}
	return message;
}

function expectAssistantReplayMetadataSanitized(message: AssistantMessage): void {
	// After rehydration, assistant Responses-family providerPayload must be stripped
	// to prevent stale native history replay on warmed sessions.
	expect(message.providerPayload).toBeUndefined();

	const thinkingBlock = message.content.find(block => block.type === "thinking");
	if (!thinkingBlock || thinkingBlock.type !== "thinking") {
		throw new Error("Expected assistant thinking block");
	}
	expect(thinkingBlock.thinkingSignature).toBeUndefined();

	const textBlock = message.content.find(block => block.type === "text");
	if (!textBlock || textBlock.type !== "text") {
		throw new Error("Expected assistant text block");
	}
	expect(textBlock.textSignature).toBe("text_sig_preserved");

	const toolCallBlock = message.content.find(block => block.type === "toolCall");
	if (!toolCallBlock || toolCallBlock.type !== "toolCall") {
		throw new Error("Expected assistant tool call block");
	}
	expect(toolCallBlock).toMatchObject({
		id: "tool_call_1",
		name: "read",
		arguments: { path: "README.md" },
		thoughtSignature: "tool_sig_preserved",
	});
}

async function createPersistedSession(
	tempDir: string,
	populate: (sessionManager: SessionManager) => { treeTargetId?: string } | undefined,
): Promise<{ sessionFile: string; treeTargetId?: string }> {
	const sessionManager = SessionManager.create(tempDir, tempDir);
	const result = populate(sessionManager);
	await sessionManager.flush();
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) {
		throw new Error("Expected persisted session file");
	}
	await sessionManager.close();
	return { sessionFile, treeTargetId: result?.treeTargetId };
}

async function createSessionHarness(
	tempDir: string,
	sessionManager: SessionManager,
	options: {
		provider?: Parameters<typeof getBundledModel>[0];
		modelId?: string;
		forkContextSeed?: ForkContextSeed;
		providerSessionId?: string;
		providerSessionState?: Map<string, ProviderSessionState>;
	} = {},
): Promise<{ session: AgentSession; authStorage: AuthStorage }> {
	const { provider = "openai", modelId = "gpt-5-mini" } = options;
	const [{ createAgentSession }, { Settings }, { AuthStorage }] = await Promise.all([
		import("@gajae-code/coding-agent/sdk"),
		import("@gajae-code/coding-agent/config/settings"),
		import("@gajae-code/coding-agent/session/auth-storage"),
	]);
	const authStorage = await AuthStorage.create(path.join(tempDir, `testauth-${Snowflake.next()}.db`));
	authStorage.setRuntimeApiKey("openai", "test-key");
	authStorage.setRuntimeApiKey("openai-codex", "test-key");
	const model = getBundledModel(provider, modelId);
	if (!model) {
		throw new Error(`Expected bundled test model ${provider}/${modelId}`);
	}

	const { session } = await createAgentSession({
		cwd: tempDir,
		agentDir: tempDir,
		authStorage,
		sessionManager,
		model,
		settings: Settings.isolated(),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		forkContextSeed: options.forkContextSeed,
		providerSessionId: options.providerSessionId,
		providerSessionState: options.providerSessionState,
	});

	return { session, authStorage };
}

describe("AgentSession OpenAI Responses replay boundaries", () => {
	const sessions: AgentSession[] = [];
	const authStorages: AuthStorage[] = [];
	const tempDirs: string[] = [];

	afterEach(async () => {
		while (sessions.length > 0) {
			await sessions.pop()?.dispose();
		}
		while (authStorages.length > 0) {
			authStorages.pop()?.close();
		}
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir && fs.existsSync(tempDir)) {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("sanitizes stale assistant replay metadata during startup resume while preserving user payloads", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-startup-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const preservedUserPayload = createUserHistoryPayload();
		const assistantText = "Loaded assistant response";

		const { sessionFile } = await createPersistedSession(tempDir, sessionManager => {
			sessionManager.appendMessage({
				role: "user",
				content: "Preserved summary",
				providerPayload: preservedUserPayload,
				timestamp: Date.now() - 2,
			});
			sessionManager.appendMessage(createStaleAssistantMessage(assistantText));
			sessionManager.appendMessage({ role: "user", content: "Follow-up", timestamp: Date.now() - 1 });
		});

		const reloadedSessionManager = await SessionManager.open(sessionFile, tempDir);
		const { session, authStorage } = await createSessionHarness(tempDir, reloadedSessionManager);
		sessions.push(session);
		authStorages.push(authStorage);

		const persistedUser = findPersistedMessageEntry(session.sessionManager, "user", "Preserved summary").message;
		if (persistedUser.role !== "user") {
			throw new Error("Expected persisted user message");
		}
		expect(persistedUser.providerPayload).toEqual(preservedUserPayload);

		const persistedAssistant = findPersistedMessageEntry(session.sessionManager, "assistant", assistantText).message;
		if (persistedAssistant.role !== "assistant") {
			throw new Error("Expected persisted assistant message");
		}
		expectAssistantReplayMetadataSanitized(persistedAssistant);

		const runtimeAssistant = findRuntimeAssistant(session, assistantText);
		expectAssistantReplayMetadataSanitized(runtimeAssistant);
		const runtimeUser = session.messages.find(
			message => message.role === "user" && getTextContent(message) === "Preserved summary",
		);
		if (!runtimeUser || runtimeUser.role !== "user") {
			throw new Error("Expected runtime user message");
		}
		expect(runtimeUser.providerPayload).toEqual(preservedUserPayload);
	});

	it("sanitizes stale Responses-family assistant replay metadata for direct SessionManager.open consumers", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-open-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const assistantText = "Codex assistant snapshot";

		const { sessionFile } = await createPersistedSession(tempDir, sessionManager => {
			sessionManager.appendMessage(
				createStaleAssistantMessage(assistantText, {
					api: "openai-codex-responses",
					provider: "openai-codex",
					model: "gpt-5.2-codex",
				}),
			);
		});

		const openedSessionManager = await SessionManager.open(sessionFile, tempDir);
		const persistedAssistant = findPersistedMessageEntry(openedSessionManager, "assistant", assistantText).message;
		if (persistedAssistant.role !== "assistant") {
			throw new Error("Expected persisted codex assistant message");
		}
		expectAssistantReplayMetadataSanitized(persistedAssistant);
		await openedSessionManager.close();
	});

	it("sanitizes stale assistant replay metadata when forking a persisted session", async () => {
		const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-fork-source-${Snowflake.next()}-`));
		const forkDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-fork-target-${Snowflake.next()}-`));
		tempDirs.push(sourceDir, forkDir);
		const preservedUserPayload = createUserHistoryPayload();
		const assistantText = "Forked assistant snapshot";

		const { sessionFile } = await createPersistedSession(sourceDir, sessionManager => {
			sessionManager.appendMessage({
				role: "user",
				content: "Fork summary",
				providerPayload: preservedUserPayload,
				timestamp: Date.now() - 2,
			});
			sessionManager.appendMessage(createStaleAssistantMessage(assistantText));
		});

		const forkedSessionManager = await SessionManager.forkFrom(sessionFile, forkDir, forkDir);
		const forkedAssistant = findPersistedMessageEntry(forkedSessionManager, "assistant", assistantText).message;
		if (forkedAssistant.role !== "assistant") {
			throw new Error("Expected forked assistant message");
		}
		expectAssistantReplayMetadataSanitized(forkedAssistant);

		const forkedUser = findPersistedMessageEntry(forkedSessionManager, "user", "Fork summary").message;
		if (forkedUser.role !== "user") {
			throw new Error("Expected forked user message");
		}
		expect(forkedUser.providerPayload).toEqual(preservedUserPayload);
		await forkedSessionManager.close();
	});

	it("keeps same-file reload safe without resetting live provider state after startup sanitization", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-reload-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const assistantText = "Reloaded assistant response";

		const { sessionFile } = await createPersistedSession(tempDir, sessionManager => {
			sessionManager.appendModelChange("openai-codex/gpt-5.2-codex");
			sessionManager.appendMessage({ role: "user", content: "Reload summary", timestamp: Date.now() - 2 });
			sessionManager.appendMessage(
				createStaleAssistantMessage(assistantText, {
					api: "openai-codex-responses",
					provider: "openai-codex",
					model: "gpt-5.2-codex",
				}),
			);
			sessionManager.appendMessage({ role: "user", content: "Reload follow-up", timestamp: Date.now() - 1 });
		});

		const reloadedSessionManager = await SessionManager.open(sessionFile, tempDir);
		const { session, authStorage } = await createSessionHarness(tempDir, reloadedSessionManager, {
			provider: "openai-codex",
			modelId: "gpt-5.2-codex",
		});
		sessions.push(session);
		authStorages.push(authStorage);

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", { close: closeSpy } satisfies ProviderSessionState);

		await session.reload();

		expect(closeSpy).not.toHaveBeenCalled();
		expect(session.providerSessionState.size).toBe(1);
		expectAssistantReplayMetadataSanitized(findRuntimeAssistant(session, assistantText));

		const persistedAssistant = findPersistedMessageEntry(session.sessionManager, "assistant", assistantText).message;
		if (persistedAssistant.role !== "assistant") {
			throw new Error("Expected reloaded assistant message");
		}
		expectAssistantReplayMetadataSanitized(persistedAssistant);
	});

	it("builds sanitized fork seeds while sharing cache identity without provider transport state", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-fork-seed-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const parentManager = SessionManager.create(tempDir, tempDir);
		const { session: parent, authStorage: parentAuthStorage } = await createSessionHarness(tempDir, parentManager, {
			provider: "openai-codex",
			modelId: "gpt-5.2-codex",
		});
		sessions.push(parent);
		authStorages.push(parentAuthStorage);

		parent.agent.appendMessage({
			role: "user",
			content: "Parent summary",
			providerPayload: createUserHistoryPayload("openai-codex"),
			timestamp: Date.now() - 2,
		});
		parent.agent.appendMessage(
			createStaleAssistantMessage("Parent assistant", {
				api: "openai-codex-responses",
				provider: "openai-codex",
				model: "gpt-5.2-codex",
			}),
		);
		parent.agent.appendMessage({
			role: "developer",
			content: [{ type: "text", text: "Do not override child" }],
			timestamp: Date.now() - 1,
		});
		parent.agent.appendMessage({
			role: "toolResult",
			toolCallId: "parent-tool",
			toolName: "bash",
			content: [{ type: "text", text: "parent tool output" }],
			isError: false,
			timestamp: Date.now(),
		});

		const parentCloseSpy = vi.fn();
		parent.providerSessionState.set("openai-codex-responses", {
			close: parentCloseSpy,
		} satisfies ProviderSessionState);

		const seed = await parent.buildForkContextSeed({ maxMessages: 10, maxTokens: 10_000 });
		expect(seed.cacheIdentity).toBe(parent.sessionId);
		expect(seed.messages).toHaveLength(2);
		expect(seed.metadata.skippedReasons["developer-role"]).toBe(1);
		expect(seed.metadata.skippedReasons["tool-result-role"]).toBe(1);
		expect(seed.agentMessages).toEqual(seed.messages);
		expect(seed.messages.every(message => !("providerPayload" in message))).toBe(true);
		const inheritedAssistant = seed.messages.find(message => message.role === "assistant");
		if (!inheritedAssistant || typeof inheritedAssistant.content === "string") {
			throw new Error("Expected sanitized inherited assistant message");
		}
		expect(inheritedAssistant.content.every(block => block.type !== "thinking")).toBe(true);

		const childState = new Map<string, ProviderSessionState>();
		const childManager = SessionManager.create(tempDir, tempDir);
		const { session: child, authStorage: childAuthStorage } = await createSessionHarness(tempDir, childManager, {
			provider: "openai-codex",
			modelId: "gpt-5.2-codex",
			forkContextSeed: seed,
			providerSessionState: childState,
		});
		sessions.push(child);
		authStorages.push(childAuthStorage);

		expect(child.sessionId).not.toBe(parent.sessionId);
		expect(child.agent.providerSessionId).toBe(parent.sessionId);
		expect(child.providerSessionState).toBe(childState);
		expect(child.providerSessionState).not.toBe(parent.providerSessionState);
		const childCodexState = child.providerSessionState.get("openai-codex-responses") as
			| { webSocketSessions?: Map<string, { lastResponseId?: string; lastResponseItems?: unknown[] }> }
			| undefined;
		expect(childCodexState?.webSocketSessions).toBeDefined();
		for (const sessionState of childCodexState?.webSocketSessions?.values() ?? []) {
			expect(sessionState.lastResponseId).toBeUndefined();
			expect(sessionState.lastResponseItems).toBeUndefined();
		}
		expect(parent.providerSessionState.size).toBe(1);
		expect(parentCloseSpy).not.toHaveBeenCalled();
		expect(child.messages.slice(0, 2)).toEqual(seed.agentMessages);

		parent.agent.appendMessage({ role: "user", content: "oversized ".repeat(5_000), timestamp: Date.now() });
		const boundedSeed = await parent.buildForkContextSeed({ maxMessages: 10, maxTokens: 1 });
		expect(boundedSeed.messages).toHaveLength(0);
		expect(boundedSeed.metadata.skippedReasons["token-limit"]).toBeGreaterThan(0);
	});

	it("keeps provider session state when same-file reload only changes message metadata", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-reload-metadata-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const assistantText = "Reloaded metadata-only response";

		const { sessionFile } = await createPersistedSession(tempDir, sessionManager => {
			sessionManager.appendModelChange("openai-codex/gpt-5.2-codex");
			sessionManager.appendMessage(
				createStaleAssistantMessage(assistantText, {
					api: "openai-codex-responses",
					provider: "openai-codex",
					model: "gpt-5.2-codex",
				}),
			);
		});

		const reloadedSessionManager = await SessionManager.open(sessionFile, tempDir);
		const { session, authStorage } = await createSessionHarness(tempDir, reloadedSessionManager, {
			provider: "openai-codex",
			modelId: "gpt-5.2-codex",
		});
		sessions.push(session);
		authStorages.push(authStorage);

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", { close: closeSpy } satisfies ProviderSessionState);

		const rewrittenLines = fs
			.readFileSync(sessionFile, "utf8")
			.trimEnd()
			.split("\n")
			.map(line => {
				const entry = JSON.parse(line) as { type?: string; message?: { role?: string; timestamp?: number } };
				if (entry.type === "message" && entry.message?.role === "assistant") {
					entry.message.timestamp = (entry.message.timestamp ?? 0) + 10_000;
				}
				return JSON.stringify(entry);
			});
		fs.writeFileSync(sessionFile, `${rewrittenLines.join("\n")}\n`, "utf8");

		await session.reload();

		expect(closeSpy).not.toHaveBeenCalled();
		expect(session.providerSessionState.size).toBe(1);
		expect(session.model?.provider).toBe("openai-codex");
		expect(session.model?.id).toBe("gpt-5.2-codex");
		expectAssistantReplayMetadataSanitized(findRuntimeAssistant(session, assistantText));
	});

	it("captures session-manager state when custom message details are proxy-backed", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-capture-proxy-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const sessionManager = SessionManager.create(tempDir, tempDir);
		const proxyDetails = new Proxy({ ok: true, nested: { value: "preserved" } }, {});

		sessionManager.appendCustomMessageEntry("proxy-details", "Proxy metadata", true, proxyDetails);

		const snapshot = sessionManager.captureState();
		const customEntry = snapshot.fileEntries.find(
			entry => entry.type === "custom_message" && entry.customType === "proxy-details",
		);
		if (!customEntry || customEntry.type !== "custom_message") {
			throw new Error("Expected captured custom message entry");
		}
		expect(customEntry.details).toEqual({ ok: true, nested: { value: "preserved" } });
		await sessionManager.close();
	});

	it("reloads when current session contains proxy-backed custom message details", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-reload-proxy-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const sessionManager = SessionManager.create(tempDir, tempDir);
		const { session, authStorage } = await createSessionHarness(tempDir, sessionManager);
		sessions.push(session);
		authStorages.push(authStorage);
		const proxyDetails = new Proxy({ ok: true, nested: { value: "preserved" } }, {});

		await session.sendCustomMessage(
			{
				customType: "proxy-details",
				content: "Proxy metadata",
				display: true,
				details: proxyDetails,
			},
			{ triggerTurn: false },
		);

		const originalSessionFile = session.sessionFile;
		expect(originalSessionFile).toBeDefined();

		await session.reload();

		expect(() => session.sessionManager.captureState()).not.toThrow();
		expect(session.sessionFile).toBe(originalSessionFile);
	});

	it("resets provider session state when same-file reload restores different messages under the same model", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-reload-content-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const assistantText = "Reloaded content change response";

		const { sessionFile } = await createPersistedSession(tempDir, sessionManager => {
			sessionManager.appendModelChange("openai-codex/gpt-5.2-codex");
			sessionManager.appendMessage(
				createStaleAssistantMessage(assistantText, {
					api: "openai-codex-responses",
					provider: "openai-codex",
					model: "gpt-5.2-codex",
				}),
			);
		});

		const reloadedSessionManager = await SessionManager.open(sessionFile, tempDir);
		const { session, authStorage } = await createSessionHarness(tempDir, reloadedSessionManager, {
			provider: "openai-codex",
			modelId: "gpt-5.2-codex",
		});
		sessions.push(session);
		authStorages.push(authStorage);

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", { close: closeSpy } satisfies ProviderSessionState);

		const mutatedSessionManager = await SessionManager.open(sessionFile, tempDir);
		mutatedSessionManager.appendMessage({
			role: "user",
			content: "Externally appended follow-up",
			timestamp: Date.now() + 1,
		});
		await mutatedSessionManager.flush();
		await mutatedSessionManager.close();

		await session.reload();

		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
		expect(session.model?.provider).toBe("openai-codex");
		expect(session.model?.id).toBe("gpt-5.2-codex");
		expect(
			session.messages.some(
				message => message.role === "user" && getTextContent(message) === "Externally appended follow-up",
			),
		).toBe(true);
	});

	it("resets provider session state when same-file reload restores a different saved model", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-reload-model-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const assistantText = "Reloaded model change response";

		const { sessionFile } = await createPersistedSession(tempDir, sessionManager => {
			sessionManager.appendModelChange("openai-codex/gpt-5.2-codex");
			sessionManager.appendMessage(
				createStaleAssistantMessage(assistantText, {
					api: "openai-codex-responses",
					provider: "openai-codex",
					model: "gpt-5.2-codex",
				}),
			);
		});

		const reloadedSessionManager = await SessionManager.open(sessionFile, tempDir);
		const { session, authStorage } = await createSessionHarness(tempDir, reloadedSessionManager, {
			provider: "openai-codex",
			modelId: "gpt-5.2-codex",
		});
		sessions.push(session);
		authStorages.push(authStorage);

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", { close: closeSpy } satisfies ProviderSessionState);

		const mutatedSessionManager = await SessionManager.open(sessionFile, tempDir);
		mutatedSessionManager.appendModelChange("openai/gpt-5-mini");
		await mutatedSessionManager.flush();
		expect(mutatedSessionManager.buildSessionContext().models.default).toBe("openai/gpt-5-mini");
		await mutatedSessionManager.close();

		await session.reload();

		expect(session.model?.provider).toBe("openai");
		expect(session.model?.id).toBe("gpt-5-mini");
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
		expectAssistantReplayMetadataSanitized(findRuntimeAssistant(session, assistantText));
	});

	it("resets plain openai-responses provider state when same-file reload restores a different saved model", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-reload-openai-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const assistantText = "Reloaded openai responses model change";

		const { sessionFile } = await createPersistedSession(tempDir, sessionManager => {
			sessionManager.appendModelChange("openai/gpt-5-mini");
			sessionManager.appendMessage(createStaleAssistantMessage(assistantText));
		});

		const reloadedSessionManager = await SessionManager.open(sessionFile, tempDir);
		const { session, authStorage } = await createSessionHarness(tempDir, reloadedSessionManager);
		sessions.push(session);
		authStorages.push(authStorage);

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-responses:openai", { close: closeSpy } satisfies ProviderSessionState);

		const mutatedSessionManager = await SessionManager.open(sessionFile, tempDir);
		mutatedSessionManager.appendModelChange("openai/gpt-5.4-mini");
		await mutatedSessionManager.flush();
		expect(mutatedSessionManager.buildSessionContext().models.default).toBe("openai/gpt-5.4-mini");
		await mutatedSessionManager.close();

		await session.reload();

		expect(session.model?.provider).toBe("openai");
		expect(session.model?.id).toBe("gpt-5.4-mini");
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
		expectAssistantReplayMetadataSanitized(findRuntimeAssistant(session, assistantText));
	});

	it("switches sessions without requiring write access during load-time sanitization", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-switch-fail-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const currentSessionManager = SessionManager.create(tempDir, tempDir);
		const { session, authStorage } = await createSessionHarness(tempDir, currentSessionManager);
		sessions.push(session);
		authStorages.push(authStorage);

		const { sessionFile } = await createPersistedSession(tempDir, sessionManager => {
			sessionManager.appendMessage(createStaleAssistantMessage("Unreadable assistant snapshot"));
		});
		const sessionDir = path.dirname(sessionFile);
		const originalMode = fs.statSync(sessionDir).mode & 0o777;
		fs.chmodSync(sessionDir, 0o555);

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-responses:openai", { close: closeSpy } satisfies ProviderSessionState);

		try {
			await expect(session.switchSession(sessionFile)).resolves.toBe(true);
		} finally {
			fs.chmodSync(sessionDir, originalMode);
		}

		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
		expect(session.sessionManager).toBe(currentSessionManager);
		expect(session.sessionFile).toBe(sessionFile);
		expectAssistantReplayMetadataSanitized(findRuntimeAssistant(session, "Unreadable assistant snapshot"));
	});

	it("clears provider session state and sanitizes loaded assistant metadata when switching sessions", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-switch-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const preservedUserPayload = createUserHistoryPayload();
		const assistantText = "Switched assistant response";

		const currentSessionManager = SessionManager.create(tempDir, tempDir);
		const { session, authStorage } = await createSessionHarness(tempDir, currentSessionManager);
		sessions.push(session);
		authStorages.push(authStorage);

		const { sessionFile } = await createPersistedSession(tempDir, sessionManager => {
			sessionManager.appendMessage({
				role: "user",
				content: "Older summary",
				providerPayload: preservedUserPayload,
				timestamp: Date.now() - 2,
			});
			sessionManager.appendMessage(createStaleAssistantMessage(assistantText));
			sessionManager.appendMessage({ role: "user", content: "Older follow-up", timestamp: Date.now() - 1 });
		});

		const closeSpy = vi.fn();
		session.providerSessionState.set("stale-provider-session", { close: closeSpy } satisfies ProviderSessionState);

		const switched = await session.switchSession(sessionFile);
		expect(switched).toBe(true);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);

		const persistedAssistant = findPersistedMessageEntry(session.sessionManager, "assistant", assistantText).message;
		if (persistedAssistant.role !== "assistant") {
			throw new Error("Expected persisted assistant message after switch");
		}
		expectAssistantReplayMetadataSanitized(persistedAssistant);
		const persistedUser = findPersistedMessageEntry(session.sessionManager, "user", "Older summary").message;
		if (persistedUser.role !== "user") {
			throw new Error("Expected switched user message");
		}
		expect(persistedUser.providerPayload).toEqual(preservedUserPayload);
		expectAssistantReplayMetadataSanitized(findRuntimeAssistant(session, assistantText));
	});

	it("does not reintroduce stale assistant replay metadata when navigating to another branch after load sanitization", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-tree-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const branchAssistantText = "Archived branch assistant";

		const { sessionFile, treeTargetId } = await createPersistedSession(tempDir, sessionManager => {
			const rootUserId = sessionManager.appendMessage({ role: "user", content: "Root", timestamp: Date.now() - 5 });
			const mainAssistantId = sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "Main branch" }],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5-mini",
				usage: createUsage(),
				stopReason: "stop",
				timestamp: Date.now() - 4,
			});
			sessionManager.branch(rootUserId);
			sessionManager.appendMessage({ role: "user", content: "Archived branch", timestamp: Date.now() - 3 });
			const archivedAssistantId = sessionManager.appendMessage(createStaleAssistantMessage(branchAssistantText));
			sessionManager.branch(mainAssistantId);
			sessionManager.appendMessage({ role: "user", content: "Active branch leaf", timestamp: Date.now() - 2 });
			return { treeTargetId: archivedAssistantId };
		});

		if (!treeTargetId) {
			throw new Error("Expected archived branch target id");
		}

		const reloadedSessionManager = await SessionManager.open(sessionFile, tempDir);
		const { session, authStorage } = await createSessionHarness(tempDir, reloadedSessionManager);
		sessions.push(session);
		authStorages.push(authStorage);

		const navigation = await session.navigateTree(treeTargetId, { summarize: false });
		expect(navigation.cancelled).toBe(false);
		expectAssistantReplayMetadataSanitized(findRuntimeAssistant(session, branchAssistantText));

		const persistedAssistant = findPersistedMessageEntry(
			session.sessionManager,
			"assistant",
			branchAssistantText,
		).message;
		if (persistedAssistant.role !== "assistant") {
			throw new Error("Expected archived branch assistant entry");
		}
		expectAssistantReplayMetadataSanitized(persistedAssistant);
	});

	it("resets provider session state when starting a brand-new session", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-new-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const sessionManager = SessionManager.create(tempDir, tempDir);
		const { session, authStorage } = await createSessionHarness(tempDir, sessionManager);
		sessions.push(session);
		authStorages.push(authStorage);

		const closeSpy = vi.fn();
		session.providerSessionState.set("live-provider-session", { close: closeSpy } satisfies ProviderSessionState);

		const created = await session.newSession();
		expect(created).toBe(true);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
	});
});
