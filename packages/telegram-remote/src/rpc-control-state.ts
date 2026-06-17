import type { RpcBackendPort, RpcBackendState, RpcControlState } from "./types";

export type RpcControlSignal =
	| { kind: "state_changed"; state: RpcControlState }
	| {
			kind: "reconnect_required";
			reason: "command_failed" | "timeout" | "transport_error" | "controller_stolen";
			queuedInputs: number;
	  };

export type RpcReconnectReason = Extract<RpcControlSignal, { kind: "reconnect_required" }>["reason"];
export interface RpcControlClock {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface RpcControlOptions {
	backend: RpcBackendPort;
	commandTimeoutMs?: number;
	clock?: RpcControlClock;
	onSignal?: (signal: RpcControlSignal) => void;
}

type QueuedOperation = { kind: "text"; text: string } | { kind: "abort" } | { kind: "abort_and_prompt"; text: string };

type LifecycleEvent = { type: string; [key: string]: unknown };

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

const realClock: RpcControlClock = {
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function hasActiveTurn(session: unknown): boolean {
	if (typeof session !== "object" || session === null) return false;
	const record = session as Record<string, unknown>;
	if (record.isRunning === true || record.running === true || record.active === true) return true;
	if (record.status === "running" || record.status === "active" || record.status === "working") return true;
	if (record.turnActivity === "active" || record.activeTurn === "active") return true;
	return typeof record.currentTurnId === "string" || typeof record.turnId === "string";
}

function turnIdentity(session: unknown): string | null {
	if (typeof session !== "object" || session === null) return null;
	const record = session as Record<string, unknown>;
	const value = record.currentTurnId ?? record.turnId ?? record.activeTurnId;
	return typeof value === "string" && value.length > 0 ? value : null;
}

function isNewTurnEvent(event: LifecycleEvent): boolean {
	return event.type === "turn_start" || event.type === "agent_start";
}

function isIdleEvent(event: LifecycleEvent): boolean {
	return (
		event.type === "turn_end" ||
		event.type === "agent_end" ||
		event.type === "turn_cancelled" ||
		event.type === "agent_cancelled"
	);
}

function isWaitingForUiEvent(event: LifecycleEvent): boolean {
	return event.type === "extension_ui_request" || event.type === "workflow_gate";
}

export class RpcControlStateMachine {
	readonly #backend: RpcBackendPort;
	readonly #clock: RpcControlClock;
	readonly #commandTimeoutMs: number;
	readonly #onSignal?: (signal: RpcControlSignal) => void;
	#state: RpcControlState = "detached";
	#queue: QueuedOperation[] = [];
	#processing = false;
	#pendingAbort = false;
	#pendingAbortAndPrompt = false;
	#pendingAbortAndPromptTurnId: string | null = null;

	constructor(options: RpcControlOptions) {
		this.#backend = options.backend;
		this.#clock = options.clock ?? realClock;
		this.#commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
		this.#onSignal = options.onSignal;
	}

	get state(): RpcControlState {
		return this.#state;
	}

	get queuedCount(): number {
		return this.#queue.length + (this.#processing ? 1 : 0);
	}

	get hasPendingWork(): boolean {
		return this.#queue.length > 0 || this.#processing || this.#pendingAbort || this.#pendingAbortAndPrompt;
	}

	setState(state: RpcControlState): void {
		this.#setState(state);
	}

	async attach(): Promise<void> {
		this.#setState("connecting");
		await this.#backend.connect();
		const backendState = await this.#backend.getState().catch(() => null);
		this.#setState(backendState && hasActiveTurn(backendState.session) ? "attached_turn_active" : "attached_idle");
	}

	async detach(): Promise<void> {
		await this.#backend.close();
		this.#queue = [];
		this.#processing = false;
		this.#pendingAbort = false;
		this.#pendingAbortAndPrompt = false;
		this.#setState("detached");
	}

	submitText(text: string): Promise<void> {
		this.#enqueue({ kind: "text", text });
		return Promise.resolve();
	}

	abort(): Promise<void> {
		this.#enqueue({ kind: "abort" });
		return Promise.resolve();
	}

	abortAndPrompt(text: string): Promise<void> {
		this.#enqueue({ kind: "abort_and_prompt", text });
		return Promise.resolve();
	}

	handleEvent(event: LifecycleEvent): void {
		if (isWaitingForUiEvent(event)) this.#setState("waiting_for_ui");
		if (isNewTurnEvent(event)) {
			const turnId =
				typeof event.turnId === "string" ? event.turnId : typeof event.turn_id === "string" ? event.turn_id : null;
			if (this.#pendingAbortAndPrompt) {
				if (!this.#pendingAbortAndPromptTurnId || !turnId || turnId !== this.#pendingAbortAndPromptTurnId) {
					this.#pendingAbortAndPrompt = false;
					this.#pendingAbortAndPromptTurnId = null;
				}
			}
			this.#pendingAbort = false;
			this.#setState("attached_turn_active");
			this.#drain();
			return;
		}
		if (isIdleEvent(event)) {
			this.#pendingAbort = false;
			if (!this.#pendingAbortAndPrompt) this.#setState("attached_idle");
			this.#drain();
		}
	}

	async refreshFromBackend(): Promise<RpcBackendState> {
		const state = await this.#backend.getState();
		const active = hasActiveTurn(state.session);
		const turnId = turnIdentity(state.session);
		if (this.#pendingAbortAndPrompt && active && turnId !== this.#pendingAbortAndPromptTurnId) {
			this.#pendingAbortAndPrompt = false;
			this.#pendingAbortAndPromptTurnId = null;
		}
		if (this.#pendingAbort && !active) this.#pendingAbort = false;
		if (!this.#pendingAbortAndPrompt) this.#setState(active ? "attached_turn_active" : "attached_idle");
		this.#drain();
		return state;
	}

	controllerStolen(): void {
		this.#transitionToReconnect("controller_stolen");
	}

	transportError(): void {
		this.#transitionToReconnect("transport_error");
	}

	#enqueue(operation: QueuedOperation): void {
		this.#queue.push(operation);
		this.#drain();
	}

	#drain(): void {
		if (
			this.#processing ||
			this.#pendingAbort ||
			this.#pendingAbortAndPrompt ||
			this.#state === "reconnecting" ||
			this.#state === "detached"
		)
			return;
		const operation = this.#queue.shift();
		if (!operation) return;
		this.#processing = true;
		void this.#runOperation(operation).finally(() => {
			this.#processing = false;
			this.#drain();
		});
	}

	async #runOperation(operation: QueuedOperation): Promise<void> {
		try {
			switch (operation.kind) {
				case "text":
					if (this.#state === "attached_turn_active" || this.#state === "waiting_for_ui")
						await this.#withTimeout(() => this.#backend.steer(operation.text));
					else await this.#withTimeout(() => this.#backend.prompt(operation.text));
					break;
				case "abort":
					this.#pendingAbort = true;
					await this.#withTimeout(() => this.#backend.abort());
					await this.#confirmAbort();
					break;
				case "abort_and_prompt":
					this.#pendingAbortAndPrompt = true;
					this.#pendingAbortAndPromptTurnId = turnIdentity(
						(await this.#backend.getState().catch(() => null))?.session,
					);
					this.#setState("control_pending_abort_and_prompt");
					await this.#withTimeout(() => this.#backend.abortAndPrompt(operation.text));
					break;
			}
		} catch (error) {
			this.#queue.unshift(operation);
			this.#clearPendingFor(operation);
			this.#transitionToReconnect(
				error instanceof Error && error.message === "rpc_control_timeout" ? "timeout" : "command_failed",
			);
		}
	}

	async #confirmAbort(): Promise<void> {
		const state = await this.#withTimeout(() => this.#backend.getState());
		if (hasActiveTurn(state.session)) return;
		this.#pendingAbort = false;
		this.#setState("attached_idle");
	}

	#clearPendingFor(operation: QueuedOperation): void {
		if (operation.kind === "abort") this.#pendingAbort = false;
		if (operation.kind === "abort_and_prompt") {
			this.#pendingAbortAndPrompt = false;
			this.#pendingAbortAndPromptTurnId = null;
		}
	}

	#withTimeout<T>(work: () => Promise<T>): Promise<T> {
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		let settled = false;
		const timer = this.#clock.setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error("rpc_control_timeout"));
		}, this.#commandTimeoutMs);
		work().then(
			value => {
				if (settled) return;
				settled = true;
				this.#clock.clearTimeout(timer);
				resolve(value);
			},
			error => {
				if (settled) return;
				settled = true;
				this.#clock.clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
		return promise;
	}

	#transitionToReconnect(reason: RpcReconnectReason): void {
		this.#setState("reconnecting");
		this.#onSignal?.({ kind: "reconnect_required", reason, queuedInputs: this.#queue.length });
	}

	#setState(state: RpcControlState): void {
		if (this.#state === state) return;
		this.#state = state;
		this.#onSignal?.({ kind: "state_changed", state });
	}
}
