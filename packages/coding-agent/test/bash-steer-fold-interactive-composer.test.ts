import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@gajae-code/ai/providers/mock";
import { TempDir } from "@gajae-code/utils";
import { AsyncJobManager } from "../src/async";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { initTheme } from "../src/modes/theme/theme";
import { type CreateAgentSessionResult, createAgentSession } from "../src/sdk";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { STEER_FOLD_GRACE_MS } from "../src/tools/bash";

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("timeout");
}

/**
 * The interactive composer is the surface users actually steer from, and it is
 * NOT the SDK `session.steer()` seam: pressing Enter while streaming routes
 * through InputController.submitText -> session.prompt(text, { streamingBehavior:
 * "steer" }) -> #queueSteer -> agent.steer(). This test drives that exact path
 * against a real InteractiveMode over a real foreground bash so a regression in
 * the composer wiring (missing fold seams, wrong streaming behavior, a steer
 * that never reaches the tool boundary) cannot hide behind the SDK-level tests.
 */
describe("interactive composer steer over a foreground bash", () => {
	let created: CreateAgentSessionResult | undefined;
	let authStorage: AuthStorage | undefined;
	let tempDir: TempDir | undefined;
	let mode: InteractiveMode | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(async () => {
		mode?.stop();
		await created?.session.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		created = undefined;
		mode = undefined;
		AsyncJobManager.resetForTests();
		resetSettingsForTest();
	});

	test("composer Enter while a foreground bash runs folds it and the steer is consumed by the same run", async () => {
		tempDir = TempDir.createSync("@gjc-repro-tui-steer-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		registerMockApi();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							name: "bash",
							arguments: { command: "printf 'start\\n'; sleep 8; printf 'done\\n'", timeout: 60 },
						},
					],
				},
				{ content: ["steer acknowledged"] },
				{ content: ["wake"] },
			],
		});
		authStorage.setRuntimeApiKey(mock.model.provider, "test-key");
		created = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			authStorage,
			settings: Settings.isolated({
				"async.enabled": true,
				"bash.autoBackground.enabled": false,
				"compaction.enabled": false,
				busyPromptMode: "steer",
				toolInterruptPolicy: "abort_tools",
			}),
			model: mock.model,
			toolNames: ["bash"],
			hasUI: true,
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
		mode = new InteractiveMode(session, "test");
		await mode.init();

		const run = session.prompt("run the long command");
		await waitFor(() => session.hasForegroundBashBackgroundRequestHandler());
		await Bun.sleep(STEER_FOLD_GRACE_MS + 250);
		const callsBefore = mock.calls.length;

		// EXACTLY what pressing Enter in the composer does.
		mode.editor.setText("please handle this now");
		await mode.editor.onSubmit?.("please handle this now");

		// The same run must consume the steer at the tool boundary the fold created.
		await waitFor(() =>
			mock.calls.some(call => JSON.stringify(call.context.messages).includes("please handle this now")),
		);

		// The command left the foreground as a steer fold and is still running.
		const folded = session.getAsyncJobSnapshot()?.running.find(job => job.metadata?.foldReason === "steer");
		expect(folded).toBeDefined();
		expect(folded?.status).toBe("running");
		// Consumed, not merely queued: nothing is left for Esc or an empty submit to drain.
		expect(mock.calls.length).toBe(callsBefore + 1);
		expect(session.drainableQueuedMessageCount).toBe(0);
		expect(session.agent.hasQueuedSteering()).toBe(false);
		await run.catch(() => undefined);
	}, 60_000);
});
