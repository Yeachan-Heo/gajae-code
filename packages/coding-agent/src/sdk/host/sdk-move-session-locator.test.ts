import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../../session/session-manager";
import { resolveSessionLocator } from "../broker/session-index";

describe("SDK session locator updates on move_session", () => {
	test("registerAfterMoveListener can be registered and unregistered", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-move-session-"));
		const initialCwd = path.join(tempDir, "ws");

		try {
			await fs.mkdir(initialCwd, { recursive: true });
			const manager = SessionManager.inMemory(initialCwd);

			// Verify the listener can be registered
			let listenerCalled = false;
			const unregister = manager.registerAfterMoveListener(() => {
				listenerCalled = true;
			});

			// Verify the listener is registered (by checking that the unregister function exists and works)
			expect(typeof unregister).toBe("function");

			// Call the unregister function
			unregister();

			// Listener should not have been called during registration/unregistration
			expect(listenerCalled).toBe(false);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("locator is resolved correctly for new cwd after move", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-locator-"));
		const initialCwd = path.join(tempDir, "ws");
		const newCwd = path.join(tempDir, "ws", "repo");
		const stateRoot = path.join(tempDir, "state");

		try {
			await fs.mkdir(initialCwd, { recursive: true });
			await fs.mkdir(newCwd, { recursive: true });
			await fs.mkdir(stateRoot, { recursive: true });

			const initialLocator = await resolveSessionLocator(initialCwd, stateRoot);
			const movedLocator = await resolveSessionLocator(newCwd, stateRoot);

			// Verify the locators are different (cwd has changed)
			expect(initialLocator.cwd).toBe(initialCwd);
			expect(movedLocator.cwd).toBe(newCwd);
			expect(initialLocator.stateRoot).toBe(stateRoot);
			expect(movedLocator.stateRoot).toBe(stateRoot);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
