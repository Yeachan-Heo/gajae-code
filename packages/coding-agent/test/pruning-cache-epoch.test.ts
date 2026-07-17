import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import type { AssistantMessage, ToolResultMessage } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { loadExtensions } from "@gajae-code/coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@gajae-code/coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getProjectAgentDir, TempDir } from "@gajae-code/utils";

/**
 * Cache-epoch invariant regression tests for tool-output pruning.
 *
 * Pruning rewrites already-sent toolResult history, which mutates the
 * provider-facing prompt prefix. Within a cache epoch that is only allowed at
 * a sanctioned maintenance boundary (the compaction threshold). These tests
 * lock the invariant: below the compaction threshold pruning must never fire;
 * at/above the threshold pruning may fire as part of context maintenance.
 */

function assistantMessage(totalTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: totalTokens - 1000,
			output: 1000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	} as AssistantMessage;
}

function toolResultMessage(index: number, sizeChars: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${index}`,
		toolName: "bash",
		content: [{ type: "text", text: `output-${index} ${"x ".repeat(Math.floor(sizeChars / 2))}` }],
		isError: false,
		timestamp: Date.now() + index,
	} as ToolResultMessage;
}

describe("pruning cache-epoch invariant", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;

	async function createSession(): Promise<void> {
		tempDir = TempDir.createSync("@pi-prune-epoch-");
		// Extension short-circuits compaction so no LLM calls happen.
		const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		const extensionPath = path.join(extensionsDir, "compaction-short-circuit.ts");
		fs.writeFileSync(
			extensionPath,
			[
				"export default function(pi) {",
				'\tpi.on("session_before_compact", async (event) => {',
				'\t\treturn { compaction: { summary: "compacted", shortSummary: undefined, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, details: {} } };',
				"\t});",
				"}",
			].join("\n"),
		);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const extensionsResult = await loadExtensions([extensionPath], tempDir.path());
		const extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.autoContinue": false,
				"contextPromotion.enabled": false,
				"todo.reminders": false,
			}),
			modelRegistry,
			extensionRunner,
		});
	}

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	function seedPrunableHistory(): void {
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		// ~75k tokens of toolResult output: well past the 40k protect window and
		// 20k minimum-savings hysteresis, so pruning WOULD fire if invoked.
		for (let i = 0; i < 25; i++) {
			sessionManager.appendMessage(toolResultMessage(i, 12_000));
		}
	}

	function seedSubMinimumPrunableHistory(): void {
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		for (let i = 0; i < 18; i++) sessionManager.appendMessage(toolResultMessage(i, 12_000));
	}

	function prunedEntryCount(): number {
		return sessionManager.getBranch().filter(entry => {
			if (entry.type !== "message") return false;
			const message = (entry as { message: { role?: string; prunedAt?: number } }).message;
			return message.role === "toolResult" && message.prunedAt !== undefined;
		}).length;
	}

	async function driveTurnEnd(message: AssistantMessage): Promise<void> {
		sessionManager.appendMessage(message);
		session.agent.emitExternalEvent({ type: "message_end", message });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [message] });
		for (let i = 0; i < 20; i++) await Promise.resolve();
		await session.waitForIdle();
		await new Promise(resolve => setTimeout(resolve, 100));
		await session.waitForIdle();
	}

	it("does not prune already-sent tool outputs while below the compaction threshold", async () => {
		await createSession();
		seedPrunableHistory();
		const branchBefore = JSON.stringify(sessionManager.getBranch());
		// 50k tokens on a 200k-context model: far below the compaction threshold.
		await driveTurnEnd(assistantMessage(50_000));
		expect(prunedEntryCount()).toBe(0);
		// Already-sent toolResult history must be byte-identical (no mid-epoch rewrite).
		expect(JSON.stringify(sessionManager.getBranch().slice(0, 26))).toBe(
			JSON.stringify(JSON.parse(branchBefore).slice(0, 26)),
		);
	});

	it("prunes tool outputs at the compaction maintenance boundary", async () => {
		await createSession();
		seedPrunableHistory();
		// 190k tokens on a 200k-context model: over the threshold, so context
		// maintenance (pruning, then compaction if still over) is sanctioned.
		await driveTurnEnd(assistantMessage(190_000));
		expect(prunedEntryCount()).toBeGreaterThan(0);
	});

	it("uses sub-normal-minimum output savings to avert threshold compaction", async () => {
		await createSession();
		seedSubMinimumPrunableHistory();
		session.settings.set("compaction.thresholdTokens", 187_000);
		await driveTurnEnd(assistantMessage(188_000));
		expect(prunedEntryCount()).toBeGreaterThan(0);
		expect(sessionManager.getBranch().some(entry => entry.type === "compaction")).toBe(false);
	});
});
