import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@gajae-code/ai";
import { SessionManager } from "../../src/session/session-manager";
import { MemorySessionStorage } from "../../src/session/session-storage";

function makeAssistantMessage(): AssistantMessage {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "test response" }],
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
		timestamp: 1,
	};
}

describe("fork-branch prompts regression (issue #7699)", () => {
	it("includes prompts added after branching in fork when forking again", async () => {
		// This test reproduces issue #7699:
		// After /fork, prompts sent in the forked session are missing from the next /fork selector.
		// The issue occurs when:
		// 1. Fork a session
		// 2. Branch to an earlier prompt
		// 3. Add new prompts
		// 4. Fork again
		// The new prompts should be included in the second fork

		const storage = new MemorySessionStorage();
		const session = SessionManager.create("/cwd", "/sessions", storage);

		// Add initial prompts
		session.appendMessage({ role: "user", content: "original first prompt", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());

		const secondPromptId = session.appendMessage({ role: "user", content: "original second prompt", timestamp: 2 });
		session.appendMessage(makeAssistantMessage());

		session.appendMessage({ role: "user", content: "original third prompt", timestamp: 3 });
		session.appendMessage(makeAssistantMessage());

		// Flush and fork
		await session.flush();
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		// Fork 1: Create forked session
		const forked1 = await SessionManager.forkFrom(sessionFile, "/cwd", "/sessions", storage);

		// In the forked session, branch back to the second prompt
		forked1.branch(secondPromptId);

		// Add new prompts in the forked session after branching
		forked1.appendMessage({ role: "user", content: "forked first after branch", timestamp: 4 });
		forked1.appendMessage(makeAssistantMessage());

		forked1.appendMessage({ role: "user", content: "forked second after branch", timestamp: 5 });

		// NOTE: We do NOT flush here - this tests if in-memory entries are visible when forking
		// Flush the forked session
		await forked1.flush();
		const forked1File = forked1.getSessionFile();
		if (!forked1File) throw new Error("Expected forked session file");

		// Fork 2: Fork from the forked session
		const forked2 = await SessionManager.forkFrom(forked1File, "/cwd", "/sessions", storage);

		// Get the user messages from the second forked session
		const forked2Entries = forked2.getEntries();
		const forked2Messages: Array<string> = [];

		for (const entry of forked2Entries) {
			if (entry.type !== "message") continue;
			if ((entry as any).message?.role !== "user") continue;

			const message = (entry as any).message;
			let text = "";
			if (typeof message.content === "string") {
				text = message.content;
			} else if (Array.isArray(message.content)) {
				text = message.content
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("");
			}

			if (text) {
				forked2Messages.push(text);
			}
		}

		// The new prompts added after branching should be included in the second fork
		expect(forked2Messages).toContain("forked first after branch");
		expect(forked2Messages).toContain("forked second after branch");

		await session.close();
		await forked1.close();
		await forked2.close();
	});

	it("preserves all prompts through fork chain", async () => {
		// Test that all prompts are preserved through a chain of forks
		const storage = new MemorySessionStorage();
		const session = SessionManager.create("/cwd", "/sessions", storage);

		// Add initial prompts
		session.appendMessage({ role: "user", content: "session 1 prompt", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());

		await session.flush();
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		// Fork 1
		const forked1 = await SessionManager.forkFrom(sessionFile, "/cwd", "/sessions", storage);
		forked1.appendMessage({ role: "user", content: "session 2 prompt", timestamp: 2 });
		forked1.appendMessage(makeAssistantMessage());

		await forked1.flush();
		const forked1File = forked1.getSessionFile();
		if (!forked1File) throw new Error("Expected forked session 1 file");

		// Fork 2
		const forked2 = await SessionManager.forkFrom(forked1File, "/cwd", "/sessions", storage);
		forked2.appendMessage({ role: "user", content: "session 3 prompt", timestamp: 3 });
		forked2.appendMessage(makeAssistantMessage());

		// Get the messages from the second fork
		const forked2Entries = forked2.getEntries();
		const forked2Messages: Array<string> = [];

		for (const entry of forked2Entries) {
			if (entry.type !== "message") continue;
			if ((entry as any).message?.role !== "user") continue;

			const message = (entry as any).message;
			let text = "";
			if (typeof message.content === "string") {
				text = message.content;
			} else if (Array.isArray(message.content)) {
				text = message.content
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("");
			}

			if (text) {
				forked2Messages.push(text);
			}
		}

		// All prompts from all sessions should be present
		expect(forked2Messages).toContain("session 1 prompt");
		expect(forked2Messages).toContain("session 2 prompt");
		expect(forked2Messages).toContain("session 3 prompt");

		await session.close();
		await forked1.close();
		await forked2.close();
	});
});
