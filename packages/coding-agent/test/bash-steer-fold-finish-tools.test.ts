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

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("timeout");
}

/**
 * Regression for the real dogfood failure: with `toolInterruptPolicy:
 * finish_tools` (the user's global config), a composer steer over a long
 * foreground bash was ABORTED instead of folded. `finish_tools` means "do not
 * kill the batch to deliver a steer"; a fold kills nothing, so it must apply
 * under both policies. This drives the real InteractiveMode composer, then the
 * empty second Enter the user pressed, and asserts nothing was aborted.
 */
describe("steer fold under toolInterruptPolicy=finish_tools", () => {
	let created: CreateAgentSessionResult | undefined;
	let authStorage: AuthStorage | undefined;
	let tempDir: TempDir | undefined;
	let mode: InteractiveMode | undefined;

	beforeAll(() => initTheme());
	beforeEach(() => resetSettingsForTest());
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

	test("a composer steer folds the foreground bash and a second empty Enter has nothing left to abort", async () => {
		tempDir = TempDir.createSync("@gjc-repro-abort-");
		await Settings.init({ inMemory: true, cwd: tempDir.path(), overrides: { "starReminder.enabled": false } });
		registerMockApi();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const mock = createMockModel({
			responses: [
				{
					content: [
						"Adjusting long sleep timeout and output behavior",
						{
							type: "toolCall",
							name: "bash",
							arguments: {
								command:
									"printf 'foreground sleep started\\n'; sleep 120; printf 'foreground sleep finished\\n'",
								timeout: 180,
							},
						},
					],
				},
				{ content: ["reply after steer"] },
				{ content: ["wake"] },
			],
		});
		authStorage.setRuntimeApiKey(mock.model.provider, "test-key");
		// The user's global config: toolInterruptPolicy=finish_tools. Everything else default.
		created = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			authStorage,
			settings: Settings.isolated({ "compaction.enabled": false, toolInterruptPolicy: "finish_tools" }),
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

		const results: string[] = [];
		const stopReasons: string[] = [];
		const unsub = session.subscribe(e => {
			if (e.type === "tool_execution_end") results.push(JSON.stringify(e.result));
			if (e.type === "agent_end") stopReasons.push(String((e as { stopReason?: unknown }).stopReason));
		});

		try {
			const run = session.prompt("run it");
			await waitFor(() => session.hasForegroundBashBackgroundRequestHandler());
			await Bun.sleep(8_000);

			const callsBeforeSteer = mock.calls.length;
			mode.editor.setText("hello");
			await mode.editor.onSubmit?.("hello");
			await Bun.sleep(2_000);
			// Second Enter on an empty composer (what the user did).
			mode.editor.setText("");
			await mode.editor.onSubmit?.("");

			// The run must end normally: a rejection here (abort) is the bug.
			await run;

			const folded = session.getAsyncJobSnapshot()?.running.find(j => j.metadata?.foldReason === "steer");
			expect(folded).toBeDefined();
			expect(folded?.status).toBe("running");
			expect(results.some(r => r.includes("Tool execution was aborted"))).toBe(false);
			expect(results.some(r => r.includes("Folded into background job"))).toBe(true);
			// The SAME run consumed the steer: one more model call carrying "hello",
			// and its reply reached the transcript before the run ended.
			expect(mock.calls.length).toBe(callsBeforeSteer + 1);
			expect(JSON.stringify(mock.calls[mock.calls.length - 1]?.context.messages)).toContain("hello");
			expect(JSON.stringify(session.messages)).toContain("reply after steer");
			// Nothing drainable remained for the empty Enter to abort, and exactly
			// one turn ended, normally.
			expect(session.drainableQueuedMessageCount).toBe(0);
			expect(stopReasons).toEqual(["completed"]);
		} finally {
			unsub();
		}
	}, 60_000);
});
