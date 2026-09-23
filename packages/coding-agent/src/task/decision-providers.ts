import type { AuthStorage } from "@gajae-code/ai/core";
import decisionPrompt from "../prompts/task-decision.md" with { type: "text" };
import { type KevServiceChannel, resolveKevServiceChannel } from "../setup/kev-setup";
import { controlInferRequest, type KevControlReply, kevControl } from "../setup/kev-supervisor";
import {
	DECISION_TIERS,
	type DecisionErrorCode,
	type DecisionOutcome,
	type DecisionProvider,
	type DecisionProviderConfig,
	type DecisionRequest,
	normalizeDecisionRequest,
	validateDecisionResultDetailed,
} from "./decision-model";

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
type DecisionAuthStorage = Pick<AuthStorage, "getApiKey">;
type DecisionFetch = (url: string, init: RequestInit) => Promise<Response>;
type ProviderOptions = DecisionProviderConfig & {
	readonly fetchFn?: DecisionFetch;
	readonly authStorage?: DecisionAuthStorage;
	readonly endpoint: string;
	readonly model: string;
};
export type DecisionProviderOptions = ProviderOptions;
type KevControlFn = (socketPath: string, message: string, timeoutMs: number) => Promise<KevControlReply | undefined>;
export type KevDecisionProviderOptions = {
	readonly model?: string;
	readonly timeoutMs?: number;
	/** Kev installation root; defaults to the remembered one. */
	readonly root?: string;
	readonly resolveChannel?: (root?: string) => Promise<KevServiceChannel | undefined>;
	readonly control?: KevControlFn;
};
export type JevDecisionProviderOptions = {
	readonly timeoutMs?: number;
	readonly credentialSessionId?: string;
	readonly fetchFn?: DecisionFetch;
	readonly authStorage: DecisionAuthStorage;
};

const failure = (code: DecisionErrorCode): DecisionOutcome => ({ error: { code } });
function boundedTimeout(value: unknown): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 60_000
		? value
		: DEFAULT_TIMEOUT_MS;
}
interface DeadlineLease {
	signal: AbortSignal;
	deadline: number;
	expired: Promise<never>;
	dispose(): void;
}
function createLease(timeoutMs: number, parent?: AbortSignal): DeadlineLease {
	const controller = new AbortController();
	const deadline = performance.now() + timeoutMs;
	const stopped = Promise.withResolvers<never>();
	const stop = (reason: "timeout" | "aborted") => {
		controller.abort();
		stopped.reject(new Error(reason));
	};
	const timer = setTimeout(() => stop("timeout"), timeoutMs);
	const abort = () => stop("aborted");
	if (parent?.aborted) abort();
	else parent?.addEventListener("abort", abort, { once: true });
	void stopped.promise.catch(() => undefined);
	return {
		signal: controller.signal,
		deadline,
		expired: stopped.promise,
		dispose: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", abort);
		},
	};
}
async function raceDeadline<T>(operation: Promise<T>, lease: DeadlineLease): Promise<T> {
	return await Promise.race([operation, lease.expired]);
}
async function cancelReader(reader: { cancel(): Promise<void> }): Promise<void> {
	try {
		await reader.cancel();
	} catch {
		/* cancellation is best effort */
	}
}
async function readBody(response: Response, lease: DeadlineLease): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			if (lease.signal.aborted || performance.now() >= lease.deadline) throw new Error("timeout");
			const part = await raceDeadline(reader.read(), lease);
			if (part.done) break;
			total += part.value.byteLength;
			if (total > MAX_BODY_BYTES) throw new Error("response_too_large");
			chunks.push(part.value);
		}
		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return new TextDecoder().decode(bytes);
	} catch (error) {
		void cancelReader(reader);
		throw error;
	}
}
function validBearer(key: string): boolean {
	return key.length > 0 && !/[\u0000-\u001f\u007f\s]/u.test(key);
}
function makeBody(request: DecisionRequest, model: string): Record<string, unknown> {
	return {
		state: { role: request.role, assignment: request.assignment },
		model,
		questions: {
			route: {
				type: "choice",
				instructions: decisionPrompt,
				criteria: Object.fromEntries(
					DECISION_TIERS.filter(t => request.candidates[t] !== undefined).map(t => [t, request.candidates[t]]),
				),
			},
		},
	};
}

function httpFailure(status: number): DecisionOutcome {
	if (status === 401) return failure("auth_401");
	if (status === 403) return failure("auth_403");
	return failure("http_error");
}

/** Shared System One envelope handling; identical whichever transport carried it. */
function interpretEnvelope(text: string, request: DecisionRequest): DecisionOutcome {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return failure("invalid_json");
	}
	const envelope = parsed as { model?: unknown; answers?: { route?: unknown } } | null;
	if (!envelope?.answers || !Object.hasOwn(envelope.answers, "route")) return failure("invalid_response");
	const checked = validateDecisionResultDetailed(envelope.answers.route, request.candidates);
	if (checked.error) return failure(checked.error);
	if (!checked.result) return failure("invalid_response");
	return {
		result:
			typeof envelope.model === "string"
				? { ...checked.result, reportedModel: envelope.model.slice(0, 256) }
				: checked.result,
	};
}

async function decide(
	input: DecisionRequest,
	options: ProviderOptions,
	keyFn: (signal: AbortSignal) => Promise<string | undefined>,
	parentSignal?: AbortSignal,
): Promise<DecisionOutcome> {
	const current = createLease(boundedTimeout(options.timeoutMs), parentSignal);
	let response: Response | undefined;
	try {
		if (parentSignal?.aborted) return failure("aborted");
		const request = normalizeDecisionRequest(input);
		if (DECISION_TIERS.every(t => request.candidates[t] === undefined)) return failure("invalid_candidate");
		if (performance.now() >= current.deadline) return failure("timeout");
		const key = await raceDeadline(keyFn(current.signal), current);
		if (current.signal.aborted || performance.now() >= current.deadline)
			return failure(parentSignal?.aborted ? "aborted" : "timeout");
		if (options.authStorage && !key) return failure("credential_unavailable");
		if (options.authStorage && !validBearer(key!)) return failure("credential_unavailable");
		const pendingResponse = (options.fetchFn ?? fetch)(options.endpoint, {
			method: "POST",
			redirect: "error",
			headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
			body: JSON.stringify(makeBody(request, options.model)),
			signal: current.signal,
		});
		void pendingResponse.then(
			lateResponse => {
				if (current.signal.aborted || performance.now() >= current.deadline) {
					void lateResponse.body?.cancel().catch(() => undefined);
				}
			},
			() => undefined,
		);
		response = await raceDeadline(pendingResponse, current);
		if (current.signal.aborted || performance.now() >= current.deadline)
			return failure(parentSignal?.aborted ? "aborted" : "timeout");
		if (!response.ok) {
			void response.body?.cancel().catch(() => undefined);
			return httpFailure(response.status);
		}
		const text = await readBody(response, current);
		if (performance.now() >= current.deadline) return failure("timeout");
		const interpreted = interpretEnvelope(text, request);
		if (performance.now() >= current.deadline) return failure("timeout");
		return interpreted;
	} catch (cause) {
		if (cause instanceof Error && cause.message === "response_too_large") return failure("response_too_large");
		if (cause instanceof Error && (cause.message === "timeout" || current.signal.aborted))
			return failure(parentSignal?.aborted ? "aborted" : "timeout");
		if (cause instanceof Error && cause.message === "aborted") return failure("aborted");
		return failure("transport_error");
	} finally {
		current.dispose();
		if (response && !response.bodyUsed) void response.body?.cancel().catch(() => undefined);
	}
}

/**
 * The local decision provider.
 *
 * It never posts task text to a loopback URL. A port number proves nothing about
 * who is listening on it, so inference is carried over the owned supervisor's
 * authenticated Unix socket, and the supervisor forwards it to the one process
 * it started. With no provable owned service there is no destination, and
 * nothing is sent.
 */
export class KevDecisionProvider implements DecisionProvider {
	readonly #model: string;
	readonly #timeoutMs: number;
	readonly #root?: string;
	readonly #resolveChannel: (root?: string) => Promise<KevServiceChannel | undefined>;
	readonly #control: KevControlFn;
	constructor(options: KevDecisionProviderOptions = {}) {
		this.#model = options.model ?? "kev-latest";
		this.#timeoutMs = boundedTimeout(options.timeoutMs);
		this.#root = options.root;
		this.#resolveChannel = options.resolveChannel ?? (root => resolveKevServiceChannel({ root }));
		this.#control = options.control ?? kevControl;
	}
	async decide(request: DecisionRequest, options?: { signal?: AbortSignal }): Promise<DecisionOutcome> {
		const current = createLease(this.#timeoutMs, options?.signal);
		try {
			if (options?.signal?.aborted) return failure("aborted");
			const normalized = normalizeDecisionRequest(request);
			if (DECISION_TIERS.every(tier => normalized.candidates[tier] === undefined))
				return failure("invalid_candidate");
			const channel = await raceDeadline(this.#resolveChannel(this.#root), current);
			if (!channel) return failure("unavailable");
			if (current.signal.aborted || performance.now() >= current.deadline)
				return failure(options?.signal?.aborted ? "aborted" : "timeout");
			const body = JSON.stringify(makeBody(normalized, this.#model));
			const reply = await raceDeadline(
				this.#control(channel.socket, controlInferRequest(channel.token, body), this.#timeoutMs),
				current,
			);
			if (performance.now() >= current.deadline) return failure("timeout");
			if (!reply) return failure("transport_error");
			if (!reply.ok) return failure(reply.error === "response_too_large" ? "response_too_large" : "unavailable");
			if (reply.status === undefined || reply.body === undefined) return failure("invalid_response");
			if (reply.status < 200 || reply.status >= 300) return httpFailure(reply.status);
			return interpretEnvelope(reply.body, normalized);
		} catch (cause) {
			if (cause instanceof Error && cause.message === "aborted") return failure("aborted");
			if (cause instanceof Error && (cause.message === "timeout" || current.signal.aborted))
				return failure(options?.signal?.aborted ? "aborted" : "timeout");
			return failure("transport_error");
		} finally {
			current.dispose();
		}
	}
}
export class JevDecisionProvider implements DecisionProvider {
	readonly #options: ProviderOptions;
	constructor(options: JevDecisionProviderOptions) {
		this.#options = {
			endpoint: "https://api.typesafe.ai/v1/systemone",
			model: "jev-latest",
			timeoutMs: boundedTimeout(options.timeoutMs),
			credentialSessionId: options.credentialSessionId,
			authStorage: options.authStorage,
			fetchFn: options.fetchFn,
		};
	}
	decide(request: DecisionRequest, options?: { signal?: AbortSignal }): Promise<DecisionOutcome> {
		return decide(
			request,
			this.#options,
			signal => this.#options.authStorage!.getApiKey("typesafe", this.#options.credentialSessionId, { signal }),
			options?.signal,
		);
	}
}
