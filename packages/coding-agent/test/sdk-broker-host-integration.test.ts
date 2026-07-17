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
