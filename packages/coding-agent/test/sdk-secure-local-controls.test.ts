import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { verifyOwnerOnlyPathSecurityExpected } from "@gajae-code/natives";
import type { ServerWebSocket } from "bun";
import type { SessionIndex } from "../src/sdk/broker/session-index";
import { SdkClient } from "../src/sdk/client/client";
import { type ControlSurface, dispatchControl } from "../src/sdk/host/control";
import { SessionSdkHost } from "../src/sdk/host/host";
import { createSdkCapabilities, createSdkSurfacePolicy } from "../src/sdk/host/surface-policy";
import { SECURE_LOCAL_OPERATIONS } from "../src/sdk/protocol/client-control-contracts";
import { findOperation } from "../src/sdk/protocol/operation-registry";
import { SessionRouter, type SessionRouterClient } from "../src/sdk/router/session-router";
import { getSecureLocalAuthority } from "../src/sdk/secure-local-authority";
import {
	SECURE_LOCAL_PROOF_FIELD,
	secureLocalFrameOperation,
	signSecureLocalFrame,
	verifySecureLocalFrame,
} from "../src/sdk/secure-local-controls";

const AUTHORITY = "independent-sdk-owned-authority";
const ENDPOINT_TOKEN = "internal-endpoint-token";

test("secure-local advertisements require both installed operations and affirmative authority", () => {
	for (const secureLocalAuthorityAvailable of [undefined, false, true]) {
		for (const installed of [false, true]) {
			const policy = createSdkSurfacePolicy({
				bindings: ["sdkControl"],
				workflowGateAvailable: false,
				clientControlOperations: installed ? SECURE_LOCAL_OPERATIONS : [],
				...(secureLocalAuthorityAvailable === undefined ? {} : { secureLocalAuthorityAvailable }),
			});
			const capabilities = createSdkCapabilities(policy);
			expect(capabilities.operations).toContain("turn.prompt");
			expect(capabilities.operations).not.toContain("auth.apiKey.store");
			expect(capabilities.operations).not.toContain("auth.status");
			if (installed && secureLocalAuthorityAvailable === true) {
				expect(capabilities.secureLocalOperations).toContain("auth.apiKey.store");
				expect(capabilities.secureLocalOperations).toContain("auth.status");
			} else {
				expect(capabilities.secureLocalOperations).toBeUndefined();
			}
		}
	}
});

test("operator installation and secure-local authority retain independent capability fences", () => {
	const operatorOperations = ["operator.execute", "operator.read", "operator.cancel"];
	for (const secureLocalAuthorityAvailable of [undefined, false, true]) {
		for (const operatorsInstalled of [false, true]) {
			const capabilities = createSdkCapabilities(
				createSdkSurfacePolicy({
					bindings: ["sdkControl"],
					workflowGateAvailable: false,
					clientControlOperations: [...SECURE_LOCAL_OPERATIONS, ...(operatorsInstalled ? operatorOperations : [])],
					...(secureLocalAuthorityAvailable === undefined ? {} : { secureLocalAuthorityAvailable }),
				}),
			);
			for (const operation of operatorOperations) {
				expect(capabilities.operations.includes(operation)).toBe(operatorsInstalled);
				expect(capabilities.secureLocalOperations ?? []).not.toContain(operation);
			}
			for (const operation of SECURE_LOCAL_OPERATIONS) {
				expect(capabilities.operations).not.toContain(operation);
				expect((capabilities.secureLocalOperations ?? []).includes(operation)).toBe(
					secureLocalAuthorityAvailable === true,
				);
			}
		}
	}
});

test("exact grants require independent authority and bind every security-relevant wire field", () => {
	const frame = {
		type: "control_request",
		id: "request",
		operation: "auth.apiKey.store",
		input: { provider: "test", key: "secret" },
	};
	const signed = { ...frame, [SECURE_LOCAL_PROOF_FIELD]: signSecureLocalFrame(AUTHORITY, ENDPOINT_TOKEN, frame) };
	expect(verifySecureLocalFrame(AUTHORITY, ENDPOINT_TOKEN, signed)).toBe(true);
	expect(verifySecureLocalFrame(AUTHORITY, "other-endpoint", signed)).toBe(false);
	const forged = { ...frame, [SECURE_LOCAL_PROOF_FIELD]: signSecureLocalFrame(ENDPOINT_TOKEN, ENDPOINT_TOKEN, frame) };
	expect(verifySecureLocalFrame(AUTHORITY, ENDPOINT_TOKEN, forged)).toBe(false);
	for (const tamper of [
		{ id: "other-request" },
		{ operation: "auth.start" },
		{ input: { provider: "other", key: "secret" } },
		{ cursor: "other-cursor" },
		{ idempotencyKey: "retain-secret" },
		{ connectionId: "other-connection" },
		{ token: "other-token" },
	])
		expect(verifySecureLocalFrame(AUTHORITY, ENDPOINT_TOKEN, { ...signed, ...tamper })).toBe(false);
	const query = { type: "query_request", id: "numeric", query: "Q38", input: { flowId: "flow" }, cursor: "page" };
	const signedQuery = { ...query, [SECURE_LOCAL_PROOF_FIELD]: signSecureLocalFrame(AUTHORITY, ENDPOINT_TOKEN, query) };
	expect(secureLocalFrameOperation(query)).toBe("auth.read");
	expect(verifySecureLocalFrame(AUTHORITY, ENDPOINT_TOKEN, signedQuery)).toBe(true);
	expect(verifySecureLocalFrame(AUTHORITY, ENDPOINT_TOKEN, { ...signedQuery, query: "auth.status" })).toBe(false);
	expect(verifySecureLocalFrame(AUTHORITY, ENDPOINT_TOKEN, { ...signedQuery, operation: "auth.status" })).toBe(false);
	expect(() => signSecureLocalFrame(AUTHORITY, ENDPOINT_TOKEN, { ...query, operation: "auth.status" })).toThrow();
});

test("host rejects forged and replayed grants before observers and never logs authorization bodies", async () => {
	let receive!: (connection: string, frame: Record<string, unknown>) => void;
	const sent: Record<string, unknown>[] = [];
	const observed: unknown[] = [];
	const admitted: unknown[] = [];
	let effects = 0;
	const host = new SessionSdkHost({
		sessionId: "secure-local-test",
		stateRoot: "/tmp/secure-local-test",
		token: ENDPOINT_TOKEN,
		secureLocalAuthority: AUTHORITY,
		onFrame: handler => {
			receive = handler;
			return () => {};
		},
		sendFrame: (_connection, frame) => {
			sent.push(frame);
			return "written";
		},
		onRequest: (...args) => observed.push(args),
		onFrameAdmitted: (...args) => observed.push(args),
		onFrameAdmission: (_connection, frame) => {
			admitted.push(frame);
			return undefined;
		},
		beforeControlResponse: (...args) => {
			observed.push(args);
		},
		afterControlResponse: (...args) => {
			observed.push(args);
		},
		onControlResponseDelivery: (...args) => {
			observed.push(args);
		},
		control: () => {
			effects++;
			return { id: "store", ok: true, result: { saved: true } };
		},
	});
	await host.start();
	try {
		const frame = {
			type: "control_request",
			id: "store",
			connectionId: "trusted",
			operation: "auth.apiKey.store",
			input: { provider: "test", key: "never-in-observers" },
			capabilities: ["auth.apiKey.store"],
		};
		receive("untrusted", frame);
		await Bun.sleep(0);
		expect(sent.at(-1)).toMatchObject({ ok: false, error: { code: "operation_prohibited" } });
		expect(effects).toBe(0);
		const forgedFrame = { ...frame, connectionId: "endpoint-token-holder" };
		const forged = {
			...forgedFrame,
			[SECURE_LOCAL_PROOF_FIELD]: signSecureLocalFrame(ENDPOINT_TOKEN, ENDPOINT_TOKEN, forgedFrame),
		};
		receive("endpoint-token-holder", forged);
		await Bun.sleep(0);
		expect(sent.at(-1)).toMatchObject({ ok: false, error: { code: "operation_prohibited" } });
		expect(effects).toBe(0);
		const signed = { ...frame, [SECURE_LOCAL_PROOF_FIELD]: signSecureLocalFrame(AUTHORITY, ENDPOINT_TOKEN, frame) };
		const emptyConnection = { ...frame, connectionId: "" };
		receive("", {
			...emptyConnection,
			[SECURE_LOCAL_PROOF_FIELD]: signSecureLocalFrame(AUTHORITY, ENDPOINT_TOKEN, emptyConnection),
		});
		await Bun.sleep(0);
		expect(sent.at(-1)).toMatchObject({ ok: false, error: { code: "operation_prohibited" } });
		expect(effects).toBe(0);
		expect(admitted).toEqual([]);
		receive("trusted", signed);
		await Bun.sleep(0);
		expect(sent.at(-1)).toMatchObject({ ok: true, result: { saved: true } });
		expect(effects).toBe(1);
		receive("trusted", signed);
		await Bun.sleep(0);
		expect(sent.at(-1)).toMatchObject({ ok: false, error: { code: "operation_prohibited" } });
		expect(effects).toBe(1);
		expect(observed).toEqual([]);
		expect(JSON.stringify(admitted)).not.toContain("never-in-observers");
		expect(JSON.stringify(admitted)).not.toContain(SECURE_LOCAL_PROOF_FIELD);
		expect(JSON.stringify(host.events.replay(0))).not.toContain("never-in-observers");
	} finally {
		await host.stop();
	}
});

test("secret-bearing controls reject idempotency retention before invoking effects", async () => {
	let effects = 0;
	const surface = {
		authorizationControl: () => {
			effects++;
			return { saved: true };
		},
	} as unknown as ControlSurface;
	const row = findOperation("control", "auth.apiKey.store");
	for (let index = 0; index < 2; index++) {
		const response = await dispatchControl(surface, row, {
			id: String(index),
			operation: "auth.apiKey.store",
			input: { provider: "test", key: "secret" },
			idempotencyKey: "do-not-retain",
		});
		expect(response).toMatchObject({ ok: false, error: { code: "invalid_input" } });
	}
	expect(effects).toBe(0);
});

test("SDK authority is private, atomic across creators, persistent, and never replaces unsafe files", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-authority-"));
	try {
		const keys = await Promise.all(Array.from({ length: 8 }, () => getSecureLocalAuthority(directory)));
		expect(new Set(keys).size).toBe(1);
		expect(keys[0]).toMatch(/^[a-f0-9]{64}$/);
		const file = path.join(directory, "sdk", "secure-local-authority.key");
		if (process.platform === "win32") {
			const identity = await fs.stat(file, { bigint: true });
			expect(verifyOwnerOnlyPathSecurityExpected(file, "file", identity.dev, identity.ino)).toEqual({ ok: true });
		} else {
			expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
		}
		expect(await fs.readFile(file)).toHaveLength(32);
		expect(await getSecureLocalAuthority(directory)).toBe(keys[0]!);
		if (process.platform !== "win32") {
			await fs.chmod(file, 0o644);
			await expect(getSecureLocalAuthority(directory)).rejects.toThrow("private regular");
			expect((await fs.stat(file)).mode & 0o777).toBe(0o644);
		}
		await fs.unlink(file);
		const target = path.join(directory, "existing-key");
		await fs.writeFile(target, Buffer.alloc(32, 7), { mode: 0o600 });
		await fs.symlink(target, file);
		await expect(getSecureLocalAuthority(directory)).rejects.toThrow();
		expect(await fs.readFile(target)).toEqual(Buffer.alloc(32, 7));
		await fs.unlink(file);
		await fs.mkdir(file);
		await expect(getSecureLocalAuthority(directory)).rejects.toThrow("private regular");
		const linkedAgent = path.join(directory, "linked-agent");
		await fs.mkdir(linkedAgent);
		await fs.symlink(path.join(directory, "sdk"), path.join(linkedAgent, "sdk"));
		await expect(getSecureLocalAuthority(linkedAgent)).rejects.toThrow("directory is not trusted");
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

async function secureTransportFixture(authority: string, stateRoot: string, identifyConnection = true) {
	let receive!: (connectionId: string, frame: Record<string, unknown>) => void;
	let sequence = 0;
	const sockets = new Map<string, ServerWebSocket<{ connectionId: string }>>();
	const closed = new Map<string, () => void>();
	const responses = new Map<string, (frame: Record<string, unknown>) => void>();
	const requests: Record<string, unknown>[] = [];
	const effects: Record<string, unknown>[] = [];
	const admitted: Record<string, unknown>[] = [];
	const server = Bun.serve<{ connectionId: string }>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			return server.upgrade(request, { data: { connectionId: `connection-${++sequence}` } })
				? undefined
				: new Response("upgrade required", { status: 400 });
		},
		websocket: {
			open(socket) {
				sockets.set(socket.data.connectionId, socket);
				socket.send(
					JSON.stringify({
						type: "hello",
						...(identifyConnection ? { connectionId: socket.data.connectionId } : {}),
					}),
				);
			},
			message(socket, message) {
				const frame = JSON.parse(String(message)) as Record<string, unknown>;
				if (secureLocalFrameOperation(frame)) requests.push(frame);
				receive(socket.data.connectionId, frame);
			},
			close(socket) {
				sockets.delete(socket.data.connectionId);
				closed.get(socket.data.connectionId)?.();
				closed.delete(socket.data.connectionId);
			},
		},
	});
	const respond = (_connectionId: string, frame: Record<string, unknown>) => {
		effects.push(frame);
		return { id: frame.id, ok: true, result: { secret: "local-only-reply" } };
	};
	const host = new SessionSdkHost({
		sessionId: "secure-session",
		stateRoot,
		token: ENDPOINT_TOKEN,
		secureLocalAuthority: authority,
		onFrame: handler => {
			receive = handler;
			return () => {};
		},
		sendFrame: (connectionId, frame) => {
			const socket = sockets.get(connectionId);
			if (!socket) return "dropped";
			socket.send(JSON.stringify(frame));
			responses.get(`${connectionId}:${String(frame.id)}`)?.(frame);
			return "written";
		},
		onFrameAdmission: (_connectionId, frame) => {
			admitted.push(frame);
			return undefined;
		},
		control: respond,
		query: respond,
	});
	await host.start();
	return {
		url: `ws://127.0.0.1:${server.port}`,
		requests,
		effects,
		admitted,
		exchange: async (client: SdkClient, frame: Record<string, unknown>): Promise<Record<string, unknown>> => {
			const response = Promise.withResolvers<Record<string, unknown>>();
			const key = `${client.connectionId}:${String(frame.id)}`;
			responses.set(key, response.resolve);
			try {
				client.send(frame);
				return await response.promise;
			} finally {
				responses.delete(key);
			}
		},
		disconnect: async (connectionId: string): Promise<void> => {
			const socket = sockets.get(connectionId);
			if (!socket) throw new Error("Fixture connection is unavailable.");
			const disconnected = Promise.withResolvers<void>();
			closed.set(connectionId, disconnected.resolve);
			socket.close();
			await disconnected.promise;
		},
		close: async () => {
			await host.stop();
			await server.stop(true);
		},
	};
}

test("valid grant capacity exhaustion is retryable without weakening replay rejection", async () => {
	const transport = await secureTransportFixture(AUTHORITY, "/tmp/secure-replay-capacity");
	const client = await SdkClient.connect(transport.url, ENDPOINT_TOKEN);
	let now = Date.now();
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	const signed = (id: string) => {
		const frame = { type: "query_request", id, query: "auth.status", connectionId: client.connectionId };
		return { ...frame, [SECURE_LOCAL_PROOF_FIELD]: signSecureLocalFrame(AUTHORITY, ENDPOINT_TOKEN, frame) };
	};
	try {
		const first = signed("capacity-0");
		expect(await transport.exchange(client, first)).toMatchObject({ ok: true });
		for (let index = 1; index < 256; index++) {
			expect(await transport.exchange(client, signed(`capacity-${index}`))).toMatchObject({ ok: true });
		}
		expect(transport.effects).toHaveLength(256);
		expect(await transport.exchange(client, first)).toMatchObject({
			ok: false,
			error: { code: "operation_prohibited" },
		});
		const invalid = signed("invalid-at-capacity");
		expect(
			await transport.exchange(client, { ...invalid, [SECURE_LOCAL_PROOF_FIELD]: "invalid-proof" }),
		).toMatchObject({ ok: false, error: { code: "operation_prohibited" } });
		expect(await transport.exchange(client, signed("capacity-overflow"))).toMatchObject({
			ok: false,
			error: { code: "unavailable" },
		});
		expect(transport.effects).toHaveLength(256);
		expect(transport.admitted).toHaveLength(256);
		now += 30_001;
		expect(await transport.exchange(client, signed("capacity-recovered"))).toMatchObject({ ok: true });
		expect(transport.effects).toHaveLength(257);
		expect(transport.admitted).toHaveLength(257);
	} finally {
		clock.mockRestore();
		await client.close();
		await transport.close();
	}
});

test("unused auth.read and apiKey.store proofs reject another actual connection without consuming the owner proof", async () => {
	const transport = await secureTransportFixture(AUTHORITY, "/tmp/secure-connection-binding");
	const a = await SdkClient.connect(transport.url, ENDPOINT_TOKEN);
	const b = await SdkClient.connect(transport.url, ENDPOINT_TOKEN);
	try {
		for (const request of [
			{ type: "query_request", id: "read", query: "auth.read", input: { flowId: "flow" } },
			{
				type: "control_request",
				id: "store",
				operation: "auth.apiKey.store",
				input: { provider: "test", key: "secret" },
			},
		]) {
			const frame = { ...request, connectionId: a.connectionId };
			const signed = {
				...frame,
				[SECURE_LOCAL_PROOF_FIELD]: signSecureLocalFrame(AUTHORITY, ENDPOINT_TOKEN, frame),
			};
			const effectsBefore = transport.effects.length;
			const admissionsBefore = transport.admitted.length;
			expect(await transport.exchange(b, signed)).toMatchObject({
				ok: false,
				error: { code: "operation_prohibited" },
			});
			expect(transport.effects).toHaveLength(effectsBefore);
			expect(transport.admitted).toHaveLength(admissionsBefore);
			expect(await transport.exchange(a, signed)).toMatchObject({
				ok: true,
				result: { secret: "local-only-reply" },
			});
			expect(transport.effects).toHaveLength(effectsBefore + 1);
			expect(await transport.exchange(a, signed)).toMatchObject({
				ok: false,
				error: { code: "operation_prohibited" },
			});
			expect(transport.effects).toHaveLength(effectsBefore + 1);
		}
		const unbound = { type: "query_request", id: "unbound", query: "auth.read" };
		expect(
			await transport.exchange(a, {
				...unbound,
				[SECURE_LOCAL_PROOF_FIELD]: signSecureLocalFrame(AUTHORITY, ENDPOINT_TOKEN, unbound),
			}),
		).toMatchObject({ ok: false, error: { code: "operation_prohibited" } });
	} finally {
		await a.close();
		await b.close();
		await transport.close();
	}
});

async function secureRouterFixture(
	customCorrelation = false,
	identifyConnection = true,
): Promise<{
	router: SessionRouter;
	requests: Record<string, unknown>[];
	observed: unknown[];
	emit: (frame: Record<string, unknown>) => void;
	client: SdkClient;
	disconnect: () => Promise<void>;
	close: () => Promise<void>;
}> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-secure-router-"));
	const agentDir = path.join(directory, "agent");
	const authority = await getSecureLocalAuthority(agentDir);
	const stateRoot = path.join(directory, ".gjc", "state");
	await fs.mkdir(path.join(stateRoot, "sdk"), { recursive: true });
	const transport = await secureTransportFixture(authority, stateRoot, identifyConnection);
	const realClient = await SdkClient.connect(transport.url, ENDPOINT_TOKEN, { reconnectAttempts: 0 });
	const endpointFile = path.join(stateRoot, "sdk", "secure-session.json");
	await fs.writeFile(
		endpointFile,
		JSON.stringify({ sessionId: "secure-session", url: transport.url, token: ENDPOINT_TOKEN, pid: 42 }),
	);
	const endpointStat = await fs.stat(endpointFile, { bigint: true });
	const endpointMtimeMs = Number(endpointStat.mtimeNs) / 1_000_000;
	const endpointFileId = `${endpointStat.dev}:${endpointStat.ino}`;
	const index = {
		open: async () => {},
		refresh: async () => {},
		refreshIfChanged: async () => true,
		listSessions: () => ({
			indexSeq: 1,
			warnings: [],
			sessions: [
				{
					sessionId: "secure-session",
					locator: { cwd: directory, worktreeRoot: null, stateRoot },
					endpointGeneration: 1,
					pid: 42,
					endpointMtimeMs,
					endpointFileId,
					live: true,
					indexSeq: 1,
					ambiguous: false,
					terminal: false,
				},
			],
		}),
	} as unknown as SessionIndex;
	const observed: unknown[] = [];
	const requests = transport.requests;
	let handler: ((frame: Record<string, unknown>) => void) | undefined;
	const client: SessionRouterClient = {
		get connectionId() {
			return realClient.connectionId;
		},
		connect: () => realClient.connect(),
		onReconnect: next => realClient.onReconnect(next),
		onFrame: next => {
			handler = next;
			const unsubscribe = realClient.onFrame(next);
			return () => {
				unsubscribe();
				handler = undefined;
			};
		},
		request: async (frame, options) => {
			if (secureLocalFrameOperation(frame))
				expect(verifySecureLocalFrame(authority, ENDPOINT_TOKEN, frame)).toBe(true);
			const response = await realClient.request(frame, options);
			if (!secureLocalFrameOperation(frame)) return response;
			handler?.(response);
			// Even a transport-specific response type must be suppressed by the
			// bounded exact pending-ID fence before custom correlation runs.
			handler?.({ ...response, type: "transport_specific_reply" });
			handler?.({
				type: "control_command_result",
				requestId: "unrelated-native-result",
				message: JSON.stringify({ ...response, type: "transport_specific_reply" }),
			});
			return response;
		},
		close: () => realClient.close(),
		send: frame => realClient.send(frame),
	};
	const router = new SessionRouter({
		agentDir,
		secureLocalOperations: ["auth.status", "auth.cancel"],
		...(customCorrelation
			? {
					correlateFrame: (frame: Record<string, unknown>) => {
						observed.push(frame);
						return { body: frame, name: "custom", sessionId: undefined, generation: undefined };
					},
				}
			: {}),
		deps: {
			createIndex: () => index,
			createClient: async () => client,
			onFrame: (_attachment, frame) => {
				observed.push(frame);
			},
			onNotificationFrame: (_subscription, frame) => {
				observed.push(frame);
			},
		},
	});
	await router.start();
	const attachment = router.attachment("secure-session");
	expect(attachment?.isCurrent()).toBe(true);
	expect(attachment?.generation).toBe(1);
	expect(attachment?.connectionId).toBe(realClient.connectionId);
	return {
		router,
		requests,
		observed,
		emit: frame => handler?.(frame),
		client: realClient,
		disconnect: async () => {
			const connectionId = realClient.connectionId;
			if (!connectionId) throw new Error("Fixture connection is unavailable.");
			// Unknown frames receive no reply. Keep one real request pending so its
			// close rejection proves the client retired the socket, not just the server.
			const dispatched = Promise.withResolvers<void>();
			const retired = realClient
				.request(
					{ type: "connection_close_probe" },
					{
						connectedOnly: true,
						timeoutMs: 1_000,
						onDispatch: () => dispatched.resolve(),
					},
				)
				.then(
					() => {
						throw new Error("Connection-close probe unexpectedly received a reply.");
					},
					(error: unknown) => {
						expect(error).toMatchObject({ code: "uncertain_after_send" });
					},
				);
			await dispatched.promise;
			await transport.disconnect(connectionId);
			await retired;
		},
		close: async () => {
			await router.stop();
			await transport.close();
			await fs.rm(directory, { recursive: true, force: true });
		},
	};
}

test("Router rejects secure-local requests when the established hello has no connection identity", async () => {
	const fixture = await secureRouterFixture(false, false);
	try {
		await expect(
			fixture.router.request("secure-session", { type: "query_request", query: "auth.status" }),
		).rejects.toMatchObject({ phase: "pre_send" });
		expect(fixture.requests).toEqual([]);
	} finally {
		await fixture.close();
	}
});

test("SdkClient clears inherited hello identity and never borrows correlation from ordinary proof claims", async () => {
	const transport = await secureTransportFixture(AUTHORITY, "/tmp/secure-client-hello-binding", false);
	const client = new SdkClient(transport.url, ENDPOINT_TOKEN);
	client.connectionId = "stale-before-hello";
	try {
		await client.connect();
		expect(client.connectionId).toBeUndefined();
		const stale = { type: "query_request", id: "stale", query: "auth.read", connectionId: "stale-before-hello" };
		await expect(
			client.request({
				...stale,
				[SECURE_LOCAL_PROOF_FIELD]: signSecureLocalFrame(AUTHORITY, ENDPOINT_TOKEN, stale),
			}),
		).rejects.toMatchObject({ name: "SdkPreparedDispatchError", code: "connection_closed" });
		expect(transport.requests).toEqual([]);
		const response = await client.request({
			type: "query_request",
			id: "untrusted-correlation",
			query: "session.info",
			[SECURE_LOCAL_PROOF_FIELD]: "untrusted-proof",
		});
		expect(response.id).not.toBe("untrusted-correlation");
		expect(response.ok).toBe(true);
	} finally {
		await client.close();
		await transport.close();
	}
});

test("SdkClient rejects signed stale or unbound connection claims before transport dispatch", async () => {
	const transport = await secureTransportFixture(AUTHORITY, "/tmp/secure-client-connection-binding");
	const client = await SdkClient.connect(transport.url, ENDPOINT_TOKEN);
	try {
		for (const connectionId of [undefined, "", "stale-connection"]) {
			const frame = { type: "query_request", id: "exact-signed-id", query: "auth.read", connectionId };
			const signed = {
				...frame,
				[SECURE_LOCAL_PROOF_FIELD]: signSecureLocalFrame(AUTHORITY, ENDPOINT_TOKEN, frame),
			};
			await expect(client.request(signed)).rejects.toMatchObject({
				name: "SdkPreparedDispatchError",
				code: "connection_closed",
			});
		}
		expect(transport.requests).toEqual([]);
		expect(transport.effects).toEqual([]);
		const frame = { type: "query_request", id: "", query: "auth.read", connectionId: client.connectionId };
		await expect(
			client.request({
				...frame,
				[SECURE_LOCAL_PROOF_FIELD]: signSecureLocalFrame(AUTHORITY, ENDPOINT_TOKEN, frame),
			}),
		).rejects.toMatchObject({ code: "invalid_input" });
		expect(transport.requests).toEqual([]);
	} finally {
		await client.close();
		await transport.close();
	}
});

test("Router reconnects before signing the current connection and rejects stale or pre-send changed identities", async () => {
	const fixture = await secureRouterFixture();
	const connect = spyOn(fixture.client, "connect");
	try {
		const originalConnection = fixture.client.connectionId;
		await fixture.router.request("secure-session", { type: "query_request", query: "auth.status" });
		const originalProof = fixture.requests.at(-1)?.[SECURE_LOCAL_PROOF_FIELD];
		await fixture.disconnect();
		await expect(
			fixture.router.request("secure-session", { type: "query_request", query: "auth.status" }),
		).resolves.toMatchObject({ ok: true, result: { secret: "local-only-reply" } });
		expect(connect).toHaveBeenCalled();
		expect(fixture.client.connectionId).not.toBe(originalConnection);
		expect(fixture.requests.at(-1)?.connectionId).toBe(fixture.client.connectionId);
		expect(fixture.requests.at(-1)?.[SECURE_LOCAL_PROOF_FIELD]).not.toBe(originalProof);
		const sentCount = fixture.requests.length;
		await expect(
			fixture.router.request("secure-session", {
				type: "query_request",
				query: "auth.status",
				connectionId: originalConnection,
			}),
		).rejects.toMatchObject({ phase: "pre_send" });
		expect(fixture.requests).toHaveLength(sentCount);
		await expect(
			fixture.router.request(
				"secure-session",
				{ type: "query_request", query: "auth.status" },
				undefined,
				undefined,
				{
					dispatchFence: async dispatch => {
						await fixture.disconnect();
						await fixture.client.connect();
						return dispatch();
					},
				},
			),
		).rejects.toMatchObject({ phase: "pre_send" });
		expect(fixture.requests).toHaveLength(sentCount);
		await expect(
			fixture.router.request("secure-session", { type: "query_request", query: "auth.status" }),
		).resolves.toMatchObject({ ok: true });
	} finally {
		connect.mockRestore();
		await fixture.close();
	}
});

test("Router admits and signs only its one-time serialized snapshot, not getter or toJSON claims", async () => {
	const fixture = await secureRouterFixture();
	try {
		let reads = 0;
		await fixture.router.request("secure-session", {
			type: "control_request",
			get operation() {
				return ++reads === 1 ? "auth.cancel" : "auth.apiKey.store";
			},
			input: { flowId: "flow" },
		});
		expect(reads).toBe(1);
		expect(fixture.requests.at(-1)?.operation).toBe("auth.cancel");
		let serialized = 0;
		let leaked = false;
		const caller = {
			type: "query_request",
			query: "auth.status",
			toJSON() {
				serialized++;
				leaked = Object.hasOwn(this, "token") || Object.hasOwn(this, SECURE_LOCAL_PROOF_FIELD);
				return { type: "query_request", query: "auth.read", input: { flowId: "not-granted" } };
			},
		};
		await expect(fixture.router.request("secure-session", caller)).rejects.toThrow("does not grant");
		expect(serialized).toBe(1);
		expect(leaked).toBe(false);
		await expect(
			fixture.router.request("secure-session", {
				type: "query_request",
				query: "auth.status",
				operation: "auth.read",
			}),
		).rejects.toThrow("shadow");
		await expect(fixture.router.request("secure-session", { type: "query_request", query: "Q38" })).rejects.toThrow(
			"does not grant",
		);
		await expect(
			fixture.router.request("secure-session", {
				type: "query_request",
				query: "auth.status",
				[SECURE_LOCAL_PROOF_FIELD]: "caller-proof",
			}),
		).rejects.toThrow("cannot supply");
		expect(fixture.requests).toHaveLength(1);
	} finally {
		await fixture.close();
	}
});

test("Router never sends secure replies to notification, event, or correlation observers", async () => {
	for (const customCorrelation of [false, true]) {
		const fixture = await secureRouterFixture(customCorrelation);
		try {
			const result = await fixture.router.request("secure-session", { type: "query_request", query: "auth.status" });
			expect(result).toMatchObject({ result: { secret: "local-only-reply" } });
			fixture.emit(result); // Late duplicate after pending settlement.
			await Bun.sleep(0);
			fixture.emit({ type: "event", payload: { type: "public-event" } });
			await Bun.sleep(0);
			// Real transport readiness/hello frames may reach ordinary observers.
			// Neither those frames nor the public event may expose secure replies,
			// including nested correlated bodies or transport-specific duplicates.
			const observed = JSON.stringify(fixture.observed);
			expect(observed).toContain("public-event");
			expect(observed).not.toContain("local-only-reply");
			expect(observed).not.toContain(SECURE_LOCAL_PROOF_FIELD);
			for (const responseType of ["query_response", "control_response", "transport_specific_reply"])
				expect(observed).not.toContain(responseType);
			if (typeof result.id !== "string") throw new Error("Secure reply did not preserve its request identity.");
			expect(observed).not.toContain(result.id);
		} finally {
			await fixture.close();
		}
	}
});

test("Router preserves native command text but excludes late wrapped SDK replies", async () => {
	for (const customCorrelation of [false, true]) {
		const fixture = await secureRouterFixture(customCorrelation);
		try {
			const response = await fixture.router.request("secure-session", {
				type: "query_request",
				query: "auth.status",
			});
			fixture.emit({
				type: "control_command_result",
				requestId: "native-model-list",
				sessionId: "secure-session",
				status: "ok",
				message: "Available native models",
				modelChoices: [{ selector: "test/model", label: "Test model" }],
			});
			for (const type of ["query_response", "control_response"]) {
				fixture.emit({ type: "control_command_result", message: JSON.stringify({ ...response, type }) });
			}
			fixture.emit({ type: "event", payload: { type: "native-delivery-settled" } });
			await Bun.sleep(0);
			const observed = JSON.stringify(fixture.observed);
			expect(observed).toContain("Available native models");
			expect(observed).toContain("native-delivery-settled");
			expect(observed).not.toContain("local-only-reply");
			expect(observed).not.toContain(SECURE_LOCAL_PROOF_FIELD);
			expect(observed).not.toContain("query_response");
			expect(observed).not.toContain("control_response");
		} finally {
			await fixture.close();
		}
	}
});

test("SdkClient settles exact auth callers but excludes replies and duplicates from generic onFrame", async () => {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			return server.upgrade(request) ? undefined : new Response("upgrade required", { status: 400 });
		},
		websocket: {
			open(socket) {
				socket.send(JSON.stringify({ type: "hello", connectionId: "private-client" }));
			},
			message(socket, message) {
				const frame = JSON.parse(String(message)) as Record<string, unknown>;
				if (frame.type !== "query_request") return;
				const response = {
					type: "query_response",
					id: frame.id,
					ok: true,
					result: { secret: "local-client-only" },
				};
				socket.send(JSON.stringify(response));
				socket.send(JSON.stringify(response));
			},
		},
	});
	const client = new SdkClient(`ws://127.0.0.1:${server.port}`, ENDPOINT_TOKEN, { reconnectAttempts: 0 });
	const observed: Record<string, unknown>[] = [];
	client.onFrame(frame => {
		observed.push(frame);
	});
	try {
		await client.connect();
		const request = {
			type: "query_request",
			id: "sdk-owned-request",
			connectionId: client.connectionId,
			query: "Q38",
			input: { flowId: "flow" },
		};
		const signed = {
			...request,
			[SECURE_LOCAL_PROOF_FIELD]: signSecureLocalFrame(AUTHORITY, ENDPOINT_TOKEN, request),
		};
		let dispatchFrame: Record<string, unknown> | undefined;
		let dispatchRecord: unknown;
		const result = await client.request(signed, {
			onDispatch: context => {
				dispatchFrame = context.frame;
				dispatchRecord = client.getSentRecord(request.id);
			},
		});
		expect(dispatchFrame?.id).toBe(request.id);
		expect(dispatchFrame && verifySecureLocalFrame(AUTHORITY, ENDPOINT_TOKEN, dispatchFrame)).toBe(true);
		expect(dispatchRecord).toBeUndefined();
		expect(result).toMatchObject({ id: request.id, result: { secret: "local-client-only" } });
		expect(client.getSentRecord(request.id)).toBeUndefined();
		await Bun.sleep(0);
		expect(observed.some(frame => frame.type === "hello")).toBe(true);
		expect(JSON.stringify(observed)).not.toContain("local-client-only");
	} finally {
		await client.close();
		await server.stop(true);
	}
});
