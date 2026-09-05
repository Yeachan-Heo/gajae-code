import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai/models";
import type { AssistantMessage, Message, ProviderPayload, ProviderSessionState, Usage } from "@gajae-code/ai/types";
import { createOpenAIResponsesHistoryPayload } from "@gajae-code/ai/utils";
import * as asyncModule from "@gajae-code/coding-agent/async";
import * as settingsModule from "@gajae-code/coding-agent/config/settings";
import * as internalUrls from "@gajae-code/coding-agent/internal-urls";
import type { CreateAgentSessionResult } from "@gajae-code/coding-agent/sdk";
import * as sdkModule from "@gajae-code/coding-agent/sdk";
import type { AgentSession, ForkContextSeed } from "@gajae-code/coding-agent/session/agent-session";
import type { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import {
	type SessionEntry,
	SessionManager,
	type SessionMessageEntry,
} from "@gajae-code/coding-agent/session/session-manager";
import * as taskModule from "@gajae-code/coding-agent/task";
import * as agentsModule from "@gajae-code/coding-agent/task/agents";
import * as discoveryModule from "@gajae-code/coding-agent/task/discovery";
import * as eventBusModule from "@gajae-code/coding-agent/utils/event-bus";
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

function makeFsError(code: "EACCES" | "EPERM" | "EROFS"): NodeJS.ErrnoException {
	return Object.assign(new Error(code), { code });
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

function rewritePersistedAssistantsAsStale(sessionFile: string, assistantTexts: readonly string[]): void {
	let assistantIndex = 0;
	const rewritten = fs
		.readFileSync(sessionFile, "utf8")
		.split("\n")
		.map(line => {
			if (!line) return line;
			const record = JSON.parse(line) as SessionEntry;
			if (record.type !== "message" || record.message.role !== "assistant") return line;
			const assistantText = assistantTexts[assistantIndex++];
			if (assistantText === undefined) throw new Error("Unexpected persisted assistant message");
			record.message = { ...createStaleAssistantMessage(assistantText), timestamp: record.message.timestamp };
			return JSON.stringify(record);
		})
		.join("\n");
	if (assistantIndex !== assistantTexts.length)
		throw new Error("Expected every stale assistant fixture to be persisted");
	fs.writeFileSync(sessionFile, rewritten);
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
	if (message?.role !== "assistant") {
		throw new Error(`Expected runtime assistant message with text: ${text}`);
	}
	return message;
}

function expectAssistantReplayMetadataSanitized(message: AssistantMessage): void {
	// After rehydration, assistant Responses-family providerPayload must be stripped
	// to prevent stale native history replay on warmed sessions.
	expect(message.providerPayload).toBeUndefined();

	const thinkingBlock = message.content.find(block => block.type === "thinking");
	if (thinkingBlock?.type !== "thinking") {
		throw new Error("Expected assistant thinking block");
	}
	expect(thinkingBlock.thinkingSignature).toBeUndefined();

	const textBlock = message.content.find(block => block.type === "text");
	if (textBlock?.type !== "text") {
		throw new Error("Expected assistant text block");
	}
	expect(textBlock.textSignature).toBe("text_sig_preserved");

	const toolCallBlock = message.content.find(block => block.type === "toolCall");
	if (toolCallBlock?.type !== "toolCall") {
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
		settings?: Record<string, unknown>;
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
		settings: Settings.isolated(options.settings ?? {}),
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
		if (runtimeUser?.role !== "user") {
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

	it("sanitizes multiple stale managed assistants in memory without rewriting on open", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-3793-managed-open-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const assistantTexts = ["First stale managed assistant", "Second stale managed assistant"];
		const destination = SessionManager.managedDestination(tempDir, path.join(tempDir, "agent"));
		const persistedSessionManager = SessionManager.create(tempDir, destination);
		for (const assistantText of assistantTexts) {
			persistedSessionManager.appendMessage(createStaleAssistantMessage(assistantText));
		}
		await persistedSessionManager.flush();
		const sessionFile = persistedSessionManager.getSessionFile();
		if (!sessionFile) {
			throw new Error("Expected persisted managed session file");
		}
		await persistedSessionManager.close();
		rewritePersistedAssistantsAsStale(sessionFile, assistantTexts);

		let openedSessionManager: SessionManager | undefined;
		try {
			const opened = await SessionManager.open(sessionFile, destination);
			openedSessionManager = opened;
			const persistedAssistantEntries = assistantTexts.map(assistantText =>
				findPersistedMessageEntry(opened, "assistant", assistantText),
			);
			for (const persistedAssistantEntry of persistedAssistantEntries) {
				const { message } = persistedAssistantEntry;
				if (message.role !== "assistant") {
					throw new Error("Expected persisted managed assistant message");
				}
				expectAssistantReplayMetadataSanitized(message);
			}
			await opened.close();
			openedSessionManager = undefined;

			const reopened = await SessionManager.open(sessionFile, destination);
			openedSessionManager = reopened;
			for (const assistantText of assistantTexts) {
				const { message } = findPersistedMessageEntry(reopened, "assistant", assistantText);
				if (message.role !== "assistant") {
					throw new Error("Expected reopened managed assistant message");
				}
				expectAssistantReplayMetadataSanitized(message);
			}

			const persistedText = fs.readFileSync(sessionFile, "utf8");
			const patchRecords = persistedText.split("\n").filter(record => record.includes('"type":"entry_patch"'));
			expect(persistedText).toContain("enc_stale");
			expect(patchRecords).toHaveLength(0);
		} finally {
			await openedSessionManager?.close();
		}
	});

	it("sanitizes a managed transcript larger than 20 MiB in memory without rewriting on open", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-3793-large-managed-open-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const assistantTexts = Array.from(
			{ length: 256 },
			(_, index) => `Large stale managed assistant ${index} ${"x".repeat(96 * 1024)}`,
		);

		const sourceManager = SessionManager.create(tempDir, path.join(tempDir, "source"));
		for (const assistantText of assistantTexts) {
			sourceManager.appendMessage(createStaleAssistantMessage(assistantText));
		}
		await sourceManager.flush();
		const sourceFile = sourceManager.getSessionFile();
		if (!sourceFile) throw new Error("Expected large source session file");
		await sourceManager.close();

		const destination = SessionManager.managedDestination(tempDir, path.join(tempDir, "agent"));
		const placeholderManager = SessionManager.create(tempDir, destination);
		await placeholderManager.flush();
		const sessionFile = placeholderManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected managed destination session file");
		await placeholderManager.close();
		fs.copyFileSync(sourceFile, sessionFile);
		rewritePersistedAssistantsAsStale(sessionFile, assistantTexts);
		expect(fs.statSync(sessionFile).size).toBeGreaterThan(20 * 1024 * 1024);

		let openedSessionManager: SessionManager | undefined;
		try {
			const opened = await SessionManager.open(sessionFile, destination);
			openedSessionManager = opened;

			for (const assistantText of [assistantTexts[0]!, assistantTexts.at(-1)!]) {
				const { message } = findPersistedMessageEntry(opened, "assistant", assistantText);
				if (message.role !== "assistant") throw new Error("Expected large persisted assistant message");
				expectAssistantReplayMetadataSanitized(message);
			}

			await opened.close();
			openedSessionManager = undefined;
			const reopened = await SessionManager.open(sessionFile, destination);
			openedSessionManager = reopened;
			const patchRecords = fs
				.readFileSync(sessionFile, "utf8")
				.split("\n")
				.filter(record => record.includes('"type":"entry_patch"'));
			expect(patchRecords).toHaveLength(0);
			expect(fs.readFileSync(sessionFile, "utf8")).toContain("enc_stale");
		} finally {
			await openedSessionManager?.close();
		}
	}, 30_000);

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
		expect(seed.messages).toHaveLength(3);
		expect(seed.metadata.skippedReasons["developer-role"]).toBe(1);
		const inheritedToolDigest = seed.messages.at(-1);
		expect(inheritedToolDigest).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "[tool result: bash]\nparent tool output" }],
		});
		expect(seed.metadata.approximateTokens).toBeGreaterThan(0);
		expect(seed.agentMessages).toEqual(seed.messages);
		expect(seed.messages.every(message => !("providerPayload" in message))).toBe(true);
		const inheritedAssistant = seed.messages.find(message => message.role === "assistant");
		if (!inheritedAssistant || typeof inheritedAssistant.content === "string") {
			throw new Error("Expected sanitized inherited assistant message");
		}
		expect(inheritedAssistant.content.every(block => block.type !== "thinking")).toBe(true);

		const jsonEdgeMessage = {
			role: "user" as const,
			content: {
				dropped: undefined,
				date: new Date("2026-06-12T08:12:00.000Z"),
				proto: Object.assign(Object.create({ inherited: "ignored" }), { own: "kept" }),
				// biome-ignore lint/suspicious/noSparseArray: array hole is an intentional JSON-semantics fixture
				array: [undefined, , new Date("2024-01-02T03:04:05.000Z")],
			},
			timestamp: Date.now(),
		};
		const providerMessages = (
			parent as unknown as { model: unknown; messages: Message[]; agent: { state: { messages: Message[] } } }
		).messages;
		const originalProviderMessages = [...providerMessages];
		providerMessages.splice(0, providerMessages.length, jsonEdgeMessage as unknown as Message);
		const jsonSeed = await parent.buildForkContextSeed({ maxMessages: 10, maxTokens: 10_000 });
		const seededJsonMessage = jsonSeed.messages.find(
			message => message.role === "user" && typeof message.content === "object",
		);
		expect(JSON.stringify(seededJsonMessage)).toBe(
			JSON.stringify({ ...JSON.parse(JSON.stringify(jsonEdgeMessage)), attribution: "user" }),
		);
		expect(jsonSeed.agentMessages).toEqual(jsonSeed.messages);
		providerMessages.splice(0, providerMessages.length, ...originalProviderMessages);
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
		// A fork owns a new transcript and provider transport/cache affinity. It
		// inherits only the sanitized prompt seed, never the parent's session.
		expect(child.agent.sessionId).toBe(child.sessionId);
		expect(child.agent.providerSessionId).toBe(child.sessionId);
		expect(child.agent.providerSessionId).not.toBe(parent.agent.providerSessionId);
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
		expect(child.messages.slice(0, seed.agentMessages.length)).toEqual(seed.agentMessages);

		parent.agent.appendMessage({ role: "user", content: "oversized ".repeat(5_000), timestamp: Date.now() });
		const boundedSeed = await parent.buildForkContextSeed({ maxMessages: 10, maxTokens: 1 });
		expect(boundedSeed.messages).toHaveLength(0);
		expect(boundedSeed.metadata.skippedReasons["token-limit"]).toBeGreaterThan(0);

		parent.agent.appendMessage({ role: "user", content: "Preserve this prompt", timestamp: Date.now() + 1 });
		parent.agent.appendMessage(createStaleAssistantMessage("oversized assistant ".repeat(5_000)));
		const lastTurnSeed = await parent.buildForkContextSeed({
			maxMessages: 2,
			maxTokens: 100,
			preserveLatestUser: true,
		});
		expect(lastTurnSeed.messages.map(message => message.role)).toEqual(["user", "assistant"]);
		expect(getTextContent(lastTurnSeed.messages[0]!)).toContain("Preserve this prompt");
		expect(lastTurnSeed.metadata.approximateTokens).toBeLessThanOrEqual(100);
		expect(lastTurnSeed.metadata.includedMessages + lastTurnSeed.metadata.skippedMessages).toBe(
			lastTurnSeed.metadata.parentMessageCount,
		);
	});

	it("propagates appendOnlyPrefixSnapshot through buildForkContextSeed when append-only mode is active", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-fc-default-append-only-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const parentManager = SessionManager.create(tempDir, tempDir);

		const deepseekModel = getBundledModel("deepseek", "deepseek-chat");
		const provider: Parameters<typeof getBundledModel>[0] = deepseekModel ? "deepseek" : "openai";
		const modelId = deepseekModel ? "deepseek-chat" : "gpt-5-mini";

		const { session: parent, authStorage } = await createSessionHarness(tempDir, parentManager, {
			provider,
			modelId,
			settings: { "provider.appendOnlyContext": "on" },
		});
		sessions.push(parent);
		authStorages.push(authStorage);

		parent.agent.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Refactor auth." }],
			attribution: "user",
			timestamp: Date.now() - 10_000,
		});

		const seed = await parent.buildForkContextSeed({ maxMessages: 10, maxTokens: 10_000 });

		if (parent.agent.appendOnlyContext) {
			expect(seed.appendOnlyPrefixSnapshot).toBeDefined();
			expect(seed.appendOnlyPrefixSnapshot?.fingerprint).toBe(parent.agent.appendOnlyContext.prefix.fingerprint);

			const parentFingerprintBefore = parent.agent.appendOnlyContext.prefix.fingerprint;
			(seed.appendOnlyPrefixSnapshot as { fingerprint: string }).fingerprint = "TAMPER";
			expect(parent.agent.appendOnlyContext.prefix.fingerprint).toBe(parentFingerprintBefore);
		} else {
			expect(seed.appendOnlyPrefixSnapshot).toBeUndefined();
		}
	});

	it("preserves a forked child seeded prefix across compaction and prune rewrites", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-fc-seeded-rewrite-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const parentManager = SessionManager.create(tempDir, tempDir);
		const { session: parent, authStorage: parentAuthStorage } = await createSessionHarness(tempDir, parentManager, {
			provider: "openai-codex",
			modelId: "gpt-5.2-codex",
			settings: { "provider.appendOnlyContext": "on" },
		});
		sessions.push(parent);
		authStorages.push(parentAuthStorage);
		parent.agent.appendMessage({
			role: "user",
			content: [{ type: "text", text: "parent seeded prefix" }],
			attribution: "user",
			timestamp: Date.now() - 10_000,
		});
		const seed = await parent.buildForkContextSeed({ maxMessages: 10, maxTokens: 10_000 });
		expect(seed.appendOnlyPrefixSnapshot).toBeDefined();
		const childManager = SessionManager.create(tempDir, tempDir);
		const { session: child, authStorage: childAuthStorage } = await createSessionHarness(tempDir, childManager, {
			provider: "openai-codex",
			modelId: "gpt-5.2-codex",
			settings: { "provider.appendOnlyContext": "on", "compaction.keepRecentTokens": 10 },
			forkContextSeed: seed,
		});
		sessions.push(child);
		authStorages.push(childAuthStorage);
		const appendOnly = child.agent.appendOnlyContext;
		expect(appendOnly).not.toBeUndefined();
		if (!appendOnly) return;
		const seededPrefix = appendOnly.log.toMessages();
		expect(seededPrefix).toEqual(seed.messages);

		const oldLocal = { role: "user" as const, content: "child old local", timestamp: Date.now() - 3_000 };
		const keptLocal = { role: "user" as const, content: "child kept local", timestamp: Date.now() - 2_000 };
		child.agent.appendMessage(oldLocal);
		child.agent.appendMessage(keptLocal);
		childManager.appendMessage(oldLocal);
		const firstKeptEntryId = childManager.appendMessage(keptLocal);
		const compactionEntryId = childManager.appendCompaction(
			"child summary",
			"child summary",
			firstKeptEntryId,
			1_000,
		);
		const compactionLocal = {
			role: "user" as const,
			content: "child-before-compaction-rewrite",
			timestamp: Date.now() - 1_000,
		};
		appendOnly.syncMessages([...seededPrefix, compactionLocal]);
		expect(appendOnly.log.toMessages()).toHaveLength(seededPrefix.length + 1);
		await child.applyCompactionPostAppendForTests(compactionEntryId, firstKeptEntryId);
		expect(appendOnly.log.toMessages().slice(0, seededPrefix.length)).toEqual(seededPrefix);
		expect(appendOnly.log.toMessages()).not.toContainEqual(compactionLocal);

		const pruneOutput = "fork-prune-output-".repeat(60_000);
		const pruneCallId = "fork-prune-call";
		const pruneAssistant = {
			role: "assistant" as const,
			content: [{ type: "toolCall" as const, id: pruneCallId, name: "bash", arguments: { command: "cat" } }],
			api: child.model!.api,
			provider: child.model!.provider,
			model: child.model!.id,
			usage: createUsage(),
			stopReason: "toolUse" as const,
			timestamp: Date.now(),
		};
		const pruneResult = {
			role: "toolResult" as const,
			toolCallId: pruneCallId,
			toolName: "bash",
			content: [{ type: "text" as const, text: pruneOutput }],
			isError: false,
			timestamp: Date.now(),
		};
		const recentPruneResult = {
			role: "toolResult" as const,
			toolCallId: "fork-recent-call",
			toolName: "bash",
			content: [{ type: "text" as const, text: "fork-recent-output-".repeat(20_000) }],
			isError: false,
			timestamp: Date.now(),
		};
		const pruneFinalAssistant = {
			...createStaleAssistantMessage("fork final response", {
				api: child.model!.api,
				provider: child.model!.provider,
				model: child.model!.id,
			}),
			usage: { ...createUsage(), totalTokens: (child.model!.contextWindow ?? 200_000) + 100_000 },
		};
		for (const message of [
			pruneAssistant,
			pruneResult,
			recentPruneResult,
			{ role: "user" as const, content: "fork fence one", timestamp: Date.now() },
			pruneFinalAssistant,
			{ role: "user" as const, content: "fork fence two", timestamp: Date.now() },
		]) {
			child.agent.appendMessage(message as never);
			childManager.appendMessage(message as never);
		}
		const pruneLocal = { role: "user" as const, content: "child-before-prune-rewrite", timestamp: Date.now() };
		appendOnly.syncMessages([...seededPrefix, pruneLocal]);
		expect(appendOnly.log.toMessages()).toHaveLength(seededPrefix.length + 1);
		const outcome = await child.runMidRunMaintenanceForTests({
			systemPrompt: child.state.systemPrompt,
			messages: child.messages,
			tools: [],
		});
		expect(outcome).toBe("pruned");
		expect(appendOnly.log.toMessages().slice(0, seededPrefix.length)).toEqual(seededPrefix);
		expect(appendOnly.log.toMessages()).not.toContainEqual(pruneLocal);
		// Each session created by this test races the workspace-tree scan's 5s
		// startup deadline, so on slower runners the two harness sessions plus the
		// maintenance can exceed bun's 5s default. The CI failure this guards was
		// the StablePrefix fingerprint crash (fast); the generous bound only
		// prevents environment-speed false timeouts.
	}, 30_000);

	it("spawns bundled executor and architect via TaskTool with inheritContext: bounded through the production path", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-fc-task-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const parentManager = SessionManager.create(tempDir, tempDir);

		const { session: parent, authStorage } = await createSessionHarness(tempDir, parentManager, {
			settings: { "task.forkContext.enabled": true },
		});
		sessions.push(parent);
		authStorages.push(authStorage);

		parent.agent.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Establishing parent context for fork-context spawn test." }],
			attribution: "user",
			timestamp: Date.now() - 10_000,
		});

		const bundledExecutor = agentsModule.getBundledAgent("executor");
		const bundledArchitect = agentsModule.getBundledAgent("architect");
		expect(bundledExecutor?.forkContext).toBe("allowed");
		expect(bundledArchitect?.forkContext).toBe("allowed");

		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [bundledExecutor!, bundledArchitect!],
			projectAgentsDir: null,
		});

		const childCaptures: Array<{
			agentDisplayName?: string;
			forkContextSeed?: ForkContextSeed;
			providerSessionId?: string;
		}> = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options = {}) => {
			childCaptures.push({
				agentDisplayName: options.agentDisplayName,
				forkContextSeed: options.forkContextSeed,
				providerSessionId: options.providerSessionId,
			});
			const listeners: Array<
				(event: Parameters<AgentSession["subscribe"]>[0] extends (event: infer E) => void ? E : never) => void
			> = [];
			const stubSession: Partial<AgentSession> = {
				state: { messages: [] } as unknown as AgentSession["state"],
				agent: { state: { systemPrompt: ["stub"] } } as unknown as AgentSession["agent"],
				model: undefined,
				sessionManager: {
					appendSessionInit: () => {},
					getSessionFile: () => null,
					getArtifactsDir: () => null,
				} as unknown as AgentSession["sessionManager"],
				getActiveToolNames: () => ["yield"],
				setActiveToolsByName: async () => {},
				subscribe: ((listener: (typeof listeners)[number]) => {
					listeners.push(listener);
					return () => {
						const index = listeners.indexOf(listener);
						if (index >= 0) listeners.splice(index, 1);
					};
				}) as AgentSession["subscribe"],
				prompt: async () => {
					(stubSession.state as { messages: Message[] }).messages.push({
						role: "assistant",
						content: [{ type: "text", text: "(stub-yield)" }],
						api: "openai-responses",
						provider: "openai",
						model: "mock",
						usage: createUsage(),
						stopReason: "stop",
						timestamp: Date.now(),
					});
					for (const listener of listeners) {
						listener({
							type: "tool_execution_end",
							toolCallId: "yield-call",
							toolName: "yield",
							result: {
								content: [{ type: "text", text: "Result submitted." }],
								details: { status: "success", data: { ok: true } },
							},
							isError: false,
						});
					}
				},
				waitForIdle: async () => {},
				getLastAssistantMessage: () => {
					const messages = (stubSession.state as { messages: Message[] }).messages;
					for (let i = messages.length - 1; i >= 0; i--) {
						const message = messages[i];
						if (message?.role === "assistant") return message as AssistantMessage;
					}
					return undefined;
				},
				abort: async () => {},
				dispose: async () => {},
			};
			return {
				session: stubSession as AgentSession,
				extensionsResult: {} as CreateAgentSessionResult["extensionsResult"],
				setToolUIContext: () => {},
				eventBus: new eventBusModule.EventBus(),
			} satisfies CreateAgentSessionResult;
		});

		const manager = new asyncModule.AsyncJobManager({ onJobComplete: async () => {} });
		asyncModule.AsyncJobManager.setInstance(manager);

		const toolSession = {
			cwd: tempDir,
			hasUI: false,
			settings: settingsModule.Settings.isolated({
				"async.enabled": false,
				"task.forkContext.enabled": true,
			}),
			getSessionFile: () => parent.sessionManager.getSessionFile(),
			getSessionId: () => parent.sessionId,
			getSessionSpawns: () => "*",
			model: parent.model,
			buildForkContextSeed: (opts: Parameters<AgentSession["buildForkContextSeed"]>[0]) =>
				parent.buildForkContextSeed(opts),
			modelRegistry: {
				authStorage: undefined,
				refresh: async () => {},
				getAvailable: () => [],
				getApiKey: async () => null,
			},
			// Inject the manager used by this production-path harness; the real SDK
			// ToolSession exposes the same accessor for endpoint-owned routing.
			getAsyncJobManager: () => manager,
		};

		const tool = await taskModule.TaskTool.create(
			toolSession as unknown as Parameters<typeof taskModule.TaskTool.create>[0],
		);

		await tool.execute("call-exec", {
			agent: "executor",
			tasks: [{ id: "ExecFork", description: "d", assignment: "a", inheritContext: "bounded" }],
		});
		await tool.execute("call-arch", {
			agent: "architect",
			tasks: [{ id: "ArchFork", description: "d", assignment: "a", inheritContext: "bounded" }],
		});
		try {
			await manager.waitForAll();
		} finally {
			await manager.dispose({ timeoutMs: 100 });
			asyncModule.AsyncJobManager.resetForTests();
			vi.restoreAllMocks();
		}

		expect(childCaptures).toHaveLength(2);
		const execChild = childCaptures.find(o => o.agentDisplayName === "executor");
		const archChild = childCaptures.find(o => o.agentDisplayName === "architect");
		expect(execChild).toBeDefined();
		expect(archChild).toBeDefined();

		const expectedIds = new Map([
			["executor", JSON.stringify(["subagent-canonical", parent.sessionId, "0-ExecFork"])],
			["architect", JSON.stringify(["subagent-canonical", parent.sessionId, "0-ArchFork"])],
		]);
		for (const child of [execChild!, archChild!]) {
			expect(child.forkContextSeed).toBeDefined();
			expect(child.providerSessionId).toBe(expectedIds.get(child.agentDisplayName!));
			expect(child.providerSessionId).not.toBe(parent.sessionId);
		}
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
		if (customEntry?.type !== "custom_message") {
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
			settings: { "provider.appendOnlyContext": "on" },
		});
		sessions.push(session);
		authStorages.push(authStorage);
		const appendOnly = session.agent.appendOnlyContext;
		expect(appendOnly).not.toBeUndefined();
		appendOnly?.syncMessages([{ role: "user", content: "reload-provider-marker" }]);
		expect(appendOnly?.log.length).toBe(1);

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
		expect(appendOnly?.log.length).toBe(0);
		expect(session.providerSessionState.size).toBe(0);
		expect(session.model?.provider).toBe("openai-codex");
		expect(session.model?.id).toBe("gpt-5.2-codex");
		expect(
			session.messages.some(
				message => message.role === "user" && getTextContent(message) === "Externally appended follow-up",
			),
		).toBe(true);
	});

	it("preserves bash signal metadata across persisted reload and provider replay normalization", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-5291-bash-signal-${Snowflake.next()}-`));
		tempDirs.push(tempDir);

		const { sessionFile } = await createPersistedSession(tempDir, sessionManager => {
			sessionManager.appendModelChange("openai-codex/gpt-5.2-codex");
			sessionManager.appendMessage({ role: "user", content: "before signalled command", timestamp: Date.now() });
			sessionManager.appendMessage({
				role: "bashExecution",
				command: "kill -TERM $$",
				output: "",
				exitCode: 143,
				signal: "SIGTERM",
				cancelled: false,
				truncated: false,
				timestamp: Date.now(),
			});
			sessionManager.appendMessage(createStaleAssistantMessage("after signalled command"));
		});

		const reloadedSessionManager = await SessionManager.open(sessionFile, tempDir);
		const { session, authStorage } = await createSessionHarness(tempDir, reloadedSessionManager, {
			provider: "openai-codex",
			modelId: "gpt-5.2-codex",
		});
		sessions.push(session);
		authStorages.push(authStorage);
		await session.reload();

		const initialBashMessage = session.messages.find(message => message.role === "bashExecution");
		if (initialBashMessage?.role !== "bashExecution") {
			throw new Error("Expected restored bash execution message");
		}
		expect(initialBashMessage.signal).toBe("SIGTERM");

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", { close: closeSpy } satisfies ProviderSessionState);

		const rewrittenLines = fs
			.readFileSync(sessionFile, "utf8")
			.trimEnd()
			.split("\n")
			.map(line => {
				const entry = JSON.parse(line) as SessionEntry;
				if (entry.type === "message" && entry.message.role === "bashExecution") {
					entry.message = { ...entry.message, signal: "SIGKILL" };
				}
				return JSON.stringify(entry);
			});
		fs.writeFileSync(sessionFile, `${rewrittenLines.join("\n")}\n`, "utf8");

		await session.reload();

		expect(closeSpy).toHaveBeenCalledTimes(1);
		const restoredBashMessage = session.messages.find(message => message.role === "bashExecution");
		if (restoredBashMessage?.role !== "bashExecution") throw new Error("Expected reloaded bash execution message");
		expect(restoredBashMessage.signal).toBe("SIGKILL");

		const rendered = convertToLlm([restoredBashMessage])[0];
		const renderedText = rendered && typeof rendered.content !== "string" ? rendered.content[0] : undefined;
		expect(renderedText?.type).toBe("text");
		if (renderedText?.type !== "text") throw new Error("Expected rendered bash text");
		expect(renderedText.text).toContain("Command terminated by SIGKILL (exit code 143)");
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

	it.each([
		"EACCES",
		"EPERM",
		"EROFS",
	] as const)("publishes a read-only successor and retries local:// setup after %s", async code => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-readonly-local-switch-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const currentSessionManager = SessionManager.create(tempDir, tempDir);
		const { session, authStorage } = await createSessionHarness(tempDir, currentSessionManager);
		sessions.push(session);
		authStorages.push(authStorage);
		const predecessorSessionId = session.sessionId;
		const { sessionFile } = await createPersistedSession(tempDir, sessionManager => {
			sessionManager.appendMessage({ role: "user", content: "read-only successor", timestamp: Date.now() });
		});
		const readiness = vi.spyOn(internalUrls, "initializeLocalRoot").mockRejectedValue(makeFsError(code));

		try {
			await expect(session.switchSession(sessionFile)).resolves.toBe(true);
			const successorSessionId = session.sessionManager.getSessionId();
			expect(successorSessionId).not.toBe(predecessorSessionId);
			expect(session.sessionId).toBe(successorSessionId);
			expect(session.agent.sessionId).toBe(successorSessionId);
			expect(session.sessionFile).toBe(sessionFile);

			await expect(session.reload()).resolves.toBeUndefined();
			expect(readiness).toHaveBeenCalledTimes(2);

			const localOptions = {
				getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
				isManagedDestination: () => session.sessionManager.isManagedDestination(),
				getManagedLegacyLocalMigrationSource: () => session.sessionManager.getManagedLegacyLocalMigrationSource(),
				getSessionId: () => session.sessionManager.getSessionId(),
			};
			const localMkdir = vi.spyOn(fs, "mkdirSync").mockImplementation((() => {
				throw makeFsError(code);
			}) as typeof fs.mkdirSync);
			try {
				expect(() => internalUrls.resolveLocalUrlToPath("local://retry.md", localOptions)).toThrow(code);
			} finally {
				localMkdir.mockRestore();
			}
			const localPath = internalUrls.resolveLocalUrlToPath("local://retry.md", localOptions);
			fs.writeFileSync(localPath, "retried local root");
			expect(fs.readFileSync(localPath, "utf8")).toBe("retried local root");
		} finally {
			readiness.mockRestore();
		}
	});

	it("rolls back an unrelated local-root failure with predecessor authority intact", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-local-switch-rollback-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const currentSessionManager = SessionManager.create(tempDir, tempDir);
		const { session, authStorage } = await createSessionHarness(tempDir, currentSessionManager);
		sessions.push(session);
		authStorages.push(authStorage);
		const predecessor = {
			sessionId: session.sessionId,
			sessionFile: session.sessionFile,
			managerSessionId: currentSessionManager.getSessionId(),
			managerSessionFile: currentSessionManager.getSessionFile(),
			agentSessionId: session.agent.sessionId,
			agentProviderSessionId: session.agent.providerSessionId,
		};
		const { sessionFile } = await createPersistedSession(tempDir, sessionManager => {
			sessionManager.appendMessage({ role: "user", content: "failed successor", timestamp: Date.now() });
		});
		const readiness = vi
			.spyOn(internalUrls, "initializeLocalRoot")
			.mockRejectedValueOnce(new Error("unexpected local root initialization failure"));

		try {
			await expect(session.switchSession(sessionFile)).rejects.toThrow(
				"unexpected local root initialization failure",
			);
			expect(session.sessionId).toBe(predecessor.sessionId);
			expect(session.sessionFile).toBe(predecessor.sessionFile);
			expect(currentSessionManager.getSessionId()).toBe(predecessor.managerSessionId);
			expect(currentSessionManager.getSessionFile()).toBe(predecessor.managerSessionFile);
			expect(session.agent.sessionId).toBe(predecessor.agentSessionId);
			expect(session.agent.providerSessionId).toBe(predecessor.agentProviderSessionId);
		} finally {
			readiness.mockRestore();
		}
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
