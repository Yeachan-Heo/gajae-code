import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import type { AgentMessage, AgentQueuedRunStartDecision } from "@gajae-code/agent-core";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel, type TextContent } from "@gajae-code/ai";
import { createMockModel, type MockHandler } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession, type QueuedRunStartFailure } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { logger, TempDir } from "@gajae-code/utils";
import { createSdkRunCapability } from "../src/sdk/host/sdk-run-capability";

function isRetryableRemoveError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const code = (error as { code?: unknown }).code;
	return code === "EBUSY" || code === "ENOTEMPTY";
}

async function removeTempDirWithRetry(dir: TempDir): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		try {
			dir.removeSync();
			return;
		} catch (error) {
			if (attempt === 19 || !isRetryableRemoveError(error)) {
				throw error;
			}
			await Bun.sleep(50 * (attempt + 1));
		}
	}
}

/**
 * Issue #434 — queued prompts while the agent is busy.
 *
 * A prompt submitted while the agent is streaming can either steer the active
 * turn (interrupt now) or be queued to run after the active turn completes.
 * These tests pin the two distinct behaviors and prove the two queues do not
 * conflate: steering goes to the steering queue, queued-next-turn prompts go to
 * the follow-up queue, and the queued prompts run in submission order.
 */
describe("AgentSession queued prompts (issue #434)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-queued-prompts-");
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
		await removeTempDirWithRetry(tempDir);
	});

	function buildSession(
		responses: MockHandler[],
		settings = Settings.isolated({ "compaction.enabled": false }),
	): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		return new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
	}

	function messageText(m: Extract<AgentMessage, { role: "user" }>): string {
		if (typeof m.content === "string") return m.content;
		return m.content
			.filter((c): c is TextContent => c.type === "text")
			.map(c => c.text)
			.join("");
	}

	function userTexts(s: AgentSession): string[] {
		return s.agent.state.messages
			.filter((m): m is Extract<AgentMessage, { role: "user" }> => m.role === "user")
			.map(messageText);
	}

	function assistantCount(s: AgentSession): number {
		return s.agent.state.messages.filter(m => m.role === "assistant").length;
	}

	async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
		const start = Date.now();
		while (!predicate()) {
			if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
			await Bun.sleep(5);
		}
	}

	it("isolates a throwing failure observer within a real all-mode own-run batch", async () => {
		const evalRelease = Promise.withResolvers<void>();
		const refused = Promise.withResolvers<void>();
		const observerError = new Error("first queued failure observer failed");
		const firstFailures: QueuedRunStartFailure[] = [];
		const secondFailures: QueuedRunStartFailure[] = [];
		const siblingFailures: QueuedRunStartFailure[] = [];
		const promotions: Array<{ startsOwnRun?: boolean; removed?: boolean }> = [];
		const siblingCancellation = new AbortController();
		let providerCalls = 0;
		session = buildSession([
			() => {
				providerCalls += 1;
				return { content: ["seed"] };
			},
			() => {
				providerCalls += 1;
				return { content: ["restored"] };
			},
		]);
		await session.prompt("seed");
		session.setFollowUpMode("all");
		const model = session.agent.state.model;
		const decisions: AgentQueuedRunStartDecision[] = [];
		const sessionDecisionHook = session.agent.onQueuedRunStartDecision;
		session.agent.onQueuedRunStartDecision = decision => {
			decisions.push(decision);
			sessionDecisionHook?.(decision);
		};
		const evaluation = session.trackEvalExecution(evalRelease.promise, new AbortController());
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			await session.sendUserMessage("first selected", {
				deliverAs: "followUp",
				queuePolicy: "respect-mode",
				onQueuedPromoted: promotion => promotions.push(promotion),
				onQueuedRunStartFailed: failure => {
					firstFailures.push(failure);
					throw observerError;
				},
			});
			await session.sendUserMessage("second selected", {
				deliverAs: "followUp",
				queuePolicy: "respect-mode",
				onQueuedPromoted: promotion => promotions.push(promotion),
				onQueuedRunStartFailed: failure => {
					secondFailures.push(failure);
					refused.resolve();
				},
			});
			await session.sendUserMessage("outside selected batch", {
				deliverAs: "followUp",
				sdkRunCapability: createSdkRunCapability("outside-refused-batch"),
				preflightSignal: siblingCancellation.signal,
				onQueuedRunStartFailed: failure => siblingFailures.push(failure),
			});
			const selected = session.agent.snapshotFollowUp();
			expect(selected).toHaveLength(2);
			expect(session.getQueuedMessages().followUp).toEqual([
				"first selected",
				"second selected",
				"outside selected batch",
			]);
			session.agent.setModel(undefined);
			evalRelease.resolve();
			await evaluation;
			await refused.promise;
			expect(firstFailures).toHaveLength(1);
			expect(secondFailures).toHaveLength(1);
			const refusal = secondFailures[0]?.error;
			if (!(refusal instanceof Error)) throw new Error("Expected queued model-guard refusal", { cause: refusal });
			expect(firstFailures[0]).toEqual({ disposition: "not-started", error: secondFailures[0]?.error });
			expect(secondFailures[0]?.error).toMatchObject({ message: "No model configured" });
			expect(secondFailures[0]?.error).not.toBe(observerError);
			expect(decisions).toEqual([
				{
					disposition: "not-started",
					consumedQueuedMessages: selected,
					error: refusal,
				},
			]);
			expect(decisions[0]?.consumedQueuedMessages[0]).toBe(selected[0]);
			expect(decisions[0]?.consumedQueuedMessages[1]).toBe(selected[1]);
			expect(promotions).toEqual([{ startsOwnRun: true }, { startsOwnRun: true }]);
			expect(session.agent.snapshotFollowUp()).toEqual([]);
			expect(session.getQueuedMessages().followUp).toEqual(["outside selected batch"]);
			expect(siblingFailures).toEqual([]);
			expect(providerCalls).toBe(1);
			expect(warn).toHaveBeenCalledWith("Queued run start failure callback failed", { error: observerError });
			siblingCancellation.abort();
			await session.waitForIdle();
			session.agent.setModel(model);
			await session.prompt("restored");
			expect(firstFailures).toHaveLength(1);
			expect(secondFailures).toHaveLength(1);
			expect(siblingFailures).toEqual([]);
			expect(session.queuedMessageCount).toBe(0);
			expect(userTexts(session)).toEqual(["seed", "restored"]);
		} finally {
			evalRelease.resolve();
			siblingCancellation.abort();
			warn.mockRestore();
		}
	});

	it("relays an actual queued no-model refusal after enqueue returns without retaining the failed SDK token", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const refused = Promise.withResolvers<QueuedRunStartFailure>();
		const restoredEntered = Promise.withResolvers<void>();
		const restoredRelease = Promise.withResolvers<void>();
		let providerCalls = 0;
		session = buildSession([
			async () => {
				providerCalls += 1;
				entered.resolve();
				await release.promise;
				return { content: ["predecessor"] };
			},
			async () => {
				providerCalls += 1;
				restoredEntered.resolve();
				await restoredRelease.promise;
				return { content: ["restored"] };
			},
		]);
		const model = session.agent.state.model;
		const failures: QueuedRunStartFailure[] = [];
		const siblingFailures: QueuedRunStartFailure[] = [];
		const siblingPromotions: Array<{ startsOwnRun?: boolean; removed?: boolean }> = [];
		const siblingCancellation = new AbortController();
		const coreDecisions: unknown[] = [];
		const sessionDecisionHook = session.agent.onQueuedRunStartDecision;
		session.agent.onQueuedRunStartDecision = decision => {
			coreDecisions.push(decision);
			sessionDecisionHook?.(decision);
		};
		const predecessor = session.prompt("predecessor");
		await entered.promise;
		await session.sendUserMessage("same text", {
			deliverAs: "followUp",
			sdkRunCapability: createSdkRunCapability("failed-queued-owner"),
			onQueuedRunStartFailed: failure => {
				failures.push(failure);
				refused.resolve(failure);
			},
		});
		await session.sendUserMessage("same text", {
			deliverAs: "followUp",
			sdkRunCapability: createSdkRunCapability("removed-sibling-owner"),
			preflightSignal: siblingCancellation.signal,
			onQueuedPromoted: promotion => siblingPromotions.push(promotion),
			onQueuedRunStartFailed: failure => siblingFailures.push(failure),
		});
		expect(failures).toEqual([]);
		siblingCancellation.abort();
		session.agent.setModel(undefined);
		release.resolve();
		const failure = await refused.promise;
		await predecessor;
		await session.waitForIdle();
		expect(failure.disposition).toBe("not-started");
		expect(failure.error).toBeInstanceOf(Error);
		expect(coreDecisions).toEqual([expect.objectContaining({ disposition: "not-started", error: failure.error })]);
		expect(failures).toHaveLength(1);
		expect(siblingFailures).toEqual([]);
		expect(siblingPromotions).toEqual([{ startsOwnRun: true, removed: true }]);
		expect(providerCalls).toBe(1);
		expect(session.queuedMessageCount).toBe(0);
		session.agent.setModel(model);
		const restored = session.prompt("restored");
		await restoredEntered.promise;
		try {
			const staleSteerOptions = { deliverAs: "steer" as const, expectedSdkRunToken: "failed-queued-owner" };
			await expect(session.sendUserMessage("stale steer", staleSteerOptions)).rejects.toMatchObject({
				code: "turn_not_active",
			});
		} finally {
			restoredRelease.resolve();
			await restored;
		}
		expect(failures).toHaveLength(1);
		expect(siblingFailures).toEqual([]);
		expect(providerCalls).toBe(2);
		expect(userTexts(session)).toEqual(["predecessor", "restored"]);
	});

	it("never downgrades a started queued run to not-started on a provider error", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const failures: QueuedRunStartFailure[] = [];
		session = buildSession([
			async () => {
				entered.resolve();
				await release.promise;
				return { content: ["predecessor"] };
			},
			{ content: ["successor"] },
		]);
		const predecessor = session.prompt("predecessor");
		await entered.promise;
		await session.sendUserMessage("queued", {
			deliverAs: "followUp",
			sdkRunCapability: createSdkRunCapability("started-queued-owner"),
			onQueuedRunStartFailed: failure => failures.push(failure),
		});
		let successorCalls = 0;
		session.agent.streamFn = () => {
			successorCalls += 1;
			throw new Error("No model configured");
		};
		release.resolve();
		await predecessor;
		await session.waitForIdle();
		expect(successorCalls).toBeGreaterThan(0);
		expect(failures).toEqual([]);
		expect(userTexts(session)).toEqual(["predecessor", "queued"]);
	});

	it("retires the failure channel when a steer joins an already executing run", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const failures: QueuedRunStartFailure[] = [];
		const promotions: Array<{ startsOwnRun?: boolean; removed?: boolean }> = [];
		session = buildSession([
			async () => {
				entered.resolve();
				await release.promise;
				return { content: ["first response"] };
			},
		]);
		const running = session.prompt("active run");
		await entered.promise;
		await session.sendUserMessage("in-run steer", {
			deliverAs: "steer",
			onQueuedPromoted: promotion => promotions.push(promotion),
			onQueuedRunStartFailed: failure => failures.push(failure),
		});
		session.agent.streamFn = () => {
			throw new Error("No model configured");
		};
		release.resolve();
		await running;
		await session.waitForIdle();
		expect(promotions).toEqual([{ startsOwnRun: false }]);
		expect(failures).toEqual([]);
		expect(userTexts(session)).toEqual(["active run", "in-run steer"]);
	});

	it("rejects persisted queue modes before changing the live agent", () => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
			toolInterruptPolicy: "abort_tools",
		});
		session = buildSession([], settings);
		const canWrite = spyOn(settings, "canWriteDurableConfig").mockReturnValue(false);
		const set = spyOn(settings, "set");

		try {
			expect(() => session!.setSteeringMode("all")).toThrow("Repair config.yml");
			expect(() => session!.setFollowUpMode("all")).toThrow("Repair config.yml");
			expect(() => session!.setToolInterruptPolicy("finish_tools")).toThrow("Repair config.yml");

			expect(session.agent.getSteeringMode()).toBe("one-at-a-time");
			expect(session.agent.getFollowUpMode()).toBe("one-at-a-time");
			expect(session.agent.getToolInterruptPolicy()).toBe("abort_tools");
			expect(settings.getGlobal("steeringMode")).toBe("one-at-a-time");
			expect(settings.getGlobal("followUpMode")).toBe("one-at-a-time");
			expect(settings.getGlobal("toolInterruptPolicy")).toBe("abort_tools");
			expect(set).not.toHaveBeenCalled();
		} finally {
			canWrite.mockRestore();
			set.mockRestore();
		}
	});
	it("runs prompts queued while busy after the active turn, in submission order", async () => {
		const gate = Promise.withResolvers<void>();
		session = buildSession([
			async () => {
				await gate.promise;
				return { content: ["turn 1"] };
			},
			{ content: ["turn 2"] },
			{ content: ["turn 3"] },
		]);

		// Start the first turn but do not await — it blocks on the gate so the
		// session stays busy while we queue.
		const first = session.prompt("p1");
		await waitUntil(() => session!.agent.state.isStreaming);

		// Queue two prompts as next-turn work (the "queue" busy behavior).
		await session.prompt("p2", { streamingBehavior: "followUp" });
		await session.prompt("p3", { streamingBehavior: "followUp" });

		// They are queued, not delivered yet, and live in the follow-up queue.
		expect(session.getQueuedMessages().followUp).toEqual(["p2", "p3"]);
		expect(session.getQueuedMessages().steering).toEqual([]);
		expect(assistantCount(session)).toBe(0);

		gate.resolve();
		await first;
		await session.waitForIdle();

		expect(userTexts(session)).toEqual(["p1", "p2", "p3"]);
		expect(assistantCount(session)).toBe(3);
		expect(session.queuedMessageCount).toBe(0);
	});

	it("resumes a follow-up queued during foreground eval once the execution settles", async () => {
		session = buildSession([{ content: ["turn 1"] }, { content: ["turn 2"] }]);
		await session.prompt("p1");

		const gate = Promise.withResolvers<void>();
		const evalExecution = session.trackEvalExecution(gate.promise, new AbortController());
		await session.followUp("p2", undefined, { followUpQueuePolicy: "sequential" });

		expect(session.getQueuedMessages().followUp).toEqual(["p2"]);
		expect(userTexts(session)).toEqual(["p1"]);

		gate.resolve();
		await evalExecution;
		session.recordPythonResult("print('done')", {
			output: "",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 0,
			totalBytes: 0,
			outputLines: 0,
			outputBytes: 0,
			displayOutputs: [],
			stdinRequested: false,
		});
		await session.waitForIdle();

		expect(userTexts(session)).toEqual(["p1", "p2"]);
		expect(assistantCount(session)).toBe(2);
		expect(session.queuedMessageCount).toBe(0);
	});

	it("keeps explicit composer queue prompts sequential even when follow-up mode batches", async () => {
		const gate = Promise.withResolvers<void>();
		session = buildSession([
			async () => {
				await gate.promise;
				return { content: ["turn 1"] };
			},
			{ content: ["turn 2"] },
			{ content: ["turn 3"] },
		]);
		session.setFollowUpMode("all");

		const first = session.prompt("p1");
		await waitUntil(() => session!.agent.state.isStreaming);

		await session.prompt("p2", { streamingBehavior: "followUp", followUpQueuePolicy: "sequential" });
		await session.prompt("p3", { streamingBehavior: "followUp", followUpQueuePolicy: "sequential" });

		expect(session.getQueuedMessages().followUp).toEqual(["p2", "p3"]);

		gate.resolve();
		await first;
		await session.waitForIdle();

		expect(userTexts(session)).toEqual(["p1", "p2", "p3"]);
		expect(assistantCount(session)).toBe(3);
		expect(session.queuedMessageCount).toBe(0);
	});

	it("keeps steering and queued-next-turn prompts in separate queues", async () => {
		const gate = Promise.withResolvers<void>();
		session = buildSession([
			async () => {
				await gate.promise;
				return { content: ["turn 1"] };
			},
			{ content: ["after steer"] },
			{ content: ["after queue"] },
		]);

		const first = session.prompt("p1");
		await waitUntil(() => session!.agent.state.isStreaming);

		await session.prompt("steer me", { streamingBehavior: "steer" });
		await session.prompt("queue me", { streamingBehavior: "followUp" });

		// Separation: the steer landed only in the steering queue, the queued
		// prompt only in the follow-up queue.
		expect(session.getQueuedMessages().steering).toEqual(["steer me"]);
		expect(session.getQueuedMessages().followUp).toEqual(["queue me"]);
		expect(session.hasQueuedSteering).toBe(true);

		gate.resolve();
		await first;
		await session.waitForIdle();

		// Steering interrupted/continued the active turn; the queued prompt ran
		// after it. Submission order across both is preserved.
		expect(userTexts(session)).toEqual(["p1", "steer me", "queue me"]);
	});

	it("cancels only an implicit diverted text before queue consumption", async () => {
		const gate = Promise.withResolvers<void>();
		session = buildSession([
			async () => {
				await gate.promise;
				return { content: ["original completed"] };
			},
			{ content: ["unrelated steer completed"] },
		]);
		const first = session.prompt("original");
		try {
			await waitUntil(() => session!.agent.state.isStreaming);
			await session.sendUserMessage("keep steer", { deliverAs: "steer" });
			const cancelled = new AbortController();
			const promotions: Array<{ startsOwnRun?: boolean; removed?: boolean }> = [];
			const dispositions: Array<{ startsOwnRun: boolean }> = [];
			await session.sendUserMessage("cancel only this text", {
				preflightSignal: cancelled.signal,
				onDispatchDisposition: disposition => dispositions.push(disposition),
				onQueuedPromoted: promotion => promotions.push(promotion),
			});
			expect(dispositions).toEqual([{ startsOwnRun: false }]);
			expect(session.getQueuedMessages().steering).toEqual(["keep steer", "cancel only this text"]);
			cancelled.abort();
			expect(session.getQueuedMessages().steering).toEqual(["keep steer"]);
			expect(promotions).toEqual([{ startsOwnRun: false, removed: true }]);
			expect(session.agent.state.isStreaming).toBe(true);
			gate.resolve();
			await first;
			await session.waitForIdle();
			expect(userTexts(session)).toEqual(["original", "keep steer"]);
			expect(assistantCount(session)).toBe(2);
		} finally {
			gate.resolve();
			await first;
		}
	});

	it("removes an implicit diverted submission when its admission callback rejects", async () => {
		const gate = Promise.withResolvers<void>();
		session = buildSession([
			async () => {
				await gate.promise;
				return { content: ["original completed"] };
			},
		]);
		const first = session.prompt("original");
		try {
			await waitUntil(() => session!.agent.state.isStreaming);
			await expect(
				session.sendUserMessage("rejected queue entry", {
					onPreflightAccepted: () => {
						throw new Error("admission observer rejected");
					},
				}),
			).rejects.toThrow("admission observer rejected");
			expect(session.getQueuedMessages().steering).toEqual([]);
			expect(session.agent.state.isStreaming).toBe(true);
			gate.resolve();
			await first;
			await session.waitForIdle();
			expect(userTexts(session)).toEqual(["original"]);
		} finally {
			gate.resolve();
			await first;
		}
	});

	it("removes an arbitrary queued prompt selected for editing", async () => {
		const gate = Promise.withResolvers<void>();
		session = buildSession([
			async () => {
				await gate.promise;
				return { content: ["turn 1"] };
			},
			{ content: ["after steer"] },
			{ content: ["after remaining queue"] },
		]);

		const first = session.prompt("p1");
		await waitUntil(() => session!.agent.state.isStreaming);

		await session.prompt("steer me", { streamingBehavior: "steer" });
		await session.prompt("queue older", { streamingBehavior: "followUp" });
		await session.prompt("queue newest", { streamingBehavior: "followUp" });

		const entries = session.getQueuedMessageEntries();
		expect(entries.map(entry => entry.text)).toEqual(["steer me", "queue older", "queue newest"]);
		const removed = session.removeQueuedMessageForEditing(entries[1]?.id ?? "");

		expect(removed).toBe("queue older");
		expect(session.getQueuedMessages().steering).toEqual(["steer me"]);
		expect(session.getQueuedMessages().followUp).toEqual(["queue newest"]);

		gate.resolve();
		await first;
		await session.waitForIdle();

		expect(userTexts(session)).toEqual(["p1", "steer me", "queue newest"]);
	});

	it("reorders queued follow-up prompts selected for editing", async () => {
		const gate = Promise.withResolvers<void>();
		session = buildSession([
			async () => {
				await gate.promise;
				return { content: ["turn 1"] };
			},
			{ content: ["after moved queue"] },
			{ content: ["after remaining queue"] },
		]);

		const first = session.prompt("p1");
		await waitUntil(() => session!.agent.state.isStreaming);

		await session.prompt("queue older", { streamingBehavior: "followUp" });
		await session.prompt("queue newest", { streamingBehavior: "followUp" });

		const entries = session.getQueuedMessageEntries();
		expect(entries.map(entry => entry.text)).toEqual(["queue older", "queue newest"]);
		expect(session.moveQueuedMessageForEditing(entries[1]?.id ?? "", "up")).toBe(true);
		expect(session.getQueuedMessages().followUp).toEqual(["queue newest", "queue older"]);

		gate.resolve();
		await first;
		await session.waitForIdle();

		expect(userTexts(session)).toEqual(["p1", "queue newest", "queue older"]);
	});
});
