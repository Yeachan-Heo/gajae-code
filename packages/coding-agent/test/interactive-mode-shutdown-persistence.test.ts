import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { postmortem, TempDir } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { initTheme } from "../src/modes/theme/theme";
import { AgentSession, SessionDisposalIncompleteError } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

describe("interactive shutdown persistence", () => {
	let tempDir: TempDir;
	let auth: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => initTheme());
	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("gjc-shutdown-persistence-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		auth = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const registry = new ModelRegistry(auth, path.join(tempDir.path(), "models.json"));
		session = new AgentSession({
			agent: new Agent({ initialState: { tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry: registry,
		});
		mode = new InteractiveMode(session, "test");
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		auth?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	test("restores terminal and exits nonzero when bounded disposal cannot finish persistence", async () => {
		const events: string[] = [];
		vi.spyOn(session, "dispose").mockRejectedValue(
			new SessionDisposalIncompleteError("unbarriered coordinator persistence"),
		);
		const drain = vi.spyOn(mode.ui.terminal, "drainInput").mockImplementation(async () => {
			events.push("drain");
		});
		const stop = vi.spyOn(mode, "stop").mockImplementation(() => {
			events.push("stop");
		});
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const quit = vi.spyOn(postmortem, "quit").mockImplementation(async () => {
			events.push("quit");
		});

		await expect(mode.shutdown()).resolves.toBeUndefined();
		expect(drain).toHaveBeenCalledWith(1000);
		expect(stop).toHaveBeenCalledTimes(1);
		expect(events).toEqual(["drain", "stop", "quit"]);
		expect(quit).toHaveBeenCalledWith(1);
		const output = stderr.mock.calls.map(call => String(call[0])).join("");
		expect(output).toContain("Shutdown incomplete:");
		expect(output).toContain("unbarriered coordinator persistence");
		expect(output).toContain("Pending state may not be saved.");
	});

	test("successful disposal retains clean exit without persistence warning", async () => {
		vi.spyOn(session, "dispose").mockResolvedValue();
		vi.spyOn(mode.ui.terminal, "drainInput").mockResolvedValue();
		vi.spyOn(mode, "stop").mockImplementation(() => {});
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const quit = vi.spyOn(postmortem, "quit").mockResolvedValue();
		await mode.shutdown();
		expect(quit).toHaveBeenCalledWith(0);
		expect(stderr.mock.calls.map(call => String(call[0])).join("")).not.toContain("Shutdown incomplete:");
	});
});
