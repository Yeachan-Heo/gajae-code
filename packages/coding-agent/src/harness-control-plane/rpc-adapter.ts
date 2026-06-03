/**
 * gajae-code RPC adapter + single-flight acceptance.
 *
 * The gajae-code harness is driven via `gjc --mode rpc` (see docs/rpc.md). Acceptance
 * is a PROTOCOL FACT, not an echo: a prompt is `accepted` only when the RPC command is
 * acked AND the next `agent_start` event arrives after the pre-submit cursor within the
 * timeout, with an idle + empty-queue pre-state. Ack alone never means accepted.
 *
 * The acceptance logic ({@link singleFlightAccept}) is decoupled from the transport via
 * the {@link HarnessRpc} interface so it is unit-testable with a fake, while
 * {@link GajaeCodeRpc} provides the real `gjc --mode rpc` subprocess implementation
 * (exercised by the M10 e2e suite).
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface RpcStateSnapshot {
	isStreaming: boolean;
	steeringQueueDepth: number;
	followupQueueDepth: number;
}

/** Abstract handle to a live gajae-code RPC session. */
export interface HarnessRpc {
	getState(): Promise<RpcStateSnapshot>;
	/** Send a prompt; resolves with the RPC command id and whether it was acked. Does NOT await agent_start. */
	sendPrompt(prompt: string): Promise<{ commandId: string; ack: boolean }>;
	/** Monotonic count of events observed so far (the acceptance cursor). */
	eventCursor(): number;
	/** Resolve when an `agent_start` event arrives strictly after `afterCursor`, else null on timeout. */
	waitForAgentStart(afterCursor: number, timeoutMs: number): Promise<{ cursor: number } | null>;
	close(): Promise<void>;
}

export interface AcceptanceResult {
	accepted: boolean;
	reason: string;
	commandId: string | null;
	preSubmitCursor: number;
	agentStartCursor: number | null;
	preSubmitState: RpcStateSnapshot;
}

/**
 * Single-flight acceptance: idle + empty-queue pre-state, ack, then the NEXT
 * `agent_start` after the pre-submit cursor within `timeoutMs`.
 */
export async function singleFlightAccept(
	rpc: HarnessRpc,
	prompt: string,
	timeoutMs: number,
): Promise<AcceptanceResult> {
	const pre = await rpc.getState();
	const preSubmitCursor = rpc.eventCursor();
	if (pre.isStreaming || pre.steeringQueueDepth > 0 || pre.followupQueueDepth > 0) {
		return {
			accepted: false,
			reason: "pre-state-not-idle",
			commandId: null,
			preSubmitCursor,
			agentStartCursor: null,
			preSubmitState: pre,
		};
	}
	const { commandId, ack } = await rpc.sendPrompt(prompt);
	if (!ack) {
		return {
			accepted: false,
			reason: "no-ack",
			commandId,
			preSubmitCursor,
			agentStartCursor: null,
			preSubmitState: pre,
		};
	}
	const started = await rpc.waitForAgentStart(preSubmitCursor, timeoutMs);
	if (!started) {
		return {
			accepted: false,
			reason: "no-agent-start-within-timeout",
			commandId,
			preSubmitCursor,
			agentStartCursor: null,
			preSubmitState: pre,
		};
	}
	return {
		accepted: true,
		reason: "protocol-ack-single-flight",
		commandId,
		preSubmitCursor,
		agentStartCursor: started.cursor,
		preSubmitState: pre,
	};
}

interface PendingResponse {
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
}

/**
 * Real adapter: spawns `gjc --mode rpc --session-dir <dir>` and speaks the JSONL
 * protocol from docs/rpc.md. Verified end-to-end in the M10 suite.
 */
export class GajaeCodeRpc implements HarnessRpc {
	#proc: ChildProcessWithoutNullStreams;
	#buffer = "";
	#cursor = 0;
	#pending = new Map<string, PendingResponse>();
	#agentStartCursors: number[] = [];
	#waiters: {
		afterCursor: number;
		resolve: (v: { cursor: number } | null) => void;
		timer: ReturnType<typeof setTimeout>;
	}[] = [];

	constructor(opts: { sessionDir: string; command?: string[]; cwd?: string; env?: NodeJS.ProcessEnv }) {
		const base = opts.command ?? ["gjc", "--mode", "rpc"];
		const args = [...base.slice(1), "--session-dir", opts.sessionDir];
		this.#proc = spawn(base[0], args, {
			cwd: opts.cwd,
			env: opts.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
		}) as ChildProcessWithoutNullStreams;
		this.#proc.stdout.setEncoding("utf8");
		this.#proc.stdout.on("data", chunk => this.#onData(chunk as string));
	}

	#onData(chunk: string): void {
		this.#buffer += chunk;
		let idx = this.#buffer.indexOf("\n");
		while (idx >= 0) {
			const line = this.#buffer.slice(0, idx).trim();
			this.#buffer = this.#buffer.slice(idx + 1);
			if (line) this.#onFrame(line);
			idx = this.#buffer.indexOf("\n");
		}
	}

	#onFrame(line: string): void {
		let frame: Record<string, unknown>;
		try {
			frame = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}
		const type = frame.type;
		if (type === "response") {
			const id = typeof frame.id === "string" ? frame.id : undefined;
			if (id && this.#pending.has(id)) {
				const pending = this.#pending.get(id);
				this.#pending.delete(id);
				pending?.resolve(frame);
			}
			return;
		}
		if (type === "ready") return;
		// Any other frame is a session/agent event: advance the cursor.
		this.#cursor += 1;
		if (type === "agent_start") {
			const cursor = this.#cursor;
			this.#agentStartCursors.push(cursor);
			this.#waiters = this.#waiters.filter(w => {
				if (cursor > w.afterCursor) {
					clearTimeout(w.timer);
					w.resolve({ cursor });
					return false;
				}
				return true;
			});
		}
	}

	#send(command: Record<string, unknown>): Promise<Record<string, unknown>> {
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#proc.stdin.write(`${JSON.stringify({ id, ...command })}\n`, err => {
				if (err) {
					this.#pending.delete(id);
					reject(err);
				}
			});
		});
	}

	async getState(): Promise<RpcStateSnapshot> {
		const res = await this.#send({ type: "get_state" });
		const data = (res.data ?? {}) as Record<string, unknown>;
		return {
			isStreaming: Boolean(data.isStreaming),
			steeringQueueDepth: typeof data.queuedMessageCount === "number" ? data.queuedMessageCount : 0,
			followupQueueDepth: 0,
		};
	}

	async sendPrompt(prompt: string): Promise<{ commandId: string; ack: boolean }> {
		const id = randomUUID();
		const ackPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#proc.stdin.write(`${JSON.stringify({ id, type: "prompt", message: prompt })}\n`, err => {
				if (err) {
					this.#pending.delete(id);
					reject(err);
				}
			});
		});
		const res = await ackPromise;
		return { commandId: id, ack: res.success === true };
	}

	eventCursor(): number {
		return this.#cursor;
	}

	waitForAgentStart(afterCursor: number, timeoutMs: number): Promise<{ cursor: number } | null> {
		const existing = this.#agentStartCursors.find(c => c > afterCursor);
		if (existing !== undefined) return Promise.resolve({ cursor: existing });
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				this.#waiters = this.#waiters.filter(w => w.timer !== timer);
				resolve(null);
			}, timeoutMs);
			this.#waiters.push({ afterCursor, resolve, timer });
		});
	}

	async close(): Promise<void> {
		try {
			this.#proc.stdin.end();
		} catch {
			// ignore
		}
		this.#proc.kill();
	}
}
