import { TOOL_TIMEOUTS } from "../tools/tool-timeouts";
import { HEARTBEAT_TTL_MS } from "./bus/daemon-paths";

/** Ceiling of a single blocking tool call, the longest frame-free step of a healthy turn. */
const MAX_TOOL_RUNTIME_MS = Math.max(...Object.values(TOOL_TIMEOUTS).map(config => config.max)) * 1_000;

/**
 * Inactivity bound for one prompt: the silence after which a session host is
 * treated as having stopped producing, so the prompt is settled instead of
 * hanging the client forever.
 *
 * The bound cannot fire during healthy work. Every step of a live turn emits a
 * frame (agent_start, message and tool events, agent_end), so the longest
 * legitimate silence within a turn is one blocking tool call, and
 * `TOOL_TIMEOUTS` caps the slowest tools (`bash`, `ssh`) at
 * {@link MAX_TOOL_RUNTIME_MS}. Ten owner-heartbeat windows
 * ({@link HEARTBEAT_TTL_MS}) are added on top of that ceiling, which also
 * covers the SDK reconnect budget (2 x HEARTBEAT_TTL_MS) plus the model call
 * that follows a tool result. Only a producer that stopped for good stays
 * silent this long.
 */
export const ACP_PROMPT_INACTIVITY_TIMEOUT_MS = MAX_TOOL_RUNTIME_MS + 10 * HEARTBEAT_TTL_MS;

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
