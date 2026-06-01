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

function createSeed(cacheIdentity = "parent-cache-id"): ForkContextSeed {
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
		cacheIdentity,
	};
}

async function createSession(
	tempDir: string,
	seed: ForkContextSeed,
	providerSessionState?: Map<string, ProviderSessionState>,
) {
	const authStorage = await AuthStorage.create(path.join(tempDir, `auth-${Snowflake.next()}.db`));
	authStorage.setRuntimeApiKey("openai", "test-key");
	const model = getBundledModel("openai", "gpt-5-mini");
	if (!model) throw new Error("Expected bundled openai/gpt-5-mini model");
	const result = await createAgentSession({
		cwd: tempDir,
		agentDir: tempDir,
		authStorage,
		sessionManager: SessionManager.create(tempDir, tempDir),
		model,
		settings: Settings.isolated(),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		forkContextSeed: seed,
		providerSessionState,
	});
	return { session: result.session, authStorage };
}

describe("task fork-context cache identity", () => {
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

	it("uses seed cache identity as the provider-facing session id", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-task-cache-key-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const seed = createSeed("shared-parent-cache");
		const { session, authStorage } = await createSession(tempDir, seed);
		sessions.push(session);
		authStorages.push(authStorage);

		expect(session.sessionId).not.toBe("shared-parent-cache");
		expect(session.agent.providerSessionId).toBe("shared-parent-cache");
		expect(session.messages).toEqual(seed.agentMessages);
	});

	it("does not share mutable provider state unless explicitly supplied", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-task-provider-state-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const parentState = new Map<string, ProviderSessionState>();
		parentState.set("openai-responses:openai", { close: () => {} });
		const { session, authStorage } = await createSession(tempDir, createSeed());
		sessions.push(session);
		authStorages.push(authStorage);

		expect(session.providerSessionState).not.toBe(parentState);
		expect(session.providerSessionState.size).toBe(0);
	});
});
