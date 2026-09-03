/**
 * Steer-triggered bash fold through a REAL AgentSession.
 *
 * The model issues a bash call; the user steers through the production
 * `session.steer()` path after the grace window. The tool result must be the
 * fold result with the steer reason line, the SAME run must consume the steer
 * at the tool boundary (a second model call sees it), remaining tools in the
 * batch must be skipped, the job must keep running under its original
 * deadline, and its completion must wake a later turn with the fold receipt.
 * The SDK `bash.background` control must then report `already_backgrounded`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createMockModel, registerMockApi } from "@gajae-code/ai/providers/mock";
import { TempDir } from "@gajae-code/utils";
import { AsyncJobManager } from "../src/async";
import { Settings } from "../src/config/settings";
import { type CreateAgentSessionResult, createAgentSession } from "../src/sdk";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { STEER_FOLD_GRACE_MS, steerFoldReasonLine } from "../src/tools/bash";

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("Timed out waiting for live steer-fold state");
}

function messagesText(messages: unknown): string {
	return JSON.stringify(messages);
}

describe("live session steer fold", () => {
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
	});

	test("a post-grace steer folds the model's bash call, the same run consumes the steer, and completion wakes a later turn", async () => {
		tempDir = TempDir.createSync("@gjc-steer-fold-live-");
		registerMockApi();
		authStorage = await AuthStorage.create(`${tempDir.path()}/auth.db`);
		// Turn 1: two parallel tool calls — the long bash and a sibling that must be
		// skipped once the steer is consumed. Turn 2 (same run, after the steer):
		// acknowledge. Turn 3 (wake): the folded job's receipt arrives.
		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							name: "bash",
							arguments: { command: "printf 'live-start\\n'; sleep 5; printf 'live-done\\n'", timeout: 30 },
						},
						{ type: "toolCall", name: "bash", arguments: { command: "printf 'sibling-ran\\n'" } },
					],
				},
				{ content: ["steer acknowledged"] },
				{ content: ["wake complete"] },
			],
		});
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
				busyPromptMode: "steer",
			}),
			model: mock.model,
			toolNames: ["bash"],
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
		const { session } = created;
		const stopReasons: string[] = [];
		const toolResults: string[] = [];
		const unsubscribe = session.subscribe(event => {
			if (event.type === "agent_end") stopReasons.push(String(event.stopReason));
			if (event.type === "tool_execution_end") toolResults.push(JSON.stringify(event.result));
		});

		try {
			const run = session.prompt("run the long command");
			await waitFor(() => session.hasForegroundBashBackgroundRequestHandler());
			await Bun.sleep(STEER_FOLD_GRACE_MS + 150);
			await session.steer("please handle this now");
			await run;
			const callsAfterSteerRun = mock.calls.length;

			// The tool boundary returned a steer-fold result, not the command output.
			const foldResult = toolResults.find(text => text.includes("Folded into background job"));
			expect(foldResult).toBeDefined();
			const jobId = /background job (bg_\d+)/.exec(foldResult ?? "")?.[1];
			if (!jobId) throw new Error(`expected a background job id in ${foldResult}`);
			expect(foldResult).toContain(steerFoldReasonLine(jobId));
			// The preview is a best-effort snapshot and may end at any chunk boundary;
			// post-fold output must appear only in the eventual completion receipt.
			const foldText = (JSON.parse(foldResult!) as { content: Array<{ text: string }> }).content[0]!.text;
			const preview = foldText.slice(0, foldText.indexOf("Background job "));
			expect(preview).not.toContain("live-done");

			// The SAME run consumed the steer at the tool boundary: it reached a model
			// call while the folded job was still running, and the sibling tool call
			// in the interrupted batch was skipped.
			const steerCall = mock.calls.find(call =>
				messagesText(call.context.messages).includes("please handle this now"),
			);
			expect(steerCall).toBeDefined();
			expect(toolResults.some(text => text.includes("sibling-ran"))).toBe(false);
			// Stop-after-result is the chord fold's exit; a steer fold does not pause the turn.
			expect(stopReasons).not.toContain("paused");
			expect(stopReasons).not.toContain("aborted");

			// The job kept running under its original deadline with a steer reason.
			const manager = session.getAsyncJobSnapshot();
			const foldedJob = [...(manager?.running ?? []), ...(manager?.recent ?? [])].find(job => job.id === jobId);
			expect(foldedJob?.metadata).toMatchObject({ backgrounded: true, foldReason: "steer" });
			// Under a loaded test host the command may finish before this
			// assertion runs; either state is valid, but the same registered job must
			// carry the fold metadata rather than a restarted replacement.
			expect(foldedJob?.status === "running" || foldedJob?.status === "completed").toBe(true);

			// C52 after a steer fold: nothing is foldable, but the wait already left
			// the foreground. A still-running job reports already_backgrounded; if
			// it completed while the loaded test host was asserting, no_active_bash is
			// the correct current-state answer.
			expect(await session.requestForegroundBashBackgroundOutcome("sdk_control")).toEqual(
				foldedJob?.status === "running" ? { status: "already_backgrounded" } : { status: "no_active_bash" },
			);

			// Completion wakes a later turn with the receipt.
			await waitFor(() => session.getAsyncJobSnapshot()?.running.some(job => job.id === jobId) === false, 15_000);
			// The session's idle scheduler may flush before this observer gets CPU. If
			// the receipt is still queued, drive that same production flush explicitly;
			// otherwise observe the already-started wake turn.
			if (session.yieldQueue.has("async-result")) await session.yieldQueue.flush("idle");
			await waitFor(() => mock.calls.length > callsAfterSteerRun);
			expect(mock.calls.length).toBe(callsAfterSteerRun + 1);
			const wakeMessages = messagesText(mock.calls[mock.calls.length - 1]?.context.messages);
			expect(wakeMessages).toContain("live-done");
			expect(wakeMessages).toContain("folded bash-managed wait");
		} finally {
			unsubscribe();
		}
	}, 30_000);
});
