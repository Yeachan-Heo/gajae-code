import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@gajae-code/agent-core";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel, type TextContent } from "@gajae-code/ai";
import { createMockModel, type MockHandler } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	AgentSession,
	type AgentSessionEvent,
	type QueuedInputEvent,
	type QueuedInputSubmission,
} from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

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

	it("correlates duplicate steers and follow-ups with their exact same-run terminal", async () => {
		const gate = Promise.withResolvers<void>();
		session = buildSession([
			async () => {
				await gate.promise;
				return { content: ["first"] };
			},
			{ content: ["steered"] },
			{ content: ["followed"] },
			{ content: ["followed again"] },
		]);
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));
		const first = session.prompt("root");
		await waitUntil(() => session!.agent.state.isStreaming);
		const steer = await session.submitQueuedInput("duplicate", { mode: "steer" });
		const followUp = await session.submitQueuedInput("duplicate", { mode: "followUp" });
		const duplicateFollowUp = await session.submitQueuedInput("duplicate", { mode: "followUp" });
		expect(duplicateFollowUp.submissionId).not.toBe(followUp.submissionId);
		expect(steer.submissionId).not.toBe(followUp.submissionId);
		expect(events.filter(event => event.type === "queued_input_admitted")).toEqual([
			{ type: "queued_input_admitted", submissionId: steer.submissionId, mode: "steer" },
			{ type: "queued_input_admitted", submissionId: followUp.submissionId, mode: "followUp" },
			{ type: "queued_input_admitted", submissionId: duplicateFollowUp.submissionId, mode: "followUp" },
		]);
		gate.resolve();
		await first;
		await session.waitForIdle();
		const end = events.find(event => event.type === "agent_end");
		if (end?.type !== "agent_end") throw new Error("Expected owning terminal");
		for (const handle of [steer, followUp, duplicateFollowUp]) {
			const consumed = events.filter(
				(event): event is Extract<QueuedInputEvent, { type: "queued_input_consumed" }> =>
					event.type === "queued_input_consumed" && event.submissionId === handle.submissionId,
			);
			expect(consumed).toHaveLength(1);
			const execution = consumed[0];
			if (!execution) throw new Error("Expected consumed submission");
			expect(execution.startsOwnRun).toBe(false);
			expect(
				events.some(
					event =>
						event.type === "message_start" &&
						event.scope === execution.scope &&
						event.message.role === "user" &&
						messageText(event.message) === "duplicate",
				),
			).toBe(true);
			expect(
				events.filter(
					event => event.type === "queued_input_terminal" && event.submissionId === handle.submissionId,
				),
			).toEqual([
				{ type: "queued_input_terminal", submissionId: handle.submissionId, terminal: end, runId: execution.runId },
			]);
			expect(handle.cancel()).toBe(false);
		}
		expect(userTexts(session)).toEqual(["root", "duplicate", "duplicate", "duplicate"]);
	});

	it("settles exact duplicate removals and cancellations without an unrelated terminal", async () => {
		const gate = Promise.withResolvers<void>();
		session = buildSession([
			async () => {
				await gate.promise;
				return { content: ["done"] };
			},
		]);
		const events: QueuedInputEvent[] = [];
		session.subscribe(event => {
			if (event.type.startsWith("queued_input_")) events.push(event as QueuedInputEvent);
		});
		const first = session.prompt("root");
		await waitUntil(() => session!.agent.state.isStreaming);
		const steer = await session.submitQueuedInput("duplicate", { mode: "steer" });
		const followUp = await session.submitQueuedInput("duplicate", { mode: "followUp" });
		const edited = await session.submitQueuedInput("duplicate", { mode: "followUp" });
		const clearedFollowUp = await session.submitQueuedInput("duplicate", { mode: "followUp" });
		expect(followUp.cancel()).toBe(true);
		expect(followUp.cancel()).toBe(false);
		expect(session.removeQueuedMessageForEditing(edited.submissionId)).toBe("duplicate");
		session.clearQueue();
		expect(steer.cancel()).toBe(false);
		expect(events.filter(event => event.type === "queued_input_removed").map(event => event.submissionId)).toEqual([
			followUp.submissionId,
			edited.submissionId,
			steer.submissionId,
			clearedFollowUp.submissionId,
		]);
		expect(
			events.some(event => event.type === "queued_input_consumed" || event.type === "queued_input_terminal"),
		).toBe(false);
		gate.resolve();
		await first;
		await session.waitForIdle();
		expect(userTexts(session)).toEqual(["root"]);
		expect(events.filter(event => event.type === "queued_input_removed")).toHaveLength(4);
		expect(clearedFollowUp.cancel()).toBe(false);
	});

	it("promotes late unwind submissions and preserves sequential FIFO under batch mode (#5371)", async () => {
		session = buildSession([{ content: ["root done"] }, { content: ["second"] }, { content: ["third"] }]);
		session.setFollowUpMode("all");
		const events: AgentSessionEvent[] = [];
		const handles: Promise<QueuedInputSubmission>[] = [];
		let submitted = false;
		session.subscribe(event => {
			events.push(event);
			if (event.type !== "agent_end" || submitted) return;
			submitted = true;
			handles.push(session!.submitQueuedInput("second", { mode: "followUp", queuePolicy: "sequential" }));
			handles.push(session!.submitQueuedInput("third", { mode: "followUp", queuePolicy: "sequential" }));
		});
		await session.prompt("root");
		const submissions = await Promise.all(handles);
		await session.waitForIdle();
		expect(userTexts(session)).toEqual(["root", "second", "third"]);
		expect(assistantCount(session)).toBe(3);
		const consumed = events.filter(
			(event): event is Extract<QueuedInputEvent, { type: "queued_input_consumed" }> =>
				event.type === "queued_input_consumed",
		);
		expect(consumed.map(event => event.submissionId)).toEqual(submissions.map(handle => handle.submissionId));
		expect(consumed[0]?.startsOwnRun).toBe(true);
		const predecessor = events.find(event => event.type === "agent_end");
		for (const execution of consumed) {
			const terminals = events.filter(
				(event): event is Extract<QueuedInputEvent, { type: "queued_input_terminal" }> =>
					event.type === "queued_input_terminal" && event.submissionId === execution.submissionId,
			);
			expect(terminals).toHaveLength(1);
			expect(terminals[0]?.runId).toBe(execution.runId);
			expect(terminals[0]?.terminal).not.toBe(predecessor);
		}
	});

	it("promotes an idle steer to its successor without attaching to the predecessor terminal", async () => {
		session = buildSession([{ content: ["root done"] }, { content: ["successor done"] }]);
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));
		await session.prompt("root");
		const predecessor = events.find(event => event.type === "agent_end");
		const submission = await session.submitQueuedInput("idle steer", { mode: "steer" });
		await session.waitForIdle();
		const consumed = events.find(
			(event): event is Extract<QueuedInputEvent, { type: "queued_input_consumed" }> =>
				event.type === "queued_input_consumed" && event.submissionId === submission.submissionId,
		);
		const terminal = events.find(
			(event): event is Extract<QueuedInputEvent, { type: "queued_input_terminal" }> =>
				event.type === "queued_input_terminal" && event.submissionId === submission.submissionId,
		);
		expect(consumed?.startsOwnRun).toBe(true);
		expect(consumed?.scope).toBeDefined();
		expect(terminal?.terminal.scope).toBe(consumed?.scope);
		expect(terminal?.terminal).not.toBe(predecessor);
		expect(userTexts(session)).toEqual(["root", "idle steer"]);
		expect(submission.cancel()).toBe(false);
	});

	it("rejects invalid JavaScript queue modes before admission", async () => {
		session = buildSession([]);
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));
		for (const mode of ["invalid", "", null, undefined]) {
			await expect(session.submitQueuedInput("input", { mode: mode as "steer" })).rejects.toMatchObject({
				code: "invalid_input",
			});
		}
		expect(session.queuedMessageCount).toBe(0);
		expect(events).toEqual([]);
	});

	it("honors sequential steer FIFO even when steering mode batches", async () => {
		const gate = Promise.withResolvers<void>();
		session = buildSession([
			async () => {
				await gate.promise;
				return { content: ["root done"] };
			},
			{ content: ["first steer done"] },
			{ content: ["second steer done"] },
		]);
		session.setSteeringMode("all");
		const consumed: string[] = [];
		session.subscribe(event => {
			if (event.type === "queued_input_consumed") consumed.push(event.submissionId);
		});
		const first = session.prompt("root");
		await waitUntil(() => session!.agent.state.isStreaming);
		const older = await session.submitQueuedInput("older", { mode: "steer", queuePolicy: "sequential" });
		const newer = await session.submitQueuedInput("newer", { mode: "steer", queuePolicy: "sequential" });
		gate.resolve();
		await first;
		await session.waitForIdle();
		expect(userTexts(session)).toEqual(["root", "older", "newer"]);
		expect(assistantCount(session)).toBe(3);
		expect(consumed).toEqual([older.submissionId, newer.submissionId]);
	});

	it("settles consumed input across a maintenance attempt-scope change", async () => {
		const gate = Promise.withResolvers<void>();
		session = buildSession([
			async () => {
				await gate.promise;
				return { content: ["root"] };
			},
			{ content: ["resumed"] },
		]);
		let maintained = false;
		session.agent.setMaintainContext(context => {
			if (
				!maintained &&
				context.messages.some(message => message.role === "user" && messageText(message) === "steer")
			) {
				maintained = true;
				return "pruned";
			}
			return "not-needed";
		});
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));
		const first = session.prompt("root");
		await waitUntil(() => session!.agent.state.isStreaming);
		const submission = await session.submitQueuedInput("steer", { mode: "steer" });
		gate.resolve();
		await first;
		await session.waitForIdle();
		const consumed = events.find(
			(event): event is Extract<QueuedInputEvent, { type: "queued_input_consumed" }> =>
				event.type === "queued_input_consumed",
		);
		const terminals = events.filter(
			(event): event is Extract<QueuedInputEvent, { type: "queued_input_terminal" }> =>
				event.type === "queued_input_terminal",
		);
		expect(maintained).toBe(true);
		if (!consumed) throw new Error("Expected consumption provenance");
		expect(terminals).toHaveLength(1);
		expect(terminals[0]?.submissionId).toBe(submission.submissionId);
		expect(terminals[0]?.terminal.scope).not.toBe(consumed?.scope);
		expect(terminals[0]?.runId).toBe(consumed.runId);
		expect(terminals[0]?.terminal.stopReason).not.toBe("maintenance");
	});

	for (const mode of ["steer", "followUp"] as const) {
		it(`commits an entire ${mode} batch before a consumed listener cancels its sibling`, async () => {
			const gate = Promise.withResolvers<void>();
			session = buildSession([
				async () => {
					await gate.promise;
					return { content: ["root"] };
				},
				{ content: ["batch"] },
			]);
			session.setSteeringMode("all");
			session.setFollowUpMode("all");
			const first = session.prompt("root");
			await waitUntil(() => session!.agent.state.isStreaming);
			const older = await session.submitQueuedInput("same", { mode });
			const newer = await session.submitQueuedInput("same", { mode });
			const events: AgentSessionEvent[] = [];
			let cancelled: boolean | undefined;
			session.subscribe(event => {
				events.push(event);
				if (event.type === "queued_input_consumed" && event.submissionId === older.submissionId)
					cancelled = newer.cancel();
			});
			gate.resolve();
			await first;
			await session.waitForIdle();
			expect(cancelled).toBe(false);
			expect(userTexts(session)).toEqual(["root", "same", "same"]);
			expect(events.filter(event => event.type === "queued_input_removed")).toEqual([]);
			expect(
				events.filter(event => event.type === "queued_input_terminal").map(event => event.submissionId),
			).toEqual([older.submissionId, newer.submissionId]);
		});

		it(`binds the selected ${mode} submission accepted by cancelAndSubmit`, async () => {
			const gate = Promise.withResolvers<void>();
			session = buildSession([
				async () => {
					await gate.promise;
					return { content: ["root"] };
				},
				{ content: ["replacement"] },
			]);
			const events: AgentSessionEvent[] = [];
			session.subscribe(event => events.push(event));
			const first = session.prompt("root");
			await waitUntil(() => session!.agent.state.isStreaming);
			const submission = await session.submitQueuedInput("selected", { mode });
			const abortSpy = spyOn(session.agent, "abort");
			const replacement = session.cancelAndSubmit("selected", { queuedEntryId: submission.submissionId });
			await waitUntil(() => abortSpy.mock.calls.length > 0);
			abortSpy.mockRestore();
			gate.resolve();
			expect(await replacement).toEqual({ kind: "submitted" });
			await first;
			await session.waitForIdle();
			const consumed = events.filter(
				(event): event is Extract<QueuedInputEvent, { type: "queued_input_consumed" }> =>
					event.type === "queued_input_consumed",
			);
			const terminal = events.filter(
				(event): event is Extract<QueuedInputEvent, { type: "queued_input_terminal" }> =>
					event.type === "queued_input_terminal",
			);
			expect(consumed).toHaveLength(1);
			expect(consumed[0]).toMatchObject({ submissionId: submission.submissionId, startsOwnRun: true });
			expect(terminal).toHaveLength(1);
			expect(terminal[0]?.terminal.scope).toBe(consumed[0]?.scope);
			expect(userTexts(session).filter(text => text === "selected")).toHaveLength(1);
		});
	}

	it("does not requeue input when a consumed listener aborts its materialized run", async () => {
		const gate = Promise.withResolvers<void>();
		session = buildSession([
			async () => {
				await gate.promise;
				return { content: ["root"] };
			},
			{ content: ["steered"] },
		]);
		const events: AgentSessionEvent[] = [];
		let abort: Promise<unknown> | undefined;
		session.subscribe(event => {
			events.push(event);
			if (event.type === "queued_input_consumed") abort = session!.abort({ cause: "user_interrupt" });
		});
		const first = session.prompt("root");
		await waitUntil(() => session!.agent.state.isStreaming);
		const submission = await session.submitQueuedInput("once", { mode: "steer" });
		gate.resolve();
		await first;
		await abort;
		await session.waitForIdle();
		expect(userTexts(session).filter(text => text === "once")).toHaveLength(1);
		expect(session.queuedMessageCount).toBe(0);
		expect(events.filter(event => event.type === "queued_input_consumed")).toHaveLength(1);
		expect(events.filter(event => event.type === "queued_input_terminal").map(event => event.submissionId)).toEqual([
			submission.submissionId,
		]);
		const terminal = events.find(
			(event): event is Extract<QueuedInputEvent, { type: "queued_input_terminal" }> =>
				event.type === "queued_input_terminal",
		);
		expect(
			terminal?.terminal.messages.some(message => message.role === "user" && messageText(message) === "once"),
		).toBe(true);
		expect(terminal?.terminal).toMatchObject({ stopReason: "maintenance", maintenanceOutcome: "aborted" });
	});

	for (const operation of ["dispose", "newSession"] as const) {
		it(`settles pending and consumed submissions when ${operation} detaches the bridge`, async () => {
			const firstGate = Promise.withResolvers<void>();
			const secondGate = Promise.withResolvers<void>();
			const secondStarted = Promise.withResolvers<void>();
			session = buildSession([
				async () => {
					await firstGate.promise;
					return { content: ["root"] };
				},
				async () => {
					secondStarted.resolve();
					await secondGate.promise;
					return { content: ["steered"] };
				},
			]);
			const events: AgentSessionEvent[] = [];
			session.subscribe(event => events.push(event));
			const first = session.prompt("root");
			await waitUntil(() => session!.agent.state.isStreaming);
			const consumed = await session.submitQueuedInput("consumed", { mode: "steer" });
			firstGate.resolve();
			await secondStarted.promise;
			const pending = await session.submitQueuedInput("pending", { mode: "followUp" });
			const abortSpy = spyOn(session.agent, "abort");
			const closing = operation === "dispose" ? session.dispose() : session.newSession();
			await waitUntil(() => abortSpy.mock.calls.length > 0);
			abortSpy.mockRestore();
			secondGate.resolve();
			await closing;
			await first;
			expect(events.filter(event => event.type === "queued_input_removed").map(event => event.submissionId)).toEqual(
				[pending.submissionId],
			);
			const terminals = events.filter(
				(event): event is Extract<QueuedInputEvent, { type: "queued_input_terminal" }> =>
					event.type === "queued_input_terminal",
			);
			if (!terminals[0]) throw new Error("Expected settled submission after teardown");
			expect(
				terminals[0].terminal.messages.some(
					message => message.role === "user" && messageText(message) === "consumed",
				),
			).toBe(true);
			expect(terminals).toHaveLength(1);
			expect(terminals[0]?.submissionId).toBe(consumed.submissionId);
			// The mock can finish after receiving abort; preserve the real terminal
			// rather than inventing a cancelled result for completed execution.
			expect(terminals[0]?.terminal.type).toBe("agent_end");
			const execution = events.find(
				(event): event is Extract<QueuedInputEvent, { type: "queued_input_consumed" }> =>
					event.type === "queued_input_consumed" && event.submissionId === consumed.submissionId,
			);
			if (!execution) throw new Error("Expected consumed ownership");
			expect(terminals[0]?.runId).toBe(execution.runId);
			expect(pending.cancel()).toBe(false);
			expect(consumed.cancel()).toBe(false);
		});
	}

	it("preserves pending ownership when switching sessions rolls back", async () => {
		session = buildSession([]);
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));
		const submission = await session.submitQueuedInput("preserved", { mode: "followUp" });
		const setSessionFile = spyOn(session.sessionManager, "setSessionFile").mockRejectedValueOnce(
			new Error("load failed"),
		);
		try {
			await expect(session.switchSession(path.join(tempDir.path(), "unloadable.jsonl"))).rejects.toThrow(
				"load failed",
			);
		} finally {
			setSessionFile.mockRestore();
		}
		expect(events.filter(event => event.type === "queued_input_removed")).toEqual([]);
		expect(session.getQueuedMessages().followUp).toEqual(["preserved"]);
		expect(submission.cancel()).toBe(true);
		expect(events.filter(event => event.type === "queued_input_removed").map(event => event.submissionId)).toEqual([
			submission.submissionId,
		]);
		expect(session.queuedMessageCount).toBe(0);
	});

	for (const mode of ["steer", "followUp"] as const) {
		it(`refuses edit removal of a claimed ${mode} at next turn_start`, async () => {
			const gate = Promise.withResolvers<void>();
			session = buildSession([
				async () => {
					await gate.promise;
					return { content: ["root"] };
				},
				{ content: ["queued response"] },
			]);
			const first = session.prompt("root");
			await waitUntil(() => session!.agent.state.isStreaming);
			const submission = await session.submitQueuedInput("claimed", { mode });
			const events: AgentSessionEvent[] = [];
			let attempted = false;
			let removed: string | undefined;
			session.subscribe(event => {
				events.push(event);
				if (event.type === "turn_start" && !attempted) {
					attempted = true;
					removed = session!.removeQueuedMessageForEditing(submission.submissionId);
				}
			});
			gate.resolve();
			await first;
			await session.waitForIdle();
			expect(attempted).toBe(true);
			expect(removed).toBeUndefined();
			expect(events.filter(event => event.type === "queued_input_removed")).toEqual([]);
			expect(
				events.filter(event => event.type === "queued_input_consumed").map(event => event.submissionId),
			).toEqual([submission.submissionId]);
			expect(
				events.filter(event => event.type === "queued_input_terminal").map(event => event.submissionId),
			).toEqual([submission.submissionId]);
			expect(userTexts(session)).toEqual(["root", "claimed"]);
			expect(submission.cancel()).toBe(false);
		});
	}
});
