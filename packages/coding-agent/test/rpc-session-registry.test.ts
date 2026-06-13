import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	listRpcSessions,
	type RpcSessionRecord,
	registerRpcSession,
	unregisterRpcSession,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/session-registry";

let agentDir: string;

beforeEach(async () => {
	agentDir = await mkdtemp(path.join(tmpdir(), "rpc-reg-"));
});

afterEach(async () => {
	await rm(agentDir, { recursive: true, force: true });
});

function rec(over: Partial<RpcSessionRecord> = {}): RpcSessionRecord {
	return {
		sessionId: "s1",
		pid: process.pid,
		transport: "stdio",
		cwd: "/tmp",
		model: "test-model",
		startedAt: new Date().toISOString(),
		...over,
	};
}

describe("rpc session registry (issue 10)", () => {
	test("register then list returns the live record; unregister removes it", async () => {
		await registerRpcSession(rec({ sessionId: "live" }), agentDir);
		expect((await listRpcSessions(agentDir)).map(s => s.sessionId)).toEqual(["live"]);
		await unregisterRpcSession("live", agentDir);
		expect(await listRpcSessions(agentDir)).toEqual([]);
	});

	test("listing reaps records whose process is dead and keeps live ones", async () => {
		await registerRpcSession(
			rec({ sessionId: "alive", pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z" }),
			agentDir,
		);
		await registerRpcSession(
			rec({ sessionId: "dead", pid: 2 ** 30, startedAt: "2026-01-02T00:00:00.000Z" }),
			agentDir,
		);
		expect((await listRpcSessions(agentDir)).map(s => s.sessionId)).toEqual(["alive"]);
		expect(await readdir(path.join(agentDir, "rpc-sessions"))).toEqual(["alive.json"]);
	});

	test("listing reaps unparseable records", async () => {
		await registerRpcSession(rec({ sessionId: "ok" }), agentDir);
		const dir = path.join(agentDir, "rpc-sessions");
		await writeFile(path.join(dir, "junk.json"), "{not valid json");
		expect((await listRpcSessions(agentDir)).map(s => s.sessionId)).toEqual(["ok"]);
		expect((await readdir(dir)).sort()).toEqual(["ok.json"]);
	});

	test("missing registry directory lists empty", async () => {
		expect(await listRpcSessions(path.join(agentDir, "does-not-exist"))).toEqual([]);
	});

	test("records sort by startedAt ascending", async () => {
		await registerRpcSession(rec({ sessionId: "second", startedAt: "2026-02-01T00:00:00.000Z" }), agentDir);
		await registerRpcSession(rec({ sessionId: "first", startedAt: "2026-01-01T00:00:00.000Z" }), agentDir);
		expect((await listRpcSessions(agentDir)).map(s => s.sessionId)).toEqual(["first", "second"]);
	});
});
