import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { isUnixSocketAlive } from "@gajae-code/coding-agent/modes/rpc/rpc-mode";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "rpc-listen-guard-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("isUnixSocketAlive (--listen live-owner probe, #606)", () => {
	it("returns false for a socket path that does not exist", async () => {
		expect(await isUnixSocketAlive(path.join(dir, "missing.sock"))).toBe(false);
	});

	it("returns false for a non-socket file at the path", async () => {
		const filePath = path.join(dir, "not-a-socket");
		await Bun.write(filePath, "stale");
		expect(await isUnixSocketAlive(filePath)).toBe(false);
	});

	it("returns true while a live server is listening, false after it stops", async () => {
		const socketPath = path.join(dir, "live.sock");
		const server = Bun.listen({
			unix: socketPath,
			socket: { data() {}, open() {}, error() {}, close() {} },
		});

		expect(await isUnixSocketAlive(socketPath)).toBe(true);

		server.stop(true);
		expect(await isUnixSocketAlive(socketPath)).toBe(false);
	});
});
