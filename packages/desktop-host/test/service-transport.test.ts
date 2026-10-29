/** JSON-lines -> DesktopHost -> public SDK factory, with real loopback MCP effects.
 * Manager/catalog and SDK promise effects are not remote/resource settlement certificates.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@gajae-code/ai/core";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	createAgentSession,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
} from "@gajae-code/coding-agent/sdk";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { DesktopHost } from "../src/host";
import type { DesktopMcpOperationResult, DesktopMcpServer, DesktopMcpSnapshot } from "../src/mcp-protocol";
import type { DesktopOperatorOperation } from "../src/operator-protocol";
import {
	type DesktopCommandResult,
	type DesktopFrame,
	type DesktopProject,
	type DesktopRequest,
	type DesktopSession,
	parseRequest,
} from "../src/protocol";
import type { DesktopSessionInfo, DesktopSessionInfoUsage } from "../src/session-info-protocol";

const provider = "desktopservicefixture";
const secret = "owned-service-transport-private-credential";
const configSecret = "owned-loopback-config-private-token";
const originalRefresh = ModelRegistry.prototype.refresh;
const originalFetch = globalThis.fetch;
const cleanups: Array<() => Promise<void>> = [];
let environment: NodeJS.ProcessEnv;
let previousAgentDir: string;
let forbiddenNetwork: string[];
type ResponseFrame = Extract<DesktopFrame, { type: "response" }>;
interface Counts {
	initializes: number;
	lists: number;
	deletes: number;
	httpMethods: Record<string, number>;
	rpcMethods: Record<string, number>;
}

beforeEach(() => {
	environment = { ...process.env };
	previousAgentDir = getAgentDir();
	forbiddenNetwork = [];
	process.env.GJC_DESKTOP_ISOLATED = "1";
	delete process.env.GJC_CODING_AGENT_DIR;
	delete process.env.GJC_DESKTOP_AGENT_DIR;
	delete process.env.GJC_DESKTOP_SERVICE_UNUSED_API_KEY;
	vi.spyOn(ModelRegistry.prototype, "refresh").mockImplementation(function (this: ModelRegistry, _strategy, sessionId) {
		return originalRefresh.call(this, "offline", sessionId);
	});
	const blocked: typeof fetch = Object.assign(async (input: string | URL | Request) => {
		forbiddenNetwork.push(String(input));
		throw new Error("Service transport permits only its owned MCP loopback origin");
	}, { preconnect: (url: string | URL) => {
		forbiddenNetwork.push(String(url));
		throw new Error("Service transport forbids network preconnect");
	} });
	vi.spyOn(globalThis, "fetch").mockImplementation(blocked);
});

afterEach(async () => {
	try {
		while (cleanups.length) await cleanups.pop()?.();
		expect(forbiddenNetwork).toEqual([]);
	} finally {
		vi.restoreAllMocks();
		for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
		Object.assign(process.env, environment);
		setAgentDir(previousAgentDir);
	}
});

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("Owned service transport did not settle before its deadline");
}

function measured(value: DesktopSessionInfoUsage | { available: false; reason: string }): DesktopSessionInfoUsage {
	if (!value.available) throw new Error(`Expected seeded SDK usage: ${value.reason}`);
	return value;
}

function server(snapshot: DesktopMcpSnapshot, index = 0): DesktopMcpServer {
	if (!snapshot.available || !snapshot.servers[index]) throw new Error("Missing actual factory-manager MCP server");
	return snapshot.servers[index]!;
}

async function fixture(credential = secret, options: { moveSession?: boolean } = {}) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-service-transport-"));
	const dataDir = path.join(directory, "desktop");
	const agentDir = path.join(dataDir, "agent");
	const projectPath = path.join(directory, "project");
	const counts = new Map<string, Counts>();
	const captures: CreateAgentSessionResult[] = [];
	const frames: DesktopFrame[] = [];
	const gates = new Map<string, { entered(): void; wait: Promise<void> }>();
	const releases = new Set<() => void>();
	let host: DesktopHost | undefined;
	const loopback = Bun.serve({ hostname: "127.0.0.1", port: 0,
		async fetch(request) {
			const name = new URL(request.url).pathname.slice(1);
			if (name !== "server0" && name !== "server1") return new Response(null, { status: 404 });
			let counter = counts.get(name);
			if (!counter) {
				counter = { initializes: 0, lists: 0, deletes: 0, httpMethods: {}, rpcMethods: {} };
				counts.set(name, counter);
			}
			counter.httpMethods[request.method] = (counter.httpMethods[request.method] ?? 0) + 1;
			if (request.method === "DELETE") { counter.deletes++; return new Response(null, { status: 204 }); }
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const body = await request.json() as { id?: number | string; method: string };
			const method = typeof body.method === "string" && /^[A-Za-z0-9_./-]{1,80}$/.test(body.method) ? body.method : "invalid";
			counter.rpcMethods[method] = (counter.rpcMethods[method] ?? 0) + 1;
			if (body.id === undefined) return new Response(null, { status: 202 });
			if (body.method === "initialize") {
				counter.initializes++;
				const gate = gates.get(name);
				if (gate) { gates.delete(name); gate.entered(); await gate.wait; }
				return Response.json({ jsonrpc: "2.0", id: body.id, result: {
					protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name, version: "1" },
				} }, { headers: { "Mcp-Session-Id": `${name}-${counter.initializes}` } });
			}
			if (body.method === "tools/list") {
				counter.lists++;
				return Response.json({ jsonrpc: "2.0", id: body.id, result: {
					tools: [{ name: "hello", description: configSecret, inputSchema: { type: "object", properties: {} } }],
				} });
			}
			return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
		},
	});
	cleanups.push(async () => {
		for (const release of releases) release();
		try {
			for (const capture of captures) { capture.session.abortBash(); capture.session.abortEval(); }
			await host?.close();
			for (const capture of captures) expect(capture.session.agent.streamFn).not.toHaveBeenCalled();
		} finally {
			loopback.stop(true);
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
	// Scope discovery roots before AuthStorage, Settings or factory initialization.
	process.env.HOME = path.join(dataDir, "home");
	process.env.USERPROFILE = process.env.HOME;
	for (const [key, leaf] of Object.entries({ XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_STATE_HOME: "state", XDG_CACHE_HOME: "cache" }))
		process.env[key] = path.join(dataDir, leaf);
	await fs.mkdir(projectPath, { recursive: true });
	await fs.mkdir(process.env.HOME, { recursive: true });
	const allowedFetch: typeof fetch = Object.assign(async (input: string | URL | Request, init?: BunFetchRequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.origin !== loopback.url.origin || !["/server0", "/server1"].includes(url.pathname)) {
			forbiddenNetwork.push(url.href);
			throw new Error("External HTTP is forbidden in service transport fixtures");
		}
		return originalFetch(input, init);
	}, { preconnect: (url: string | URL) => {
		forbiddenNetwork.push(String(url));
		throw new Error("Service transport forbids network preconnect");
	} });
	vi.spyOn(globalThis, "fetch").mockImplementation(allowedFetch);
	await setModelPresetRegistryDisabled({ agentDir, disabled: true });
	await Bun.write(path.join(agentDir, "config.yml"), [
		"shellPath: /bin/sh", "startup:", "  networkPrewarm: false", "mcp:", "  enableProjectConfig: false",
		"compaction:", "  enabled: false", "retry:", "  enabled: false", "todo:", "  enabled: false", "",
	].join("\n"));
	const configs = Object.fromEntries(["server0", "server1"].map(name => [name, {
		type: "http", protocol: "legacy", autoload: true, sharing: "per-session", timeout: 5_000,
		url: `${loopback.url}${name}?token=${configSecret}`, headers: { Authorization: `Bearer ${configSecret}` },
	}]));
	await Bun.write(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: configs }));
	await Bun.write(path.join(agentDir, "models.yml"), JSON.stringify({ providers: { [provider]: {
		api: "openai-completions", baseUrl: `https://example.invalid/${configSecret}`,
		apiKeyEnv: "GJC_DESKTOP_SERVICE_UNUSED_API_KEY", models: [{
			id: "base", name: "Service fixture", reasoning: false, input: ["text"], contextWindow: 32_768, maxTokens: 1024,
		}],
	} } }));
	const auth = await AuthStorage.create(path.join(agentDir, "agent.db"));
	try { await auth.set(provider, { type: "api_key", key: credential }); }
	finally { auth.close(); }
	const allowMoveSession = options.moveSession === true;
	const createSession = async (options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
		if (!(options.authStorage instanceof AuthStorage) || !(options.modelRegistry instanceof ModelRegistry) ||
			!(options.settings instanceof Settings) || !options.sessionManager)
			throw new Error("DesktopHost must supply genuine scoped SDK services");
		const model = options.modelRegistry.find(provider, "base");
		if (!model) throw new Error("Owned configured model was not loaded by the real registry");
		options.settings.override("startup.networkPrewarm", false);
		options.settings.override("compaction.enabled", false);
		options.settings.override("retry.enabled", false);
		options.settings.override("bash.autoBackground.enabled", false);
		// Owned recorded transcript evidence, not a fabricated provider response/turn.
		const message: AssistantMessage = {
			role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 1_700_000_000_000,
			content: [{ type: "text", text: `private fixture transcript ${secret}` }], stopReason: "stop",
			usage: { input: 41, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 53,
				cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.02, total: 0.35 } },
		};
		options.sessionManager.appendMessage(message);
		const result = await createAgentSession({
			...options, model, agentId: crypto.randomUUID(), providerSessionId: crypto.randomUUID(), credentialSessionId: crypto.randomUUID(),
			extensions: [], additionalExtensionPaths: [], hookPaths: [], disableExtensionDiscovery: true,
			toolNames: allowMoveSession ? ["move_session"] : [], skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
			...(allowMoveSession ? {} : {
				workspaceTree: { rootPath: projectPath, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			}),
			enableMcpAutoload: true, enableLsp: false, skipPythonPreflight: true, deferOptionalModelRefresh: true,
		});
		vi.spyOn(result.session.agent, "streamFn").mockImplementation(() => {
			throw new Error("Provider turns are forbidden in service transport fixtures");
		});
		captures.push(result);
		if (!result.mcpManager)
			throw new Error(`Public factory must return its actual autoloaded MCP manager; safe method counts: ${JSON.stringify([...counts])}`);
		return result;
	};
	host = new DesktopHost({ dataDir, createSession, emit: frame => { frames.push(frame); } });
	const ownedHost = host;
	const response = async (method: DesktopRequest["method"], params: Record<string, unknown> = {}): Promise<ResponseFrame> => {
		const id = crypto.randomUUID();
		await ownedHost.handle(parseRequest(`${JSON.stringify({ id, method, params })}\n`));
		const frame = frames.find((value): value is ResponseFrame => value.type === "response" && value.id === id);
		if (!frame) throw new Error(`No JSON-lines response for ${method}`);
		return frame;
	};
	const call = async <T>(method: DesktopRequest["method"], params: Record<string, unknown> = {}): Promise<T> => {
		const frame = await response(method, params);
		if (!frame.ok) throw new Error(`${method}: ${frame.error}`);
		return frame.result as T;
	};
	const project = await call<DesktopProject>("project.open", { path: projectPath });
	const open = async () => {
		const dto = await call<DesktopSession>("session.create", { projectId: project.id });
		const result = captures.at(-1);
		if (!result?.mcpManager) throw new Error("Host did not capture the real factory MCP manager");
		return { dto, sdk: result.session, manager: result.mcpManager };
	};
	const first = await open();
	const snapshot = (sessionId = first.dto.id) => call<DesktopMcpSnapshot>("mcp.get", { sessionId });
	const info = async (sessionId = first.dto.id) => {
		const value = await call<DesktopSessionInfo>("session.info", { sessionId });
		if (!value.available) throw new Error(`Expected actual readable SDK telemetry: ${value.code}`);
		return value;
	};
	const counters = () => structuredClone([...counts]);
	return { directory, projectPath, loopbackOrigin: loopback.url.origin, frames, first, captures, counts, call, response, open, snapshot, info, counters,
		blockInitialize(name = "server0") {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const finish = () => release.resolve();
			releases.add(finish);
			gates.set(name, { entered: () => entered.resolve(), wait: release.promise });
			return { entered: entered.promise, release: finish };
		},
	};
}

describe("desktop service public SDK transport", () => {
	test("transport suspend/resume/reconnect changes actual manager connections and loopback counters only for the addressed server", async () => {
		const f = await fixture();
		const sessionId = f.first.dto.id;
		const manager = f.first.manager;
		const initial = await f.snapshot();
		expect(initial).toMatchObject({ available: true, scope: "factory_manager_may_be_shared", truncated: false });
		expect(initial.servers).toHaveLength(2);
		expect(server(initial)).toMatchObject({ state: "connected", transport: "http", sharing: "per-session", toolCount: 1 });
		const alpha = manager.getConnection("server0");
		const beta = manager.getConnection("server1");
		expect(alpha).toBeDefined();
		expect(beta).toBeDefined();
		const betaCounters = structuredClone(f.counts.get("server1"));
		const before = f.counts.get("server0")!.initializes;
		const suspended = await f.call<DesktopMcpOperationResult>("mcp.operate", { sessionId, ref: server(initial).ref, action: "suspend" });
		expect(suspended).toMatchObject({ status: "suspended", cleanup: "not_certified" });
		expect(server(suspended.snapshot)).toMatchObject({ state: "suspended", controls: ["resume"], toolCount: 0 });
		expect(manager.getConnection("server0")).toBeUndefined();
		expect(f.counts.get("server0")!.initializes).toBe(before);
		const resumed = await f.call<DesktopMcpOperationResult>("mcp.operate", { sessionId, ref: server(suspended.snapshot).ref, action: "resume" });
		expect(resumed).toMatchObject({ status: "resumed", cleanup: "not_certified" });
		expect(server(resumed.snapshot)).toMatchObject({ state: "connected", toolCount: 1 });
		const resumedConnection = manager.getConnection("server0");
		expect(resumedConnection).toBeDefined();
		expect(resumedConnection).not.toBe(alpha);
		expect(f.counts.get("server0")!.initializes).toBe(before + 1);
		const reconnected = await f.call<DesktopMcpOperationResult>("mcp.operate", { sessionId, ref: server(resumed.snapshot).ref, action: "reconnect" });
		expect(reconnected).toMatchObject({ status: "reconnected", cleanup: "not_certified" });
		expect(manager.getConnection("server0")).toBeDefined();
		expect(manager.getConnection("server0")).not.toBe(resumedConnection);
		expect(f.counts.get("server0")!.initializes).toBe(before + 2);
		expect(f.counts.get("server0")!.lists).toBeGreaterThanOrEqual(before + 2);
		expect(manager.getConnection("server1")).toBe(beta);
		expect(f.counts.get("server1")).toEqual(betaCounters);
		for (const result of [suspended, resumed, reconnected]) {
			expect(Object.keys(result).sort()).toEqual(["cleanup", "snapshot", "status"]);
			for (const field of ["remoteSettled", "resourcesReleased", "sessionRegistrySettled", "quota", "billing"])
				expect(result).not.toHaveProperty(field);
		}
		const serialized = JSON.stringify(f.frames);
		for (const value of [secret, configSecret, "Authorization", "Bearer", f.loopbackOrigin, "binding", manager.getServerControlSnapshot()[0]!.target.binding])
			expect(serialized).not.toContain(value);
	}, 30_000);

	test("foreign-session, guessed, old-generation and unknown JSON fields are rejected before actual manager effects", async () => {
		const f = await fixture();
		const other = await f.open();
		const sessionId = f.first.dto.id;
		const ref = server(await f.snapshot()).ref;
		const control = vi.spyOn(f.first.manager, "controlServer");
		const foreignControl = vi.spyOn(other.manager, "controlServer");
		const before = f.counters();
		const requests: Array<{ method: DesktopRequest["method"]; params: Record<string, unknown> }> = [
			{ method: "mcp.operate", params: { sessionId: other.dto.id, ref, action: "suspend" } },
			{ method: "mcp.operate", params: { sessionId: f.first.sdk.sessionId, ref, action: "suspend" } },
			{ method: "mcp.operate", params: { sessionId, ref: { ...ref, key: crypto.randomUUID() }, action: "suspend" } },
			{ method: "mcp.operate", params: { sessionId, ref: { ...ref, name: "server1" }, action: "suspend" } },
			{ method: "mcp.operate", params: { sessionId, ref, action: "suspend", catalogSessionId: other.dto.id } },
			{ method: "mcp.operate", params: { sessionId, ref, action: "delete" } },
			{ method: "mcp.get", params: { sessionId, catalogSessionId: other.dto.id } },
			{ method: "session.info", params: { sessionId, catalogSessionId: other.dto.id } },
			{ method: "session.info", params: { sessionId, owner: f.first.sdk.getAgentId() } },
			{ method: "session.info", params: { sessionId: crypto.randomUUID() } },
		];
		for (const request of requests) expect((await f.response(request.method, request.params)).ok).toBe(false);
		expect(control).not.toHaveBeenCalled();
		expect(foreignControl).not.toHaveBeenCalled();
		expect(f.counters()).toEqual(before);
		const generation = f.first.sdk.sessionLifecycle.generation;
		expect(await f.call<DesktopCommandResult>("command.run", { sessionId, text: "/clear" })).toMatchObject({ consumed: true });
		expect(f.first.sdk.sessionLifecycle.generation).toBeGreaterThan(generation);
		const current = await f.snapshot();
		expect(current.sessionGeneration).toBe(f.first.sdk.sessionLifecycle.generation);
		const afterClear = f.counters();
		for (const action of ["suspend", "reconnect"])
			expect((await f.response("mcp.operate", { sessionId, ref, action })).ok).toBe(false);
		expect(control).not.toHaveBeenCalled();
		expect(f.counters()).toEqual(afterClear);
	}, 30_000);

	test("Host rebinds after genuine newSession, rejects predecessor refs, and applies fresh refs to the current factory manager", async () => {
		const f = await fixture();
		const sessionId = f.first.dto.id;
		const factory = f.captures[0]!;
		const initialManager = f.first.manager;
		const oldRef = server(await f.snapshot()).ref;
		const predecessorFile = f.first.sdk.sessionManager.getSessionFile();
		if (!predecessorFile) throw new Error("Expected the Host-owned predecessor transcript");
		expect(await Bun.file(predecessorFile).exists()).toBe(true);
		expect(await f.first.sdk.newSession()).toBe(true);
		await waitFor(() => !f.first.sdk.sessionLifecycle.transitioning);
		const currentManager = factory.mcpManager;
		if (!currentManager) throw new Error("Committed session lost its genuine factory MCP manager");
		const current = await f.snapshot();
		expect(current.sessionGeneration).toBe(f.first.sdk.sessionLifecycle.generation);
		expect(current.sessionGeneration).toBeGreaterThan(oldRef.sessionGeneration);
		expect(server(current).ref.key).not.toBe(oldRef.key);
		const initialControl = vi.spyOn(initialManager, "controlServer");
		const currentControl = currentManager === initialManager ? initialControl : vi.spyOn(currentManager, "controlServer");
		const successorFile = f.first.sdk.sessionManager.getSessionFile();
		if (!successorFile) throw new Error("Expected the genuine SDK successor's reserved transcript path");
		expect(successorFile).not.toBe(predecessorFile);
		expect(path.resolve(successorFile)).toStartWith(`${path.resolve(f.directory)}${path.sep}`);
		const before = f.counters();
		const rejected = await f.response("mcp.operate", { sessionId, ref: oldRef, action: "suspend" });
		expect(rejected.ok).toBe(false);
		if (rejected.ok) throw new Error("Predecessor MCP reference unexpectedly admitted");
		expect(rejected.error).not.toContain("ENOENT");
		// Failed control cleanup must materialize the genuine empty successor via
		// Host persistence, not publish its reserved path or repair it in the fixture.
		expect(await Bun.file(successorFile).exists()).toBe(true);
		expect((await fs.stat(successorFile)).isFile()).toBe(true);
		const firstLine = (await Bun.file(successorFile).text()).split("\n")[0];
		if (!firstLine) throw new Error("Materialized SDK transcript has no session header");
		const header: unknown = JSON.parse(firstLine);
		expect(header).toMatchObject({ type: "session", id: f.first.sdk.sessionManager.getSessionId(), cwd: f.first.sdk.sessionManager.getCwd() });
		expect(f.first.sdk.sessionManager.getHeader()).toMatchObject({ type: "session", id: f.first.sdk.sessionManager.getSessionId() });
		const catalog: unknown = await Bun.file(path.join(f.directory, "desktop", "catalog.json")).json();
		expect(catalog).toMatchObject({ sessions: expect.arrayContaining([expect.objectContaining({
			id: sessionId, file: path.relative(path.join(f.directory, "desktop", "sessions"), successorFile),
		})]) });
		expect(await Bun.file(predecessorFile).exists()).toBe(true);
		expect(initialControl).not.toHaveBeenCalled();
		expect(currentControl).not.toHaveBeenCalled();
		expect(f.counters()).toEqual(before);
		const beta = currentManager.getConnection("server1");
		const betaCounters = structuredClone(f.counts.get("server1"));
		const initializes = f.counts.get("server0")!.initializes;
		const suspended = await f.call<DesktopMcpOperationResult>("mcp.operate", { sessionId, ref: server(current).ref, action: "suspend" });
		expect(suspended).toMatchObject({ status: "suspended", cleanup: "not_certified" });
		expect(currentControl).toHaveBeenCalledTimes(1);
		expect(currentManager.getConnection("server0")).toBeUndefined();
		expect(f.counts.get("server0")!.initializes).toBe(initializes);
		const resumed = await f.call<DesktopMcpOperationResult>("mcp.operate", { sessionId, ref: server(suspended.snapshot).ref, action: "resume" });
		expect(resumed).toMatchObject({ status: "resumed", cleanup: "not_certified" });
		expect(currentControl).toHaveBeenCalledTimes(2);
		expect(currentManager.getConnection("server0")).toBeDefined();
		expect(f.counts.get("server0")!.initializes).toBe(initializes + 1);
		expect(currentManager.getConnection("server1")).toBe(beta);
		expect(f.counts.get("server1")).toEqual(betaCounters);
		if (currentManager !== initialManager) expect(initialControl).not.toHaveBeenCalled();
		const info = await f.info();
		expect(info.metadata.catalogSessionId).toBe(sessionId);
		for (const identity of [f.first.sdk.sessionId, f.first.sdk.sessionManager.getSessionId(), f.first.sdk.credentialSessionId, f.first.sdk.getAgentId()!])
			expect(JSON.stringify(info.metadata)).not.toContain(identity);
	}, 30_000);

	test("public factory manager getter follows genuine owned move_session replacement without claiming unrecataloged Host move support", async () => {
		const f = await fixture(secret, { moveSession: true });
		const factory = f.captures[0]!;
		const initialManager = f.first.manager;
		const target = path.join(f.projectPath, "owned-child");
		await fs.mkdir(target);
		const move = f.first.sdk.getToolByName("move_session");
		if (!move) throw new Error("Expected the canonical factory's genuine move_session tool");
		const initializes = f.counts.get("server0")!.initializes;
		const cwdGeneration = f.first.sdk.sessionManager.getCwdGeneration();
		await move.execute("owned-service-manager-replacement", { path: target });
		expect(f.first.sdk.sessionManager.getCwd()).toBe(await fs.realpath(target));
		expect(f.first.sdk.sessionManager.getCwdGeneration()).toBeGreaterThan(cwdGeneration);
		const currentManager = factory.mcpManager;
		if (!currentManager) throw new Error("Factory result getter lost the actual successor MCP manager");
		// This path constructs and adopts a successor; a static result property
		// would still expose the disconnected predecessor and fail here.
		expect(currentManager).not.toBe(initialManager);
		expect(initialManager.getConnection("server0")).toBeUndefined();
		expect(currentManager.getConnection("server0")).toBeDefined();
		expect(f.counts.get("server0")!.initializes).toBeGreaterThan(initializes);
		const beta = currentManager.getConnection("server1");
		const betaCounters = structuredClone(f.counts.get("server1"));
		const beforeReconnect = f.counts.get("server0")!.initializes;
		const targetRef = currentManager.getServerControlSnapshot().find(value => value.target.name === "server0")?.target;
		if (!targetRef) throw new Error("Successor manager lacks its genuine loopback server target");
		expect(await currentManager.controlServer(targetRef, "reconnect")).toMatchObject({ status: "reconnected", cleanup: "not_certified" });
		expect(f.counts.get("server0")!.initializes).toBe(beforeReconnect + 1);
		expect(currentManager.getConnection("server1")).toBe(beta);
		expect(f.counts.get("server1")).toEqual(betaCounters);
		// The app catalog still names its original project: no Host service
		// request is sent after this SDK-only rescope.
	}, 30_000);

	test("session.info projects actual recorded/active SDK telemetry and catalog identity without SDK ownership, config or billing guesses", async () => {
		const f = await fixture();
		const sdk = f.first.sdk;
		const identities = [sdk.sessionId, sdk.sessionManager.getSessionId(), sdk.credentialSessionId, sdk.getAgentId()!];
		expect(new Set(identities).size).toBe(4);
		await sdk.setSessionName(`private identities ${identities.join(" ")} ${secret}`, "user");
		const before = f.counters();
		const info = await f.info();
		expect(info.metadata.catalogSessionId).toBe(f.first.dto.id);
		expect(info.model).toEqual({ provider, id: "base", name: "Service fixture" });
		expect(info.metadata.persisted).toBe(true);
		expect(info.metadata.sessionFileDisplay).not.toBeNull();
		expect(info.metadata.sessionFileDisplay).toContain("[session]");
		expect(info.metadata).not.toHaveProperty("sessionId");
		expect(info.metadata).not.toHaveProperty("sessionFile");
		expect(measured(info.recordedTotals)).toMatchObject({ source: "transcript_aggregate", tokens: { input: 41, output: 7, cacheRead: 3, cacheWrite: 2, total: 53 } });
		expect(measured(info.activeTotals)).toMatchObject({ source: "active_messages", cost: { amount: 0.35, source: "sdk_recorded_cost" } });
		expect(measured(info.activeTotals).tokens.input).toBe(sdk.getSessionStats().tokens.input);
		expect(measured(info.recordedTotals).tokens.input).toBe(sdk.sessionManager.getUsageStatistics().input);
		expect(info.liveProgress.available).toBe(false);
		expect(info.context.contextWindow).toBe(sdk.model!.contextWindow);
		expect(info.context.source).toBe(sdk.getContextUsage()!.source);
		expect(info.accountQuota).toMatchObject({ available: false });
		expect(info.actualBilledCost).toMatchObject({ available: false });
		const serialized = JSON.stringify(info);
		for (const value of [...identities, secret, configSecret, "Authorization", "baseUrl", "apiKey", "credentialSessionId", "owner"])
			expect(serialized).not.toContain(value);
		expect(f.counters()).toEqual(before);
	}, 30_000);

	test("actual held native shell leaves session.info/mcp.get responsive and rejects MCP mutations before manager entry", async () => {
		const f = await fixture();
		const sessionId = f.first.dto.id;
		const ref = server(await f.snapshot()).ref;
		const control = vi.spyOn(f.first.manager, "controlServer");
		const before = f.counters();
		const connection = f.first.manager.getConnection("server0");
		const marker = "native_service_shell_started";
		const operation = await f.call<DesktopOperatorOperation>("operator.execute", {
			sessionId, text: "! printf 'native_service_shell_started_with_enough_safe_padding_after_the_marker_to_release_stream_redaction_overlap_and_show_real_native_output\\n'; sleep 30; printf 'must_not_complete\\n'",
		});
		try {
			await waitFor(() => f.first.sdk.isBashRunning && f.frames.some(frame => frame.type === "operator" &&
				frame.event.operation.operationId === operation.operationId && frame.event.operation.output.includes(marker)));
			const info = await f.info();
			expect(info.run).toMatchObject({ state: "running", bashRunning: true, pythonRunning: false, streaming: false });
			expect(info.run.bashRunning).toBe(f.first.sdk.isBashRunning);
			expect(info.run.pythonRunning).toBe(f.first.sdk.isEvalRunning);
			expect(await f.snapshot()).toMatchObject({ available: true });
			for (const action of ["suspend", "resume", "reconnect"])
				expect((await f.response("mcp.operate", { sessionId, ref, action })).ok).toBe(false);
			expect(control).not.toHaveBeenCalled();
			expect(f.counters()).toEqual(before);
			expect(f.first.manager.getConnection("server0")).toBe(connection);
			expect(f.first.sdk.isBashRunning).toBe(true);
			const abort = await f.call<DesktopOperatorOperation>("operator.abort", { sessionId, operationId: operation.operationId });
			expect(abort.status).toBe("cancel_requested");
			await waitFor(() => f.frames.some(frame => frame.type === "operator" &&
				frame.event.operation.operationId === operation.operationId && frame.event.operation.status === "cancelled"));
			expect((await f.info()).run).toMatchObject({ bashRunning: false, pythonRunning: false, state: "idle" });
			const suspended = await f.call<DesktopMcpOperationResult>("mcp.operate", { sessionId, ref, action: "suspend" });
			expect(suspended.status).toBe("suspended");
			expect(control).toHaveBeenCalledTimes(1);
			expect(f.first.manager.getConnection("server0")).toBeUndefined();
		} finally { f.first.sdk.abortBash(); }
	}, 30_000);

	test("session.info and mcp.get remain nonexclusive during a genuine held loopback reconnect", async () => {
		const f = await fixture();
		const sessionId = f.first.dto.id;
		const ref = server(await f.snapshot()).ref;
		const gate = f.blockInitialize();
		const operation = f.call<DesktopMcpOperationResult>("mcp.operate", { sessionId, ref, action: "reconnect" });
		try {
			await Promise.race([gate.entered, operation.then(() => {
				throw new Error("Reconnect completed without reaching the owned initialize gate");
			})]);
			// The SDK marks MCP control as transitioning. Read honestly without waiting
			// for the held mutation or manufacturing an available telemetry state.
			expect(await f.call<DesktopSessionInfo>("session.info", { sessionId })).toMatchObject({ available: false, code: "transitioning" });
			expect(await f.snapshot()).toMatchObject({ available: true, servers: [
				expect.objectContaining({ controls: [] }), expect.objectContaining({ controls: [] }),
			] });
			const before = f.counters();
			const control = vi.spyOn(f.first.manager, "controlServer");
			expect((await f.response("mcp.operate", { sessionId, ref, action: "suspend" })).ok).toBe(false);
			expect(control).not.toHaveBeenCalled();
			expect(f.counters()).toEqual(before);
		} finally { gate.release(); }
		expect(await operation).toMatchObject({ status: "reconnected", cleanup: "not_certified" });
		expect(f.first.manager.getConnection("server0")).toBeDefined();
	}, 30_000);

	test("registered '-' credential cannot corrupt opaque transport refs, operation/catalog UUIDs or protocol enums; display secrets stay masked", async () => {
		const f = await fixture("-");
		const sessionId = f.first.dto.id;
		const snapshot = await f.snapshot();
		const target = server(snapshot);
		const before = f.counts.get("server0")!.initializes;
		// Use the emitted reference at the real manager fence, not an equality-only test.
		const suspended = await f.call<DesktopMcpOperationResult>("mcp.operate", { sessionId, ref: target.ref, action: "suspend" });
		expect(suspended).toMatchObject({ status: "suspended", cleanup: "not_certified" });
		expect(f.first.manager.getConnection("server0")).toBeUndefined();
		expect(f.counts.get("server0")!.initializes).toBe(before);
		const resumed = await f.call<DesktopMcpOperationResult>("mcp.operate", { sessionId, ref: server(suspended.snapshot).ref, action: "resume" });
		expect(resumed.status).toBe("resumed");
		expect(f.counts.get("server0")!.initializes).toBe(before + 1);
		const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
		expect(target.ref.key).toMatch(uuid);
		expect(target.ref.connectionGeneration).toMatch(uuid);
		expect(snapshot.connectionGeneration).toBe(target.ref.connectionGeneration);
		expect(target.sharing).toBe("per-session");
		const info = await f.info();
		expect(info.metadata.catalogSessionId).toBe(sessionId);
		expect(info.metadata.catalogSessionId).toMatch(uuid);
		expect(info.run.state).toBe("idle");
		expect(info.context.source).toBe(f.first.sdk.getContextUsage()!.source);
		const operation = await f.call<DesktopOperatorOperation>("operator.execute", { sessionId, text: "!! printf 'visible-secret-value\\n'" });
		expect(operation.operationId).toMatch(uuid);
		await waitFor(() => f.frames.some(frame => frame.type === "operator" &&
			frame.event.operation.operationId === operation.operationId && frame.event.operation.status === "completed"));
		const completed = await f.call<DesktopOperatorOperation>("operator.get", { sessionId, operationId: operation.operationId });
		expect(completed).toMatchObject({ status: "completed", exitCode: 0 });
		expect(completed.output).toContain("visible[redacted]secret[redacted]value");
		expect(completed.output).not.toContain("visible-secret-value");
		for (const value of [configSecret, "Authorization", "Bearer", f.loopbackOrigin, "https://example.invalid/", "visible-secret-value"])
			expect(JSON.stringify(f.frames)).not.toContain(value);
	}, 30_000);
});
