import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { createMcpAppServerService } from "../../../runtime-mcp/app-server-service";
import { AuthStorage } from "../../../session/auth-storage";
import { createAppServerRuntime } from "../../create-app-server";

const enc = (value: string) => new TextEncoder().encode(value);
const dec = (value: Uint8Array) => JSON.parse(new TextDecoder().decode(value)) as Record<string, unknown>;

async function initialize(
	connection: { process(line: Uint8Array): Promise<void> },
	frames: Record<string, unknown>[],
): Promise<void> {
	await connection.process(
		enc('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"wire-test","version":"1"}}}'),
	);
	await connection.process(enc('{"method":"initialized"}'));
	frames.splice(0);
}

function writeStdioFixture(root: string): string {
	const fixture = path.join(root, "mcp-fixture.mjs");
	writeFileSync(
		fixture,
		`import readline from "node:readline";
const toolName = process.argv[2] ?? "one";
const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  const req = JSON.parse(line); if (req.id === undefined) continue;
  let result = {};
  if (req.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
  else if (req.method === "tools/list") result = { tools: [{ name: toolName, description: toolName, inputSchema: { type: "object" } }] };
  else if (req.method === "tools/call") result = { content: [{ type: "text", text: toolName }] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\\n");
}
`,
	);
	return fixture;
}

function responseFor(frames: Record<string, unknown>[], id: number): Record<string, unknown> {
	const frame = frames.find(value => value.id === id);
	if (!frame) throw new Error(`Missing response frame ${id}: ${JSON.stringify(frames)}`);
	return frame;
}

async function waitForFrame(
	frames: Record<string, unknown>[],
	predicate: (frame: Record<string, unknown>) => boolean,
): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (frames.some(predicate)) return;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for frame: ${JSON.stringify(frames)}`);
}

test("MCP-WIRE-001 production app-server reload changes the live tool set after an on-disk edit", async () => {
	const root = mkdtempSync("/tmp/gjc-mcp-wire-reload-");
	const fixture = writeStdioFixture(root);
	const configPath = path.join(root, ".mcp.json");
	const writeConfig = (tool: string): void =>
		writeFileSync(
			configPath,
			JSON.stringify({
				mcpServers: { fixture: { type: "stdio", command: process.execPath, args: [fixture, tool] } },
			}),
		);
	writeConfig("one");
	const service = createMcpAppServerService({ cwd: root, agentDir: root });
	const runtime = createAppServerRuntime({}, undefined, { mcpService: service });
	const frames: Record<string, unknown>[] = [];
	const connection = runtime.createConnection(frame => {
		frames.push(dec(frame));
	});
	try {
		await initialize(connection, frames);
		await connection.process(enc('{"id":2,"method":"config/mcpServer/reload"}'));
		const firstReload = responseFor(frames, 2);
		expect(firstReload).toEqual({ id: 2, result: {} });
		await connection.process(
			enc(
				'{"id":3,"method":"mcpServer/tool/call","params":{"threadId":"wire","server":"fixture","tool":"one","arguments":{}}}',
			),
		);
		expect(responseFor(frames, 3)).toMatchObject({ id: 3, result: { content: [{ text: "one" }] } });

		writeConfig("two");
		await connection.process(enc('{"id":4,"method":"config/mcpServer/reload"}'));
		expect(responseFor(frames, 4)).toEqual({ id: 4, result: {} });
		await connection.process(
			enc(
				'{"id":5,"method":"mcpServer/tool/call","params":{"threadId":"wire","server":"fixture","tool":"two","arguments":{}}}',
			),
		);
		expect(responseFor(frames, 5)).toMatchObject({ id: 5, result: { content: [{ text: "two" }] } });
		expect(
			await connection.process(
				enc(
					'{"id":6,"method":"mcpServer/tool/call","params":{"threadId":"wire","server":"fixture","tool":"one","arguments":{}}}',
				),
			),
		).toBeUndefined();
		expect(responseFor(frames, 6)).toMatchObject({ id: 6, error: { code: -32010 } });
	} finally {
		await connection.close();
		rmSync(root, { recursive: true, force: true });
	}
});

async function oauthFixture(): Promise<{ root: string; configPath: string; server: Bun.Server<unknown> }> {
	const root = mkdtempSync("/tmp/gjc-mcp-wire-oauth-");
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async request => {
			const url = new URL(request.url);
			if (url.pathname === "/authorize") {
				const redirect = url.searchParams.get("redirect_uri");
				const state = url.searchParams.get("state");
				if (!redirect || !state) return new Response("missing redirect", { status: 400 });
				return Response.redirect(`${redirect}?code=wire-code&state=${encodeURIComponent(state)}`, 302);
			}
			if (url.pathname === "/token" && request.method === "POST")
				return Response.json({ access_token: "wire-access", refresh_token: "wire-refresh", expires_in: 3600 });
			if (url.pathname === "/mcp" && request.method === "POST") {
				const body = (await request.json()) as { id: string | number; method: string };
				const result =
					body.method === "initialize"
						? {
								protocolVersion: "2025-03-26",
								capabilities: { tools: {} },
								serverInfo: { name: "oauth-fixture", version: "1" },
							}
						: body.method === "tools/list"
							? { tools: [] }
							: {};
				return Response.json({ jsonrpc: "2.0", id: body.id, result });
			}
			return new Response("ok");
		},
	});
	const origin = `http://127.0.0.1:${server.port}`;
	const configPath = path.join(root, ".mcp.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			mcpServers: {
				oauth: {
					type: "http",
					url: `${origin}/mcp`,
					oauth: {
						authorizationUrl: `${origin}/authorize`,
						tokenUrl: `${origin}/token`,
						clientId: "wire-client",
						callbackPort: 39000 + Math.floor(Math.random() * 500),
					},
				},
			},
		}),
	);
	return { root, configPath, server };
}

test("MCP-WIRE-002 production OAuth completion persists and publishes after the response", async () => {
	const fixture = await oauthFixture();
	const storage = await AuthStorage.create(path.join(fixture.root, "auth.db"));
	const service = createMcpAppServerService({ cwd: fixture.root, agentDir: fixture.root, authStorage: storage });
	const runtime = createAppServerRuntime({}, undefined, { mcpService: service });
	const frames: Record<string, unknown>[] = [];
	const connection = runtime.createConnection(frame => {
		frames.push(dec(frame));
	});
	try {
		await initialize(connection, frames);
		await connection.process(enc('{"id":2,"method":"mcpServer/oauth/login","params":{"name":"oauth"}}'));
		const response = responseFor(frames, 2);
		expect(response.result).toHaveProperty("authorizationUrl");
		const authorizationUrl = (response.result as Record<string, unknown>).authorizationUrl as string;
		await fetch(authorizationUrl);
		await waitForFrame(frames, frame => frame.method === "mcpServer/oauthLogin/completed");
		const responseIndex = frames.findIndex(frame => frame.id === 2);
		const notificationIndex = frames.findIndex(frame => frame.method === "mcpServer/oauthLogin/completed");
		expect(responseIndex).toBeGreaterThanOrEqual(0);
		expect(notificationIndex).toBeGreaterThan(responseIndex);
		expect(frames[notificationIndex]).toMatchObject({
			method: "mcpServer/oauthLogin/completed",
			params: { name: "oauth", success: true },
		});
		const credentials = storage.exportSnapshot().credentials;
		expect(credentials.some(entry => entry.credential.type === "oauth" && entry.credential.mcpBinding)).toBe(true);
		const saved = JSON.parse(readFileSync(fixture.configPath, "utf8")) as {
			mcpServers: Record<string, Record<string, unknown>>;
		};
		expect((saved.mcpServers.oauth.auth as Record<string, unknown>).credentialId).toMatch(/^mcp_oauth_/);
	} finally {
		await connection.close();
		storage.close();
		fixture.server.stop();
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("MCP-WIRE-003 OAuth persistence rolls back credential and config writes after reconnect failure", async () => {
	const fixture = await oauthFixture();
	const storage = await AuthStorage.create(path.join(fixture.root, "auth.db"));
	const service = createMcpAppServerService({ cwd: fixture.root, agentDir: fixture.root, authStorage: storage });
	const runtime = createAppServerRuntime({}, undefined, { mcpService: service });
	const frames: Record<string, unknown>[] = [];
	const connection = runtime.createConnection(frame => {
		frames.push(dec(frame));
	});
	try {
		await initialize(connection, frames);
		await service.discover();
		(service.manager as unknown as { reconnectServer: (name: string) => Promise<boolean> }).reconnectServer =
			async () => false;
		await connection.process(enc('{"id":2,"method":"mcpServer/oauth/login","params":{"name":"oauth"}}'));
		const authorizationUrl = (responseFor(frames, 2).result as Record<string, unknown>).authorizationUrl as string;
		await fetch(authorizationUrl);
		await waitForFrame(frames, frame => frame.method === "mcpServer/oauthLogin/completed");
		expect(frames.find(frame => frame.method === "mcpServer/oauthLogin/completed")).toMatchObject({
			params: { name: "oauth", success: false },
		});
		expect(storage.exportSnapshot().credentials.some(entry => entry.credential.type === "oauth")).toBe(false);
		const saved = JSON.parse(readFileSync(fixture.configPath, "utf8")) as {
			mcpServers: Record<string, Record<string, unknown>>;
		};
		expect(saved.mcpServers.oauth.auth).toBeUndefined();
	} finally {
		await connection.close();
		storage.close();
		fixture.server.stop();
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("MCP-WIRE-004 loaded-thread reload is rejected before manager or tool mutation", async () => {
	const root = mkdtempSync("/tmp/gjc-mcp-wire-loaded-reload-");
	const fixture = writeStdioFixture(root);
	const configPath = path.join(root, ".mcp.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			mcpServers: { fixture: { type: "stdio", command: process.execPath, args: [fixture, "one"] } },
		}),
	);
	const service = createMcpAppServerService({ cwd: root, agentDir: root });
	const runtime = createAppServerRuntime({}, undefined, { mcpService: service });
	const frames: Record<string, unknown>[] = [];
	const connection = runtime.createConnection(frame => {
		frames.push(dec(frame));
	});
	const originalLoaded = runtime.manager.loaded;
	try {
		await initialize(connection, frames);
		await service.discover();
		const beforeConnection = service.manager.getConnection("fixture");
		const beforeTools = service.manager.getTools().map(tool => tool.name);
		runtime.manager.loaded = (() => [{ threadId: "loaded" }]) as typeof runtime.manager.loaded;
		await connection.process(enc('{"id":2,"method":"config/mcpServer/reload"}'));
		expect(responseFor(frames, 2)).toMatchObject({ id: 2, error: { code: -32016 } });
		expect(service.manager.getConnection("fixture")).toBe(beforeConnection);
		expect(service.manager.getTools().map(tool => tool.name)).toEqual(beforeTools);
	} finally {
		runtime.manager.loaded = originalLoaded;
		await connection.close();
		await service.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("MCP-WIRE-005 runtime close aborts an in-progress OAuth flow without writes or reconnect", async () => {
	const fixture = await oauthFixture();
	const storage = await AuthStorage.create(path.join(fixture.root, "auth.db"));
	const service = createMcpAppServerService({ cwd: fixture.root, agentDir: fixture.root, authStorage: storage });
	const runtime = createAppServerRuntime({}, undefined, { mcpService: service });
	const frames: Record<string, unknown>[] = [];
	const connection = runtime.createConnection(frame => {
		frames.push(dec(frame));
	});
	let reconnects = 0;
	try {
		await initialize(connection, frames);
		await service.discover();
		const manager = service.manager as unknown as { reconnectServer: (name: string) => Promise<unknown> };
		const reconnectServer = manager.reconnectServer.bind(service.manager);
		manager.reconnectServer = async name => {
			reconnects += 1;
			return reconnectServer(name);
		};
		const pending = connection.process(enc('{"id":2,"method":"mcpServer/oauth/login","params":{"name":"oauth"}}'));
		await waitForFrame(frames, frame => frame.id === 2);
		await runtime.close();
		await pending;
		expect(storage.exportSnapshot().credentials.some(entry => entry.credential.type === "oauth")).toBe(false);
		expect(reconnects).toBe(0);
		const saved = JSON.parse(readFileSync(fixture.configPath, "utf8")) as {
			mcpServers: Record<string, Record<string, unknown>>;
		};
		expect(saved.mcpServers.oauth.auth).toBeUndefined();
	} finally {
		await connection.close().catch(() => {});
		await runtime.close().catch(() => {});
		storage.close();
		fixture.server.stop();
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("MCP-WIRE-010 runtime close drains queued OAuth without writes or reconnect", async () => {
	const fixture = await oauthFixture();
	const storage = await AuthStorage.create(path.join(fixture.root, "auth.db"));
	const service = createMcpAppServerService({ cwd: fixture.root, agentDir: fixture.root, authStorage: storage });
	const runtime = createAppServerRuntime({}, undefined, { mcpService: service });
	const frames: Record<string, unknown>[] = [];
	const wireConnection = runtime.createConnection(frame => {
		frames.push(dec(frame));
	});
	const gate = Promise.withResolvers<void>();
	try {
		await initialize(wireConnection, frames);
		await service.discover();
		const manager = service.manager as unknown as {
			discoverAndConnect: () => Promise<unknown>;
		};
		const discoverAndConnect = manager.discoverAndConnect.bind(service.manager);
		manager.discoverAndConnect = async () => {
			await gate.promise;
			return discoverAndConnect();
		};
		const queued = service.oauthLogin({ name: "oauth" });
		await Bun.sleep(10);
		const closing = runtime.close();
		gate.resolve();
		await closing;
		await queued.catch(() => undefined);
		expect(storage.exportSnapshot().credentials.some(entry => entry.credential.type === "oauth")).toBe(false);
		const saved = JSON.parse(readFileSync(fixture.configPath, "utf8")) as {
			mcpServers: Record<string, Record<string, unknown>>;
		};
		expect(saved.mcpServers.oauth.auth).toBeUndefined();
		await wireConnection.close().catch(() => {});
	} finally {
		gate.resolve();
		await wireConnection.close().catch(() => {});
		await runtime.close().catch(() => {});
		storage.close();
		fixture.server.stop();
		rmSync(fixture.root, { recursive: true, force: true });
	}
});
test("MCP-WIRE-006 requester close before OAuth commit compensates the pending write", async () => {
	const fixture = await oauthFixture();
	const storage = await AuthStorage.create(path.join(fixture.root, "auth.db"));
	const service = createMcpAppServerService({ cwd: fixture.root, agentDir: fixture.root, authStorage: storage });
	const runtime = createAppServerRuntime({}, undefined, { mcpService: service });
	const frames: Record<string, unknown>[] = [];
	const connection = runtime.createConnection(frame => {
		frames.push(dec(frame));
	});
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const storageOverride = storage as unknown as {
		set: (provider: string, credential: unknown) => Promise<void>;
	};
	const originalSet = storage.set.bind(storage);
	storageOverride.set = async (provider, credential) => {
		entered.resolve();
		await release.promise;
		return originalSet(provider, credential as never);
	};
	let reconnects = 0;
	try {
		await initialize(connection, frames);
		await service.discover();
		const manager = service.manager as unknown as { reconnectServer: (name: string) => Promise<unknown> };
		const reconnectServer = manager.reconnectServer.bind(service.manager);
		manager.reconnectServer = async name => {
			reconnects += 1;
			return reconnectServer(name);
		};
		await connection.process(enc('{"id":2,"method":"mcpServer/oauth/login","params":{"name":"oauth"}}'));
		const authorizationUrl = (responseFor(frames, 2).result as Record<string, unknown>).authorizationUrl as string;
		await fetch(authorizationUrl);
		await entered.promise;
		await connection.close();
		release.resolve();
		await service.close();
		expect(storage.exportSnapshot().credentials.some(entry => entry.credential.type === "oauth")).toBe(false);
		expect(reconnects).toBe(0);
		const saved = JSON.parse(readFileSync(fixture.configPath, "utf8")) as {
			mcpServers: Record<string, Record<string, unknown>>;
		};
		expect(saved.mcpServers.oauth.auth).toBeUndefined();
		expect(frames.some(frame => frame.method === "mcpServer/oauthLogin/completed")).toBe(false);
	} finally {
		release.resolve();
		await connection.close().catch(() => {});
		await service.close().catch(() => {});
		storage.close();
		fixture.server.stop();
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("MCP-WIRE-007 reload during OAuth cannot overwrite the replacement source", async () => {
	const fixture = await oauthFixture();
	const storage = await AuthStorage.create(path.join(fixture.root, "auth.db"));
	const service = createMcpAppServerService({ cwd: fixture.root, agentDir: fixture.root, authStorage: storage });
	const runtime = createAppServerRuntime({}, undefined, { mcpService: service });
	const frames: Record<string, unknown>[] = [];
	const connection = runtime.createConnection(frame => {
		frames.push(dec(frame));
	});
	try {
		await initialize(connection, frames);
		await connection.process(enc('{"id":2,"method":"mcpServer/oauth/login","params":{"name":"oauth"}}'));
		const authorizationUrl = (responseFor(frames, 2).result as Record<string, unknown>).authorizationUrl as string;
		const savedBefore = JSON.parse(readFileSync(fixture.configPath, "utf8")) as {
			mcpServers: Record<string, Record<string, unknown>>;
		};
		savedBefore.mcpServers.oauth.url = `${new URL(authorizationUrl).origin}/replacement-mcp`;
		(savedBefore.mcpServers.oauth.oauth as Record<string, unknown>).clientId = "replacement-client";
		writeFileSync(fixture.configPath, JSON.stringify(savedBefore));
		await connection.process(enc('{"id":3,"method":"config/mcpServer/reload"}'));
		expect(responseFor(frames, 3)).toEqual({ id: 3, result: {} });
		await fetch(authorizationUrl);
		await waitForFrame(frames, frame => frame.method === "mcpServer/oauthLogin/completed");
		expect(frames.find(frame => frame.method === "mcpServer/oauthLogin/completed")).toMatchObject({
			params: { name: "oauth", success: false },
		});
		const savedAfter = JSON.parse(readFileSync(fixture.configPath, "utf8")) as {
			mcpServers: Record<string, Record<string, unknown>>;
		};
		expect(savedAfter.mcpServers.oauth.url).toContain("replacement-mcp");
		expect((savedAfter.mcpServers.oauth.oauth as Record<string, unknown>).clientId).toBe("replacement-client");
		expect(storage.exportSnapshot().credentials.some(entry => entry.credential.type === "oauth")).toBe(false);
	} finally {
		await connection.close();
		await service.close();
		storage.close();
		fixture.server.stop();
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("MCP-WIRE-008 concurrent same-server OAuth login rejects the second without an orphan credential", async () => {
	const fixture = await oauthFixture();
	const storage = await AuthStorage.create(path.join(fixture.root, "auth.db"));
	const service = createMcpAppServerService({ cwd: fixture.root, agentDir: fixture.root, authStorage: storage });
	const runtime = createAppServerRuntime({}, undefined, { mcpService: service });
	const framesA: Record<string, unknown>[] = [];
	const framesB: Record<string, unknown>[] = [];
	const connectionA = runtime.createConnection(frame => {
		framesA.push(dec(frame));
	});
	const connectionB = runtime.createConnection(frame => {
		framesB.push(dec(frame));
	});
	try {
		await initialize(connectionA, framesA);
		await initialize(connectionB, framesB);
		await connectionA.process(enc('{"id":2,"method":"mcpServer/oauth/login","params":{"name":"oauth"}}'));
		const authorizationUrl = (responseFor(framesA, 2).result as Record<string, unknown>).authorizationUrl as string;
		await connectionB.process(enc('{"id":2,"method":"mcpServer/oauth/login","params":{"name":"oauth"}}'));
		expect(responseFor(framesB, 2)).toMatchObject({ id: 2, error: { code: -32016, message: "Resource is busy." } });
		await fetch(authorizationUrl);
		await waitForFrame(framesA, frame => frame.method === "mcpServer/oauthLogin/completed");
		expect(framesA.find(frame => frame.method === "mcpServer/oauthLogin/completed")).toMatchObject({
			params: { name: "oauth", success: true },
		});
		const credentials = storage.exportSnapshot().credentials.filter(entry => entry.credential.type === "oauth");
		expect(credentials).toHaveLength(1);
		const saved = JSON.parse(readFileSync(fixture.configPath, "utf8")) as {
			mcpServers: Record<string, Record<string, unknown>>;
		};
		expect((saved.mcpServers.oauth.auth as Record<string, unknown>).credentialId).toBe(credentials[0]?.provider);
	} finally {
		await connectionA.close();
		await connectionB.close();
		await service.close();
		storage.close();
		fixture.server.stop();
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("MCP-WIRE-009 OAuth compensation failures remain observable as an aggregate", async () => {
	const fixture = await oauthFixture();
	const storage = await AuthStorage.create(path.join(fixture.root, "auth.db"));
	const completion = Promise.withResolvers<{ success: boolean; error?: string; cause?: unknown }>();
	const service = createMcpAppServerService({
		cwd: fixture.root,
		agentDir: fixture.root,
		authStorage: storage,
		oauthPersistence: {
			writeConfig: async () => {
				throw new Error("config restore fault");
			},
		},
	});
	const manager = service.manager as unknown as { reconnectServer: (name: string) => Promise<unknown> };
	manager.reconnectServer = async () => false;
	const storageOverride = storage as unknown as { remove: (provider: string) => Promise<void> };
	storageOverride.remove = async () => {
		throw new Error("credential removal fault");
	};
	try {
		const result = await service.oauthLogin({
			name: "oauth",
			onCompletion: value => completion.resolve(value),
		});
		await fetch(result.authorizationUrl);
		const outcome = await completion.promise;
		expect(outcome.success).toBe(false);
		expect(outcome.error).toBe("MCP OAuth login failed.");
		expect(outcome.cause).toBeInstanceOf(AggregateError);
		const failures = (outcome.cause as AggregateError).errors;
		expect(failures).toHaveLength(4);
		expect(failures.map(error => String(error))).toEqual(
			expect.arrayContaining([
				"Error: MCP server did not reconnect after OAuth login.",
				"Error: config restore fault",
				"Error: credential removal fault",
				"Error: MCP server did not reconnect while restoring the previous OAuth connection.",
			]),
		);
	} finally {
		await service.close().catch(() => {});
		storage.close();
		fixture.server.stop();
		rmSync(fixture.root, { recursive: true, force: true });
	}
});
