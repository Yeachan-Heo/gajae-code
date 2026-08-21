/**
 * Per-session control endpoint — a Unix domain socket served by the RuntimeOwner so
 * stateless `gjc harness` CLI calls can route owner-routed primitives (submit, observe,
 * recover, retire) to the live owner. One JSON request line in, one JSON response line out.
 *
 * The owner is the only listener; clients connect per call. When no socket is reachable
 * the caller falls back to the no-owner behavior (read-only observe, owner-not-live submit).
 *
 * FIFO fallback (for platforms/paths where AF_UNIX is unavailable or path-length limited)
 * is a documented seam tracked as an ADR follow-up.
 */

import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { MAX_UNIX_SOCKET_PATH_BYTES } from "./storage";

export interface EndpointRequest {
	verb: string;
	input: Record<string, unknown>;
}

export type EndpointHandler = (req: EndpointRequest) => Promise<unknown>;

function frame(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

export class ControlServer {
	#server: net.Server | null = null;
	#sockets = new Set<net.Socket>();
	/** Serializes listen/close so lifecycle operations cannot unlink or replace each other's socket. */
	#lifecycle: Promise<void> = Promise.resolve();
	constructor(
		readonly socketPath: string,
		private readonly handler: EndpointHandler,
	) {}

	async listen(): Promise<void> {
		return this.#serialized(() => this.#listen());
	}

	/**
	 * Runs a lifecycle operation exclusively. Concurrent callers await the in-flight
	 * operation first, so a second listen can never unlink the bound socket of a live
	 * server and leave it orphaned, and close can never race a bind into a survivor.
	 */
	async #serialized(operation: () => Promise<void>): Promise<void> {
		const previous = this.#lifecycle;
		const gate = Promise.withResolvers<void>();
		this.#lifecycle = gate.promise;
		await previous;
		try {
			await operation();
		} finally {
			gate.resolve();
		}
	}

	async #listen(): Promise<void> {
		// A repeated listen awaits the live server instead of rebinding it.
		if (this.#server) return;
		await fs.mkdir(path.dirname(this.socketPath), { recursive: true });
		if (Buffer.byteLength(this.socketPath) > MAX_UNIX_SOCKET_PATH_BYTES) {
			throw new Error(`socket_path_too_long:${this.socketPath}`);
		}
		await fs.rm(this.socketPath, { force: true });
		const server = net.createServer(socket => this.#onConnection(socket));
		try {
			const bound = Promise.withResolvers<void>();
			const onError = (error: Error): void => bound.reject(error);
			server.once("error", onError);
			server.listen(this.socketPath, () => {
				server.removeListener("error", onError);
				this.#server = server;
				bound.resolve();
			});
			await bound.promise;
		} catch (error) {
			server.removeAllListeners("error");
			server.on("error", () => {});
			try {
				server.close();
			} catch {
				// The listener may never have reached the bound state.
			}
			await fs.rm(this.socketPath, { force: true });
			throw error;
		}
	}

	#onConnection(socket: net.Socket): void {
		this.#sockets.add(socket);
		socket.once("close", () => this.#sockets.delete(socket));
		// Bun 1.4 can report a peer reset through `close` without destroying an
		// accepted half-open socket unless an error listener is installed. The
		// endpoint owns each accepted socket, so force its lifecycle to finish.
		socket.on("error", () => {
			if (!socket.destroyed) socket.destroy();
		});
		socket.setEncoding("utf8");
		let buffer = "";
		let handled = false;
		socket.on("data", (chunk: string) => {
			if (handled) return;
			buffer += chunk;
			const idx = buffer.indexOf("\n");
			if (idx < 0) return;
			handled = true;
			const line = buffer.slice(0, idx).trim();
			void this.#dispatch(line)
				.then(response => {
					if (!socket.destroyed) socket.end(frame(response));
				})
				.catch((error: unknown) => {
					if (!socket.destroyed)
						socket.end(frame({ ok: false, error: error instanceof Error ? error.message : String(error) }));
				});
		});
	}

	async #dispatch(line: string): Promise<unknown> {
		const req = JSON.parse(line) as EndpointRequest;
		if (!req || typeof req.verb !== "string") throw new Error("bad_request");
		return this.handler({ verb: req.verb, input: req.input ?? {} });
	}

	async #close(): Promise<void> {
		const server = this.#server;
		this.#server = null;
		let closeError: unknown = null;
		if (server) {
			// Stop accepting first, then terminate every accepted socket. This makes
			// close independent of handler completion or a peer that never sends FIN.
			for (const socket of this.#sockets) socket.destroy();
			const closed = Promise.withResolvers<void>();
			try {
				server.close(error => (error ? closed.reject(error) : closed.resolve()));
			} catch (error) {
				closed.reject(error);
			}
			try {
				await closed.promise;
			} catch (error) {
				closeError = error;
			}
		}
		for (const socket of this.#sockets) socket.destroy();
		await fs.rm(this.socketPath, { force: true });
		if (closeError) throw closeError;
	}

	async close(): Promise<void> {
		return this.#serialized(() => this.#close());
	}
}

export class EndpointUnreachableError extends Error {
	constructor(
		readonly socketPath: string,
		readonly reason = "unreachable",
	) {
		super(`endpoint_${reason}:${socketPath}`);
		this.name = "EndpointUnreachableError";
	}
}

/** Call the owner's control endpoint. Rejects with {@link EndpointUnreachableError} when no owner listens or responds. */
export function callEndpoint(socketPath: string, req: EndpointRequest, timeoutMs = 5_000): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let socket: net.Socket;
		try {
			socket = net.connect(socketPath);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException | null)?.code;
			if (
				code === "ENOENT" ||
				code === "ECONNREFUSED" ||
				code === "ECONNRESET" ||
				code === "EPIPE" ||
				code === "ENAMETOOLONG" ||
				code === "EINVAL" ||
				code === "ENOTSOCK"
			) {
				reject(new EndpointUnreachableError(socketPath, code.toLowerCase()));
			} else {
				reject(error);
			}
			return;
		}
		let buffer = "";
		let settled = false;
		const done = (fn: () => void, graceful = false): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				if (graceful) socket.end();
				else socket.destroy();
			} catch {
				if (!socket.destroyed) socket.destroy();
			}
			fn();
		};
		const timer = setTimeout(
			() => done(() => reject(new EndpointUnreachableError(socketPath, "timeout"))),
			timeoutMs,
		);
		socket.setEncoding("utf8");
		socket.on("connect", () => {
			try {
				socket.write(frame(req));
			} catch (error) {
				done(() => reject(error));
			}
		});
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const idx = buffer.indexOf("\n");
			if (idx >= 0) {
				const line = buffer.slice(0, idx).trim();
				done(() => {
					try {
						resolve(JSON.parse(line));
					} catch {
						reject(new EndpointUnreachableError(socketPath, "bad_frame"));
					}
				}, true);
			}
		});
		socket.on("end", () => {
			if (!settled) done(() => reject(new EndpointUnreachableError(socketPath, "closed")));
		});
		socket.on("close", () => {
			if (!settled) done(() => reject(new EndpointUnreachableError(socketPath, "closed")));
		});
		socket.on("error", (error: NodeJS.ErrnoException) => {
			done(() => {
				if (
					error.code === "ENOENT" ||
					error.code === "ECONNREFUSED" ||
					error.code === "ECONNRESET" ||
					error.code === "EPIPE" ||
					error.code === "ENAMETOOLONG" ||
					error.code === "EINVAL" ||
					error.code === "ENOTSOCK"
				) {
					reject(new EndpointUnreachableError(socketPath, error.code.toLowerCase()));
				} else {
					reject(error);
				}
			});
		});
	});
}
