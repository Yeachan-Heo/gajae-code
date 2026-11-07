import { createHash } from "node:crypto";
import type { CreateAgentSessionResult, JobObservation, JobObservationSnapshot } from "@gajae-code/coding-agent/sdk";
import { JobObservationError } from "@gajae-code/coding-agent/sdk/job-observation";
import {
	canonicalJson,
	compileGateSchema,
	schemaHash,
	validateGateAnswer,
	type WorkflowGate,
	type WorkflowGateEmitter,
} from "@gajae-code/coding-agent/sdk/workflow-gates";
import type {
	DesktopActivityCron,
	DesktopActivityDetail,
	DesktopActivityErrorCode,
	DesktopActivityGate,
	DesktopActivityGateAnswer,
	DesktopActivityGateAnswerResult,
	DesktopActivityGateSummary,
	DesktopActivityJob,
	DesktopActivityOperation,
	DesktopActivityRef,
	DesktopActivityScope,
	DesktopActivitySessionState,
	DesktopActivitySnapshot,
	DesktopActivityTask,
} from "./activity-protocol";

export const DESKTOP_ACTIVITY_LIMITS = {
	entries: 100,
	fieldChars: 1024,
	outputChars: 16_384,
	gates: 32,
	gateContentChars: 32_768,
	gateSchemaChars: 65_536,
	gateOptions: 64,
	answerBytes: 65_536,
} as const;

const REASONS: Record<DesktopActivityErrorCode, string> = {
	unavailable: "This session has no public job observation capability.",
	disposed: "Activity observation has been disposed.",
	stale_session: "The session has changed; reopen activity observation.",
	stale_connection: "The connection has changed; reopen activity observation.",
	invalid_reference: "Invalid activity reference.",
	not_found: "The activity is no longer in this session's observation.",
	stale_generation: "The activity has been replaced; refresh its reference.",
	unsupported: "The public session API does not currently support this control.",
	control_busy: "The task lifecycle is changing or its owner is shutting down; refresh before controlling it.",
	already_terminal: "The activity is already terminal.",
	backend_failure: "The activity backend operation failed.",
	redaction_failed: "Activity redaction failed; no content was returned.",
	invalid_answer: "The answer does not satisfy the original gate schema or input limits.",
	gate_not_presented: "Open the complete gate content before answering.",
	gate_busy: "An answer for this gate is already in progress.",
	gate_content_too_large: "The gate exceeds safe display limits; answer through another complete presentation.",
	gate_resolution_failed:
		"The gate response could not be proven complete. Refresh its state; do not assume approval or execution. The host must wire genuine gate presentation terminalization.",
};

export class DesktopActivityError extends Error {
	constructor(readonly code: DesktopActivityErrorCode) {
		super(REASONS[code]);
		this.name = "DesktopActivityError";
	}
}

export interface DesktopActivityOptions {
	/** Host-owned connection incarnation. Create a new controller on reconnect. */
	connectionGeneration: string;
	/** Required host policy: redact host-known secrets before truncation or serialization. */
	redact: (text: string) => string;
}

type FactoryResult = Pick<CreateAgentSessionResult, "session" | "jobObservation">;
interface GateReference {
	emitter: WorkflowGateEmitter;
	gateId: string;
	fingerprint: string;
	choices: Map<string, unknown>;
	presented: boolean;
	busy: boolean;
}

function gateFingerprint(gate: WorkflowGate): string {
	return createHash("sha256").update(canonicalJson(gate)).digest("hex");
}

function parseAnswer(json: string): unknown {
	if (Buffer.byteLength(json, "utf8") > DESKTOP_ACTIVITY_LIMITS.answerBytes)
		throw new DesktopActivityError("invalid_answer");
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		throw new DesktopActivityError("invalid_answer");
	}
	const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
	let nodes = 0;
	while (pending.length) {
		const current = pending.pop()!;
		if (
			++nodes > 4096 ||
			current.depth > 16 ||
			(typeof current.value === "number" && !Number.isFinite(current.value))
		)
			throw new DesktopActivityError("invalid_answer");
		if (current.value && typeof current.value === "object") {
			for (const child of Object.values(current.value)) pending.push({ value: child, depth: current.depth + 1 });
		}
	}
	return value;
}
type Target =
	| { type: "job"; id: string; generation: string }
	| { type: "task"; id: string; generation: string }
	| { type: "cron"; id: string; createdAt: number };
type JobRow = JobObservationSnapshot["jobs"][number];
type TaskRow = JobObservationSnapshot["tasks"][number];
type CronRow = JobObservationSnapshot["crons"][number];
type Row = { type: "job"; value: JobRow } | { type: "task"; value: TaskRow } | { type: "cron"; value: CronRow };

function targetFor(row: Row): Target {
	switch (row.type) {
		case "job":
			return { type: "job", id: row.value.id, generation: row.value.generation };
		case "task":
			return { type: "task", id: row.value.target.id, generation: row.value.target.generation };
		case "cron":
			return { type: "cron", id: row.value.id, createdAt: row.value.createdAt };
	}
}

function identity(target: Target): string {
	return JSON.stringify(target);
}

function finite(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * A connection-local adapter over the factory's captured owner-scoped view.
 * References are view identities, not authorization: SDK ownership and generation
 * checks remain authoritative. No global manager, owner input, or manager disposal.
 */
export class DesktopActivityController {
	readonly #session: FactoryResult["session"];
	readonly #sessionId: string;
	readonly #managerSessionId: string;
	readonly #sessionManager: FactoryResult["session"]["sessionManager"];
	readonly #sdkGeneration: number;
	readonly #observation: JobObservation | undefined;
	readonly #redact: (text: string) => string;
	readonly #scope: DesktopActivityScope;
	readonly #references = new Map<string, Target>();
	readonly #gateReferences = new Map<string, GateReference>();
	readonly #subscriptions = new Set<() => void>();
	readonly #lifecycleUnsubscribers: Array<() => void> = [];
	#staleSession = false;
	#disposed = false;

	constructor(result: FactoryResult, options: DesktopActivityOptions) {
		if (
			typeof options.connectionGeneration !== "string" ||
			!options.connectionGeneration ||
			options.connectionGeneration.length > 128
		)
			throw new DesktopActivityError("stale_connection");
		if (typeof options.redact !== "function") throw new DesktopActivityError("redaction_failed");
		this.#session = result.session;
		const lifecycle = result.session.sessionLifecycle;
		if (lifecycle.transitioning && !lifecycle.disposed) throw new DesktopActivityError("control_busy");
		this.#sdkGeneration = lifecycle.generation;
		this.#sessionManager = result.session.sessionManager;
		this.#sessionId = result.session.sessionId;
		// Gate brokers belong to SessionManager identity, which may differ from
		// the provider-facing AgentSession.sessionId override.
		this.#managerSessionId = result.session.sessionManager.getSessionId();
		this.#scope = { sessionGeneration: crypto.randomUUID(), connectionGeneration: options.connectionGeneration };
		this.#redact = options.redact;
		// Do not instantiate the factory's lazy capability after session disposal.
		this.#observation =
			lifecycle.disposed || lifecycle.transitioning || result.session.isDisposed ? undefined : result.jobObservation;
		if (!result.session.isDisposed) {
			this.#lifecycleUnsubscribers.push(result.session.registerToolSessionCleanup(() => this.dispose()));
			this.#lifecycleUnsubscribers.push(
				result.session.registerToolSessionTransitionCleanup(() => {
					// A cleanup is not a commit. Compaction and cancelled preparation
					// can notify without changing the frozen SDK generation.
					try {
						this.#assertSession();
					} catch {
						/* Reads and controls report current availability. */
					}
				}),
			);
		}
	}

	#assertSession(): void {
		const lifecycle = this.#session.sessionLifecycle;
		if (this.#disposed || lifecycle.disposed || this.#session.isDisposed) {
			this.dispose();
			throw new DesktopActivityError("disposed");
		}
		if (lifecycle.generation !== this.#sdkGeneration) this.#invalidateSession();
		if (this.#staleSession) throw new DesktopActivityError("stale_session");
		// Preparation can transiently stage identities. It grants no new authority
		// and refuses controls, but cannot permanently revoke an unchanged binding.
		if (lifecycle.transitioning) throw new DesktopActivityError("control_busy");
		if (
			this.#session.sessionManager !== this.#sessionManager ||
			this.#session.sessionId !== this.#sessionId ||
			this.#session.sessionManager.getSessionId() !== this.#managerSessionId
		) {
			this.#invalidateSession();
			throw new DesktopActivityError("stale_session");
		}
	}

	#invalidateSession(): void {
		this.#staleSession = true;
		this.#references.clear();
		this.#gateReferences.clear();
	}

	#backend<T>(operation: () => T): T {
		try {
			return operation();
		} catch (error) {
			if (error instanceof DesktopActivityError) throw error;
			if (error instanceof JobObservationError) {
				const code = error.code;
				switch (code) {
					case "invalid_owner":
						throw new DesktopActivityError("unavailable");
					case "read_only":
					case "no_live_job":
					case "not_running":
					case "no_live_handle":
					case "already_running":
					case "already_queued":
					case "context_unavailable":
					case "no_runner":
						throw new DesktopActivityError("unsupported");
					case "control_in_progress":
					case "owner_shutdown_in_progress":
						throw new DesktopActivityError("control_busy");
					case "resume_failed":
						throw new DesktopActivityError("backend_failure");
					case "disposed":
						throw new DesktopActivityError("disposed");
					case "not_found":
						throw new DesktopActivityError("not_found");
					case "stale_generation":
						throw new DesktopActivityError("stale_generation");
					case "already_terminal":
						throw new DesktopActivityError("already_terminal");
					default:
						throw new DesktopActivityError("backend_failure");
				}
			}
			// Backend messages may contain command text, paths or credentials.
			throw new DesktopActivityError("backend_failure");
		}
	}

	#view(): JobObservation {
		this.#assertSession();
		if (!this.#observation) throw new DesktopActivityError("unavailable");
		return this.#observation;
	}

	#text(value: string, limit: number = DESKTOP_ACTIVITY_LIMITS.fieldChars): { text: string; truncated: boolean } {
		let redacted: string;
		try {
			redacted = this.#redact(value);
			if (typeof redacted !== "string") throw new Error("Invalid redaction result");
		} catch {
			throw new DesktopActivityError("redaction_failed");
		}
		// Strip terminal control sequences and non-printing controls from renderer-facing text.
		const text = redacted.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
		return { text: text.slice(0, limit), truncated: text.length > limit };
	}

	#ref(key: string): DesktopActivityRef {
		return { ...this.#scope, key };
	}

	#sessionState(): DesktopActivitySessionState {
		const state = this.#session.getGoalModeState();
		const workflow = this.#session.getEffectiveActiveWorkflowSkillState();
		const gates = this.#gateSummaries();
		return {
			goal: state
				? {
						enabled: state.enabled,
						status: state.goal.status,
						tokensUsed: finite(state.goal.tokensUsed),
						timeUsedSeconds: finite(state.goal.timeUsedSeconds),
					}
				: null,
			workflow: workflow ? { skill: this.#text(workflow.skill).text } : null,
			gates,
		};
	}

	#schemaDisplay(schema: unknown): { text: string; truncated: boolean } {
		let truncated = false;
		let nodes = 0;
		const text = (value: string): string => {
			const projected = this.#text(value, DESKTOP_ACTIVITY_LIMITS.gateSchemaChars);
			truncated ||= projected.truncated;
			return projected.text;
		};
		const project = (value: unknown, depth: number): unknown => {
			if (++nodes > 8192 || depth > 32) throw new DesktopActivityError("gate_content_too_large");
			if (typeof value === "string") return text(value);
			if (Array.isArray(value)) return value.map(child => project(child, depth + 1));
			if (value && typeof value === "object")
				return Object.fromEntries(
					Object.entries(value).map(([key, child]) => [text(key), project(child, depth + 1)]),
				);
			return value;
		};
		// Redact strings AND property names before JSON escaping, otherwise a
		// secret containing quotes/newlines could survive a serialized-text pass.
		const serialized = JSON.stringify(project(schema, 0), null, 2);
		if (typeof serialized !== "string") throw new DesktopActivityError("backend_failure");
		return {
			text: serialized.slice(0, DESKTOP_ACTIVITY_LIMITS.gateSchemaChars),
			truncated: truncated || serialized.length > DESKTOP_ACTIVITY_LIMITS.gateSchemaChars,
		};
	}

	#remoteAnswers(emitter: WorkflowGateEmitter): boolean {
		return typeof emitter.resolveGate === "function" && emitter.supportsRemoteGateAnswers() === true;
	}

	#gateSummary(key: string, gate: WorkflowGate, emitter: WorkflowGateEmitter): DesktopActivityGateSummary {
		const answerable = this.#remoteAnswers(emitter);
		return {
			ref: this.#ref(key),
			kind: gate.kind,
			stage: this.#text(gate.stage).text,
			createdAt: this.#text(gate.created_at).text,
			answerable,
			...(!answerable
				? {
						reason:
							"This session's emitter does not advertise remote answers. The session factory must install an authoritative remote-answer emitter.",
					}
				: {}),
		};
	}

	#gateSummaries(): DesktopActivitySessionState["gates"] {
		const emitter = this.#session.getWorkflowGateEmitter();
		const gates = emitter?.listPendingGates?.();
		if (!emitter || !gates) {
			this.#gateReferences.clear();
			return {
				available: false,
				reason:
					"The session factory must expose an authoritative workflow emitter with listPendingGates for app gate observation.",
			};
		}
		const retained = new Map<string, GateReference>();
		const pending = gates.slice(0, DESKTOP_ACTIVITY_LIMITS.gates).map(gate => {
			const fingerprint = gateFingerprint(gate);
			const existing = [...this.#gateReferences].find(
				([, record]) =>
					record.emitter === emitter && record.gateId === gate.gate_id && record.fingerprint === fingerprint,
			);
			const key = existing?.[0] ?? crypto.randomUUID();
			retained.set(
				key,
				existing?.[1] ?? {
					emitter,
					gateId: gate.gate_id,
					fingerprint,
					choices: new Map(),
					presented: false,
					busy: false,
				},
			);
			return this.#gateSummary(key, gate, emitter);
		});
		this.#assertSession();
		if (this.#session.getWorkflowGateEmitter() !== emitter) throw new DesktopActivityError("stale_generation");
		this.#gateReferences.clear();
		for (const [key, record] of retained) this.#gateReferences.set(key, record);
		return { available: true, pending, truncated: gates.length > pending.length };
	}

	#resolveGate(ref: DesktopActivityRef): { key: string; record: GateReference; gate: WorkflowGate } {
		this.#checkScope(ref);
		const key = ref.key;
		this.#assertSession();
		if (typeof key !== "string" || key.length > 128) throw new DesktopActivityError("invalid_reference");
		const record = this.#gateReferences.get(key);
		if (!record) throw new DesktopActivityError("not_found");
		if (this.#session.getWorkflowGateEmitter() !== record.emitter) throw new DesktopActivityError("stale_generation");
		const gate = record.emitter.listPendingGates?.().find(entry => entry.gate_id === record.gateId);
		if (!gate) throw new DesktopActivityError("not_found");
		if (gateFingerprint(gate) !== record.fingerprint || schemaHash(gate.schema) !== gate.schema_hash)
			throw new DesktopActivityError("stale_generation");
		this.#assertSession();
		return { key, record, gate };
	}

	/** Complete operator presentation is required before either answer mode can be used. */
	getGate(ref: DesktopActivityRef): DesktopActivityGate {
		return this.#backend(() => this.#gate(ref));
	}

	/**
	 * Trusted-host presentation ledger binding only. Never serialize this result
	 * as a browser DTO: gateId is the exact SDK identity, not display text.
	 * This reads/validates content; it supplies no terminalization proof.
	 */
	getGatePresentation(ref: DesktopActivityRef): { gate: DesktopActivityGate; gateId: string } {
		return this.#backend(() => {
			const original = this.#resolveGate(ref);
			const gate = this.getGate(this.#ref(original.key));
			if (gate.truncated) throw new DesktopActivityError("gate_content_too_large");
			const current = this.#resolveGate(this.#ref(original.key));
			if (current.record !== original.record) throw new DesktopActivityError("stale_generation");
			return { gate, gateId: current.record.gateId };
		});
	}

	#gate(ref: DesktopActivityRef): DesktopActivityGate {
		const { key, record, gate } = this.#resolveGate(ref);
		record.presented = false;
		const compiled = compileGateSchema(gate.schema);
		let truncated = false;
		let remaining = DESKTOP_ACTIVITY_LIMITS.gateContentChars as number;
		const content: DesktopActivityGate["content"] = {};
		for (const field of ["title", "prompt", "summary", "plan", "source", "language"] as const) {
			const value = gate.context[field];
			if (value === undefined) continue;
			const projected = this.#text(value, remaining);
			content[field] = projected.text;
			remaining -= projected.text.length;
			truncated ||= projected.truncated;
		}
		const references = gate.context.artifact_refs ?? [];
		truncated ||= references.length > DESKTOP_ACTIVITY_LIMITS.gateOptions;
		const artifacts = references.slice(0, DESKTOP_ACTIVITY_LIMITS.gateOptions).map(reference => {
			const project = (value: string): string => {
				const text = this.#text(value, Math.min(remaining, DESKTOP_ACTIVITY_LIMITS.fieldChars));
				remaining -= text.text.length;
				truncated ||= text.truncated;
				return text.text;
			};
			return {
				kind: project(reference.kind),
				...(reference.path === undefined ? {} : { path: project(reference.path) }),
				...(reference.sha256 === undefined ? {} : { sha256: project(reference.sha256) }),
			};
		});
		const schema = this.#schemaDisplay(gate.schema);
		truncated ||= schema.truncated;
		const options = gate.options ?? [];
		truncated ||= options.length > DESKTOP_ACTIVITY_LIMITS.gateOptions;
		const choices: DesktopActivityGate["choices"] = [];
		const optionLabels: DesktopActivityGate["optionLabels"] = [];
		const nextChoices = new Map<string, unknown>();
		for (const option of options.slice(0, DESKTOP_ACTIVITY_LIMITS.gateOptions)) {
			const label = this.#text(option.label);
			const description = option.description === undefined ? undefined : this.#text(option.description);
			truncated ||= label.truncated || description?.truncated === true;
			const presentation = { label: label.text, ...(description ? { description: description.text } : {}) };
			optionLabels.push(presentation);
			// Producer labels often describe a field rather than a complete answer
			// (e.g. approval's decision). Those are instructions, never fake buttons.
			if (validateGateAnswer(compiled, gate.gate_id, option.value)) continue;
			const serialized = canonicalJson(option.value);
			if (Buffer.byteLength(serialized, "utf8") > DESKTOP_ACTIVITY_LIMITS.answerBytes) continue;
			const choiceKey = crypto.randomUUID();
			nextChoices.set(choiceKey, parseAnswer(serialized));
			choices.push({ key: choiceKey, ...presentation });
		}
		const summary = this.#gateSummary(key, gate, record.emitter);
		// Caller redaction can reenter the host. Re-resolve after all callbacks.
		const current = this.#resolveGate(this.#ref(key));
		if (current.record !== record) throw new DesktopActivityError("stale_generation");
		record.choices = nextChoices;
		record.presented = !truncated && summary.answerable;
		return {
			...summary,
			content,
			artifacts,
			schemaJson: schema.text,
			choices,
			optionLabels,
			truncated,
			answerable: record.presented,
			...(truncated ? { reason: REASONS.gate_content_too_large } : {}),
			maxAnswerBytes: DESKTOP_ACTIVITY_LIMITS.answerBytes,
		};
	}

	async answerGate(
		ref: DesktopActivityRef,
		request: DesktopActivityGateAnswer,
	): Promise<DesktopActivityGateAnswerResult> {
		// Capture untrusted properties before final lifecycle/identity checks. Never
		// forward renderer-supplied gate IDs, schema hashes or idempotency keys.
		if (!request || typeof request !== "object") throw new DesktopActivityError("invalid_answer");
		const kind = request.kind;
		const choiceKey = kind === "choice" ? request.choiceKey : undefined;
		const json = kind === "json" ? request.json : undefined;
		const { key, record, gate } = this.#backend(() => this.#resolveGate(ref));
		if (!this.#backend(() => this.#remoteAnswers(record.emitter))) throw new DesktopActivityError("unsupported");
		if (!record.presented) throw new DesktopActivityError("gate_not_presented");
		if (record.busy) throw new DesktopActivityError("gate_busy");
		let answer: unknown;
		if (
			kind === "choice" &&
			typeof choiceKey === "string" &&
			choiceKey.length <= 128 &&
			record.choices.has(choiceKey)
		) {
			answer = structuredClone(record.choices.get(choiceKey));
		} else if (
			kind === "json" &&
			typeof json === "string" &&
			json.length <= DESKTOP_ACTIVITY_LIMITS.answerBytes &&
			Buffer.byteLength(json, "utf8") <= DESKTOP_ACTIVITY_LIMITS.answerBytes
		) {
			answer = parseAnswer(json);
		} else throw new DesktopActivityError("invalid_answer");
		if (this.#backend(() => validateGateAnswer(compileGateSchema(gate.schema), gate.gate_id, answer)))
			throw new DesktopActivityError("invalid_answer");
		// This is an additional host fence, not a substitute for the broker's own
		// locked original-schema, runtime-instance and live-continuation validation.
		this.#backend(() => this.#resolveGate(this.#ref(key)));
		record.busy = true;
		try {
			const resolve = record.emitter.resolveGate;
			if (!resolve) throw new DesktopActivityError("unsupported");
			const result = await resolve.call(record.emitter, {
				gate_id: record.gateId,
				answer,
				idempotency_key: crypto.randomUUID(),
			});
			this.#assertSession();
			if (this.#session.getWorkflowGateEmitter() !== record.emitter)
				throw new DesktopActivityError("stale_generation");
			if (result.status === "rejected") return { status: "rejected", reason: REASONS.invalid_answer };
			this.#gateReferences.delete(key);
			return { status: "accepted" };
		} catch (error) {
			if (error instanceof DesktopActivityError) throw error;
			// Terminalization may fail after durable acceptance. Do not pretend the
			// answer was rejected or that execution resumed; leave SDK recovery intact.
			throw new DesktopActivityError("gate_resolution_failed");
		} finally {
			record.busy = false;
		}
	}

	#job(row: JobRow, snapshot: JobObservationSnapshot, key: string): DesktopActivityJob {
		const folded = snapshot.foldedJobs?.find(entry => entry.id === row.id && entry.generation === row.generation);
		const monitor = snapshot.monitors.some(entry => entry.id === row.id && entry.generation === row.generation);
		const outputAvailable = row.kind === "bash" && monitor && !row.backgrounded && !folded;
		return {
			type: "job",
			ref: this.#ref(key),
			id: this.#text(row.id).text,
			kind: this.#text(row.kind).text,
			label: this.#text(row.label).text,
			status: row.status,
			backgrounded: row.backgrounded,
			deliveryState: row.deliveryState,
			outputAvailable,
			controls: outputAvailable && row.status === "running" ? ["cancel"] : [],
			...(!outputAvailable
				? { reason: "Only non-folded monitor jobs support output and cancellation through the public API." }
				: {}),
			...(folded?.errorText ? { error: this.#text(folded.errorText).text } : {}),
		};
	}

	#project(row: Row, snapshot: JobObservationSnapshot, key: string): DesktopActivityDetail["entry"] {
		switch (row.type) {
			case "job":
				return this.#job(row.value, snapshot, key);
			case "task":
				return {
					type: "task",
					ref: this.#ref(key),
					id: this.#text(row.value.id).text,
					status: row.value.status,
					controls: [
						...(row.value.capabilities.cancel ? ["stop" as const] : []),
						...(row.value.capabilities.pause ? ["pause" as const] : []),
						...(row.value.capabilities.resume ? ["resume" as const] : []),
					],
					...(!row.value.capabilities.cancel && !row.value.capabilities.pause && !row.value.capabilities.resume
						? { reason: "The SDK advertises no controls for this task's current lifecycle." }
						: {}),
					...(row.value.requestedModel ? { requestedModel: this.#text(row.value.requestedModel).text } : {}),
					...(row.value.effectiveModel ? { effectiveModel: this.#text(row.value.effectiveModel).text } : {}),
				};
			case "cron":
				return {
					type: "cron",
					ref: this.#ref(key),
					id: this.#text(row.value.id).text,
					schedule: this.#text(row.value.humanSchedule).text,
					recurring: row.value.recurring,
					firing: row.value.firing === true,
					controls: ["delete"],
					...(row.value.nextFireAt === undefined ? {} : { nextFireAt: finite(row.value.nextFireAt) }),
				};
		}
	}

	#jobs(snapshot: JobObservationSnapshot): JobRow[] {
		const jobs = [...snapshot.jobs];
		const present = new Set(jobs.map(row => identity({ type: "job", id: row.id, generation: row.generation })));
		for (const row of snapshot.foldedJobs ?? []) {
			if (!present.has(identity({ type: "job", id: row.id, generation: row.generation }))) jobs.push(row);
		}
		return jobs;
	}

	/** Unavailable results intentionally have no idle-looking jobs/tasks/crons arrays. */
	getSnapshot(): DesktopActivitySnapshot {
		try {
			this.#assertSession();
			const sessionState = this.#sessionState();
			if (!this.#observation) {
				this.#assertSession();
				return { ...this.#scope, available: false, reason: REASONS.unavailable, sessionState };
			}
			const snapshot = this.#backend(() => this.#view().getSnapshot());
			const jobs = this.#jobs(snapshot);
			const oldKeys = new Map([...this.#references].map(([key, target]) => [identity(target), key]));
			const nextReferences = new Map<string, Target>();
			const project = (row: Row): DesktopActivityDetail["entry"] => {
				const target = targetFor(row);
				const key = oldKeys.get(identity(target)) ?? crypto.randomUUID();
				nextReferences.set(key, target);
				return this.#project(row, snapshot, key);
			};
			const projectedJobs = jobs
				.slice(0, DESKTOP_ACTIVITY_LIMITS.entries)
				.map(value => project({ type: "job", value }) as DesktopActivityJob);
			const tasks = snapshot.tasks
				.slice(0, DESKTOP_ACTIVITY_LIMITS.entries)
				.map(value => project({ type: "task", value }) as DesktopActivityTask);
			const crons = snapshot.crons
				.slice(0, DESKTOP_ACTIVITY_LIMITS.entries)
				.map(value => project({ type: "cron", value }) as DesktopActivityCron);
			this.#assertSession();
			this.#references.clear();
			for (const [key, target] of nextReferences) this.#references.set(key, target);
			return {
				...this.#scope,
				available: true,
				sessionState,
				jobs: projectedJobs,
				tasks,
				crons,
				truncated: {
					jobs: jobs.length > projectedJobs.length,
					tasks: snapshot.tasks.length > tasks.length,
					crons: snapshot.crons.length > crons.length,
				},
				activeMonitorCount: finite(snapshot.activeMonitorCount),
				activeCronCount: finite(snapshot.activeCronCount),
				worstState: snapshot.worstState,
				failedUnacknowledged: snapshot.failedUnacknowledged,
			};
		} catch (error) {
			const code = error instanceof DesktopActivityError ? error.code : "backend_failure";
			return { ...this.#scope, available: false, reason: REASONS[code] };
		}
	}

	#checkScope(scope: DesktopActivityScope): void {
		if (!scope || typeof scope !== "object") throw new DesktopActivityError("invalid_reference");
		const { sessionGeneration, connectionGeneration } = scope;
		this.#assertSession();
		if (connectionGeneration !== this.#scope.connectionGeneration) throw new DesktopActivityError("stale_connection");
		if (sessionGeneration !== this.#scope.sessionGeneration) throw new DesktopActivityError("stale_session");
	}

	#resolve(ref: DesktopActivityRef): { key: string; target: Target; row: Row; snapshot: JobObservationSnapshot } {
		this.#checkScope(ref);
		const key = ref.key;
		this.#assertSession();
		if (typeof key !== "string" || key.length > 128) throw new DesktopActivityError("invalid_reference");
		const target = this.#references.get(key);
		if (!target) throw new DesktopActivityError("not_found");
		const snapshot = this.#backend(() => this.#view().getSnapshot());
		let row: Row | undefined;
		switch (target.type) {
			case "job": {
				const value = this.#jobs(snapshot).find(job => job.id === target.id);
				if (value && value.generation !== target.generation) throw new DesktopActivityError("stale_generation");
				if (value) row = { type: "job", value };
				break;
			}
			case "task": {
				const value = snapshot.tasks.find(task => task.target.id === target.id);
				if (value && value.target.generation !== target.generation)
					throw new DesktopActivityError("stale_generation");
				if (value) row = { type: "task", value };
				break;
			}
			case "cron": {
				const value = snapshot.crons.find(cron => cron.id === target.id);
				if (value && value.createdAt !== target.createdAt) throw new DesktopActivityError("stale_generation");
				if (value) row = { type: "cron", value };
				break;
			}
		}
		if (!row) throw new DesktopActivityError("not_found");
		this.#assertSession();
		return { key, target, row, snapshot };
	}

	getDetail(ref: DesktopActivityRef): DesktopActivityDetail {
		const { key, target, row, snapshot } = this.#resolve(ref);
		// Read output before invoking the caller's redactor, then recheck session liveness.
		const readable =
			row.type === "job" &&
			snapshot.monitors.some(
				monitor => monitor.id === row.value.id && monitor.generation === row.value.generation,
			) &&
			!row.value.backgrounded &&
			!snapshot.foldedJobs?.some(job => job.id === row.value.id && job.generation === row.value.generation);
		const output =
			readable && target.type === "job" ? this.#backend(() => this.#view().getMonitorOutput(target)) : undefined;
		const entry = this.#project(row, snapshot, key);
		const detail: DesktopActivityDetail = {
			entry,
			...(output === undefined ? {} : { output: this.#text(output, DESKTOP_ACTIVITY_LIMITS.outputChars) }),
		};
		this.#assertSession();
		return detail;
	}

	operate(ref: DesktopActivityRef, operation: DesktopActivityOperation): DesktopActivitySnapshot {
		const { target } = this.#resolve(ref);
		// No redactor/listener/await between adapter checks and the SDK's own final
		// owner + generation validation. Task capabilities and CAS targets come only from the SDK.
		this.#backend(() => {
			const view = this.#view();
			if (operation === "cancel" && target.type === "job") view.cancelMonitor(target);
			else if (operation === "delete" && target.type === "cron") view.deleteCron(target);
			else if (operation === "stop" && target.type === "task") view.cancelTask(target);
			else if (operation === "pause" && target.type === "task") view.pauseTask(target);
			else if (operation === "resume" && target.type === "task") view.resumeTask(target);
			else throw new DesktopActivityError("unsupported");
		});
		return this.getSnapshot();
	}

	acknowledgeFailures(scope: DesktopActivityScope): DesktopActivitySnapshot {
		this.#checkScope(scope);
		this.#backend(() => this.#view().acknowledgeFailures());
		return this.getSnapshot();
	}

	/** Payload-free invalidation; re-read a bounded snapshot in the owning host. */
	onChange(listener: () => void): () => void {
		this.#assertSession();
		const notify = () => {
			if (this.#disposed) return;
			try {
				listener();
			} catch {
				/* Subscriber failures must not break lifecycle callbacks. */
			}
		};
		const unsubscribers: Array<() => void> = [];
		try {
			if (this.#observation) unsubscribers.push(this.#backend(() => this.#view().onChange(notify)));
			unsubscribers.push(this.#session.subscribe(notify));
			const gates = this.#session.getWorkflowGateEmitter();
			if (gates?.onGateEmitted) unsubscribers.push(gates.onGateEmitted(notify));
			// Gate subscriptions may replay synchronously into a disposing listener.
			this.#assertSession();
		} catch (error) {
			for (const unsubscribe of unsubscribers) unsubscribe();
			throw error;
		}
		const unsubscribe = () => {
			this.#subscriptions.delete(unsubscribe);
			for (const dispose of unsubscribers.splice(0)) dispose();
		};
		this.#subscriptions.add(unsubscribe);
		return unsubscribe;
	}

	/** Detach this adapter only; the factory/session owns the shared SDK view. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#references.clear();
		this.#gateReferences.clear();
		for (const unsubscribe of this.#subscriptions) unsubscribe();
		for (const unsubscribe of this.#lifecycleUnsubscribers.splice(0)) unsubscribe();
	}
}

export function createDesktopActivityController(
	result: FactoryResult,
	options: DesktopActivityOptions,
): DesktopActivityController {
	return new DesktopActivityController(result, options);
}
