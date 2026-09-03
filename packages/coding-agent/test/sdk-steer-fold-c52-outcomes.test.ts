/**
 * C52 outcome red team.
 *
 * `bash.background` must distinguish a fold that just succeeded from a running
 * wait that was already folded for any reason, and from a session with no live
 * Bash wait. Exercise the public AgentSession outcome API against real
 * manager-owned Bash jobs rather than a FoldCoordinator double.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createMockModel, type MockResponse, registerMockApi } from "@gajae-code/ai/providers/mock";
import { TempDir } from "@gajae-code/utils";
import { AsyncJobManager } from "../src/async";
import { Settings } from "../src/config/settings";
import type { ExtensionContextActions, ExtensionUIContext } from "../src/extensibility/extensions/types";
import { ExtensionUiController } from "../src/modes/controllers/extension-ui-controller";
import { initializeExtensions } from "../src/modes/runtime-init";
import type { InteractiveModeContext } from "../src/modes/types";
import { type CreateAgentSessionResult, createAgentSession } from "../src/sdk";
import { OPERATIONS } from "../src/sdk/protocol/operation-registry";
import type { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { bashBackgroundControlError } from "../src/session/fold-coordinator";
import { SessionManager } from "../src/session/session-manager";

interface LiveScenario {
	created: CreateAgentSessionResult;
	authStorage: AuthStorage;
	tempDir: TempDir;
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("Timed out waiting for C52 outcome state");
}

type SdkControl = NonNullable<ExtensionContextActions["sdkControl"]>;

/**
 * Capture the REAL C52 dispatcher of the named surface by initializing it
 * against `session` with a stub runner, exactly as production does, and
 * returning its `sdkControl` action.
 */
async function captureSdkControl(
	dispatcher: "runtime-init" | "extension-ui-controller",
	session: AgentSession,
): Promise<SdkControl> {
	let captured: ExtensionContextActions | undefined;
	const runner = {
		initialize(_actions: unknown, actions: ExtensionContextActions): void {
			captured = actions;
		},
		onError: () => {},
		emit: async () => undefined,
	};
	// `#private` fields require the real receiver, so forward through a proxy
	// that binds methods to the live session and overrides only the runner.
	const target = new Proxy(session, {
		get(receiver, property) {
			if (property === "extensionRunner") return runner;
			const value = Reflect.get(receiver, property, receiver);
			return typeof value === "function" ? value.bind(receiver) : value;
		},
	});
	if (dispatcher === "runtime-init") {
		await initializeExtensions(target, { reportSendError: () => {}, reportRuntimeError: () => {} });
	} else {
		const controller = new ExtensionUiController({ session: target } as unknown as InteractiveModeContext);
		controller.initializeHookRunner({} as ExtensionUIContext, false);
	}
	const sdkControl = captured?.sdkControl;
	if (!sdkControl) throw new Error(`${dispatcher} did not expose sdkControl`);
	return sdkControl;
}

async function createScenario(options: { autoBackground?: boolean; thresholdMs?: number } = {}): Promise<LiveScenario> {
	const tempDir = TempDir.createSync("@gjc-steer-fold-c52-");
	registerMockApi();
	const authStorage = await AuthStorage.create(`${tempDir.path()}/auth.db`);
	const responses: MockResponse[] = [
		{
			content: [
				{
					type: "toolCall",
					name: "bash",
					arguments: { command: "sleep 2; printf 'c52 complete\n'", timeout: 30 },
				},
			],
		},
		{ content: ["background handoff acknowledged"] },
	];
	const mock = createMockModel({
		handler: () => responses.shift() ?? { content: ["background completion acknowledged"] },
	});
	authStorage.setRuntimeApiKey(mock.model.provider, "test-key");
	const created = await createAgentSession({
		cwd: tempDir.path(),
		agentDir: tempDir.path(),
		sessionManager: SessionManager.inMemory(tempDir.path()),
		authStorage,
		settings: Settings.isolated({
			"async.enabled": true,
			"bash.autoBackground.enabled": options.autoBackground ?? false,
			...(options.thresholdMs === undefined ? {} : { "bash.autoBackground.thresholdMs": options.thresholdMs }),
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
	return { created, authStorage, tempDir };
}

describe("C52 bash.background outcomes after prior folds", () => {
	const scenarios: LiveScenario[] = [];

	afterEach(async () => {
		const retired = scenarios.splice(0);
		await Promise.all(
			retired.map(async scenario => {
				await scenario.created.session.dispose();
				scenario.authStorage.close();
				scenario.tempDir.removeSync();
			}),
		);
		AsyncJobManager.resetForTests();
	});

	test("reports already_backgrounded after chord, sdk_control, and timer folds; reports no_active_bash without a live wait", async () => {
		const chord = await createScenario();
		scenarios.push(chord);
		const chordRun = chord.created.session.prompt("start a command for chord folding");
		await waitFor(() => chord.created.session.hasForegroundBashBackgroundRequestHandler());
		const chordFold = await chord.created.session.requestForegroundBashBackgroundOutcome("chord");
		expect(chordFold.status).toBe("folded");
		await chordRun;
		expect(await chord.created.session.requestForegroundBashBackgroundOutcome("sdk_control")).toEqual({
			status: "already_backgrounded",
		});

		const sdkControl = await createScenario();
		scenarios.push(sdkControl);
		const sdkControlRun = sdkControl.created.session.prompt("start a command for SDK folding");
		await waitFor(() => sdkControl.created.session.hasForegroundBashBackgroundRequestHandler());
		const sdkControlFold = await sdkControl.created.session.requestForegroundBashBackgroundOutcome("sdk_control");
		expect(sdkControlFold.status).toBe("folded");
		await sdkControlRun;
		expect(await sdkControl.created.session.requestForegroundBashBackgroundOutcome("sdk_control")).toEqual({
			status: "already_backgrounded",
		});

		const timer = await createScenario({ autoBackground: true, thresholdMs: 25 });
		scenarios.push(timer);
		const timerRun = timer.created.session.prompt("start a command for timer folding");
		await waitFor(
			() =>
				timer.created.session
					.getAsyncJobSnapshot()
					?.running.some(job => job.metadata?.backgrounded === true && job.metadata?.foldReason === "timer") ??
				false,
		);
		await timerRun;
		expect(await timer.created.session.requestForegroundBashBackgroundOutcome("sdk_control")).toEqual({
			status: "already_backgrounded",
		});

		const idle = await createScenario();
		scenarios.push(idle);
		expect(await idle.created.session.requestForegroundBashBackgroundOutcome("sdk_control")).toEqual({
			status: "no_active_bash",
		});
		await Promise.all(
			[chord, sdkControl, timer].map(scenario =>
				waitFor(() => (scenario.created.session.getAsyncJobSnapshot()?.running.length ?? 0) === 0, 5_000),
			),
		);
	}, 30_000);

	test("the public C52 contract maps every non-folded outcome to its declared error code", () => {
		expect(bashBackgroundControlError({ status: "already_backgrounded" })).toMatchObject({
			code: "already_backgrounded",
		});
		expect(bashBackgroundControlError({ status: "no_active_bash" })).toMatchObject({ code: "no_active_bash" });
		expect(bashBackgroundControlError({ status: "not_foldable", reason: "the wait settled" })).toMatchObject({
			code: "not_foldable",
			message: expect.stringContaining("the wait settled"),
		});
		const declared = OPERATIONS.find(operation => operation.sdkId === "bash.background")?.errorCodes ?? [];
		expect(new Set(declared)).toEqual(new Set(["not_foldable", "already_backgrounded", "no_active_bash"]));
	});

	for (const dispatcher of ["runtime-init", "extension-ui-controller"] as const) {
		test(`bash.background through the ${dispatcher} dispatcher returns { backgrounded, jobId } on a fresh fold, then already_backgrounded, then no_active_bash`, async () => {
			const scenario = await createScenario();
			scenarios.push(scenario);
			const { session } = scenario.created;
			const sdkControl = await captureSdkControl(dispatcher, session);

			await expect(sdkControl("bash.background", {})).rejects.toMatchObject({ code: "no_active_bash" });

			const run = session.prompt("start a command for a control probe");
			await waitFor(() => session.hasForegroundBashBackgroundRequestHandler());
			expect(await sdkControl("bash.background", {})).toEqual({
				backgrounded: true,
				jobId: expect.stringMatching(/^bg_\d+$/),
			});
			await run;
			await expect(sdkControl("bash.background", {})).rejects.toMatchObject({ code: "already_backgrounded" });

			await waitFor(() => (session.getAsyncJobSnapshot()?.running.length ?? 0) === 0, 5_000);
			await expect(sdkControl("bash.background", {})).rejects.toMatchObject({ code: "no_active_bash" });
		}, 20_000);
	}
});
