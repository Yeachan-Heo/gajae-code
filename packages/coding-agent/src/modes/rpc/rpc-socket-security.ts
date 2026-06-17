import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";

export class RpcSocketSecurityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RpcSocketSecurityError";
	}
}

const unsafeBits = 0o077;

function currentUid(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function assertOwned(stat: { uid: number }, target: string): void {
	const uid = currentUid();
	if (uid !== undefined && stat.uid !== uid) {
		throw new RpcSocketSecurityError(`${target} is owned by uid ${stat.uid}, expected ${uid}`);
	}
}

function assertPrivateMode(mode: number, target: string): void {
	if ((mode & unsafeBits) !== 0) throw new RpcSocketSecurityError(`${target} has group/other permissions`);
}

export async function prepareRpcSocketPath(socketPath: string): Promise<void> {
	const parent = path.dirname(socketPath);
	let parentStat: import("node:fs").Stats;
	try {
		parentStat = await fs.lstat(parent);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		await fs.mkdir(parent, { recursive: true, mode: 0o700 });
		parentStat = await fs.lstat(parent);
	}
	if (parentStat.isSymbolicLink()) throw new RpcSocketSecurityError(`RPC socket parent is a symlink: ${parent}`);
	if (!parentStat.isDirectory()) throw new RpcSocketSecurityError(`RPC socket parent is not a directory: ${parent}`);
	assertOwned(parentStat, parent);
	assertPrivateMode(parentStat.mode, parent);

	let existing: import("node:fs").Stats;
	try {
		existing = await fs.lstat(socketPath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
		throw err;
	}
	if (existing.isSymbolicLink()) throw new RpcSocketSecurityError(`RPC socket path is a symlink: ${socketPath}`);
	assertOwned(existing, socketPath);
	if (!existing.isSocket()) throw new RpcSocketSecurityError(`RPC socket path is not a socket: ${socketPath}`);
	assertPrivateMode(existing.mode, socketPath);
	if (await probeUnixSocketAlive(socketPath)) {
		throw new RpcSocketSecurityError(`RPC socket path is live: ${socketPath}`);
	}
	await fs.unlink(socketPath);
}

export async function assertSafeClientSocket(socketPath: string): Promise<void> {
	const parent = path.dirname(socketPath);
	const parentStat = await fs.lstat(parent);
	if (parentStat.isSymbolicLink()) throw new RpcSocketSecurityError(`RPC socket parent is a symlink: ${parent}`);
	if (!parentStat.isDirectory()) throw new RpcSocketSecurityError(`RPC socket parent is not a directory: ${parent}`);
	assertOwned(parentStat, parent);
	assertPrivateMode(parentStat.mode, parent);

	const socketStat = await fs.lstat(socketPath);
	if (socketStat.isSymbolicLink()) throw new RpcSocketSecurityError(`RPC socket path is a symlink: ${socketPath}`);
	assertOwned(socketStat, socketPath);
	if (!socketStat.isSocket()) throw new RpcSocketSecurityError(`RPC socket path is not a socket: ${socketPath}`);
	assertPrivateMode(socketStat.mode, socketPath);
}

export async function verifyRpcSocketAfterListen(socketPath: string): Promise<void> {
	await fs.chmod(socketPath, 0o600);
	const st = await fs.lstat(socketPath);
	if (st.isSymbolicLink()) throw new RpcSocketSecurityError(`RPC socket path became a symlink: ${socketPath}`);
	if (!st.isSocket()) throw new RpcSocketSecurityError(`RPC socket path is not a socket after listen: ${socketPath}`);
	assertOwned(st, socketPath);
	assertPrivateMode(st.mode, socketPath);
}

export function probeUnixSocketAlive(socketPath: string): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection({ path: socketPath });
		let settled = false;
		const settle = (value: boolean) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(value);
		};
		socket.once("connect", () => settle(true));
		socket.once("error", err => {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ECONNREFUSED") settle(false);
			else reject(err);
		});
		socket.setTimeout(1000, () => reject(new RpcSocketSecurityError(`timed out probing ${socketPath}`)));
	});
}
