import { validateAdapterSecretFields } from "../protocol/adapter-validation";
import { type Adapter, OPERATIONS, type Operation, type OperationKind } from "../protocol/operation-registry";

export type ChatTransport = Extract<Adapter, "telegram" | "discord" | "slack">;
export type ChatOperationDisposition = "allowed" | "unsupported_on_chat";

export interface ChatCommandError {
	code: "unsupported_on_chat" | "secret_input_forbidden";
	message: string;
}

export type ChatCommandDecision = { ok: true } | { ok: false; error: ChatCommandError };

export interface ChatOperationRequest {
	kind: OperationKind;
	operation: string;
	input?: unknown;
}

const EXPLICITLY_PROHIBITED_OPERATION_IDS = new Set(["C25", "C39", "C40", "G02"]);

function isAllowedOnChat(transport: ChatTransport, operation: Operation): boolean {
	return (
		!EXPLICITLY_PROHIBITED_OPERATION_IDS.has(operation.id) &&
		(operation.adapterDispositions[transport] === "generic_safe" ||
			operation.adapterDispositions[transport] === "native_alias")
	);
}

function buildChatOperationPolicy(transport: ChatTransport): Readonly<Record<string, ChatOperationDisposition>> {
	const policy: Record<string, ChatOperationDisposition> = {};
	for (const operation of OPERATIONS)
		policy[operation.id] = isAllowedOnChat(transport, operation) ? "allowed" : "unsupported_on_chat";
	return policy;
}

/**
 * Chat authorization follows each transport's canonical registry disposition.
 * Explicit policy prohibitions remain as defense in depth for shell execution,
 * callback-provider registration, and endpoint credentials.
 */
export const CHAT_OPERATION_POLICY: Readonly<
	Record<ChatTransport, Readonly<Record<string, ChatOperationDisposition>>>
> = {
	telegram: buildChatOperationPolicy("telegram"),
	discord: buildChatOperationPolicy("discord"),
	slack: buildChatOperationPolicy("slack"),
};

function unsupported(): ChatCommandDecision {
	return { ok: false, error: { code: "unsupported_on_chat", message: "This operation is not supported on chat." } };
}

/** Reject unsafe or unknown commands before their SDK request can be sent. */
export function authorizeChatOperation(transport: ChatTransport, request: ChatOperationRequest): ChatCommandDecision {
	const operation = OPERATIONS.find(
		candidate => candidate.kind === request.kind && candidate.sdkId === request.operation,
	);
	if (!operation) return unsupported();
	if (validateAdapterSecretFields(operation.sdkId, (request.input ?? {}) as Record<string, unknown>)) {
		return {
			ok: false,
			error: { code: "secret_input_forbidden", message: "Secret configuration input is forbidden on chat." },
		};
	}
	return CHAT_OPERATION_POLICY[transport][operation.id] === "allowed" ? { ok: true } : unsupported();
}

/** Execute only an authorized command, ensuring rejected payloads produce no SDK send. */
export async function sendAuthorizedChatOperation<T>(
	transport: ChatTransport,
	request: ChatOperationRequest,
	send: () => Promise<T>,
): Promise<{ ok: true; result: T } | { ok: false; error: ChatCommandError }> {
	const decision = authorizeChatOperation(transport, request);
	if (!decision.ok) return decision;
	return { ok: true, result: await send() };
}

const BODY_BEARING_QUERY_OPERATIONS = new Set([
	"transcript.body",
	"context.get",
	"diff.read_hunk",
	"session.last_assistant",
	"resource.body",
	"artifact.read",
]);

export type ChatCommandOutcome =
	| { ok: true; result: unknown }
	| { ok: false; error: { code: string; message: string } };

/**
 * The chat transport is an untrusted presentation surface, not a general SDK
 * result renderer. Never serialize SDK result bodies or provider error text.
 */
export function projectChatCommandOutcome(
	request: Pick<ChatOperationRequest, "kind" | "operation">,
	outcome: ChatCommandOutcome,
): Record<string, unknown> {
	if (!outcome.ok)
		return { ok: false, error: { code: outcome.error.code, message: "Command could not be completed." } };
	if (request.kind === "query" && BODY_BEARING_QUERY_OPERATIONS.has(request.operation)) {
		return { ok: true, result: { operation: request.operation, status: "content_withheld" } };
	}
	return { ok: true, result: { operation: request.operation, status: "completed" } };
}
