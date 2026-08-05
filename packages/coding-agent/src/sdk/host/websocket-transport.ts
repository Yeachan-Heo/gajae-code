import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionSdkTransport } from "./session-runtime";
import type { SdkFrame } from "./types";

type SocketData = { connectionId: string };
type Socket = { readonly data: SocketData; send(message: string): void; close(): void; terminate?(): void };

export interface SdkWebSocketTransportDependencies {
	readonly filesystem?: Pick<typeof fs, "mkdir" | "writeFile" | "chmod" | "rm">;
	readonly serve?: typeof Bun.serve;
}
type SdkServer = ReturnType<typeof Bun.serve<SocketData>>;

export type SdkTransportLifecycleErrorCode =
	| "endpoint_write_failed"
	| "endpoint_chmod_failed"
	| "endpoint_remove_failed"
	| "server_stop_failed";

/** Typed transport lifecycle failure; callers can distinguish endpoint cleanup from protocol errors. */
export class SdkTransportLifecycleError extends Error {
	readonly code: SdkTransportLifecycleErrorCode;

	constructor(code: SdkTransportLifecycleErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "SdkTransportLifecycleError";
		this.code = code;
	}
}

function asLifecycleError(code: SdkTransportLifecycleErrorCode, message: string, error: unknown): SdkTransportLifecycleError {
	if (error instanceof SdkTransportLifecycleError) return error;
	return new SdkTransportLifecycleError(code, message, error);
}

function combineLifecycleErrors(errors: unknown[], message: string): unknown {
	if (errors.length === 0) return undefined;
	if (errors.length === 1) return errors[0];
	const aggregate = new AggregateError(errors, message) as AggregateError & { code?: SdkTransportLifecycleErrorCode };
	const typed = errors.find(
		(error): error is SdkTransportLifecycleError => error instanceof SdkTransportLifecycleError,
	);
	if (typed) aggregate.code = typed.code;
	return aggregate;
}

/**
 * Small loopback WebSocket transport used by SDK hosting. NotificationServer
 * remains an optional notification adapter; this transport keeps SDK hosting
 * available without loading that adapter or its native dependency.
 */
export async function createSdkWebSocketTransport(
	input: { sessionId: string; stateRoot: string; token: string } & SdkWebSocketTransportDependencies,
): Promise<SessionSdkTransport> {
	const filesystem = input.filesystem ?? fs;
	const serve = input.serve ?? Bun.serve;
	let frameHandler: ((connectionId: string, frame: SdkFrame) => void) | undefined;
	let malformedHandler: ((connectionId: string, message: string) => void) | undefined;
	let connectionCloseHandler: ((connectionId: string) => void) | undefined;
	let capabilitiesHandler: ((connectionId: string, capabilities: readonly string[]) => void) | undefined;
	let server: SdkServer | undefined;
	const sockets = new Map<string, Socket>();
	const endpointFile = path.join(input.stateRoot, "sdk", `${input.sessionId}.json`);
	let started = false;
	let startPromise: Promise<{ url: string }> | undefined;
	let stopPromise: Promise<void> | undefined;

	const stopServer = async (current: SdkServer): Promise<void> => {
		try {
			const stopResult = current.stop(true);
			await Promise.race([stopResult, new Promise<void>(resolve => setTimeout(resolve, 250))]);
		} catch (error) {
			throw asLifecycleError("server_stop_failed", "SDK WebSocket server shutdown failed.", error);
		}
	};

	const closeServer = async (current: SdkServer | undefined = server): Promise<void> => {
		// Detach the server before invoking stop so a reentrant cleanup cannot stop it twice.
		if (current === server) server = undefined;
		started = false;
		for (const socket of sockets.values()) {
			try {
				socket.terminate?.();
				if (!socket.terminate) socket.close();
			} catch {
				// A socket may already have closed while the server is stopping.
			}
		}
		sockets.clear();
		if (current) await stopServer(current);
	};

	const removeEndpoint = async (): Promise<void> => {
		try {
			await filesystem.rm(endpointFile, { force: true });
		} catch (error) {
			throw asLifecycleError("endpoint_remove_failed", "SDK endpoint file removal failed.", error);
		}
	};

	const endpointUrl = (current: SdkServer): string => {
		const url = new URL(current.url);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		return url.toString();
	};

	const transport: SessionSdkTransport = {
		sessionId: input.sessionId,
		stateRoot: input.stateRoot,
		token: input.token,
		onFrame(handler) {
			frameHandler = handler;
			return () => {
				if (frameHandler === handler) frameHandler = undefined;
			};
		},
		onMalformedFrame(handler) {
			malformedHandler = handler;
			return () => {
				if (malformedHandler === handler) malformedHandler = undefined;
			};
		},
		sendFrame(connectionId, frame) {
			const socket = sockets.get(connectionId);
			if (!socket) throw new Error("SDK connection is no longer available.");
			socket.send(JSON.stringify(frame));
		},
		start: async () => {
			if (stopPromise) await stopPromise;
			if (startPromise) return await startPromise;
			if (started && server) return { url: endpointUrl(server) };
			if (stopPromise) await stopPromise;
			if (startPromise) return await startPromise;
			if (started && server) return { url: endpointUrl(server) };

			const pending = (async (): Promise<{ url: string }> => {
				let localServer: SdkServer | undefined;
				const failures: unknown[] = [];
				try {
					await filesystem.mkdir(path.dirname(endpointFile), { recursive: true, mode: 0o700 });
					localServer = serve<SocketData>({
						hostname: "127.0.0.1",
						port: 0,
						fetch(request, instance) {
							const url = new URL(request.url);
							if (url.searchParams.get("token") !== input.token)
								return new Response("Unauthorized", { status: 401 });
							const connectionId = randomUUID();
							if (instance.upgrade(request, { data: { connectionId } })) return undefined;
							return new Response("WebSocket upgrade required", { status: 426 });
						},
						websocket: {
							open(socket) {
								sockets.set(socket.data.connectionId, socket);
								socket.send(JSON.stringify({ type: "hello", connectionId: socket.data.connectionId }));
							},
							message(socket, message) {
								const raw = String(message);
								try {
									const frame = JSON.parse(raw) as SdkFrame;
									if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
										malformedHandler?.(socket.data.connectionId, "SDK frame must be a JSON object.");
										return;
									}
									if (typeof frame.type !== "string" || frame.type.length === 0) {
										malformedHandler?.(socket.data.connectionId, "SDK frame type must be a non-empty string.");
										return;
									}
									if (frame.type === "event_replay" && Array.isArray(frame.capabilities)) {
										capabilitiesHandler?.(
											socket.data.connectionId,
											frame.capabilities.filter((value): value is string => typeof value === "string"),
										);
									}
									frameHandler?.(socket.data.connectionId, frame);
								} catch {
									malformedHandler?.(socket.data.connectionId, "SDK frame is not valid JSON.");
								}
							},
							close(socket) {
								const { connectionId } = socket.data;
								sockets.delete(connectionId);
								connectionCloseHandler?.(connectionId);
							},
						},
					});
					server = localServer;
					const url = endpointUrl(localServer);
					try {
						await filesystem.writeFile(
							endpointFile,
							JSON.stringify({ version: 1, url, token: input.token, pid: process.pid }),
							"utf8",
						);
					} catch (error) {
						throw asLifecycleError("endpoint_write_failed", "SDK endpoint file publication failed.", error);
					}
					try {
						await filesystem.chmod(endpointFile, 0o600);
					} catch (error) {
						throw asLifecycleError("endpoint_chmod_failed", "SDK endpoint file permission update failed.", error);
					}
					started = true;
					return { url };
				} catch (error) {
					failures.push(error);
					// Compensating cleanup is unconditional: even mkdir/write failures must
					// remove a stale endpoint and any server created before chmod failed.
					try {
						await closeServer(localServer);
					} catch (cleanupError) {
						failures.push(cleanupError);
					}
					try {
						await removeEndpoint();
					} catch (cleanupError) {
						failures.push(cleanupError);
					}
					started = false;
					server = undefined;
					const combined = combineLifecycleErrors(failures, "SDK transport startup failed and cleanup was incomplete.");
					if (combined !== undefined) throw combined;
					throw error;
				}
			})();
			startPromise = pending;
			try {
				return await pending;
			} finally {
				if (startPromise === pending) startPromise = undefined;
			}
		},
		stop: async () => {
			if (stopPromise) return await stopPromise;
			const pending = (async (): Promise<void> => {
				// If startup is in flight, join it before closing the resulting server.
				if (startPromise) await startPromise.catch(() => undefined);
				const failures: unknown[] = [];
				try {
					await closeServer();
				} catch (error) {
					failures.push(error);
				}
				try {
					await removeEndpoint();
				} catch (error) {
					failures.push(error);
				}
				const combined = combineLifecycleErrors(failures, "SDK transport shutdown failed.");
				if (combined !== undefined) throw combined;
			})();
			stopPromise = pending;
			try {
				await pending;
			} finally {
				if (stopPromise === pending) stopPromise = undefined;
			}
		},
		broadcastFrame(frame) {
			const json = JSON.stringify(frame);
			for (const socket of sockets.values()) {
				try {
					socket.send(json);
				} catch {
					// Broadcasts are best effort; directed responses surface send failures.
				}
			}
		},
		onConnectionClose(handler) {
			connectionCloseHandler = handler;
			return () => {
				if (connectionCloseHandler === handler) connectionCloseHandler = undefined;
			};
		},
		onNegotiatedCapabilities(handler) {
			capabilitiesHandler = handler;
			return () => {
				if (capabilitiesHandler === handler) capabilitiesHandler = undefined;
			};
		},
	};

	return transport;
}
