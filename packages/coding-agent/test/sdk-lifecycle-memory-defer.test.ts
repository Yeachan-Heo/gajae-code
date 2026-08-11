import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { localBackend } from "@gajae-code/coding-agent/memory-backend/local-backend";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { logger } from "@gajae-code/utils";
import { startMemoryBackendAfterReadiness } from "../src/commands/sdk";
import { createLifecycleAgentSession } from "../src/sdk/lifecycle-session";

const createdDirs = new Set<string>();

describe("lifecycle session memory startup", () => {
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

	// The broker kills a lifecycle child that misses its readiness deadline, and
	// local memory startup summarises every queued rollout through the model, so
	// construction must never reach the backend.
	test("never starts the memory backend while building the session", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lifecycle-memory-"));
		createdDirs.add(cwd);
		const startSpy = vi.spyOn(localBackend, "start").mockImplementation(() => {});

		const created = await createLifecycleAgentSession({
			cwd,
			agentDir: cwd,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "memory.backend": "local" }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			toolNames: [],
		});

		if ("failure" in created) throw new Error(`Lifecycle session construction failed: ${created.failure.message}`);
		try {
			expect(startSpy).not.toHaveBeenCalled();

			// The post-readiness resume must reach the same backend, exactly once.
			await created.startDeferredMemoryBackend();
			expect(startSpy).toHaveBeenCalledTimes(1);
			expect(startSpy.mock.calls[0]?.[0].session).toBe(created.session);

			await created.startDeferredMemoryBackend();
			expect(startSpy).toHaveBeenCalledTimes(1);
		} finally {
			await created.session.dispose();
		}
	}, 30_000);
});

describe("startMemoryBackendAfterReadiness", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("returns before the memory backend has started", async () => {
		const started = Promise.withResolvers<void>();
		let resolved = false;
		startMemoryBackendAfterReadiness(async () => {
			await started.promise;
			resolved = true;
		});

		// Readiness is already published: the caller must not be blocked here.
		await Bun.sleep(1);
		expect(resolved).toBe(false);
		started.resolve();
		await Bun.sleep(1);
		expect(resolved).toBe(true);
	});

	test("logs a failed startup instead of rejecting the session", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onRejection);
		try {
			startMemoryBackendAfterReadiness(async () => {
				throw new Error("phase1 stage1 job failed");
			});
			await Bun.sleep(1);
		} finally {
			process.off("unhandledRejection", onRejection);
		}

		expect(rejections).toHaveLength(0);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toBe("Deferred memory backend startup failed after readiness");
		expect(String(warn.mock.calls[0]?.[1]?.error)).toContain("phase1 stage1 job failed");
	});
});
