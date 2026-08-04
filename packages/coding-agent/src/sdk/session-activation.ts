/**
 * The activation exchange a prepared session answers, and nothing else.
 *
 * A prepared session holds discoverable endpoint authority while its readiness
 * stays withheld; activation is the one request that asks it to publish that
 * readiness. Every caller shares this exchange whatever proved the endpoint
 * authority beforehand: the `gjc notify activate-thread` CLI resolves it from
 * the local session index, and the Coordinator resolves it from the broker's
 * incarnation-bound binding.
 *
 * It lives outside `sdk/bus` on purpose. The existing-thread module reaches the
 * chat-daemon and settings graph to prove a Slack binding, and the Coordinator
 * MCP entrypoint may not reach that graph at all, so the exchange the machine
 * entrypoint needs carries no notification, daemon, or settings dependency.
 */

import { SdkClientError } from "./client/client";

export type SessionActivationErrorCode =
	| "session_not_live"
	| "not_prepared"
	| "not_bound"
	| "activation_unavailable"
	| "activation_outcome_unknown";

/** A fail-closed rejection while activating a prepared session. */
export class SessionActivationError extends Error {
	constructor(
		readonly code: SessionActivationErrorCode,
		message: string,
	) {
		super(message);
		this.name = "SessionActivationError";
	}
}

/** Safe confirmation of an activation. It carries identifiers only. */
export interface ActivatedPreparedSession {
	sessionId: string;
	endpointGeneration: number;
	status: "activated" | "already";
}

/** The narrow transport surface activation needs from an SDK connection. */
export interface PreparedSessionActivationClient {
	request(frame: Record<string, unknown>): Promise<Record<string, unknown>>;
	close(): Promise<void>;
}

/**
 * Ask one already-connected session to publish the readiness it withheld.
 *
 * The frame names the exact session and endpoint generation, and the answer is
 * accepted only when it proves both, so a replacement session can never be
 * activated in place of the requested one. Activation is idempotent: an exact
 * retry answers `already` without a second readiness signal.
 */
export async function requestPreparedSessionActivation(
	client: PreparedSessionActivationClient,
	sessionId: string,
	endpointGeneration: number,
): Promise<ActivatedPreparedSession> {
	try {
		const answer = await client.request({
			type: "session_activate",
			sessionId,
			endpointGeneration,
		});
		return interpretActivationAnswer(answer, sessionId, endpointGeneration);
	} catch (error) {
		throw activationFailure(error);
	}
}

function interpretActivationAnswer(
	answer: Record<string, unknown>,
	sessionId: string,
	endpointGeneration: number,
): ActivatedPreparedSession {
	const status = answer.status;
	if (
		answer.type !== "session_activate_result" ||
		answer.ok !== true ||
		answer.sessionId !== sessionId ||
		answer.generation !== endpointGeneration ||
		(status !== "activated" && status !== "already")
	)
		throw new SessionActivationError(
			"activation_outcome_unknown",
			"The session answered an activation that does not match the request; rerun it to observe the settled state.",
		);
	return { sessionId, endpointGeneration, status };
}

/**
 * Translate a failed activation by what it proves.
 *
 * A refused status is definitive: the session decided and published nothing. A
 * transport failure after the request was sent is not, because the session may
 * have activated before the answer was lost; an exact retry then answers
 * `already` rather than publishing a second readiness signal.
 */
function activationFailure(error: unknown): SessionActivationError {
	if (error instanceof SessionActivationError) return error;
	const code = error instanceof SdkClientError ? error.code : undefined;
	if (code === "not_authorized")
		return new SessionActivationError(
			"not_bound",
			"The session is prepared for an existing thread but no binding has been applied yet.",
		);
	if (code === "not_prepared")
		return new SessionActivationError("not_prepared", "The session is not prepared for activation.");
	if (code === "generation_changed" || code === "session_mismatch")
		return new SessionActivationError(
			"session_not_live",
			"The session endpoint generation changed before activation; rerun it against the current session.",
		);
	if (code === "authority_unavailable")
		return new SessionActivationError(
			"activation_unavailable",
			"The session could not read its activation authority.",
		);
	return new SessionActivationError(
		"activation_outcome_unknown",
		"The session did not answer the activation; rerun it to observe the settled state.",
	);
}
