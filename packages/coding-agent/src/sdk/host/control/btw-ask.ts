import {
	BTW_MAX_QUESTION_UTF8_BYTES,
	type BtwTextExchange,
	boundBtwExchanges,
	utf8ByteLength,
} from "../../../session/btw-contract";
import { BusyError } from "./dispatch";
import type { ControlInput } from "./operations";

/**
 * Session-owned ephemeral side-question runner (`/btw`); absent when the host has none.
 * `exchanges` are the earlier side exchanges, oldest first, already bounded by
 * `boundBtwExchanges`; an empty list asks without side history.
 */
export type EphemeralQuestionRunner = (
	question: string,
	exchanges: readonly BtwTextExchange[],
	signal?: AbortSignal,
) => Promise<string>;

const BTW_ASK_FIELDS = new Set(["question", "exchanges"]);
const BTW_ASK_EXCHANGE_FIELDS = new Set(["question", "reply"]);

function invalidInput(message: string): never {
	throw Object.assign(new Error(message), { code: "invalid_input" });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * Validates the caller-supplied side history of a stateless client. Every entry
 * must be exactly `{ question, reply }` with a nonblank question and a string
 * reply; anything else is refused rather than dropped. The public `reply` maps
 * to the internal `answer`, and the list is then bounded exactly as the TUI
 * `/btw` panel bounds its own history.
 */
function parseExchanges(value: unknown): BtwTextExchange[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) invalidInput("btw.ask exchanges must be an array of { question, reply } objects.");
	const exchanges: BtwTextExchange[] = [];
	for (const [index, entry] of value.entries()) {
		if (!isPlainRecord(entry)) invalidInput(`btw.ask exchanges[${index}] must be a { question, reply } object.`);
		for (const key of Object.keys(entry))
			if (!BTW_ASK_EXCHANGE_FIELDS.has(key)) invalidInput(`Unknown btw.ask exchanges[${index}] field: ${key}`);
		if (typeof entry.question !== "string" || entry.question.trim().length === 0)
			invalidInput(`btw.ask exchanges[${index}].question must be a nonempty string.`);
		if (typeof entry.reply !== "string") invalidInput(`btw.ask exchanges[${index}].reply must be a string.`);
		exchanges.push({ question: entry.question, answer: entry.reply });
	}
	return boundBtwExchanges(exchanges);
}

/**
 * Builds the `btw.ask` (C60) handler shared by both session host surfaces (the
 * SDK-only runtime host and the notifications-hosted SDK server).
 *
 * `btw.ask` owns no turn and appends nothing to the session transcript, so it
 * enforces its own single-flight admission instead of relying on turn
 * admission. The registry marks the operation `fast_lane`, so dispatch never
 * queues it behind the ordered per-surface chain and a second concurrent
 * question reaches this guard while the first is still answering.
 *
 * Input outside the `/btw` contract (an unknown field, a blank or oversized
 * question, malformed `exchanges`) is refused as `invalid_input`, a second
 * in-flight question as the typed `busy`, and a host without the runner seam as
 * `unavailable` — never by admitting side work into turn state.
 */
export function createBtwAskHandler(
	runner: EphemeralQuestionRunner | undefined,
): (input: ControlInput, signal?: AbortSignal) => Promise<{ reply: string }> {
	let questionInFlight = false;
	return async (input, signal) => {
		if (!isPlainRecord(input)) invalidInput("btw.ask input must be an object.");
		for (const key of Object.keys(input))
			if (!BTW_ASK_FIELDS.has(key)) invalidInput(`Unknown btw.ask input field: ${key}`);
		const question = input.question;
		if (typeof question !== "string" || question.trim().length === 0)
			invalidInput("btw.ask requires a nonempty question.");
		if (utf8ByteLength(question) > BTW_MAX_QUESTION_UTF8_BYTES)
			invalidInput(`btw.ask questions are limited to ${BTW_MAX_QUESTION_UTF8_BYTES} UTF-8 bytes.`);
		const exchanges = parseExchanges(input.exchanges);
		if (!runner)
			throw Object.assign(new Error("btw.ask is unavailable without an installed session seam."), {
				code: "unavailable",
			});
		if (questionInFlight) throw new BusyError("A /btw question is already running. Wait for it to finish.");
		signal?.throwIfAborted();
		questionInFlight = true;
		try {
			const reply = await runner(question.trim(), exchanges, signal);
			if (typeof reply !== "string")
				throw Object.assign(new Error("The /btw runner returned an invalid reply."), { code: "unavailable" });
			return { reply: reply.trim() };
		} finally {
			questionInFlight = false;
		}
	};
}
