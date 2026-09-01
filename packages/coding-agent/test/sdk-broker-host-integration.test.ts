import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "../src/extensibility/extensions";
import { Broker } from "../src/sdk/broker/broker";
import { processIncarnation } from "../src/sdk/broker/process-incarnation";
import { SessionIndex } from "../src/sdk/broker/session-index";
import { createSdkSessionRuntimeExtension } from "../src/sdk/host/session-runtime";
import { createSdkWebSocketTransport } from "../src/sdk/host/websocket-transport";
import { SessionRouter } from "../src/sdk/router/session-router";

const event = (
	type: "host_registered" | "host_heartbeat" | "host_unregistered",
	sessionId: string,
	stateRoot: string,
	endpointMtimeMs?: number,
	endpointFileId?: string,
) => ({
	type,
	sessionId,
	locator: { cwd: "repo", worktreeRoot: null, stateRoot },
	endpointGeneration: 1,
	pid: process.pid,
	...(endpointMtimeMs === undefined ? {} : { endpointMtimeMs }),
	...(endpointFileId === undefined ? {} : { endpointFileId }),
});

test("broker preserves host registration endpoint metadata across heartbeats", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-host-"));
	const stateRoot = path.join(agentDir, "state");
	const endpointPath = path.join(stateRoot, "sdk", "live.json");
	await fs.mkdir(path.dirname(endpointPath), { recursive: true });
	await fs.writeFile(endpointPath, JSON.stringify({ sessionId: "live", pid: process.pid, token: "session-secret" }));
	const endpointIdentity = await fs.stat(endpointPath, { bigint: true });
	const endpointMtimeMs = Number(endpointIdentity.mtimeNs) / 1_000_000;
	const endpointFileId = `${endpointIdentity.dev}:${endpointIdentity.ino}`;
	const broker = new Broker({ agentDir });
	await broker.start();
	try {
		const busIndex = await new SessionIndex(agentDir).open();
		await busIndex.append(event("host_registered", "live", stateRoot, endpointMtimeMs, endpointFileId));
		await busIndex.append(event("host_heartbeat", "live", stateRoot));
		await busIndex.append(event("host_heartbeat", "live", stateRoot));
		expect(await broker.handleRequest("session.get_endpoint", { sessionId: "live", endpointGeneration: 1 })).toEqual({
			ok: true,
			result: { sessionId: "live", pid: process.pid, token: "session-secret" },
		});
		expect(await broker.handleRequest("session.list", {})).toMatchObject({
			ok: true,
			result: { indexSeq: 3, sessions: [{ sessionId: "live", live: true, endpointMtimeMs }] },
		});
		await fs.writeFile(endpointPath, JSON.stringify({ sessionId: "live", pid: process.pid, token: "replaced" }));
		expect(await broker.handleRequest("session.get_endpoint", { sessionId: "live", endpointGeneration: 1 })).toEqual({
			ok: false,
			error: { code: "endpoint_stale", message: "session endpoint is stale" },
		});
		await busIndex.append(event("host_unregistered", "live", stateRoot));
		expect(await broker.handleRequest("session.list", {})).toMatchObject({
			ok: true,
			result: { indexSeq: 4, sessions: [{ sessionId: "live", live: false, terminal: true }] },
		});
	} finally {
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("broker session.list returns bounded stable cursor pages", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-page-"));
	const stateRoot = path.join(agentDir, "state");
	const broker = new Broker({ agentDir });
	await broker.start();
	try {
		const busIndex = await new SessionIndex(agentDir).open();
		await busIndex.append(event("host_registered", "one", stateRoot));
		await busIndex.append(event("host_registered", "two", stateRoot));
		await busIndex.append(event("host_registered", "three", stateRoot));

		const first = await broker.handleRequest("session.list", { limit: 2 });
		expect(first.ok).toBe(true);
		if (!first.ok) throw new Error(first.error.message);
		const firstPage = first.result as {
			indexSeq: number;
			sessions: Array<{ sessionId: string }>;
			continuationCursor?: string;
		};
		expect(firstPage.sessions).toMatchObject([{ sessionId: "one" }, { sessionId: "two" }]);
		expect(firstPage.continuationCursor).toEqual(expect.any(String));

		await busIndex.append(event("host_registered", "four", stateRoot));
		await fs.appendFile(path.join(agentDir, "sdk", "sessions", "index.jsonl"), '{"version":999}\n');
		const second = await broker.handleRequest("session.list", { cursor: firstPage.continuationCursor });
		expect(second).toMatchObject({
			ok: true,
			indexSeq: firstPage.indexSeq,
			result: { indexSeq: firstPage.indexSeq, sessions: [{ sessionId: "three" }] },
		});
		expect(JSON.stringify(second)).not.toContain('"four"');
		expect(await broker.handleRequest("session.list", { limit: 101 })).toEqual({
			ok: false,
			error: { code: "invalid_input", message: "limit must be a safe integer from 1 to 100" },
		});
	} finally {
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("broker session.list keeps cursor warnings snapshot-stable", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-warning-snapshot-"));
	const stateRoot = path.join(agentDir, "state");
	const broker = new Broker({ agentDir });
	await broker.start();
	try {
		const busIndex = await new SessionIndex(agentDir).open();
		await busIndex.append(event("host_registered", "one", stateRoot));
		await busIndex.append(event("host_registered", "two", stateRoot));
		const first = await broker.handleRequest("session.list", { limit: 1 });
		expect(first.ok).toBe(true);
		if (!first.ok) throw new Error(first.error.message);
		const firstPage = first.result as { continuationCursor?: string; warnings: string[] };
		expect(firstPage.warnings).toEqual([]);
		await fs.appendFile(path.join(agentDir, "sdk", "sessions", "index.jsonl"), "not json\n");
		const second = await broker.handleRequest("session.list", { cursor: firstPage.continuationCursor });
		expect(second).toMatchObject({ ok: true, result: { sessions: [{ sessionId: "two" }], warnings: [] } });
	} finally {
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("broker session.list rejects a new cursor stream at capacity without evicting active cursors", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-cursor-capacity-"));
	const stateRoot = path.join(agentDir, "state");
	const broker = new Broker({ agentDir });
	await broker.start();
	try {
		const busIndex = await new SessionIndex(agentDir).open();
		const sessionIds = Array.from({ length: 2 }, (_, index) => `session-${index + 1}`);
		for (const sessionId of sessionIds) await busIndex.append(event("host_registered", sessionId, stateRoot));

		const cursors: string[] = [];
		for (let index = 0; index < 32; index += 1) {
			const response = await broker.handleRequest("session.list", { limit: 1 });
			expect(response.ok).toBe(true);
			if (!response.ok) throw new Error(response.error.message);
			const page = response.result as { continuationCursor?: string };
			expect(page.continuationCursor).toEqual(expect.any(String));
			cursors.push(page.continuationCursor as string);
		}

		// Exact inspection is not a paginated list. Even with all 32 cursor slots
		// occupied it returns the one requested row without allocating a cursor.
		expect(await broker.handleRequest("session.list", { resolveSessionId: "session-2" })).toMatchObject({
			ok: true,
			result: { sessions: [{ sessionId: "session-2" }] },
		});
		const exact = await broker.handleRequest("session.list", { resolveSessionId: "session-2" });
		expect(exact.ok && (exact.result as { continuationCursor?: string }).continuationCursor).toBeUndefined();

		expect(await broker.handleRequest("session.list", { limit: 1 })).toEqual({
			ok: false,
			error: { code: "invalid_input", message: "session.list cursor capacity is exhausted" },
		});

		const continued = await broker.handleRequest("session.list", { cursor: cursors[0] });
		expect(continued).toMatchObject({
			ok: true,
			result: { sessions: [{ sessionId: "session-2" }] },
		});
		if (!continued.ok) throw new Error(continued.error.message);
		expect(await broker.handleRequest("session.list", { cursor: cursors[0] })).toEqual({
			ok: false,
			error: { code: "invalid_input", message: "cursor is expired or invalid" },
		});
		expect(await broker.handleRequest("session.list", { limit: 1 })).toMatchObject({
			ok: true,
			result: { sessions: [{ sessionId: "session-1" }], continuationCursor: expect.any(String) },
		});
	} finally {
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("SDK-only runtime registers its broker endpoint and retracts it on shutdown", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-only-broker-"));
	const cwd = path.join(agentDir, "workspace");
	const sessionId = "sdk-only-live";
	const lifecycleRequestId = "sdk-only-live-marker";
	const broker = new Broker({ agentDir });
	await broker.start();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void | Promise<void>>();
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	createSdkSessionRuntimeExtension(api, {
		agentDir,
		brokerRegistrationRequired: true,
		lifecycleRequestId,
		createTransport: input => createSdkWebSocketTransport(input),
	});
	const pendingGateIds = new Set(["gate-answer", "gate-approve", "gate-drain"]);
	let drainGateResolution: (() => void) | undefined;
	const workflowGate = {
		listWorkflowGateQueryRecords: () =>
			[...pendingGateIds].map(gateId => ({ id: `pending:${gateId}`, gate_id: gateId, tag: "pending" })),
		listPendingGates: () => [...pendingGateIds].map(gate_id => ({ gate_id })),
		resolveGate: async (response: { gate_id: string }) => {
			if (response.gate_id === "gate-drain")
				return await new Promise(resolve => {
					drainGateResolution = () => {
						pendingGateIds.delete(response.gate_id);
						resolve({ gate_id: response.gate_id, status: "accepted" });
					};
				});
			pendingGateIds.delete(response.gate_id);
			return { gate_id: response.gate_id, status: "accepted" };
		},
		recoverAcceptedGates: async () => [],
		lookupCompletedResolution: () => ({ kind: "none" }),
		prepareTerminalization: () => true,
		clearPreparedTerminalization: () => {},
		registerGateTerminalController: () => () => {},
		quarantineGate: () => {},
	};
	const context = {
		cwd,
		sdkBindings: () => [],
		sessionManager: { getSessionId: () => sessionId, getSessionName: () => undefined },
		workflowGate,
	} as unknown as ExtensionContext;
	try {
		const start = handlers.get("session_start");
		if (!start) throw new Error("SDK-only session_start handler was not registered.");
		await start({}, context);
		await broker.index.refresh();
		expect(broker.index.listSessions().sessions.find(session => session.sessionId === sessionId)).toMatchObject({
			lifecycleRequestId,
		});
		expect(await broker.handleRequest("session.get_endpoint", { sessionId, endpointGeneration: 1 })).toMatchObject({
			ok: true,
			result: { sessionId, pid: process.pid, url: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:/) },
		});
		const endpoint = await broker.handleRequest("session.get_endpoint", { sessionId, endpointGeneration: 1 });
		if (!endpoint.ok) throw new Error(endpoint.error.message);
		const socket = new WebSocket(
			`${(endpoint.result as { url: string; token: string }).url}?token=${encodeURIComponent((endpoint.result as { token: string }).token)}`,
		);
		const frames: Array<Record<string, unknown>> = [];
		socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("error", () => reject(new Error("SDK-only WebSocket failed to open.")), {
				once: true,
			});
		});
		const request = async (id: string, frame: Record<string, unknown>) => {
			socket.send(JSON.stringify({ ...frame, id }));
			const deadline = Date.now() + 2_000;
			while (!frames.some(candidate => candidate.id === id)) {
				if (Date.now() > deadline) throw new Error(`Timed out awaiting ${id}.`);
				await Bun.sleep(10);
			}
			return frames.find(candidate => candidate.id === id)!;
		};
		expect(await request("gates", { type: "query_request", query: "Q12", input: {} })).toMatchObject({
			type: "query_response",
			ok: true,
			page: { items: [{ gate_id: "gate-answer" }, { gate_id: "gate-approve" }, { gate_id: "gate-drain" }] },
		});
		expect(
			await request("wrong-session", {
				type: "control_request",
				operation: "workflow.gate_answer",
				input: { id: "gate-answer", response: "approve", expectedSessionId: "wrong-session" },
			}),
		).toMatchObject({ type: "control_response", ok: false, error: { code: "resource_gone" } });
		expect(
			await request("answer", {
				type: "control_request",
				operation: "workflow.gate_answer",
				input: { id: "gate-answer", response: "approve", expectedSessionId: sessionId },
			}),
		).toMatchObject({ type: "control_response", ok: true, result: { status: "accepted" } });
		expect(
			await request("approve", {
				type: "control_request",
				operation: "workflow.plan_approve",
				input: { id: "gate-approve", choice: "approve", expectedSessionId: sessionId },
			}),
		).toMatchObject({ type: "control_response", ok: true, result: { status: "accepted" } });
		socket.send(
			JSON.stringify({
				type: "control_request",
				id: "drain",
				operation: "workflow.gate_answer",
				input: { id: "gate-drain", response: "approve", expectedSessionId: sessionId },
			}),
		);
		while (!drainGateResolution) await Bun.sleep(10);
		const shutdown = handlers.get("session_shutdown");
		if (!shutdown) throw new Error("SDK-only session_shutdown handler was not registered.");
		const stopping = Promise.resolve(shutdown({}, context));
		await Bun.sleep(10);
		expect(await broker.handleRequest("session.get_endpoint", { sessionId, endpointGeneration: 1 })).toMatchObject({
			ok: true,
		});
		drainGateResolution();
		await stopping;
		expect(await broker.handleRequest("session.get_endpoint", { sessionId, endpointGeneration: 1 })).toMatchObject({
			ok: false,
			error: { code: "resource_gone", message: "session endpoint record is gone" },
		});
	} finally {
		const shutdown = handlers.get("session_shutdown");
		if (shutdown) await Promise.resolve(shutdown({}, context)).catch(() => undefined);
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("resumed direct SDK-only session replaces generation zero and is usable through the Router", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-direct-resume-"));
	const cwd = path.join(agentDir, "workspace");
	const stateRoot = path.join(cwd, ".gjc", "state");
	const sessionId = "sdk-direct-resume";
	await fs.mkdir(cwd, { recursive: true });
	let broker = new Broker({ agentDir });
	await broker.start();
	const index = await new SessionIndex(agentDir).open();
	const incarnation = processIncarnation(process.pid);
	await index.append({
		type: "host_registered",
		sessionId,
		locator: { cwd, worktreeRoot: null, stateRoot: agentDir },
		endpointGeneration: 0,
		pid: process.pid,
		...(incarnation ? { processIncarnation: incarnation } : {}),
	});
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void | Promise<void>>();
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	createSdkSessionRuntimeExtension(api, {
		agentDir,
		createTransport: input => createSdkWebSocketTransport(input),
	});
	const pendingGateIds = new Set(["resume-gate"]);
	const context = {
		cwd,
		sdkBindings: () => [],
		sessionManager: { getSessionId: () => sessionId, getSessionName: () => "Resumed direct session" },
		workflowGate: {
			listWorkflowGateQueryRecords: () =>
				[...pendingGateIds].map(gateId => ({ id: `pending:${gateId}`, gate_id: gateId, tag: "pending" })),
			listPendingGates: () => [...pendingGateIds].map(gate_id => ({ gate_id })),
			resolveGate: async (response: { gate_id: string }) => {
				pendingGateIds.delete(response.gate_id);
				return { gate_id: response.gate_id, status: "accepted" };
			},
			recoverAcceptedGates: async () => [],
			lookupCompletedResolution: () => ({ kind: "none" }),
			prepareTerminalization: () => true,
			clearPreparedTerminalization: () => {},
			registerGateTerminalController: () => () => {},
			quarantineGate: () => {},
		},
	} as unknown as ExtensionContext;
	const router = new SessionRouter({ agentDir, sessionIds: [sessionId] });
	try {
		const start = handlers.get("session_start");
		if (!start) throw new Error("SDK-only session_start handler was not registered.");
		await start({}, context);
		await index.refresh();
		let resumed = index.listSessions().sessions.find(session => session.sessionId === sessionId);
		expect(resumed).toMatchObject({
			endpointGeneration: 1,
			live: true,
			terminal: false,
			ambiguous: false,
			locator: { cwd, stateRoot },
		});
		expect(resumed?.endpointMtimeMs).toEqual(expect.any(Number));
		const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
		const endpointIdentity = await fs.lstat(endpointPath, { bigint: true });
		const endpointMtimeMs = Number(endpointIdentity.mtimeNs) / 1_000_000;
		await index.append({
			type: "host_registered",
			sessionId,
			locator: { cwd, worktreeRoot: null, stateRoot },
			endpointGeneration: 1,
			pid: process.pid,
			endpointMtimeMs: endpointMtimeMs + 0.0005,
			endpointFileId: `${endpointIdentity.dev}:${endpointIdentity.ino}`,
			...(incarnation ? { processIncarnation: incarnation } : {}),
		});
		await index.refresh();
		resumed = index.listSessions().sessions.find(session => session.sessionId === sessionId);
		expect(Math.abs(endpointMtimeMs - resumed!.endpointMtimeMs!)).toBeGreaterThan(0);
		expect(Math.abs(endpointMtimeMs - resumed!.endpointMtimeMs!)).toBeLessThanOrEqual(0.001);
		expect(resumed?.endpointFileId).toBe(`${endpointIdentity.dev}:${endpointIdentity.ino}`);

		await broker.stop();
		broker = new Broker({ agentDir });
		await broker.start();
		expect(await broker.handleRequest("session.get_endpoint", { sessionId, endpointGeneration: 1 })).toMatchObject({
			ok: true,
			result: { sessionId, pid: process.pid, url: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:/) },
		});

		await router.start();
		const attachment = router.attachment(sessionId);
		expect(attachment).not.toBeNull();
		expect(attachment?.generation).toBe(1);
		expect(
			await router.request(
				sessionId,
				{ type: "query_request", id: "resume-query", query: "Q12", input: {} },
				1,
				attachment ?? undefined,
			),
		).toMatchObject({
			type: "query_response",
			ok: true,
			page: { items: [{ gate_id: "resume-gate" }] },
		});
		expect(
			await router.request(
				sessionId,
				{
					type: "control_request",
					id: "resume-control",
					operation: "workflow.gate_answer",
					input: { id: "resume-gate", response: "approve", expectedSessionId: sessionId },
				},
				1,
				attachment ?? undefined,
			),
		).toMatchObject({ type: "control_response", ok: true, result: { status: "accepted" } });
	} finally {
		await router.stop().catch(() => undefined);
		const shutdown = handlers.get("session_shutdown");
		if (shutdown) await Promise.resolve(shutdown({}, context)).catch(() => undefined);
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("SDK-only runtime rejects an endpoint substituted before broker registration", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-registration-authority-"));
	const cwd = path.join(agentDir, "workspace");
	const sessionId = "sdk-registration-authority";
	const broker = new Broker({ agentDir });
	await broker.start();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void | Promise<void>>();
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	createSdkSessionRuntimeExtension(api, {
		agentDir,
		brokerRegistrationRequired: true,
		lifecycleRequestId: "sdk-registration-authority-marker",
		createTransport: async input => {
			const transport = await createSdkWebSocketTransport(input);
			const realStart = transport.start.bind(transport);
			return {
				...transport,
				start: async () => {
					const endpoint = await realStart();
					const endpointPath = path.join(input.stateRoot, "sdk", `${input.sessionId}.json`);
					await fs.rename(endpointPath, `${endpointPath}.substituted`);
					await fs.writeFile(
						endpointPath,
						JSON.stringify({
							version: 1,
							sessionId: input.sessionId,
							pid: process.pid,
							url: "ws://127.0.0.1:1",
							token: "substituted-endpoint-token",
						}),
						{ encoding: "utf8", mode: 0o600 },
					);
					return endpoint;
				},
			};
		},
	});
	const context = {
		cwd,
		sdkBindings: () => [],
		sessionManager: { getSessionId: () => sessionId, getSessionName: () => undefined },
	} as unknown as ExtensionContext;
	try {
		const start = handlers.get("session_start");
		if (!start) throw new Error("SDK-only session_start handler was not registered.");
		await expect(start({}, context)).rejects.toThrow("SDK endpoint did not match the published transport authority.");
		expect(await broker.handleRequest("session.get_endpoint", { sessionId, endpointGeneration: 1 })).toMatchObject({
			ok: false,
			error: { code: "resource_gone" },
		});
	} finally {
		const shutdown = handlers.get("session_shutdown");
		if (shutdown) await Promise.resolve(shutdown({}, context)).catch(() => undefined);
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});
