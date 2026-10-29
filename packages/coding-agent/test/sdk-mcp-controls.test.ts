import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { type CreateAgentSessionResult, createAgentSession } from "@gajae-code/coding-agent/sdk";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";

const cleanups: Array<() => Promise<void>> = [];
const secret = "fixture-only-private-header";
type Manager = NonNullable<CreateAgentSessionResult["mcpManager"]>;

/** Only a public factory session, owned config, and deterministic loopback MCP traffic. */
async function fixture() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-mcp-controls-"));
	const counters = new Map<string, { initializes: number; deletes: number }>();
	const failures = new Set<string>();
	const gates = new Map<string, { entered: () => void; wait: Promise<void>; release: () => void }>();
	const releases = new Set<() => void>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const name = new URL(request.url).pathname.slice(1);
			let counts = counters.get(name);
			if (!counts) {
				counts = { initializes: 0, deletes: 0 };
				counters.set(name, counts);
			}
			if (request.method === "DELETE") {
				counts.deletes++;
				const gate = gates.get(`delete:${name}`);
				if (gate) {
					gates.delete(`delete:${name}`);
					gate.entered();
					await gate.wait;
				}
				return new Response(null, { status: 204 });
			}
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const body = (await request.json()) as { id?: number; method: string };
			if (body.id === undefined) return new Response(null, { status: 202 });
			if (body.method === "initialize") {
				counts.initializes++;
				const gate = gates.get(name);
				if (gate) {
					gates.delete(name);
					gate.entered();
					await gate.wait;
				}
				if (failures.has(name))
					return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: secret } });
				return Response.json(
					{
						jsonrpc: "2.0",
						id: body.id,
						result: {
							protocolVersion: "2025-03-26",
							capabilities: { tools: {} },
							serverInfo: { name, version: "1" },
						},
					},
					{ headers: { "Mcp-Session-Id": `${name}-${counts.initializes}` } },
				);
			}
			if (body.method === "tools/list")
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						tools: [
							{ name: "hello", description: "Local fixture", inputSchema: { type: "object", properties: {} } },
						],
					},
				});
			return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
		},
	});
	const config = (endpoint: string) => ({
		type: "http" as const,
		url: `${server.url}${endpoint}`,
		protocol: "legacy" as const,
		timeout: 1_000,
		headers: { Authorization: `Bearer ${secret}` },
	});
	const configs = { alpha: config("alpha"), beta: config("beta") };
	await Bun.write(path.join(directory, "mcp.json"), JSON.stringify({ mcpServers: configs }));
	await setModelPresetRegistryDisabled({ agentDir: directory, disabled: true });
	const settings = Settings.isolated({
		"mcp.enableProjectConfig": false,
		"compaction.enabled": false,
		"todo.enabled": false,
	});
	const auth = await AuthStorage.create(path.join(directory, "auth.db"));
	const registry = new ModelRegistry(auth, path.join(directory, "models.yml"), settings, { agentDir: directory });
	let result: CreateAgentSessionResult | undefined;
	cleanups.push(async () => {
		for (const release of releases) release();
		await result?.session.dispose();
		await registry.dispose();
		await settings.close();
		auth.close();
		server.stop(true);
		await fs.rm(directory, { recursive: true, force: true });
	});
	result = await createAgentSession({
		cwd: directory,
		agentDir: directory,
		authStorage: auth,
		modelRegistry: registry,
		settings,
		sessionManager: SessionManager.inMemory(directory),
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableLsp: false,
		toolNames: [],
	});
	const manager = result.mcpManager;
	if (!manager) throw new Error("Public factory did not return its conventional MCP manager");
	function block(name: string) {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		releases.add(() => release.resolve());
		gates.set(name, { entered: () => entered.resolve(), wait: release.promise, release: () => release.resolve() });
		return { entered: entered.promise, release: () => release.resolve() };
	}
	return {
		result,
		manager,
		counters,
		failures,
		config,
		configs,
		blockNextInitialize: block,
		blockNextDelete(name: string) {
			return block(`delete:${name}`);
		},
	};
}

function row(manager: Manager, name = "alpha") {
	const found = manager.getServerControlSnapshot().find(server => server.target.name === name);
	if (!found) throw new Error(`Missing fixture server ${name}`);
	return found;
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Owned MCP catalog publication did not settle");
		await Bun.sleep(10);
	}
}

afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});

describe("public SDK generation-fenced MCP controls", () => {
	test("real suspend/resume/reconnect updates physical sessions and the session catalog without touching beta", async () => {
		const f = await fixture();
		const alpha = row(f.manager);
		const betaConnection = f.manager.getConnection("beta");
		const betaInitializes = f.counters.get("beta")!.initializes;
		expect(alpha).toMatchObject({
			state: "connected",
			toolCount: 1,
			scope: "manager",
			controls: ["suspend", "reconnect"],
		});
		expect(JSON.stringify(f.manager.getServerControlSnapshot())).not.toContain(secret);
		const before = f.result.session.sessionLifecycle.generation;
		await f.result.session.withMcpControlAdmission(before, signal =>
			f.manager.controlServer(alpha.target, "suspend", { signal }),
		);
		expect(row(f.manager)).toMatchObject({ state: "suspended", toolCount: 0, controls: ["resume"] });
		expect(f.manager.getConnection("alpha")).toBeUndefined();
		await waitFor(() => !f.result.session.getAllToolNames().includes("mcp__alpha_hello"));
		expect(f.counters.get("alpha")!.deletes).toBeGreaterThan(0);
		await f.result.session.withMcpControlAdmission(before, signal =>
			f.manager.controlServer(row(f.manager).target, "resume", { signal }),
		);
		expect(row(f.manager)).toMatchObject({ state: "connected", toolCount: 1 });
		await waitFor(() => f.result.session.getAllToolNames().includes("mcp__alpha_hello"));
		const initializations = f.counters.get("alpha")!.initializes;
		await f.manager.controlServer(row(f.manager).target, "reconnect");
		expect(f.counters.get("alpha")!.initializes).toBe(initializations + 1);
		expect(f.manager.getConnection("beta")).toBe(betaConnection);
		expect(f.counters.get("beta")!.initializes).toBe(betaInitializes);
		expect(f.result.session.sessionLifecycle.generation).toBe(before);
	}, 30_000);

	test("manager-issued binding rejects foreign and guessed targets at its own fence", async () => {
		const f = await fixture();
		const foreign = await fixture();
		const target = row(f.manager).target;
		const connection = f.manager.getConnection("alpha");
		await expect(f.manager.controlServer(row(foreign.manager).target, "suspend")).rejects.toMatchObject({
			code: "stale_target",
		});
		await expect(f.manager.controlServer({ ...target, binding: "guessed" }, "suspend")).rejects.toMatchObject({
			code: "stale_target",
		});
		await expect(
			f.manager.controlServer({ ...target, generation: target.generation + 1 }, "suspend"),
		).rejects.toMatchObject({ code: "stale_target" });
		expect(f.manager.getConnection("alpha")).toBe(connection);
	}, 30_000);

	test("removal, config replacement, and A-B-A never revive an old target", async () => {
		const f = await fixture();
		const a = row(f.manager).target;
		const beta = f.manager.getConnection("beta");
		await f.manager.disconnectServer("alpha");
		await expect(f.manager.controlServer(a, "reconnect")).rejects.toMatchObject({ code: "stale_target" });
		await f.manager.connectServers({ alpha: f.config("replacement"), beta: f.configs.beta }, {});
		const b = row(f.manager).target;
		expect(b.generation).toBeGreaterThan(a.generation);
		await expect(f.manager.controlServer(a, "suspend")).rejects.toMatchObject({ code: "stale_target" });
		await f.manager.disconnectServer("alpha");
		await f.manager.connectServers(f.configs, {});
		const successor = row(f.manager).target;
		expect(successor.generation).toBeGreaterThan(b.generation);
		for (const stale of [a, b])
			await expect(f.manager.controlServer(stale, "suspend")).rejects.toMatchObject({ code: "stale_target" });
		expect(f.manager.getConnection("alpha")?.config).toMatchObject({ url: f.configs.alpha.url });
		expect(f.manager.getConnection("beta")).toBe(beta);
	}, 30_000);

	test("reconnect reserves at SDK admission; parallel and stale mutations cannot slip past an await", async () => {
		const f = await fixture();
		const old = row(f.manager).target;
		const gate = f.blockNextInitialize("alpha");
		const pending = f.manager.controlServer(old, "reconnect");
		try {
			await gate.entered;
			await expect(f.manager.controlServer(old, "suspend")).rejects.toMatchObject({ code: "stale_target" });
			await expect(f.manager.controlServer(row(f.manager).target, "suspend")).rejects.toMatchObject({
				code: "busy",
			});
			await expect(f.manager.disconnectServer("alpha")).rejects.toMatchObject({ code: "busy" });
			await expect(f.manager.connectServers(f.configs, {})).rejects.toMatchObject({ code: "busy" });
		} finally {
			gate.release();
		}
		expect(await pending).toMatchObject({ status: "reconnected", cleanup: "not_certified" });
		expect(row(f.manager).state).toBe("connected");
	}, 30_000);

	test("backend failure and cancellation do not report successful reconnection", async () => {
		const f = await fixture();
		const beta = f.manager.getConnection("beta");
		f.failures.add("alpha");
		const failure = f.manager.controlServer(row(f.manager).target, "reconnect");
		await expect(failure).rejects.toMatchObject({ code: "unknown_effect" });
		expect(row(f.manager).state).not.toBe("connected");
		expect(f.manager.getConnection("beta")).toBe(beta);
		f.failures.delete("alpha");
		const gate = f.blockNextInitialize("alpha");
		const abort = new AbortController();
		const cancelled = f.manager.controlServer(row(f.manager).target, "reconnect", { signal: abort.signal });
		try {
			await gate.entered;
			abort.abort();
		} finally {
			gate.release();
		}
		await expect(cancelled).rejects.toMatchObject({ code: "unknown_effect" });
		expect(f.manager.getConnection("beta")).toBe(beta);
	}, 30_000);

	test("an old release cannot reconnect or delete a lifecycle successor installed during its await", async () => {
		const f = await fixture();
		const old = row(f.manager).target;
		const gate = f.blockNextDelete("alpha");
		const pending = f.manager.controlServer(old, "reconnect");
		const outcome = pending.then(
			value => ({ status: "fulfilled" as const, value }),
			(error: unknown) => ({ status: "rejected" as const, error }),
		);
		let successor = f.manager.getConnection("alpha");
		try {
			expect(await Promise.race([gate.entered.then(() => "entered" as const), outcome])).toBe("entered");
			await f.manager.disconnectAll();
			await f.manager.connectServers({ alpha: f.config("replacement"), beta: f.configs.beta }, {});
			successor = f.manager.getConnection("alpha");
			expect(successor).toBeDefined();
		} finally {
			gate.release();
		}
		expect(await outcome).toMatchObject({ status: "rejected", error: { code: "unknown_effect" } });
		expect(f.manager.getConnection("alpha")).toBe(successor);
		expect(f.manager.getConnection("alpha")?.config).toMatchObject({ url: f.config("replacement").url });
		await expect(f.manager.controlServer(old, "suspend")).rejects.toMatchObject({ code: "stale_target" });
		expect(row(f.manager).target.generation).toBeGreaterThan(old.generation);
	}, 30_000);
});
