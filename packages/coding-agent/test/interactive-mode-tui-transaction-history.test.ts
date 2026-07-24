import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import { TUI } from "@gajae-code/tui";
import { TempDir } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { AuthStorage } from "../src/session/auth-storage";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { initTheme } from "../src/modes/theme/theme";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";

// This test intentionally uses the real InteractiveMode constructor: the production
// TUI is the ownership boundary for the observer callback.
describe("InteractiveMode TUI transaction history wiring", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode | undefined;
	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@tui-transaction-history-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(`${tempDir.path()}/testauth.db`);
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
	});

	afterEach(async () => {
		mode?.stop();
		mode = undefined;
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("routes shared metadata to the session sink and releases the observer on stop", () => {
		const observerSetter = vi.spyOn(TUI.prototype, "setTransactionObserver");
		mode = new InteractiveMode(session, "test");

		const installedObserver = observerSetter.mock.calls[0]?.[0];
		if (typeof installedObserver !== "function") throw new Error("InteractiveMode did not install a TUI observer");

		installedObserver({ classification: "shared", operation: "primary", bytes: "hé", outcome: "accepted" });
		installedObserver({ classification: "exempt", operation: "ime", bytes: "overlay", outcome: "accepted" });

		const snapshot = session.tuiTransactionHistory.snapshot();
		expect(snapshot.totalSharedObservations).toBe(1);
		expect(snapshot.records).toHaveLength(1);
		expect(snapshot.records[0]).toMatchObject({
			sessionId: session.sessionManager.getSessionId(),
			operation: "primary",
			outcome: "accepted",
			byteLength: 3,
		});
		expect(snapshot.records[0]).not.toHaveProperty("bytes");

		const petDispose = vi.fn();
		mode.petWidget = { dispose: petDispose } as never;
		mode.stop();
		expect(petDispose).toHaveBeenCalledTimes(1);
		expect(observerSetter).toHaveBeenLastCalledWith(undefined);
		mode = undefined;
	});
});
