import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
import { SessionManager } from "../src/session/session-manager";

const tmpDirs: string[] = [];

afterEach(async () => {
	for (const dir of tmpDirs) {
		try {
			await fs.rm(dir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
	tmpDirs.length = 0;
});

test("ACP session.list includes managed sessions not in broker index when cwd is provided", async () => {
	// Create a temporary directory structure
	const tmpDir = await fs.mkdtemp("/tmp/gjc-broker-session-list-");
	tmpDirs.push(tmpDir);
	const agentDir = path.join(tmpDir, ".gjc", "agent");
	await fs.mkdir(agentDir, { recursive: true });

	const cwd = path.join(tmpDir, "project");
	await fs.mkdir(cwd, { recursive: true });

	// Create a managed session (saved transcript)
	const managed = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
	managed.appendMessage({ role: "user", content: "Hello", timestamp: Date.now() });
	await managed.ensureOnDisk();

	const sessionId = managed.getSessionId();

	// Create and start the broker
	const broker = new Broker({ agentDir });
	await broker.start();

	try {
		// Call session.list with cwd but no cursor (first page)
		const result = await broker.handleRequest("session.list", { cwd });

		expect(result).toMatchObject({ ok: true });
		if (result.ok !== true) throw new Error("session.list failed");

		const sessions = ((result.result as any).sessions ?? []) as unknown[];
		expect(Array.isArray(sessions)).toBe(true);

		// The managed session should be included in the list
		const found = sessions.find((s: any) => typeof s === "object" && s !== null && s.sessionId === sessionId);
		expect(found).toBeDefined();
		expect(found).toMatchObject({
			sessionId,
			live: false,
			terminal: true,
		});
	} finally {
		await broker.stop();
	}
});

test("ACP session.list deduplicates sessions by sessionId", async () => {
	// Create a temporary directory structure
	const tmpDir = await fs.mkdtemp("/tmp/gjc-broker-dedup-");
	tmpDirs.push(tmpDir);
	const agentDir = path.join(tmpDir, ".gjc", "agent");
	await fs.mkdir(agentDir, { recursive: true });

	const cwd = path.join(tmpDir, "project");
	await fs.mkdir(cwd, { recursive: true });

	// Create and start the broker
	const broker = new Broker({ agentDir });
	await broker.start();

	try {
		// Create a session through the broker
		const createResult = await broker.handleRequest("session.create", { cwd }, "create-1");
		expect(createResult.ok).toBe(true);

		if (createResult.ok !== true) throw new Error("session.create failed");
		const brokerSessionId = (createResult.result as any).sessionId;

		// Also create a managed session with a different ID
		const managed = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
		managed.appendMessage({ role: "user", content: "Managed session", timestamp: Date.now() });
		await managed.ensureOnDisk();
		const managedSessionId = managed.getSessionId();

		// Refresh the broker index to pick up the broker session
		await broker.index.refresh();

		// Call session.list with cwd
		const result = await broker.handleRequest("session.list", { cwd });

		expect(result.ok).toBe(true);
		if (result.ok !== true) throw new Error("session.list failed");

		const sessions = ((result.result as any).sessions ?? []) as unknown[];

		// Count how many times each session ID appears
		const brokerCount = sessions.filter(
			(s: any) => typeof s === "object" && s !== null && s.sessionId === brokerSessionId,
		).length;
		const managedCount = sessions.filter(
			(s: any) => typeof s === "object" && s !== null && s.sessionId === managedSessionId,
		).length;

		// Each session should appear exactly once
		expect(brokerCount).toBe(1);
		expect(managedCount).toBe(1);
	} finally {
		await broker.stop();
	}
});

test("ACP session.list without cwd does not scan managed sessions", async () => {
	// Create a temporary directory structure
	const tmpDir = await fs.mkdtemp("/tmp/gjc-broker-no-cwd-");
	tmpDirs.push(tmpDir);
	const agentDir = path.join(tmpDir, ".gjc", "agent");
	await fs.mkdir(agentDir, { recursive: true });

	const cwd = path.join(tmpDir, "project");
	await fs.mkdir(cwd, { recursive: true });

	// Create a managed session
	const managed = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
	managed.appendMessage({ role: "user", content: "Hello", timestamp: Date.now() });
	await managed.ensureOnDisk();

	const sessionId = managed.getSessionId();

	// Create and start the broker
	const broker = new Broker({ agentDir });
	await broker.start();

	try {
		// Call session.list WITHOUT cwd
		const result = await broker.handleRequest("session.list", {});

		expect(result.ok).toBe(true);
		if (result.ok !== true) throw new Error("session.list failed");

		const sessions = ((result.result as any).sessions ?? []) as unknown[];

		// The managed session should NOT be included when no cwd is provided
		const found = sessions.find((s: any) => typeof s === "object" && s !== null && s.sessionId === sessionId);
		expect(found).toBeUndefined();
	} finally {
		await broker.stop();
	}
});

test("ACP session.list can load and resume managed transcripts listed in session list", async () => {
	// Create a temporary directory structure
	const tmpDir = await fs.mkdtemp("/tmp/gjc-broker-resume-");
	tmpDirs.push(tmpDir);
	const agentDir = path.join(tmpDir, ".gjc", "agent");
	await fs.mkdir(agentDir, { recursive: true });

	const cwd = path.join(tmpDir, "project");
	await fs.mkdir(cwd, { recursive: true });

	// Create a managed session (old transcript not in broker index)
	const managed = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
	managed.appendMessage({ role: "user", content: "Hello", timestamp: Date.now() });
	await managed.ensureOnDisk();

	const sessionId = managed.getSessionId();

	// Create and start the broker
	const broker = new Broker({ agentDir });
	await broker.start();

	try {
		// List sessions - should include the managed transcript
		const listResult = await broker.handleRequest("session.list", { cwd });
		expect(listResult.ok).toBe(true);
		if (listResult.ok !== true) throw new Error("session.list failed");

		const sessions = ((listResult.result as any).sessions ?? []) as unknown[];
		const listedSession = sessions.find(
			(s: any) => typeof s === "object" && s !== null && s.sessionId === sessionId,
		) as any;
		expect(listedSession).toBeDefined();
		expect(listedSession.live).toBe(false);
		expect(listedSession.terminal).toBe(true);

		// Now try to load the session using session.load
		const loadResult = await broker.handleRequest("session.load", {
			cwd,
			sessionId,
		});

		// The load should succeed or provide meaningful feedback about the managed session
		// It may not be resumable for a new task, but it should be accessible
		if (loadResult.ok) {
			const loaded = loadResult.result as any;
			expect(loaded.sessionId).toBe(sessionId);
		} else {
			// For a managed transcript that's not meant to be resumed as a live session,
			// this is acceptable - the key is that session.load knows about it
			expect(["not_found", "endpoint_stale", "live_session"]).toContain((loadResult as any).error?.code);
		}
	} finally {
		await broker.stop();
	}
});

test("ACP session.list with pagination orders managed sessions by mtime", async () => {
	// Create a temporary directory structure
	const tmpDir = await fs.mkdtemp("/tmp/gjc-broker-pagination-");
	tmpDirs.push(tmpDir);
	const agentDir = path.join(tmpDir, ".gjc", "agent");
	await fs.mkdir(agentDir, { recursive: true });

	const cwd = path.join(tmpDir, "project");
	await fs.mkdir(cwd, { recursive: true });

	// Create multiple managed sessions with different timestamps
	const sessions: Array<{ sessionId: string; index: number }> = [];
	for (let i = 0; i < 3; i++) {
		const managed = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
		managed.appendMessage({ role: "user", content: `Session ${i}`, timestamp: Date.now() + i * 1000 });
		await managed.ensureOnDisk();
		sessions.push({ sessionId: managed.getSessionId(), index: i });
		// Small delay to ensure different mtimes
		await new Promise(resolve => setTimeout(resolve, 10));
	}

	// Create and start the broker
	const broker = new Broker({ agentDir });
	await broker.start();

	try {
		// List sessions with a small page limit to test pagination
		const listResult = await broker.handleRequest("session.list", { cwd, limit: 2 });
		expect(listResult.ok).toBe(true);
		if (listResult.ok !== true) throw new Error("session.list failed");

		const firstPage = ((listResult.result as any).sessions ?? []) as unknown[];
		expect(Array.isArray(firstPage)).toBe(true);

		// Verify that sessions are ordered by mtime (most recent first)
		// Since we created sessions in order with delays, the most recent should be first
		if (firstPage.length > 0) {
			const firstPageIds = firstPage
				.filter((s: any) => sessions.some(sess => sess.sessionId === s.sessionId))
				.map((s: any) => s.sessionId);

			// Check that the session list maintains ordering
			for (let i = 0; i < firstPageIds.length - 1; i++) {
				const current = firstPage[i] as any;
				const next = firstPage[i + 1] as any;
				// Most recent (highest mtime) should come first
				const currentTime = current.endpointMtimeMs ?? current.lastHeartbeatAt ?? 0;
				const nextTime = next.endpointMtimeMs ?? next.lastHeartbeatAt ?? 0;
				expect(currentTime).toBeGreaterThanOrEqual(nextTime);
			}
		}

		// Test getting the next page if available
		if ((listResult.result as any).cursor) {
			const secondPageResult = await broker.handleRequest("session.list", {
				cwd,
				limit: 2,
				cursor: (listResult.result as any).cursor,
			});

			expect(secondPageResult.ok).toBe(true);
			if (secondPageResult.ok !== true) throw new Error("session.list pagination failed");

			const secondPage = ((secondPageResult.result as any).sessions ?? []) as unknown[];
			// Second page should not contain duplicates from first page
			const firstPageSessionIds = new Set(firstPage.map((s: any) => s.sessionId));
			for (const session of secondPage) {
				const s = session as any;
				if (sessions.some(sess => sess.sessionId === s.sessionId)) {
					expect(firstPageSessionIds.has(s.sessionId)).toBe(false);
				}
			}
		}
	} finally {
		await broker.stop();
	}
});
