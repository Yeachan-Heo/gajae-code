/**
 * Contract: when delivering the messages typed during compaction fails, the batch goes back to
 * the compaction queue and the input that flush queued leaves the session queue. Messages that
 * were queued in the session before the flush (an extension's prompt, for example), and messages
 * queued after the flush finished delivering, stay queued; they are never discarded with the
 * failed batch.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai/models";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { CompactionQueuedMessage, InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { UiHelpers } from "@gajae-code/coding-agent/modes/utils/ui-helpers";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

describe("flushCompactionQueue failure", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	const authStorages: AuthStorage[] = [];

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-compaction-flush-failure-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		try {
			await session?.dispose();
		} finally {
			session = undefined;
			for (const authStorage of authStorages.splice(0)) authStorage.close();
		}
	});

	afterAll(async () => {
		await tempDir?.remove();
	});

	/** A session whose first turn is still streaming (a 60 s mock delay the abort cancels). */
	async function startStreamingSession(): Promise<{ live: AgentSession; running: Promise<void> }> {
		const started = Promise.withResolvers<void>();
		const mock = createMockModel({
			responses: [
				() => {
					started.resolve();
					return { content: ["working"], delayMs: 60_000 };
				},
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			convertToLlm,
			initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(tempDir.join(`auth-${authStorages.length}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const live = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
		});
		session = live;
		const running = live.prompt("first task");
		await started.promise;
		return { live, running };
	}

	function flushContext(live: AgentSession, typed: CompactionQueuedMessage[], showError: (message: string) => void) {
		return {
			session: live,
			compactionQueuedMessages: [...typed],
			pendingMessagesContainer: { clear: () => {}, addChild: () => {}, removeChild: () => {} },
			editor: { addToHistory: () => {}, setText: () => {}, getText: () => "" },
			keybindings: { getDisplayString: () => "Alt+Up" },
			skillCommands: new Map(),
			fileSlashCommands: new Set<string>(),
			locallySubmittedUserSignatures: new Set<string>(),
			isKnownSlashCommand: () => false,
			recordLocalSubmission: () => () => {},
			withLocalSubmission: async <T>(_text: string, fn: () => Promise<T>) => fn(),
			updatePendingMessagesDisplay: () => {},
			showStatus: () => {},
			showError,
		} as unknown as InteractiveModeContext;
	}

	it("keeps messages queued before the flush when delivering the compaction queue fails", async () => {
		const { live, running } = await startStreamingSession();

		// Queued in the session before the flush runs: an extension's prompt.
		await live.sendUserMessage("from the extension", { deliverAs: "followUp" });

		// The second typed message fails to deliver.
		// gajae delivers typed messages through prompt() with a streaming behavior.
		const prompt = live.prompt.bind(live);
		let deliveries = 0;
		vi.spyOn(live, "prompt").mockImplementation(async (text, options) => {
			if (++deliveries === 2) throw new Error("delivery failed");
			return prompt(text, options);
		});
		const typed: CompactionQueuedMessage[] = [
			{ text: "typed one", mode: "steer" },
			{ text: "typed two", mode: "steer" },
		];
		const ctx = flushContext(live, typed, () => {});

		await new UiHelpers(ctx).flushCompactionQueue({ willRetry: true });

		// The failed batch is held for retry, and the input it queued left the session queue ...
		expect(ctx.compactionQueuedMessages).toEqual(typed);
		expect(live.getQueuedMessages().steering).toEqual([]);
		// ... but the extension's prompt queued before the flush is still there.
		expect(live.getQueuedMessages().followUp).toEqual(["from the extension"]);

		await live.abort();
		await running.catch(() => {});
	});

	it("keeps messages queued after the flush returned when its first prompt fails later", async () => {
		const { live, running } = await startStreamingSession();

		// The first typed prompt is fire-and-forget; its setup fails only after the flush returns.
		const setupFails = Promise.withResolvers<void>();
		const prompted = Promise.withResolvers<void>();
		const prompt = live.prompt.bind(live);
		let calls = 0;
		vi.spyOn(live, "prompt").mockImplementation(async (text, options) => {
			if (++calls > 1) return prompt(text, options);
			prompted.resolve();
			await setupFails.promise;
			throw new Error("No API key found");
		});
		const typed: CompactionQueuedMessage[] = [
			{ text: "typed first", mode: "steer" },
			{ text: "typed second", mode: "steer" },
		];
		// The restore reports the failure last, once the queues are settled.
		const reported = Promise.withResolvers<void>();
		const ctx = flushContext(live, typed, () => reported.resolve());

		await new UiHelpers(ctx).flushCompactionQueue({ willRetry: false });
		await prompted.promise;
		expect(live.getQueuedMessages().steering).toEqual(["typed second"]);

		// Something else queues a prompt while the first prompt is still being set up.
		await live.sendUserMessage("queued afterwards", { deliverAs: "followUp" });
		setupFails.resolve();
		await reported.promise;
		expect(ctx.compactionQueuedMessages).toEqual(typed);

		// The flush took back its own delivered message, not the one queued after it.
		expect(live.getQueuedMessages().steering).toEqual([]);
		expect(live.getQueuedMessages().followUp).toEqual(["queued afterwards"]);

		await live.abort();
		await running.catch(() => {});
	});

	it("stops delivering and takes back the rest when the first prompt fails mid-delivery", async () => {
		const { live, running } = await startStreamingSession();

		// The first typed prompt fails while the second typed message is still being delivered.
		const prompt = live.prompt.bind(live);
		const steerStarted = Promise.withResolvers<void>();
		const steerRelease = Promise.withResolvers<void>();
		let calls = 0;
		vi.spyOn(live, "prompt").mockImplementation(async (text, options) => {
			if (++calls === 1) throw new Error("No API key found");
			steerStarted.resolve();
			await steerRelease.promise;
			return prompt(text, options);
		});
		const typed: CompactionQueuedMessage[] = [
			{ text: "typed first", mode: "steer" },
			{ text: "typed second", mode: "steer" },
			{ text: "typed third", mode: "steer" },
		];
		const reported = Promise.withResolvers<void>();
		const ctx = flushContext(live, typed, () => reported.resolve());

		const flushing = new UiHelpers(ctx).flushCompactionQueue({ willRetry: false });
		await steerStarted.promise;
		await reported.promise;
		steerRelease.resolve();
		await flushing;

		// The batch is back in the compaction queue once, and none of it stays in the session queue
		// to be sent now and again on the next flush.
		expect(ctx.compactionQueuedMessages).toEqual(typed);
		expect(live.getQueuedMessages().steering).toEqual([]);

		await live.abort();
		await running.catch(() => {});
	});
});
