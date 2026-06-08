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
	constructor(
		readonly socketPath: string,
		private readonly handler: EndpointHandler,
	) {}

	async listen(): Promise<void> {
		await fs.mkdir(path.dirname(this.socketPath), { recursive: true });
		if (Buffer.byteLength(this.socketPath) > MAX_UNIX_SOCKET_PATH_BYTES) {
			throw new Error(`socket_path_too_long:${this.socketPath}`);
		}
		await fs.rm(this.socketPath, { force: true });
		await new Promise<void>((resolve, reject) => {
			const server = net.createServer(socket => this.#onConnection(socket));
			server.once("error", reject);
			server.listen(this.socketPath, () => {
				server.removeListener("error", reject);
				this.#server = server;
				resolve();
			});
		});
	}

	#onConnection(socket: net.Socket): void {
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
					socket.end(frame(response));
				})
				.catch((error: unknown) => {
					socket.end(frame({ ok: false, error: error instanceof Error ? error.message : String(error) }));
				});
		});
	}

	async #dispatch(line: string): Promise<unknown> {
		const req = JSON.parse(line) as EndpointRequest;
		if (!req || typeof req.verb !== "string") throw new Error("bad_request");
		return this.handler({ verb: req.verb, input: req.input ?? {} });
	}

	async close(): Promise<void> {
		const server = this.#server;
		this.#server = null;
		if (server) {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
		await fs.rm(this.socketPath, { force: true });
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
		const socket = net.connect(socketPath);
		let buffer = "";
		let settled = false;
		const done = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			fn();
		};
		const timer = setTimeout(
			() => done(() => reject(new EndpointUnreachableError(socketPath, "timeout"))),
			timeoutMs,
		);
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(frame(req)));
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
				});
			}
		});
		socket.on("error", (error: NodeJS.ErrnoException) => {
			done(() => {
				if (
					error.code === "ENOENT" ||
					error.code === "ECONNREFUSED" ||
					error.code === "ECONNRESET" ||
					error.code === "EPIPE"
				) {
					reject(new EndpointUnreachableError(socketPath, error.code.toLowerCase()));
				} else {
					reject(error);
				}
			});
		});
	});
}
