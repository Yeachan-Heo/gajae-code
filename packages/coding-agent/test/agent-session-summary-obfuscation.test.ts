import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantMessage, Context } from "@gajae-code/ai";
import * as ai from "@gajae-code/ai";
import { TempDir } from "@gajae-code/utils";
import { Settings } from "../src/config/settings";
import { createAgentSession } from "../src/sdk";
import type { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const CANARY = "GJCCANARY7f3a9d2e-SECRETVALUE-DO-NOT-LEAK";
const ORDINARY = "ORDINARY-NOTE-7c2e-keep";
const STORED_ORDINARY = "STORED-NOTE-7c2e-keep";
const PLACEHOLDER = /#GJC1_[A-Za-z0-9_-]{22}#/;
const SECRET_ENV_PATTERNS = /(?:KEY|SECRET|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE|OAUTH)(?:_|$)/i;

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "github-copilot",
		model: "gpt-4o",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function contextText(context: Context): string {
	return context.messages
		.map(message => {
			if (typeof message.content === "string") return message.content;
			return message.content
				.map(block => {
					if (block.type === "text") return block.text;
					if (block.type === "thinking") return block.thinking;
					return "";
				})
				.join("\n");
		})
		.join("\n");
}

async function withClearedSecretEnv<T>(run: () => Promise<T>): Promise<T> {
	const removed: Array<[string, string]> = [];
	for (const [name, value] of Object.entries(process.env)) {
		if (!value || value.length < 8) continue;
		if (!SECRET_ENV_PATTERNS.test(name)) continue;
		removed.push([name, value]);
		delete process.env[name];
	}
	try {
		return await run();
	} finally {
		for (const [name, value] of removed) {
			process.env[name] = value;
		}
	}
}

describe("summary requests obfuscate registered secrets", () => {
	let tempDir: TempDir;
	const sessions: Array<{ dispose: () => Promise<void> }> = [];
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("summary-secret-obfuscate-");
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	async function createSession(): Promise<AgentSession> {
		const model = ai.getBundledModel("github-copilot", "gpt-4o");
		if (!model) {
			throw new Error("Expected github-copilot/gpt-4o model to exist");
		}

		const cwd = tempDir.path();
		fs.mkdirSync(path.join(cwd, ".gjc"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".gjc", "secrets.yml"), `- type: plain\n  content: ${CANARY}\n`);

		const authStorage = await AuthStorage.create(path.join(cwd, "testauth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("github-copilot", "test-key");

		const sessionManager = SessionManager.inMemory();
		const firstId = sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `Initial request ${CANARY} ${ORDINARY}` }],
			timestamp: Date.now() - 3,
		});
		sessionManager.appendCompaction(`Stored summary ${CANARY} ${STORED_ORDINARY}`, undefined, firstId, 1_000);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `Initial response ${CANARY} ${ORDINARY}` }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 120_000,
				output: 2_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 122_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `Latest request ${CANARY} ${ORDINARY}` }],
			timestamp: Date.now(),
		});

		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			authStorage,
			model,
			sessionManager,
			settings: Settings.isolated({
				"secrets.enabled": true,
				"compaction.autoContinue": false,
				"compaction.keepRecentTokens": 1,
			}),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		sessions.push(session);
		return session;
	}

	function captureSummaryContexts(): Context[] {
		const captured: Context[] = [];
		vi.spyOn(ai, "completeSimple").mockImplementation(async (...args) => {
			const context = args[1];
			captured.push(context);
			return createAssistantMessage("Compacted summary") as never;
		});
		return captured;
	}

	function summaryText(captured: Context[]): string {
		const summary = captured.map(contextText).find(text => text.includes("<conversation>"));
		if (!summary) {
			throw new Error("Expected a summary request");
		}
		return summary;
	}

	it("compact request omits a registered secret from the provider body", async () => {
		await withClearedSecretEnv(async () => {
			const captured = captureSummaryContexts();
			const session = await createSession();
			await session.compact();
			const text = summaryText(captured);
			expect(text).toContain("<previous-summary>");
			expect(text).not.toContain(CANARY);
			expect(text).toMatch(PLACEHOLDER);
		});
	});

	it("keeps ordinary conversation text in the compact request", async () => {
		await withClearedSecretEnv(async () => {
			const captured = captureSummaryContexts();
			const session = await createSession();
			await session.compact();
			const text = summaryText(captured);
			expect(text).toContain(ORDINARY);
			expect(text).toContain(STORED_ORDINARY);
		});
	});
});
