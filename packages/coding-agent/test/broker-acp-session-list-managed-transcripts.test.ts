import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
import { SessionManager } from "../src/session/session-manager";
import { resolveManagedSessionScope, listManagedSessionCandidates } from "../src/sdk/session-directory";

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
		
		const sessions = result.result.sessions as unknown[];
		expect(Array.isArray(sessions)).toBe(true);
		
		// The managed session should be included in the list
		const found = sessions.find(
			(s: any) => typeof s === "object" && s !== null && s.sessionId === sessionId
		);
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
		
		const sessions = result.result.sessions as unknown[];
		
		// Count how many times each session ID appears
		const brokerCount = sessions.filter(
			(s: any) => typeof s === "object" && s !== null && s.sessionId === brokerSessionId
		).length;
		const managedCount = sessions.filter(
			(s: any) => typeof s === "object" && s !== null && s.sessionId === managedSessionId
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
		
		const sessions = result.result.sessions as unknown[];
		
		// The managed session should NOT be included when no cwd is provided
		const found = sessions.find(
			(s: any) => typeof s === "object" && s !== null && s.sessionId === sessionId
		);
		expect(found).toBeUndefined();
	} finally {
		await broker.stop();
	}
});
