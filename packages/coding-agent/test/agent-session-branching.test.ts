/**
 * Tests for AgentSession branching behavior.
 *
 * These tests verify:
 * - Branching from a single message works
 * - Branching in --no-session mode (in-memory only)
 * - getUserMessagesForBranching returns correct entries
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { createTools, type ToolSession } from "@gajae-code/coding-agent/tools";
import { Snowflake } from "@gajae-code/utils";
import { e2eApiKey } from "./utilities";

describe.skipIf(!e2eApiKey("ANTHROPIC_API_KEY"))("AgentSession branching", () => {
	let session: AgentSession;
	let tempDir: string;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage | undefined;

	beforeEach(() => {
		// Create temp directory for session files
		tempDir = path.join(os.tmpdir(), `pi-branching-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		authStorage = undefined;
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	});

	async function createSession(noSession: boolean = false) {
		const toolSession: ToolSession = {
			cwd: tempDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const tools = await createTools(toolSession);

		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => e2eApiKey("ANTHROPIC_API_KEY"),
			initialState: {
				model,
				systemPrompt: ["You are a helpful assistant. Be extremely concise, reply with just a few words."],
				tools,
			},
		});

		sessionManager = noSession ? SessionManager.inMemory() : SessionManager.create(tempDir, tempDir);
		const settings = Settings.isolated();
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});

		// Must subscribe to enable session persistence
		session.subscribe(() => {});

		return session;
	}

	it("should allow branching from single message", async () => {
		await createSession();

		// Send one message
		await session.prompt("Say hello");
		await session.agent.waitForIdle();

		// Should have exactly 1 user message available for branching
		const userMessages = session.getUserMessagesForBranching();
		expect(userMessages.length).toBe(1);
		expect(userMessages[0].text).toBe("Say hello");

		// Branch from the first message
		const result = await session.branch(userMessages[0].entryId);
		expect(result.selectedText).toBe("Say hello");
		expect(result.cancelled).toBe(false);

		// After branching, conversation should be empty (branched before the first message)
		expect(session.messages.length).toBe(0);

		// Session file should exist (new branch)
		expect(session.sessionFile).not.toBeNull();
		expect(fs.existsSync(session.sessionFile!)).toBe(true);
	});

	it("should support in-memory branching in --no-session mode", async () => {
		await createSession(true);

		// Verify sessions are disabled
		expect(session.sessionFile).toBeUndefined();

		// Send one message
		await session.prompt("Say hi");
		await session.agent.waitForIdle();

		// Should have 1 user message
		const userMessages = session.getUserMessagesForBranching();
		expect(userMessages.length).toBe(1);

		// Verify we have messages before branching
		expect(session.messages.length).toBeGreaterThan(0);

		// Branch from the first message
		const result = await session.branch(userMessages[0].entryId);
		expect(result.selectedText).toBe("Say hi");
		expect(result.cancelled).toBe(false);

		// After branching, conversation should be empty
		expect(session.messages.length).toBe(0);

		// Session file should still be undefined (no file created)
		expect(session.sessionFile).toBeUndefined();
	});

	it("should branch from middle of conversation", async () => {
		await createSession();

		// Send multiple messages
		await session.prompt("Say one");
		await session.agent.waitForIdle();

		await session.prompt("Say two");
		await session.agent.waitForIdle();

		await session.prompt("Say three");
		await session.agent.waitForIdle();

		// Should have 3 user messages
		const userMessages = session.getUserMessagesForBranching();
		expect(userMessages.length).toBe(3);

		// Branch from second message (keeps first message + response)
		const secondMessage = userMessages[1];
		const result = await session.branch(secondMessage.entryId);
		expect(result.selectedText).toBe("Say two");

		// After branching, should have first user message + assistant response
		expect(session.messages.length).toBe(2);
		expect(session.messages[0].role).toBe("user");
		expect(session.messages[1].role).toBe("assistant");
	});
});

function largeBranchMarker(label: string): string {
	return `${label}-${"x".repeat(520_000)}-end`;
}

async function createFidelityAgentSession(tempDir: string): Promise<{
	session: AgentSession;
	sessionManager: SessionManager;
	authStorage: AuthStorage;
}> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: ["test"],
			tools: [],
		},
	});
	const sessionManager = SessionManager.create(tempDir, tempDir);
	const authStorage = await AuthStorage.create(path.join(tempDir, "fidelity-auth.db"));
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "fidelity-models.yml"));
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated(),
		modelRegistry,
	});
	session.subscribe(() => {});
	return { session, sessionManager, authStorage };
}

async function evictOldBranchMessage(sessionManager: SessionManager, marker: string): Promise<string> {
	sessionManager.appendMessage({ role: "user", content: "intro", timestamp: Date.now() });
	sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "intro response" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	});
	const oldUserId = sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: marker }],
		timestamp: Date.now(),
	});
	const firstKeptEntryId = sessionManager.appendMessage({ role: "user", content: "kept", timestamp: Date.now() });
	const compactionEntryId = sessionManager.appendCompaction("summary", "short", firstKeptEntryId, 123);
	sessionManager.evictCompactedContent(firstKeptEntryId, compactionEntryId);
	await sessionManager.flush();
	return oldUserId;
}

describe("AgentSession branching fidelity", () => {
	it("uses original pre-compaction user text for branch selectedText", async () => {
		const tempDir = path.join(os.tmpdir(), `gjc-branch-selected-fidelity-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		let session: AgentSession | undefined;
		let authStorage: AuthStorage | undefined;
		try {
			const marker = largeBranchMarker("branch-selected-original");
			const created = await createFidelityAgentSession(tempDir);
			session = created.session;
			authStorage = created.authStorage;
			const oldUserId = await evictOldBranchMessage(created.sessionManager, marker);

			const result = await session.branch(oldUserId);

			expect(result.cancelled).toBe(false);
			expect(result.selectedText).toBe(marker);
			expect(result.selectedText).not.toContain("compacted history evicted");
		} finally {
			await session?.dispose();
			authStorage?.close();
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("lists evicted user messages with original text in the branch picker", async () => {
		const tempDir = path.join(os.tmpdir(), `gjc-branch-picker-fidelity-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		let session: AgentSession | undefined;
		let authStorage: AuthStorage | undefined;
		try {
			const marker = largeBranchMarker("branch-picker-original");
			const created = await createFidelityAgentSession(tempDir);
			session = created.session;
			authStorage = created.authStorage;
			const oldUserId = await evictOldBranchMessage(created.sessionManager, marker);

			const messages = session.getUserMessagesForBranching();
			const oldMessage = messages.find(message => message.entryId === oldUserId);

			expect(oldMessage).toBeDefined();
			expect(oldMessage?.text).toBe(marker);
			expect(oldMessage?.text).not.toContain("compacted history evicted");
		} finally {
			await session?.dispose();
			authStorage?.close();
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
