import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
import { SessionIndex } from "../src/sdk/broker/session-index";

const event = (
	type: "host_registered" | "host_heartbeat" | "host_unregistered",
	sessionId: string,
	stateRoot: string,
	endpointMtimeMs?: number,
) => ({
	type,
	sessionId,
	locator: { repo: "repo", stateRoot },
	endpointGeneration: 1,
	pid: process.pid,
	...(endpointMtimeMs === undefined ? {} : { endpointMtimeMs }),
});

test("broker preserves host registration endpoint metadata across heartbeats", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-host-"));
	const stateRoot = path.join(agentDir, "state");
	const endpointPath = path.join(stateRoot, "sdk", "live.json");
	await fs.mkdir(path.dirname(endpointPath), { recursive: true });
	await fs.writeFile(endpointPath, JSON.stringify({ sessionId: "live", pid: process.pid, token: "session-secret" }));
	const endpointMtimeMs = (await fs.stat(endpointPath)).mtimeMs;
	const broker = new Broker({ agentDir });
	await broker.start();
	try {
		const busIndex = await new SessionIndex(agentDir).open();
		await busIndex.append(event("host_registered", "live", stateRoot, endpointMtimeMs));
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
			result: { indexSeq: 4, sessions: [] },
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
		expect(firstPage).toMatchObject({ indexSeq: 3, sessions: [{ sessionId: "one" }, { sessionId: "two" }] });
		expect(firstPage.continuationCursor).toEqual(expect.any(String));

		await busIndex.append(event("host_registered", "four", stateRoot));
		await fs.appendFile(path.join(agentDir, "sdk", "sessions", "index.jsonl"), '{"version":999}\n');
		const second = await broker.handleRequest("session.list", { cursor: firstPage.continuationCursor });
		expect(second).toMatchObject({
			ok: true,
			indexSeq: 3,
			result: { indexSeq: 3, sessions: [{ sessionId: "three" }] },
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
