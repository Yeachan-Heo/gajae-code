/**
 * The interactive `/mcp` surface for sessions holding the session MCP control
 * capability: status rendering, result messages, usage errors and argument
 * completion. Sessions without the capability keep the pristine namespace, and
 * exact --mcp-config sessions keep their own `/mcp`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AutocompleteItem } from "@gajae-code/tui";
import { getBuiltinSlashCommandsForSession } from "../../src/extensibility/slash-commands";
import { attachExactMcpControls } from "../../src/runtime-mcp/redaction";
import { issueSessionMcpControlGrant } from "../../src/runtime-mcp/session-controls-grant";
import { type BuiltinSlashCommandRuntime, lookupBuiltinSlashCommand } from "../../src/slash-commands/builtin-registry";
import {
	type Case,
	makeCase,
	openSession,
	runCleanups,
	type SessionHarness,
	spawnCount,
	writeMcp,
	writeStandard,
} from "./fixtures/session-mcp-harness";

// Disposing a session can wait for an in-flight MCP connect; allow for a loaded machine.
afterEach(runCleanups, 20_000);

type Output = { status: string; warning: string; error: string; returned: unknown };

async function runMcp(h: SessionHarness, args: string): Promise<Output> {
	const out: Output = { status: "", warning: "", error: "", returned: undefined };
	const runtime = {
		ctx: {
			session: h.session,
			editor: { setText: () => {} },
			showStatus: (text: string) => {
				out.status += text;
			},
			showWarning: (text: string) => {
				out.warning += text;
			},
			showError: (text: string) => {
				out.error += text;
			},
		},
	} as unknown as BuiltinSlashCommandRuntime;
	const handler = lookupBuiltinSlashCommand("mcp")?.handleTui;
	if (!handler) throw new Error("/mcp builtin is not registered");
	out.returned = await handler({ name: "mcp", args, text: args ? `/mcp ${args}` : "/mcp" }, runtime);
	return out;
}

async function completions(h: SessionHarness, prefix: string): Promise<AutocompleteItem[]> {
	const command = getBuiltinSlashCommandsForSession(false, h.session).find(item => item.name === "mcp");
	if (!command?.getArgumentCompletions) throw new Error("/mcp has no argument completions");
	return (await command.getArgumentCompletions(prefix)) ?? [];
}

const STATUS_LINE =
	/^ {2}\S+ · (global|project) · (connected|connecting|disconnected|disabled|failed) · autoload (on|off) · \d+ tools( · not in mcp\.json)?$/;

function statusLine(text: string, name: string): string | undefined {
	return text.split("\n").find(line => line.startsWith(`  ${name} · `));
}

async function standardSession(settings?: Record<string, unknown>): Promise<{ c: Case; h: SessionHarness }> {
	const c = makeCase();
	writeStandard(c);
	return { c, h: await openSession(c, { settings }) };
}

describe("/mcp in sessions with session MCP controls", () => {
	test("status, list and bare /mcp render one row per server", async () => {
		const { h } = await standardSession();
		const [status, list, bare] = [await runMcp(h, "status"), await runMcp(h, "list"), await runMcp(h, "")];
		expect(list.status).toBe(status.status);
		expect(bare.status).toBe(status.status);
		const [header, ...rows] = status.status.split("\n");
		expect(header).toBe("MCP servers (this session):");
		for (const row of rows) expect(row).toMatch(STATUS_LINE);
		expect(statusLine(status.status, "fakeon")).toBe("  fakeon · global · connected · autoload on · 1 tools");
		expect(statusLine(status.status, "fakeoff")).toBe("  fakeoff · project · disconnected · autoload off · 0 tools");
		expect(statusLine(status.status, "fakedis")).toContain(" · disabled · ");
		expect(statusLine(status.status, "fakedeny")).toContain(" · disabled · ");
		expect((await runMcp(h, "status extra")).error).toBe("Usage: /mcp status");
	}, 30_000);

	test("connect, disconnect and reconnect report the result", async () => {
		const { h } = await standardSession();
		expect((await runMcp(h, "connect fakeoff")).status).toBe('MCP server "fakeoff" connected (1 tools active).');
		expect((await runMcp(h, "reconnect fakeoff")).status).toBe('MCP server "fakeoff" reconnected (1 tools).');
		expect((await runMcp(h, "disconnect fakeoff")).status).toBe(
			'MCP server "fakeoff" disconnected; its tools were removed for this session.',
		);
	}, 30_000);

	test("refusals and usage errors", async () => {
		const { c, h } = await standardSession();
		expect((await runMcp(h, "connect fakeon")).warning).toBe('MCP server "fakeon" is already connected.');
		expect((await runMcp(h, "disconnect fakeoff")).warning).toBe('MCP server "fakeoff" is not connected.');
		expect((await runMcp(h, "connect nosuch")).error).toBe(
			"Unknown MCP server: nosuch. Usage: /mcp [status|list|connect <name>|disconnect <name>|reconnect <name>]",
		);
		for (const name of ["fakedis", "fakedeny"]) {
			expect((await runMcp(h, `connect ${name}`)).error).toBe(
				`MCP server "${name}" is disabled. Change mcp.json to enable it, then run /mcp connect again.`,
			);
		}
		expect((await runMcp(h, "connect")).error).toBe("Server name required. Usage: /mcp connect <name>");
		expect((await runMcp(h, "connect a b")).error).toBe("Server name required. Usage: /mcp connect <name>");
		expect((await runMcp(h, "reload")).error).toContain("Unknown subcommand: reload.");
		expect(spawnCount(c, "fakedis") + spawnCount(c, "fakedeny")).toBe(0);

		const { c: c2, h: h2 } = await standardSession({ "mcp.enableProjectConfig": undefined });
		expect((await runMcp(h2, "connect fakeoff")).error).toBe(
			"Project stdio servers need mcp.enableProjectConfig: true in the user config.",
		);
		expect(spawnCount(c2, "fakeoff")).toBe(0);
	}, 30_000);

	test("busy sessions and failures", async () => {
		const { c, h } = await standardSession();
		let busy: Output | undefined;
		await h.session.runWithPromptAdmissionForTests(async () => {
			busy = await runMcp(h, "connect fakeoff");
		});
		expect(busy?.warning).toBe("MCP connect is unavailable while this session is busy.");

		expect((await runMcp(h, "connect fakefail")).error).toBe(
			'MCP server "fakefail" could not be connected; session tools are unchanged.',
		);

		await runMcp(h, "connect fakeflaky");
		writeFileSync(c.flag("flaky"), "");
		expect((await runMcp(h, "reconnect fakeflaky")).error).toBe(
			'MCP server "fakeflaky" could not be reconnected; its previous tools stay listed.',
		);

		const original = h.session.refreshMCPTools;
		h.session.refreshMCPTools = async () => {
			h.session.refreshMCPTools = original;
			throw new Error("refresh failed");
		};
		expect((await runMcp(h, "connect fakeoff")).error).toBe("MCP connect failed.");
	}, 30_000);

	test("undeclared servers and frozen managers", async () => {
		const { c, h } = await standardSession();
		await runMcp(h, "connect fakeoff");
		writeMcp(c, c.projectMcp, {});
		expect(statusLine((await runMcp(h, "status")).status, "fakeoff")).toBe(
			"  fakeoff · project · connected · autoload off · 1 tools · not in mcp.json",
		);
		expect((await runMcp(h, "reconnect fakeoff")).warning).toBe(
			'MCP server "fakeoff" is no longer in mcp.json; only /mcp disconnect is available.',
		);
		await runMcp(h, "disconnect fakeoff");

		h.result.mcpManager?.freezeConnectionSet();
		expect((await runMcp(h, "connect fakeon")).error).toBe("MCP controls are not available in this session.");
		expect((await runMcp(h, "status")).status).toContain("MCP controls are not available in this session.");
	}, 30_000);

	test("argument completion lists subcommands and eligible servers", async () => {
		const { h } = await standardSession();
		const labels = (items: AutocompleteItem[]) => items.map(item => item.label).sort();
		expect((await completions(h, "")).map(item => item.value.trim()).sort()).toEqual([
			"connect",
			"disconnect",
			"list",
			"reconnect",
			"status",
		]);
		const connect = await completions(h, "connect ");
		expect(labels(connect)).toEqual(["fakefail", "fakeflaky", "fakenotimeout", "fakeoff", "fakeslow"]);
		expect(connect.find(item => item.label === "fakeoff")).toMatchObject({
			value: "connect fakeoff",
			description: "project · disconnected · autoload off",
		});
		expect(labels(await completions(h, "connect fakes"))).toEqual(["fakeslow"]);
		expect(labels(await completions(h, "disconnect "))).toEqual(["fakeauto", "fakeon"]);
		expect(labels(await completions(h, "reconnect "))).toEqual(["fakeauto", "fakeon"]);
	}, 30_000);
});

describe("/mcp completion with untrusted server names", () => {
	test("names outside the mcp.json name pattern are never offered", async () => {
		const c = makeCase();
		const hostile = "evil\u001b[2J\u001b]0;spoof\u0007";
		writeMcp(c, c.userMcp, { fakeon: {} });
		writeMcp(c, c.projectMcp, { fakeoff: { autoload: false }, [hostile]: { autoload: false } });
		const h = await openSession(c);
		const status = await h.session.getSessionMcpStatusSnapshot();
		expect(status?.servers.some(server => server.name === hostile)).toBe(true);
		const offered = await completions(h, "connect ");
		expect(offered.map(item => item.label)).toEqual(["fakeoff"]);
		for (const item of [...offered, ...(await completions(h, "connect e"))]) {
			expect(`${item.value}${item.label}${item.description ?? ""}`).not.toMatch(/[\u0000-\u001f\u007f]/);
		}
		expect((await runMcp(h, "status")).status).not.toContain("\u001b");
	}, 30_000);
});

describe("/mcp outside the session MCP control capability", () => {
	test("sessions without the grant keep the pristine namespace", async () => {
		const c = makeCase();
		writeStandard(c);
		const h = await openSession(c, { session: { sessionMcpControlGrant: undefined } });
		expect(getBuiltinSlashCommandsForSession(false, h.session).some(item => item.name === "mcp")).toBe(false);
		expect(getBuiltinSlashCommandsForSession(false).some(item => item.name === "mcp")).toBe(false);
		expect((await runMcp(h, "status")).returned).toEqual({ prompt: "/mcp status" });
		expect((await runMcp(h, "connect fakeoff")).returned).toEqual({ prompt: "/mcp connect fakeoff" });
		expect(spawnCount(c, "fakeoff")).toBe(0);
	}, 30_000);

	test("exact --mcp-config sessions keep the native /mcp surface", async () => {
		const outputs: string[] = [];
		for (const sessionMcpControlGrant of [undefined, issueSessionMcpControlGrant()]) {
			const c = makeCase();
			const exact = join(c.base, "exact.json");
			writeMcp(c, exact, { fakeexact: {} });
			const h = await openSession(c, { session: { mcpConfigPath: exact, sessionMcpControlGrant } });
			attachExactMcpControls(h.session, { grantSource: "root-interactive-exact-config", configPath: exact });
			const command = getBuiltinSlashCommandsForSession(true, h.session).find(item => item.name === "mcp");
			const subcommands = (command?.subcommands ?? []).map(item => item.name).join(",");
			const status = (await runMcp(h, "status")).status.replaceAll(c.base, "<base>");
			const unknown = await runMcp(h, "connect x");
			outputs.push(JSON.stringify({ subcommands, status, unknown: unknown.error + unknown.warning }));
		}
		expect(outputs[1]).toBe(outputs[0]);
		expect(outputs[0]).toContain("Unknown subcommand");
	}, 60_000);
});
