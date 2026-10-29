import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createAgentSession, type CreateAgentSessionResult, type ExtensionFactory } from "@gajae-code/coding-agent/sdk";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { createDesktopMcpController, DESKTOP_MCP_LIMITS, type DesktopMcpController } from "../src/mcp-controls";

const cleanups: Array<() => Promise<void>> = [];
const secret = "owned-fixture-mcp-secret";
type Manager = NonNullable<CreateAgentSessionResult["mcpManager"]>;
interface Gate { entered(): void; wait: Promise<void>; release(): void }

/** Real factory/session/manager. All MCP traffic is deterministic and loopback-only. */
async function fixture(options: {
	manager?: Manager; disabled?: boolean; count?: number; distinctToolCounts?: boolean; redact?: (text: string) => string; extensions?: ExtensionFactory[];
} = {}) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-mcp-"));
	const counts = new Map<string, { initializes: number; deletes: number; httpMethods: string[]; rpcMethods: string[] }>();
	const failures = new Set<string>();
	const gates = new Map<string, Gate>();
	const releases = new Set<() => void>();
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
		async fetch(request) {
			const name = new URL(request.url).pathname.slice(1);
			let counter = counts.get(name);
			if (!counter) { counter = { initializes: 0, deletes: 0, httpMethods: [], rpcMethods: [] }; counts.set(name, counter); }
			if (counter.httpMethods.length < 32) counter.httpMethods.push(request.method);
			if (request.method === "DELETE") { counter.deletes++; return new Response(null, { status: 204 }); }
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const body = await request.json() as { id?: number; method: string };
			if (counter.rpcMethods.length < 32) counter.rpcMethods.push(
				typeof body.method === "string" && /^[a-zA-Z][a-zA-Z0-9_/-]{0,127}$/.test(body.method) ? body.method : "invalid_method",
			);
			if (body.id === undefined) {
				if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
				// JSON-RPC notifications never receive a response, including unknown methods.
				return new Response(null, { status: 202 });
			}
			if (body.method === "initialize") {
				counter.initializes++;
				const gate = gates.get(name);
				if (gate) { gates.delete(name); gate.entered(); await gate.wait; }
				if (failures.has(name)) return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: secret } });
				return Response.json({ jsonrpc: "2.0", id: body.id, result: {
					protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name, version: "1" },
				} }, { headers: { "Mcp-Session-Id": `${name}-${counter.initializes}` } });
			}
			if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: {
				tools: Array.from({ length: options.distinctToolCounts && name === "server1" ? 2 : 1 }, (_, index) => ({
					name: `hello${index}`, description: secret, inputSchema: { type: "object", properties: {} },
				})),
			} });
			return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
		},
	});
	const config = (endpoint: string) => ({ type: "http" as const, protocol: "legacy" as const, autoload: true,
		url: `${server.url}${endpoint}?token=${secret}`, timeout: 1_000, headers: { Authorization: `Bearer ${secret}` } });
	const configs = Object.fromEntries(Array.from({ length: options.count ?? 2 }, (_, index) => [`server${index}`, config(`server${index}`)]));
	await Bun.write(path.join(directory, "mcp.json"), JSON.stringify({ mcpServers: configs }));
	await setModelPresetRegistryDisabled({ agentDir: directory, disabled: true });
	const settings = Settings.isolated({ "mcp.enableProjectConfig": false, "compaction.enabled": false, "todo.enabled": false });
	const auth = await AuthStorage.create(path.join(directory, "auth.db"));
	const registry = new ModelRegistry(auth, path.join(directory, "models.yml"), settings, { agentDir: directory });
	let result: CreateAgentSessionResult | undefined;
	const controllers: DesktopMcpController[] = [];
	cleanups.push(async () => {
		for (const release of releases) release();
		for (const controller of controllers) controller.dispose();
		await result?.session.dispose();
		await registry.dispose();
		await settings.close();
		auth.close();
		server.stop(true);
		await fs.rm(directory, { recursive: true, force: true });
	});
	result = await createAgentSession({ cwd: directory, agentDir: directory, authStorage: auth, modelRegistry: registry, settings,
		sessionManager: SessionManager.inMemory(directory), model: getBundledModel("openai", "gpt-4o-mini"),
		...(options.manager ? { mcpManager: options.manager } : {}), enableMcpAutoload: !options.disabled,
		disableExtensionDiscovery: true, extensions: options.extensions, skills: [], contextFiles: [], promptTemplates: [], slashCommands: [], enableLsp: false, toolNames: [],
	});
	const capturedResult = result;
	function controller(connectionGeneration: string = crypto.randomUUID(), redact = options.redact ?? ((text: string) => text.replaceAll(secret, "[redacted]"))) {
		const value = createDesktopMcpController(capturedResult, { connectionGeneration, redact });
		controllers.push(value);
		return value;
	}
	function gate() {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		releases.add(() => release.resolve());
		return { gate: { entered: () => entered.resolve(), wait: release.promise, release: () => release.resolve() },
			entered: entered.promise, release: () => release.resolve() };
	}
	return { result, auth, counts, failures, configs, config, controller, primary: controller(),
		blockNextInitialize(name = "server0") { const value = gate(); gates.set(name, value.gate); return value; },
	};
}

function server(controller: DesktopMcpController, index = 0) {
	const snapshot = controller.getSnapshot();
	if (!snapshot.available || !snapshot.servers[index]) throw new Error("Missing genuine MCP fixture snapshot");
	return snapshot.servers[index]!;
}

afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
	vi.restoreAllMocks();
});

describe("desktop factory-bound MCP controls", () => {
	test("projects bounded safe data and performs actual suspend/resume/reconnect with no beta effects", async () => {
		const f = await fixture();
		const manager = f.result.mcpManager!;
		expect({ managerPresent: Boolean(manager), requests: [...f.counts] }).toMatchObject({ managerPresent: true });
		const beta = manager.getConnection("server1");
		const snapshot = f.primary.getSnapshot();
		expect(snapshot).toMatchObject({ available: true, scope: "factory_manager_may_be_shared", truncated: false });
		const serialized = JSON.stringify(snapshot);
		for (const privateValue of [secret, "Authorization", "Bearer", f.configs.server0!.url, "binding", manager.getServerControlSnapshot()[0]!.target.binding])
			expect(serialized).not.toContain(privateValue);
		const before = f.counts.get("server0")!.initializes;
		const ref = server(f.primary).ref;
		expect(await f.primary.operate(ref, "suspend")).toMatchObject({ status: "suspended", cleanup: "not_certified" });
		expect(server(f.primary)).toMatchObject({ state: "suspended", controls: ["resume"], toolCount: 0 });
		expect(manager.getConnection("server0")).toBeUndefined();
		expect((await f.primary.operate(server(f.primary).ref, "resume")).status).toBe("resumed");
		expect(server(f.primary).state).toBe("connected");
		expect((await f.primary.operate(server(f.primary).ref, "reconnect")).status).toBe("reconnected");
		expect(f.counts.get("server0")!.initializes).toBe(before + 2);
		expect(manager.getConnection("server1")).toBe(beta);
		expect(f.counts.get("server1")!.initializes).toBe(1);
	}, 30_000);

	test("unavailable is explicit and tools-only manager absence never becomes fake empty availability", async () => {
		const f = await fixture({ disabled: true });
		expect(f.result.mcpManager).toBeUndefined();
		expect(f.primary.getSnapshot()).toMatchObject({ available: false, servers: [], error: { code: "unavailable" } });
	}, 20_000);

	test("strict unknown-JSON parsing rejects additional fields, getters, prototypes, foreign and guessed references", async () => {
		const f = await fixture();
		const ref = server(f.primary).ref;
		const initializations = f.counts.get("server0")!.initializes;
		for (const bad of [null, [], "server0", {}, { ...ref, name: "server1" }, { ...ref, key: 42 },
			Object.create(ref), Object.defineProperty({ ...ref }, "key", { enumerable: true, get: () => ref.key })]) {
			await expect(f.primary.operate(bad, "suspend")).rejects.toMatchObject({ code: "invalid_input" });
		}
		for (const badAction of [null, {}, "delete", "reconnect\0"]) await expect(f.primary.operate(ref, badAction)).rejects.toMatchObject({ code: "invalid_input" });
		await expect(f.primary.operate({ ...ref, key: crypto.randomUUID() }, "suspend")).rejects.toMatchObject({ code: "not_found" });
		await expect(f.primary.operate({ ...ref, connectionGeneration: "foreign" }, "suspend")).rejects.toMatchObject({ code: "stale_connection" });
		await expect(f.primary.operate({ ...ref, sessionGeneration: ref.sessionGeneration + 1 }, "suspend")).rejects.toMatchObject({ code: "stale_session" });
		const other = f.controller(ref.connectionGeneration);
		other.getSnapshot();
		await expect(other.operate(ref, "suspend")).rejects.toMatchObject({ code: "not_found" });
		expect(f.counts.get("server0")!.initializes).toBe(initializations);
		expect(server(f.primary).state).toBe("connected");
	}, 20_000);

	test("SDK target CAS catches config replacement and ABA even before adapter refresh", async () => {
		const f = await fixture({ distinctToolCounts: true });
		const manager = f.result.mcpManager!;
		// The owned endpoints advertise distinct tool counts. Bind initial refs
		// through those observed fixture facts, never row order or private names.
		const initial = f.primary.getSnapshot();
		expect(initial.servers).toHaveLength(2);
		const originals = initial.servers.filter(row => row.toolCount === 1);
		const unrelatedServers = initial.servers.filter(row => row.toolCount === 2);
		expect(originals).toHaveLength(1);
		expect(unrelatedServers).toHaveLength(1);
		const original = originals[0]!.ref;
		const unrelated = unrelatedServers[0]!.ref;
		const unrelatedConnection = manager.getConnection("server1");
		const unrelatedCounters = structuredClone(f.counts.get("server1"));
		const originalTarget = manager.getServerControlSnapshot().find(row => row.target.name === "server0")!.target;
		const originalInitializes = f.counts.get("server0")!.initializes;
		await manager.disconnectServer("server0");
		expect(manager.getConnection("server0")).toBeUndefined();
		const replaced = await manager.connectServers({ ...f.configs, server0: f.config("replacement") }, {});
		expect({ errors: replaced.errors.size, connected: replaced.connectedServers, requests: [...f.counts] })
			.toMatchObject({ errors: 0, connected: expect.arrayContaining(["server0"]) });
		expect(f.counts.get("replacement")?.initializes).toBe(1);
		expect(manager.getConnection("server0")?.config).toMatchObject({ url: f.config("replacement").url });
		expect(manager.getServerControlSnapshot().find(row => row.target.name === "server0")!.target.generation)
			.toBeGreaterThan(originalTarget.generation);
		await expect(f.primary.operate(original, "suspend")).rejects.toMatchObject({ code: "stale_target" });
		// Only server0 was replaced. Configured names stay private; select the
		// changed target by excluding the captured unchanged server1 reference.
		const replacements = f.primary.getSnapshot().servers.filter(row => row.ref.key !== unrelated.key);
		expect(replacements).toHaveLength(1);
		const replacement = replacements[0]!.ref;
		expect(f.primary.getSnapshot().servers.find(row => row.ref.key === unrelated.key)?.ref).toEqual(unrelated);
		expect(manager.getConnection("server1")).toBe(unrelatedConnection);
		expect(f.counts.get("server1")).toEqual(unrelatedCounters);
		expect(replacement.key).not.toBe(original.key);
		const replacementTarget = manager.getServerControlSnapshot().find(row => row.target.name === "server0")!.target;
		await manager.disconnectServer("server0");
		expect(manager.getConnection("server0")).toBeUndefined();
		const restored = await manager.connectServers(f.configs, {});
		expect({ errors: restored.errors.size, connected: restored.connectedServers, requests: [...f.counts] })
			.toMatchObject({ errors: 0, connected: expect.arrayContaining(["server0"]) });
		expect(f.counts.get("server0")!.initializes).toBe(originalInitializes + 1);
		expect(manager.getConnection("server0")?.config).toMatchObject({ url: f.configs.server0!.url });
		expect(manager.getServerControlSnapshot().find(row => row.target.name === "server0")!.target.generation)
			.toBeGreaterThan(replacementTarget.generation);
		for (const stale of [original, replacement]) {
			await expect(f.primary.operate(stale, "suspend")).rejects.toMatchObject({ code: stale === original ? "not_found" : "stale_target" });
		}
		const restoredServers = f.primary.getSnapshot().servers.filter(row => row.ref.key !== unrelated.key);
		expect(restoredServers).toHaveLength(1);
		const restoredServer = restoredServers[0]!;
		expect(restoredServer.state).toBe("connected");
		expect(restoredServer.ref.key).not.toBe(original.key);
		expect(restoredServer.ref.key).not.toBe(replacement.key);
		expect(f.primary.getSnapshot().servers.find(row => row.ref.key === unrelated.key))
			.toMatchObject({ ref: unrelated, state: "connected" });
		expect(manager.getConnection("server1")).toBe(unrelatedConnection);
		expect(f.counts.get("server1")).toEqual(unrelatedCounters);
		const suspended = await f.primary.operate(restoredServer.ref, "suspend");
		expect(suspended).toMatchObject({ status: "suspended", cleanup: "not_certified", snapshot: { available: true } });
		expect(suspended.snapshot.servers.find(row => row.ref.key === unrelated.key))
			.toMatchObject({ ref: unrelated, state: "connected" });
		expect(manager.getConnection("server0")).toBeUndefined();
		const suspendedServers = f.primary.getSnapshot().servers.filter(row => row.ref.key !== unrelated.key);
		expect(suspendedServers).toHaveLength(1);
		const resumed = await f.primary.operate(suspendedServers[0]!.ref, "resume");
		expect(resumed).toMatchObject({ status: "resumed", cleanup: "not_certified", snapshot: { available: true } });
		// Resume uses the SDK's manager-wide reconnect fence. Its ref epochs
		// advance even though server1's actual connection and traffic stay unchanged.
		const resumedUnrelated = resumed.snapshot.servers.filter(row => row.toolCount === 2);
		expect(resumedUnrelated).toHaveLength(1);
		expect(resumedUnrelated[0]!.state).toBe("connected");
		expect(resumedUnrelated[0]!.ref.key).not.toBe(unrelated.key);
		await expect(f.primary.operate(unrelated, "suspend")).rejects.toMatchObject({ code: "not_found" });
		expect(manager.getConnection("server0")?.config).toMatchObject({ url: f.configs.server0!.url });
		expect(manager.getConnection("server1")).toBe(unrelatedConnection);
		expect(f.counts.get("server1")).toEqual(unrelatedCounters);
	}, 30_000);

	test("injected/shared factory manager is used exactly and controller disposal does not dispose it", async () => {
		const owner = await fixture();
		const shared = await fixture({ manager: owner.result.mcpManager! });
		expect(shared.result.mcpManager).toBe(owner.result.mcpManager);
		expect(shared.primary.getSnapshot().scope).toBe("factory_manager_may_be_shared");
		await shared.primary.operate(server(shared.primary).ref, "suspend");
		expect(server(owner.primary).state).toBe("suspended");
		shared.primary.dispose();
		expect(shared.primary.getSnapshot()).toMatchObject({ available: false, error: { code: "disposed" } });
		await owner.primary.operate(server(owner.primary).ref, "resume");
		expect(server(owner.primary).state).toBe("connected");
	}, 30_000);

	test("read-only status stays available during real prompt admission; mutation uses SDK exclusivity", async () => {
		const f = await fixture();
		const ref = server(f.primary).ref;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const stopped = new Error("Owned fixture stopped before provider execution");
		// The only credential is an owned local fixture value. It is never transmitted:
		// the real durable-accept callback rejects before Agent execution can begin.
		f.auth.setRuntimeApiKey("openai", "owned-local-fixture-not-for-network");
		const prompt = f.result.session.prompt("Held at genuine prompt admission", {
			onPreflightAcceptCommit: async () => { entered.resolve(); await release.promise; throw stopped; },
		});
		const outcome = prompt.then(value => ({ status: "fulfilled" as const, value }), (error: unknown) => ({ status: "rejected" as const, error }));
		try {
			const checkpoint = await Promise.race([entered.promise.then(() => "entered" as const), outcome]);
			expect(checkpoint).toBe("entered");
			expect(f.primary.getSnapshot()).toMatchObject({ available: true });
			await expect(f.primary.operate(ref, "suspend")).rejects.toMatchObject({ code: "busy" });
			expect(server(f.primary).state).toBe("connected");
		} finally { release.resolve(); }
		expect(await outcome).toEqual({ status: "rejected", error: stopped });
	}, 30_000);

	test("notifications only wake; a genuine committed lifecycle invalidates old refs", async () => {
		const f = await fixture();
		const ref = server(f.primary).ref;
		let wakes = 0;
		f.primary.onChange(() => { wakes++; });
		const generation = f.result.session.sessionLifecycle.generation;
		f.result.session.emitNotice("info", "Uncommitted notification", "fixture");
		expect(wakes).toBeGreaterThan(0);
		expect(f.result.session.sessionLifecycle.generation).toBe(generation);
		expect(server(f.primary).ref).toEqual(ref);
		const committed = Promise.withResolvers<void>();
		const releaseCleanup = Promise.withResolvers<void>();
		const unregister = f.result.session.registerToolSessionTransitionCleanup(async () => {
			committed.resolve();
			await releaseCleanup.promise;
		});
		const transition = f.result.session.newSession();
		const outcome = transition.then(value => ({ status: "fulfilled" as const, value }), (error: unknown) => ({ status: "rejected" as const, error }));
		try {
			const checkpoint = await Promise.race([committed.promise.then(() => "committed" as const), outcome]);
			expect(checkpoint).toBe("committed");
			expect(f.result.session.sessionLifecycle).toMatchObject({ transitioning: true });
			expect(f.result.session.sessionLifecycle.generation).toBeGreaterThan(generation);
			expect(f.primary.getSnapshot()).toMatchObject({ available: false, error: { code: "stale_session" } });
			await expect(f.primary.operate(ref, "reconnect")).rejects.toMatchObject({ code: "stale_session" });
		} finally { releaseCleanup.resolve(); unregister(); }
		expect(await outcome).toEqual({ status: "fulfilled", value: true });
		expect(f.result.session.sessionLifecycle.generation).toBeGreaterThan(generation);
		expect(f.primary.getSnapshot()).toMatchObject({ available: false, error: { code: "stale_session" } });
		await expect(f.primary.operate(ref, "reconnect")).rejects.toMatchObject({ code: "stale_session" });
	}, 30_000);

	test("cancelled real preparation preserves old refs while mutations and new bindings refuse preparation", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		cleanups.push(async () => { release.resolve(); });
		const extension: ExtensionFactory = api => {
			api.on("session_before_switch", async () => {
				entered.resolve();
				await release.promise;
				return { cancel: true };
			});
		};
		const f = await fixture({ extensions: [extension] });
		const original = server(f.primary).ref;
		const lifecycle = f.result.session.sessionLifecycle;
		const connection = f.result.mcpManager!.getConnection("server0");
		const preparation = f.result.session.newSession();
		const outcome = preparation.then(value => ({ status: "fulfilled" as const, value }), (error: unknown) => ({ status: "rejected" as const, error }));
		try {
			const checkpoint = await Promise.race([entered.promise.then(() => "entered" as const), outcome]);
			expect(checkpoint).toBe("entered");
			expect(f.result.session.sessionLifecycle).toMatchObject({ generation: lifecycle.generation, transitioning: true });
			expect(f.primary.getSnapshot()).toMatchObject({ available: true });
			expect(server(f.primary)).toMatchObject({ ref: original, controls: [] });
			expect(() => f.controller("during-preparation")).toThrow(expect.objectContaining({ code: "session_transitioning" }));
			await expect(f.primary.operate(original, "suspend")).rejects.toMatchObject({ code: "session_transitioning" });
			expect(f.result.mcpManager!.getConnection("server0")).toBe(connection);
		} finally { release.resolve(); }
		expect(await outcome).toEqual({ status: "fulfilled", value: false });
		expect(f.result.session.sessionLifecycle).toEqual(lifecycle);
		expect(server(f.primary).ref).toEqual(original);
		expect(await f.primary.operate(original, "suspend")).toMatchObject({ status: "suspended", cleanup: "not_certified" });
	}, 30_000);

	test("failed genuine runner preparation retains the captured generation and usable original refs", async () => {
		const extension: ExtensionFactory = api => { api.on("session_before_switch", async () => undefined); };
		const f = await fixture({ extensions: [extension] });
		const runner = f.result.session.extensionRunner;
		if (!runner) throw new Error("Expected the actual factory ExtensionRunner");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		cleanups.push(async () => { release.resolve(); });
		// Extension handler exceptions are isolated by the runner. Fail dispatch on
		// the genuine runner instance instead of replacing SDK lifecycle objects.
		vi.spyOn(runner, "emit").mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			throw new Error("controlled MCP preparation failure");
		});
		const original = server(f.primary).ref;
		const lifecycle = f.result.session.sessionLifecycle;
		const preparation = f.result.session.newSession();
		const outcome = preparation.then(value => ({ status: "fulfilled" as const, value }), (error: unknown) => ({ status: "rejected" as const, error }));
		try {
			const checkpoint = await Promise.race([entered.promise.then(() => "entered" as const), outcome]);
			expect(checkpoint).toBe("entered");
			expect(f.result.session.sessionLifecycle).toMatchObject({ generation: lifecycle.generation, transitioning: true });
			expect(server(f.primary)).toMatchObject({ ref: original, controls: [] });
			await expect(f.primary.operate(original, "reconnect")).rejects.toMatchObject({ code: "session_transitioning" });
		} finally { release.resolve(); }
		expect(await outcome).toMatchObject({ status: "rejected", error: { message: "controlled MCP preparation failure" } });
		expect(f.result.session.sessionLifecycle).toEqual(lifecycle);
		expect(server(f.primary).ref).toEqual(original);
		expect(await f.primary.operate(original, "suspend")).toMatchObject({ status: "suspended", cleanup: "not_certified" });
	}, 30_000);

	test("same-ID clear permanently invalidates refs through committed generation, including repeated clear ABA", async () => {
		const f = await fixture();
		const original = server(f.primary).ref;
		const id = f.result.session.sessionId;
		const generation = f.result.session.sessionLifecycle.generation;
		expect(await f.result.session.clearContext()).toBe(true);
		expect(f.result.session.sessionId).toBe(id);
		expect(f.result.session.sessionLifecycle.generation).toBeGreaterThan(generation);
		expect(f.primary.getSnapshot()).toMatchObject({ available: false, error: { code: "stale_session" } });
		await expect(f.primary.operate(original, "suspend")).rejects.toMatchObject({ code: "stale_session" });
		expect(await f.result.session.clearContext()).toBe(true);
		expect(f.result.session.sessionId).toBe(id);
		await expect(f.primary.operate(original, "reconnect")).rejects.toMatchObject({ code: "stale_session" });
	}, 30_000);

	test("parallel mutations and backend errors do not produce false success or leak error text", async () => {
		const f = await fixture();
		const ref = server(f.primary).ref;
		const gate = f.blockNextInitialize();
		const operation = f.primary.operate(ref, "reconnect");
		try {
			await gate.entered;
			expect(f.primary.getSnapshot()).toMatchObject({ available: true });
			await expect(f.primary.operate(ref, "suspend")).rejects.toMatchObject({ code: "session_transitioning" });
		} finally { gate.release(); }
		expect(await operation).toMatchObject({ status: "reconnected" });
		f.failures.add("server0");
		const error: unknown = await f.primary.operate(server(f.primary).ref, "reconnect").catch(value => value);
		expect(error).toMatchObject({ code: "unknown_effect" });
		expect(String(error)).not.toContain(secret);
		expect(server(f.primary).state).not.toBe("connected");
		expect(f.counts.get("server1")!.initializes).toBe(1);
	}, 30_000);

	test("redaction fails closed, reference retention is bounded, and disposal cancels without claiming settlement", async () => {
		const f = await fixture({ count: DESKTOP_MCP_LIMITS.servers + 1 });
		const snapshot = f.primary.getSnapshot();
		expect(snapshot.servers).toHaveLength(DESKTOP_MCP_LIMITS.servers);
		expect(snapshot.truncated).toBe(true);
		const closed = f.controller("closed-redactor", () => { throw new Error(secret); });
		expect(closed.getSnapshot()).toMatchObject({ available: false, servers: [], error: { code: "redaction_failed" } });
		expect(JSON.stringify(closed.getSnapshot())).not.toContain(secret);
		const ref = server(f.primary).ref;
		const gate = f.blockNextInitialize();
		const pending = f.primary.operate(ref, "reconnect");
		try { await gate.entered; f.primary.dispose(); } finally { gate.release(); }
		await expect(pending).rejects.toMatchObject({ code: "unknown_effect" });
		expect(f.primary.getSnapshot()).toMatchObject({ available: false, error: { code: "disposed" } });
	}, 60_000);
});
