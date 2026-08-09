/** Canonical durable turn-result DTOs. */
export const TURN_RESULT_VERSION = 1 as const;
export const TURN_RESULT_CONTENT_MAX_BYTES = 16_384;
export const TURN_RESULT_ERROR_MESSAGE_MAX_LENGTH = 512;
export type TurnResultSelector =
	| { kind: "prompt" | "skill"; clientRef: string }
	| { kind: "prompt" | "skill"; commandId: string; turnId: string };
export type TurnResultStatus = "unknown" | "accepted" | "in_flight" | "terminal_ok" | "failed";
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
export interface TurnResultPage {
	status: TurnResultStatus;
	kind?: "prompt" | "skill";
	commandId?: string;
	turnId?: string;
	clientRef?: string;
	acceptedAt?: number;
	startedAt?: number;
	terminalAt?: number;
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
