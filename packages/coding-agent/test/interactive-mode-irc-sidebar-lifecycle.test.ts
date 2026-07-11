import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { TempDir } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { IrcSplitViewComponent } from "../src/modes/components/irc-sidebar";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

function getSplitView(mode: InteractiveMode): IrcSplitViewComponent {
	const split = mode.ui.children.find(
		(child): child is IrcSplitViewComponent => child instanceof IrcSplitViewComponent,
	);
	if (!split) throw new Error("IRC split view component is not registered on the TUI");
	return split;
}

describe("InteractiveMode IRC sidebar startup/reset lifecycle", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-irc-lifecycle-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		}

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("syncs availability at startup so the toggle opens the split with no live settings change", async () => {
		// Persisted settings (as if restored from a prior session), both enabled.
		mode.settings.set("irc.enabled", true);
		mode.settings.set("irc.sidebar.enabled", true);

		// init() must sync availability from persisted settings — no live setter fires.
		await mode.init();
		const split = getSplitView(mode);
		expect(split.visible).toBe(false); // enabled-but-closed

		// Without the startup sync this toggle is inert (the "inert Alt+I" regression).
		mode.toggleIrcSidebar();
		expect(split.visible).toBe(true);

		// A session reset (fork / handoff / new) closes the split...
		mode.resetIrcSidebarSession();
		expect(split.visible).toBe(false);

		// ...and its availability re-sync keeps the toggle live afterward, again with
		// no live settings change.
		mode.toggleIrcSidebar();
		expect(split.visible).toBe(true);
	});

	it("re-derives availability on reset after a settings change with no live callback", async () => {
		// Start disabled so the startup sync leaves the sidebar unavailable.
		mode.settings.set("irc.enabled", true);
		mode.settings.set("irc.sidebar.enabled", false);
		await mode.init();
		const split = getSplitView(mode);

		mode.toggleIrcSidebar();
		expect(split.visible).toBe(false); // inert while disabled

		// Enable the setting WITHOUT the live selector callback: availability is now
		// stale-false even though both predicates read true.
		mode.settings.set("irc.sidebar.enabled", true);
		mode.toggleIrcSidebar();
		expect(split.visible).toBe(false); // still inert until a sync runs

		// resetIrcSidebarSession() re-derives availability from current settings; drop
		// its sync and the toggle stays inert here.
		mode.resetIrcSidebarSession();
		mode.toggleIrcSidebar();
		expect(split.visible).toBe(true);
	});

	const disabledCombinations: Array<{ ircEnabled: boolean; sidebarEnabled: boolean }> = [
		{ ircEnabled: true, sidebarEnabled: false },
		{ ircEnabled: false, sidebarEnabled: true },
		{ ircEnabled: false, sidebarEnabled: false },
	];
	for (const { ircEnabled, sidebarEnabled } of disabledCombinations) {
		it(`keeps the split unavailable and the toggle inert (irc.enabled=${ircEnabled}, irc.sidebar.enabled=${sidebarEnabled})`, async () => {
			mode.settings.set("irc.enabled", ircEnabled);
			mode.settings.set("irc.sidebar.enabled", sidebarEnabled);
			await mode.init();
			const split = getSplitView(mode);

			expect(split.visible).toBe(false);
			mode.toggleIrcSidebar();
			expect(split.visible).toBe(false);

			// A reset must not resurrect an unavailable sidebar either.
			mode.resetIrcSidebarSession();
			mode.toggleIrcSidebar();
			expect(split.visible).toBe(false);
		});
	}
});
