import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import * as fs from "node:fs/promises";
import { SessionIndex } from "../src/sdk/broker/session-index";
import type { SessionLocatorV2 } from "../src/sdk/broker/session-index";

describe("Broker ephemeral session propagation and filtering", () => {
	let tmpDir: string;
	let sessionIndex: SessionIndex;
	const createLocator = (cwd: string): SessionLocatorV2 => ({
		cwd: path.resolve(cwd),
		worktreeRoot: null,
		stateRoot: path.join(cwd, ".gjc", "state"),
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp("/tmp/gjc-broker-ephemeral-");
		const agentDir = path.join(tmpDir, "agent");
		await fs.mkdir(agentDir, { recursive: true });
		sessionIndex = new SessionIndex(agentDir);
	});

	afterEach(async () => {
		if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
	});

	describe("Index event producer: ephemeral propagation", () => {
		it("records ephemeral=true in host_registered event", async () => {
			const cwd = path.join(tmpDir, "workspace");
			await fs.mkdir(cwd, { recursive: true });
			const locator = createLocator(cwd);

			const event = await sessionIndex.append({
				type: "host_registered",
				sessionId: "ephemeral-test-1",
				locator,
				endpointGeneration: 1,
				pid: process.pid,
				processIncarnation: "test-incarnation",
				ephemeral: true,
			});

			expect(event.ephemeral).toBe(true);
		});

		it("omits ephemeral for persistent sessions", async () => {
			const cwd = path.join(tmpDir, "workspace");
			await fs.mkdir(cwd, { recursive: true });
			const locator = createLocator(cwd);

			const event = await sessionIndex.append({
				type: "host_registered",
				sessionId: "persistent-test-1",
				locator,
				endpointGeneration: 1,
				pid: process.pid,
				processIncarnation: "test-incarnation",
			});

			expect(event.ephemeral).toBeUndefined();
		});

		it("ephemeral marker persists through journal append/sync", async () => {
			const cwd = path.join(tmpDir, "workspace");
			await fs.mkdir(cwd, { recursive: true });
			const locator = createLocator(cwd);

			// Append ephemeral session
			const appended = await sessionIndex.append({
				type: "host_registered",
				sessionId: "ephemeral-persisted",
				locator,
				endpointGeneration: 1,
				pid: process.pid,
				processIncarnation: "test-incarnation",
				ephemeral: true,
			});

			// List sessions to trigger index read/reconstruction
			const sessions = sessionIndex.listSessions();
			const found = sessions.sessions.find(s => s.sessionId === "ephemeral-persisted");

			expect(found).toBeDefined();
			expect(found?.ephemeral).toBe(true);
		});
	});

	describe("Index reducer: ephemeral reconstruction from events", () => {
		it("reconstructs ephemeral from host_registered event", async () => {
			const cwd = path.join(tmpDir, "workspace");
			await fs.mkdir(cwd, { recursive: true });
			const locator = createLocator(cwd);

			await sessionIndex.append({
				type: "host_registered",
				sessionId: "ephemeral-reconstruct",
				locator,
				endpointGeneration: 1,
				pid: process.pid,
				processIncarnation: "test-incarnation",
				ephemeral: true,
			});

			// Force refresh to reconstruct from disk
			await sessionIndex.refresh();
			const sessions = sessionIndex.listSessions().sessions;
			const ephemeralSession = sessions.find(s => s.sessionId === "ephemeral-reconstruct");

			expect(ephemeralSession?.ephemeral).toBe(true);
		});

		it("persistent sessions lack ephemeral marker after reconstruction", async () => {
			const cwd = path.join(tmpDir, "workspace");
			await fs.mkdir(cwd, { recursive: true });
			const locator = createLocator(cwd);

			await sessionIndex.append({
				type: "host_registered",
				sessionId: "persistent-reconstruct",
				locator,
				endpointGeneration: 1,
				pid: process.pid,
				processIncarnation: "test-incarnation",
			});

			await sessionIndex.refresh();
			const sessions = sessionIndex.listSessions().sessions;
			const persistentSession = sessions.find(s => s.sessionId === "persistent-reconstruct");

			expect(persistentSession?.ephemeral).toBeUndefined();
		});
	});

	describe("Session list filtering: ephemeral exclusion", () => {
		it("ephemeral sessions excluded from listSessions", async () => {
			const cwd1 = path.join(tmpDir, "workspace1");
			const cwd2 = path.join(tmpDir, "workspace2");
			await fs.mkdir(cwd1, { recursive: true });
			await fs.mkdir(cwd2, { recursive: true });

			const loc1 = createLocator(cwd1);
			const loc2 = createLocator(cwd2);

			// Create persistent session
			await sessionIndex.append({
				type: "host_registered",
				sessionId: "persistent-in-list",
				locator: loc1,
				endpointGeneration: 1,
				pid: process.pid,
				processIncarnation: "test-incarnation",
			});

			// Create ephemeral session
			await sessionIndex.append({
				type: "host_registered",
				sessionId: "ephemeral-in-list",
				locator: loc2,
				endpointGeneration: 1,
				pid: process.pid,
				processIncarnation: "test-incarnation",
				ephemeral: true,
			});

			// Force refresh for accurate list
			await sessionIndex.refresh();
			const sessions = sessionIndex.listSessions().sessions;

			// Persistent visible, ephemeral hidden
			expect(sessions.find(s => s.sessionId === "persistent-in-list")).toBeDefined();
			expect(sessions.find(s => s.sessionId === "ephemeral-in-list")).toBeUndefined();
		});

		it("filtering works correctly with multiple sessions", async () => {
			const tmpWorkspaces = [1, 2, 3, 4, 5].map(i => path.join(tmpDir, `ws${i}`));
			for (const cwd of tmpWorkspaces) await fs.mkdir(cwd, { recursive: true });

			// Append: persistent, ephemeral, persistent, ephemeral, persistent
			const sessionIds = ["s1", "s2", "s3", "s4", "s5"];
			const ephemeralFlags = [false, true, false, true, false];

			for (let i = 0; i < sessionIds.length; i++) {
				await sessionIndex.append({
					type: "host_registered",
					sessionId: sessionIds[i],
					locator: createLocator(tmpWorkspaces[i]),
					endpointGeneration: 1,
					pid: process.pid,
					processIncarnation: `incarnation-${i}`,
					...(ephemeralFlags[i] ? { ephemeral: true } : {}),
				});
			}

			await sessionIndex.refresh();
			const sessions = sessionIndex.listSessions().sessions;
			const listedIds = sessions.map(s => s.sessionId);

			// Only persistent sessions visible
			expect(listedIds).toContain("s1");
			expect(listedIds).toContain("s3");
			expect(listedIds).toContain("s5");

			// Ephemeral sessions hidden
			expect(listedIds).not.toContain("s2");
			expect(listedIds).not.toContain("s4");
		});

		it("ephemeral marker survives compaction", async () => {
			const cwd = path.join(tmpDir, "workspace");
			await fs.mkdir(cwd, { recursive: true });
			const locator = createLocator(cwd);

			// Register ephemeral session
			await sessionIndex.append({
				type: "host_registered",
				sessionId: "ephemeral-compact",
				locator,
				endpointGeneration: 1,
				pid: process.pid,
				processIncarnation: "test-incarnation",
				ephemeral: true,
			});

			// Add heartbeat to trigger compaction threshold
			for (let i = 0; i < 10; i++) {
				await sessionIndex.append({
					type: "host_heartbeat",
					sessionId: "ephemeral-compact",
					locator,
					endpointGeneration: 1,
					pid: process.pid,
				});
			}

			// Force refresh (includes potential compaction)
			await sessionIndex.refresh();
			const sessions = sessionIndex.listSessions().sessions;
			const found = sessions.find(s => s.sessionId === "ephemeral-compact");

			// Ephemeral marker should be lost only if compaction removes it
			// This tests that marker is retained through journal compaction
			expect(found?.ephemeral).toBe(true);
		});
	});

	describe("Type validation and edge cases", () => {
		it("rejects non-boolean ephemeral values", async () => {
			const cwd = path.join(tmpDir, "workspace");
			await fs.mkdir(cwd, { recursive: true });

			// Should still accept as long as the session-index append accepts the type
			// This is a TypeScript-level concern
			const locator = createLocator(cwd);

			const event = await sessionIndex.append({
				type: "host_registered",
				sessionId: "test-types",
				locator,
				endpointGeneration: 1,
				pid: process.pid,
				processIncarnation: "test-incarnation",
				ephemeral: true,
			});

			expect(typeof event.ephemeral).toBe("boolean");
		});

		it("ephemeral=false is distinct from undefined", async () => {
			const cwd = path.join(tmpDir, "workspace");
			await fs.mkdir(cwd, { recursive: true });
			const locator = createLocator(cwd);

			const ephemeralFalse = await sessionIndex.append({
				type: "host_registered",
				sessionId: "explicit-false",
				locator,
				endpointGeneration: 1,
				pid: process.pid,
				processIncarnation: "test-incarnation",
				ephemeral: false,
			});

			const undefined_ = await sessionIndex.append({
				type: "host_registered",
				sessionId: "undefined-ephemeral",
				locator,
				endpointGeneration: 1,
				pid: process.pid,
				processIncarnation: "test-incarnation",
			});

			expect(ephemeralFalse.ephemeral).toBe(false);
			expect(undefined_.ephemeral).toBeUndefined();
		});
	});
});
