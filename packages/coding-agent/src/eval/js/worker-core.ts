import { isDesignedError } from "@gajae-code/utils/error-classification";
import { ToolAbortError, ToolError } from "../../tools/tool-errors";
import { QuickJsCellRuntime } from "./quickjs/runtime";
import { JsRuntime, type RuntimeHooks, type RuntimeOptions } from "./shared/runtime";
import type {
	JsEvalRuntimeKind,
	RunErrorPayload,
	SessionSnapshot,
	ToolReply,
	Transport,
	WorkerInbound,
} from "./worker-protocol";

interface PendingTool {
	resolve(value: unknown): void;
	reject(error: Error): void;
}

interface ActiveRun {
	runId: string;
	pendingTools: Map<string, PendingTool>;
}

/** One engine that executes eval cells for the worker (`eval.jsRuntime`). */
interface CellRuntime {
	readonly kind: JsEvalRuntimeKind;
	readonly alive: boolean;
	setCwd(cwd: string): void;
	runCell(code: string, filename: string, deadlineMs: number | undefined): Promise<void>;
	dispose(): void;
}

/** Bun backend: user code runs on the worker's own global with the full prelude. */
class BunCellRuntime implements CellRuntime {
	readonly kind = "bun";
	readonly alive = true;
	#runtime: JsRuntime;

	constructor(options: RuntimeOptions) {
		this.#runtime = new JsRuntime(options);
	}

	setCwd(cwd: string): void {
		this.#runtime.setCwd(cwd);
	}

	/** The deadline is enforced by the host, which terminates the worker. */
	async runCell(code: string, filename: string): Promise<void> {
		const value = await this.#runtime.run(code, filename);
		this.#runtime.displayValue(value);
	}

	dispose(): void {}
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
			isToolError: error instanceof ToolError,
			isDesigned: isDesignedError(error),
		};
	}
	return { message: String(error) };
}

function errorFromPayload(payload: RunErrorPayload): Error {
	const error = payload.isDesigned
		? payload.isAbort
			? new ToolAbortError(payload.message)
			: new ToolError(payload.message)
		: new Error(payload.message);
	if (payload.name) error.name = payload.name;
	if (payload.stack) error.stack = payload.stack;
	return error;
}

export class WorkerCore {
	#transport: Transport;
	#runtime: CellRuntime | null = null;
	#creating: Promise<CellRuntime> | null = null;
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
				this.#ensureRuntime(msg.snapshot).catch((error: unknown) => {
					// The first run retries creation and reports the failure to its caller.
					this.#transport.send({
						type: "log",
						level: "warn",
						msg: "JS eval runtime initialization failed",
						meta: {
							runtime: msg.snapshot.runtime,
							error: error instanceof Error ? error.message : String(error),
						},
					});
				});
				return;
			case "run":
				this.#enqueueRun(msg.runId, msg.code, msg.filename, msg.snapshot, msg.deadlineMs);
				return;
			case "tool-reply":
				this.#deliverToolReply(msg.id, msg.reply);
				return;
			case "close":
				this.#close();
				return;
		}
	}

	async #ensureRuntime(snapshot: SessionSnapshot): Promise<CellRuntime> {
		let runtime = this.#runtime;
		if (runtime && !runtime.alive) {
			this.#runtime = null;
			runtime = null;
		}
		if (!runtime) {
			const creating = this.#creating ?? this.#createRuntime(snapshot);
			this.#creating = creating;
			try {
				runtime = await creating;
			} finally {
				if (this.#creating === creating) this.#creating = null;
			}
			this.#runtime = runtime;
		}
		const requested = snapshot.runtime ?? "bun";
		if (runtime.kind !== requested) {
			throw new ToolError(`JS worker runs the ${runtime.kind} runtime, not ${requested}`);
		}
		runtime.setCwd(snapshot.cwd);
		return runtime;
	}

	async #createRuntime(snapshot: SessionSnapshot): Promise<CellRuntime> {
		const getHooks = (): RuntimeHooks | null => this.#hooksForCurrentRun();
		if (snapshot.runtime === "quickjs") return await QuickJsCellRuntime.create({ getHooks });
		return new BunCellRuntime({ initialCwd: snapshot.cwd, sessionId: snapshot.sessionId, getHooks });
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

	#enqueueRun(
		runId: string,
		code: string,
		filename: string,
		snapshot: SessionSnapshot,
		deadlineMs: number | undefined,
	): void {
		const previous = this.#queue;
		const next = (async () => {
			await previous.catch(() => undefined);
			await this.#runOne(runId, code, filename, snapshot, deadlineMs);
		})();
		this.#queue = next.catch(() => undefined);
	}

	async #runOne(
		runId: string,
		code: string,
		filename: string,
		snapshot: SessionSnapshot,
		deadlineMs: number | undefined,
	): Promise<void> {
		const active: ActiveRun = { runId, pendingTools: new Map() };
		try {
			const runtime = await this.#ensureRuntime(snapshot);
			this.#active = active;
			await runtime.runCell(code, filename, deadlineMs);
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
		const runtime = this.#runtime;
		this.#runtime = null;
		try {
			runtime?.dispose();
		} catch (error) {
			this.#transport.send({
				type: "log",
				level: "warn",
				msg: "JS eval runtime disposal failed",
				meta: { error: error instanceof Error ? error.message : String(error) },
			});
		}
		this.#transport.send({ type: "closed" });
		this.#unsubscribe();
		this.#transport.close();
	}
}
