import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSdkSessionTransport } from "../../src/harness-control-plane/sdk-transport";
import { SdkDiscoveryError } from "../../src/sdk/client/discovery";

const replay = {
	type: "event_replay_result",
	id: "replay-id",
	ok: true,
	events: [],
	generation: 0,
	lastSeq: 0,
};
const client = {
	onFrame(): void {},
	onReconnectFailed(): void {},
	request: async (): Promise<unknown> => replay,
	query: async (): Promise<unknown> => ({}),
	control: async (): Promise<unknown> => ({}),
	close: async (): Promise<void> => {},
};

function writeRecord(repo: string, sessionId: string, record: unknown): void {
	const dir = path.join(repo, ".gjc", "state", "sdk");
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify(record));
}

async function dial(
	record: unknown,
	rewriteOnSpawn: boolean,
): Promise<{ spawnCalls: number; url?: string; token?: string }> {
	const sessionId = "session-a";
	const repo = mkdtempSync(path.join(tmpdir(), "harness-ep-"));
	try {
		writeRecord(repo, sessionId, record);
		let spawnCalls = 0;
		let url: string | undefined;
		let token: string | undefined;
		const transport = await createSdkSessionTransport({
			repo,
			sessionId,
			discoveryTimeoutMs: 1_000,
			spawn: () => {
				spawnCalls += 1;
				if (rewriteOnSpawn) {
					writeRecord(repo, sessionId, {
						version: 1,
						sessionId,
						url: "ws://127.0.0.1:9",
						token: "spawned-token",
						pid: process.pid,
					});
				}
				return { async stop(): Promise<void> {} };
			},
			connect: async (nextUrl: string, nextToken: string) => {
				url = nextUrl;
				token = nextToken;
				return client as never;
			},
		});
		await transport.close();
		return { spawnCalls, url, token };
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
}

async function deadPid(): Promise<number> {
	const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
		stdout: "ignore",
		stderr: "ignore",
		stdin: "ignore",
	});
	await child.exited;
	if (!child.pid || child.pid <= 0) throw new Error("spawned process had no pid");
	return child.pid;
}

describe("harness owner discovery trust", () => {
	it("does not dial a workspace endpoint that is not a live loopback session", async () => {
		const attack = "ws://127.0.0.1:9/steal?token=fake-token-from-repo";
		const stolen = await dial(
			{ version: 1, sessionId: "session-a", url: attack, token: "fake-token-from-repo", pid: process.pid },
			true,
		);
		expect(stolen.spawnCalls).toBe(1);
		expect(stolen.url).toBe("ws://127.0.0.1:9");
		expect(stolen.token).toBe("spawned-token");

		const remote = await dial(
			{
				version: 1,
				sessionId: "session-a",
				url: "wss://203.0.113.10:443/steal",
				token: "remote-token",
				pid: process.pid,
			},
			true,
		);
		expect(remote.spawnCalls).toBe(1);
		expect(remote.url).toBe("ws://127.0.0.1:9");
		expect(remote.token).not.toBe("remote-token");

		const stale = await dial(
			{
				version: 1,
				sessionId: "session-a",
				url: "ws://127.0.0.1:9",
				token: "stale-token",
				pid: process.pid,
				stale: true,
			},
			true,
		);
		expect(stale.spawnCalls).toBe(1);
		expect(stale.token).toBe("spawned-token");

		const emptyHash = await dial(
			{ version: 1, sessionId: "session-a", url: "ws://127.0.0.1:9/#", token: "hash-token", pid: process.pid },
			true,
		);
		expect(emptyHash.spawnCalls).toBe(1);
		expect(emptyHash.url).toBe("ws://127.0.0.1:9");
		expect(emptyHash.token).toBe("spawned-token");

		const emptyQuery = await dial(
			{ version: 1, sessionId: "session-a", url: "ws://127.0.0.1:9/?", token: "query-token", pid: process.pid },
			true,
		);
		expect(emptyQuery.spawnCalls).toBe(1);
		expect(emptyQuery.url).toBe("ws://127.0.0.1:9");
		expect(emptyQuery.token).toBe("spawned-token");

		const missingPid = await dial(
			{ version: 1, sessionId: "session-a", url: "ws://127.0.0.1:9", token: "no-pid-token" },
			true,
		);
		expect(missingPid.spawnCalls).toBe(1);

		const dead = await dial(
			{ version: 1, sessionId: "session-a", url: "ws://127.0.0.1:9", token: "dead-token", pid: await deadPid() },
			true,
		);
		expect(dead.spawnCalls).toBe(1);
		expect(dead.token).toBe("spawned-token");
	});

	it("propagates a first discovery read error without spawning", async () => {
		const cases = [
			new SdkDiscoveryError(
				"sdk/session-a.json",
				"SDK endpoint discovery record session id does not match its filename.",
			),
			new SdkDiscoveryError("sdk/session-a.json", "SDK endpoint discovery record must be an object."),
		];
		for (const error of cases) {
			let spawnCalls = 0;
			let connectCalls = 0;
			await expect(
				createSdkSessionTransport({
					repo: "unused-repo",
					sessionId: "session-a",
					discoveryTimeoutMs: 1_000,
					readEndpoint: async () => {
						throw error;
					},
					spawn: () => {
						spawnCalls += 1;
						return { async stop(): Promise<void> {} };
					},
					connect: async () => {
						connectCalls += 1;
						return client as never;
					},
				}),
			).rejects.toBe(error);
			expect(spawnCalls).toBe(0);
			expect(connectCalls).toBe(0);
		}
	});

	it("rejects port-zero and IPv4-mapped IPv6 discovery and still attaches to port one and IPv6 loopback", async () => {
		for (const url of [
			"ws://127.0.0.1:0",
			"ws://[::1]:0",
			"ws://[::ffff:127.0.0.1]:9",
			"ws://[::ffff:7f00:1]:9",
			"ws://[::FFFF:127.0.0.1]:1",
		]) {
			const rejected = await dial(
				{ version: 1, sessionId: "session-a", url, token: "rejected-token", pid: process.pid },
				true,
			);
			expect(rejected.spawnCalls).toBe(1);
			expect(rejected.url).toBe("ws://127.0.0.1:9");
			expect(rejected.url).not.toBe(url);
			expect(rejected.token).toBe("spawned-token");
			expect(rejected.token).not.toBe("rejected-token");
		}
		for (const url of ["ws://127.0.0.1:1", "ws://[::1]:9", "ws://[::1]:1"]) {
			const attached = await dial(
				{ version: 1, sessionId: "session-a", url, token: "kept-token", pid: process.pid },
				false,
			);
			expect(attached.spawnCalls).toBe(0);
			expect(attached.url).toBe(url);
			expect(attached.token).toBe("kept-token");
		}
	});

	it("keeps two concurrent discovery attaches on their own records", async () => {
		const [left, right] = await Promise.all([
			dial(
				{ version: 1, sessionId: "session-a", url: "ws://127.0.0.1:1", token: "left-token", pid: process.pid },
				false,
			),
			dial(
				{ version: 1, sessionId: "session-a", url: "ws://[::1]:9", token: "right-token", pid: process.pid },
				false,
			),
		]);
		expect(left.spawnCalls).toBe(0);
		expect(left.url).toBe("ws://127.0.0.1:1");
		expect(left.token).toBe("left-token");
		expect(right.spawnCalls).toBe(0);
		expect(right.url).toBe("ws://[::1]:9");
		expect(right.token).toBe("right-token");
	});

	it("still attaches to a live loopback endpoint without spawning", async () => {
		for (const url of [
			"ws://127.0.0.1:9",
			"ws://127.0.0.1:9/",
			"ws://localhost:9",
			"ws://LOCALHOST:9",
			"ws://[::1]:9",
			"ws://127.0.0.1",
			" ws://127.0.0.1:9 ",
			"ws://2130706433:9",
			"ws://127.0.0.2:9",
			"ws://127.1.2.3:9",
			"ws://2130706434:9",
			"wss://127.0.0.1:9",
			"wss://127.0.0.1",
			"ws://localhost.:9",
			"ws://127.0.0.1.:9",
		]) {
			const attached = await dial(
				{ version: 1, sessionId: "session-a", url, token: "kept-token", pid: process.pid },
				false,
			);
			expect(attached.spawnCalls).toBe(0);
			expect(attached.url).toBe(url);
			expect(attached.token).toBe("kept-token");
		}
	});
});
