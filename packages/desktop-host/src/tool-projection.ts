import type { CreateAgentSessionResult } from "@gajae-code/coding-agent/sdk";
import type { DesktopToolDetail } from "./tool-protocol";

type Session = CreateAgentSessionResult["session"];

/** The `tool.detail` refusal while call details are not projected; it never stands in for data. */
export const TOOL_DETAIL_UNAVAILABLE = "Tool call details are not available yet.";

/**
 * Receives every event of a live SDK session, before the Host's own handling, so running calls
 * can be tracked between `message_end` and their result. It must not throw. Nothing is tracked
 * yet.
 */
export function observeToolEvent(_session: Session, _event: { readonly type: string }): void {}

/**
 * Answers `tool.detail` for a live session. `tool.detail` is a projected control method, so the
 * Host does not redact this result when it emits it: every string must pass through `redact`
 * before any cut. Until call details are projected this fails closed.
 */
export function projectToolDetail(
	_session: Session,
	_streamingMessage: unknown,
	_callId: string,
	_redact: (text: string) => string,
): DesktopToolDetail {
	throw new Error(TOOL_DETAIL_UNAVAILABLE);
}
