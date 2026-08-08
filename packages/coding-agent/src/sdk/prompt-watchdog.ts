import { TOOL_TIMEOUTS } from "../tools/tool-timeouts";
import { HEARTBEAT_TTL_MS } from "./bus/daemon-paths";

/** Ceiling a caller may *request* for one tool call; `bash`/`ssh` cap out at 3600s. */
const MAX_TOOL_RUNTIME_MS = Math.max(...Object.values(TOOL_TIMEOUTS).map(config => config.max)) * 1_000;

/** Budget one tool call gets when nobody asks to extend it; `bash` defaults to 300s. */
const DEFAULT_TOOL_RUNTIME_MS = Math.max(...Object.values(TOOL_TIMEOUTS).map(config => config.default)) * 1_000;

/**
 * Frame-free cost of one transport round trip while the producer is still healthy:
 * the owner heartbeat has to lapse ({@link HEARTBEAT_TTL_MS}) before a reconnect is
 * even attempted, and the reconnect itself gets a second window.
 */
const SDK_RECONNECT_BUDGET_MS = 2 * HEARTBEAT_TTL_MS;

/**
 * Inactivity bound for a prompt whose session host has no tool call in flight: after
 * this much silence the host is treated as having stopped producing, so the prompt is
 * settled instead of hanging the client forever.
 *
 * Every step of a live turn emits a frame (`agent_start`, message events, tool events,
 * `agent_end`), so this bound only has to exceed the longest frame-free gap a healthy
 * turn can produce *with nothing executing*: one model round trip, from the request
 * leaving the host to the first streamed event coming back, possibly straddling a
 * transport reconnect.
 *
 * `TOOL_TIMEOUTS` is this runtime's own statement of how long a single unattended step
 * may block before it is declared stuck, and its slowest **default**
 * ({@link DEFAULT_TOOL_RUNTIME_MS}) is the longest such wait nobody explicitly opted
 * into. That is well above the agent's own model-stream watchdog (120s idle / 100s
 * first event in `packages/ai/src/utils/idle-iterator.ts`), which aborts a stalled
 * provider stream and republishes it as an error frame — itself a frame — long before
 * this bound. {@link SDK_RECONNECT_BUDGET_MS} is added on top so a reconnect landing
 * inside that gap cannot trip it either. Two providers widen their first-event
 * fallback past this bound (alibaba-token-plan 600s, kimi-code 300s); a turn that
 * emits nothing at all for this long on those is reported as abandoned rather than
 * left `running`, and the session still accepts the next prompt.
 *
 * {@link MAX_TOOL_RUNTIME_MS} is deliberately *not* used here. `max` is what a caller
 * may request, not what tools take, so sizing every gap for it produced a 63min bound
 * that could never act as a safety net. Turns that legitimately reach that ceiling are
 * covered by {@link ACP_PROMPT_TOOL_ACTIVITY_TIMEOUT_MS} instead, which is gated on
 * evidence that a tool is actually executing.
 */
export const ACP_PROMPT_INACTIVITY_TIMEOUT_MS = DEFAULT_TOOL_RUNTIME_MS + SDK_RECONNECT_BUDGET_MS;

/**
 * Inactivity bound that applies only while the session host has an unfinished tool
 * call — a `tool_execution_start`/`tool_execution_update` with no matching
 * `tool_execution_end`.
 *
 * A long `bash` is protected by the evidence that it is running, not by a constant
 * sized for the worst case, so this wide bound stands only for as long as that
 * evidence does. It still terminates: no tool call may outlive
 * {@link MAX_TOOL_RUNTIME_MS}, after which the host must publish `tool_execution_end`,
 * so a host that dies mid-tool is still reported (one reconnect budget later).
 */
export const ACP_PROMPT_TOOL_ACTIVITY_TIMEOUT_MS = MAX_TOOL_RUNTIME_MS + SDK_RECONNECT_BUDGET_MS;

/**
 * Widest frame-free window a single provider call may legitimately occupy before the
 * agent's own stream watchdog aborts it. Mirrors `ALIBABA_TOKEN_PLAN_FIRST_EVENT_TIMEOUT_MS`
 * in `packages/ai/src/utils/idle-iterator.ts` (600s), the largest per-provider first-event
 * fallback of any built-in provider — `DEFAULT_STREAM_FIRST_EVENT_TIMEOUT_MS` is 100s and
 * `kimi-code` gets 300s. That constant is module-private there, so it is mirrored here and
 * pinned against `getProviderFirstEventTimeoutFallbackMs` in the watchdog test: a change on
 * either side fails loudly instead of silently inflating this bound.
 */
const MAX_PROVIDER_FIRST_EVENT_TIMEOUT_MS = 600_000;

/**
 * Inactivity bound that applies while a prompt is awaiting the model: a provider call is in
 * flight and has not produced the first frame of its response yet.
 *
 * Tool execution had evidence and model inference did not, so a turn thinking after
 * `agent_start` looked exactly like a dead producer and was killed at
 * {@link ACP_PROMPT_INACTIVITY_TIMEOUT_MS}. Inference gets the same evidence-based
 * tolerance: the wide bound stands only as long as a model call is observably unanswered.
 *
 * It still terminates. A provider stream that yields nothing within
 * {@link MAX_PROVIDER_FIRST_EVENT_TIMEOUT_MS} is aborted by the agent's own stream watchdog,
 * which republishes as an error/retry frame, so a host that dies mid-inference is still
 * reported one reconnect budget later.
 */
export const ACP_PROMPT_INFERENCE_TIMEOUT_MS = MAX_PROVIDER_FIRST_EVENT_TIMEOUT_MS + SDK_RECONNECT_BUDGET_MS;

/**
 * Per-prompt view of what the session host is observably doing: which tool calls it has
 * started but not finished, and whether it is waiting on a model call. Inbound frames are
 * the only evidence the ACP side has, so "a tool is running" means exactly "a start was
 * observed and its end was not", and "awaiting the model" means exactly "a model call was
 * dispatched and nothing from its response has been observed".
 */
export class PromptActivity {
	readonly #running = new Set<string>();
	#awaitingModel = false;

	/** Folds one inbound frame's lifecycle event into the in-flight tool and model state. */
	observe(eventType: string | undefined, toolCallId: string | undefined, messageRole: string | undefined): void {
		this.#observeInference(eventType, messageRole);
		if (toolCallId === undefined) return;
		if (eventType === "tool_execution_start" || eventType === "tool_execution_update") this.#running.add(toolCallId);
		else if (eventType === "tool_execution_end") this.#running.delete(toolCallId);
	}

	/**
	 * A turn is awaiting the model from every point where the host dispatches a provider
	 * call — `agent_start` for the turn's first call, `tool_execution_end` for the
	 * re-invocation that carries a tool result back — until the first frame of that
	 * response proves the model answered.
	 */
	#observeInference(eventType: string | undefined, messageRole: string | undefined): void {
		if (eventType === "agent_start" || eventType === "tool_execution_end") {
			this.#awaitingModel = true;
			return;
		}
		// Streamed content/thinking/tool-call deltas, and the tool call the model asked for,
		// are only ever produced by an answering model.
		if (eventType === "message_update" || eventType === "tool_execution_start") {
			this.#awaitingModel = false;
			return;
		}
		// Providers that do not stream emit no `message_update`, so the assistant message
		// itself is the first proof. `message_start`/`message_end` also carry the user and
		// tool-result messages the host echoes back, which prove nothing about the model.
		if ((eventType === "message_start" || eventType === "message_end") && messageRole === "assistant")
			this.#awaitingModel = false;
	}

	/** True while at least one started tool call has not reported an end. */
	get running(): boolean {
		return this.#running.size > 0;
	}

	/** True while a dispatched model call has not produced the first frame of its response. */
	get awaitingModel(): boolean {
		return this.#awaitingModel;
	}

	/** Bound that applies to the next frame-free gap, given what is observably executing. */
	get inactivityBoundMs(): number {
		if (this.running) return ACP_PROMPT_TOOL_ACTIVITY_TIMEOUT_MS;
		return this.#awaitingModel ? ACP_PROMPT_INFERENCE_TIMEOUT_MS : ACP_PROMPT_INACTIVITY_TIMEOUT_MS;
	}
}

/** Timer surface behind the prompt watchdog; tests substitute a virtual clock. */
export interface PromptWatchdogClock {
	now(): number;
	/** Runs `handler` after `delayMs`; the returned callback cancels the pending run. */
	schedule(handler: () => void, delayMs: number): () => void;
}

export const systemPromptWatchdogClock: PromptWatchdogClock = {
	now: () => Date.now(),
	schedule(handler: () => void, delayMs: number): () => void {
		const timer = setTimeout(handler, delayMs);
		timer.unref?.();
		return () => clearTimeout(timer);
	},
};
