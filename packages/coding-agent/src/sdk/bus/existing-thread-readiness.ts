/**
 * The prepare → bind → activate lifecycle for adopting an existing chat root.
 *
 * Stock startup publishes a session's readiness immediately, so the running
 * chat daemon surfaces the session and creates its own root before an operator
 * could ever name an existing one. A session that opts in is *prepared*
 * instead: its id, endpoint, and broker registration are discoverable authority
 * while readiness stays withheld, which leaves exactly one root claim for
 * `gjc notify bind-thread` to fill. Activation then publishes readiness once,
 * and the daemon adopts the bound root instead of replacing it.
 *
 * Nothing here mutates a mapping. The gate only reads the daemon-owned store to
 * prove a binding exists, and the activation client only asks the session's own
 * host to publish the readiness it withheld.
 */

import type { SessionIndex } from "../broker/session-index";
import { SdkClient } from "../client/client";
import type { SdkSessionEndpoint, SdkSessionEndpointScope } from "../client/discovery";
import type { SessionActivationGate } from "../host";
import {
	type ActivatedPreparedSession,
	type PreparedSessionActivationClient,
	requestPreparedSessionActivation,
	SessionActivationError,
} from "../session-activation";
import type { ConversationStore } from "./conversation-store";
import type { SlackConversation } from "./slack-conversation";
import { resolveSessionBindingAuthority } from "./slack-thread-binding";

/** Explicit, session-scoped opt-in for withholding readiness until a root is bound. */
export const EXISTING_THREAD_BIND_ENV = "GJC_NOTIFY_BIND_EXISTING_THREAD";

/**
 * Existing-thread binding is opt-in, and only the exact value `1` opts in.
 *
 * Every other value — absent, empty, `0`, or anything truthy-looking — keeps
 * the stock immediate-readiness contract, so no session silently loses its
 * root publication because of an ambiguous environment.
 */
export function isExistingThreadBindingRequested(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[EXISTING_THREAD_BIND_ENV] === "1";
}

export interface SlackBindingActivationInput {
	store: ConversationStore<SlackConversation>;
	teamId: string;
	channelId: string;
}

/**
 * Authorize activation only against an applied binding for this exact session.
 *
 * The proof is the daemon-owned mapping itself: an active record for this
 * session, in the configured workspace and channel, carrying a root and the
 * exact endpoint generation being activated. A missing, foreign, or
 * stale-generation mapping is a refusal, and an unreadable store raises so the
 * caller reports unavailable authority instead of an authorization.
 */
export function createSlackBindingActivationGate(input: SlackBindingActivationInput): SessionActivationGate {
	return async ({ sessionId, generation }) => {
		const document = await input.store.load();
		return Object.values(document.conversations).some(
			record =>
				record.state === "active" &&
				record.sessionId === sessionId &&
				record.teamId === input.teamId &&
				record.channelId === input.channelId &&
				typeof record.rootTs === "string" &&
				record.rootTs.length > 0 &&
				record.endpointGeneration === generation,
		);
	};
}

export type {
	ActivatedPreparedSession,
	PreparedSessionActivationClient,
	SessionActivationErrorCode,
} from "../session-activation";
export { requestPreparedSessionActivation, SessionActivationError } from "../session-activation";

export interface PreparedSessionActivationInput {
	sessionIndex: SessionIndex;
	sessionId: string;
}

export interface PreparedSessionActivationDeps {
	readEndpoint?: (
		repo: string,
		sessionId: string,
		scope?: SdkSessionEndpointScope,
	) => Promise<SdkSessionEndpoint | null>;
	connect?: (endpoint: { url: string; token: string }) => Promise<PreparedSessionActivationClient>;
}

/**
 * Ask a prepared session to publish the readiness it withheld.
 *
 * The same discovery authority the binding requires is resolved first, so an
 * unindexed, terminated, or endpoint-rolled session is refused before any
 * connection is opened. The request names the exact session and endpoint
 * generation, and the answer is accepted only when it proves both, so a
 * replacement session can never be activated in place of the requested one.
 * Activation is idempotent: an exact retry answers `already` without a second
 * readiness signal.
 */
export async function activatePreparedSession(
	input: PreparedSessionActivationInput,
	deps: PreparedSessionActivationDeps = {},
): Promise<ActivatedPreparedSession> {
	const authority = await resolveSessionBindingAuthority({
		sessionIndex: input.sessionIndex,
		sessionId: input.sessionId,
		...(deps.readEndpoint ? { readEndpoint: deps.readEndpoint } : {}),
	});
	if (!authority)
		throw new SessionActivationError(
			"session_not_live",
			"Session activation requires an exact live session endpoint.",
		);
	// Deliberately not a second discovery read. The authority proof is bound to
	// one endpoint file, verified by pid and mtime at one scope; re-resolving here
	// could connect to a replacement process whose endpoint generation repeats,
	// and the generation carried below could not tell the two apart.
	const endpoint = authority.endpoint;
	if (!endpoint.url || !endpoint.token)
		throw new SessionActivationError(
			"session_not_live",
			"Session activation requires a readable session discovery endpoint.",
		);
	let client: PreparedSessionActivationClient;
	try {
		client = await (deps.connect ?? defaultActivationClient)({ url: endpoint.url, token: endpoint.token });
	} catch {
		// Nothing was ever sent, so no activation can have been applied.
		throw new SessionActivationError("activation_unavailable", "The session endpoint could not be reached.");
	}
	try {
		return await requestPreparedSessionActivation(client, input.sessionId, authority.endpointGeneration);
	} finally {
		await client.close().catch(() => undefined);
	}
}

async function defaultActivationClient(endpoint: {
	url: string;
	token: string;
}): Promise<PreparedSessionActivationClient> {
	const client = await SdkClient.connect(endpoint.url, endpoint.token, { reconnectAttempts: 0 });
	return {
		request: async frame => (await client.request(frame)) as Record<string, unknown>,
		close: async () => await client.close(),
	};
}
