import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { postmortem, TempDir } from "@gajae-code/utils";
import { ConfigHotReloadWatcher } from "../src/config/config-hot-reload";
import * as configHotReloadTrust from "../src/config/config-hot-reload-trust";
import { ModelRegistry } from "../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { initTheme } from "../src/modes/theme/theme";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for interactive configuration lifecycle");
		await Bun.sleep(5);
	}
}

describe("interactive configuration hot reload lifecycle", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;
	let mode: InteractiveMode;
	const pendingTrustReleases: Array<() => void> = [];
	const pendingShutdownReleases: Array<() => void> = [];

	beforeAll(() => initTheme());
	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@interactive-config-hot-reload-");
		await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides: { "starReminder.enabled": false, "startup.quiet": true, "pet.mode": "off" },
		});
		const configPath = path.join(tempDir.path(), "config.yml");
		const modelsPath = path.join(tempDir.path(), "models.yml");
		await Bun.write(
			configPath,
			"todo:\n  enabled: false\nstarReminder:\n  enabled: false\nstartup:\n  quiet: true\npet:\n  mode: off\n",
		);
		await Bun.write(modelsPath, "providers: {}\n");
		const settings = await Settings.loadForScope({ cwd: tempDir.path(), agentDir: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, modelsPath, settings, {
			agentDir: tempDir.path(),
			automaticRefresh: false,
		});
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		vi.spyOn(mode.ui, "start").mockImplementation(() => {});
		vi.spyOn(configHotReloadTrust, "isConfigHotReloadSupported").mockReturnValue(true);
	});

	afterEach(async () => {
		mode?.stop();
		for (const release of pendingTrustReleases.splice(0)) release();
		for (const release of pendingShutdownReleases.splice(0)) release();
		vi.restoreAllMocks();
		await session?.dispose();
		await modelRegistry?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	function pendingTrust(): PromiseWithResolvers<boolean> {
		const gate = Promise.withResolvers<boolean>();
		pendingTrustReleases.push(() => gate.resolve(true));
		return gate;
	}

	function pendingShutdown(): PromiseWithResolvers<void> {
		const gate = Promise.withResolvers<void>();
		pendingShutdownReleases.push(() => gate.resolve());
		return gate;
	}

	function stubShutdownPersistence(flush: Promise<void>) {
		vi.spyOn(session, "dispose").mockResolvedValue();
		const flushSpy = vi.spyOn(mode.sessionManager, "flush").mockImplementation(() => flush);
		vi.spyOn(mode.sessionManager, "saveDraft").mockResolvedValue();
		vi.spyOn(mode.ui.terminal, "drainInput").mockResolvedValue();
		vi.spyOn(postmortem, "quit").mockResolvedValue();
		return flushSpy;
	}

	it("skips watching without a warning on platforms that cannot verify directory privacy", async () => {
		vi.spyOn(configHotReloadTrust, "isConfigHotReloadSupported").mockReturnValue(false);
		const trust = vi.spyOn(configHotReloadTrust, "isConfigHotReloadTrusted");
		const watcherStart = vi.spyOn(ConfigHotReloadWatcher.prototype, "start");
		const showWarning = vi.spyOn(mode, "showWarning");

		await mode.init();

		expect(trust).not.toHaveBeenCalled();
		expect(watcherStart).not.toHaveBeenCalled();
		expect(showWarning).not.toHaveBeenCalledWith(expect.stringContaining("Configuration watching could not start"));
	});

	it("warns when a supported platform finds untrusted configuration directories", async () => {
		vi.spyOn(configHotReloadTrust, "isConfigHotReloadTrusted").mockResolvedValue(false);
		const watcherStart = vi.spyOn(ConfigHotReloadWatcher.prototype, "start");
		const showWarning = vi.spyOn(mode, "showWarning");

		await mode.init();

		expect(watcherStart).not.toHaveBeenCalled();
		expect(showWarning).toHaveBeenCalledWith(
			"Configuration watching could not start because directory ownership and privacy could not be verified.",
		);
	});

	it("does not start the watcher when stop wins during the trust check", async () => {
		const trustGate = pendingTrust();
		const trust = vi.spyOn(configHotReloadTrust, "isConfigHotReloadTrusted").mockReturnValue(trustGate.promise);
		const watcherStart = vi.spyOn(ConfigHotReloadWatcher.prototype, "start");
		const initializing = mode.init();
		await waitFor(() => trust.mock.calls.length === 1);

		mode.stop();
		trustGate.resolve(true);
		await initializing;

		expect(watcherStart).not.toHaveBeenCalled();
	});

	it("does not start the watcher when shutdown wins during the trust check", async () => {
		const trustGate = pendingTrust();
		const trust = vi.spyOn(configHotReloadTrust, "isConfigHotReloadTrusted").mockReturnValue(trustGate.promise);
		const watcherStart = vi.spyOn(ConfigHotReloadWatcher.prototype, "start");
		const initializing = mode.init();
		await waitFor(() => trust.mock.calls.length === 1);
		const shutdownGate = pendingShutdown();
		const flush = stubShutdownPersistence(shutdownGate.promise);

		const shuttingDown = mode.shutdown();
		await waitFor(() => flush.mock.calls.length === 1);
		trustGate.resolve(true);
		await initializing;

		shutdownGate.resolve();
		await shuttingDown;
		expect(watcherStart).not.toHaveBeenCalled();
	});

	// Production only watches on Linux; macOS fs.watch can drop an event written right after arming.
	it.skipIf(process.platform !== "linux")(
		"does not reload a candidate whose trust check finishes after shutdown",
		async () => {
			const candidateTrust = pendingTrust();
			let trustCalls = 0;
			vi.spyOn(configHotReloadTrust, "isConfigHotReloadTrusted").mockImplementation(() => {
				trustCalls++;
				return trustCalls === 3 ? candidateTrust.promise : Promise.resolve(true);
			});
			vi.spyOn(session, "validateConfiguration").mockResolvedValue();
			await mode.init();
			const reload = vi.spyOn(session, "reloadConfiguration");
			const configPath = session.settings.getGlobalConfigPath();
			if (!configPath) throw new Error("Expected a file-backed configuration path");

			await Bun.write(configPath, "todo:\n  enabled: true\n");
			await waitFor(() => trustCalls === 3);
			const shutdownGate = pendingShutdown();
			const flush = stubShutdownPersistence(shutdownGate.promise);
			const shuttingDown = mode.shutdown();
			await waitFor(() => flush.mock.calls.length === 1);

			candidateTrust.resolve(true);
			await Bun.sleep(0);
			shutdownGate.resolve();
			await shuttingDown;
			expect(reload).not.toHaveBeenCalled();
		},
	);
});
