import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import * as z from "zod/v4";
import { waitForToolCallBoundary } from "../src/sdk/prompt-tool-boundary";

/**
 * #5637 review thread P2: the bus-level cases drive the deadline handlers
 * directly and stub the abort, so they never observe a real abort signal, real
 * file-mutation integrity, real resource-ledger settlement, or a single final
 * frame on the real Agent path. These do, on a live `AgentSession` running a
 * controlled mutating tool paused mid-write.
 *
 * What runs end-to-end here is the load-bearing half of the fix: the production
 * `waitForToolCallBoundary` fed by the production
 * `AgentSession.pendingToolExecutions`, reading a REAL run resource ledger
 * populated by a REAL dispatched tool, then the real `abortPromptAndWait`. The
 * WebSocket bus transport around it stays covered by
 * `sdk-bus-prompt-deadline.test.ts`.
 */

const TOOL_CALL_ID = "mutating-call";
/** Short, so the forced case proves its UPPER bound quickly instead of in 5 s. */
const TEST_GRACE_MS = 300;
/** The model call after the tool never answers, so the run is still live to fence. */
const UNANSWERED_MODEL_CALL_MS = 30_000;

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(5);
	}
}

/** A tool that writes in two halves and parks between them, like a real patch apply. */
function mutatingTool(input: {
	target: string;
	release: Promise<void>;
	onStart: (signal: AbortSignal | undefined) => void;
	record: (observation: { abortedMidWrite: boolean }) => void;
}): AgentTool {
	return {
		name: "mutate",
		label: "Mutate",
		description: "Writes a file in two halves, parking mid-write",
		parameters: z.object({}),
		execute: async (_toolCallId: string, _params: unknown, signal?: AbortSignal) => {
			fs.writeFileSync(input.target, "FIRST-HALF");
			input.onStart(signal);
			await input.release;
			// The observation the whole fix exists for: was this call told to give up
			// while it still had a half-written file on disk?
			input.record({ abortedMidWrite: signal?.aborted === true });
			fs.writeFileSync(input.target, "FIRST-HALF/SECOND-HALF");
			return { content: [{ type: "text" as const, text: "written" }] };
		},
	};
}

describe("prompt deadline tool boundary on a live AgentSession", () => {
	let tempDir: TempDir | undefined;
	let session: AgentSession | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		await tempDir?.remove();
		tempDir = undefined;
	});

	/** Build a live session whose single turn calls the mutating tool, and start it. */
	async function startMutatingTurn(release: Promise<void>) {
		tempDir = TempDir.createSync("@gjc-deadline-boundary-");
		const target = path.join(tempDir.path(), "artifact.txt");
		const toolRunning = Promise.withResolvers<void>();
		const observations: Array<{ abortedMidWrite: boolean }> = [];
		const state: { toolSignal?: AbortSignal } = {};
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: TOOL_CALL_ID, name: "mutate", arguments: {} }] },
				// Never answered: the deadline must fence a run that is still live once
				// the tool reaches its boundary, which is the real sequencing.
				{ content: ["done"], delayMs: UNANSWERED_MODEL_CALL_MS },
			],
		});
		const tool = mutatingTool({
			target,
			release,
			onStart: signal => {
				state.toolSignal = signal;
				toolRunning.resolve();
			},
			record: observation => observations.push(observation),
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [tool], messages: [] },
			streamFn: mock.stream,
		});
		const live = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			// `getAvailable` is NOT optional here. `compaction.enabled: false` does
			// not keep the prompt off the compaction path: the resource-floor
			// emergency in `#checkEstimatedContextBeforePromptOnce` calls
			// `#runAutoCompaction(..., { force: true })`, and `force` deliberately
			// bypasses both the strategy-off and the disabled guards, landing on
			// `#modelRegistry.getAvailable()`. That floor only trips under memory
			// pressure, so a stub without it passes alone and throws inside
			// `prompt()` under a full-suite run — taking every assertion below with it.
			modelRegistry: { getApiKey: async () => "test-key", getAvailable: () => [mock.model] } as never,
		});
		session = live;
		// `activePromptHandle` goes undefined once the run is terminal, so the
		// deadline owner's handle has to be captured while the run is live.
		let handle: string | undefined;
		const finalFrames: string[] = [];
		live.subscribe(event => {
			if (event.type === "agent_start") handle ??= agent.activeResourceRunId;
			if (event.type === "agent_end" || event.type === "agent_failed") finalFrames.push(event.type);
		});
		const prompt = live.prompt("mutate the artifact");
		await toolRunning.promise;
		if (!handle) throw new Error("Expected an execution handle while the run was live");
		return { live, agent, prompt, handle, target, finalFrames, observations, state };
	}

	it("waits for a real mutating tool to finish, leaving no abort signal and no torn file", async () => {
		const release = Promise.withResolvers<void>();
		const turn = await startMutatingTurn(release.promise);
		// Safety valve so a regression fails its assertion instead of eating the
		// suite's hook timeout.
		const safety = setTimeout(() => release.resolve(), 5_000);
		safety.unref?.();
		try {
			// The authority, read from the REAL ledger while the tool is parked
			// mid-write. AgentLoop reserved this lease synchronously before `execute`.
			expect(turn.live.pendingToolExecutions(turn.handle)).toEqual([TOOL_CALL_ID]);
			expect(fs.readFileSync(turn.target, "utf8")).toBe("FIRST-HALF");

			// The deadline has expired. Exactly what the bus does at that point:
			const boundary = waitForToolCallBoundary({
				pending: () => turn.live.pendingToolExecutions(turn.handle),
				// No event-derived idle signal at all — the ledger alone must carry it,
				// which is the stuck-fanout shape from review thread P1.
				whenIdle: () => new Promise<void>(() => {}),
				graceMs: 5_000,
			});
			// Proving a NEGATIVE inside a window, which a poll cannot express: the wait
			// must still be pending while the tool holds its half-written file.
			const pendingProbe = await Promise.race([
				boundary.then(() => "resolved"),
				Bun.sleep(150).then(() => "waiting"),
			]);
			expect(pendingProbe).toBe("waiting");

			release.resolve();
			expect((await boundary).outcome).toBe("settled");

			// The tool ran to completion without ever being told to give up ...
			expect(turn.observations).toEqual([{ abortedMidWrite: false }]);
			// ... so the artifact is whole, not torn.
			expect(fs.readFileSync(turn.target, "utf8")).toBe("FIRST-HALF/SECOND-HALF");

			// Only now does the deadline fence the still-live run.
			expect(await turn.live.abortPromptAndWait(turn.handle, { graceMs: 1_000 })).toMatchObject({
				status: "settled",
			});
			await turn.prompt.catch(() => undefined);
			await turn.live.waitForIdle();
			// The ledger agrees the run's resources are settled, with none left behind.
			expect(await turn.agent.resourceLedger.waitForSettlement(turn.handle, { graceMs: 100 })).toEqual({
				status: "settled",
			});
			expect(turn.live.pendingToolExecutions(turn.handle)).toEqual([]);
			expect(turn.finalFrames).toHaveLength(1);
		} finally {
			clearTimeout(safety);
			release.resolve();
			await turn.prompt.catch(() => undefined);
		}
	}, 30_000);

	it("force-terminates a tool that outlasts the grace, within the grace and not merely eventually", async () => {
		const release = Promise.withResolvers<void>();
		const turn = await startMutatingTurn(release.promise);
		const safety = setTimeout(() => release.resolve(), 10_000);
		safety.unref?.();
		try {
			expect(turn.live.pendingToolExecutions(turn.handle)).toEqual([TOOL_CALL_ID]);

			// The tool is never released inside the grace, so the wait must give up.
			const startedAt = Date.now();
			const boundary = await waitForToolCallBoundary({
				pending: () => turn.live.pendingToolExecutions(turn.handle),
				whenIdle: () => new Promise<void>(() => {}),
				graceMs: TEST_GRACE_MS,
			});
			const waitedMs = Date.now() - startedAt;
			expect(boundary.outcome).toBe("forced");
			expect(boundary.pendingToolCallIds).toEqual([TOOL_CALL_ID]);
			// The UPPER bound: the force lands WITHIN the grace, not "eventually".
			expect(waitedMs).toBeGreaterThanOrEqual(TEST_GRACE_MS - 50);
			expect(waitedMs).toBeLessThan(TEST_GRACE_MS + 2_000);

			// Forcing aborts THROUGH the still-running tool, which is the documented,
			// bounded cost of a tool that will not come back. Release only once the
			// abort has actually reached the call, so the observation is the forced
			// path rather than a race with it.
			const proof = turn.live.abortPromptAndWait(turn.handle, { graceMs: 2_000 });
			await waitUntil(() => turn.state.toolSignal?.aborted === true, "the abort to reach the running tool");
			release.resolve();
			await proof;
			expect(turn.observations).toEqual([{ abortedMidWrite: true }]);

			await turn.prompt.catch(() => undefined);
			await turn.live.waitForIdle();
			expect(turn.live.pendingToolExecutions(turn.handle)).toEqual([]);
			expect(turn.finalFrames).toHaveLength(1);
		} finally {
			clearTimeout(safety);
			release.resolve();
			await turn.prompt.catch(() => undefined);
		}
	}, 30_000);
});
