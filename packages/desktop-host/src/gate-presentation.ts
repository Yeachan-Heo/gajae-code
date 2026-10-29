import * as crypto from "node:crypto";
import type { CreateAgentSessionResult } from "@gajae-code/coding-agent/sdk";
import {
	canonicalJson,
	schemaHash,
	type WorkflowGate,
	type WorkflowGateEmitter,
	type WorkflowGateTerminalController,
	type WorkflowGateTerminalProof,
} from "@gajae-code/coding-agent/sdk/workflow-gates";
import { DesktopActivityError, type DesktopActivityController } from "./activity-controls";
import type { DesktopActivityGate, DesktopActivityGateAnswer, DesktopActivityGateAnswerResult, DesktopActivityRef } from "./activity-protocol";
import type { DesktopGatePresentation, DesktopGatePresentationErrorCode, DesktopGatePresentationEvent } from "./gate-presentation-protocol";

export const DESKTOP_GATE_PRESENTATION_LIMITS = {
	presentations: 128,
	retirementTimeoutMs: 15_000,
	maxRetirementTimeoutMs: 60_000,
} as const;

const REASONS: Record<DesktopGatePresentationErrorCode, string> = {
	unavailable: "This session has no authoritative desktop gate presentation capability.",
	registration_failed: "A desktop gate terminal controller could not be registered; existing ownership was not replaced.",
	revoked: "This gate presenter binding has been permanently revoked.",
	invalid_presentation: "Unknown gate presentation in this binding.",
	not_presented: "The owning UI has not committed this exact gate presentation.",
	invalid_retirement: "No matching pending retirement exists for this presentation and nonce.",
	stale_presentation: "The gate or its complete presentation has changed; reopen it.",
	capacity: "The presentation evidence ledger is full; no further surfaces can be issued in this binding.",
	busy: "This gate presentation is being answered or retired.",
	callback_failed: "Gate presentation delivery failed; no retirement was proven.",
	retirement_timeout: "The owning UI did not prove removal of the exact gate presentation before the deadline.",
};

export class DesktopGatePresentationError extends Error {
	constructor(readonly code: DesktopGatePresentationErrorCode) {
		super(REASONS[code]);
		this.name = "DesktopGatePresentationError";
	}
}

export interface DesktopGatePresenterOptions {
	session: CreateAgentSessionResult["session"];
	activity: DesktopActivityController;
	/** Host-owned identities; neither may come from renderer request parameters. */
	connectionGeneration: string;
	catalogSessionId: string;
	/** Host binding liveness, NOT sidebar selection. Revoke on any binding replacement, including ABA. */
	isCurrent: (connectionGeneration: string, catalogSessionId: string) => boolean;
	/** Deliver to the sole guarded main-window owner. Throw on failed delivery. */
	emit: (event: DesktopGatePresentationEvent) => void;
	/** A deadline only rejects. It never supplies terminalization evidence. */
	retirementTimeoutMs?: number;
}

interface Retirement {
	nonce: string;
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: Error) => void;
	timer: Timer | undefined;
	deadline: number;
}

interface PresentationRecord {
	readonly id: string;
	readonly gateId: string;
	readonly fingerprint: string;
	readonly ref: DesktopActivityRef;
	readonly presentation: DesktopGatePresentation;
	readonly display: string;
	state: "issued" | "presented" | "retiring" | "terminal" | "failed";
	retirement?: Retirement;
}

/** Project only the immutable SDK gate fields, excluding diagnostic query metadata. */
function fingerprint(gate: WorkflowGate): string {
	return crypto.createHash("sha256").update(canonicalJson({
		type: gate.type, gate_id: gate.gate_id, stage: gate.stage, kind: gate.kind,
		schema: gate.schema, schema_hash: gate.schema_hash, options: gate.options,
		context: gate.context, created_at: gate.created_at, required: gate.required,
		runtime_turn_id: gate.runtime_turn_id,
	})).digest("hex");
}

function displayFingerprint(gate: DesktopActivityGate): string {
	return crypto.createHash("sha256").update(canonicalJson({
		...gate,
		// The adapter deliberately generates fresh choice handles on every complete read.
		choices: gate.choices.map(({ label, description }) => ({ label, description })),
	})).digest("hex");
}

function freeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

/**
 * The sole terminal controller for one genuine session + connection binding.
 * A read, emitted event, timer, or teardown is never proof of GUI retirement.
 * Only the guarded owner acknowledging the exact issued retirement nonce proves it.
 */
export class DesktopGatePresenter {
	readonly #session: CreateAgentSessionResult["session"];
	readonly #activity: DesktopActivityController;
	readonly #sessionId: string;
	readonly #managerSessionId: string;
	readonly #sessionManager: CreateAgentSessionResult["session"]["sessionManager"];
	readonly #sdkGeneration: number;
	readonly #connectionGeneration: string;
	readonly #catalogSessionId: string;
	readonly #activityGeneration: string;
	readonly #emitter: WorkflowGateEmitter;
	readonly #isCurrent: (connectionGeneration: string, catalogSessionId: string) => boolean;
	readonly #emit: (event: DesktopGatePresentationEvent) => void;
	readonly #timeout: number;
	readonly #records = new Map<string, PresentationRecord>();
	readonly #answering = new Set<string>();
	readonly #completing = new Set<string>();
	readonly #cleanups: Array<() => void> = [];
	#registered = false;
	#unregister: (() => void) | undefined;
	#revoked = false;
	#checking = false;
	#dispatching = false;
	#preparing = false;
	#withdrawingAll = false;

	constructor(options: DesktopGatePresenterOptions) {
		const { session, activity, connectionGeneration, catalogSessionId, isCurrent, emit } = options;
		const timeout = options.retirementTimeoutMs ?? DESKTOP_GATE_PRESENTATION_LIMITS.retirementTimeoutMs;
		if (typeof connectionGeneration !== "string" || !connectionGeneration || connectionGeneration.length > 128
			|| typeof catalogSessionId !== "string" || !catalogSessionId || catalogSessionId.length > 256
			|| typeof isCurrent !== "function" || typeof emit !== "function"
			|| !Number.isSafeInteger(timeout) || timeout < 1 || timeout > DESKTOP_GATE_PRESENTATION_LIMITS.maxRetirementTimeoutMs)
			throw new DesktopGatePresentationError("unavailable");
		const lifecycle = session.sessionLifecycle;
		if (lifecycle.disposed || session.isDisposed) throw new DesktopGatePresentationError("revoked");
		if (lifecycle.transitioning) throw new DesktopGatePresentationError("busy");
		this.#sdkGeneration = lifecycle.generation;
		this.#sessionManager = session.sessionManager;
		this.#session = session;
		this.#activity = activity;
		this.#sessionId = session.sessionId;
		this.#managerSessionId = session.sessionManager.getSessionId();
		this.#connectionGeneration = connectionGeneration;
		this.#catalogSessionId = catalogSessionId;
		this.#isCurrent = isCurrent;
		this.#emit = emit;
		this.#timeout = timeout;
		const emitter = session.getWorkflowGateEmitter();
		if (!emitter?.registerGateTerminalController || !emitter.listPendingGates || !emitter.listWorkflowGateQueryRecords || !emitter.resolveGate)
			throw new DesktopGatePresentationError("unavailable");
		this.#emitter = emitter;
		const snapshot = activity.getSnapshot();
		if (!snapshot.sessionState || snapshot.connectionGeneration !== connectionGeneration)
			throw new DesktopGatePresentationError("unavailable");
		this.#activityGeneration = snapshot.sessionGeneration;
		this.#assertLive(false);
		const controller: WorkflowGateTerminalController = {
			completeGateInteractions: gateId => this.#complete(gateId),
			cancelGateInteractions: gateId => this.#cancel(gateId),
		};
		try {
			// The canonical emitter rejects an existing controller. Never unregister someone else's.
			this.#unregister = emitter.registerGateTerminalController(controller);
			this.#registered = true;
		} catch {
			throw new DesktopGatePresentationError("registration_failed");
		}
		try {
			this.#cleanups.push(session.registerToolSessionCleanup(() => this.dispose()));
			// Cleanup/notification is a wakeup, not evidence of a committed transition.
			this.#cleanups.push(session.registerToolSessionTransitionCleanup(() => this.#observeLifecycle()));
			this.#cleanups.push(session.subscribe(() => this.#observeLifecycle()));
			this.#assertLive();
		} catch {
			this.revoke();
			throw new DesktopGatePresentationError("revoked");
		}
	}

	#entry(): void {
		if (this.#dispatching || this.#checking || this.#preparing) {
			this.revoke();
			throw new DesktopGatePresentationError("busy");
		}
		this.#assertLive();
	}

	#observeLifecycle(): void {
		if (this.#checking || this.#dispatching || this.#preparing) {
			// A callback cannot reenter validation and turn temporary busy into authority.
			this.revoke();
			return;
		}
		try { this.#assertLive(); } catch (error) {
			if (!(error instanceof DesktopGatePresentationError && error.code === "busy")) this.revoke();
		}
	}

	#assertLive(requireRegistered = true): void {
		if (this.#revoked || (requireRegistered && !this.#registered)) throw new DesktopGatePresentationError("revoked");
		if (this.#checking) {
			this.revoke();
			throw new DesktopGatePresentationError("busy");
		}
		this.#checking = true;
		let transitionBusy = false;
		const checkBinding = () => {
			const lifecycle = this.#session.sessionLifecycle;
			if (this.#revoked || lifecycle.disposed || this.#session.isDisposed || lifecycle.generation !== this.#sdkGeneration
				|| this.#isCurrent(this.#connectionGeneration, this.#catalogSessionId) !== true)
				throw new DesktopGatePresentationError("revoked");
			// The host callback can reenter or start a transition. Read the public
			// authority again before interpreting temporarily staged SDK identities.
			const current = this.#session.sessionLifecycle;
			if (this.#revoked || current.disposed || this.#session.isDisposed || current.generation !== this.#sdkGeneration)
				throw new DesktopGatePresentationError("revoked");
			if (current.transitioning) {
				transitionBusy = true;
				throw new DesktopGatePresentationError("busy");
			}
			if (this.#session.sessionManager !== this.#sessionManager || this.#session.sessionId !== this.#sessionId
				|| this.#session.sessionManager.getSessionId() !== this.#managerSessionId
				|| this.#session.getWorkflowGateEmitter() !== this.#emitter)
				throw new DesktopGatePresentationError("revoked");
		};
		try {
			checkBinding();
			const snapshot = this.#activity.getSnapshot();
			// Redaction inside the activity snapshot can notify or begin preparation.
			// Check committed authority first, before treating an unavailable view as stale.
			checkBinding();
			if (!snapshot.sessionState || snapshot.sessionGeneration !== this.#activityGeneration
				|| snapshot.connectionGeneration !== this.#connectionGeneration || this.#revoked)
				throw new DesktopGatePresentationError("revoked");
		} catch {
			if (transitionBusy && !this.#revoked) throw new DesktopGatePresentationError("busy");
			this.revoke();
			throw new DesktopGatePresentationError("revoked");
		} finally {
			this.#checking = false;
		}
	}

	#prepare<T>(operation: () => T): T {
		this.#preparing = true;
		try { return operation(); } finally { this.#preparing = false; }
	}

	#record(id: string): PresentationRecord {
		if (typeof id !== "string" || id.length > 128) throw new DesktopGatePresentationError("invalid_presentation");
		const record = this.#records.get(id);
		if (!record) throw new DesktopGatePresentationError("invalid_presentation");
		return record;
	}

	#currentFingerprint(gateId: string, accepted = false): string {
		const pending = this.#emitter.listPendingGates?.().find(gate => gate.gate_id === gateId);
		const gate = pending ?? (accepted ? this.#emitter.listWorkflowGateQueryRecords?.().find(row =>
			row.gate_id === gateId && row.tag === "accepted" && row.post_accept_disposition !== "continuation_lost"
			&& row.post_accept_disposition !== "unknown") : undefined);
		if (!gate || schemaHash(gate.schema) !== gate.schema_hash) throw new DesktopGatePresentationError("stale_presentation");
		return fingerprint(gate);
	}

	#assertTarget(record: PresentationRecord, accepted = false): void {
		this.#assertLive();
		try {
			if (this.#currentFingerprint(record.gateId, accepted) !== record.fingerprint)
				throw new DesktopGatePresentationError("stale_presentation");
		} catch {
			// Observing an immutable target disappear/change permanently fences this ledger.
			this.revoke();
			throw new DesktopGatePresentationError("stale_presentation");
		}
		this.#assertLive();
	}

	#dispatch(event: DesktopGatePresentationEvent): void {
		if (this.#dispatching) throw new DesktopGatePresentationError("busy");
		this.#dispatching = true;
		try {
			const delivered: unknown = this.#emit(freeze(event));
			if (delivered instanceof Promise) {
				void delivered.catch(() => undefined);
				throw new DesktopGatePresentationError("callback_failed");
			}
		} catch {
			this.revoke();
			throw new DesktopGatePresentationError("callback_failed");
		} finally {
			this.#dispatching = false;
		}
	}

	present(ref: DesktopActivityRef): DesktopGatePresentation {
		this.#entry();
		if (this.#withdrawingAll) throw new DesktopGatePresentationError("busy");
		return this.#prepare(() => {
			if (this.#records.size >= DESKTOP_GATE_PRESENTATION_LIMITS.presentations) throw new DesktopGatePresentationError("capacity");
			// Snapshot untrusted properties before any trusted callback can run.
			const captured = freeze({ sessionGeneration: ref?.sessionGeneration, connectionGeneration: ref?.connectionGeneration, key: ref?.key });
			const { gate, gateId } = this.#activity.getGatePresentation(captured);
			this.#assertLive();
			if (!gate.answerable || gate.truncated) throw new DesktopGatePresentationError("unavailable");
			if (this.#answering.has(gateId) || this.#completing.has(gateId)) throw new DesktopGatePresentationError("busy");
			const target = this.#currentFingerprint(gateId);
			const previous = [...this.#records.values()].find(record => record.gateId === gateId);
			if (previous && previous.fingerprint !== target) throw new DesktopGatePresentationError("stale_presentation");
			const presentation = freeze({ id: crypto.randomUUID(), gate: structuredClone(gate) });
			const record: PresentationRecord = {
				id: presentation.id, gateId, fingerprint: target, ref: captured, presentation,
				display: displayFingerprint(gate), state: "issued",
			};
			// Never evict even terminal/failed evidence into a false not_published proof.
			this.#records.set(record.id, record);
			this.#dispatch({ type: "presented", presentation });
			this.#assertTarget(record);
			return structuredClone(presentation);
		});
	}

	/** Called only after the owning React tree has committed this exact surface. */
	acknowledgePresented(id: string): void {
		this.#entry();
		const record = this.#record(id);
		this.#assertTarget(record);
		if (record.state !== "issued" && record.state !== "presented") throw new DesktopGatePresentationError("not_presented");
		record.state = "presented";
	}

	async answer(id: string, request: DesktopActivityGateAnswer): Promise<DesktopActivityGateAnswerResult> {
		this.#entry();
		if (this.#withdrawingAll) throw new DesktopGatePresentationError("busy");
		const record = this.#record(id);
		if (record.state !== "presented") throw new DesktopGatePresentationError("not_presented");
		if (this.#answering.has(record.gateId) || this.#completing.has(record.gateId)) throw new DesktopGatePresentationError("busy");
		if (!request || typeof request !== "object") throw new DesktopActivityError("invalid_answer");
		// Read renderer properties before callbacks, then retain no caller-owned objects.
		const { kind, choiceKey, json } = this.#prepare(() => {
			const kind = request.kind;
			return { kind, choiceKey: kind === "choice" ? request.choiceKey : undefined, json: kind === "json" ? request.json : undefined };
		});
		this.#answering.add(record.gateId);
		try {
			this.#assertTarget(record);
			const current = this.#prepare(() => this.#activity.getGatePresentation(record.ref));
			this.#assertTarget(record);
			if (current.gateId !== record.gateId || displayFingerprint(current.gate) !== record.display || record.state !== "presented")
				throw new DesktopGatePresentationError("stale_presentation");
			let answer: DesktopActivityGateAnswer;
			if (kind === "choice" && typeof choiceKey === "string") {
				const index = record.presentation.gate.choices.findIndex(choice => choice.key === choiceKey);
				const choice = index < 0 ? undefined : current.gate.choices[index];
				if (!choice) throw new DesktopActivityError("invalid_answer");
				// Same immutable SDK gate, same complete display, same ordered original option.
				// Only the fresh adapter handle is translated; original values/schema stay there.
				answer = { kind: "choice", choiceKey: choice.key };
			} else if (kind === "json" && typeof json === "string") answer = { kind: "json", json };
			else throw new DesktopActivityError("invalid_answer");
			const result = await this.#activity.answerGate(record.ref, answer);
			this.#assertTarget(record, result.status === "accepted");
			return result;
		} finally {
			this.#answering.delete(record.gateId);
		}
	}

	#retire(record: PresentationRecord): Promise<void> {
		if (record.state === "terminal") return Promise.resolve();
		if (record.state === "failed") return Promise.reject(new DesktopGatePresentationError("invalid_retirement"));
		if (record.retirement) return record.retirement.promise;
		const deferred = Promise.withResolvers<void>();
		const retirement: Retirement = {
			nonce: crypto.randomUUID(), ...deferred, timer: undefined, deadline: performance.now() + this.#timeout,
		};
		// Keep failed callbacks/timeouts observed even when no terminalization call awaits yet.
		void retirement.promise.catch(() => undefined);
		record.retirement = retirement;
		record.state = "retiring";
		retirement.timer = setTimeout(() => {
			if (record.state !== "retiring") return;
			record.state = "failed";
			retirement.reject(new DesktopGatePresentationError("retirement_timeout"));
		}, this.#timeout);
		try {
			this.#dispatch({ type: "retire", presentationId: record.id, nonce: retirement.nonce });
			this.#assertLive();
		} catch (error) {
			if (retirement.timer) clearTimeout(retirement.timer);
			record.state = "failed";
			retirement.reject(error instanceof DesktopGatePresentationError ? error : new DesktopGatePresentationError("callback_failed"));
		}
		return retirement.promise;
	}

	/** Hide only this surface. The workflow remains unanswered and may be reopened. */
	async withdraw(id: string): Promise<void> {
		this.#entry();
		const record = this.#record(id);
		this.#assertTarget(record, true);
		await this.#retire(record);
		this.#assertTarget(record, true);
	}

	/**
	 * Hide every issued surface before a host mutation. This never answers a gate.
	 * The host must also block new present calls until its subsequent mutation ends.
	 */
	async withdrawAll(): Promise<void> {
		this.#entry();
		if (this.#withdrawingAll) throw new DesktopGatePresentationError("busy");
		this.#withdrawingAll = true;
		const records = [...this.#records.values()].filter(record => record.state !== "terminal");
		try {
			for (const record of records) this.#assertTarget(record, true);
			await Promise.all(records.map(record => this.#retire(record)));
			this.#assertLive();
			for (const record of records) {
				this.#assertTarget(record, true);
				if (record.state !== "terminal") throw new DesktopGatePresentationError("invalid_retirement");
			}
		} finally {
			this.#withdrawingAll = false;
		}
	}

	/** The UI must have committed absence of the exact surface before sending this nonce. */
	acknowledgeRetired(id: string, nonce: string): void {
		this.#entry();
		const record = this.#record(id);
		const retirement = record.retirement;
		if (record.state !== "retiring" || !retirement || typeof nonce !== "string" || nonce !== retirement.nonce)
			throw new DesktopGatePresentationError("invalid_retirement");
		if (performance.now() >= retirement.deadline) {
			record.state = "failed";
			if (retirement.timer) clearTimeout(retirement.timer);
			retirement.reject(new DesktopGatePresentationError("retirement_timeout"));
			throw new DesktopGatePresentationError("retirement_timeout");
		}
		this.#assertTarget(record, true);
		if (retirement.timer) clearTimeout(retirement.timer);
		record.state = "terminal";
		retirement.resolve();
	}

	async #retireGate(gateId: string): Promise<WorkflowGateTerminalProof> {
		this.#entry();
		if (this.#completing.has(gateId)) throw new DesktopGatePresentationError("busy");
		const records = [...this.#records.values()].filter(record => record.gateId === gateId);
		// No source-grounded proof of exclusive unpublished ownership is available here.
		// Unknown/unissued gates therefore fail closed, NEVER not_published.
		if (!records.length) throw new DesktopGatePresentationError("invalid_presentation");
		for (const record of records) this.#assertTarget(record, true);
		const alreadyTerminal = records.every(record => record.state === "terminal");
		this.#completing.add(gateId);
		try {
			await Promise.all(records.map(record => this.#retire(record)));
			for (const record of records) {
				this.#assertTarget(record, true);
				if (record.state !== "terminal") throw new DesktopGatePresentationError("invalid_retirement");
			}
			return alreadyTerminal ? "already_terminal" : "retired";
		} finally {
			this.#completing.delete(gateId);
		}
	}

	#complete(gateId: string): Promise<WorkflowGateTerminalProof> {
		return this.#retireGate(gateId);
	}

	async #cancel(gateId: string): Promise<void> {
		await this.#retireGate(gateId);
	}

	/** Permanent host-binding revocation. It rejects waits and requests hiding, never proves it. */
	revoke(): void {
		if (this.#revoked) return;
		this.#revoked = true;
		this.#registered = false;
		// A replacement controller must not forget an unproven old surface. Keep
		// this revoked controller occupying a live emitter until its SDK owner dies.
		if (this.#session.isDisposed || [...this.#records.values()].every(record => record.state === "terminal")) {
			try { this.#unregister?.(); } catch { /* Never restore authority. */ }
			this.#unregister = undefined;
		}
		for (const cleanup of this.#cleanups.splice(0).reverse()) {
			try { cleanup(); } catch { /* Revocation cannot restore authority on cleanup failure. */ }
		}
		for (const record of this.#records.values()) {
			if (record.state === "terminal" || record.state === "failed") continue;
			if (!record.retirement && !this.#dispatching) {
				// Best effort hide request on teardown; its nonce cannot now be acknowledged.
				try { this.#dispatch({ type: "retire", presentationId: record.id, nonce: crypto.randomUUID() }); } catch { /* No proof. */ }
			}
			record.state = "failed";
			if (record.retirement?.timer) clearTimeout(record.retirement.timer);
			record.retirement?.reject(new DesktopGatePresentationError("revoked"));
		}
	}

	dispose(): void {
		this.revoke();
	}
}

export function createDesktopGatePresenter(options: DesktopGatePresenterOptions): DesktopGatePresenter {
	return new DesktopGatePresenter(options);
}
