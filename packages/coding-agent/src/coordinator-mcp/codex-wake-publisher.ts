import * as fs from "node:fs/promises";
import * as net from "node:net";
import type { CodexHandoffEndpoint, CodexHandoffRegistrationV1, CodexWakeEventV1 } from "./codex-handoff";

export interface CodexAppServerTransport {
	request(method: string, params: Record<string, unknown>): Promise<unknown>;
	close(): Promise<void>;
}

export type CodexTransportFactory = (
	endpoint: CodexHandoffEndpoint,
	token: string | null,
) => Promise<CodexAppServerTransport>;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function assertSafeCodexEndpoint(endpoint: unknown): CodexHandoffEndpoint {
	if (endpoint === null || typeof endpoint !== "object") throw new Error("invalid_codex_endpoint");
	const value = endpoint as Record<string, unknown>;
	if (value.kind === "unix") {
		if (
			typeof value.path !== "string" ||
			value.path.length === 0 ||
			value.path.length > 1024 ||
			!value.path.startsWith("/")
		)
			throw new Error("invalid_codex_endpoint");
		return { kind: "unix", path: value.path };
	}
	if (value.kind === "tcp") {
		if (typeof value.host !== "string" || typeof value.port !== "number") throw new Error("invalid_codex_endpoint");
		if (!LOOPBACK_HOSTS.has(value.host.toLowerCase())) throw new Error("codex_endpoint_not_loopback");
		if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535)
			throw new Error("invalid_codex_endpoint");
		return { kind: "tcp", host: value.host, port: value.port };
	}
	throw new Error("invalid_codex_endpoint");
}

export async function readCodexTokenFile(tokenFile: string | null): Promise<string | null> {
	if (tokenFile === null) return null;
	try {
		return (await fs.readFile(tokenFile, "utf8")).trim();
	} catch {
		throw new Error("codex_token_file_unreadable");
	}
}

function boundSummary(value: string): string {
	const normalized = value
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

export function buildCodexWakePrompt(event: CodexWakeEventV1): string {
	const identifiers = [
		`event_kind: ${event.event_kind}`,
		`work_unit: ${event.work_unit}`,
		`wake_key: ${event.key}`,
		...(event.turn_id === null ? [] : [`turn_id: ${event.turn_id}`]),
		...(event.question_id === null ? [] : [`question_id: ${event.question_id}`]),
		`summary: ${boundSummary(event.summary)}`,
	];
	return `${identifiers.join("\n")}\nResume the delegate flow by reading coordinator state.`;
}

function idleStatus(value: unknown): boolean {
	return value !== null && typeof value === "object" && (value as Record<string, unknown>).status === "idle";
}

export async function publishCodexWake(input: {
	handoff: CodexHandoffRegistrationV1;
	event: CodexWakeEventV1;
	transportFactory: CodexTransportFactory;
}): Promise<{ published: boolean; reason: string | null }> {
	const endpoint = assertSafeCodexEndpoint(input.handoff.endpoint);
	const token = await readCodexTokenFile(input.handoff.token_file);
	const transport = await input.transportFactory(endpoint, token);
	try {
		await transport.request("thread/resume", { threadId: input.handoff.thread_id });
		const status = await transport.request("thread/status", { threadId: input.handoff.thread_id });
		if (!idleStatus(status)) return { published: false, reason: "thread_active_pending" };
		await transport.request("turn/start", {
			threadId: input.handoff.thread_id,
			clientUserMessageId: input.event.client_user_message_id,
			prompt: buildCodexWakePrompt(input.event),
		});
		return { published: true, reason: null };
	} finally {
		await transport.close();
	}
}

interface JsonRpcResponse {
	id?: number;
	result?: unknown;
	error?: unknown;
}

export function createDefaultCodexTransportFactory(): CodexTransportFactory {
	return async (endpoint, token) => {
		const safeEndpoint = assertSafeCodexEndpoint(endpoint);
		const connected = Promise.withResolvers<void>();
		const socket =
			safeEndpoint.kind === "unix"
				? net.createConnection(safeEndpoint.path)
				: net.createConnection({ host: safeEndpoint.host, port: safeEndpoint.port });
		let connectError: Error | null = null;
		socket.once("connect", () => connected.resolve());
		socket.once("error", error => {
			connectError = error;
			connected.reject(error);
		});
		try {
			await connected.promise;
		} catch {
			throw new Error("codex_app_server_unavailable");
		}
		if (connectError !== null) throw new Error("codex_app_server_unavailable");
		let nextId = 1;
		let buffer = "";
		let pending: {
			id: number;
			resolve: (value: unknown) => void;
			reject: (reason?: unknown) => void;
			timeout: Timer;
		} | null = null;
		socket.on("data", chunk => {
			buffer += chunk.toString();
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				let response: JsonRpcResponse;
				try {
					response = JSON.parse(line) as JsonRpcResponse;
				} catch {
					continue;
				}
				if (pending === null || response.id !== pending.id) continue;
				const current = pending;
				pending = null;
				clearTimeout(current.timeout);
				if (response.error !== undefined) current.reject(new Error("codex_app_server_request_failed"));
				else current.resolve(response.result);
			}
		});
		socket.on("error", () => {
			if (pending === null) return;
			const current = pending;
			pending = null;
			clearTimeout(current.timeout);
			current.reject(new Error("codex_app_server_unavailable"));
		});
		return {
			request: async (method, params) => {
				if (pending !== null) throw new Error("codex_app_server_request_in_flight");
				const id = nextId++;
				const response = Promise.withResolvers<unknown>();
				const timeout = setTimeout(() => {
					if (pending?.id !== id) return;
					pending = null;
					response.reject(new Error("codex_app_server_timeout"));
				}, 10_000);
				pending = { id, ...response, timeout };
				const requestParams = token === null ? params : { ...params, token };
				socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: requestParams })}\n`);
				return response.promise;
			},
			close: async () => {
				if (pending !== null) {
					clearTimeout(pending.timeout);
					pending.reject(new Error("codex_app_server_closed"));
					pending = null;
				}
				if (socket.destroyed) return;
				const closed = Promise.withResolvers<void>();
				socket.once("close", () => closed.resolve());
				socket.destroy();
				await closed.promise;
			},
		};
	};
}
