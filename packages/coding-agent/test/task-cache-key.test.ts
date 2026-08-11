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
import { ArtifactManager } from "../src/session/artifacts";
import { AuthStorage } from "../src/session/auth-storage";
import { ManagedSessionDescendantStore, managedDirectoryRoot } from "../src/session/internal/managed-session-storage";
import { SessionManager } from "../src/session/session-manager";
import { createManagedTaskPersistence } from "../src/task/executor";

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
async function withLifecycleIdentity<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
	const previousRequestId = process.env.GJC_LIFECYCLE_REQUEST_ID;
	const previousSessionId = process.env.GJC_SESSION_ID;
	try {
		process.env.GJC_LIFECYCLE_REQUEST_ID = "task-provider-identity-test";
		process.env.GJC_SESSION_ID = sessionId;
		return await run();
	} finally {
		if (previousRequestId === undefined) delete process.env.GJC_LIFECYCLE_REQUEST_ID;
		else process.env.GJC_LIFECYCLE_REQUEST_ID = previousRequestId;
		if (previousSessionId === undefined) delete process.env.GJC_SESSION_ID;
		else process.env.GJC_SESSION_ID = previousSessionId;
	}
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

	it("gives nested managed children distinct provider identities without rewriting logical headers", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-task-cache-key-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const { session: parent, authStorage: parentAuth } = await createSession(tempDir);
		sessions.push(parent);
		authStorages.push(parentAuth);
		parent.agent.appendMessage({ role: "user", content: "parent context", timestamp: Date.now() });
		const seedA = await parent.buildForkContextSeed({ maxMessages: 50, maxTokens: 10_000 });
		const seedB = await parent.buildForkContextSeed({ maxMessages: 50, maxTokens: 10_000 });
		expect(seedA.metadata.includedMessages).toBeGreaterThan(0);

		const artifactsDir = path.join(tempDir, "artifacts");
		const artifacts = new ArtifactManager(
			new ManagedSessionDescendantStore(managedDirectoryRoot(tempDir), artifactsDir),
		);
		const childAProviderSessionId = JSON.stringify(["subagent-canonical", parent.sessionId, "0-child-a"]);
		const childBProviderSessionId = JSON.stringify(["subagent-canonical", parent.sessionId, "1-child-b"]);
		const childAPersistence = createManagedTaskPersistence(artifacts, "0-child-a");
		const childBPersistence = createManagedTaskPersistence(artifacts, "1-child-b");
		const [{ session: childA, authStorage: authA }, { session: childB, authStorage: authB }] = await Promise.all([
			createSession(tempDir, {
				forkContextSeed: seedA,
				providerSessionId: childAProviderSessionId,
				sessionManager: await withLifecycleIdentity(parent.sessionId, () => childAPersistence.openSession(tempDir)),
			}),
			createSession(tempDir, {
				forkContextSeed: seedB,
				providerSessionId: childBProviderSessionId,
				sessionManager: await withLifecycleIdentity(parent.sessionId, () => childBPersistence.openSession(tempDir)),
			}),
		]);
		sessions.push(childA, childB);
		authStorages.push(authA, authB);

		expect(childA.messages.slice(0, seedA.agentMessages.length)).toEqual(seedA.agentMessages);
		expect(childA.sessionManager.getSessionFile()).toBe(path.join(artifactsDir, "0-child-a.jsonl"));
		expect(childB.sessionManager.getSessionFile()).toBe(path.join(artifactsDir, "1-child-b.jsonl"));
		// Nested managed persistence intentionally preserves the lifecycle-owned logical
		// header while provider continuity must be child-owned and collision-free.
		expect(childA.sessionManager.getSessionId()).toBe(parent.sessionManager.getSessionId());
		expect(childB.sessionManager.getSessionId()).toBe(parent.sessionManager.getSessionId());
		expect(childA.agent.providerSessionId).not.toBe(parent.sessionId);
		expect(childB.agent.providerSessionId).not.toBe(parent.sessionId);
		expect(childA.agent.providerSessionId).not.toBe(childB.agent.providerSessionId);
	}, 15_000);

	it("keeps a nested managed child provider identity across detached resume", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-task-detached-resume-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const { session: parent, authStorage: parentAuth } = await createSession(tempDir);
		sessions.push(parent);
		authStorages.push(parentAuth);
		parent.agent.appendMessage({ role: "user", content: "parent context", timestamp: Date.now() });
		const seed = await parent.buildForkContextSeed({ maxMessages: 50, maxTokens: 10_000 });
		const artifactsDir = path.join(tempDir, "artifacts");
		const artifacts = new ArtifactManager(
			new ManagedSessionDescendantStore(managedDirectoryRoot(tempDir), artifactsDir),
		);
		const persistence = createManagedTaskPersistence(artifacts, "0-resumable-child");
		const childProviderSessionId = JSON.stringify(["subagent-canonical", parent.sessionId, "0-resumable-child"]);
		const { session: child, authStorage: childAuth } = await createSession(tempDir, {
			forkContextSeed: seed,
			providerSessionId: childProviderSessionId,
			sessionManager: await withLifecycleIdentity(parent.sessionId, () => persistence.openSession(tempDir)),
		});
		sessions.push(child);
		authStorages.push(childAuth);
		expect(child.agent.providerSessionId).toBe(childProviderSessionId);
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

		const { session: resumed, authStorage: resumedAuth } = await createSession(tempDir, {
			forkContextSeed: seed,
			providerSessionId: childProviderSessionId,
			sessionManager: await withLifecycleIdentity(parent.sessionId, () => persistence.openSession(tempDir)),
		});
		sessions.push(resumed);
		authStorages.push(resumedAuth);

		expect(resumed.sessionManager.getSessionId()).toBe(parent.sessionManager.getSessionId());
		expect(resumed.agent.providerSessionId).toBe(childProviderSessionId);
		expect(resumed.agent.providerSessionId).not.toBe(parent.sessionId);
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
