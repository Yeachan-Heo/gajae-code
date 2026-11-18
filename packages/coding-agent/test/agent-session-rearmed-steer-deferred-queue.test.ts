import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import { createSdkRunCapability } from "../src/session/sdk-run-capability-internal";

/**
 * Test for PR #7865 fix: hasQueuedSteering must check deferred SDK follow-ups
 * for re-armed steers when mixed SDK/TUI queue path is active.
 *
 * When an SDK run is interrupted (user_interrupt abort), steers are re-armed and
 * moved to the deferred SDK follow-up queue if one already exists. Without checking
 * #deferredSdkFollowUps in the hasQueuedSteering predicate, the predicate would
 * return false even though a re-armed steer is queued. This breaks the steer-on-interrupt
 * UX where the first Esc key should resume into the queued steer (not abort).
 *
 * The fix adds a third check to hasQueuedSteering (agent-session.ts:20089):
 *   return this.#deferredSdkFollowUps.some(message => this.#rearmedSteerMessages.has(message));
 *
 * Without this check, the hasQueuedSteering predicate would return false and the
 * test assertion would fail because the re-armed steer in #deferredSdkFollowUps would
 * not be detected.
 */
describe("AgentSession re-armed steer detection in deferred queue", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-rearmed-steer-deferred-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		tempDir.removeSync();
	});

	it("detects re-armed steering in deferred SDK follow-up queue via hasQueuedSteering", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");

		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();

		const mock = createMockModel({
			responses: [
				// First message: stream slowly so we can interrupt it
				async () => {
					firstStarted.resolve();
					await releaseFirst.promise;
					return { content: ["first completed"] };
				},
				// Second message: handles the re-armed steer
				{ content: ["handled re-armed steer"] },
			],
		});

		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});

		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const sdkToken = "command-test:turn-test";

		let running: Promise<void> | undefined;
		try {
			// Send first message with SDK capability
			running = session.sendUserMessage("first task", {
				sdkRunCapability: createSdkRunCapability(sdkToken),
			});
			await firstStarted.promise;

			// Send a steer while the run is active
			await session.sendUserMessage("steer message", {
				deliverAs: "steer",
				expectedSdkRunToken: sdkToken,
			} as never);

			// At this point, the steer should be queued
			expect(session.getQueuedMessages().steering).toContain("steer message");

			// Now interrupt the run by aborting - this should re-arm the steer
			// Release the streaming message so abort can interrupt it
			releaseFirst.resolve();
			await session.abort({ cause: "user_interrupt" });

			// Wait for the abort to complete
			await running.catch(() => {});

			// The critical check: hasQueuedSteering should detect the re-armed steer
			// even if it's in the deferred SDK follow-up queue, not the agent's queue.
			// IMPORTANT: Assert BEFORE waitForIdle() to catch the steer while it's still
			// in #deferredSdkFollowUps, before the continuation drains it.
			expect(session.hasQueuedSteering).toBe(true);

			// Now allow the idle processing to proceed
			await session.waitForIdle();

			// The queued messages should still reflect the re-armed steer as a follow-up
			const queued = session.getQueuedMessages();
			expect(queued.followUp).toContain("steer message");
		} finally {
			releaseFirst.resolve();
			await running?.catch(() => {});
		}
	});
});
