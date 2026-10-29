/**
 * Session-local MCP controls on AgentSession, granted by createAgentSession to
 * root interactive sessions only: `autoload: false` servers stay disconnected at
 * startup, and `controlSessionMcpServer()` connects, disconnects, or reconnects one
 * declared server for the current session without writing mcp.json.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAllMCPConfigs } from "../../src/runtime-mcp/config";
import { attachExactMcpControls } from "../../src/runtime-mcp/redaction";
import type { SessionMcpControlAction } from "../../src/session/agent-session";
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

afterEach(runCleanups);

function control(h: SessionHarness, action: SessionMcpControlAction, name: string) {
	return h.session.controlSessionMcpServer(action, name);
}

async function row(h: SessionHarness, name: string) {
	const snapshot = await h.session.getSessionMcpStatusSnapshot();
	return snapshot?.servers.find(server => server.name === name);
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
			fakeon: {},
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
		writeMcp(c, c.userMcp, { fakeon: {}, fakefailauto: { args: ["--fail"] } });
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
});

describe("session MCP control grant", () => {
	test("is withheld unless the session is a deferred root session without --mcp-config", async () => {
		for (const session of [
			{ sessionMcpControls: false },
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
		for (const sessionMcpControls of [false, true]) {
			const c = makeCase();
			const exact = join(c.base, "exact.json");
			writeMcp(c, exact, { fakeexact: {} });
			const h = await openSession(c, { session: { mcpConfigPath: exact, sessionMcpControls } });
			attachExactMcpControls(h.session, { grantSource: "root-interactive-exact-config", configPath: exact });
			expect(h.session.hasExactMcpControls).toBe(true);
			expect(h.session.hasSessionMcpControls).toBe(false);
			expect(await h.session.getSessionMcpStatusSnapshot()).toBeUndefined();
			expect(await control(h, "connect", "fakeexact")).toBeUndefined();
		}
	}, 60_000);
});
