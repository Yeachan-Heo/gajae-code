import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	assertSafeClientSocket,
	prepareRpcSocketPath,
	RpcSocketSecurityError,
	verifyRpcSocketAfterListen,
} from "@gajae-code/coding-agent/modes/rpc/rpc-socket-security";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "rpc-sock-sec-"));
	await chmod(dir, 0o700);
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

// NOTE: a real leftover ("stale") unix socket cannot be reliably created in-process because a
// clean net.Server close() unlinks the socket file. The security-critical paths — refusing a LIVE
// socket and refusing/​not-unlinking non-socket files — are covered below; stale removal is the
// no-conflicting-path resolve case.

describe("rpc socket security", () => {
	test("refuses a symlinked parent", async () => {
		const real = path.join(dir, "real");
		const link = path.join(dir, "link");
		await mkdir(real, { mode: 0o700 });
		await symlink(real, link);
		await expect(prepareRpcSocketPath(path.join(link, "rpc.sock"))).rejects.toThrow(RpcSocketSecurityError);
	});

	test("refuses non-socket paths without unlinking them", async () => {
		for (const kind of ["regular", "directory"] as const) {
			const parent = path.join(dir, kind);
			await mkdir(parent, { mode: 0o700 });
			const socketPath = path.join(parent, "rpc.sock");
			if (kind === "regular") await writeFile(socketPath, "not a socket");
			else await mkdir(socketPath);
			await expect(prepareRpcSocketPath(socketPath)).rejects.toThrow(/not a socket/);
			expect(await lstat(socketPath)).toBeDefined();
		}
	});

	test("refuses unsafe parent mode", async () => {
		const parent = path.join(dir, "unsafe");
		await mkdir(parent, { mode: 0o777 });
		await chmod(parent, 0o777);
		await expect(prepareRpcSocketPath(path.join(parent, "rpc.sock"))).rejects.toThrow(/group\/other permissions/);
	});

	test("refuses a live socket", async () => {
		const socketPath = path.join(dir, "live.sock");
		const server = net.createServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, resolve);
		});
		try {
			await expect(prepareRpcSocketPath(socketPath)).rejects.toThrow(/live/);
			expect((await lstat(socketPath)).isSocket()).toBe(true);
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test("refuses an existing socket with group or other mode before probing or unlinking", async () => {
		const socketPath = path.join(dir, "unsafe-existing.sock");
		const server = net.createServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, resolve);
		});
		try {
			await chmod(socketPath, 0o666);
			await expect(prepareRpcSocketPath(socketPath)).rejects.toThrow(/group\/other permissions/);
			const st = await lstat(socketPath);
			expect(st.isSocket()).toBe(true);
			expect(st.mode & 0o777).toBe(0o666);
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test("removes a confirmed-stale socket", async () => {
		const socketPath = path.join(dir, "stale.sock");
		await expect(prepareRpcSocketPath(socketPath)).resolves.toBeUndefined();
		await expect(lstat(socketPath)).rejects.toThrow();
	});

	test("verify after listen chmods private socket and fails closed on ambiguous path", async () => {
		const socketPath = path.join(dir, "verify.sock");
		const server = net.createServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, resolve);
		});
		try {
			await verifyRpcSocketAfterListen(socketPath);
			expect((await lstat(socketPath)).mode & 0o777).toBe(0o600);
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
		const badPath = path.join(dir, "ambiguous.sock");
		await writeFile(badPath, "not socket");
		await expect(verifyRpcSocketAfterListen(badPath)).rejects.toThrow(/not a socket after listen/);
	});

	test("client validator accepts a live private socket", async () => {
		const socketPath = path.join(dir, "client-live.sock");
		const server = net.createServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, resolve);
		});
		try {
			await chmod(socketPath, 0o600);
			await expect(assertSafeClientSocket(socketPath)).resolves.toBeUndefined();
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test("client validator refuses wrong-owner paths via current uid seam", async () => {
		// A real uid-mismatch socket cannot be created portably in-process without chown privileges.
		// assertSafeClientSocket reads process.getuid at validation time, so overriding that seam
		// exercises the same fail-closed owner-check path against this test-owned fixture.
		const getuid = process.getuid;
		if (typeof getuid !== "function") return;
		Object.defineProperty(process, "getuid", { configurable: true, value: () => getuid.call(process) + 1 });
		try {
			await expect(assertSafeClientSocket(path.join(dir, "missing.sock"))).rejects.toThrow(/owned by uid/);
		} finally {
			Object.defineProperty(process, "getuid", { configurable: true, value: getuid });
		}
	});

	test("client validator refuses symlink non-socket and group-writable socket without unlinking", async () => {
		const regular = path.join(dir, "regular.sock");
		await writeFile(regular, "not a socket");
		await expect(assertSafeClientSocket(regular)).rejects.toThrow(/not a socket/);
		expect(await lstat(regular)).toBeDefined();

		const target = path.join(dir, "target.sock");
		const link = path.join(dir, "link.sock");
		await writeFile(target, "not a socket");
		await symlink(target, link);
		await expect(assertSafeClientSocket(link)).rejects.toThrow(/symlink/);

		const socketPath = path.join(dir, "group-writable.sock");
		const server = net.createServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, resolve);
		});
		try {
			await chmod(socketPath, 0o660);
			await expect(assertSafeClientSocket(socketPath)).rejects.toThrow(/group\/other permissions/);
			expect((await lstat(socketPath)).isSocket()).toBe(true);
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
});
