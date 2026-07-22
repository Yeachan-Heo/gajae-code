import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { MAX_UNIX_SOCKET_PATH_BYTES } from "../../harness-control-plane/storage";
import { authenticatePreface } from "./auth-preface";
import type { ServeHandle, ServeOptions } from "./index";
import type { RelayOptions, RelayPair, TransportError } from "./relay";
import { startRelayPair } from "./relay";

function socketFailure(code: string): Error {
	return new Error(code);
}

async function validateSocketPath(socketPath: string): Promise<void> {
	if (process.platform === "win32") throw socketFailure("unsupported_platform");
	if (Buffer.byteLength(socketPath) > MAX_UNIX_SOCKET_PATH_BYTES) throw socketFailure("socket_path_too_long");
	try {
		await fs.lstat(socketPath);
		throw socketFailure("socket_path_in_use");
	} catch (error) {
		if (error instanceof Error && error.message === "socket_path_in_use") throw error;
		const code = error as NodeJS.ErrnoException;
		if (code.code !== "ENOENT") throw error;
	}
	let parent: Awaited<ReturnType<typeof fs.stat>>;
	try {
		parent = await fs.stat(path.dirname(socketPath));
	} catch {
		throw socketFailure("socket_dir_insecure");
	}
	if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o022) !== 0)
		throw socketFailure("socket_dir_insecure");
}

function sendTransportError(socket: net.Socket, error: TransportError): void {
	socket.write(`${JSON.stringify(error)}\n`);
}

/** Serves authenticated SDK JSONL clients over a private Unix-domain socket. */
export async function startSocketServe(
	options: ServeOptions & { socketPath: string; webSocketFactory?: RelayOptions["webSocketFactory"] },
): Promise<ServeHandle> {
	await validateSocketPath(options.socketPath);
	const pairs = new Set<RelayPair>();
	const sockets = new Set<net.Socket>();
	const connectionTasks = new Set<Promise<void>>();
	const dialControllers = new Set<AbortController>();
	let server: net.Server | undefined;
	let ownedIdentity: { dev: number; ino: number } | undefined;
	let closing: Promise<void> | undefined;
	const done = Promise.withResolvers<void>();
	void done.promise.catch(() => undefined);

	const removeOwnedSocket = async (): Promise<void> => {
		if (!ownedIdentity) return;
		try {
			const current = await fs.lstat(options.socketPath);
			if (current.isSocket() && current.dev === ownedIdentity.dev && current.ino === ownedIdentity.ino)
				await fs.unlink(options.socketPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	};

	const removeOwnedSocketSync = (): void => {
		if (!ownedIdentity) return;
		try {
			const current = fsSync.lstatSync(options.socketPath);
			if (current.isSocket() && current.dev === ownedIdentity.dev && current.ino === ownedIdentity.ino)
				fsSync.unlinkSync(options.socketPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	};
	const cleanupOnExit = (): void => removeOwnedSocketSync();
	process.once("exit", cleanupOnExit);
	const close = async (fatalError?: Error): Promise<void> => {
		if (closing) return await closing;
		closing = (async () => {
			const errors: Error[] = fatalError ? [fatalError] : [];
			for (const controller of dialControllers) controller.abort();
			for (const socket of sockets) socket.destroy();
			const pairResults = await Promise.allSettled([...pairs].map(pair => pair.close()));
			for (const result of pairResults) {
				if (result.status === "rejected")
					errors.push(result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
			}
			const connectionResults = await Promise.allSettled([...connectionTasks]);
			for (const result of connectionResults) {
				if (result.status === "rejected")
					errors.push(result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
			}
			let displacedPath: string | undefined;
			if (server?.listening && ownedIdentity) {
				try {
					const current = await fs.lstat(options.socketPath).catch(() => undefined);
					if (current && (current.dev !== ownedIdentity.dev || current.ino !== ownedIdentity.ino)) {
						displacedPath = `${options.socketPath}.${process.pid}.closing`;
						await fs.rename(options.socketPath, displacedPath);
					}
				} catch (error) {
					errors.push(error instanceof Error ? error : new Error(String(error)));
				}
			}
			if (server?.listening) {
				try {
					await new Promise<void>((resolve, reject) =>
						server?.close(error => (error ? reject(error) : resolve())),
					);
				} catch (error) {
					errors.push(error instanceof Error ? error : new Error(String(error)));
				}
			}
			if (displacedPath) {
				try {
					await fs.rename(displacedPath, options.socketPath);
				} catch (error) {
					errors.push(error instanceof Error ? error : new Error(String(error)));
				}
			}
			try {
				await removeOwnedSocket();
			} catch (error) {
				errors.push(error instanceof Error ? error : new Error(String(error)));
			}
			process.removeListener("exit", cleanupOnExit);
			if (errors.length > 0) {
				const error = new AggregateError(errors, "socket_serve_close_failed");
				done.reject(error);
				throw error;
			}
			done.resolve();
		})();
		return await closing;
	};
	const handleConnection = async (socket: net.Socket, signal: AbortSignal): Promise<void> => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		try {
			const initialDownstreamBytes = await authenticatePreface(socket, options.token);
			if (closing) {
				socket.destroy();
				return;
			}
			const pair = await startRelayPair({
				...options,
				signal,
				downstream: socket,
				downstreamSink: socket,
				initialDownstreamBytes,
				onTransportError: error => sendTransportError(socket, error),
			});
			pairs.add(pair);
			try {
				await pair.done.catch(() => undefined);
			} finally {
				pairs.delete(pair);
				socket.end();
			}
		} catch {
			socket.destroy();
		}
	};
	server = net.createServer(socket => {
		if (closing) {
			socket.destroy();
			return;
		}
		const controller = new AbortController();
		dialControllers.add(controller);
		const task = handleConnection(socket, controller.signal).finally(() => {
			dialControllers.delete(controller);
			connectionTasks.delete(task);
		});
		connectionTasks.add(task);
		void task;
	});
	server.on("error", error => void close(error).catch(() => undefined));
	await new Promise<void>((resolve, reject) => {
		server?.once("error", reject);
		server?.listen(options.socketPath, () => resolve());
	});
	const bound = await fs.lstat(options.socketPath);
	if (!bound.isSocket()) {
		await close();
		throw socketFailure("socket_bind_failed");
	}
	ownedIdentity = { dev: bound.dev, ino: bound.ino };
	try {
		await fs.chmod(options.socketPath, 0o600);
	} catch (error) {
		await close();
		throw error;
	}
	return { close, done: done.promise };
}
