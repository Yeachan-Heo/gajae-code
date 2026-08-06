import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai/models";
import type { Message, ProviderSessionState } from "@gajae-code/ai/types";
import { Snowflake } from "@gajae-code/utils";
import { Settings } from "../src/config/settings";
import { createAgentSession } from "../src/sdk";
import type { AgentSession, ForkContextSeed } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

function createHandBuiltSeed(): ForkContextSeed {
	const message: Message = {
		role: "user",
		content: [{ type: "text", text: "seed" }],
		attribution: "user",
		timestamp: 1,
	};
	return {
		messages: [message],
		agentMessages: [message],
		metadata: {
			sourceSessionId: "parent-session-id",
			parentMessageCount: 1,
			includedMessages: 1,
			skippedMessages: 0,
			approximateTokens: 1,
			maxMessages: 50,
			maxTokens: 1_000,
			skippedReasons: {},
		},
	};
}

async function createSession(
	tempDir: string,
	options: {
		forkContextSeed?: ForkContextSeed;
		providerSessionId?: string;
		providerSessionState?: Map<string, ProviderSessionState>;
		sessionManager?: SessionManager;
	} = {},
) {
	const authStorage = await AuthStorage.create(path.join(tempDir, `auth-${Snowflake.next()}.db`));
	authStorage.setRuntimeApiKey("openai", "test-key");
	const model = getBundledModel("openai", "gpt-5-mini");
	if (!model) throw new Error("Expected bundled openai/gpt-5-mini model");
	const result = await createAgentSession({
		cwd: tempDir,
		agentDir: tempDir,
		authStorage,
		sessionManager: options.sessionManager ?? SessionManager.create(tempDir, tempDir),
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
	return { session: result.session, authStorage };
}

describe("task fork-context provider identity", () => {
	const sessions: AgentSession[] = [];
	const authStorages: AuthStorage[] = [];
	const tempDirs: string[] = [];

	afterEach(async () => {
		while (sessions.length > 0) await sessions.pop()?.dispose();
		while (authStorages.length > 0) authStorages.pop()?.close();
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("gives concurrent fork-context children distinct provider session identities", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-task-cache-key-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const { session: parent, authStorage: parentAuth } = await createSession(tempDir);
		sessions.push(parent);
		authStorages.push(parentAuth);
		parent.agent.appendMessage({ role: "user", content: "parent context", timestamp: Date.now() });

		// One seed per parallel task, exactly as TaskTool schedules them.
		const seedA = await parent.buildForkContextSeed({ maxMessages: 50, maxTokens: 10_000 });
		const seedB = await parent.buildForkContextSeed({ maxMessages: 50, maxTokens: 10_000 });
		expect(seedA.metadata.includedMessages).toBeGreaterThan(0);

		const { session: childA, authStorage: authA } = await createSession(tempDir, { forkContextSeed: seedA });
		sessions.push(childA);
		authStorages.push(authA);
		const { session: childB, authStorage: authB } = await createSession(tempDir, { forkContextSeed: seedB });
		sessions.push(childB);
		authStorages.push(authB);

		// Children inherit forked conversation context...
		expect(childA.messages.slice(0, seedA.agentMessages.length)).toEqual(seedA.agentMessages);

		// ...but never the parent's provider-facing continuity identity. Sharing it
		// makes every concurrent worker present the same session_id upstream, which
		// session-owning transports reject (owner_busy) and degrade to uncached HTTP.
		expect(parent.agent.providerSessionId).toBe(parent.sessionId);
		expect(childA.agent.providerSessionId).toBe(childA.sessionId);
		expect(childB.agent.providerSessionId).toBe(childB.sessionId);
		expect(childA.sessionId).not.toBe(parent.sessionId);
		expect(childB.sessionId).not.toBe(parent.sessionId);
		expect(childA.agent.providerSessionId).not.toBe(childB.agent.providerSessionId);
	});

	it("keeps the persisted child identity across a detached resume with the same seed and session file", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-task-detached-resume-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const { session: parent, authStorage: parentAuth } = await createSession(tempDir);
		sessions.push(parent);
		authStorages.push(parentAuth);
		parent.agent.appendMessage({ role: "user", content: "parent context", timestamp: Date.now() });
		const seed = await parent.buildForkContextSeed({ maxMessages: 50, maxTokens: 10_000 });
		expect(seed.metadata.includedMessages).toBeGreaterThan(0);

		// TaskTool allocates one session file per detached child; the initial run
		// and the detached resume both open it via SessionManager.open with an
		// explicit destination (task/index.ts resume runner -> executor).
		const childSessionFile = path.join(tempDir, "child-task.jsonl");
		const { session: child, authStorage: childAuth } = await createSession(tempDir, {
			forkContextSeed: seed,
			sessionManager: await SessionManager.open(
				childSessionFile,
				SessionManager.explicitDestination(path.dirname(childSessionFile)),
			),
		});
		sessions.push(child);
		authStorages.push(childAuth);
		const childSessionId = child.sessionId;
		expect(child.agent.providerSessionId).toBe(childSessionId);
		expect(childSessionId).not.toBe(parent.sessionId);

		// Persist one child turn the way AgentSession does on message_end, so the
		// session file holds state the seed does not contain.
		const persistedTurn: Message = {
			role: "user",
			content: [{ type: "text", text: "persisted child turn" }],
			attribution: "user",
			timestamp: Date.now(),
		};
		child.agent.appendMessage(persistedTurn);
		child.sessionManager.appendMessage(persistedTurn);
		await child.sessionManager.flush();
		await child.dispose();

		// The resume descriptor replays the SAME fork seed alongside the persisted
		// session file; identity and content must come from the session, not the seed.
		const { session: resumed, authStorage: resumedAuth } = await createSession(tempDir, {
			forkContextSeed: seed,
			sessionManager: await SessionManager.open(
				childSessionFile,
				SessionManager.explicitDestination(path.dirname(childSessionFile)),
			),
		});
		sessions.push(resumed);
		authStorages.push(resumedAuth);

		expect(resumed.agent.providerSessionId).toBe(childSessionId);
		expect(resumed.agent.providerSessionId).not.toBe(parent.sessionId);
		expect(resumed.agent.providerSessionId).not.toBe(seed.metadata.sourceSessionId);

		const restoredContent = resumed.messages.map(message => JSON.stringify(message));
		expect(restoredContent.some(content => content.includes("persisted child turn"))).toBe(true);
		expect(restoredContent.some(content => content.includes("parent context"))).toBe(false);
	}, 15_000);

	it("honors an explicit providerSessionId over the fork seed and logical id", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-task-explicit-id-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const { session, authStorage } = await createSession(tempDir, {
			forkContextSeed: createHandBuiltSeed(),
			providerSessionId: "explicit-provider-session",
		});
		sessions.push(session);
		authStorages.push(authStorage);

		expect(session.agent.providerSessionId).toBe("explicit-provider-session");
	});

	it("does not share mutable provider state unless explicitly supplied", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-task-provider-state-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const parentState = new Map<string, ProviderSessionState>();
		parentState.set("openai-responses:openai", { close: () => {} });
		const { session, authStorage } = await createSession(tempDir, { forkContextSeed: createHandBuiltSeed() });
		sessions.push(session);
		authStorages.push(authStorage);

		expect(session.providerSessionState).not.toBe(parentState);
		expect(session.providerSessionState.size).toBe(0);
	});
});
