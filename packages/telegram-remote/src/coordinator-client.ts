/**
 * MCP stdio client for the Coordinator MCP. Spawns `gjc mcp-serve coordinator`
 * and speaks newline-delimited JSON-RPC. This is the only place the gateway
 * touches the session backend, and it introduces no second control protocol —
 * it reuses the existing Coordinator MCP contract (docs/telegram-remote.md).
 */
import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type {
	CoordinationStatus,
	CoordinatorClient,
	CoordinatorRoutingEvent,
	RawRecord,
	ReportStatusResult,
	StartSessionResult,
	WatchEventsInput,
	WatchEventsResult,
} from "./types";

const COORDINATOR_MCP_PROTOCOL_VERSION = "2024-11-05";

/** Spawn configuration for the coordinator subprocess. */
export interface McpStdioOptions {
	command: string;
	args: string[];
	env: Record<string, string>;
	cwd?: string;
}

interface JsonRpcResponse {
	id?: number | string | null;
	result?: { content?: Array<{ type?: string; text?: string }> };
	error?: { code: number; message: string };
}

interface PendingRequest {
	resolve: (response: JsonRpcResponse) => void;
	reject: (error: Error) => void;
}

function asArray(value: unknown): RawRecord[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is RawRecord => typeof item === "object" && item !== null);
}

function asRecord(value: unknown): RawRecord | null {
	return typeof value === "object" && value !== null ? (value as RawRecord) : null;
}

function reasonOf(payload: RawRecord): string | undefined {
	return typeof payload.reason === "string" ? payload.reason : undefined;
}

function asPositiveFiniteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function parseRoutingEvent(value: unknown): CoordinatorRoutingEvent | null {
	const event = asRecord(value);
	if (!event) return null;
	const seq = asPositiveFiniteNumber(event.seq);
	const kind = typeof event.kind === "string" && event.kind.length > 0 ? event.kind : null;
	if (seq === null || kind === null) return null;
	const sessionId = typeof event.session_id === "string" && event.session_id.length > 0 ? event.session_id : null;
	return { seq, kind, sessionId };
}

export class McpStdioCoordinatorClient implements CoordinatorClient {
	private readonly options: McpStdioOptions;
	private child: ChildProcessByStdio<Writable, Readable, null> | null = null;
	private nextId = 1;
	private buffer = "";
	private readonly pending = new Map<number, PendingRequest>();
	private startPromise: Promise<void> | null = null;
	private closed = false;

	constructor(options: McpStdioOptions) {
		this.options = options;
	}

	async getCoordinationStatus(): Promise<CoordinationStatus> {
		try {
			const payload = await this.callTool("gjc_coordinator_read_coordination_status", {});
			if (payload.ok === false) {
				return { ok: false, reason: reasonOf(payload), sessions: [], sessionStates: [], turns: [] };
			}
			return {
				ok: true,
				sessions: asArray(payload.sessions),
				sessionStates: asArray(payload.session_states),
				turns: asArray(payload.turns),
			};
		} catch {
			return { ok: false, reason: "coordinator_unreachable", sessions: [], sessionStates: [], turns: [] };
		}
	}

	async startSession(input: { cwd: string; prompt?: string }): Promise<StartSessionResult> {
		try {
			const payload = await this.callTool("gjc_coordinator_start_session", {
				cwd: input.cwd,
				...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
				allow_mutation: true,
			});
			if (payload.ok === false) return { ok: false, reason: reasonOf(payload) };
			const session = asRecord(payload.session);
			const sessionId = session && typeof session.session_id === "string" ? session.session_id : undefined;
			return { ok: true, sessionId };
		} catch {
			return { ok: false, reason: "coordinator_unreachable" };
		}
	}

	async reportStatus(input: {
		sessionId: string;
		turnId?: string;
		status: "cancelled";
		summary?: string;
	}): Promise<ReportStatusResult> {
		try {
			const payload = await this.callTool("gjc_coordinator_report_status", {
				session_id: input.sessionId,
				...(input.turnId ? { turn_id: input.turnId } : {}),
				status: input.status,
				...(input.summary ? { summary: input.summary } : {}),
				allow_mutation: true,
			});
			if (payload.ok === false) return { ok: false, reason: reasonOf(payload) };
			return { ok: true };
		} catch {
			return { ok: false, reason: "coordinator_unreachable" };
		}
	}

	async watchEvents(input: WatchEventsInput): Promise<WatchEventsResult> {
		const timeoutMs = Math.min(input.timeoutMs ?? 25000, 30000);
		const limit = Math.min(input.limit ?? 100, 100);
		const args = {
			after_seq: input.afterSeq,
			...(input.sessionId !== undefined ? { session_id: input.sessionId } : {}),
			...(input.eventTypes !== undefined ? { event_types: input.eventTypes } : {}),
			timeout_ms: timeoutMs,
			limit,
		};
		try {
			const payload = await this.callTool("gjc_coordinator_watch_events", args);
			if (payload.ok === false) {
				return {
					ok: false,
					reason: "coordinator_unreachable",
					events: [],
					latestSeq: input.afterSeq,
					timedOut: false,
				};
			}
			const rawEvents = Array.isArray(payload.events) ? payload.events : [];
			const events = rawEvents.flatMap(event => {
				const parsed = parseRoutingEvent(event);
				return parsed ? [parsed] : [];
			});
			const latestSeq =
				typeof payload.latest_seq === "number" && Number.isFinite(payload.latest_seq)
					? payload.latest_seq
					: input.afterSeq;
			const timedOut = payload.timed_out === true;
			return { ok: true, events, latestSeq, timedOut };
		} catch {
			return {
				ok: false,
				reason: "coordinator_unreachable",
				events: [],
				latestSeq: input.afterSeq,
				timedOut: false,
			};
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		this.child?.kill();
		this.child = null;
		this.failAll(new Error("coordinator_closed"));
	}

	private ensureStarted(): Promise<void> {
		if (!this.startPromise) this.startPromise = this.start();
		return this.startPromise;
	}

	private async start(): Promise<void> {
		const child = spawn(this.options.command, this.options.args, {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "inherit"],
		});
		this.child = child;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.onData(chunk));
		child.on("exit", () => {
			this.closed = true;
			this.failAll(new Error("coordinator_process_exited"));
		});
		child.on("error", error => this.failAll(error instanceof Error ? error : new Error(String(error))));
		await this.request("initialize", {
			protocolVersion: COORDINATOR_MCP_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "gjc-telegram-remote", version: "0.0.1" },
		});
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let newline = this.buffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (line.length > 0) this.handleLine(line);
			newline = this.buffer.indexOf("\n");
		}
	}

	private handleLine(line: string): void {
		let response: JsonRpcResponse;
		try {
			response = JSON.parse(line) as JsonRpcResponse;
		} catch {
			return;
		}
		if (typeof response.id !== "number") return;
		const entry = this.pending.get(response.id);
		if (!entry) return;
		this.pending.delete(response.id);
		entry.resolve(response);
	}

	private failAll(error: Error): void {
		for (const entry of this.pending.values()) entry.reject(error);
		this.pending.clear();
	}

	private request(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
		const child = this.child;
		if (!child || this.closed) return Promise.reject(new Error("coordinator_unreachable"));
		const id = this.nextId++;
		const frame = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			child.stdin.write(frame, error => {
				if (error) {
					this.pending.delete(id);
					reject(error);
				}
			});
		});
	}

	private async callTool(name: string, args: Record<string, unknown>): Promise<RawRecord> {
		await this.ensureStarted();
		const response = await this.request("tools/call", { name, arguments: args });
		if (response.error) throw new Error(response.error.message);
		const text = response.result?.content?.[0]?.text;
		if (typeof text !== "string") throw new Error("coordinator_malformed_result");
		const payload = asRecord(JSON.parse(text));
		if (!payload) throw new Error("coordinator_malformed_result");
		return payload;
	}
}
