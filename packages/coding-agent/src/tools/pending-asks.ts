import { randomUUID } from "node:crypto";
import { logger } from "@gajae-code/utils";
import type {
	AskAnswerRequest,
	AskAnswerSource,
	AskAnswerSourceResult,
	AskRemoteInteraction,
	AskRemoteReceipt,
	AskSettlement,
	AskSettlementResult,
} from "./index";

export interface PendingAskRequest extends AskAnswerRequest {
	questionId: string;
	id: string;
	sessionId: string;
	answerSchema: Record<string, unknown>;
}

interface PendingAsk {
	request: PendingAskRequest;
	answer(interaction: AskRemoteInteraction): Promise<AskSettlement>;
}
const pending = new Map<string, PendingAsk>();
const active = new Set<{ sessionId: string; shutdown(): void }>();

export interface PendingAskHandle {
	promise: Promise<AskAnswerSourceResult>;
	update(request: AskAnswerRequest): boolean;
	close(): void;
}

function failure(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

function answerSchema(request: AskAnswerRequest): Record<string, unknown> {
	const variants: Record<string, unknown>[] = [
		{
			type: "object",
			additionalProperties: false,
			required: ["kind", "value"],
			properties: {
				kind: { const: "value" },
				value:
					request.interaction === "selector"
						? { type: "string", enum: request.options }
						: { type: "string", pattern: "\\S" },
			},
		},
	];
	const controls = request.controls.filter(control => control.enabled).map(control => control.id);
	if (controls.length)
		variants.push({
			type: "object",
			additionalProperties: false,
			required: ["kind", "controlId"],
			properties: { kind: { const: "control" }, controlId: { enum: controls } },
		});
	return { oneOf: variants };
}

/** Snapshots are read-only; observing does not register or replace an answer source. */
export function listPendingAsks(sessionId: string): PendingAskRequest[] {
	return [...pending.values()]
		.filter(entry => entry.request.sessionId === sessionId)
		.map(entry => structuredClone(entry.request));
}

export async function answerPendingAsk(
	sessionId: string,
	id: string,
	answer: unknown,
): Promise<{
	id: string;
	sessionId: string;
	settlement: AskSettlement;
}> {
	const entry = pending.get(id);
	if (!entry || entry.request.sessionId !== sessionId)
		throw failure("stale_request", "Ask request is no longer pending in this session.");
	if (!answer || typeof answer !== "object" || Array.isArray(answer))
		throw failure("invalid_input", "Expected a typed ask interaction.");
	const value = answer as Record<string, unknown>;
	const valid =
		Object.keys(value).length === 2 &&
		((value.kind === "value" &&
			typeof value.value === "string" &&
			(entry.request.interaction === "selector"
				? entry.request.options.includes(value.value)
				: /\S/u.test(value.value))) ||
			(value.kind === "control" &&
				entry.request.controls.some(control => control.enabled && control.id === value.controlId)));
	if (!valid) throw failure("invalid_input", "Answer does not match the pending request's answerSchema.");
	const settlement = await entry.answer(value as unknown as AskRemoteInteraction);
	return { id, sessionId, settlement };
}

export function closePendingAsks(sessionId: string): void {
	for (const entry of [...active]) if (entry.sessionId === sessionId) entry.shutdown();
}

/** One additional race leg, inside AskTool's existing local/remote receipt lifecycle. */
export function openPendingAsk(
	sessionId: string,
	request: AskAnswerRequest & { questionId: string },
	source: AskAnswerSource | undefined,
	signal: AbortSignal,
	onShutdown?: () => void,
): PendingAskHandle {
	const result = Promise.withResolvers<AskAnswerSourceResult>();
	let sourceController = new AbortController();
	let claimed = false;
	let closed = false;
	let entry: PendingAsk;
	let submittedReceipt: AskRemoteReceipt | undefined;
	let notificationReceipt: AskRemoteReceipt | undefined;
	const owner = {
		sessionId,
		shutdown: () => {
			onShutdown?.();
			close();
			void submittedReceipt?.settle({ kind: "resolve_without_commit", reason: "shutdown" });
			void notificationReceipt?.settle({ kind: "resolve_without_commit", reason: "shutdown" }).catch(error => {
				logger.warn("Ask notification shutdown settlement failed", { sessionId, error: String(error) });
			});
			active.delete(owner);
		},
	};
	active.add(owner);
	const remove = () => pending.delete(entry.request.id);
	const close = () => {
		if (closed) return;
		closed = true;
		remove();
		sourceController.abort();
		signal.removeEventListener("abort", close);
		if (!claimed) result.resolve(undefined);
		if (!submittedReceipt) active.delete(owner);
	};
	const install = (next: AskAnswerRequest) => {
		const snapshot = structuredClone(next);
		entry = {
			request: {
				...snapshot,
				questionId: request.questionId,
				id: randomUUID(),
				sessionId,
				answerSchema: answerSchema(snapshot),
			},
			answer: interaction => {
				claimed = true;
				remove();
				sourceController.abort();
				const completion = Promise.withResolvers<AskSettlement>();
				let settlementResult: AskSettlementResult | undefined;
				const receipt: AskRemoteReceipt = {
					source: "remote",
					interaction,
					settle: async settlement => {
						if (!settlementResult) {
							settlementResult =
								settlement.kind === "commit"
									? { kind: "committed", ack: { status: "failed", reason: "unsupported" } }
									: settlement.kind === "invalid"
										? { kind: "invalid_closed" }
										: { kind: "resolved_without_commit" };
							completion.resolve(settlement);
							active.delete(owner);
						}
						return settlementResult;
					},
				};
				submittedReceipt = receipt;
				result.resolve(receipt);
				return completion.promise;
			},
		};
		pending.set(entry.request.id, entry);
	};
	install(request);
	if (signal.aborted) close();
	else signal.addEventListener("abort", close, { once: true });
	const startSource = (request: AskAnswerRequest) => {
		if (!source || closed) return;
		const controller = sourceController;
		const fallback = (async () =>
			source.awaitAnswerRequest
				? source.awaitAnswerRequest(request, controller.signal)
				: source.awaitAnswer(request.question, request.options, controller.signal))();
		void fallback.then(
			answer => {
				if (claimed || closed || controller !== sourceController) {
					if (answer && typeof answer !== "string")
						void answer.settle({ kind: "resolve_without_commit", reason: "aborted" }).catch(error => {
							logger.warn("Late ask notification receipt settlement failed", {
								sessionId,
								error: String(error),
							});
						});
					return;
				}
				if (answer === undefined) return;
				claimed = true;
				remove();
				if (typeof answer === "string") result.resolve(answer);
				else {
					let settlement: Promise<AskSettlementResult> | undefined;
					notificationReceipt = {
						source: "remote",
						interaction: answer.interaction,
						settle: value => (settlement ??= (async () => answer.settle(value))()),
					};
					result.resolve(notificationReceipt);
				}
			},
			error => {
				if (claimed || closed || controller !== sourceController) return;
				logger.warn("Ask notification answer source failed; public and local answers remain available", {
					sessionId,
					error: error instanceof Error ? error.message : String(error),
				});
			},
		);
	};
	startSource(request);
	return {
		promise: result.promise,
		update: next => {
			if (claimed || closed) return false;
			remove();
			sourceController.abort();
			sourceController = new AbortController();
			install(next);
			startSource(next);
			return true;
		},
		close,
	};
}
