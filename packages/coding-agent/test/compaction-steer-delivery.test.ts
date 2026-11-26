import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import type { AssistantMessage, ToolResultMessage } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { loadExtensions } from "@gajae-code/coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@gajae-code/coding-agent/extensibility/extensions/runner";
import { setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { UiHelpers } from "@gajae-code/coding-agent/modes/utils/ui-helpers";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { Container } from "@gajae-code/tui";
import { getProjectAgentDir, TempDir, withTimeout } from "@gajae-code/utils";
import { loadTestTheme } from "./helpers/test-theme";

const gateKey = "__gjcCompactionSteerGate";
const preflightKey = "__gjcCompactionSteerPreflightMs";
type GateGlobal = typeof globalThis & { [gateKey]?: Promise<void>; [preflightKey]?: number };

function userTexts(session: AgentSession): string[] {
	return session.messages.flatMap(message => {
		if (message.role !== "user") return [];
		if (typeof message.content === "string") return [message.content];
		return message.content.flatMap(part => (part.type === "text" ? [part.text] : []));
	});
}

/**
 * A steer typed while the pre-prompt compaction of an idle-started prompt is
 * running is parked in the compaction-local queue and replayed when compaction
 * ends. It must reach the conversation; a chip that never delivers is a lost
 * user message.
 */
describe("steer typed during pre-prompt compaction", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let streamedUserTexts: string[][];

	beforeEach(async () => {
		const themeInstance = await loadTestTheme();
		setThemeInstance(themeInstance!);
		tempDir = TempDir.createSync("@gjc-compaction-steer-");
		const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		const extensionPath = path.join(extensionsDir, "compaction-gate.ts");
		fs.writeFileSync(
			extensionPath,
			[
				"export default function(pi) {",
				'\tpi.on("session_before_compact", async (event) => {',
				`\t\tconst gate = globalThis.${gateKey};`,
				"\t\tif (gate) await gate;",
				"\t\treturn { compaction: { summary: 'compacted', shortSummary: undefined, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, details: {} } };",
				"\t});",
				'\tpi.on("before_agent_start", async () => {',
				`\t\tconst delay = globalThis.${preflightKey} ?? 0;`,
				"\t\tif (delay) await new Promise(resolve => setTimeout(resolve, delay));",
				"\t});",
				"}",
			].join("\n"),
		);

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
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
		streamedUserTexts = [];

		const agent = new Agent({
			initialState: {
				model: { ...model, contextWindow: 200_000, maxTokens: 128_000 },
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (_model, context) => {
				streamedUserTexts.push(
					context.messages.flatMap(message =>
						message.role === "user"
							? typeof message.content === "string"
								? [message.content]
								: message.content.flatMap(part => (part.type === "text" ? [part.text] : []))
							: [],
					),
				);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const message: AssistantMessage = {
						role: "assistant",
						content: [{ type: "text", text: "ok" }],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "claude-sonnet-4-5",
						stopReason: "stop",
						usage: {
							input: 100,
							output: 10,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 110,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						timestamp: Date.now(),
					};
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});

		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Ready for tool output" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 800,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 850,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		const largeToolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "tool-large-read",
			toolName: "read",
			content: [{ type: "text", text: "x".repeat(10_000) }],
			isError: false,
			timestamp: Date.now(),
		};
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		sessionManager.appendMessage(assistantMsg);
		sessionManager.appendMessage(largeToolResult);

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.autoContinue": false }),
			modelRegistry,
			extensionRunner,
		});
		session.setResourceSampler(() => ({ heapUsedBytes: 0, providerBytes: 0, messageCount: 0, imageBytes: 0 }));
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		session.settings.set("compaction.thresholdTokens", 1000);
		session.settings.set("compaction.keepRecentTokens", 1);
	});

	afterEach(async () => {
		(globalThis as GateGlobal)[gateKey] = undefined;
		(globalThis as GateGlobal)[preflightKey] = undefined;
		await session.dispose();
		await modelRegistry.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	function createUiHelpers(): { helpers: UiHelpers; ctx: InteractiveModeContext } {
		let editorText = "";
		const ctx = {
			editor: {
				setText: (text: string) => {
					editorText = text;
				},
				getText: () => editorText,
				addToHistory: vi.fn(),
			},
			ui: { requestRender: vi.fn() },
			pendingMessagesContainer: new Container(),
			pendingBashComponents: [],
			pendingPythonComponents: [],
			session,
			sessionManager: session.sessionManager,
			compactionQueuedMessages: [],
			keybindings: { getDisplayString: () => "Alt+Up" },
			skillCommands: new Map(),
			fileSlashCommands: new Set<string>(),
			showStatus: vi.fn(),
			showError: vi.fn(),
			locallySubmittedUserSignatures: new Set<string>(),
			hasActiveBtw: () => false,
			recordLocalSubmission: () => () => {},
			withLocalSubmission: <T>(_text: string, fn: () => Promise<T>) => fn(),
		} as unknown as InteractiveModeContext;
		const helpers = new UiHelpers(ctx);
		(ctx as { updatePendingMessagesDisplay: () => void }).updatePendingMessagesDisplay = () =>
			helpers.updatePendingMessagesDisplay();
		(ctx as { flushCompactionQueue: UiHelpers["flushCompactionQueue"] }).flushCompactionQueue = options =>
			helpers.flushCompactionQueue(options);
		return { helpers, ctx };
	}

	// Before the fix, the auto_compaction_end subscriber inherited the admitted first
	// prompt's AsyncLocalStorage admission context. When that prompt was still in its
	// preflight (before_agent_start), the replay of the parked steer was refused as
	// same-session reentrancy, restored to the compaction queue, and never retried.
	for (const [label, emergency, preflightMs] of [
		["threshold, fast preflight", false, 0],
		["threshold, slow preflight", false, 300],
		["emergency resource floor, slow preflight", true, 300],
	] as const)
		it(`delivers a steer parked during an idle prompt's pre-prompt compaction (${label})`, async () => {
			(globalThis as GateGlobal)[preflightKey] = preflightMs;
			if (emergency) {
				let fired = false;
				session.setResourceSampler(() => {
					const over = !fired;
					fired = true;
					return { heapUsedBytes: 0, providerBytes: 0, messageCount: over ? 10_000_000 : 0, imageBytes: 0 };
				});
			}
			const gate = Promise.withResolvers<void>();
			(globalThis as GateGlobal)[gateKey] = gate.promise;
			const { helpers, ctx } = createUiHelpers();
			const flushes: Promise<void>[] = [];
			const compactionStarted = Promise.withResolvers<void>();
			session.subscribe(event => {
				if (event.type === "auto_compaction_start") compactionStarted.resolve();
				// Mirrors EventController#handleAutoCompactionEnd.
				if (event.type === "auto_compaction_end")
					flushes.push(helpers.flushCompactionQueue({ willRetry: event.willRetry }));
			});

			const firstPrompt = session.prompt("first message");
			await withTimeout(compactionStarted.promise, 2000, "pre-prompt compaction did not start");
			expect(session.isCompacting).toBe(true);
			// InputController routes a submission made while compacting here.
			helpers.queueCompactionMessage("second message", "steer");
			gate.resolve();

			await withTimeout(firstPrompt, 2000, "first prompt did not settle");
			await withTimeout(Promise.all(flushes), 2000, "compaction queue flush did not settle");
			await withTimeout(
				(async () => {
					while (!userTexts(session).includes("second message")) await Bun.sleep(10);
				})(),
				3000,
				"parked steer was never delivered",
			);
			await withTimeout(session.waitForIdle(), 2000, "session did not become idle");

			expect(ctx.showError).not.toHaveBeenCalled();
			expect(userTexts(session)).toEqual(expect.arrayContaining(["first message", "second message"]));
			expect(ctx.compactionQueuedMessages).toEqual([]);
			expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
			expect(streamedUserTexts.some(texts => texts.includes("second message"))).toBe(true);
		});
});
