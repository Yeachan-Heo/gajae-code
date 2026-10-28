/**
 * Session-scoped MCP controls for ordinary interactive sessions: `autoload: false`
 * servers stay disconnected at startup and `/mcp connect|disconnect|reconnect`
 * manage them for the current session without writing mcp.json.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "../../src/config/settings";
import { getBuiltinSlashCommandsForSession } from "../../src/extensibility/slash-commands";
import { loadAllMCPConfigs } from "../../src/runtime-mcp/config";
import { attachExactMcpControls } from "../../src/runtime-mcp/redaction";
import { createAgentSession } from "../../src/sdk/session";
import { type BuiltinSlashCommandRuntime, lookupBuiltinSlashCommand } from "../../src/slash-commands/builtin-registry";

const fakeServer = join(import.meta.dir, "fixtures", "session-mcp-fake-server.ts");

// ---------------------------------------------------------------------------
// Session harness
// ---------------------------------------------------------------------------

type ServerSpec = { args?: string[]; autoload?: boolean; enabled?: boolean; sharing?: string; timeout?: number };
type Case = {
	base: string;
	agentDir: string;
	cwd: string;
	log: string;
	userMcp: string;
	projectMcp: string;
	flag: (name: string) => string;
};
type Harness = {
	result: any;
	session: any;
	mcp: (args: string) => Promise<{ status: string[]; warning: string[]; error: string[]; returned: unknown }>;
	commands: (hasExact: boolean, withSession?: boolean) => readonly any[];
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) {
		try {
			await cleanup();
		} catch {
			/* best effort */
		}
	}
});

function makeCase(): Case {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "gjc-msc-case-")));
	const agentDir = join(base, "agent");
	const cwd = join(base, "proj");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, ".gjc"), { recursive: true });
	const log = join(base, "spawn.log");
	writeFileSync(log, "");
	cleanups.push(() => rmSync(base, { recursive: true, force: true }));
	return {
		base,
		agentDir,
		cwd,
		log,
		userMcp: join(agentDir, "mcp.json"),
		projectMcp: join(cwd, ".gjc", "mcp.json"),
		flag: name => join(base, `${name}.flag`),
	};
}

function serverConfig(c: Case, name: string, spec: ServerSpec): Record<string, unknown> {
	const config: Record<string, unknown> = {
		command: process.execPath,
		args: [fakeServer, "--name", name, "--log", c.log, ...(spec.args ?? [])],
	};
	if (spec.autoload !== undefined) config.autoload = spec.autoload;
	if (spec.enabled !== undefined) config.enabled = spec.enabled;
	if (spec.sharing !== undefined) config.sharing = spec.sharing;
	if (spec.timeout !== undefined) config.timeout = spec.timeout;
	return config;
}

function writeMcp(
	c: Case,
	file: string,
	servers: Record<string, ServerSpec>,
	extra: Record<string, unknown> = {},
): void {
	const mcpServers = Object.fromEntries(
		Object.entries(servers).map(([name, spec]) => [name, serverConfig(c, name, spec)]),
	);
	writeFileSync(file, `${JSON.stringify({ mcpServers, ...extra }, null, 2)}\n`);
}

/** Standard declaration set used by most tests. */
function writeStandard(c: Case): void {
	writeMcp(
		c,
		c.userMcp,
		{
			fakeon: {},
			fakeauto: {},
			fakefail: { autoload: false, args: ["--fail"] },
			fakeslow: { autoload: false, args: ["--delay-init", "2500"] },
			fakenotimeout: { autoload: false, args: ["--delay-init", "900"] },
			fakeflaky: { autoload: false, args: ["--fail-if-exists", c.flag("flaky")] },
			fakedis: { autoload: false, enabled: false },
			fakedeny: { autoload: false },
		},
		{ disabledServers: ["fakedeny"] },
	);
	writeMcp(c, c.projectMcp, {
		fakeoff: { autoload: false, args: ["--delay-if-exists", c.flag("hang"), "10000"] },
	});
}

function logLines(c: Case): string[] {
	return readFileSync(c.log, "utf8").split("\n").filter(Boolean);
}
function spawnCount(c: Case, name: string): number {
	return logLines(c).filter(line => line.startsWith(`spawn ${name} `)).length;
}
function mcpToolsOf(names: string[], server: string): string[] {
	return names.filter(name => name.startsWith("mcp_") && name.includes(server));
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function settle(): Promise<void> {
	await sleep(400);
}

async function openSession(
	c: Case,
	options: { settings?: Record<string, unknown>; start?: boolean; session?: Record<string, unknown> } = {},
): Promise<Harness> {
	const settingValues: Record<string, unknown> = {
		"mcp.enableProjectConfig": true,
		"mcp.discoveryMode": true,
		"mcp.discoveryDeferAutoload": true,
		"mcp.discoveryDefaultServers": ["fakeon"],
		...(options.settings ?? {}),
	};
	// An explicit `undefined` means "leave the setting unset" (schema default).
	for (const key of Object.keys(settingValues)) if (settingValues[key] === undefined) delete settingValues[key];
	const settings = Settings.isolated(settingValues);
	const result = await createAgentSession({
		cwd: c.cwd,
		agentDir: c.agentDir,
		settings,
		disableExtensionDiscovery: true,
		enableLsp: false,
		skipPythonPreflight: true,
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		hasUI: false,
		sessionMcpControls: true,
		deferMcpConfigStartup: true,
		...(options.session ?? {}),
	});
	const session = result.session;
	cleanups.push(async () => {
		await session.dispose();
		await sleep(150);
	});
	if (options.start !== false) await result.startDeferredMcpConfig?.();
	const mcp = async (args: string) => {
		const out = {
			status: [] as string[],
			warning: [] as string[],
			error: [] as string[],
			returned: undefined as unknown,
		};
		const runtime = {
			ctx: {
				session,
				editor: { setText: () => {} },
				showStatus: (text: string) => out.status.push(text),
				showWarning: (text: string) => out.warning.push(text),
				showError: (text: string) => out.error.push(text),
			},
		};
		const text = args ? `/mcp ${args}` : "/mcp";
		out.returned = await lookupBuiltinSlashCommand("mcp")!.handleTui!(
			{ name: "mcp", args, text },
			runtime as unknown as BuiltinSlashCommandRuntime,
		);
		return out;
	};
	const commands = (hasExact: boolean, withSession = true) =>
		withSession ? getBuiltinSlashCommandsForSession(hasExact, session) : getBuiltinSlashCommandsForSession(hasExact);
	return { result, session, mcp, commands };
}

const STATUS_LINE =
	/^ {2}\S+ · (global|project) · (connected|connecting|disconnected|disabled|failed) · autoload (on|off) · \d+ tools( · not in mcp\.json)?$/;
function statusLine(text: string, name: string): string | undefined {
	return text.split("\n").find(line => line.startsWith(`  ${name} · `));
}
function sha(path: string): string {
	return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "missing";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("session MCP controls in ordinary interactive sessions", () => {
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

	test("status rendering and project stdio approval", async () => {
		const c = makeCase();
		writeStandard(c);
		const h = await openSession(c);
		const outputs = [await h.mcp("status"), await h.mcp("list"), await h.mcp("")];
		const texts = outputs.map(out => out.status.join("\n"));
		expect(texts[0]).toBe(texts[1]);
		expect(texts[0]).toBe(texts[2]);
		const rows = texts[0]!.split("\n").slice(1);
		for (const row of rows) expect(row).toMatch(STATUS_LINE);
		expect(rows.filter(row => row.startsWith("  fakeoff · "))).toEqual([
			expect.stringContaining("  fakeoff · project ·"),
		]);
		expect(statusLine(texts[0]!, "fakedis")).toContain(" · disabled · ");
		expect(statusLine(texts[0]!, "fakedeny")).toContain(" · disabled · ");
		expect(statusLine(texts[0]!, "fakeon")).toBe("  fakeon · global · connected · autoload on · 1 tools");

		const c2 = makeCase();
		writeStandard(c2);
		const h2 = await openSession(c2, { settings: { "mcp.enableProjectConfig": undefined } });
		const status2 = (await h2.mcp("status")).status.join("\n");
		expect(statusLine(status2, "fakeoff")).toContain(" · disabled · ");
		const denied = await h2.mcp("connect fakeoff");
		expect(denied.error.join("\n")).toContain("mcp.enableProjectConfig");
		expect(spawnCount(c2, "fakeoff")).toBe(0);
	}, 30_000);

	test("connect, disconnect, connect, reconnect lifecycle", async () => {
		const c = makeCase();
		writeStandard(c);
		const h = await openSession(c);
		const onTools = mcpToolsOf(h.session.getActiveToolNames(), "fakeon");

		const first = await h.mcp("connect fakeoff");
		expect(first.status.join("")).toContain('MCP server "fakeoff" connected (1 tools active).');
		expect(mcpToolsOf(h.session.getActiveToolNames(), "fakeoff").length).toBe(1);
		await settle();
		expect(mcpToolsOf(h.session.getAllToolNames(), "fakeoff").length).toBe(1);
		expect(mcpToolsOf(h.session.getActiveToolNames(), "fakeoff").length).toBe(1);

		const off = await h.mcp("disconnect fakeoff");
		expect(off.status.join("")).toContain("disconnected");
		await settle();
		expect(mcpToolsOf(h.session.getAllToolNames(), "fakeoff")).toEqual([]);
		expect(mcpToolsOf(h.session.getActiveToolNames(), "fakeoff")).toEqual([]);
		expect(logLines(c).some(line => line.startsWith("exit fakeoff "))).toBe(true);

		expect((await h.mcp("connect fakeoff")).status.join("")).toContain("connected (1 tools active)");
		await settle();
		const spawnsBefore = spawnCount(c, "fakeoff");
		const re = await h.mcp("reconnect fakeoff");
		expect(re.status.join("")).toContain('MCP server "fakeoff" reconnected (1 tools).');
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
		await h.mcp("connect fakeoff");
		const sessionFile = h.session.sessionManager?.getSessionFile?.();
		await h.session.newSession();
		await settle();
		let status = (await h.mcp("status")).status.join("\n");
		expect(statusLine(status, "fakeoff")).toContain(" · disconnected · ");
		expect(mcpToolsOf(h.session.getAllToolNames(), "fakeoff")).toEqual([]);
		expect(logLines(c).some(line => line.startsWith("exit fakeoff "))).toBe(true);

		// a disconnected autoload server is restored after /new; control waits for that flight.
		await h.mcp("disconnect fakeon");
		expect(mcpToolsOf(h.session.getAllToolNames(), "fakeon")).toEqual([]);
		const transition = h.session.newSession();
		await transition;
		const immediate = await h.mcp("connect fakeoff");
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && h.session.getActiveToolNames().every((n: string) => !n.includes("fakeon")))
			await sleep(100);
		status = (await h.mcp("status")).status.join("\n");
		expect(statusLine(status, "fakeon")).toContain(" · connected · ");
		expect(mcpToolsOf(h.session.getActiveToolNames(), "fakeon").length).toBe(1);
		expect(mcpToolsOf(h.session.getActiveToolNames(), "fakeauto")).toEqual([]);
		// Either busy (restore flight still running) or connected (already settled) is a valid ordering.
		expect(immediate.warning.join("") + immediate.status.join("")).toMatch(/busy|connected/);
		if (immediate.status.length > 0) await h.mcp("disconnect fakeoff");

		// switchSession resets like newSession.
		await h.mcp("connect fakeoff");
		if (sessionFile && existsSync(sessionFile)) {
			await h.session.switchSession(sessionFile);
			await settle();
			status = (await h.mcp("status")).status.join("\n");
			expect(statusLine(status, "fakeoff")).toContain(" · disconnected · ");
		}

		// a second session in the same agentDir starts from mcp.json only.
		const spawnsBefore = spawnCount(c, "fakeoff");
		await openSession(c);
		await settle();
		expect(spawnCount(c, "fakeoff")).toBe(spawnsBefore);
		expect([sha(c.userMcp), sha(c.projectMcp)]).toEqual(before);
	}, 60_000);

	test("guarded results and failure rollback", async () => {
		const c = makeCase();
		writeStandard(c);
		const h = await openSession(c);

		const already = await h.mcp("connect fakeon");
		expect(already.warning.join("")).toContain("already connected");
		expect((await h.mcp("disconnect fakeoff")).warning.join("")).toContain("not connected");
		const unknown = await h.mcp("connect nosuch");
		expect(unknown.error.join("")).toContain("Unknown MCP server");
		expect(unknown.error.join("")).toContain("Usage");
		for (const name of ["fakedis", "fakedeny"])
			expect((await h.mcp(`connect ${name}`)).error.join("")).toContain("Change mcp.json");

		// (e) busy while admission is held
		let busy: { warning: string[] } | undefined;
		const startedAt = Date.now();
		await h.session.runWithPromptAdmissionForTests(async () => {
			busy = await h.mcp("connect fakeoff");
		});
		expect(Date.now() - startedAt).toBeLessThan(1000);
		expect(busy!.warning.join("")).toContain("busy");

		// (f) failing server leaves tools unchanged
		const activeBefore = [...h.session.getActiveToolNames()].sort();
		const allBefore = [...h.session.getAllToolNames()].sort();
		const failed = await h.mcp("connect fakefail");
		expect(failed.error.join("")).toContain("could not be connected");
		expect([...h.session.getActiveToolNames()].sort()).toEqual(activeBefore);
		expect([...h.session.getAllToolNames()].sort()).toEqual(allBefore);
		expect(statusLine((await h.mcp("status")).status.join("\n"), "fakefail")).toContain(" · failed · ");

		// (g) refresh failure rolls back the connection
		const original = h.session.refreshMCPTools;
		h.session.refreshMCPTools = async () => {
			h.session.refreshMCPTools = original;
			throw new Error("refresh failed");
		};
		const rolled = await h.mcp("connect fakeoff");
		expect(rolled.error.join("")).toContain("MCP connect failed.");
		await settle();
		expect([...h.session.getActiveToolNames()].sort()).toEqual(activeBefore);
		expect([...h.session.getAllToolNames()].sort()).toEqual(allBefore);
		expect(h.result.mcpManager.getConnectionStatus("fakeoff")).toBe("disconnected");
	}, 30_000);

	test("connect before deferred startup settles is busy", async () => {
		const c = makeCase();
		writeStandard(c);
		const h = await openSession(c, { start: false });
		const startedAt = Date.now();
		const out = await h.mcp("connect fakeoff");
		expect(Date.now() - startedAt).toBeLessThan(1000);
		expect(out.warning.join("")).toContain("busy");
		await h.result.startDeferredMcpConfig?.();
	}, 30_000);

	test("slash command surface and completions", async () => {
		const c = makeCase();
		writeStandard(c);
		const h = await openSession(c);
		const mcpCommand = h.commands(false).find((command: any) => command.name === "mcp");
		expect(mcpCommand).toBeDefined();
		const subs = (await mcpCommand.getArgumentCompletions("")).map((item: any) => item.value ?? item.label);
		expect(subs.map((value: string) => value.trim()).sort()).toEqual([
			"connect",
			"disconnect",
			"list",
			"reconnect",
			"status",
		]);
		const connect = await mcpCommand.getArgumentCompletions("connect ");
		expect(connect.map((item: any) => item.label).sort()).toEqual(
			["fakeflaky", "fakefail", "fakenotimeout", "fakeoff", "fakeslow"].sort(),
		);
		expect(connect.find((item: any) => item.label === "fakeoff").value).toBe("connect fakeoff");
		const disconnect = (await mcpCommand.getArgumentCompletions("disconnect ")).map((item: any) => item.label).sort();
		expect(disconnect).toEqual(["fakeauto", "fakeon"]);
		const reconnect = (await mcpCommand.getArgumentCompletions("reconnect ")).map((item: any) => item.label).sort();
		expect(reconnect).toEqual(["fakeauto", "fakeon"]);
		expect(h.commands(false, false).some((command: any) => command.name === "mcp")).toBe(false);

		// A session without the grant (subagent-style) keeps the stock surface.
		const c2 = makeCase();
		writeStandard(c2);
		const h2 = await openSession(c2, { session: { sessionMcpControls: false } });
		expect(h2.session.hasSessionMcpControls).toBe(false);
		expect(h2.commands(false).some((command: any) => command.name === "mcp")).toBe(false);
		expect((await h2.mcp("status")).returned).toEqual({ prompt: "/mcp status" });
	}, 30_000);

	test("only autoload:false servers creates an idle manager", async () => {
		const c = makeCase();
		writeMcp(c, c.userMcp, { fakeoff: { autoload: false } });
		const h = await openSession(c, { start: false });
		expect(h.result.startDeferredMcpConfig).toBeUndefined();
		expect(h.result.mcpManager).toBeDefined();
		expect(spawnCount(c, "fakeoff")).toBe(0);
		expect((await h.mcp("connect fakeoff")).status.join("")).toContain("connected (1 tools active)");
		await settle();
		expect(mcpToolsOf(h.session.getActiveToolNames(), "fakeoff").length).toBe(1);
	}, 30_000);

	test("all autoload servers fail at startup", async () => {
		const c = makeCase();
		writeMcp(c, c.userMcp, { fakefailauto: { args: ["--fail"] }, fakeoff: { autoload: false } });
		const h = await openSession(c, { start: false });
		const started = await h.result.startDeferredMcpConfig?.();
		expect(started?.hasErrors).toBe(true);
		expect((await h.mcp("connect fakeoff")).status.join("")).toContain("connected (1 tools active)");
		await settle();
		expect(mcpToolsOf(h.session.getActiveToolNames(), "fakeoff").length).toBe(1);
		expect(statusLine((await h.mcp("status")).status.join("\n"), "fakefailauto")).toContain(" · failed · ");
	}, 30_000);

	test("exact config sessions keep the native /mcp surface", async () => {
		const outputs: string[] = [];
		for (const sessionMcpControls of [false, true]) {
			const c = makeCase();
			const exact = join(c.base, "exact.json");
			writeMcp(c, exact, { fakeexact: {} });
			const h = await openSession(c, { session: { mcpConfigPath: exact, sessionMcpControls } });
			attachExactMcpControls(h.session, { grantSource: "root-interactive-exact-config", configPath: exact });
			expect(h.session.hasSessionMcpControls === true).toBe(false);
			const mcpCommand = h.commands(true).find((command: any) => command.name === "mcp");
			const subs = (mcpCommand.subcommands ?? []).map((sub: any) => sub.name).join(",");
			const status = (await h.mcp("status")).status.join("\n").replaceAll(c.base, "<base>");
			const unknown = await h.mcp("connect x");
			outputs.push(JSON.stringify({ subs, status, unknown: unknown.error.join("") + unknown.warning.join("") }));
		}
		expect(outputs[1]).toBe(outputs[0]);
		expect(outputs[0]).toContain("Unknown subcommand");
	}, 60_000);

	test("subagents inherit a full manager with connected tools", async () => {
		const c = makeCase();
		writeStandard(c);
		const h = await openSession(c);
		await h.mcp("connect fakeoff");
		expect(h.result.mcpManager.isToolsOnly()).toBe(false);
		expect(h.result.mcpManager.getTools().some((tool: any) => tool.mcpServerName === "fakeoff")).toBe(true);
	}, 30_000);

	test("slow servers finish connecting within the command", async () => {
		const c = makeCase();
		writeStandard(c);
		const h = await openSession(c);
		for (const name of ["fakeslow", "fakenotimeout"]) {
			const out = await h.mcp(`connect ${name}`);
			expect(out.status.join("")).toContain(`MCP server "${name}" connected (1 tools active).`);
			expect(mcpToolsOf(h.session.getActiveToolNames(), name).length).toBe(1);
		}
	}, 30_000);

	test("failed reconnect keeps stale tools", async () => {
		const c = makeCase();
		writeStandard(c);
		const h = await openSession(c);
		await h.mcp("connect fakeflaky");
		const before = mcpToolsOf(h.session.getAllToolNames(), "fakeflaky");
		const activeBefore = mcpToolsOf(h.session.getActiveToolNames(), "fakeflaky");
		writeFileSync(c.flag("flaky"), "");
		const startedAt = Date.now();
		const out = await h.mcp("reconnect fakeflaky");
		expect(Date.now() - startedAt).toBeLessThan(6500);
		expect(out.error.join("")).toContain("could not be reconnected");
		expect(mcpToolsOf(h.session.getAllToolNames(), "fakeflaky")).toEqual(before);
		expect(mcpToolsOf(h.session.getActiveToolNames(), "fakeflaky")).toEqual(activeBefore);
		expect(statusLine((await h.mcp("status")).status.join("\n"), "fakeflaky")).toContain(
			" · failed · autoload off · 1 tools",
		);
		const mcpCommand = h.commands(false).find((command: any) => command.name === "mcp");
		expect((await mcpCommand.getArgumentCompletions("reconnect ")).map((item: any) => item.label)).toContain(
			"fakeflaky",
		);
		await h.mcp("disconnect fakeflaky");
		expect(mcpToolsOf(h.session.getAllToolNames(), "fakeflaky")).toEqual([]);
		expect(statusLine((await h.mcp("status")).status.join("\n"), "fakeflaky")).toContain(" · disconnected · ");
	}, 30_000);

	test("undeclared, shared and frozen managers", async () => {
		const c = makeCase();
		writeStandard(c);
		writeMcp(c, c.userMcp, {
			fakeon: {},
			fakeshared: { autoload: false, sharing: "shared" },
		});
		const h = await openSession(c);
		// A native `sharing: "shared"` entry connects like any other server.
		expect((await h.mcp("connect fakeshared")).status.join("")).toContain("connected");
		const sharedTools = mcpToolsOf(h.session.getActiveToolNames(), "fakeshared");
		const shared = await h.mcp("reconnect fakeshared");
		// 0.19.0's native mcp.json provider (discovery/builtin.ts) drops `sharing`, so a
		// native `sharing: "shared"` entry is per-session and reconnects normally. The
		// shared-pool `unavailable` branch stays defensive for a future provider change.
		const loaded = await loadAllMCPConfigs(c.cwd, {
			agentDir: c.agentDir,
			enableProjectConfig: true,
			autoloadOnly: false,
			includeDisabled: true,
			nativeOnly: true,
		});
		expect(loaded.configs.fakeshared?.sharing).toBeUndefined();
		expect(shared.status.join("")).toContain("reconnected");
		expect(spawnCount(c, "fakeshared")).toBe(2);
		expect(mcpToolsOf(h.session.getActiveToolNames(), "fakeshared")).toEqual(sharedTools);

		// a connected server removed from mcp.json is undeclared
		expect((await h.mcp("connect fakeoff")).status.join("")).toContain("connected");
		writeMcp(c, c.projectMcp, {});
		const status = (await h.mcp("status")).status.join("\n");
		expect(statusLine(status, "fakeoff")).toMatch(/· connected · autoload off · 1 tools · not in mcp\.json$/);
		expect((await h.mcp("reconnect fakeoff")).warning.join("")).toContain("no longer in mcp.json");
		expect((await h.mcp("disconnect fakeoff")).status.join("")).toContain("disconnected");

		// frozen connection sets are unavailable
		h.result.mcpManager.freezeConnectionSet();
		expect((await h.mcp("connect fakeoff")).error.join("")).toContain("MCP controls are not available");
		const frozenStatus = (await h.mcp("status")).status.join("\n");
		expect(frozenStatus).toContain("MCP controls are not available in this session.");
	}, 30_000);

	test("retained failed autoload server is not restored", async () => {
		const c = makeCase();
		writeMcp(c, c.userMcp, { fakeon: {}, fakefailauto: { args: ["--fail"] } });
		const h = await openSession(c, { start: false });
		const started = await h.result.startDeferredMcpConfig?.();
		expect(started?.hasErrors).toBe(true);
		expect(h.result.mcpManager.getAllServerNames()).toContain("fakefailauto");
		expect((await h.mcp("disconnect fakefailauto")).warning.join("")).toContain("not connected");
		expect((await h.mcp("reconnect fakefailauto")).warning.join("")).toContain("not connected");
		expect(statusLine((await h.mcp("status")).status.join("\n"), "fakefailauto")).toContain(" · failed · ");
		expect(mcpToolsOf(h.session.getActiveToolNames(), "fakeon").length).toBe(1);
		const spawns = spawnCount(c, "fakefailauto");
		await h.session.newSession();
		const after = await h.mcp("disconnect fakefailauto");
		expect(after.warning.join("")).toContain("not connected");
		await settle();
		expect(spawnCount(c, "fakefailauto")).toBe(spawns);
	}, 30_000);
});
