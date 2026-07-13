import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { AcpAgent } from "../src/modes/acp/acp-agent";
import { AcpSdkAdapter } from "../src/sdk/acp";

type TestSessionIdentity = {
	dev: string;
	ino: string;
	size: number;
	mtimeMs: number;
	mtimeNs: string;
};
type BrokerSession = {
	sessionId: string;
	locator: { repo: string };
	canonicalCwd?: string;
	live?: boolean;
	endpointGeneration?: number;
	endpointIncarnation?: string;
	path?: string;
	sessionIdentity?: TestSessionIdentity;
};
type BrokerRequest = {
	operation?: string;
	input?: Record<string, unknown>;
	idempotencyKey?: string;
};
type TestServer = {
	port: number | undefined;
	upgrade(request: Request): boolean;
	stop(close?: boolean): void;
};

const directories: string[] = [];
const servers: TestServer[] = [];

/** Resolve a workspace path through the filesystem so symlink aliases collapse to one scope. */
function realpath(value: string): string {
	try {
		return fs.realpathSync(value);
	} catch {
		return path.resolve(value);
	}
}
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

function incarnation(seed: string): string {
	return createHash("sha256").update(seed).digest("hex");
}

function savedIdentity(tag: string): TestSessionIdentity {
	const digest = createHash("sha256").update(tag).digest("hex");
	return {
		dev: "2049",
		ino: String((BigInt(`0x${digest.slice(0, 12)}`) % 1_000_000n) + 1n),
		size: 1024,
		mtimeMs: Number((BigInt(`0x${digest.slice(12, 24)}`) % 1_000_000n) + 1_700_000_000_000n),
		mtimeNs: String((BigInt(`0x${digest.slice(24, 36)}`) % 1_000_000_000n) + 1n),
	};
}

function liveSession(sessionId: string, repo: string, seed: string, generation = 1): BrokerSession {
	return {
		sessionId,
		locator: { repo },
		canonicalCwd: repo,
		live: true,
		endpointGeneration: generation,
		endpointIncarnation: incarnation(seed),
	};
}

function savedSession(sessionId: string, repo: string, identityTag: string): BrokerSession {
	return {
		sessionId,
		locator: { repo },
		canonicalCwd: repo,
		path: path.join(repo, `${sessionId}.jsonl`),
		sessionIdentity: savedIdentity(identityTag),
	};
}

async function createHarness(): Promise<{
	agent: AcpAgent;
	abort: AbortController;
	agentDir: string;
	cwdA: string;
	cwdB: string;
	requests: BrokerRequest[];
	setSessions(sessions: BrokerSession[]): void;
	moveSession(sessionId: string, repo: string, seed?: string): void;
	recreateSaved(sessionId: string, repo: string, identityTag: string): void;
	endpointUrl: string;
	endpointPort: number | undefined;
	promptAcknowledged: Promise<void>;
	refreshPromptAcknowledged(): Promise<void>;
	endpointClosed: Promise<void>;
	refreshEndpointClosed(): Promise<void>;
	setBrokerIdentity(identity: { ownerId: string; packageGeneration: string; startedAt: number }): void;
	setMutateOnGetEndpoint(fn: (() => void) | undefined): void;
	reverseReadTextFileCalls: number;
	sendEndpointFrame(frame: Record<string, unknown>): void;
}> {
	const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "gjc-acp-multi-cwd-"));
	directories.push(root);
	const agentDir = path.join(root, ".gjc", "agent");
	const cwdA = path.join(root, "workspace-a");
	const cwdB = path.join(root, "workspace-b");
	const token = "multi-cwd-token";
	const endpointToken = "endpoint-token";
	const requests: BrokerRequest[] = [];
	let brokerSessions: BrokerSession[] = [];
	let promptAcknowledged = Promise.withResolvers<void>();
	let endpointClosed = Promise.withResolvers<void>();
	let endpointPort: number | undefined;
	let brokerIdentityValue = {
		ownerId: "test-owner",
		packageGeneration: "test",
		startedAt: Date.now(),
	};
	let mutateOnGetEndpoint: (() => void) | undefined;
	let reverseReadTextFileCalls = 0;

	let broker!: TestServer;
	broker = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (new URL(request.url).searchParams.get("token") !== token)
				return new Response("Unauthorized", { status: 401 });
			if (!broker.upgrade(request)) return new Response("Upgrade failed", { status: 400 });
		},
		websocket: {
			open(socket) {
				socket.send(JSON.stringify({ type: "broker_hello", protocolVersion: 3 }));
			},
			message(socket, raw) {
				const frame = JSON.parse(String(raw)) as BrokerRequest & {
					id?: string;
				};
				requests.push(frame);
				if (frame.operation === "session.list") {
					const requestedId = frame.input?.resolveSessionId;
					const requestedCwd = frame.input?.cwd;
					if (typeof requestedId === "string" && typeof requestedCwd === "string") {
						const match = brokerSessions.find(
							session =>
								session.sessionId === requestedId && realpath(session.locator.repo) === realpath(requestedCwd),
						);
						const result = {
							brokerIdentity: brokerIdentityValue,
							...(match
								? {
										canonicalCwd: realpath(requestedCwd),
										savedSession: {
											id: match.sessionId,
											path: match.path ?? path.join(match.locator.repo, `${match.sessionId}.jsonl`),
											sessionIdentity: match.sessionIdentity ?? savedIdentity(`${match.sessionId}-default`),
										},
									}
								: {
										canonicalCwd: realpath(requestedCwd),
										savedSession: undefined,
									}),
						};
						socket.send(
							JSON.stringify({
								type: "broker_response",
								id: frame.id,
								ok: true,
								result,
							}),
						);
						return;
					}
					const canonical = typeof requestedCwd === "string" ? realpath(requestedCwd) : undefined;
					const sessions = brokerSessions.map(session => ({
						...session,
						canonicalCwd: realpath(session.locator.repo),
					}));
					const result = {
						brokerIdentity: brokerIdentityValue,
						sessions,
						...(canonical ? { canonicalCwd: canonical } : {}),
					};
					socket.send(
						JSON.stringify({
							type: "broker_response",
							id: frame.id,
							ok: true,
							result,
						}),
					);
					return;
				}
				if (frame.operation === "session.get_endpoint") {
					if (mutateOnGetEndpoint) {
						const fn = mutateOnGetEndpoint;
						mutateOnGetEndpoint = undefined;
						fn();
					}
					socket.send(
						JSON.stringify({
							type: "broker_response",
							id: frame.id,
							ok: true,
							result: {
								url: `ws://127.0.0.1:${endpointPort}`,
								token: endpointToken,
							},
						}),
					);
					return;
				}
				socket.send(
					JSON.stringify({
						type: "broker_response",
						id: frame.id,
						ok: true,
						result: {},
					}),
				);
			},
		},
	}) as TestServer;
	servers.push(broker);

	let endpoint!: TestServer;
	let endpointSocket: { send(message: string): void } | undefined;
	endpoint = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (!endpoint.upgrade(request)) return new Response("Upgrade failed", { status: 400 });
		},
		websocket: {
			open(socket) {
				endpointPort = endpoint.port;
				endpointSocket = socket;
				socket.send(
					JSON.stringify({
						type: "hello",
						connectionId: "acp-endpoint-1",
						protocolVersion: 3,
					}),
				);
			},
			close() {
				endpointSocket = undefined;
				endpointClosed.resolve();
			},
			message(socket, raw) {
				const frame = JSON.parse(String(raw)) as {
					id?: string;
					type?: string;
					operation?: string;
					capability?: string;
				};
				if (frame.type === "register_provider") {
					socket.send(
						JSON.stringify({
							type: "register_provider_result",
							id: frame.id,
							ok: true,
							leaseId: `lease-${frame.capability ?? "ui"}`,
						}),
					);
					return;
				}
				if (frame.type === "control_request" && frame.operation === "turn.prompt") {
					socket.send(
						JSON.stringify({
							type: "control_response",
							id: frame.id,
							ok: true,
							result: { commandId: "turn-1", accepted: true },
						}),
					);
					promptAcknowledged.resolve();
					return;
				}
				if (typeof frame.id === "string")
					socket.send(
						JSON.stringify({
							type: "query_response",
							id: frame.id,
							ok: true,
							result: { page: { items: [] } },
						}),
					);
			},
		},
	}) as TestServer;
	servers.push(endpoint);
	endpointPort = endpoint.port;

	await fsPromises.mkdir(path.join(agentDir, "sdk"), { recursive: true });
	await Promise.all([fsPromises.mkdir(cwdA, { recursive: true }), fsPromises.mkdir(cwdB, { recursive: true })]);
	await Bun.write(
		path.join(agentDir, "sdk", "broker.json"),
		JSON.stringify({
			version: 1,
			protocolVersion: 3,
			packageGeneration: "test",
			ownerId: "test-owner",
			pid: process.pid,
			host: "127.0.0.1",
			port: broker.port,
			url: `ws://127.0.0.1:${broker.port}`,
			token,
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		}),
	);
	const abort = new AbortController();
	const agent = new AcpAgent(
		{
			signal: abort.signal,
			closed: Promise.withResolvers<void>().promise,
			sessionUpdate: async () => {},
			readTextFile: async () => {
				reverseReadTextFileCalls++;
				return "";
			},
		} as unknown as AgentSideConnection,
		{ agentDir },
	);
	return {
		agent,
		abort,
		agentDir,
		cwdA,
		cwdB,
		requests,
		setSessions(sessions) {
			brokerSessions = sessions;
		},
		moveSession(sessionId, repo, seed) {
			brokerSessions = brokerSessions.map(session =>
				session.sessionId === sessionId
					? {
							...session,
							locator: { repo },
							canonicalCwd: repo,
							...(seed ? { endpointIncarnation: incarnation(seed) } : {}),
						}
					: session,
			);
		},
		recreateSaved(sessionId, repo, identityTag) {
			brokerSessions = brokerSessions.map(session =>
				session.sessionId === sessionId
					? {
							...session,
							locator: { repo },
							canonicalCwd: repo,
							path: path.join(repo, `${sessionId}.jsonl`),
							sessionIdentity: savedIdentity(identityTag),
						}
					: session,
			);
		},
		get endpointUrl() {
			return `ws://127.0.0.1:${endpointPort}`;
		},
		get endpointPort() {
			return endpointPort;
		},
		get promptAcknowledged() {
			return promptAcknowledged.promise;
		},
		refreshPromptAcknowledged() {
			promptAcknowledged = Promise.withResolvers<void>();
			return promptAcknowledged.promise;
		},
		get endpointClosed() {
			return endpointClosed.promise;
		},
		refreshEndpointClosed() {
			endpointClosed = Promise.withResolvers<void>();
			return endpointClosed.promise;
		},
		setBrokerIdentity(identity) {
			brokerIdentityValue = identity;
		},
		setMutateOnGetEndpoint(fn) {
			mutateOnGetEndpoint = fn;
		},
		get reverseReadTextFileCalls() {
			return reverseReadTextFileCalls;
		},
		sendEndpointFrame(frame) {
			endpointSocket?.send(JSON.stringify(frame));
		},
	};
}

afterEach(async () => {
	for (const server of servers.splice(0)) server.stop(true);
	for (const directory of directories.splice(0)) await fsPromises.rm(directory, { recursive: true, force: true });
});

test("one ACP connection keeps independent cwd authority for distinct broker sessions", async () => {
	const harness = await createHarness();
	harness.setSessions([
		liveSession("session-a", harness.cwdA, "inc-a"),
		liveSession("session-b", harness.cwdB, "inc-b"),
	]);

	expect(await harness.agent.listSessions({ cwd: harness.cwdA })).toMatchObject({
		sessions: [{ sessionId: "session-a", cwd: harness.cwdA }],
	});
	expect(await harness.agent.listSessions({ cwd: path.join(harness.cwdB, ".") })).toMatchObject({
		sessions: [{ sessionId: "session-b", cwd: harness.cwdB }],
	});
	await expect(harness.agent.closeSession({ sessionId: "session-a" })).resolves.toEqual({});
	await expect(harness.agent.closeSession({ sessionId: "session-b" })).resolves.toEqual({});
	const closes = harness.requests.filter(request => request.operation === "session.close");
	expect(closes).toEqual([
		expect.objectContaining({
			input: expect.objectContaining({
				sessionId: "session-a",
				endpointGeneration: 1,
				endpointIncarnation: incarnation("inc-a"),
			}),
			idempotencyKey: `acp:session.close:session-a:${incarnation("inc-a")}`,
		}),
		expect.objectContaining({
			input: expect.objectContaining({
				sessionId: "session-b",
				endpointGeneration: 1,
				endpointIncarnation: incarnation("inc-b"),
			}),
			idempotencyKey: `acp:session.close:session-b:${incarnation("inc-b")}`,
		}),
	]);
	harness.abort.abort();
});

test("a cross-cwd session id conflict revokes prior authority for the connection lifetime", async () => {
	const harness = await createHarness();
	harness.setSessions([liveSession("shared", harness.cwdA, "shared-a")]);
	await harness.agent.listSessions({ cwd: harness.cwdA });

	harness.setSessions([liveSession("shared", harness.cwdB, "shared-b")]);
	await expect(harness.agent.listSessions({ cwd: harness.cwdB })).rejects.toMatchObject({ code: "conflict" });

	harness.setSessions([liveSession("shared", harness.cwdA, "shared-a")]);
	await expect(harness.agent.listSessions({ cwd: harness.cwdA })).rejects.toMatchObject({ code: "conflict" });
	const beforeLifecycle = harness.requests.length;
	await expect(
		harness.agent.loadSession({
			sessionId: "shared",
			cwd: harness.cwdA,
			mcpServers: [],
		}),
	).rejects.toMatchObject({ code: "conflict" });
	await expect(harness.agent.closeSession({ sessionId: "shared" })).rejects.toMatchObject({ code: "conflict" });
	await expect(harness.agent.deleteSession({ sessionId: "shared" })).rejects.toMatchObject({ code: "conflict" });
	expect(harness.requests).toHaveLength(beforeLifecycle);
	harness.abort.abort();
});

test("a cwd-less broker observation revokes a session id relocated after scoped issuance", async () => {
	const harness = await createHarness();
	harness.setSessions([liveSession("relocated", harness.cwdA, "relocated-a")]);
	await harness.agent.listSessions({ cwd: harness.cwdA });

	harness.setSessions([liveSession("relocated", harness.cwdB, "relocated-b")]);
	await expect(harness.agent.listSessions({})).resolves.toMatchObject({
		sessions: [{ sessionId: "relocated", cwd: harness.cwdB }],
	});
	const beforeLifecycle = harness.requests.length;
	await expect(harness.agent.closeSession({ sessionId: "relocated" })).rejects.toMatchObject({ code: "conflict" });
	await expect(harness.agent.deleteSession({ sessionId: "relocated" })).rejects.toMatchObject({ code: "conflict" });
	expect(harness.requests).toHaveLength(beforeLifecycle);
	harness.abort.abort();
});

test("delete validates current scoped authority before any remote lifecycle mutation", async () => {
	const harness = await createHarness();
	harness.setSessions([savedSession("moved-before-delete", harness.cwdA, "moved-a")]);
	await harness.agent.listSessions({ cwd: harness.cwdA });

	harness.setSessions([savedSession("moved-before-delete", harness.cwdB, "moved-b")]);
	const lifecycleBefore = harness.requests.filter(
		request => request.operation === "session.close" || request.operation === "session.delete",
	).length;
	await expect(harness.agent.deleteSession({ sessionId: "moved-before-delete" })).rejects.toMatchObject({
		code: "conflict",
	});
	expect(
		harness.requests.filter(
			request => request.operation === "session.close" || request.operation === "session.delete",
		),
	).toHaveLength(lifecycleBefore);
	harness.abort.abort();
});

test("a duplicate id across broker workspaces fails before any scoped authority is committed", async () => {
	const harness = await createHarness();
	harness.setSessions([
		liveSession("safe", harness.cwdA, "safe-a"),
		liveSession("duplicate", harness.cwdA, "dup-a"),
		liveSession("duplicate", harness.cwdB, "dup-b"),
	]);

	await expect(harness.agent.listSessions({ cwd: harness.cwdA })).rejects.toMatchObject({ code: "conflict" });
	const beforeLifecycle = harness.requests.length;
	await expect(harness.agent.closeSession({ sessionId: "duplicate" })).rejects.toMatchObject({ code: "conflict" });
	await expect(harness.agent.closeSession({ sessionId: "safe" })).resolves.toEqual({});
	expect(harness.requests).toHaveLength(beforeLifecycle);
	harness.abort.abort();
});

test("session cursors use exact decimal grammar and paginate within one cwd", async () => {
	const harness = await createHarness();
	harness.setSessions(
		Array.from({ length: 60 }, (_, index) => liveSession(`session-${index}`, harness.cwdA, `inc-${index}`)),
	);
	const malformed = ["", "10px", "0x10", " 10", "+10", "-1", "1e2", "10:20", "10.5", "01", "9007199254740992"];
	for (const cursor of malformed) {
		const before = harness.requests.length;
		await expect(harness.agent.listSessions({ cwd: harness.cwdA, cursor })).rejects.toThrow(
			"Invalid ACP session cursor",
		);
		expect(harness.requests).toHaveLength(before);
	}
	const first = await harness.agent.listSessions({ cwd: harness.cwdA });
	expect(first.sessions).toHaveLength(50);
	expect(first.nextCursor).toBe("50");
	const second = await harness.agent.listSessions({
		cwd: harness.cwdA,
		cursor: first.nextCursor,
	});
	expect(second.sessions).toHaveLength(10);
	expect(second.nextCursor).toBeUndefined();
	harness.abort.abort();
});

test("symlink aliases of one workspace do not split cwd authority scope", async () => {
	const harness = await createHarness();
	const realpathDir = harness.cwdA;
	const aliasDir = path.join(path.dirname(realpathDir), "workspace-a-alias");
	await fsPromises.symlink(realpathDir, aliasDir);
	expect(realpath(aliasDir)).toBe(realpath(realpathDir));

	harness.setSessions([liveSession("aliased", realpathDir, "alias-inc")]);

	// Scoping through the alias binds the canonical (realpath) authority.
	const viaAlias = await harness.agent.listSessions({ cwd: aliasDir });
	expect(viaAlias).toMatchObject({
		sessions: [{ sessionId: "aliased", cwd: realpathDir }],
	});

	// Scoping through the realpath must not conflict: both collapse to one canonical scope.
	const viaReal = await harness.agent.listSessions({ cwd: realpathDir });
	expect(viaReal).toMatchObject({
		sessions: [{ sessionId: "aliased", cwd: realpathDir }],
	});

	// A lexical-only model would have treated the alias as a second scope and revoked authority.
	await expect(harness.agent.closeSession({ sessionId: "aliased" })).resolves.toEqual({});
	expect(harness.requests.filter(request => request.operation === "session.close")).toEqual([
		expect.objectContaining({
			idempotencyKey: `acp:session.close:aliased:${incarnation("alias-inc")}`,
		}),
	]);
	harness.abort.abort();
});

test("a stale live authority cannot close a same-id successor endpoint", async () => {
	const harness = await createHarness();
	harness.setSessions([liveSession("reused", harness.cwdA, "inc-first")]);
	await harness.agent.listSessions({ cwd: harness.cwdA });

	// The original endpoint is replaced by a successor under the same id with a new incarnation.
	harness.moveSession("reused", harness.cwdA, "inc-second");
	const closeBefore = harness.requests.filter(request => request.operation === "session.close").length;
	await expect(harness.agent.closeSession({ sessionId: "reused" })).rejects.toMatchObject({ code: "conflict" });
	// No broker close is issued, and the reused id remains non-authorizing for this connection.
	expect(harness.requests.filter(request => request.operation === "session.close")).toHaveLength(closeBefore);
	harness.setSessions([liveSession("reused", harness.cwdA, "inc-second")]);
	await expect(harness.agent.listSessions({ cwd: harness.cwdA })).rejects.toMatchObject({ code: "conflict" });
	harness.abort.abort();
});

test("a recreated saved transcript cannot be deleted under stale identity authority", async () => {
	const harness = await createHarness();
	harness.setSessions([savedSession("archived", harness.cwdA, "identity-original")]);
	await harness.agent.listSessions({ cwd: harness.cwdA });

	// The transcript is recreated (new inode/mtime) under the same id and scope.
	harness.recreateSaved("archived", harness.cwdA, "identity-recreated");
	const deleteBefore = harness.requests.filter(request => request.operation === "session.delete").length;
	await expect(harness.agent.deleteSession({ sessionId: "archived" })).rejects.toMatchObject({ code: "conflict" });
	// No delete mutation is issued against the recreated transcript.
	expect(harness.requests.filter(request => request.operation === "session.delete")).toHaveLength(deleteBefore);
	harness.abort.abort();
});

test("close and delete idempotency keys are scoped to exact broker authority", async () => {
	const harness = await createHarness();
	const identity = savedIdentity("archived-original");
	harness.setSessions([
		{
			...savedSession("archived", harness.cwdA, "archived-original"),
			path: path.join(harness.cwdA, "archived.jsonl"),
			sessionIdentity: identity,
		},
		liveSession("live-1", harness.cwdA, "live-inc"),
	]);
	await harness.agent.listSessions({ cwd: harness.cwdA });

	await expect(harness.agent.closeSession({ sessionId: "live-1" })).resolves.toEqual({});
	const close = harness.requests.filter(request => request.operation === "session.close")[0]!;
	expect(close.idempotencyKey).toBe(`acp:session.close:live-1:${incarnation("live-inc")}`);
	expect(close.input).toMatchObject({
		endpointGeneration: 1,
		brokerOwnerId: "test-owner",
		endpointIncarnation: incarnation("live-inc"),
	});

	await expect(harness.agent.deleteSession({ sessionId: "archived" })).resolves.toEqual({});
	const remove = harness.requests.filter(request => request.operation === "session.delete")[0]!;
	expect(remove.idempotencyKey).toMatch(/^acp:session\.delete:archived:[a-f0-9]{64}$/);
	expect(remove.input).toMatchObject({ brokerOwnerId: "test-owner", sessionIdentity: identity });
	expect(remove.input?.idempotencyKey).toBeUndefined();
	harness.abort.abort();
});

test("ambiguity revokes attached prompt, cancel, ext control, and reverse capability", async () => {
	const harness = await createHarness();
	harness.setSessions([liveSession("attached", harness.cwdA, "attached-inc")]);
	harness.refreshEndpointClosed();
	await harness.agent.loadSession({
		sessionId: "attached",
		cwd: harness.cwdA,
		mcpServers: [],
	});

	// Relocate the session to a second workspace and observe it: ambiguity is terminal.
	harness.moveSession("attached", harness.cwdB, "attached-inc-b");
	await expect(
		harness.agent.loadSession({
			sessionId: "attached",
			cwd: harness.cwdB,
			mcpServers: [],
		}),
	).rejects.toMatchObject({ code: "conflict" });

	// No prompt, cancel, ext control, or reverse capability may reach the revoked session.
	await expect(
		harness.agent.prompt({
			sessionId: "attached",
			prompt: [{ type: "text", text: "again" }],
		}),
	).rejects.toMatchObject({ code: "conflict" });
	await expect(harness.agent.cancel({ sessionId: "attached" })).rejects.toMatchObject({ code: "conflict" });
	await expect(
		harness.agent.extMethod("_gjc/sdk/control", {
			sessionId: "attached",
			operation: "mode.plan.set",
			input: { on: true },
		}),
	).resolves.toMatchObject({ ok: false, error: { code: "conflict" } });
});

test("a same-generation successor between list and get_endpoint cannot attach", async () => {
	const harness = await createHarness();
	harness.setSessions([liveSession("successor", harness.cwdA, "successor-first")]);
	harness.refreshEndpointClosed();

	// Between the authority-capturing list and the post-endpoint revalidation list,
	// the broker replaces the endpoint with a same-generation successor.
	harness.setMutateOnGetEndpoint(() => harness.moveSession("successor", harness.cwdA, "successor-second"));

	await expect(
		harness.agent.loadSession({
			sessionId: "successor",
			cwd: harness.cwdA,
			mcpServers: [],
		}),
	).rejects.toMatchObject({ code: "conflict" });

	// The ambiguous id remains non-authorizing for the connection lifetime.
	harness.setSessions([liveSession("successor", harness.cwdA, "successor-second")]);
	await expect(harness.agent.closeSession({ sessionId: "successor" })).rejects.toMatchObject({ code: "conflict" });
	harness.abort.abort();
});

test("broker restart revokes cached authority even with matching session metadata", async () => {
	const harness = await createHarness();
	harness.setSessions([liveSession("restart-proof", harness.cwdA, "restart-inc")]);
	await harness.agent.listSessions({ cwd: harness.cwdA });

	// A successor broker has a new random owner even when its package metadata matches.
	harness.setBrokerIdentity({
		ownerId: "successor-owner",
		packageGeneration: "test",
		startedAt: Date.now() + 1,
	});

	const closeBefore = harness.requests.filter(request => request.operation === "session.close").length;
	await expect(harness.agent.closeSession({ sessionId: "restart-proof" })).rejects.toMatchObject({
		code: "conflict",
	});
	expect(harness.requests.filter(request => request.operation === "session.close")).toHaveLength(closeBefore);
	harness.abort.abort();
});

test("missing broker boot identity revokes cached authority before lifecycle mutation", async () => {
	const harness = await createHarness();
	harness.setSessions([liveSession("identity-required", harness.cwdA, "identity-required-inc")]);
	await harness.agent.listSessions({ cwd: harness.cwdA });

	harness.setBrokerIdentity({ ownerId: "", packageGeneration: "test", startedAt: Date.now() });
	const closeBefore = harness.requests.filter(request => request.operation === "session.close").length;
	await expect(harness.agent.closeSession({ sessionId: "identity-required" })).rejects.toMatchObject({
		code: "unavailable",
	});
	expect(harness.requests.filter(request => request.operation === "session.close")).toHaveLength(closeBefore);
	harness.abort.abort();
});

test("a held-close reverse filesystem request cannot reach the ACP client after ambiguity", async () => {
	const harness = await createHarness();
	const closeHeld = Promise.withResolvers<void>();
	const originalClose = AcpSdkAdapter.prototype.close;
	AcpSdkAdapter.prototype.close = async function () {
		await closeHeld.promise;
		return await originalClose.call(this);
	};
	try {
		await harness.agent.initialize({
			protocolVersion: 1,
			clientCapabilities: { fs: { readTextFile: true } },
		});
		harness.setSessions([liveSession("reverse-held", harness.cwdA, "reverse-held-inc")]);
		harness.refreshEndpointClosed();
		await harness.agent.loadSession({
			sessionId: "reverse-held",
			cwd: harness.cwdA,
			mcpServers: [],
		});

		harness.sendEndpointFrame({
			type: "reverse_request",
			id: "rev-before",
			connectionId: "acp-endpoint-1",
			capability: "fs",
			leaseId: "lease-fs",
			payload: { method: "fs.readTextFile", payload: { path: "/before" } },
		});
		await waitFor(() => harness.reverseReadTextFileCalls === 1, "pre-ambiguity reverse delivery");

		harness.moveSession("reverse-held", harness.cwdB, "reverse-held-inc-b");
		await expect(
			harness.agent.loadSession({
				sessionId: "reverse-held",
				cwd: harness.cwdB,
				mcpServers: [],
			}),
		).rejects.toMatchObject({ code: "conflict" });

		// The socket is deliberately still open because adapter.close is held.
		// The synchronous reverse gate, not transport teardown, must deny dispatch.
		harness.sendEndpointFrame({
			type: "reverse_request",
			id: "rev-after",
			connectionId: "acp-endpoint-1",
			capability: "fs",
			leaseId: "lease-fs",
			payload: { method: "fs.readTextFile", payload: { path: "/after" } },
		});
		await Bun.sleep(100);
		expect(harness.reverseReadTextFileCalls).toBe(1);
	} finally {
		AcpSdkAdapter.prototype.close = originalClose;
		closeHeld.resolve();
		harness.abort.abort();
	}
});

test("a stale saved identity blocks resume before any session.resume mutation", async () => {
	const harness = await createHarness();
	harness.setSessions([savedSession("stale-resume", harness.cwdA, "resume-original")]);
	await harness.agent.listSessions({ cwd: harness.cwdA });

	// The transcript is recreated under the same id and scope.
	harness.recreateSaved("stale-resume", harness.cwdA, "resume-recreated");
	const resumeBefore = harness.requests.filter(request => request.operation === "session.resume").length;
	await expect(
		harness.agent.resumeSession({
			sessionId: "stale-resume",
			cwd: harness.cwdA,
			mcpServers: [],
		}),
	).rejects.toMatchObject({ code: "conflict" });
	expect(harness.requests.filter(request => request.operation === "session.resume")).toHaveLength(resumeBefore);
	harness.abort.abort();
});

test("a stale saved identity blocks fork before any session.fork mutation", async () => {
	const harness = await createHarness();
	harness.setSessions([savedSession("stale-fork", harness.cwdA, "fork-original")]);
	await harness.agent.listSessions({ cwd: harness.cwdA });

	harness.recreateSaved("stale-fork", harness.cwdA, "fork-recreated");
	const forkBefore = harness.requests.filter(request => request.operation === "session.fork").length;
	await expect(
		harness.agent.unstable_forkSession({
			sessionId: "stale-fork",
			cwd: harness.cwdA,
			mcpServers: [],
		}),
	).rejects.toMatchObject({ code: "conflict" });
	expect(harness.requests.filter(request => request.operation === "session.fork")).toHaveLength(forkBefore);
	harness.abort.abort();
});
