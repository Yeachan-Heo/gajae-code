/** Canonical durable turn-result DTOs. */
export const TURN_RESULT_VERSION = 1 as const;
export const TURN_RESULT_CONTENT_MAX_BYTES = 16_384;
export const TURN_RESULT_ERROR_MESSAGE_MAX_LENGTH = 512;
export type TurnResultSelector =
	| { kind: "prompt" | "skill"; clientRef: string }
	| { kind: "prompt" | "skill"; commandId: string; turnId: string };
/**
 * `admitted`: the host reserved the clientRef and generated the correlation, but
 * the submission is still in preflight (for example a pre-prompt compaction) and
 * is neither accepted nor rejected yet.
 */
export type TurnResultStatus = "unknown" | "admitted" | "accepted" | "in_flight" | "terminal_ok" | "failed";
export interface TurnResultContent {
	version: typeof TURN_RESULT_VERSION;
	type: "text";
	text: string;
	byteLength: number;
	truncated: boolean;
}
export interface TurnResultError {
	code: string;
	message: string;
}
export type TurnResultReceiptState = "absent" | "present" | "missing" | "unknown";
export interface TurnResultPage {
	status: TurnResultStatus;
	kind?: "prompt" | "skill";
	commandId?: string;
	turnId?: string;
	clientRef?: string;
	acceptedAt?: number;
	startedAt?: number;
	terminalAt?: number;
	receiptState?: TurnResultReceiptState;
	outcome?: unknown;
	content?: TurnResultContent;
	error?: TurnResultError;
}
export function sanitizeTurnResultContent(text: unknown): TurnResultContent | undefined {
	if (typeof text !== "string") return undefined;
	const bytes = new TextEncoder().encode(text);
	const truncated = bytes.length > TURN_RESULT_CONTENT_MAX_BYTES;
	let bounded = text;
	if (truncated) {
		let end = 0;
		for (const character of text) {
			const next = end + new TextEncoder().encode(character).length;
			if (next > TURN_RESULT_CONTENT_MAX_BYTES) break;
			end = next;
		}
		bounded = new TextDecoder().decode(bytes.slice(0, end));
	}
	return {
		version: TURN_RESULT_VERSION,
		type: "text",
		text: bounded,
		byteLength: new TextEncoder().encode(bounded).length,
		truncated,
	};
}

export function reportableTurnResultContent(content: TurnResultContent | undefined): boolean {
	return content !== undefined && content.text.trim().length > 0;
}

/** First reportable invocation-owned content wins; blank evidence remains replaceable. */
export function reduceTurnResultContent(
	existing: TurnResultContent | undefined,
	incoming: TurnResultContent | undefined,
): TurnResultContent | undefined {
	if (reportableTurnResultContent(existing)) return existing;
	if (incoming === undefined) return existing;
	const sanitized = sanitizeTurnResultContent(incoming.text);
	if (sanitized === undefined) return existing;
	return {
		...sanitized,
		truncated: sanitized.truncated || incoming.truncated || existing?.truncated === true,
	};
}
