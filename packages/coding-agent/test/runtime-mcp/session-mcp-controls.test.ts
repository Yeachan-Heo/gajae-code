/**
 * Session-local MCP controls on AgentSession, granted by createAgentSession to
 * root interactive sessions only: `autoload: false` servers stay disconnected at
 * startup, and `controlSessionMcpServer()` connects, disconnects, or reconnects one
 * declared server for the current session without writing mcp.json.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@gajae-code/utils";
import * as z from "zod/v4";
import { AsyncJobManager } from "../../src/async";
import type { CustomTool } from "../../src/extensibility/custom-tools/types";
import { AgentRegistry, MAIN_AGENT_ID } from "../../src/registry/agent-registry";
import * as mcpRuntime from "../../src/runtime-mcp";
import { loadAllMCPConfigs } from "../../src/runtime-mcp/config";
import { attachExactMcpControls } from "../../src/runtime-mcp/redaction";
import { issueSessionMcpControlGrant, type SessionMcpControlGrant } from "../../src/runtime-mcp/session-controls-grant";
import { createMCPToolName } from "../../src/runtime-mcp/tool-bridge";
import type { SessionMcpControlAction } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import {
	logLines,
	makeCase,
	mcpToolsOf,
	openSession,
	runCleanups,
	type SessionHarness,
	settle,
	sha,
	sleep,
	spawnCount,
	writeMcp,
	writeStandard,
} from "./fixtures/session-mcp-harness";

// Disposing a session can wait for an in-flight MCP connect; allow for a loaded machine.
afterEach(runCleanups, 20_000);

// These fixtures test reset/control ownership, not the 250 ms ordinary-startup policy.
// Declare a bounded server window; explicit zero/delay timing cases keep their own values.
const AUTOLOAD_FIXTURE_TIMEOUT_MS = 1_000;

function control(h: SessionHarness, action: SessionMcpControlAction, name: string) {
	return h.session.controlSessionMcpServer(action, name);
}

async function row(h: SessionHarness, name: string) {
	const snapshot = await h.session.getSessionMcpStatusSnapshot();
	return snapshot?.servers.find(server => server.name === name);
}

async function awaitFixtureGate(gate: Promise<void>, name: string): Promise<void> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error(`MCP fixture gate did not open: ${name}`)), 2000);
	try {
		await Promise.race([gate, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

async function seedPredecessor(h: SessionHarness, registry: AgentRegistry, transition: "new" | "switch" = "new") {
	h.session.sessionManager.appendMessage({
		role: "user",
		content: "MCP_RESET_PREDECESSOR_HISTORY 보존할 대화",
		timestamp: Date.now(),
	});
	h.session.agent.replaceMessages(h.session.sessionManager.buildSessionContext().messages);
	await h.session.sessionManager.ensureOnDisk();
	await h.session.sessionManager.flush();
	const sessionId = h.session.sessionManager.getSessionId();
	const sessionFile = h.session.sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted predecessor transcript");
	expect(existsSync(sessionFile)).toBe(true);
	const transcript = sha(sessionFile);
	const messages = [...h.session.agent.state.messages];
	const entries = h.session.sessionManager.getEntries();
	const workflow = h.session.getWorkflowGateEmitter();
	const jobs = AsyncJobManager.forEndpoint(sessionId);
	if (!workflow || !jobs) throw new Error("Expected live predecessor workflow and job owners");
	const agentRef = registry.list().find(ref => ref.session === h.session);
	if (!agentRef) throw new Error("Expected the session's actual coordinator registration");
	const agentId = agentRef.id;
	expect(registry.get(agentId)?.sessionFile).toBe(sessionFile);
	const adoptionSpy = vi.spyOn(
		h.session.sessionManager,
		transition === "new" ? "commitPreparedNewSession" : "setSessionFile",
	);
	const identitySpy = vi.spyOn(h.session, "notifySessionIdentityChanged");
	return {
		expectUnchanged: (adoptionAttempts = 0) => {
			expect(adoptionSpy).toHaveBeenCalledTimes(adoptionAttempts);
			expect(identitySpy).not.toHaveBeenCalled();
			expect(h.session.sessionManager.getSessionId()).toBe(sessionId);
			expect(h.session.sessionManager.getSessionFile()).toBe(sessionFile);
			expect(h.session.agent.sessionId).toBe(sessionId);
			expect(h.session.agent.state.messages).toEqual(messages);
			expect(h.session.sessionManager.getEntries()).toEqual(entries);
			expect(sha(sessionFile)).toBe(transcript);
			expect(AsyncJobManager.forEndpoint(sessionId)).toBe(jobs);
			expect(AsyncJobManager.endpointIdOf(jobs)).toBe(sessionId);
			expect(h.session.getWorkflowGateEmitter()).toBe(workflow);
			expect(registry.get(agentId)?.sessionFile).toBe(sessionFile);
		},
		expectSuccessor: (expectedMessages: typeof messages = [], adoptionAttempts = 1) => {
			const successorId = h.session.sessionManager.getSessionId();
			const successorFile = h.session.sessionManager.getSessionFile();
			expect(successorId).not.toBe(sessionId);
			expect(successorFile).not.toBe(sessionFile);
			expect(adoptionSpy).toHaveBeenCalledTimes(adoptionAttempts);
			expect(identitySpy).toHaveBeenCalledTimes(1);
			expect(h.session.agent.sessionId).toBe(successorId);
			expect(h.session.agent.state.messages).toEqual(expectedMessages);
			expect(sha(sessionFile)).toBe(transcript);
			expect(AsyncJobManager.forEndpoint(sessionId)).toBeUndefined();
			expect(AsyncJobManager.forEndpoint(successorId)).toBe(jobs);
			expect(AsyncJobManager.endpointIdOf(jobs)).toBe(successorId);
			expect(h.session.getWorkflowGateEmitter()).not.toBe(workflow);
			expect(registry.get(agentId)?.sessionFile).toBe(successorFile);
		},
		restore: () => {
			identitySpy.mockRestore();
			adoptionSpy.mockRestore();
		},
	};
}

describe("session MCP controls on AgentSession", () => {
	test("startup connects only autoload servers", async () => {
		const c = makeCase();
		writeStandard(c);
		const h = await openSession(c);
		await settle();
		for (const name of ["fakeoff", "fakefail", "fakeslow", "fakenotimeout", "fakeflaky"]) {
			expect(spawnCount(c, name)).toBe(0);
			expect(mcpToolsOf(h.session.getAllToolNames(), name)).toEqual([]);
		}
		expect(mcpToolsOf(h.session.getActiveToolNames(), "fakeon").length).toBe(1);
		expect(mcpToolsOf(h.session.getAllToolNames(), "fakeauto").length).toBe(1);
		expect(mcpToolsOf(h.session.getActiveToolNames(), "fakeauto")).toEqual([]);
		expect(h.session.hasSessionMcpControls).toBe(true);
	}, 30_000);

	test("status snapshot reports declarations and refuses unapproved project stdio", async () => {
		const c = makeCase();
		writeStandard(c);
		const h = await openSession(c);
		expect(await row(h, "fakeon")).toMatchObject({
			scope: "global",
			state: "connected",
			autoload: true,
			toolCount: 1,
			declared: true,
		});
		expect(await row(h, "fakeoff")).toMatchObject({ scope: "project", state: "disconnected", autoload: false });
		expect(await row(h, "fakedis")).toMatchObject({ state: "disabled", disabled: "enabled-false" });
		expect(await row(h, "fakedeny")).toMatchObject({ state: "disabled", disabled: "disabled-servers" });

		const c2 = makeCase();
		writeStandard(c2);
		const h2 = await openSession(c2, { settings: { "mcp.enableProjectConfig": undefined } });
		expect(await row(h2, "fakeoff")).toMatchObject({ state: "disabled", disabled: "project-stdio-unapproved" });
		expect(await control(h2, "connect", "fakeoff")).toMatchObject({
			status: "disabled",
			disabledReason: "project-stdio-unapproved",
		});
		expect(spawnCount(c2, "fakeoff")).toBe(0);
	}, 30_000);

	test("connect, disconnect, connect, reconnect lifecycle", async () => {
		const c = makeCase();
		writeStandard(c);
		const h = await openSession(c);
		const onTools = mcpToolsOf(h.session.getActiveToolNames(), "fakeon");

		expect(await control(h, "connect", "fakeoff")).toEqual({
			action: "connect",
			name: "fakeoff",
			status: "connected",
			toolCount: 1,
		});
		expect(mcpToolsOf(h.session.getActiveToolNames(), "fakeoff").length).toBe(1);
		await settle();
		expect(mcpToolsOf(h.session.getAllToolNames(), "fakeoff").length).toBe(1);
		expect(mcpToolsOf(h.session.getActiveToolNames(), "fakeoff").length).toBe(1);

		expect(await control(h, "disconnect", "fakeoff")).toMatchObject({ status: "disconnected", toolCount: 0 });
		await settle();
		expect(mcpToolsOf(h.session.getAllToolNames(), "fakeoff")).toEqual([]);
		expect(mcpToolsOf(h.session.getActiveToolNames(), "fakeoff")).toEqual([]);
		expect(logLines(c).some(line => line.startsWith("exit fakeoff "))).toBe(true);

		expect(await control(h, "connect", "fakeoff")).toMatchObject({ status: "connected" });
		await settle();
		const spawnsBefore = spawnCount(c, "fakeoff");
		expect(await control(h, "reconnect", "fakeoff")).toMatchObject({ status: "reconnected", toolCount: 1 });
		await settle();
		expect(spawnCount(c, "fakeoff")).toBe(spawnsBefore + 1);
		expect(mcpToolsOf(h.session.getActiveToolNames(), "fakeoff").length).toBe(1);
		expect(mcpToolsOf(h.session.getActiveToolNames(), "fakeon")).toEqual(onTools);
	}, 30_000);

	test("session transitions restore startup policy without writing mcp.json", async () => {
		const c = makeCase();
		writeStandard(c);
		const before = [sha(c.userMcp), sha(c.projectMcp)];
		const h = await openSession(c);
		await control(h, "connect", "fakeoff");
		const sessionFile = h.session.sessionManager.getSessionFile();
		await h.session.newSession();
		await settle();
		expect(await row(h, "fakeoff")).toMatchObject({ state: "disconnected" });
		expect(mcpToolsOf(h.session.getAllToolNames(), "fakeoff")).toEqual([]);
		expect(logLines(c).some(line => line.startsWith("exit fakeoff "))).toBe(true);

		// A disconnected autoload server is restored after /new; controls wait for that flight.
		await control(h, "disconnect", "fakeon");
		expect(mcpToolsOf(h.session.getAllToolNames(), "fakeon")).toEqual([]);
		await h.session.newSession();
		const immediate = await control(h, "connect", "fakeoff").catch((error: { code?: string }) => error.code);
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && h.session.getActiveToolNames().every(name => !name.includes("fakeon")))
			await sleep(100);
		expect(await row(h, "fakeon")).toMatchObject({ state: "connected" });
		expect(mcpToolsOf(h.session.getActiveToolNames(), "fakeon").length).toBe(1);
		expect(mcpToolsOf(h.session.getActiveToolNames(), "fakeauto")).toEqual([]);
		// Busy while the restore flight runs, or connected once it settled: both orderings are valid.
		if (immediate !== "busy") {
			expect(immediate).toMatchObject({ status: "connected" });
			await control(h, "disconnect", "fakeoff");
		}

		// switchSession resets like newSession.
		await control(h, "connect", "fakeoff");
		if (sessionFile && existsSync(sessionFile)) {
			await h.session.switchSession(sessionFile);
			await settle();
			expect(await row(h, "fakeoff")).toMatchObject({ state: "disconnected" });
		}

		// A second session in the same agentDir starts from mcp.json only.
		const spawnsBefore = spawnCount(c, "fakeoff");
		await openSession(c);
		await settle();
		expect(spawnCount(c, "fakeoff")).toBe(spawnsBefore);
		expect([sha(c.userMcp), sha(c.projectMcp)]).toEqual(before);
	}, 60_000);

	for (const agentId of [MAIN_AGENT_ID, ""]) {
		for (const failure of ["disconnect", "refresh"] as const) {
			test(`reset ${failure} failure ${agentId ? "with" : "without"} owner lease rejects the transition and retains failed override intent for retry`, async () => {
				const c = makeCase();
				writeMcp(c, c.userMcp, {
					fakeflaky: { autoload: false, args: ["--fail-if-exists", c.flag("flaky")] },
				});
				const registry = new AgentRegistry();
				const h = await openSession(c, { session: { agentId, agentRegistry: registry } });
				const manager = h.result.mcpManager;
				if (!manager) throw new Error("Expected an owned MCP manager");
				expect(await control(h, "connect", "fakeflaky")).toMatchObject({ status: "connected", toolCount: 1 });
				const toolsBefore = mcpToolsOf(h.session.getAllToolNames(), "fakeflaky");
				expect(toolsBefore).toHaveLength(1);
				writeFileSync(c.flag("flaky"), "");
				expect(await control(h, "reconnect", "fakeflaky")).toMatchObject({ status: "failed", toolCount: 1 });
				expect(await row(h, "fakeflaky")).toMatchObject({ state: "failed", toolCount: 1 });
				const predecessor = await seedPredecessor(h, registry);
				const resetFailure = new Error(`synthetic reset ${failure} failure`);
				const disconnectSpy = vi.spyOn(manager, "disconnectServer");
				const refreshSpy = vi.spyOn(h.session, "refreshMCPTools");
				const connectSpy = vi.spyOn(manager, "connectSessionServer");
				if (failure === "disconnect") disconnectSpy.mockRejectedValueOnce(resetFailure);
				else refreshSpy.mockRejectedValueOnce(resetFailure);
				try {
					await expect(h.session.newSession()).rejects.toThrow(resetFailure.message);
					predecessor.expectUnchanged();
					expect(disconnectSpy.mock.calls.map(([name]) => name)).toEqual(["fakeflaky"]);
					expect(refreshSpy).toHaveBeenCalledTimes(failure === "disconnect" ? 0 : 1);
					expect(manager.getConnectionStatus("fakeflaky")).toBe("disconnected");
					expect(manager.getTools().filter(tool => tool.mcpServerName === "fakeflaky")).toHaveLength(
						failure === "disconnect" ? 1 : 0,
					);
					expect(await row(h, "fakeflaky")).toMatchObject({
						state: "failed",
						toolCount: failure === "disconnect" ? 1 : 0,
					});
					if (failure === "disconnect") {
						expect(mcpToolsOf(h.session.getAllToolNames(), "fakeflaky")).toEqual(toolsBefore);
					}
					await expect(h.session.newSession()).resolves.toBe(true);
					predecessor.expectSuccessor();
					expect(disconnectSpy.mock.calls.map(([name]) => name)).toEqual(["fakeflaky", "fakeflaky"]);
					expect(refreshSpy).toHaveBeenCalledTimes(failure === "disconnect" ? 1 : 2);
					expect(connectSpy).not.toHaveBeenCalled();
					expect(manager.getConnectionStatus("fakeflaky")).toBe("disconnected");
					expect(manager.getTools()).toEqual([]);
					expect(mcpToolsOf(h.session.getAllToolNames(), "fakeflaky")).toEqual([]);
					expect(mcpToolsOf(h.session.getActiveToolNames(), "fakeflaky")).toEqual([]);
					expect(await row(h, "fakeflaky")).toMatchObject({ state: "disconnected", toolCount: 0 });
				} finally {
					connectSpy.mockRestore();
					refreshSpy.mockRestore();
					disconnectSpy.mockRestore();
					predecessor.restore();
				}
			}, 30_000);
		}

		test(`disposal during post-reset switch rollback does not reconnect ${agentId ? "with" : "without"} owner lease`, async () => {
			const c = makeCase();
			writeMcp(c, c.userMcp, {
				fakeon: { timeout: AUTOLOAD_FIXTURE_TIMEOUT_MS },
				fakeoff: { autoload: false, timeout: AUTOLOAD_FIXTURE_TIMEOUT_MS },
			});
			const registry = new AgentRegistry();
			const h = await openSession(c, { session: { agentId, agentRegistry: registry } });
			expect(await control(h, "disconnect", "fakeon")).toMatchObject({ status: "disconnected" });
			expect(await control(h, "connect", "fakeoff")).toMatchObject({ status: "connected" });
			const predecessor = await seedPredecessor(h, registry, "switch");
			predecessor.restore();
			const rollbackStarted = Promise.withResolvers<void>();
			const releaseRollback = Promise.withResolvers<void>();
			const restore = h.session.sessionManager.restoreRollbackState.bind(h.session.sessionManager);
			const rollbackSpy = vi
				.spyOn(h.session.sessionManager, "restoreRollbackState")
				.mockImplementation(async state => {
					rollbackStarted.resolve();
					await releaseRollback.promise;
					await restore(state);
				});
			const loadFailure = new Error("MCP post-reset load failed before disposal");
			const loadSpy = vi.spyOn(h.session.sessionManager, "setSessionFile").mockRejectedValueOnce(loadFailure);
			const subscribeSpy = vi.spyOn(h.session.agent, "subscribe");
			const transition = h.session.switchSession(join(c.base, "rejected-switch.jsonl")).then(
				() => {
					throw new Error("Disposed session switch unexpectedly succeeded");
				},
				(error: unknown) => error,
			);
			void transition.catch(() => {});
			try {
				await awaitFixtureGate(rollbackStarted.promise, "post-reset rollback before disposal");
				const disposal = Promise.allSettled([h.session.dispose(), h.session.awaitDisposeCompletion()]);
				releaseRollback.resolve();
				const failure: unknown = await transition;
				expect(failure).toBeInstanceOf(AggregateError);
				if (!(failure instanceof AggregateError)) throw new Error("Expected preserved switch and rollback errors");
				expect(failure.errors).toContain(loadFailure);
				expect(subscribeSpy).not.toHaveBeenCalled();
				const disposed = await disposal;
				expect(disposed.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
				expect(h.result.mcpManager?.getTools()).toEqual([]);
			} finally {
				releaseRollback.resolve();
				await transition;
				subscribeSpy.mockRestore();
				loadSpy.mockRestore();
				rollbackSpy.mockRestore();
			}
		}, 30_000);
	}

	test("same-identity reload preserves conventional MCP overrides without starting restoration", async () => {
		const c = makeCase();
		writeMcp(c, c.userMcp, { fakeon: { timeout: AUTOLOAD_FIXTURE_TIMEOUT_MS } });
		const h = await openSession(c);
		const manager = h.result.mcpManager;
		if (!manager) throw new Error("Expected an owned MCP manager");
		expect(await control(h, "disconnect", "fakeon")).toMatchObject({ status: "disconnected" });
		h.session.sessionManager.appendMessage({ role: "user", content: "MCP_SAME_ID_RELOAD", timestamp: Date.now() });
		h.session.agent.replaceMessages(h.session.sessionManager.buildSessionContext().messages);
		await h.session.sessionManager.ensureOnDisk();
		await h.session.sessionManager.flush();
		const sessionFile = h.session.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted reload target");
		const sessionId = h.session.sessionManager.getSessionId();
		const connectSpy = vi.spyOn(manager, "connectSessionServer");
		const disconnectSpy = vi.spyOn(manager, "disconnectServer");
		const loadSpy = vi.spyOn(mcpRuntime, "loadAllMCPConfigs");
		try {
			await expect(h.session.switchSession(sessionFile)).resolves.toBe(true);
			expect(h.session.sessionManager.getSessionId()).toBe(sessionId);
			expect(h.session.agent.sessionId).toBe(sessionId);
			expect(connectSpy).not.toHaveBeenCalled();
			expect(disconnectSpy).not.toHaveBeenCalled();
			expect(loadSpy).not.toHaveBeenCalled();
			expect(spawnCount(c, "fakeon")).toBe(1);
			expect(await row(h, "fakeon")).toMatchObject({ state: "disconnected", toolCount: 0 });
		} finally {
			loadSpy.mockRestore();
			disconnectSpy.mockRestore();
			connectSpy.mockRestore();
		}
	}, 30_000);

	test("same-path foreign header replacement is refused before reset or endpoint adoption", async () => {
		const c = makeCase();
		writeMcp(c, c.userMcp, { fakeon: { timeout: AUTOLOAD_FIXTURE_TIMEOUT_MS } });
		const registry = new AgentRegistry();
		const h = await openSession(c, {
			session: {
				agentRegistry: registry,
				sessionManager: SessionManager.create(c.cwd, join(c.base, "transcripts")),
			},
		});
		expect(await control(h, "disconnect", "fakeon")).toMatchObject({ status: "disconnected" });
		const predecessor = await seedPredecessor(h, registry, "switch");
		predecessor.restore();
		const manager = h.result.mcpManager;
		if (!manager) throw new Error("Expected an owned MCP manager");
		const previousId = h.session.sessionManager.getSessionId();
		const previousFile = h.session.sessionManager.getSessionFile();
		if (!previousFile) throw new Error("Expected a persisted predecessor");
		const messages = [...h.session.agent.state.messages];
		const workflow = h.session.getWorkflowGateEmitter();
		const jobs = AsyncJobManager.forEndpoint(previousId);
		const foreign = await openSession(c, { start: false, session: { agentRegistry: new AgentRegistry() } });
		foreign.session.sessionManager.appendMessage({
			role: "user",
			content: "MCP_FOREIGN_ENDPOINT",
			timestamp: Date.now(),
		});
		await foreign.session.sessionManager.ensureOnDisk();
		await foreign.session.sessionManager.flush();
		const foreignFile = foreign.session.sessionManager.getSessionFile();
		if (!foreignFile) throw new Error("Expected a persisted foreign transcript");
		const foreignId = foreign.session.sessionManager.getSessionId();
		const foreignJobs = AsyncJobManager.forEndpoint(foreignId);
		expect(foreignJobs).toBeDefined();
		const foreignTranscript = sha(foreignFile);
		await Bun.write(previousFile, await Bun.file(foreignFile).text());
		const replacementTranscript = sha(previousFile);
		const adoptionSpy = vi.spyOn(h.session.sessionManager, "setSessionFile");
		const identitySpy = vi.spyOn(h.session, "notifySessionIdentityChanged");
		const connectSpy = vi.spyOn(manager, "connectSessionServer");
		const loadSpy = vi.spyOn(mcpRuntime, "loadAllMCPConfigs");
		try {
			await expect(h.session.switchSession(previousFile)).rejects.toThrow(
				"Session rollback persistence identity is unavailable.",
			);
			expect(adoptionSpy).not.toHaveBeenCalled();
			expect(identitySpy).not.toHaveBeenCalled();
			expect(connectSpy).not.toHaveBeenCalled();
			expect(loadSpy).not.toHaveBeenCalled();
			expect(h.session.sessionManager.getSessionId()).toBe(previousId);
			expect(h.session.agent.sessionId).toBe(previousId);
			expect(h.session.agent.state.messages).toEqual(messages);
			expect(h.session.getWorkflowGateEmitter()).toBe(workflow);
			expect(AsyncJobManager.forEndpoint(previousId)).toBe(jobs);
			expect(AsyncJobManager.forEndpoint(foreignId)).toBe(foreignJobs);
			expect(AsyncJobManager.endpointIdOf(foreignJobs)).toBe(foreignId);
			expect(registry.get(MAIN_AGENT_ID)?.sessionFile).toBe(previousFile);
			expect(sha(previousFile)).toBe(replacementTranscript);
			expect(sha(foreignFile)).toBe(foreignTranscript);
		} finally {
			loadSpy.mockRestore();
			connectSpy.mockRestore();
			identitySpy.mockRestore();
			adoptionSpy.mockRestore();
		}
	}, 30_000);

	test("committed identity notification cannot overwrite a newer coordinator registration", async () => {
		const c = makeCase();
		writeMcp(c, c.userMcp, {});
		const registry = new AgentRegistry();
		const h = await openSession(c, { session: { agentRegistry: registry } });
		const successor = registry.register({
			id: MAIN_AGENT_ID,
			displayName: "newer coordinator owner",
			kind: "main",
			session: null,
			sessionFile: join(c.base, "newer-owner.jsonl"),
		});
		await h.session.notifySessionIdentityChanged();
		expect(registry.get(MAIN_AGENT_ID)).toBe(successor);
		expect(successor.session).toBeNull();
		expect(successor.sessionFile).toBe(join(c.base, "newer-owner.jsonl"));
	});

	test("fixture cleanup reports actual completion failures and retains evidence", async () => {
		const c = makeCase();
		writeMcp(c, c.userMcp, {});
		const h = await openSession(c);
		const failure = new Error("Actual teardown observation failed");
		const completionSpy = vi.spyOn(h.session, "awaitDisposeCompletion").mockRejectedValueOnce(failure);
		try {
			await expect(runCleanups()).rejects.toMatchObject({
				errors: [expect.objectContaining({ errors: [failure] })],
			});
			expect(existsSync(c.base)).toBe(true);
			expect(existsSync(c.userMcp)).toBe(true);
		} finally {
			completionSpy.mockRestore();
			// Remove this intentional failure's evidence only after observing genuine teardown.
			await h.session.dispose();
			await h.session.awaitDisposeCompletion();
			await fs.rm(c.base, { recursive: true });
		}
	});

	test("guarded results, busy refusal and failure rollback", async () => {
		const c = makeCase();
		writeStandard(c);
		const h = await openSession(c);

		expect(await control(h, "connect", "fakeon")).toMatchObject({ status: "already-connected" });
		expect(await control(h, "disconnect", "fakeoff")).toMatchObject({ status: "not-connected" });
		expect(await control(h, "connect", "nosuch")).toMatchObject({ status: "unknown-server" });
		expect(await control(h, "connect", "fakedis")).toMatchObject({
			status: "disabled",
			disabledReason: "enabled-false",
		});
		expect(await control(h, "connect", "fakedeny")).toMatchObject({
			status: "disabled",
			disabledReason: "disabled-servers",
		});
		expect(spawnCount(c, "fakedis") + spawnCount(c, "fakedeny")).toBe(0);

		// Busy while another admission is held: refused immediately, nothing spawned.
		let busy: unknown;
		const startedAt = Date.now();
		await h.session.runWithPromptAdmissionForTests(async () => {
			busy = await control(h, "connect", "fakeoff").catch((error: { code?: string }) => error.code);
		});
		expect(Date.now() - startedAt).toBeLessThan(1000);
		expect(busy).toBe("busy");
		expect(spawnCount(c, "fakeoff")).toBe(0);

		// A failing server leaves the session's tools unchanged.
		const activeBefore = [...h.session.getActiveToolNames()].sort();
		const allBefore = [...h.session.getAllToolNames()].sort();
		expect(await control(h, "connect", "fakefail")).toMatchObject({ status: "failed" });
		expect([...h.session.getActiveToolNames()].sort()).toEqual(activeBefore);
		expect([...h.session.getAllToolNames()].sort()).toEqual(allBefore);
		expect(await row(h, "fakefail")).toMatchObject({ state: "failed" });

		// A tool refresh failure after connecting rolls the connection back.
		const original = h.session.refreshMCPTools;
		h.session.refreshMCPTools = async () => {
			h.session.refreshMCPTools = original;
			throw new Error("refresh failed");
		};
		await expect(control(h, "connect", "fakeoff")).rejects.toThrow("refresh failed");
		await settle();
		expect([...h.session.getActiveToolNames()].sort()).toEqual(activeBefore);
		expect([...h.session.getAllToolNames()].sort()).toEqual(allBefore);
		expect(h.result.mcpManager?.getConnectionStatus("fakeoff")).toBe("disconnected");
	}, 30_000);

	test("controls are busy until deferred startup settles", async () => {
		const c = makeCase();
		writeStandard(c);
		const h = await openSession(c, { start: false });
		const startedAt = Date.now();
		const code = await control(h, "connect", "fakeoff").catch((error: { code?: string }) => error.code);
		expect(Date.now() - startedAt).toBeLessThan(1000);
		expect(code).toBe("busy");
		await h.result.startDeferredMcpConfig?.();
		expect(await control(h, "connect", "fakeoff")).toMatchObject({ status: "connected" });
	}, 30_000);

	test("completion candidates follow server state", async () => {
		const c = makeCase();
		writeStandard(c);
		const h = await openSession(c);
		const names = (servers: readonly { name: string }[]) => servers.map(server => server.name).sort();
		const candidates = await h.session.getSessionMcpCompletionCandidates();
		expect(names(candidates.connectable)).toEqual(["fakefail", "fakeflaky", "fakenotimeout", "fakeoff", "fakeslow"]);
		expect(names(candidates.connected)).toEqual(["fakeauto", "fakeon"]);
		expect(names(candidates.reconnectable)).toEqual(["fakeauto", "fakeon"]);

		await control(h, "connect", "fakeoff");
		const after = await h.session.getSessionMcpCompletionCandidates();
		expect(names(after.connectable)).not.toContain("fakeoff");
		expect(names(after.connected)).toContain("fakeoff");
		expect(names(after.reconnectable)).toContain("fakeoff");
	}, 30_000);

	test("only autoload:false servers creates an idle manager", async () => {
		const c = makeCase();
		writeMcp(c, c.userMcp, { fakeoff: { autoload: false } });
		const h = await openSession(c, { start: false });
		expect(h.result.startDeferredMcpConfig).toBeUndefined();
		expect(h.result.mcpManager).toBeDefined();
		expect(spawnCount(c, "fakeoff")).toBe(0);
		expect(await control(h, "connect", "fakeoff")).toMatchObject({ status: "connected", toolCount: 1 });
		await settle();
		expect(mcpToolsOf(h.session.getActiveToolNames(), "fakeoff").length).toBe(1);
	}, 30_000);

	test("all autoload servers failing at startup still allows connect", async () => {
		const c = makeCase();
		writeMcp(c, c.userMcp, { fakefailauto: { args: ["--fail"] }, fakeoff: { autoload: false } });
		const h = await openSession(c, { start: false });
		const started = await h.result.startDeferredMcpConfig?.();
		expect(started?.hasErrors).toBe(true);
		expect(await control(h, "connect", "fakeoff")).toMatchObject({ status: "connected", toolCount: 1 });
		await settle();
		expect(mcpToolsOf(h.session.getActiveToolNames(), "fakeoff").length).toBe(1);
		expect(await row(h, "fakefailauto")).toMatchObject({ state: "failed" });
	}, 30_000);

	test("subagents inherit a full manager with connected tools", async () => {
		const c = makeCase();
		writeStandard(c);
		const h = await openSession(c);
		await control(h, "connect", "fakeoff");
		expect(h.result.mcpManager?.isToolsOnly()).toBe(false);
		expect(h.result.mcpManager?.getTools().some(tool => tool.mcpServerName === "fakeoff")).toBe(true);
	}, 30_000);

	test("slow servers finish connecting within the call", async () => {
		const c = makeCase();
		writeStandard(c);
		const h = await openSession(c);
		for (const name of ["fakeslow", "fakenotimeout"]) {
			expect(await control(h, "connect", name)).toMatchObject({ status: "connected", toolCount: 1 });
			expect(mcpToolsOf(h.session.getActiveToolNames(), name).length).toBe(1);
		}
	}, 30_000);

	test("failed reconnect keeps stale tools", async () => {
		const c = makeCase();
		writeStandard(c);
		const h = await openSession(c);
		await control(h, "connect", "fakeflaky");
		const before = mcpToolsOf(h.session.getAllToolNames(), "fakeflaky");
		const activeBefore = mcpToolsOf(h.session.getActiveToolNames(), "fakeflaky");
		writeFileSync(c.flag("flaky"), "");
		const startedAt = Date.now();
		expect(await control(h, "reconnect", "fakeflaky")).toMatchObject({ status: "failed", toolCount: 1 });
		expect(Date.now() - startedAt).toBeLessThan(6500);
		expect(mcpToolsOf(h.session.getAllToolNames(), "fakeflaky")).toEqual(before);
		expect(mcpToolsOf(h.session.getActiveToolNames(), "fakeflaky")).toEqual(activeBefore);
		expect(await row(h, "fakeflaky")).toMatchObject({ state: "failed", autoload: false, toolCount: 1 });
		const candidates = await h.session.getSessionMcpCompletionCandidates();
		expect(candidates.reconnectable.map(server => server.name)).toContain("fakeflaky");

		expect(await control(h, "disconnect", "fakeflaky")).toMatchObject({ status: "disconnected" });
		expect(mcpToolsOf(h.session.getAllToolNames(), "fakeflaky")).toEqual([]);
		expect(await row(h, "fakeflaky")).toMatchObject({ state: "disconnected" });
	}, 30_000);

	test("undeclared, shared and frozen managers", async () => {
		const c = makeCase();
		writeStandard(c);
		writeMcp(c, c.userMcp, {
			fakeon: { timeout: AUTOLOAD_FIXTURE_TIMEOUT_MS },
			fakeshared: { autoload: false, sharing: "shared" },
		});
		const h = await openSession(c);
		// The native mcp.json provider drops `sharing`, so this entry is per-session and
		// reconnects normally. The shared-pool `unavailable` result stays defensive for a
		// provider that keeps it.
		expect(await control(h, "connect", "fakeshared")).toMatchObject({ status: "connected" });
		const sharedTools = mcpToolsOf(h.session.getActiveToolNames(), "fakeshared");
		const loaded = await loadAllMCPConfigs(c.cwd, {
			agentDir: c.agentDir,
			enableProjectConfig: true,
			autoloadOnly: false,
			includeDisabled: true,
			nativeOnly: true,
		});
		expect(loaded.configs.fakeshared?.sharing).toBeUndefined();
		expect(await control(h, "reconnect", "fakeshared")).toMatchObject({ status: "reconnected" });
		expect(spawnCount(c, "fakeshared")).toBe(2);
		expect(mcpToolsOf(h.session.getActiveToolNames(), "fakeshared")).toEqual(sharedTools);

		// A connected server removed from mcp.json is undeclared: only disconnect works.
		expect(await control(h, "connect", "fakeoff")).toMatchObject({ status: "connected" });
		writeMcp(c, c.projectMcp, {});
		expect(await row(h, "fakeoff")).toMatchObject({ state: "connected", declared: false, toolCount: 1 });
		expect(await control(h, "reconnect", "fakeoff")).toMatchObject({ status: "undeclared" });
		expect(await control(h, "disconnect", "fakeoff")).toMatchObject({ status: "disconnected" });

		// A frozen connection set reports controls as unavailable.
		h.result.mcpManager?.freezeConnectionSet();
		expect(await control(h, "connect", "fakeon")).toMatchObject({ status: "unavailable" });
		expect(await h.session.getSessionMcpStatusSnapshot()).toEqual({ available: false, servers: [] });
	}, 30_000);

	test("a failed autoload server is not restored by a session transition", async () => {
		const c = makeCase();
		writeMcp(c, c.userMcp, { fakeon: { timeout: AUTOLOAD_FIXTURE_TIMEOUT_MS }, fakefailauto: { args: ["--fail"] } });
		const h = await openSession(c, { start: false });
		const started = await h.result.startDeferredMcpConfig?.();
		expect(started?.hasErrors).toBe(true);
		expect(h.result.mcpManager?.getAllServerNames()).toContain("fakefailauto");
		expect(await control(h, "disconnect", "fakefailauto")).toMatchObject({ status: "not-connected" });
		expect(await control(h, "reconnect", "fakefailauto")).toMatchObject({ status: "not-connected" });
		expect(await row(h, "fakefailauto")).toMatchObject({ state: "failed" });
		expect(mcpToolsOf(h.session.getActiveToolNames(), "fakeon").length).toBe(1);
		const spawns = spawnCount(c, "fakefailauto");
		await h.session.newSession();
		expect(await control(h, "disconnect", "fakefailauto")).toMatchObject({ status: "not-connected" });
		await settle();
		expect(spawnCount(c, "fakefailauto")).toBe(spawns);
	}, 30_000);

	test("servers connected by the session publish later tool-list changes", async () => {
		// With and without autoload servers: the empty-start manager must publish too.
		for (const withAutoload of [false, true]) {
			const c = makeCase();
			writeMcp(c, c.userMcp, {
				...(withAutoload ? { fakeon: {} } : {}),
				fakegrow: { autoload: false, args: ["--grow-on", c.flag("grow")] },
			});
			const h = await openSession(c);
			expect(await control(h, "connect", "fakegrow")).toMatchObject({ status: "connected", toolCount: 1 });
			writeFileSync(c.flag("grow"), "");
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline && !h.session.getAllToolNames().some(name => name.includes("grown")))
				await sleep(50);
			expect(mcpToolsOf(h.session.getAllToolNames(), "fakegrow").length).toBe(2);
		}
	}, 30_000);

	test("a connected project server cannot take over an active tool name", async () => {
		const c = makeCase();
		writeMcp(c, c.userMcp, { "foo-bar": { args: ["--tools", "grown"] } });
		writeMcp(c, c.projectMcp, {
			"foo.bar": { autoload: false, args: ["--tools", "other", "--grow-on", c.flag("grow")] },
		});
		const warn = vi.spyOn(logger, "warn");
		try {
			const h = await openSession(c, { settings: { "mcp.discoveryDefaultServers": ["foo-bar"] } });
			const trusted = h.result.mcpManager?.getTools().find(tool => tool.mcpServerName === "foo-bar")?.name;
			expect(trusted).toBeDefined();
			expect(await control(h, "connect", "foo.bar")).toMatchObject({ status: "connected", toolCount: 1 });
			writeFileSync(c.flag("grow"), "");
			const skipped = () =>
				warn.mock.calls.some(
					([message, context]) =>
						String(message).includes("already published by another server") &&
						(context as { path?: string } | undefined)?.path === "mcp:foo.bar",
				);
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline && !skipped()) await sleep(50);
			expect(skipped()).toBe(true);
			await settle();
			const tool = h.session.getToolByName(trusted ?? "");
			const result = await tool?.execute("collision-call", {}, undefined, {} as never);
			expect(JSON.stringify(result?.content)).toContain("foo-bar ok");
			expect(await row(h, "foo.bar")).toMatchObject({ state: "connected", toolCount: 1 });
		} finally {
			warn.mockRestore();
		}
	}, 30_000);

	test("a connected server cannot take over a non-MCP tool's name", async () => {
		const c = makeCase();
		writeMcp(c, c.userMcp, { fakeon: {} });
		writeMcp(c, c.projectMcp, {
			foo: { autoload: false, args: ["--tools", "bar", "--grow-on", c.flag("grow")] },
		});
		const localTool = (name: string): CustomTool =>
			({
				name,
				label: name,
				description: `Local tool ${name}`,
				parameters: z.object({}),
				async execute() {
					return { content: [{ type: "text", text: `local ${name}` }] };
				},
			}) as CustomTool;
		// The names the server's `bar` (initial catalog) and `grown` (list_changed) tools map to.
		const names = [createMCPToolName("foo", "bar"), createMCPToolName("foo", "grown")];
		const warn = vi.spyOn(logger, "warn");
		try {
			const h = await openSession(c, { session: { customTools: names.map(localTool) } });
			const runsLocally = async (name: string) => {
				const result = await h.session.getToolByName(name)?.execute("collision-call", {}, undefined, {} as never);
				return JSON.stringify(result?.content).includes(`local ${name}`);
			};
			expect(await control(h, "connect", "foo")).toMatchObject({ status: "connected" });
			await settle();
			expect(await runsLocally(names[0])).toBe(true);

			// A later tools/list_changed refresh cannot take over either name.
			writeFileSync(c.flag("grow"), "");
			const blocked = (name: string) =>
				warn.mock.calls.some(
					([message, context]) =>
						String(message).includes("already registered by another tool") &&
						(context as { tool?: string } | undefined)?.tool === name,
				);
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline && !blocked(names[1])) await sleep(50);
			await settle();
			expect(blocked(names[0]) && blocked(names[1])).toBe(true);
			for (const name of names) expect(await runsLocally(name)).toBe(true);

			// Disconnecting the server keeps the local tools registered.
			await control(h, "disconnect", "foo");
			await settle();
			for (const name of names) expect(await runsLocally(name)).toBe(true);
		} finally {
			warn.mockRestore();
		}
	}, 30_000);

	test("the first turn after /new waits for restored autoload tools", async () => {
		const c = makeCase();
		writeStandard(c);
		const h = await openSession(c);
		await control(h, "disconnect", "fakeon");
		const barriers: Promise<void>[] = [];
		const extend = h.session.extendStartupTurnBarrier.bind(h.session);
		h.session.extendStartupTurnBarrier = barrier => {
			barriers.push(barrier);
			extend(barrier);
		};
		await h.session.newSession();
		expect(barriers).toHaveLength(1);
		await barriers[0];
		// No polling: the barrier settles only after the restored tools are published.
		expect(mcpToolsOf(h.session.getActiveToolNames(), "fakeon").length).toBe(1);
	}, 30_000);

	test("a disconnect that fails after taking effect is still restored by /new", async () => {
		const c = makeCase();
		writeStandard(c);
		const h = await openSession(c);
		const manager = h.result.mcpManager;
		if (!manager) throw new Error("expected an MCP manager");
		// The manager disconnects the server and then reports a cleanup error.
		const original = manager.disconnectServer.bind(manager);
		manager.disconnectServer = async name => {
			manager.disconnectServer = original;
			await original(name);
			throw new Error("cleanup failed");
		};
		await expect(control(h, "disconnect", "fakeon")).rejects.toThrow("cleanup failed");
		expect(h.result.mcpManager?.getConnectionStatus("fakeon")).toBe("disconnected");
		const spawns = spawnCount(c, "fakeon");
		await h.session.newSession();
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && h.result.mcpManager?.getConnectionStatus("fakeon") !== "connected")
			await sleep(50);
		expect(h.result.mcpManager?.getConnectionStatus("fakeon")).toBe("connected");
		expect(spawnCount(c, "fakeon")).toBe(spawns + 1);
	}, 30_000);

	test("dispose survives a /new restore that settles while disconnectAll is pending", async () => {
		const c = makeCase();
		writeStandard(c);
		const h = await openSession(c);
		const manager = h.result.mcpManager;
		if (!manager) throw new Error("expected an MCP manager");
		await control(h, "disconnect", "fakeon");
		// Hold the /new restore inside its reconnect so dispose finds the flight still running.
		const gate = Promise.withResolvers<void>();
		const connect = manager.connectSessionServer.bind(manager);
		manager.connectSessionServer = async (...args) => {
			manager.connectSessionServer = connect;
			await gate.promise;
			return connect(...args);
		};
		await h.session.newSession();
		// Release the restore from inside disconnectAll and let it settle before the disconnect
		// returns, so the flight clears its shared handle while dispose is still awaiting.
		const disconnectAll = manager.disconnectAll.bind(manager);
		manager.disconnectAll = async () => {
			manager.disconnectAll = disconnectAll;
			gate.resolve();
			await sleep(500);
			return disconnectAll();
		};
		const results = await Promise.allSettled([h.session.dispose(), h.session.awaitDisposeCompletion()]);
		expect(results.filter(result => result.status === "rejected").map(result => String(result.reason))).toEqual([]);
	}, 30_000);
});

describe("session MCP control grant", () => {
	test("is withheld without a CLI-minted grant or outside a deferred root session", async () => {
		// An SDK caller cannot forge the grant: only tokens minted by issueSessionMcpControlGrant count.
		const forged = Object.freeze({ grantSource: "root-interactive-cli" }) as SessionMcpControlGrant;
		for (const session of [
			{ sessionMcpControlGrant: undefined },
			{ sessionMcpControlGrant: forged },
			{ deferMcpConfigStartup: false },
			{ enableMcpAutoload: false },
		]) {
			const c = makeCase();
			writeStandard(c);
			const h = await openSession(c, { session });
			expect(h.session.hasSessionMcpControls).toBe(false);
			expect(await h.session.getSessionMcpStatusSnapshot()).toBeUndefined();
			expect(await control(h, "connect", "fakeoff")).toBeUndefined();
			expect(spawnCount(c, "fakeoff")).toBe(0);
		}
	}, 60_000);

	test("exact --mcp-config sessions keep only their exact controls", async () => {
		for (const sessionMcpControlGrant of [undefined, issueSessionMcpControlGrant()]) {
			const c = makeCase();
			const exact = join(c.base, "exact.json");
			writeMcp(c, exact, { fakeexact: {} });
			const h = await openSession(c, { session: { mcpConfigPath: exact, sessionMcpControlGrant } });
			attachExactMcpControls(h.session, { grantSource: "root-interactive-exact-config", configPath: exact });
			expect(h.session.hasExactMcpControls).toBe(true);
			expect(h.session.hasSessionMcpControls).toBe(false);
			expect(await h.session.getSessionMcpStatusSnapshot()).toBeUndefined();
			expect(await control(h, "connect", "fakeexact")).toBeUndefined();
		}
	}, 60_000);
});
