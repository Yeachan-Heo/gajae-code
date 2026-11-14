import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { Snowflake } from "@gajae-code/utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { MemorySessionStorage } from "../../src/session/session-storage";

function assistantMsg(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

describe("issue #7699: TUI fork flow cache invalidation", () => {
	it("should see new prompts in fork selector after forking and adding prompts", async () => {
		// This test simulates the exact TUI flow:
		// 1. User calls /fork and selects a message
		// 2. New forked session is created with AgentSession wrapping new SessionManager
		// 3. User sends prompts in the forked session
		// 4. User calls /fork again
		// 5. getUserMessagesForBranching() should include the new prompts

		const tempDir = path.join(os.tmpdir(), `gjc-7699-tui-${Snowflake.next()}`);
		const storage = new MemorySessionStorage();

		// === Phase 1: Create original session with 3 prompts ===
		const originalManager = SessionManager.create("/cwd", "/sessions", storage);
		originalManager.appendMessage({ role: "user", content: "Original 1", timestamp: 1 });
		originalManager.appendMessage(assistantMsg("Response 1"));

		originalManager.appendMessage({
			role: "user",
			content: "Original 2",
			timestamp: 2,
		});
		originalManager.appendMessage(assistantMsg("Response 2"));

		originalManager.appendMessage({ role: "user", content: "Original 3", timestamp: 3 });
		originalManager.appendMessage(assistantMsg("Response 3"));

		await originalManager.flush();
		const originalFile = originalManager.getSessionFile();
		if (!originalFile) throw new Error("Expected session file");

		// === Phase 2: Fork the original session (simulates /fork handler) ===
		const forkedManager = await SessionManager.forkFrom(originalFile, "/cwd", "/sessions", storage);
		const tempAuthDir = path.join(tempDir, "fork1");
		await import("node:fs/promises").then(fs => fs.mkdir(tempAuthDir, { recursive: true }));
		const forkedAuth = await AuthStorage.create(path.join(tempAuthDir, "auth.db"));
		const forkedRegistry = new ModelRegistry(forkedAuth, path.join(tempAuthDir, "models.yml"));

		// Create AgentSession wrapper (this is what selector-controller.ts does)
		const forkedSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
					systemPrompt: ["Test"],
					tools: [],
				},
			}),
			sessionManager: forkedManager,
			settings: Settings.isolated(),
			modelRegistry: forkedRegistry,
		});
		forkedSession.subscribe(() => {});

		// Verify fork worked - should have original messages
		let messages = forkedSession.getUserMessagesForBranching();
		expect(messages.length).toBe(3);
		expect(messages[0].text).toContain("Original 1");

		// === Phase 3: Send new prompts in forked session (user types in editor) ===
		forkedManager.appendMessage({ role: "user", content: "Forked 1", timestamp: 4 });
		forkedManager.appendMessage(assistantMsg("Response 4"));

		forkedManager.appendMessage({ role: "user", content: "Forked 2", timestamp: 5 });
		forkedManager.appendMessage(assistantMsg("Response 5"));

		// === Phase 4: Call getUserMessagesForBranching again (simulates /fork selector) ===
		// THIS IS WHERE THE BUG MANIFESTS - new prompts should be visible

		// Then check what forkedSession.getUserMessagesForBranching() returns
		messages = forkedSession.getUserMessagesForBranching();

		// BUG: If this fails, it means getUserMessagesForBranching() is returning cached old list
		expect(messages.length).toBe(5);
		expect(messages[3].text).toContain("Forked 1");
		expect(messages[4].text).toContain("Forked 2");

		await forkedSession.dispose();
		forkedAuth.close();
	});

	it("should see new prompts through multi-level forks", async () => {
		// Test: Fork -> add prompts -> fork again -> should see all prompts

		const storage = new MemorySessionStorage();

		// === Level 0: Original session ===
		const level0 = SessionManager.create("/cwd", "/sessions", storage);
		level0.appendMessage({ role: "user", content: "L0-1", timestamp: 1 });
		level0.appendMessage(assistantMsg("R0-1"));
		const l0ForkPoint = level0.appendMessage({ role: "user", content: "L0-2", timestamp: 2 });
		level0.appendMessage(assistantMsg("R0-2"));

		await level0.flush();
		const level0File = level0.getSessionFile();
		if (!level0File) throw new Error("Expected level 0 file");

		// === Level 1: Fork from level 0 ===
		const level1 = await SessionManager.forkFrom(level0File, "/cwd", "/sessions", storage);
		level1.branch(l0ForkPoint);
		level1.appendMessage({ role: "user", content: "L1-1", timestamp: 3 });
		level1.appendMessage(assistantMsg("R1-1"));

		await level1.flush();
		const level1File = level1.getSessionFile();
		if (!level1File) throw new Error("Expected level 1 file");

		const tempAuthDir1 = path.join(os.tmpdir(), `7699-auth-${Snowflake.next()}`);
		await import("node:fs/promises").then(fs => fs.mkdir(tempAuthDir1, { recursive: true }));
		const auth1 = await AuthStorage.create(path.join(tempAuthDir1, "auth.db"));
		const reg1 = new ModelRegistry(auth1, path.join(tempAuthDir1, "models.yml"));

		const session1 = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
					systemPrompt: ["Test"],
					tools: [],
				},
			}),
			sessionManager: level1,
			settings: Settings.isolated(),
			modelRegistry: reg1,
		});
		session1.subscribe(() => {});

		// Check messages at level 1
		let messages = session1.getUserMessagesForBranching();
		expect(messages.length).toBe(3); // L0-1, L0-2, L1-1
		expect(messages[2].text).toContain("L1-1");

		// === Level 2: Fork from level 1 ===
		const level2 = await SessionManager.forkFrom(level1File, "/cwd", "/sessions", storage);
		level2.appendMessage({ role: "user", content: "L2-1", timestamp: 4 });
		level2.appendMessage(assistantMsg("R2-1"));

		await level2.flush();
		const level2File = level2.getSessionFile();
		if (!level2File) throw new Error("Expected level 2 file");

		const tempAuthDir2 = path.join(os.tmpdir(), `7699-auth-${Snowflake.next()}`);
		await import("node:fs/promises").then(fs => fs.mkdir(tempAuthDir2, { recursive: true }));
		const auth2 = await AuthStorage.create(path.join(tempAuthDir2, "auth.db"));
		const reg2 = new ModelRegistry(auth2, path.join(tempAuthDir2, "models.yml"));

		const session2 = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
					systemPrompt: ["Test"],
					tools: [],
				},
			}),
			sessionManager: level2,
			settings: Settings.isolated(),
			modelRegistry: reg2,
		});
		session2.subscribe(() => {});

		// Check messages at level 2 - should include L2-1 that was just added
		messages = session2.getUserMessagesForBranching();

		// BUG: If this fails, messages added in level2 before forking to level3 are not visible
		expect(messages.length).toBe(4); // L0-1, L0-2, L1-1, L2-1
		expect(messages[3].text).toContain("L2-1");

		await session1.dispose();
		await session2.dispose();
		auth1.close();
		auth2.close();
	});
});
