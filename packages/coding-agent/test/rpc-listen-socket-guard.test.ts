import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { isUnixSocketAlive, RpcListenRefusedError } from "@gajae-code/coding-agent/modes/rpc/rpc-mode";
import { prepareRpcSocketPath } from "@gajae-code/coding-agent/modes/rpc/rpc-socket-security";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "rpc-listen-guard-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("isUnixSocketAlive (--listen live-owner probe, #606)", () => {
	const originalConnect = Bun.connect;

	afterEach(() => {
		Bun.connect = originalConnect;
	});

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

	it("returns false only for known stale/missing connect error codes", async () => {
		for (const code of ["ENOENT", "ECONNREFUSED"]) {
			Bun.connect = mock(async () => {
				const error = new Error(code) as Error & { code: string };
				error.code = code;
				throw error;
			}) as typeof Bun.connect;

			expect(await isUnixSocketAlive(path.join(dir, `${code}.sock`))).toBe(false);
		}
	});

	it("fails closed for unexpected connect error codes", async () => {
		Bun.connect = mock(async () => {
			const error = new Error("permission denied") as Error & { code: string };
			error.code = "EACCES";
			throw error;
		}) as typeof Bun.connect;

		expect(await isUnixSocketAlive(path.join(dir, "permission.sock"))).toBe(true);
	});
});

describe("--listen duplicate refusal boundary (issue 19)", () => {
	it("prepareRpcSocketPath throws the RpcListenRefusedError class main.ts catches at launch", async () => {
		// main.ts imports RpcListenRefusedError from rpc-mode and only exits cleanly
		// for that class; the refusal thrown on a live socket must be that instance.
		const socketPath = path.join(dir, "duplicate.sock");
		const server = net.createServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, resolve);
		});
		try {
			await chmod(socketPath, 0o600);
			await expect(prepareRpcSocketPath(socketPath)).rejects.toBeInstanceOf(RpcListenRefusedError);
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
});
