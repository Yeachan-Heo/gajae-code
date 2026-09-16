/**
 * Agent-level providers (e.g. Devin over ACP) own conversation history and
 * refuse GJC maintenance calls by contract, so an all-agent-level candidate
 * chain can only report a guaranteed refusal on every threshold crossing.
 * Auto-maintenance must instead be a benign skip — while a
 * `session_before_compact` hook, which needs no model call, keeps the session
 * eligible.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import type { AssistantMessage, Model } from "@gajae-code/ai";
import { getBundledModel, modelSupportsMaintenanceCalls } from "@gajae-code/ai/models";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { loadExtensions } from "@gajae-code/coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@gajae-code/coding-agent/extensibility/extensions/runner";
import { AgentSession, type AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getProjectAgentDir, TempDir } from "@gajae-code/utils";

function devinModel(): Model {
	const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!bundled) throw new Error("Expected built-in anthropic model to exist");
	return {
		...bundled,
		id: "swe-2-max",
		name: "SWE-2 Max",
		provider: "devin",
		api: "devin-acp",
		contextWindow: 200_000,
	};
}

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "devin-acp",
		provider: "devin",
		model: "swe-2-max",
		stopReason: "stop",
		usage: {
			input: 190000,
			output: 1000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 191000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
		...overrides,
	} as AssistantMessage;
}

describe("AgentSession auto-compaction on agent-level providers", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	async function createSession(settings: Record<string, unknown> = {}, withCompactionHook = false) {
		tempDir = TempDir.createSync("@pi-auto-compaction-agent-level-");
		vi.useRealTimers();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		let extensionRunner: ExtensionRunner | undefined;
		if (withCompactionHook) {
			const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
			fs.mkdirSync(extensionsDir, { recursive: true });
			const extensionPath = path.join(extensionsDir, "compaction-short-circuit.ts");
			fs.writeFileSync(
				extensionPath,
				[
					"export default function(pi) {",
					'\tpi.on("session_before_compact", async (event) => {',
					'\t\treturn { compaction: { summary: "hook-compacted", shortSummary: undefined, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, details: {} } };',
					"\t});",
					"}",
				].join("\n"),
			);
			const extensionsResult = await loadExtensions([extensionPath], tempDir.path());
			extensionRunner = new ExtensionRunner(
				extensionsResult.extensions,
				extensionsResult.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
		}
		const model = devinModel();
		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.autoContinue": true,
				"contextPromotion.enabled": false,
				"todo.reminders": false,
				...settings,
			}),
			modelRegistry,
			extensionRunner,
		});
		session.setTodoPhases([{ name: "Test", tasks: [{ content: "Keep working", status: "in_progress" }] }]);
	}

	beforeEach(async () => {
		await createSession();
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	async function driveCompaction(message = assistantMessage()) {
		sessionManager.appendMessage(message);
		session.agent.emitExternalEvent({ type: "message_end", message });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [message] });
		for (let i = 0; i < 20; i++) await Promise.resolve();
		await session.waitForIdle();
	}

	it("modelSupportsMaintenanceCalls identifies agent-level provider APIs", () => {
		expect(modelSupportsMaintenanceCalls(devinModel())).toBe(false);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		expect(modelSupportsMaintenanceCalls(bundled)).toBe(true);
	});

	it("threshold trigger on an all-agent-level chain is a silent skip, not a failure", async () => {
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));
		await driveCompaction();
		await session.waitForIdle();
		expect(events.filter(event => event.type.startsWith("auto_compaction"))).toHaveLength(0);
		expect(sessionManager.getBranch().findLast(entry => entry.type === "compaction")).toBeUndefined();
		expect(promptSpy).not.toHaveBeenCalled();
	});

	it("handoff strategy on an agent-level session model is also skipped", async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		await createSession({ "compaction.strategy": "handoff" });
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));
		await driveCompaction();
		await session.waitForIdle();
		expect(events.filter(event => event.type.startsWith("auto_compaction"))).toHaveLength(0);
		expect(sessionManager.getBranch().findLast(entry => entry.type === "compaction")).toBeUndefined();
	});

	it("session_before_compact hook keeps an agent-level session eligible", async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		await createSession({ "compaction.keepRecentTokens": 1 }, true);
		for (let index = 0; index < 8; index++) {
			sessionManager.appendMessage({
				role: "user",
				content: "hook summary context ".repeat(10_000),
				timestamp: Date.now() + index,
			});
		}
		vi.spyOn(session.agent, "prompt").mockResolvedValue();
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));
		await driveCompaction();
		await session.waitForIdle();
		const compactionEntry = sessionManager.getBranch().findLast(entry => entry.type === "compaction");
		expect(compactionEntry?.type === "compaction" && compactionEntry.summary).toBeTruthy();
		if (compactionEntry?.type === "compaction") {
			expect(compactionEntry.summary).toContain("hook-compacted");
		}
	});
});
