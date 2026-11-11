import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionIndex } from "../src/sdk/broker/session-index";
import { SdkClient } from "../src/sdk/client/client";
import { type ControlSurface, dispatchControl } from "../src/sdk/host/control";
import { SessionSdkHost } from "../src/sdk/host/host";
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
			operation: "auth.apiKey.store",
			input: { provider: "test", key: "never-in-observers" },
			capabilities: ["auth.apiKey.store"],
		};
		receive("untrusted", frame);
		await Bun.sleep(0);
		expect(sent.at(-1)).toMatchObject({ ok: false, error: { code: "operation_prohibited" } });
		expect(effects).toBe(0);
		const forged = {
			...frame,
			[SECURE_LOCAL_PROOF_FIELD]: signSecureLocalFrame(ENDPOINT_TOKEN, ENDPOINT_TOKEN, frame),
		};
		receive("endpoint-token-holder", forged);
		await Bun.sleep(0);
		expect(sent.at(-1)).toMatchObject({ ok: false, error: { code: "operation_prohibited" } });
		expect(effects).toBe(0);
		const signed = { ...frame, [SECURE_LOCAL_PROOF_FIELD]: signSecureLocalFrame(AUTHORITY, ENDPOINT_TOKEN, frame) };
		receive("trusted", signed);
		await Bun.sleep(0);
		expect(sent.at(-1)).toMatchObject({ ok: true, result: { saved: true } });
		expect(effects).toBe(1);
		receive("replay", signed);
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
		expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
		expect(await fs.readFile(file)).toHaveLength(32);
		expect(await getSecureLocalAuthority(directory)).toBe(keys[0]!);
		await fs.chmod(file, 0o644);
		await expect(getSecureLocalAuthority(directory)).rejects.toThrow("private regular");
		expect((await fs.stat(file)).mode & 0o777).toBe(0o644);
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

async function secureRouterFixture(customCorrelation = false): Promise<{
	router: SessionRouter;
	requests: Record<string, unknown>[];
	observed: unknown[];
	emit: (frame: Record<string, unknown>) => void;
	close: () => Promise<void>;
}> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-secure-router-"));
	const agentDir = path.join(directory, "agent");
	const authority = await getSecureLocalAuthority(agentDir);
	const stateRoot = path.join(directory, ".gjc", "state");
	await fs.mkdir(path.join(stateRoot, "sdk"), { recursive: true });
	const endpointFile = path.join(stateRoot, "sdk", "secure-session.json");
	await fs.writeFile(
		endpointFile,
		JSON.stringify({ sessionId: "secure-session", url: "ws://fixture.test", token: ENDPOINT_TOKEN, pid: 42 }),
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
	const requests: Record<string, unknown>[] = [];
	let handler: ((frame: Record<string, unknown>) => void) | undefined;
	const client: SessionRouterClient = {
		connectionId: "connection",
		onFrame: next => {
			handler = next;
			return () => {
				handler = undefined;
			};
		},
		request: async (frame, options) => {
			if (frame.type === "event_replay") return { ok: true, generation: 1, lastSeq: 0, events: [] };
			requests.push(frame);
			expect(verifySecureLocalFrame(authority, ENDPOINT_TOKEN, frame)).toBe(true);
			options?.beforeDispatch?.({ frame, connectionId: "connection", generation: 1 });
			const response = {
				type: frame.type === "query_request" ? "query_response" : "control_response",
				id: frame.id,
				ok: true,
				result: { secret: "local-only-reply" },
			};
			handler?.(response);
			// Even a transport-specific response type must be suppressed by the
			// bounded exact pending-ID fence before custom correlation runs.
			handler?.({ ...response, type: "transport_specific_reply" });
			return response;
		},
		close: async () => {},
		send: () => {},
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
	expect(attachment?.connectionId).toBe("connection");
	return {
		router,
		requests,
		observed,
		emit: frame => handler?.(frame),
		close: async () => {
			await router.stop();
			await fs.rm(directory, { recursive: true, force: true });
		},
	};
}

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
			expect(fixture.observed).toEqual([]);
			fixture.emit({ type: "event", payload: { type: "public-event" } });
			await Bun.sleep(0);
			expect(fixture.observed.length).toBeGreaterThan(0);
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
		const request = { type: "query_request", id: "sdk-owned-request", query: "Q38", input: { flowId: "flow" } };
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
