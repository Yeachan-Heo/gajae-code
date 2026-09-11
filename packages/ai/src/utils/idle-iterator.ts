import { $env } from "@gajae-code/utils";
import { STREAM_FIRST_EVENT_TIMEOUT_PROVIDER_CODE } from "./fallback-transport";

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_STREAM_FIRST_EVENT_TIMEOUT_MS = 100_000;
const ALIBABA_TOKEN_PLAN_FIRST_EVENT_TIMEOUT_MS = 600_000;
const KIMI_CODE_FIRST_EVENT_TIMEOUT_MS = 300_000;
// Local LM Studio models can spend several minutes loading weights and filling
// the prompt before emitting their first SSE event. Keep the shared default
// for other OpenAI-compatible providers, but avoid aborting legitimate local
// inference during that startup window.
const LM_STUDIO_FIRST_EVENT_TIMEOUT_MS = 300_000;
// Ollama Cloud is a hosted proxy where queueing/cold-start plus long prefill
// (thinking-mode requests over 1M-context sessions) routinely exceeds 120s before
// the first streamed token; 300s matches kimi-code's floor for long-reasoning silence.
const OLLAMA_CLOUD_FIRST_EVENT_TIMEOUT_MS = 300_000;

const ANTHROPIC_STREAM_IDLE_TIMEOUT_MS = 300_000;

export function getProviderStreamIdleTimeoutFallbackMs(provider: string): number | undefined {
	if (provider === "anthropic" || provider === "xai" || provider === "grok-build") {
		return ANTHROPIC_STREAM_IDLE_TIMEOUT_MS;
	}
	return undefined;
}

// Grok models behind OpenAI-compatible hosts keep the model id (or an
// `x-ai/`-prefixed OpenRouter id) even when `provider` is openrouter, kilo,
// litellm, zenmux, venice, and similar. The long-reasoning silence that
// motivates the 300s floor is a property of the model, not the account
// used to reach it, so the floor keys on the model when the provider alone
// does not already grant it (#4797).
const GROK_MODEL_ID_PATTERN = /(?:^|[/._-])grok(?:[/._-]|$)/i;

export function isGrokModelId(modelId: string | undefined): boolean {
	if (!modelId) return false;
	return GROK_MODEL_ID_PATTERN.test(modelId);
}

export function getProviderFirstEventTimeoutFallbackMs(provider: string): number | undefined {
	if (provider === "alibaba-token-plan") return ALIBABA_TOKEN_PLAN_FIRST_EVENT_TIMEOUT_MS;
	if (provider === "lm-studio") return LM_STUDIO_FIRST_EVENT_TIMEOUT_MS;
	if (provider === "ollama-cloud") return OLLAMA_CLOUD_FIRST_EVENT_TIMEOUT_MS;
	return provider === "kimi-code" ? KIMI_CODE_FIRST_EVENT_TIMEOUT_MS : undefined;
}

function normalizeIdleTimeoutMs(value: string | undefined, fallback: number): number | undefined {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	if (parsed <= 0) return undefined;
	return Math.trunc(parsed);
}

/**
 * Returns the idle timeout used for provider streaming transports.
 *
 * `GJC_OPENAI_STREAM_IDLE_TIMEOUT_MS` is honored first; `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS` is a backward-compatible alias.
 * Set `PI_STREAM_IDLE_TIMEOUT_MS=0` to disable the watchdog.
 *
 * Providers that legitimately stream much slower than the global default can pass
 * `fallbackMs` to widen the floor used when neither env var nor caller option is set.
 * Caller options still take precedence; env overrides still trump the fallback.
 */
export function getStreamIdleTimeoutMs(fallbackMs: number = DEFAULT_STREAM_IDLE_TIMEOUT_MS): number | undefined {
	return normalizeIdleTimeoutMs(
		$env.GJC_OPENAI_STREAM_IDLE_TIMEOUT_MS ?? $env.PI_STREAM_IDLE_TIMEOUT_MS ?? $env.PI_OPENAI_STREAM_IDLE_TIMEOUT_MS,
		fallbackMs,
	);
}

/**
 * Returns the idle timeout used for OpenAI-family streaming transports.
 *
 * Honors `GJC_OPENAI_STREAM_IDLE_TIMEOUT_MS` first (`PI_OPENAI_STREAM_IDLE_TIMEOUT_MS` is the legacy alias). Set `=0` to disable.
 * When `provider` is given, long-reasoning hosts (xAI Grok and Grok Build) use that floor instead of the 120s default.
 * Grok models reached through other OpenAI-compatible hosts (`openrouter/x-ai/grok-*`, kilo, litellm, …) get the
 * same floor keyed on the model id, because long-reasoning silence is a property of the model (#4797).
 */
export function getOpenAIStreamIdleTimeoutMs(provider?: string, modelId?: string): number | undefined {
	return normalizeIdleTimeoutMs(
		$env.GJC_OPENAI_STREAM_IDLE_TIMEOUT_MS ?? $env.PI_STREAM_IDLE_TIMEOUT_MS ?? $env.PI_OPENAI_STREAM_IDLE_TIMEOUT_MS,
		getProviderStreamIdleTimeoutFallbackMs(provider ?? "") ??
			(isGrokModelId(modelId) ? ANTHROPIC_STREAM_IDLE_TIMEOUT_MS : undefined) ??
			DEFAULT_STREAM_IDLE_TIMEOUT_MS,
	);
}

/**
 * Returns the timeout used while waiting for the first stream event.
 * The first token can legitimately take longer than later inter-event gaps,
 * so the default never undershoots the steady-state idle timeout.
 *
 * Set `PI_STREAM_FIRST_EVENT_TIMEOUT_MS=0` to disable the watchdog.
 *
 * Providers whose first response can legitimately take longer (heavy reasoning,
 * slow cold-start proxies) can pass `fallbackMs` to widen the floor used when
 * neither env var nor caller option is set. Caller options still take precedence;
 * env overrides still trump the fallback.
 */
export function getStreamFirstEventTimeoutMs(
	idleTimeoutMs?: number,
	fallbackMs: number = DEFAULT_STREAM_FIRST_EVENT_TIMEOUT_MS,
): number | undefined {
	const fallback = idleTimeoutMs === undefined ? fallbackMs : Math.max(fallbackMs, idleTimeoutMs);
	return normalizeIdleTimeoutMs($env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS, fallback);
}

/**
 * Resolves the OpenAI SDK client `timeout` so stalled-before-headers requests are
 * bounded by the same first-event window the transport watchdog uses after
 * `create()` returns. Without this, providers that only arm
 * `iterateWithIdleTimeout` post-setup can wait the full SDK default (10 minutes
 * per attempt) before any provider-owned watchdog exists.
 *
 * - Explicit `0` disables the request timeout (the SDK treats `timeout: 0` as an
 *   immediate failure, so callers that disable the first-event watchdog must not
 *   pass a timeout).
 * - Providers with a first-event fallback (Alibaba, Kimi) honor an explicit
 *   nonzero override as-is, even when shorter than the fallback.
 * - Other providers floor an explicit override at the env/default first-event
 *   window so a short post-connect first-event budget cannot kill legitimate
 *   slow setup.
 */
export function resolveOpenAISdkRequestTimeoutMs(
	provider: string,
	streamFirstEventTimeoutOverride?: number,
	modelId?: string,
): number | undefined {
	const providerFirstEventFallbackMs = getProviderFirstEventTimeoutFallbackMs(provider);
	const envSdkTimeoutMs = getStreamFirstEventTimeoutMs(
		getOpenAIStreamIdleTimeoutMs(provider, modelId),
		providerFirstEventFallbackMs,
	);
	if (streamFirstEventTimeoutOverride === 0) return undefined;
	if (streamFirstEventTimeoutOverride !== undefined) {
		return providerFirstEventFallbackMs !== undefined
			? streamFirstEventTimeoutOverride
			: Math.max(envSdkTimeoutMs ?? 0, streamFirstEventTimeoutOverride);
	}
	return envSdkTimeoutMs;
}

/**
 * Resolves the Anthropic SDK client `timeout` so stalled-before-headers requests
 * are bounded. The Anthropic first-event watchdog deliberately arms only once
 * response headers have arrived (setup latency must not consume the first-event
 * budget), which left the connect/headers phase governed solely by the SDK
 * default of 10 minutes per attempt — multiplied by SDK-internal retries, a
 * connection that silently died right after a completed tool call could spin
 * with no user-visible error for the better part of an hour.
 *
 * - Explicit `0` disables the request timeout, matching a disabled first-event
 *   watchdog.
 * - An explicit nonzero override is floored at the env/default first-event
 *   window (which itself never undershoots the provider idle window) so a short
 *   post-connect first-event budget cannot kill legitimate slow setup.
 */
export function resolveAnthropicSdkRequestTimeoutMs(
	provider: string,
	streamFirstEventTimeoutOverride?: number,
	streamIdleTimeoutOverride?: number,
): number | undefined {
	const idleTimeoutMs =
		streamIdleTimeoutOverride ?? getStreamIdleTimeoutMs(getProviderStreamIdleTimeoutFallbackMs(provider));
	const envSdkTimeoutMs = getStreamFirstEventTimeoutMs(
		idleTimeoutMs,
		getProviderFirstEventTimeoutFallbackMs(provider),
	);
	if (streamFirstEventTimeoutOverride === 0) return undefined;
	if (streamFirstEventTimeoutOverride !== undefined) {
		return Math.max(envSdkTimeoutMs ?? 0, streamFirstEventTimeoutOverride);
	}
	return envSdkTimeoutMs;
}

export type Watchdog = NodeJS.Timeout | undefined;
export interface FirstEventTimeoutFacts {
	requestBytes?: number;
	firstEventElapsedMs?: number;
	firstEventTimeoutMs?: number;
	endpointClass?: "canonical" | "custom";
	retryMaxAttempts?: number;
}

export class FirstEventTimeoutError extends Error {
	readonly providerCode = STREAM_FIRST_EVENT_TIMEOUT_PROVIDER_CODE;
	readonly requestBytes?: number;
	readonly firstEventElapsedMs?: number;
	readonly firstEventTimeoutMs?: number;
	readonly endpointClass?: "canonical" | "custom";
	readonly retryMaxAttempts?: number;

	constructor(message: string, facts: FirstEventTimeoutFacts = {}) {
		super(message);
		this.name = "FirstEventTimeoutError";
		this.requestBytes = facts.requestBytes;
		this.firstEventElapsedMs = facts.firstEventElapsedMs;
		this.firstEventTimeoutMs = facts.firstEventTimeoutMs;
		this.endpointClass = facts.endpointClass;
		this.retryMaxAttempts = facts.retryMaxAttempts;
	}
}

const dummyWatchdog = setTimeout(() => {}, 1);
clearTimeout(dummyWatchdog);

/**
 * Starts a watchdog that aborts a request if no first stream event arrives in time.
 * Call `markFirstEventReceived()` as soon as the first event is observed.
 */
export function createWatchdog(timeoutMs: number | undefined, onTimeout: () => void): Watchdog {
	if (timeoutMs !== undefined && timeoutMs > 0) {
		return setTimeout(onTimeout, timeoutMs);
	}
	return undefined;
}

export interface IdleTimeoutIteratorOptions {
	watchdog?: Watchdog;
	idleTimeoutMs?: number;
	firstItemTimeoutMs?: number;
	errorMessage: string;
	firstItemErrorMessage?: string;
	onIdle?: () => void;
	onFirstItemTimeout?: () => void;
	/**
	 * Optional semantic-progress predicate. Non-progress items are still yielded,
	 * but they do not reset the idle deadline. This prevents provider
	 * keepalive/no-op events from keeping a stalled tool call alive forever.
	 */
	isProgressItem?: (item: unknown) => boolean;
	/**
	 * Cancel iteration as soon as this signal aborts. Required for caller-driven
	 * cancellation (ESC) when the underlying transport does not surface signal
	 * aborts to the iterator (HTTP/2 proxies, native sockets, mocked fetch).
	 * Without this, the consumer sleeps on iterator.next() until the idle/first
	 * -event watchdog fires — observable as the issue #912 "Working… forever"
	 * symptom on the github-copilot provider.
	 */
	abortSignal?: AbortSignal;
}

/**
 * Yields items from an async iterable while enforcing a maximum idle gap between items.
 *
 * The first item may use a shorter timeout so stuck requests can be aborted and retried
 * before any user-visible content has streamed.
 */
export async function* iterateWithIdleTimeout<T>(
	iterable: AsyncIterable<T>,
	options: IdleTimeoutIteratorOptions,
): AsyncGenerator<T> {
	let watchdog = options.watchdog;
	const firstItemTimeoutMs = options.firstItemTimeoutMs ?? options.idleTimeoutMs;
	const abortSignal = options.abortSignal;
	const iterator = iterable[Symbol.asyncIterator]();
	let naturallyExhausted = false;
	let iteratorClosed = false;

	const closeIterator = (): void => {
		if (iteratorClosed) return;
		iteratorClosed = true;
		try {
			const returnPromise = iterator.return?.();
			if (returnPromise) {
				void returnPromise.catch(() => {});
			}
		} catch {
			// Cleanup must not replace the source error or timeout that triggered it.
		}
	};

	if (abortSignal?.aborted) {
		closeIterator();
		throw abortReason(abortSignal);
	}

	const withRacy = <T>(promise: Promise<T>) =>
		promise.then(
			result => ({ kind: "next" as const, result }),
			error => ({ kind: "error" as const, error }),
		);

	let awaitingFirstItem = true;
	const markFirstItemReceived = () => {
		watchdog && clearTimeout(watchdog);
		watchdog = undefined;
		awaitingFirstItem = false;
	};
	const isProgressItem = (item: T): boolean => {
		if (!options.isProgressItem) return true;
		try {
			return options.isProgressItem(item);
		} catch {
			return true;
		}
	};
	let lastProgressAt = Date.now();
	const firstItemDeadlineAt =
		firstItemTimeoutMs !== undefined && firstItemTimeoutMs > 0 ? Date.now() + firstItemTimeoutMs : undefined;

	const noTimeoutEnforced =
		(firstItemTimeoutMs === undefined || firstItemTimeoutMs <= 0) &&
		(options.idleTimeoutMs === undefined || options.idleTimeoutMs <= 0);

	try {
		while (true) {
			let activeTimeoutMs: number | undefined;
			if (awaitingFirstItem) {
				activeTimeoutMs =
					firstItemDeadlineAt === undefined ? undefined : Math.max(0, firstItemDeadlineAt - Date.now());
			} else if (options.idleTimeoutMs !== undefined && options.idleTimeoutMs > 0) {
				activeTimeoutMs = options.idleTimeoutMs - (Date.now() - lastProgressAt);
				// The idle deadline may already have elapsed because the *consumer*
				// was slow, not because the provider stalled — and the next item may
				// already be buffered and ready to deliver. Clamp to 0 instead of
				// throwing eagerly so the next() race below still gets a chance to
				// win (it settles on a microtask, ahead of the 0ms timer). Only a
				// genuinely hung iterator loses that race and surfaces as a stall.
				if (activeTimeoutMs < 0) {
					activeTimeoutMs = 0;
				}
			}

			const racers: Array<
				Promise<
					| { kind: "next"; result: IteratorResult<T> }
					| { kind: "error"; error: unknown }
					| { kind: "timeout" }
					| { kind: "abort" }
				>
			> = [];

			let timer: NodeJS.Timeout | undefined;
			let resolveTimeout: ((value: { kind: "timeout" }) => void) | undefined;
			const enforceTimeout = !noTimeoutEnforced && activeTimeoutMs !== undefined && activeTimeoutMs >= 0;
			if (enforceTimeout) {
				const { promise, resolve } = Promise.withResolvers<{ kind: "timeout" }>();
				resolveTimeout = resolve;
				timer = setTimeout(() => resolve({ kind: "timeout" }), activeTimeoutMs);
				racers.push(promise);
			}

			let abortListener: (() => void) | undefined;
			let resolveAbort: ((value: { kind: "abort" }) => void) | undefined;
			if (abortSignal) {
				const { promise, resolve } = Promise.withResolvers<{ kind: "abort" }>();
				resolveAbort = resolve;
				abortListener = () => resolve({ kind: "abort" });
				abortSignal.addEventListener("abort", abortListener, { once: true });
				racers.push(promise);
			}

			// Arm timeout/abort races before asking the source for its next item. A
			// periodic keepalive iterator commonly registers its own timer inside
			// `next()`; registering that first lets equal-deadline keepalives win every
			// race and extend the idle window forever. Already-buffered items still
			// settle as microtasks before a 0ms watchdog.
			racers.unshift(withRacy(iterator.next()));

			try {
				const outcome = await Promise.race(racers);
				if (outcome.kind === "abort") {
					closeIterator();
					throw abortReason(abortSignal!);
				}
				if (outcome.kind === "timeout") {
					if (!awaitingFirstItem) {
						options.onIdle?.();
					} else {
						options.onFirstItemTimeout?.();
					}
					closeIterator();
					throw awaitingFirstItem
						? new FirstEventTimeoutError(options.firstItemErrorMessage ?? options.errorMessage)
						: new Error(options.errorMessage);
				}
				if (outcome.kind === "error") {
					throw outcome.error;
				}
				if (awaitingFirstItem && firstItemDeadlineAt !== undefined && Date.now() >= firstItemDeadlineAt) {
					options.onFirstItemTimeout?.();
					closeIterator();
					throw new FirstEventTimeoutError(options.firstItemErrorMessage ?? options.errorMessage);
				}
				if (outcome.result.done) {
					naturallyExhausted = true;
					markFirstItemReceived();
					return;
				}
				const item = outcome.result.value;
				// Non-progress items (e.g. provider keepalives, synthetic `start` events that
				// arrive before the model has produced any tokens) MUST NOT flip us out of
				// `awaitingFirstItem`. Otherwise the next iteration switches from the (longer)
				// first-item watchdog to the (shorter) idle watchdog while we're still waiting
				// on the model's first real output.
				if (isProgressItem(item)) {
					markFirstItemReceived();
					lastProgressAt = Date.now();
				}
				yield item;
			} finally {
				if (timer !== undefined) clearTimeout(timer);
				// Resolve dangling promises so the racers don't leak (Promise.race is one-shot).
				resolveTimeout?.({ kind: "timeout" });
				if (abortListener && abortSignal) {
					abortSignal.removeEventListener("abort", abortListener);
				}
				resolveAbort?.({ kind: "abort" });
			}
		}
	} finally {
		if (!naturallyExhausted) closeIterator();
	}
}

function abortReason(signal: AbortSignal): Error {
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	if (typeof reason === "string") return new Error(reason);
	return new Error("Request was aborted");
}
