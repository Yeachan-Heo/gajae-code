import * as crypto from "node:crypto";
import { getAgentTerminalOwnerContext } from "@gajae-code/agent-core";
import type { AttemptScopeRef, ImageContent } from "@gajae-code/ai/core";
import { logger } from "@gajae-code/utils";
import {
	AgentSession,
	type PromptOptions,
	type QueuedInputDelivery,
	type QueuedInputQueuePolicy,
	type QueuedInputSubmission,
} from "../session/agent-session";
import { PromptImageUploadStore, retirePromptImageReservation } from "./host/prompt-image-upload";

export interface SessionImagePromptOptions {
	expandPromptTemplates?: boolean;
	preflightSignal?: AbortSignal;
}

export interface SessionImageSubmissionOptions {
	deliverAs: QueuedInputDelivery;
	queuePolicy?: QueuedInputQueuePolicy;
	preflightSignal?: AbortSignal;
}

/** Bounded admission for user-selected canonical bytes, not file/path loading. */
export interface SessionImageInput {
	prompt(text: string, rawImages: readonly ImageContent[], options?: SessionImagePromptOptions): Promise<void>;
	submitUserMessage(
		text: string,
		rawImages: readonly ImageContent[],
		options: SessionImageSubmissionOptions,
	): Promise<QueuedInputSubmission>;
	/** Permanently revoke this controller; accepted work keeps its resource-owned capacity. */
	dispose(): void;
}

const controllers = new WeakMap<AgentSession, BoundSessionImageInput>();

function failure(code: string, message: string): never {
	throw Object.assign(new Error(message), { code });
}

function scopeKey(scope: AttemptScopeRef): string {
	return `${scope.lineage}:${scope.generation}:${scope.attemptId}`;
}

/**
 * One current controller per real session. A confirmed identity transition may
 * bind a successor controller, sharing the same quota; predecessor instances
 * never revive after an A→B→A switch. Manual/session disposal is tombstoned.
 * Raw AgentSession.prompt remains a trusted, unmetered low-level API.
 */
export function createSessionImageInput(session: AgentSession): SessionImageInput {
	if (!(session instanceof AgentSession)) failure("invalid_input", "Image input requires a real AgentSession.");
	const existing = controllers.get(session);
	if (existing && !existing.canRebind) return existing;
	const controller = new BoundSessionImageInput(session);
	controllers.set(session, controller);
	return controller;
}

class BoundSessionImageInput implements SessionImageInput {
	readonly #session: AgentSession;
	readonly #sessionId: string;
	readonly #generation: number;
	readonly #sessionManager: AgentSession["sessionManager"];
	readonly #agent: AgentSession["agent"];
	readonly #owner = crypto.randomUUID();
	readonly #store: PromptImageUploadStore;
	readonly #revocation = new AbortController();
	#closed = false;
	#manualDisposed = false;
	#unregisterDispose: (() => void) | undefined;
	#unregisterTransition: (() => void) | undefined;

	constructor(session: AgentSession) {
		const lifecycle = session.sessionLifecycle;
		if (
			!lifecycle ||
			!Number.isSafeInteger(lifecycle.generation) ||
			typeof lifecycle.transitioning !== "boolean" ||
			typeof lifecycle.disposed !== "boolean"
		)
			failure("resource_gone", "Session lifecycle authority is unavailable.");
		if (lifecycle.disposed) failure("resource_gone", "Image input session is disposed.");
		if (lifecycle.transitioning) failure("busy", "Image input session is transitioning.");
		this.#session = session;
		this.#sessionId = session.sessionId;
		this.#generation = lifecycle.generation;
		this.#sessionManager = session.sessionManager;
		this.#agent = session.agent;
		this.#store = new PromptImageUploadStore(() => {
			const current = session.sessionLifecycle;
			return (
				!this.#closed &&
				current?.disposed === false &&
				!current.transitioning &&
				current.generation === this.#generation &&
				session.sessionId === this.#sessionId &&
				session.sessionManager === this.#sessionManager &&
				session.agent === this.#agent
			);
		}, session);
		this.#unregisterDispose = session.registerToolSessionCleanup(() => this.dispose());
		this.#unregisterTransition = session.registerToolSessionTransitionCleanup(() => {
			const current = session.sessionLifecycle;
			if (current?.disposed) this.dispose();
			else if (
				!current ||
				current.generation !== this.#generation ||
				session.sessionId !== this.#sessionId ||
				session.sessionManager !== this.#sessionManager ||
				session.agent !== this.#agent
			)
				this.#revoke();
			// Catalog-preserving work does not advance the committed generation and
			// must not revoke an otherwise unchanged image-input binding.
		});
	}

	get canRebind(): boolean {
		const lifecycle = this.#session.sessionLifecycle;
		const ready =
			!this.#manualDisposed &&
			lifecycle?.disposed === false &&
			lifecycle.transitioning === false &&
			lifecycle.generation > this.#generation;
		if (ready) {
			// A newer committed checkpoint is the authority, not an ID comparison,
			// cleanup callback, or UI notification. Never reopen this old instance.
			this.#revoke();
			this.#unregisterDispose?.();
		}
		return ready;
	}

	#revoke(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#revocation.abort();
		this.#store.close();
	}

	dispose(): void {
		this.#manualDisposed = true;
		this.#revoke();
		this.#unregisterDispose?.();
		this.#unregisterTransition?.();
		this.#unregisterTransition = undefined;
		this.#unregisterDispose = undefined;
	}

	#guard(): void {
		const lifecycle = this.#session.sessionLifecycle;
		if (
			this.#closed ||
			!lifecycle ||
			lifecycle.disposed ||
			this.#session.sessionId !== this.#sessionId ||
			lifecycle.generation !== this.#generation ||
			this.#session.sessionManager !== this.#sessionManager ||
			this.#session.agent !== this.#agent
		) {
			// Identity mismatch revokes immediately, but is not evidence that a
			// transition has completed or that a successor can yet be bound.
			this.#revoke();
			failure("resource_gone", "Image input session has been revoked.");
		}
		if (lifecycle.transitioning) failure("busy", "Image input session is transitioning.");
		if (this.#session.settings.get("images.blockImages"))
			failure("operation_prohibited", "Image input is blocked by session settings.");
		if (!this.#session.model?.input.includes("image"))
			failure("invalid_input", "The current model does not support image input.");
	}

	async #prepare(
		rawImages: readonly ImageContent[],
		signal?: AbortSignal,
	): Promise<{ images: ImageContent[]; release: () => void; guard: () => void }> {
		this.#guard();
		const model = this.#session.model;
		const autoResize = this.#session.settings.get("images.autoResize");
		const combinedSignal = signal ? AbortSignal.any([signal, this.#revocation.signal]) : this.#revocation.signal;
		combinedSignal.throwIfAborted();
		// This method stages/reserves the entire encoded/source batch synchronously
		// before its first await; normalization occurs inside the shared store.
		const prepared = await this.#store.prepareCanonicalImages(this.#owner, rawImages, {
			autoResize,
			signal: combinedSignal,
		});
		const guard = (): void => {
			this.#guard();
			combinedSignal.throwIfAborted();
			if (this.#session.model !== model || this.#session.settings.get("images.autoResize") !== autoResize)
				failure("busy", "Image input model or normalization settings changed during preparation.");
		};
		try {
			guard();
			return { ...prepared, guard };
		} catch (error) {
			prepared.release();
			throw error;
		}
	}

	async prompt(
		text: string,
		rawImages: readonly ImageContent[],
		options: SessionImagePromptOptions = {},
	): Promise<void> {
		if (typeof text !== "string") failure("invalid_input", "Prompt text must be a string.");
		this.#guard();
		if (this.#session.isStreaming || this.#session.hasPostPromptWork)
			failure("busy", "Use submitUserMessage for queued image input.");
		const reservation = await this.#prepare(rawImages, options.preflightSignal);
		let accepted = false;
		let handle: string | undefined;
		let terminal = false;
		let settled = false;
		let retired = false;
		const retire = (): void => {
			if (retired || !settled || !terminal || !handle) return;
			retired = true;
			unsubscribe();
			retirePromptImageReservation(
				handle,
				id => this.#agent.resourceLedger.waitForSettlement(id, { graceMs: null }),
				() => true,
				reservation.release,
			);
		};
		// Capture identity from a synchronous, scoped core event, never by sampling
		// an arbitrary current run after an await or after the prompt returns.
		const unsubscribe = this.#agent.subscribe(event => {
			if (!accepted) return;
			if (!settled && !handle && event.type === "agent_start" && event.scope)
				handle = this.#agent.activeResourceRunId;
			if (event.type === "agent_end" && handle && getAgentTerminalOwnerContext(event)?.resourceRunId === handle) {
				terminal = true;
				retire();
			}
		});
		try {
			reservation.guard();
			if (this.#session.isStreaming || this.#session.hasPostPromptWork)
				failure("busy", "Use submitUserMessage for queued image input.");
			const promptOptions: PromptOptions = {
				images: reservation.images,
				expandPromptTemplates: options.expandPromptTemplates,
				preflightSignal: options.preflightSignal,
				// AgentSession invokes the durable commit callback INSTEAD OF the
				// legacy accepted callback when both are supplied. Admission must be
				// recorded at that real fence, before any core execution can start.
				onPreflightAcceptCommit: () => {
					reservation.guard();
					accepted = true;
				},
			};
			await this.#session.prompt(text, promptOptions);
		} finally {
			settled = true;
			if (!accepted) {
				unsubscribe();
				reservation.release();
			} else {
				retire();
				if (!handle) {
					unsubscribe();
					logger.warn("SDK image capacity retained without exact prompt terminal/resource identity");
				}
				// A known run may publish its terminal later. Keep observing that exact
				// identity; disposal/abort/prompt settlement alone cannot release it.
			}
		}
	}

	async submitUserMessage(
		text: string,
		rawImages: readonly ImageContent[],
		options: SessionImageSubmissionOptions,
	): Promise<QueuedInputSubmission> {
		if (
			typeof text !== "string" ||
			!options ||
			!["steer", "followUp"].includes(options.deliverAs) ||
			(options.queuePolicy !== undefined && !["respect-mode", "sequential"].includes(options.queuePolicy))
		)
			failure("invalid_input", "Queued image input requires text and deliverAs: steer or followUp.");
		const reservation = await this.#prepare(rawImages, options.preflightSignal);
		let executionStarted = false;
		const terminalHandles = new Map<string, string>();
		const unsubscribe = this.#agent.subscribe(event => {
			if (event.type !== "agent_end" || !event.scope) return;
			const owner = getAgentTerminalOwnerContext(event);
			if (owner) {
				terminalHandles.set(scopeKey(event.scope), owner.resourceRunId);
				// Eviction loses reclamation proof, never permits an unrelated release.
				if (terminalHandles.size > 256) terminalHandles.delete(terminalHandles.keys().next().value!);
			}
		});
		try {
			reservation.guard();
			const submission = await this.#session.submitUserMessage([{ type: "text", text }, ...reservation.images], {
				deliverAs: options.deliverAs,
				queuePolicy: options.queuePolicy,
				trackSubmission: true,
				preflightSignal: options.preflightSignal,
				onPreflightAcceptCommit: reservation.guard,
				onQueuedPromoted: promotion => {
					if (!promotion.removed) executionStarted = true;
				},
			});
			// Return the real session receipt unchanged. Cancellation authority remains
			// limited to its exact queued submission, never to reservation release.
			void submission.terminal
				.then(async terminal => {
					const execution = await submission.execution;
					unsubscribe();
					if (terminal.disposition === "removed" && execution.disposition === "removed") {
						reservation.release();
						return;
					}
					const handle =
						terminal.disposition === "completed"
							? terminalHandles.get(scopeKey(terminal.attemptScope))
							: undefined;
					terminalHandles.clear();
					if (!handle) {
						logger.warn("SDK queued image capacity retained without exact terminal/resource identity");
						return;
					}
					retirePromptImageReservation(
						handle,
						id => this.#agent.resourceLedger.waitForSettlement(id, { graceMs: null }),
						() => true,
						reservation.release,
					);
				})
				.catch(error => {
					unsubscribe();
					logger.warn("SDK queued image lifecycle observation failed; capacity retained", { error });
				});
			return submission;
		} catch (error) {
			unsubscribe();
			if (!executionStarted) reservation.release();
			else logger.warn("SDK queued image dispatch failed after execution; capacity retained");
			throw error;
		}
	}
}
