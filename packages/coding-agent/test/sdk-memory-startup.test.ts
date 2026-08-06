import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { localBackend } from "@gajae-code/coding-agent/memory-backend/local-backend";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";

const createdDirs = new Set<string>();

describe("createAgentSession memory startup", () => {
	let authStorage: AuthStorage;

	beforeEach(async () => {
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		authStorage.close();
		for (const dir of createdDirs) {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
		createdDirs.clear();
	});

	test("defers memory startup until startup model profiles have settled", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-memory-startup-"));
		createdDirs.add(cwd);
		const modelRegistry = new ModelRegistry(authStorage);
		const settings = Settings.isolated({ "memory.backend": "local" });
		const startSpy = vi.spyOn(localBackend, "start").mockImplementation(() => {});

		const { session, startDeferredMemoryBackend } = await createAgentSession({
			cwd,
			agentDir: cwd,
			authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			toolNames: [],
			deferMemoryBackendStartup: true,
		});

		try {
			expect(startSpy).not.toHaveBeenCalled();
			expect(startDeferredMemoryBackend).toBeFunction();

			await startDeferredMemoryBackend?.();
			expect(startSpy).toHaveBeenCalledTimes(1);
			expect(startSpy.mock.calls[0]?.[0].session).toBe(session);

			await startDeferredMemoryBackend?.();
			expect(startSpy).toHaveBeenCalledTimes(1);
		} finally {
			await session.dispose();
		}
	}, 30_000);
});
