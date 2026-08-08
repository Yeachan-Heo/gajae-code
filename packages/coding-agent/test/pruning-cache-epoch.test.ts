import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentContext } from "@gajae-code/agent-core";
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

function assistantMessage(totalTokens: number, cacheRead = 0): AssistantMessage {
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
			cacheRead,
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

	async function createSession(maintenancePruningEnabled = false): Promise<void> {
		tempDir = TempDir.createSync("@pi-prune-epoch-");
		// Extension short-circuits compaction so no LLM calls happen.
		const extensionPath = path.join(getProjectAgentDir(tempDir.path()), "extensions", "compaction-short-circuit.ts");
		await Bun.write(
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
		const bundledModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundledModel) throw new Error("Expected built-in anthropic model to exist");
		const model = { ...bundledModel, contextWindow: 200_000 };
		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.autoContinue": false,
				"contextPromotion.enabled": false,
				"todo.reminders": false,
				"compaction.maintenancePruningEnabled": maintenancePruningEnabled,
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
		// Spread the output across three user turns: the newest two turns are
		// protected by the recent-turn fence (protectRecentTurns=2), so the
		// prunable mass must live in an older turn.
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		// ~75k tokens of toolResult output: well past the 40k protect window and
		// 20k minimum-savings hysteresis, so pruning WOULD fire if invoked.
		for (let i = 0; i < 25; i++) {
			sessionManager.appendMessage(toolResultMessage(i, 12_000));
		}
		sessionManager.appendMessage({ role: "user", content: "next", timestamp: Date.now() });
		sessionManager.appendMessage(toolResultMessage(100, 100));
		sessionManager.appendMessage({ role: "user", content: "latest", timestamp: Date.now() });
	}

	function seedSubMinimumPrunableHistory(): void {
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		for (let i = 0; i < 18; i++) sessionManager.appendMessage(toolResultMessage(i, 12_000));
		sessionManager.appendMessage({ role: "user", content: "next", timestamp: Date.now() });
		sessionManager.appendMessage({ role: "user", content: "latest", timestamp: Date.now() });
	}

	function seedTransactionalPrunableHistory(): void {
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		// Candidates publish newest-to-oldest, so the small output publishes first
		// and the BIG output's publication fails afterward (matched by payload size).
		sessionManager.appendMessage(toolResultMessage(0, 24 * 12_000));
		sessionManager.appendMessage(toolResultMessage(1, 12_000));
		sessionManager.appendMessage({ role: "user", content: "next", timestamp: Date.now() });
		sessionManager.appendMessage(toolResultMessage(100, 200_000));
		sessionManager.appendMessage({ role: "user", content: "latest", timestamp: Date.now() });
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
		await Bun.sleep(100);
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

	it("retains tool outputs when artifact reservation initialization fails", async () => {
		await createSession();
		seedPrunableHistory();
		const artifactManager = sessionManager.getArtifactManager();
		if (!artifactManager) throw new Error("expected an artifact manager for this session");
		const allocatePath = vi.spyOn(artifactManager, "allocatePath").mockRejectedValue(new Error("mkdir failed"));
		const allocateId = vi.spyOn(artifactManager, "allocateId");

		await expect(driveTurnEnd(assistantMessage(190_000))).resolves.toBeUndefined();
		expect(allocatePath).toHaveBeenCalledTimes(1);
		expect(allocateId).not.toHaveBeenCalled();
		expect(prunedEntryCount()).toBe(0);
		expect(() =>
			sessionManager.appendMessage({ role: "user", content: "session remains writable", timestamp: Date.now() }),
		).not.toThrow();
	});

	it("uses sub-normal-minimum output savings to avert threshold compaction", async () => {
		await createSession();
		seedSubMinimumPrunableHistory();
		session.settings.set("compaction.thresholdTokens", 187_000);
		await driveTurnEnd(assistantMessage(188_000));
		expect(prunedEntryCount()).toBeGreaterThan(0);
		expect(sessionManager.getBranch().some(entry => entry.type === "compaction")).toBe(false);
	});

	it("stages but does not commit maintenance pruning when artifact rollback drops savings below the cache-epoch cost", async () => {
		await createSession(true);
		seedTransactionalPrunableHistory();
		const branchBefore = sessionManager.getBranch();
		const branchBeforeJson = JSON.stringify(branchBefore);
		await driveTurnEnd(assistantMessage(50_000, 30_000));

		// Real artifact manager with a call-through spy: the small output publishes
		// for real, then the BIG publish fails by payload size; when the gate
		// rejects the staged prune the published artifact must be rolled back on disk.
		const artifactManager = sessionManager.getArtifactManager();
		if (!artifactManager) throw new Error("expected a managed artifact manager for this session");
		const publish = artifactManager.publishExactText.bind(artifactManager);
		vi.spyOn(artifactManager, "publishExactText").mockImplementation((text, options) =>
			Buffer.byteLength(text) > 100_000
				? Promise.resolve({ outcome: "failed", diagnostic: "publish failed" })
				: publish(text, options),
		);
		const applyMessageSpy = vi.spyOn(sessionManager, "applyEntryMessageUpdates");
		const applyCustomSpy = vi.spyOn(sessionManager, "applyCustomMessageEntryUpdates");
		const rewriteSpy = vi.spyOn(sessionManager, "rewriteEntries");
		const replaceMessagesSpy = vi.spyOn(session.agent, "replaceMessages");
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
		});
		await session.prompt("continue");

		expect(prunedEntryCount()).toBe(0);
		expect(JSON.stringify(sessionManager.getBranch().slice(0, branchBefore.length))).toBe(branchBeforeJson);
		expect(notices.some(message => message.includes("Maintenance pruning skipped: actual savings"))).toBe(true);
		// No canonical write-back or provider-context reset ran for the rejected prune.
		expect(applyMessageSpy).not.toHaveBeenCalled();
		expect(applyCustomSpy).not.toHaveBeenCalled();
		expect(rewriteSpy).not.toHaveBeenCalled();
		expect(replaceMessagesSpy).not.toHaveBeenCalled();
		// The one successfully staged artifact publication was rolled back on disk.
		expect((await artifactManager.listFiles()).filter(file => file.endsWith(".evicted.log"))).toEqual([]);
	});

	it("rolls back staged artifacts when pruning aborts during publication", async () => {
		await createSession();
		seedPrunableHistory();
		const artifactManager = sessionManager.getArtifactManager();
		if (!artifactManager) throw new Error("expected a managed artifact manager for this session");
		const publish = artifactManager.publishExactText.bind(artifactManager);
		const abortController = new AbortController();
		let aborted = false;
		vi.spyOn(artifactManager, "publishExactText").mockImplementation(async (text, options) => {
			const outcome = await publish(text, options);
			if (!aborted) {
				aborted = true;
				abortController.abort();
			}
			return outcome;
		});

		const context: AgentContext = {
			systemPrompt: session.state.systemPrompt,
			messages: [...session.messages, assistantMessage(190_000)],
			tools: [],
		};
		const result = await session.runMidRunMaintenanceForTests(context, {
			signal: abortController.signal,
			awaitEventDrain: async () => {},
		});

		expect(aborted).toBe(true);
		expect(result).toBe("aborted");
		expect(prunedEntryCount()).toBe(0);
		expect((await artifactManager.listFiles()).filter(file => file.endsWith(".evicted.log"))).toEqual([]);
	});

	it("commits maintenance pruning when actual savings clear the cache-epoch cost", async () => {
		await createSession(true);
		seedTransactionalPrunableHistory();
		await driveTurnEnd(assistantMessage(50_000, 0));

		const artifactManager = sessionManager.getArtifactManager();
		if (!artifactManager) throw new Error("expected a managed artifact manager for this session");
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		await session.prompt("continue");

		expect(prunedEntryCount()).toBeGreaterThan(0);
		// Committed prune keeps its published artifacts referenced.
		expect((await artifactManager.listFiles()).filter(file => file.endsWith(".evicted.log")).length).toBeGreaterThan(
			0,
		);
	});
});
