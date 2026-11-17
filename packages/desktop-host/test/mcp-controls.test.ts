import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import {
	ActivityControls,
	type CreateAgentSessionResult,
	createAgentSession,
	discoverAuthStorage,
	type ExtensionFactory,
	Settings,
} from "@gajae-code/coding-agent/sdk";
import { createDesktopMcpController, DESKTOP_MCP_LIMITS, type DesktopMcpController } from "../src/mcp-controls";

const cleanups: Array<() => Promise<void>> = [];
const secret = "owned-fixture-mcp-secret";
type Manager = NonNullable<CreateAgentSessionResult["mcpManager"]>;
interface Gate {
	entered(): void;
	wait: Promise<void>;
	release(): void;
}

/** Real factory/session/manager. All MCP traffic is deterministic and loopback-only. */
async function fixture(
	options: {
		manager?: Manager;
		disabled?: boolean;
		count?: number;
		names?: string[];
		distinctToolCounts?: boolean;
		redact?: (text: string) => string;
		extensions?: ExtensionFactory[];
	} = {},
) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-mcp-"));
	const counts = new Map<
		string,
		{ initializes: number; deletes: number; httpMethods: string[]; rpcMethods: string[] }
	>();
	const failures = new Set<string>();
	const gates = new Map<string, Gate>();
	const releases = new Set<() => void>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const name = new URL(request.url).pathname.slice(1);
			let counter = counts.get(name);
			if (!counter) {
				counter = { initializes: 0, deletes: 0, httpMethods: [], rpcMethods: [] };
				counts.set(name, counter);
			}
			if (counter.httpMethods.length < 32) counter.httpMethods.push(request.method);
			if (request.method === "DELETE") {
				counter.deletes++;
				return new Response(null, { status: 204 });
			}
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const body = (await request.json()) as { id?: number; method: string };
			if (counter.rpcMethods.length < 32)
				counter.rpcMethods.push(
					typeof body.method === "string" && /^[a-zA-Z][a-zA-Z0-9_/-]{0,127}$/.test(body.method)
						? body.method
						: "invalid_method",
				);
			if (body.id === undefined) {
				if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
				// JSON-RPC notifications never receive a response, including unknown methods.
				return new Response(null, { status: 202 });
			}
			if (body.method === "initialize") {
				counter.initializes++;
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
					{ headers: { "Mcp-Session-Id": `${name}-${counter.initializes}` } },
				);
			}
			if (body.method === "tools/list")
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						tools: Array.from(
							{ length: options.distinctToolCounts && name === "server1" ? 2 : 1 },
							(_, index) => ({
								// Both server digits and tool digits normalize away in MCP names.
								name: `hello_${name.replace(/[0-9]/g, digit => String.fromCharCode(97 + Number(digit)))}_${index === 0 ? "first" : "second"}`,
								description: secret,
								inputSchema: { type: "object", properties: {} },
							}),
						),
					},
				});
			return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
		},
	});
	const config = (endpoint: string) => ({
		type: "http" as const,
		protocol: "legacy" as const,
		autoload: true,
		url: `${server.url}${endpoint}?token=${secret}`,
		timeout: 1_000,
		headers: { Authorization: `Bearer ${secret}` },
	});
	const configs = Object.fromEntries(
		Array.from({ length: options.names?.length ?? options.count ?? 2 }, (_, index) => [
			options.names?.[index] ?? `server${index}`,
			config(`server${index}`),
		]),
	);
	await Bun.write(path.join(directory, "mcp.json"), JSON.stringify({ mcpServers: configs }));
	await Bun.write(
		path.join(directory, "model-presets", "control.json"),
		JSON.stringify({ version: 1, disabled: true }),
	);
	const settings = Settings.isolated({
		"mcp.enableProjectConfig": false,
		"compaction.enabled": false,
		"todo.enabled": false,
	});
	const auth = await discoverAuthStorage(directory);
	let result: CreateAgentSessionResult | undefined;
	const controllers: DesktopMcpController[] = [];
	cleanups.push(async () => {
		for (const release of releases) release();
		for (const controller of controllers) controller.dispose();
		await result?.session.dispose();
		await settings.close();
		auth.close();
		server.stop(true);
		await fs.rm(directory, { recursive: true, force: true });
	});
	result = await createAgentSession({
		cwd: directory,
		agentDir: directory,
		authStorage: auth,
		settings,
		model: getBundledModel("openai", "gpt-4o-mini"),
		...(options.manager ? { mcpManager: options.manager } : {}),
		enableMcpAutoload: !options.disabled,
		disableExtensionDiscovery: true,
		extensions: options.extensions,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableLsp: false,
		toolNames: [],
	});
	const capturedResult = result;
	function controller(
		connectionGeneration: string = crypto.randomUUID(),
		redact = options.redact ?? ((text: string) => text.replaceAll(secret, "[redacted]")),
	) {
		const value = createDesktopMcpController(capturedResult, { connectionGeneration, redact });
		controllers.push(value);
		return value;
	}
	function gate() {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		releases.add(() => release.resolve());
		return {
			gate: { entered: () => entered.resolve(), wait: release.promise, release: () => release.resolve() },
			entered: entered.promise,
			release: () => release.resolve(),
		};
	}
	return {
		result,
		auth,
		counts,
		failures,
		configs,
		config,
		controller,
		primary: controller(),
		blockNextInitialize(name = "server0") {
			const value = gate();
			gates.set(name, value.gate);
			return value;
		},
	};
}

async function server(controller: DesktopMcpController, index = 0) {
	const snapshot = (await controller.getSnapshot());
	if (!snapshot.available || !snapshot.servers[index]) throw new Error("Missing genuine MCP fixture snapshot");
	return snapshot.servers[index]!;
}

afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
	vi.restoreAllMocks();
});

describe("desktop factory-bound MCP controls", () => {
	test("projects bounded safe data and performs actual suspend/resume/reconnect with no beta effects", async () => {
		const sdkSnapshot = vi.spyOn(ActivityControls.prototype, "getMcpSnapshot");
		const sdkOperation = vi.spyOn(ActivityControls.prototype, "operateMcp");
		const f = await fixture();
		const manager = f.result.mcpManager!;
		expect({ managerPresent: Boolean(manager), requests: [...f.counts] }).toMatchObject({ managerPresent: true });
		const beta = manager.getConnection("server1");
		const snapshot = (await f.primary.getSnapshot());
		expect(snapshot).toMatchObject({ available: true, scope: "factory_manager_may_be_shared", truncated: false });
		expect(snapshot.servers.map(row => row.label)).toEqual(["server0", "server1"]);
		const serialized = JSON.stringify(snapshot);
		for (const privateValue of [
			secret,
			"Authorization",
			"Bearer",
			f.configs.server0!.url,
			"binding",
			manager.getServerControlSnapshot()[0]!.target.binding,
		])
			expect(serialized).not.toContain(privateValue);
		const before = f.counts.get("server0")!.initializes;
		const ref = (await server(f.primary)).ref;
		expect(await f.primary.operate(ref, "suspend")).toMatchObject({ status: "suspended", cleanup: "not_certified" });
		expect(sdkSnapshot).toHaveBeenCalled();
		expect(sdkOperation).toHaveBeenCalledWith({ ref: ref.key }, "suspend");
		expect((await server(f.primary))).toMatchObject({ state: "suspended", controls: ["resume"], toolCount: 0 });
		expect(manager.getConnection("server0")).toBeUndefined();
		expect((await f.primary.operate((await server(f.primary)).ref, "resume")).status).toBe("resumed");
		expect((await server(f.primary)).state).toBe("connected");
		expect((await f.primary.operate((await server(f.primary)).ref, "reconnect")).status).toBe("reconnected");
		expect(f.counts.get("server0")!.initializes).toBe(before + 2);
		expect(manager.getConnection("server1")).toBe(beta);
		expect(f.counts.get("server1")!.initializes).toBe(1);
	}, 30_000);

	test("preserves recognizable configured names and redacts secrets and URLs before display limits", async () => {
		const names = [
			"GitHub production",
			"문서 검색",
			`Private ${secret}`,
			"Remote https://user:password@private.example/mcp?token=unknown-secret",
			"API sk-abcdefgh12345678",
			"Local\nfiles\tsearch",
		];
		const f = await fixture({ names });
		const snapshot = (await f.primary.getSnapshot());
		expect(snapshot.available).toBe(true);
		expect(snapshot.servers.map(row => row.label)).toEqual([
			"GitHub production",
			"문서 검색",
			"Private [redacted]",
			"Remote [redacted URL]",
			"API «redacted-api-key»",
			"Local files search",
		]);
		const serialized = JSON.stringify(snapshot);
		for (const value of [secret, "private.example", "password", "unknown-secret", "sk-abcdefgh12345678"])
			expect(serialized).not.toContain(value);
		for (const config of Object.values(f.configs)) expect(serialized).not.toContain(config.url);
	}, 30_000);

	for (const { name, source, secrets, expected } of [
		{
			name: "control-reconstructed host credentials",
			source: "alpha\x00beta",
			secrets: ["alpha beta"],
			expected: "[redacted]",
		},
		{
			name: "raw credentials crossing a control boundary",
			source: "alpha\x00beta",
			secrets: ["alpha\x00beta"],
			expected: "[redacted]",
		},
		{
			name: "overlapping raw and normalized credentials",
			source: "overlap-left-shared-right-\x00private",
			secrets: ["overlap-left-shared", "shared-right- private"],
			expected: "[redacted]",
		},
		{
			name: "overlapping URL and host credential evidence",
			source: "https://private.example/shared\x00private",
			secrets: ["https://private.example/shared", "shared private"],
			expected: "[redacted]",
		},
		{
			name: "well-formed reconstructed host credentials",
			source: "alpha\ud800beta",
			secrets: ["alpha�beta"],
			expected: "[redacted]",
		},
		{
			name: "public control-obscured metadata",
			source: "Public\nMCP\tfiles",
			secrets: ["alpha beta"],
			expected: "Public MCP files",
		},
		{
			name: "normalized credentials crossing the display limit",
			source: `${"x".repeat(DESKTOP_MCP_LIMITS.fieldChars - 2)}alpha\x00beta`,
			secrets: ["alpha beta"],
			expected: `${"x".repeat(DESKTOP_MCP_LIMITS.fieldChars - 2)}[r`,
		},
	]) {
		test(`normalization protects ${name} without changing native MCP names or authority`, async () => {
			const redact = vi.fn((text: string) =>
				secrets.reduce((safe, secret) => safe.replaceAll(secret, "[redacted]"), text),
			);
			const names = [source, "Public MCP server"];
			const f = await fixture({ names, redact });
			const manager = f.result.mcpManager!;
			const canonical = manager.getServerControlSnapshot();
			const connections = names.map(name => manager.getConnection(name));
			const snapshot = (await f.primary.getSnapshot());
			expect(snapshot.available).toBe(true);
			expect(snapshot.servers.map(row => row.label)).toEqual([expected, "Public MCP server"]);
			expect(redact).toHaveBeenCalledWith(source);
			for (const secret of secrets) expect(JSON.stringify(snapshot)).not.toContain(secret);
			expect(canonical.map(row => row.target.name)).toEqual(names);
			expect(manager.getServerControlSnapshot()).toEqual(canonical);
			for (const [index, name] of names.entries()) {
				expect(connections[index]).toBeDefined();
				expect(manager.getConnection(name)).toBe(connections[index]);
				expect(snapshot.servers[index]!.controls).toEqual([...canonical[index]!.controls]);
				expect(snapshot.servers[index]!.ref.key).not.toBe(name);
			}
			expect((await f.primary.getSnapshot()).servers.map(row => row.ref)).toEqual(snapshot.servers.map(row => row.ref));
		}, 30_000);
	}

	test("normalization retains URL and crash-secret protection after complete host matching", async () => {
		const names = [
			"Remote\x00https://private.example/mcp?key=unknown-value",
			"API\x00sk-abcdefgh12345678",
			"Remote https://private.example/shared\x00private",
			"https://private.example/mcp\x00private-tail",
		];
		const redact = vi.fn((text: string) => text.replaceAll("private.example/shared private", "[redacted]"));
		const f = await fixture({ names, redact });
		const snapshot = (await f.primary.getSnapshot());
		expect(snapshot.available).toBe(true);
		expect(snapshot.servers.map(row => row.label)).toEqual(["[redacted]", "[redacted]", "[redacted]", "[redacted]"]);
		for (const text of [...names, ...names.map(name => name.replaceAll("\x00", " "))])
			expect(redact).toHaveBeenCalledWith(text);
		for (const secret of [
			"private.example",
			"unknown-value",
			"sk-abcdefgh12345678",
			"shared private",
			"private-tail",
		])
			expect(JSON.stringify(snapshot)).not.toContain(secret);
	}, 30_000);

	for (const retirement of ["controller disposal", "SDK owner retirement"] as const) {
		test(`normalized redactor callbacks cannot publish labels after ${retirement}`, async () => {
			const f = await fixture({ names: ["Public\x00label"] });
			let calls = 0;
			const controller = f.controller("reentrant-redactor", text => {
				if (++calls === 2) {
					if (retirement === "controller disposal") controller.dispose();
					else vi.spyOn(f.result.session, "getAgentId").mockReturnValue("retired-fixture-owner");
				}
				return text;
			});
			expect((await controller.getSnapshot())).toMatchObject({
				available: false,
				servers: [],
				error: { code: retirement === "controller disposal" ? "disposed" : "stale_session" },
			});
			expect(calls).toBe(2);
		}, 30_000);
	}

	for (const collision of ["redaction", "truncation"] as const) {
		test(`${collision} label collisions preserve separate opaque authority`, async () => {
			const prefix = "a".repeat(DESKTOP_MCP_LIMITS.fieldChars);
			const names = collision === "redaction" ? ["Docs alpha", "Docs beta"] : [`${prefix}alpha`, `${prefix}beta`];
			const f = await fixture({ names, redact: text => text.replace(/alpha|beta/g, "[redacted]") });
			const [first, second] = (await f.primary.getSnapshot()).servers;
			expect(first!.label).toBe(second!.label);
			expect(first!.label.length).toBeLessThanOrEqual(DESKTOP_MCP_LIMITS.fieldChars);
			expect(first!.ref.key).not.toBe(second!.ref.key);
			const manager = f.result.mcpManager!;
			const other = manager.getConnection(names[1]!);
			expect(other).toBeDefined();
			await f.primary.operate(first!.ref, "suspend");
			expect(manager.getConnection(names[0]!)).toBeUndefined();
			expect(manager.getConnection(names[1]!)).toBe(other);
			expect((await f.primary.getSnapshot()).servers[1]!.ref).toEqual(second!.ref);
			await f.primary.operate(second!.ref, "suspend");
			expect(manager.getConnection(names[1]!)).toBeUndefined();
		}, 30_000);
	}

	test("unavailable is explicit and tools-only manager absence never becomes fake empty availability", async () => {
		const f = await fixture({ disabled: true });
		expect(f.result.mcpManager).toBeUndefined();
		expect((await f.primary.getSnapshot())).toMatchObject({ available: false, servers: [], error: { code: "unavailable" } });
	}, 20_000);

	test("strict unknown-JSON parsing rejects additional fields, getters, prototypes, foreign and guessed references", async () => {
		const f = await fixture();
		const ref = (await server(f.primary)).ref;
		const initializations = f.counts.get("server0")!.initializes;
		for (const bad of [
			null,
			[],
			"server0",
			{},
			{ ...ref, name: "server1" },
			{ ...ref, key: 42 },
			Object.create(ref),
			Object.defineProperty({ ...ref }, "key", { enumerable: true, get: () => ref.key }),
		]) {
			await expect(f.primary.operate(bad, "suspend")).rejects.toMatchObject({ code: "invalid_input" });
		}
		for (const badAction of [null, {}, "delete", "reconnect\0"])
			await expect(f.primary.operate(ref, badAction)).rejects.toMatchObject({ code: "invalid_input" });
		await expect(f.primary.operate({ ...ref, key: crypto.randomUUID() }, "suspend")).rejects.toMatchObject({
			code: "not_found",
		});
		await expect(f.primary.operate({ ...ref, connectionGeneration: "foreign" }, "suspend")).rejects.toMatchObject({
			code: "stale_connection",
		});
		await expect(
			f.primary.operate({ ...ref, sessionGeneration: ref.sessionGeneration + 1 }, "suspend"),
		).rejects.toMatchObject({ code: "stale_session" });
		const other = f.controller(ref.connectionGeneration);
		(await other.getSnapshot());
		await expect(other.operate(ref, "suspend")).rejects.toMatchObject({ code: "not_found" });
		expect(f.counts.get("server0")!.initializes).toBe(initializations);
		expect((await server(f.primary)).state).toBe("connected");
	}, 20_000);

	test("SDK target CAS catches config replacement and ABA even before adapter refresh", async () => {
		const f = await fixture({ distinctToolCounts: true });
		const manager = f.result.mcpManager!;
		// The owned endpoints advertise distinct tool counts. Bind initial refs
		// through those observed fixture facts, never row order or private names.
		const initial = (await f.primary.getSnapshot());
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
		expect({
			errors: replaced.errors.size,
			connected: replaced.connectedServers,
			requests: [...f.counts],
		}).toMatchObject({ errors: 0, connected: expect.arrayContaining(["server0"]) });
		expect(f.counts.get("replacement")?.initializes).toBe(1);
		expect(manager.getConnection("server0")?.config).toMatchObject({ url: f.config("replacement").url });
		expect(
			manager.getServerControlSnapshot().find(row => row.target.name === "server0")!.target.generation,
		).toBeGreaterThan(originalTarget.generation);
		await expect(f.primary.operate(original, "suspend")).rejects.toMatchObject({ code: "stale_target" });
		// Only server0 was replaced. References remain opaque; select the
		// changed target by excluding the captured unchanged server1 reference.
		const replacements = (await f.primary.getSnapshot()).servers.filter(row => row.ref.key !== unrelated.key);
		expect(replacements).toHaveLength(1);
		const replacement = replacements[0]!.ref;
		expect((await f.primary.getSnapshot()).servers.find(row => row.ref.key === unrelated.key)?.ref).toEqual(unrelated);
		expect(manager.getConnection("server1")).toBe(unrelatedConnection);
		expect(f.counts.get("server1")).toEqual(unrelatedCounters);
		expect(replacement.key).not.toBe(original.key);
		const replacementTarget = manager.getServerControlSnapshot().find(row => row.target.name === "server0")!.target;
		await manager.disconnectServer("server0");
		expect(manager.getConnection("server0")).toBeUndefined();
		const restored = await manager.connectServers(f.configs, {});
		expect({
			errors: restored.errors.size,
			connected: restored.connectedServers,
			requests: [...f.counts],
		}).toMatchObject({ errors: 0, connected: expect.arrayContaining(["server0"]) });
		expect(f.counts.get("server0")!.initializes).toBe(originalInitializes + 1);
		expect(manager.getConnection("server0")?.config).toMatchObject({ url: f.configs.server0!.url });
		expect(
			manager.getServerControlSnapshot().find(row => row.target.name === "server0")!.target.generation,
		).toBeGreaterThan(replacementTarget.generation);
		for (const stale of [original, replacement]) {
			await expect(f.primary.operate(stale, "suspend")).rejects.toMatchObject({
				code: stale === original ? "not_found" : "stale_target",
			});
		}
		const restoredServers = (await f.primary.getSnapshot()).servers.filter(row => row.ref.key !== unrelated.key);
		expect(restoredServers).toHaveLength(1);
		const restoredServer = restoredServers[0]!;
		expect(restoredServer.state).toBe("connected");
		expect(restoredServer.ref.key).not.toBe(original.key);
		expect(restoredServer.ref.key).not.toBe(replacement.key);
		expect((await f.primary.getSnapshot()).servers.find(row => row.ref.key === unrelated.key)).toMatchObject({
			ref: unrelated,
			state: "connected",
		});
		expect(manager.getConnection("server1")).toBe(unrelatedConnection);
		expect(f.counts.get("server1")).toEqual(unrelatedCounters);
		const suspended = await f.primary.operate(restoredServer.ref, "suspend");
		expect(suspended).toMatchObject({ status: "suspended", cleanup: "not_certified", snapshot: { available: true } });
		expect(suspended.snapshot.servers.find(row => row.ref.key === unrelated.key)).toMatchObject({
			ref: unrelated,
			state: "connected",
		});
		expect(manager.getConnection("server0")).toBeUndefined();
		const suspendedServers = (await f.primary.getSnapshot()).servers.filter(row => row.ref.key !== unrelated.key);
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
		expect((await shared.primary.getSnapshot()).scope).toBe("factory_manager_may_be_shared");
		await shared.primary.operate((await server(shared.primary)).ref, "suspend");
		expect((await server(owner.primary)).state).toBe("suspended");
		shared.primary.dispose();
		expect((await shared.primary.getSnapshot())).toMatchObject({ available: false, error: { code: "disposed" } });
		await owner.primary.operate((await server(owner.primary)).ref, "resume");
		expect((await server(owner.primary)).state).toBe("connected");
	}, 30_000);

	test("read-only status stays available during real prompt admission; mutation uses SDK exclusivity", async () => {
		const f = await fixture();
		const ref = (await server(f.primary)).ref;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const stopped = new Error("Owned fixture stopped before provider execution");
		// The only credential is an owned local fixture value. It is never transmitted:
		// the real durable-accept callback rejects before Agent execution can begin.
		f.auth.setRuntimeApiKey("openai", "owned-local-fixture-not-for-network");
		const prompt = f.result.session.prompt("Held at genuine prompt admission", {
			onPreflightAcceptCommit: async () => {
				entered.resolve();
				await release.promise;
				throw stopped;
			},
		});
		const outcome = prompt.then(
			value => ({ status: "fulfilled" as const, value }),
			(error: unknown) => ({ status: "rejected" as const, error }),
		);
		try {
			const checkpoint = await Promise.race([entered.promise.then(() => "entered" as const), outcome]);
			expect(checkpoint).toBe("entered");
			expect((await f.primary.getSnapshot())).toMatchObject({ available: true });
			await expect(f.primary.operate(ref, "suspend")).rejects.toMatchObject({ code: "busy" });
			expect((await server(f.primary)).state).toBe("connected");
		} finally {
			release.resolve();
		}
		expect(await outcome).toEqual({ status: "rejected", error: stopped });
	}, 30_000);

	test("notifications only wake; a genuine committed lifecycle invalidates old refs", async () => {
		const f = await fixture();
		const ref = (await server(f.primary)).ref;
		let wakes = 0;
		f.primary.onChange(() => {
			wakes++;
		});
		const generation = f.result.session.sessionLifecycle.generation;
		f.result.session.emitNotice("info", "Uncommitted notification", "fixture");
		expect(wakes).toBeGreaterThan(0);
		expect(f.result.session.sessionLifecycle.generation).toBe(generation);
		expect((await server(f.primary)).ref).toEqual(ref);
		const committed = Promise.withResolvers<void>();
		const releaseCleanup = Promise.withResolvers<void>();
		const unregister = f.result.session.registerToolSessionTransitionCleanup(async () => {
			committed.resolve();
			await releaseCleanup.promise;
		});
		const transition = f.result.session.newSession();
		const outcome = transition.then(
			value => ({ status: "fulfilled" as const, value }),
			(error: unknown) => ({ status: "rejected" as const, error }),
		);
		try {
			const checkpoint = await Promise.race([committed.promise.then(() => "committed" as const), outcome]);
			expect(checkpoint).toBe("committed");
			expect(f.result.session.sessionLifecycle).toMatchObject({ transitioning: true });
			expect(f.result.session.sessionLifecycle.generation).toBeGreaterThan(generation);
			expect((await f.primary.getSnapshot())).toMatchObject({ available: false, error: { code: "stale_session" } });
			await expect(f.primary.operate(ref, "reconnect")).rejects.toMatchObject({ code: "stale_session" });
		} finally {
			releaseCleanup.resolve();
			unregister();
		}
		expect(await outcome).toEqual({ status: "fulfilled", value: true });
		expect(f.result.session.sessionLifecycle.generation).toBeGreaterThan(generation);
		expect((await f.primary.getSnapshot())).toMatchObject({ available: false, error: { code: "stale_session" } });
		await expect(f.primary.operate(ref, "reconnect")).rejects.toMatchObject({ code: "stale_session" });
	}, 30_000);

	test("cancelled real preparation preserves old refs while mutations and new bindings refuse preparation", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		cleanups.push(async () => {
			release.resolve();
		});
		const extension: ExtensionFactory = api => {
			api.on("session_before_switch", async () => {
				entered.resolve();
				await release.promise;
				return { cancel: true };
			});
		};
		const f = await fixture({ extensions: [extension] });
		const original = (await server(f.primary)).ref;
		const lifecycle = f.result.session.sessionLifecycle;
		const connection = f.result.mcpManager!.getConnection("server0");
		const preparation = f.result.session.newSession();
		const outcome = preparation.then(
			value => ({ status: "fulfilled" as const, value }),
			(error: unknown) => ({ status: "rejected" as const, error }),
		);
		try {
			const checkpoint = await Promise.race([entered.promise.then(() => "entered" as const), outcome]);
			expect(checkpoint).toBe("entered");
			expect(f.result.session.sessionLifecycle).toMatchObject({
				generation: lifecycle.generation,
				transitioning: true,
			});
			expect((await f.primary.getSnapshot())).toMatchObject({ available: true });
			expect((await server(f.primary))).toMatchObject({ ref: original, controls: [] });
			expect(() => f.controller("during-preparation")).toThrow(
				expect.objectContaining({ code: "session_transitioning" }),
			);
			await expect(f.primary.operate(original, "suspend")).rejects.toMatchObject({ code: "session_transitioning" });
			expect(f.result.mcpManager!.getConnection("server0")).toBe(connection);
		} finally {
			release.resolve();
		}
		expect(await outcome).toEqual({ status: "fulfilled", value: false });
		expect(f.result.session.sessionLifecycle).toEqual(lifecycle);
		expect((await server(f.primary)).ref).toEqual(original);
		expect(await f.primary.operate(original, "suspend")).toMatchObject({
			status: "suspended",
			cleanup: "not_certified",
		});
	}, 30_000);

	test("failed genuine runner preparation retains the captured generation and usable original refs", async () => {
		const extension: ExtensionFactory = api => {
			api.on("session_before_switch", async () => undefined);
		};
		const f = await fixture({ extensions: [extension] });
		const runner = f.result.session.extensionRunner;
		if (!runner) throw new Error("Expected the actual factory ExtensionRunner");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		cleanups.push(async () => {
			release.resolve();
		});
		// Extension handler exceptions are isolated by the runner. Fail dispatch on
		// the genuine runner instance instead of replacing SDK lifecycle objects.
		vi.spyOn(runner, "emit").mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			throw new Error("controlled MCP preparation failure");
		});
		const original = (await server(f.primary)).ref;
		const lifecycle = f.result.session.sessionLifecycle;
		const preparation = f.result.session.newSession();
		const outcome = preparation.then(
			value => ({ status: "fulfilled" as const, value }),
			(error: unknown) => ({ status: "rejected" as const, error }),
		);
		try {
			const checkpoint = await Promise.race([entered.promise.then(() => "entered" as const), outcome]);
			expect(checkpoint).toBe("entered");
			expect(f.result.session.sessionLifecycle).toMatchObject({
				generation: lifecycle.generation,
				transitioning: true,
			});
			expect((await server(f.primary))).toMatchObject({ ref: original, controls: [] });
			await expect(f.primary.operate(original, "reconnect")).rejects.toMatchObject({
				code: "session_transitioning",
			});
		} finally {
			release.resolve();
		}
		expect(await outcome).toMatchObject({
			status: "rejected",
			error: { message: "controlled MCP preparation failure" },
		});
		expect(f.result.session.sessionLifecycle).toEqual(lifecycle);
		expect((await server(f.primary)).ref).toEqual(original);
		expect(await f.primary.operate(original, "suspend")).toMatchObject({
			status: "suspended",
			cleanup: "not_certified",
		});
	}, 30_000);

	test("same-ID clear permanently invalidates refs through committed generation, including repeated clear ABA", async () => {
		const f = await fixture();
		const original = (await server(f.primary)).ref;
		const id = f.result.session.sessionId;
		const generation = f.result.session.sessionLifecycle.generation;
		expect(await f.result.session.clearContext()).toBe(true);
		expect(f.result.session.sessionId).toBe(id);
		expect(f.result.session.sessionLifecycle.generation).toBeGreaterThan(generation);
		expect((await f.primary.getSnapshot())).toMatchObject({ available: false, error: { code: "stale_session" } });
		await expect(f.primary.operate(original, "suspend")).rejects.toMatchObject({ code: "stale_session" });
		expect(await f.result.session.clearContext()).toBe(true);
		expect(f.result.session.sessionId).toBe(id);
		await expect(f.primary.operate(original, "reconnect")).rejects.toMatchObject({ code: "stale_session" });
	}, 30_000);

	test("parallel mutations and backend errors do not produce false success or leak error text", async () => {
		const f = await fixture();
		const ref = (await server(f.primary)).ref;
		const gate = f.blockNextInitialize();
		const operation = f.primary.operate(ref, "reconnect");
		try {
			await gate.entered;
			expect((await f.primary.getSnapshot())).toMatchObject({ available: true });
			await expect(f.primary.operate(ref, "suspend")).rejects.toMatchObject({ code: "session_transitioning" });
		} finally {
			gate.release();
		}
		expect(await operation).toMatchObject({ status: "reconnected" });
		f.failures.add("server0");
		const error: unknown = await f.primary.operate((await server(f.primary)).ref, "reconnect").catch(value => value);
		expect(error).toMatchObject({ code: "unknown_effect" });
		expect(String(error)).not.toContain(secret);
		expect((await server(f.primary)).state).not.toBe("connected");
		expect(f.counts.get("server1")!.initializes).toBe(1);
	}, 30_000);

	test("redaction fails closed, reference retention is bounded, and disposal cancels without claiming settlement", async () => {
		const f = await fixture({ count: DESKTOP_MCP_LIMITS.servers + 1 });
		const snapshot = (await f.primary.getSnapshot());
		expect(snapshot.servers).toHaveLength(DESKTOP_MCP_LIMITS.servers);
		expect(snapshot.truncated).toBe(true);
		const closed = f.controller("closed-redactor", () => {
			throw new Error(secret);
		});
		expect((await closed.getSnapshot())).toMatchObject({
			available: false,
			servers: [],
			error: { code: "redaction_failed" },
		});
		expect(JSON.stringify((await closed.getSnapshot()))).not.toContain(secret);
		const ref = (await server(f.primary)).ref;
		const gate = f.blockNextInitialize();
		const pending = f.primary.operate(ref, "reconnect");
		try {
			await gate.entered;
			f.primary.dispose();
		} finally {
			gate.release();
		}
		await expect(pending).rejects.toMatchObject({ code: "unknown_effect" });
		expect((await f.primary.getSnapshot())).toMatchObject({ available: false, error: { code: "disposed" } });
	}, 60_000);
});
