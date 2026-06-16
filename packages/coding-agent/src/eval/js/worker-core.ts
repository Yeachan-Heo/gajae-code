import { ToolError } from "../../tools/tool-errors";
import { JsRuntime, type RuntimeHooks } from "./shared/runtime";
import type { RunErrorPayload, SessionSnapshot, ToolReply, Transport, WorkerInbound } from "./worker-protocol";

interface PendingTool {
	resolve(value: unknown): void;
	reject(error: Error): void;
}

interface ActiveRun {
	runId: string;
	pendingTools: Map<string, PendingTool>;
}

function rejectPendingTools(active: ActiveRun, error: Error): void {
	for (const pending of active.pendingTools.values()) pending.reject(error);
	active.pendingTools.clear();
}

function errorPayload(error: unknown): RunErrorPayload {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			isAbort: error.name === "AbortError" || error.name === "ToolAbortError",
			isToolError: error.name === "ToolError" || error instanceof ToolError,
		};
	}
	return { message: String(error) };
}

function errorFromPayload(payload: RunErrorPayload): Error {
	const ctor = payload.isToolError ? ToolError : Error;
	const error = new ctor(payload.message);
	if (payload.name) error.name = payload.name;
	if (payload.stack) error.stack = payload.stack;
	return error;
}

export class WorkerCore {
	#transport: Transport;
	#runtime: JsRuntime | null = null;
	#queue: Promise<void> = Promise.resolve();
	#active: ActiveRun | null = null;
	#unsubscribe: () => void;

	constructor(transport: Transport) {
		this.#transport = transport;
		this.#unsubscribe = transport.onMessage(msg => this.#handle(msg));
		transport.send({ type: "ready" });
	}

	#handle(msg: WorkerInbound): void {
		switch (msg.type) {
			case "init":
				this.#ensureRuntime(msg.snapshot);
				return;
			case "run":
				this.#enqueueRun(msg.runId, msg.code, msg.filename, msg.snapshot);
				return;
			case "tool-reply":
				this.#deliverToolReply(msg.id, msg.reply);
				return;
			case "close":
				this.#close();
				return;
		}
	}

	#ensureRuntime(snapshot: SessionSnapshot): JsRuntime {
		if (this.#runtime) {
			this.#runtime.setCwd(snapshot.cwd);
			return this.#runtime;
		}
		this.#runtime = new JsRuntime({
			initialCwd: snapshot.cwd,
			sessionId: snapshot.sessionId,
			getHooks: () => this.#hooksForCurrentRun(),
		});
		return this.#runtime;
	}

	#hooksForCurrentRun(): RuntimeHooks | null {
		const active = this.#active;
		if (!active) return null;
		const runId = active.runId;
		return {
			onText: chunk => this.#transport.send({ type: "text", runId, chunk }),
			onDisplay: output => this.#transport.send({ type: "display", runId, output }),
			callTool: (name, args) => this.#callTool(active, name, args),
		};
	}

	#enqueueRun(runId: string, code: string, filename: string, snapshot: SessionSnapshot): void {
		const previous = this.#queue;
		const next = (async () => {
			await previous.catch(() => undefined);
			await this.#runOne(runId, code, filename, snapshot);
		})();
		this.#queue = next.catch(() => undefined);
	}

	async #runOne(runId: string, code: string, filename: string, snapshot: SessionSnapshot): Promise<void> {
		const runtime = this.#ensureRuntime(snapshot);
		runtime.setCwd(snapshot.cwd);
		const active: ActiveRun = { runId, pendingTools: new Map() };
		this.#active = active;
		try {
			const value = await runtime.run(code, filename);
			runtime.displayValue(value);
			this.#transport.send({ type: "result", runId, ok: true });
		} catch (error) {
			this.#transport.send({ type: "result", runId, ok: false, error: errorPayload(error) });
		} finally {
			rejectPendingTools(active, new ToolError("JS run ended"));
			if (this.#active === active) this.#active = null;
		}
	}

	async #callTool(active: ActiveRun, name: string, args: unknown): Promise<unknown> {
		const id = `tc-${active.runId}-${crypto.randomUUID()}`;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		active.pendingTools.set(id, { resolve, reject });
		this.#transport.send({ type: "tool-call", id, runId: active.runId, name, args });
		return await promise;
	}

	#deliverToolReply(id: string, reply: ToolReply): void {
		const active = this.#active;
		if (!active) return;
		const pending = active.pendingTools.get(id);
		if (!pending) return;
		active.pendingTools.delete(id);
		if (reply.ok) pending.resolve(reply.value);
		else pending.reject(errorFromPayload(reply.error));
	}

	#close(): void {
		const active = this.#active;
		if (active) {
			rejectPendingTools(active, new ToolError("JS worker closed"));
		}
		this.#active = null;
		this.#runtime = null;
		this.#transport.send({ type: "closed" });
		this.#unsubscribe();
		this.#transport.close();
	}
}
