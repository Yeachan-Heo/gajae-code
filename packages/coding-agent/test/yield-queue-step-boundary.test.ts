import { afterEach, describe, expect, test } from "bun:test";
import type { AgentMessage } from "@gajae-code/agent-core";
import { createMockModel, type MockModel, type MockResponse, registerMockApi } from "@gajae-code/ai/providers/mock";
import { TempDir } from "@gajae-code/utils";
import { AsyncJobManager } from "../src/async";
import { Settings } from "../src/config/settings";
import { type CreateAgentSessionResult, createAgentSession } from "../src/sdk";
import { AuthStorage } from "../src/session/auth-storage";
import { FOLD_WAKE_MERGE_WINDOW_MS } from "../src/session/fold-coordinator";
import { SessionManager } from "../src/session/session-manager";
import {
	classifyOwnedEnvelope,
	lookupOwnedRegistration,
	resetTerminalAbortRegistriesForTests,
	type TurnRegistrationKey,
} from "../src/session/terminal-abort";

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

function bashCall(command: string): MockResponse {
	return { content: [{ type: "toolCall", name: "bash", arguments: { command, timeout: 10 } }] };
}

/** A real background bash job, so the tool call's lineage registers the job as owned. */
function backgroundBashCall(command: string): MockResponse {
	return { content: [{ type: "toolCall", name: "bash", arguments: { command, timeout: 30, async: true } }] };
}

/**
 * Shell loop that finishes (printing `marker`) only once `gate` exists. The
 * marker is quoted apart in the command so the tool call's own arguments in the
 * model context never contain it; only the job's output does.
 */
function gatedJob(gate: string, marker: string): string {
	const split = marker.lastIndexOf("_");
	return `while [ ! -f "${gate}" ]; do sleep 0.05; done; echo ${marker.slice(0, split)}"${marker.slice(split)}"`;
}

/** Foreground step that releases the gated job and outlasts its completion delivery. */
function releaseGate(gate: string): string {
	return `touch "${gate}"; sleep 1.5`;
}

/**
 * Issue #7993 cause 2: an async result that completes while the agent is
 * working must reach the turn at its next tool step, not wait for the
 * before-yield flush that forces an extra iteration after the final answer.
 */
describe("yield queue step-boundary delivery", () => {
	let created: CreateAgentSessionResult | undefined;
	let authStorage: AuthStorage | undefined;
	let tempDir: TempDir | undefined;

	afterEach(async () => {
		await created?.session.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		created = undefined;
		authStorage = undefined;
		tempDir = undefined;
		AsyncJobManager.resetForTests();
		resetTerminalAbortRegistriesForTests();
	});

	async function createSession(handler: (call: number) => Promise<MockResponse>): Promise<MockModel> {
		tempDir = TempDir.createSync("@gjc-yield-step-boundary-");
		registerMockApi();
		authStorage = await AuthStorage.create(`${tempDir.path()}/auth.db`);
		let call = 0;
		const mock = createMockModel({ handler: () => handler(++call) });
		authStorage.setRuntimeApiKey(mock.model.provider, "test-key");
		created = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			settings: Settings.isolated({
				"async.enabled": true,
				"bash.autoBackground.enabled": false,
				"compaction.enabled": false,
			}),
			model: mock.model,
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			sdkHostModeSupported: false,
			notificationHostModeSupported: false,
		});
		return mock;
	}

	function session() {
		if (!created) throw new Error("expected SDK fixture");
		return created.session;
	}

	function manager(): AsyncJobManager {
		const instance = AsyncJobManager.instance();
		if (!instance) throw new Error("expected SDK async manager");
		return instance;
	}

	/** Register an ordinary background job and wait until its result sits in the yield queue. */
	async function completeOrdinaryJob(output: string): Promise<void> {
		manager().register("bash", "background work", async () => output);
		await waitFor(() => session().yieldQueue.has("async-result"), "async-result enqueue");
	}

	const contextOf = (mock: MockModel, index: number): string => JSON.stringify(mock.calls[index]?.context.messages);

	function asyncResultMessages(): AgentMessage[] {
		return session().agent.state.messages.filter(
			message => message.role === "custom" && message.customType === "async-result",
		);
	}

	/** Outlast the idle wake window so a stray later delivery would be observed. */
	const settle = () => Bun.sleep(FOLD_WAKE_MERGE_WINDOW_MS + 400);

	test("a job completing during a multi-tool turn is delivered at the next step boundary with no extra iteration", async () => {
		const mock = await createSession(async call => {
			if (call === 1) return bashCall("true");
			if (call === 2) {
				await completeOrdinaryJob("BG_RESULT_ALPHA");
				return bashCall("true");
			}
			return { content: ["final answer"] };
		});

		await session().prompt("work with several tools");
		await settle();

		// Call 3 is the step after the job completed: it already sees the result.
		expect(contextOf(mock, 1)).not.toContain("BG_RESULT_ALPHA");
		expect(contextOf(mock, 2)).toContain("BG_RESULT_ALPHA");
		// The final answer ends the turn: no trailing iteration for the result.
		expect(mock.calls).toHaveLength(3);
		expect(asyncResultMessages()).toHaveLength(1);
		expect(session().yieldQueue.has()).toBe(false);
	});

	test("no double delivery when the turn ends right after the boundary", async () => {
		const mock = await createSession(async call => {
			if (call === 1) {
				await completeOrdinaryJob("BG_RESULT_BOUNDARY_END");
				return bashCall("true");
			}
			return { content: ["final answer"] };
		});

		await session().prompt("one tool then answer");
		await settle();

		expect(contextOf(mock, 1)).toContain("BG_RESULT_BOUNDARY_END");
		expect(mock.calls).toHaveLength(2);
		expect(asyncResultMessages()).toHaveLength(1);
	});

	test("a job completing during the final answer still uses the before-yield path exactly once", async () => {
		const mock = await createSession(async call => {
			if (call === 1) return bashCall("true");
			if (call === 2) {
				await completeOrdinaryJob("BG_RESULT_FINAL");
				return { content: ["final answer"] };
			}
			return { content: ["acknowledged"] };
		});

		await session().prompt("one tool then answer");
		await settle();

		// No step boundary follows a final answer, so before-yield delivers it.
		expect(mock.calls).toHaveLength(3);
		expect(contextOf(mock, 2)).toContain("BG_RESULT_FINAL");
		expect(asyncResultMessages()).toHaveLength(1);
	});

	test("a fold-receipt result stays on the before-yield path and is not delivered at a step boundary", async () => {
		const mock = await createSession(async call => {
			if (call === 1) {
				session().yieldQueue.enqueue("async-result", {
					jobId: "bg_fold_receipt",
					generation: "fold-receipt-generation",
					result: "FOLD_RECEIPT_BETA",
					job: undefined,
					durationMs: undefined,
					foldReceipt: true,
				});
				await completeOrdinaryJob("BG_RESULT_ORDINARY");
				return bashCall("true");
			}
			return { content: [`answer ${call}`] };
		});

		await session().prompt("one tool then answer");
		await settle();

		// The ordinary result rides the boundary; the receipt waits for before-yield.
		expect(contextOf(mock, 1)).toContain("BG_RESULT_ORDINARY");
		expect(contextOf(mock, 1)).not.toContain("FOLD_RECEIPT_BETA");
		expect(mock.calls).toHaveLength(3);
		expect(contextOf(mock, 2)).toContain("FOLD_RECEIPT_BETA");
		expect(asyncResultMessages()).toHaveLength(2);
	});

	test("an abort during the turn delivers nothing at a boundary and leaves settlement to the abort path", async () => {
		const toolStarted = Promise.withResolvers<void>();
		const mock = await createSession(async call => {
			if (call === 1) {
				await completeOrdinaryJob("BG_RESULT_ABORTED_TURN");
				toolStarted.resolve();
				return bashCall("sleep 5");
			}
			return { content: [`answer ${call}`] };
		});

		const run = session()
			.prompt("long tool")
			.catch(() => {});
		await toolStarted.promise;
		await waitFor(() => session().isBashRunning || session().agent.state.isStreaming, "tool start");
		await Bun.sleep(100);
		await session().abort();
		await run;
		await settle();

		// The aborted run never reached a step boundary, so the result was not
		// injected into it, and the abort's own queue settlement (unchanged by the
		// step-boundary path) leaves nothing behind for a later wake.
		expect(mock.calls).toHaveLength(1);
		expect(asyncResultMessages()).toHaveLength(0);
		expect(session().yieldQueue.has()).toBe(false);
	}, 20_000);

	function ownedRegistrationOf(jobId: string, generation: string): TurnRegistrationKey | undefined {
		return lookupOwnedRegistration(jobId, generation, AsyncJobManager.endpointIdOf(manager()));
	}

	function onlyJob() {
		const jobs = manager().getAllJobs();
		if (jobs.length !== 1) throw new Error(`expected one background job, found ${jobs.length}`);
		return jobs[0]!;
	}

	test("a background bash job launched by the turn rides the next step boundary and settles its owned registration", async () => {
		let gate = "";
		let registeredDuringTurn: TurnRegistrationKey | undefined;
		let backgroundJob: { id: string; generation: string } | undefined;
		const mock = await createSession(async call => {
			if (call === 1) return backgroundBashCall(gatedJob(gate, "BG_OWNED_ALPHA"));
			if (call === 2) {
				backgroundJob = onlyJob();
				registeredDuringTurn = ownedRegistrationOf(backgroundJob.id, backgroundJob.generation);
				return bashCall(releaseGate(gate));
			}
			return { content: [`answer ${call}`] };
		});
		gate = `${tempDir!.path()}/gate-alpha`;

		await session().prompt("start background work, then keep working");
		await settle();

		// The production path attached an ownership envelope that classifies ordinary.
		expect(registeredDuringTurn).toBeDefined();
		const delivered = asyncResultMessages();
		expect(delivered).toHaveLength(1);
		expect((delivered[0] as { details?: { ownedCompletions?: unknown[] } }).details?.ownedCompletions).toHaveLength(
			1,
		);
		// Delivered in the step after the job completed, with no trailing iteration.
		expect(contextOf(mock, 1)).not.toContain("BG_OWNED_ALPHA");
		expect(contextOf(mock, 2)).toContain("BG_OWNED_ALPHA");
		expect(mock.calls).toHaveLength(3);
		// Boundary delivery settled the terminal job's owned registration.
		if (!backgroundJob) throw new Error("expected the background job");
		expect(ownedRegistrationOf(backgroundJob.id, backgroundJob.generation)).toBeUndefined();
	}, 20_000);

	test("a completion owned by a terminal-aborted turn (fresh) does not ride a later turn's step boundary", async () => {
		let gate = "";
		const mock = await createSession(async call => {
			if (call === 1) return backgroundBashCall(gatedJob(gate, "BG_FRESH_BETA"));
			if (call === 3) return bashCall(releaseGate(gate));
			return { content: [`answer ${call}`] };
		});
		gate = `${tempDir!.path()}/gate-beta`;

		await session().prompt("start background work");
		const job = onlyJob();
		await session().abortPromptAndWait(session().agent.activeResourceRunId ?? job.id, {
			graceMs: 50,
			terminal: { scope: "turn" },
		});
		const registration = ownedRegistrationOf(job.id, job.generation);
		if (!registration) throw new Error("expected the left-running job to stay registered");
		expect(
			classifyOwnedEnvelope({
				lineageIdHash: registration.lineageIdHash,
				promptAttemptEpoch: registration.promptAttemptEpoch,
				registration,
			}),
		).toBe("fresh");

		await session().prompt("keep working in a new turn");
		await waitFor(() => asyncResultMessages().length > 0, "fresh resume delivery", 10_000);
		await session().waitForIdle();
		await settle();

		// Call 4 follows the tool step during which the job completed: the fresh
		// resume must not ride it, and arrives through the follow-up path instead.
		expect(contextOf(mock, 3)).not.toContain("BG_FRESH_BETA");
		expect(mock.calls.length).toBeGreaterThan(4);
		expect(contextOf(mock, mock.calls.length - 1)).toContain("BG_FRESH_BETA");
		expect(asyncResultMessages()).toHaveLength(1);
	}, 30_000);

	test("a folded job's receipt (production fold disposition) does not ride a later turn's step boundary", async () => {
		let gate = "";
		const mock = await createSession(async call => {
			if (call === 1) return bashCall(gatedJob(gate, "FOLD_RECEIPT_GAMMA"));
			if (call === 2) return bashCall(releaseGate(gate));
			return { content: [`answer ${call}`] };
		});
		gate = `${tempDir!.path()}/gate-gamma`;

		const folded = session().prompt("run a long foreground command");
		await waitFor(() => session().hasForegroundBashBackgroundRequestHandler(), "foreground bash");
		expect(await session().requestForegroundBashBackground()).toBe(true);
		await folded;
		expect(mock.calls).toHaveLength(1);

		await session().prompt("keep working in a new turn");
		await waitFor(
			() => asyncResultMessages().some(message => JSON.stringify(message).includes("FOLD_RECEIPT_GAMMA")),
			"fold receipt delivery",
			10_000,
		);
		await session().waitForIdle();
		await settle();

		// Call 3 follows the tool step during which the folded job completed.
		expect(contextOf(mock, 2)).not.toContain("FOLD_RECEIPT_GAMMA");
		expect(mock.calls.length).toBeGreaterThan(3);
		expect(contextOf(mock, mock.calls.length - 1)).toContain("FOLD_RECEIPT_GAMMA");
		expect(asyncResultMessages()).toHaveLength(1);
	}, 30_000);
});
