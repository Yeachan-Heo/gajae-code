// Shared harness for the session MCP control tests: a temporary agent dir and
// project with native mcp.json files, and a root session created the way the
// interactive CLI creates it (deferred startup + session MCP controls).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "../../../src/config/settings";
import { issueSessionMcpControlGrant } from "../../../src/runtime-mcp/session-controls-grant";
import { type CreateAgentSessionOptions, createAgentSession } from "../../../src/sdk/session";

const fakeServer = join(import.meta.dir, "session-mcp-fake-server.ts");

export type ServerSpec = { args?: string[]; autoload?: boolean; enabled?: boolean; sharing?: string; timeout?: number };
export type Case = {
	base: string;
	agentDir: string;
	cwd: string;
	log: string;
	userMcp: string;
	projectMcp: string;
	flag: (name: string) => string;
};
export type SessionHarness = Awaited<ReturnType<typeof openSession>>;

const cleanups: Array<() => Promise<void> | void> = [];

/** Call from `afterEach`: disposes sessions and removes temporary directories. */
export async function runCleanups(): Promise<void> {
	for (const cleanup of cleanups.splice(0).reverse()) {
		try {
			await cleanup();
		} catch {
			/* best effort */
		}
	}
}

export function makeCase(): Case {
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
	// Startup waits only briefly for undeclared timeouts; a loaded test machine can miss
	// that window, so autoload servers declare one unless the test sets its own.
	const timeout = spec.timeout ?? (spec.autoload === false ? undefined : 15_000);
	if (timeout !== undefined) config.timeout = timeout;
	return config;
}

export function writeMcp(
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

/**
 * Standard declaration set:
 * - fakeon, fakeauto: autoload servers (fakeon is a discovery default, fakeauto stays behind tool search)
 * - fakeoff (project): autoload:false, hangs on init while the `hang` flag exists
 * - fakefail / fakeslow / fakenotimeout / fakeflaky: autoload:false failure and timing cases
 * - fakedis (enabled:false) and fakedeny (disabledServers): refused declarations
 */
export function writeStandard(c: Case): void {
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

export function logLines(c: Case): string[] {
	return readFileSync(c.log, "utf8").split("\n").filter(Boolean);
}

export function spawnCount(c: Case, name: string): number {
	return logLines(c).filter(line => line.startsWith(`spawn ${name} `)).length;
}

export function mcpToolsOf(names: readonly string[], server: string): string[] {
	return names.filter(name => name.startsWith("mcp_") && name.includes(server));
}

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Let background disconnects and tool refreshes land. */
export async function settle(): Promise<void> {
	await sleep(400);
}

export function sha(path: string): string {
	return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "missing";
}

export async function openSession(
	c: Case,
	options: { settings?: Record<string, unknown>; start?: boolean; session?: Partial<CreateAgentSessionOptions> } = {},
) {
	const settingValues: Record<string, unknown> = {
		"mcp.enableProjectConfig": true,
		"mcp.discoveryMode": true,
		"mcp.discoveryDeferAutoload": true,
		"mcp.discoveryDefaultServers": ["fakeon"],
		...(options.settings ?? {}),
	};
	// An explicit `undefined` means "leave the setting unset" (schema default).
	for (const key of Object.keys(settingValues)) if (settingValues[key] === undefined) delete settingValues[key];
	const result = await createAgentSession({
		cwd: c.cwd,
		agentDir: c.agentDir,
		settings: Settings.isolated(settingValues),
		disableExtensionDiscovery: true,
		enableLsp: false,
		skipPythonPreflight: true,
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		hasUI: false,
		sessionMcpControlGrant: issueSessionMcpControlGrant(),
		deferMcpConfigStartup: true,
		...(options.session ?? {}),
	});
	const session = result.session;
	cleanups.push(async () => {
		await session.dispose();
		await sleep(150);
	});
	if (options.start !== false) await result.startDeferredMcpConfig?.();
	return { result, session };
}
