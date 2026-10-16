import { BTW_MAX_QUESTION_UTF8_BYTES, utf8ByteLength } from "../../../session/btw-contract";
import { BusyError } from "./dispatch";

/** Session-owned ephemeral side-question runner (`/btw`); absent when the host has none. */
export type EphemeralQuestionRunner = (question: string) => Promise<string>;

/**
 * Builds the `btw.ask` (C54) handler shared by both session host surfaces (the
 * SDK-only runtime host and the notifications-hosted SDK server).
 *
 * `btw.ask` owns no turn and appends nothing to the session transcript, so it
 * enforces its own single-flight admission instead of relying on turn
 * admission. The registry marks the operation `fast_lane`, so dispatch never
 * queues it behind the ordered per-surface chain and a second concurrent
 * question reaches this guard while the first is still answering.
 *
 * A question outside the `/btw` contract is refused as `invalid_input`, a
 * second in-flight question as the typed `busy`, and a host without the runner
 * seam as `unavailable` — never by admitting side work into turn state.
 */
export function createBtwAskHandler(
	runner: EphemeralQuestionRunner | undefined,
): (question: string) => Promise<{ reply: string }> {
	let questionInFlight = false;
	return async question => {
		if (typeof question !== "string" || question.trim().length === 0)
			throw Object.assign(new Error("btw.ask requires a nonempty question."), { code: "invalid_input" });
		if (utf8ByteLength(question) > BTW_MAX_QUESTION_UTF8_BYTES)
			throw Object.assign(
				new Error(`btw.ask questions are limited to ${BTW_MAX_QUESTION_UTF8_BYTES} UTF-8 bytes.`),
				{ code: "invalid_input" },
			);
		if (!runner)
			throw Object.assign(new Error("btw.ask is unavailable without an installed session seam."), {
				code: "unavailable",
			});
		if (questionInFlight) throw new BusyError("A /btw question is already running. Wait for it to finish.");
		questionInFlight = true;
		try {
			return { reply: (await runner(question.trim())).trim() };
		} finally {
			questionInFlight = false;
		}
	};
}
