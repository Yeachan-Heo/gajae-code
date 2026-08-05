/**
 * Adoption of an operator-supplied Slack thread as a live session's root.
 *
 * Three separate authorities have to agree before a mapping exists:
 *  1. *Configuration*: a complete Slack target (both tokens plus workspace and
 *     channel) must already be configured; binding never accepts a target.
 *  2. *Daemon*: only the running owner may mutate mappings, and only while it is
 *     still the exact owner (`ownerId`/`pid`/`incarnation`/daemon generation)
 *     captured before the request was published.
 *  3. *Session*: the SDK session must be attachable right now — indexed, live,
 *     non-terminal, with a readable, non-stale endpoint whose pid matches the
 *     indexed host and whose generation has not rolled.
 *
 * Provider verification happens before any lock is taken, and the mapping commit
 * re-proves session authority inside the store lock, so an authority that
 * changes mid-flight leaves no mapping behind.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Settings } from "../../config/settings";
import type { SessionIndex } from "../broker/session-index";
import { readSdkSessionEndpoint, type SdkSessionEndpoint, type SdkSessionEndpointScope } from "../client/discovery";
import {
	type ChatDaemonCommandOwner,
	type ChatDaemonCommandSubmission,
	submitChatDaemonCommand,
} from "./chat-daemon-command-channel";
import {
	ChatDaemonController,
	chatDaemonGeneration,
	type EnsureChatDaemonResult,
	ensureSlackDaemon,
	hasSafeChatDaemonStateShape,
	readChatDaemonState,
} from "./chat-daemon-control";
import { getNotificationConfig, isSlackComplete } from "./config";
import { ConversationStore } from "./conversation-store";
import { normalizeSlackConversation, type SlackConversation, slackConversationKey } from "./slack-conversation";

export type SlackThreadBindingErrorCode =
	| "invalid_root"
	| "target_not_configured"
	| "daemon_unavailable"
	| "daemon_owner_changed"
	| "session_not_live"
	| "root_not_found"
	| "provider_unavailable"
	| "root_conflict"
	| "session_conflict"
	| "binding_outcome_unknown"
	| "binding_failed";

const BINDING_ERROR_CODES: readonly SlackThreadBindingErrorCode[] = [
	"invalid_root",
	"target_not_configured",
	"daemon_unavailable",
	"daemon_owner_changed",
	"session_not_live",
	"root_not_found",
	"provider_unavailable",
	"root_conflict",
	"session_conflict",
	"binding_outcome_unknown",
	"binding_failed",
];

/** A fail-closed rejection while adopting an operator-supplied Slack thread. */
export class SlackThreadBindingError extends Error {
	constructor(
		readonly code: SlackThreadBindingErrorCode,
		message: string,
	) {
		super(message);
		this.name = "SlackThreadBindingError";
	}
}

function bindingErrorCode(value: string | undefined): SlackThreadBindingErrorCode {
	return BINDING_ERROR_CODES.find(candidate => candidate === value) ?? "binding_failed";
}

/**
 * Slack message timestamps are `<seconds>.<fraction>` with ASCII digits on both
 * sides. The bound keeps an operator-supplied value from becoming an unbounded
 * store key or provider argument; the provider remains the final authority on
 * whether the timestamp addresses a real message.
 */
const MAX_SLACK_TS_SEGMENT = 12;

function isAsciiDigits(value: string): boolean {
	if (value.length === 0) return false;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 0x30 || code > 0x39) return false;
	}
	return true;
}

export function isBoundedSlackRootTs(value: string): boolean {
	if (typeof value !== "string") return false;
	const separator = value.indexOf(".");
	if (separator <= 0 || separator !== value.lastIndexOf(".")) return false;
	const seconds = value.slice(0, separator);
	const fraction = value.slice(separator + 1);
	if (seconds.length > MAX_SLACK_TS_SEGMENT || fraction.length > MAX_SLACK_TS_SEGMENT) return false;
	return isAsciiDigits(seconds) && isAsciiDigits(fraction);
}

/** Reject a non-addressable root before any authority read or persistence. */
export function assertBoundedSlackRootTs(rootTs: string): void {
	if (!isBoundedSlackRootTs(rootTs))
		throw new SlackThreadBindingError(
			"invalid_root",
			"Slack root timestamp must be a bounded <seconds>.<fraction> message timestamp.",
		);
}

/** Proven right to bind one session at one endpoint generation. */
async function defaultStatEndpoint(endpointPath: string): Promise<{ mtimeMs: number } | undefined> {
	const stat = await fs.stat(endpointPath).catch(() => undefined);
	return stat ? { mtimeMs: stat.mtimeMs } : undefined;
}

export interface SlackSessionBindingAuthority {
	sessionId: string;
	endpointGeneration: number;
	pid: number;
	repo: string;
	/**
	 * The exact endpoint this authority was proven against. Callers must use it
	 * rather than re-reading discovery: a second read can observe a different
	 * process whose endpoint generation happens to repeat, and the numeric
	 * generation alone cannot tell the two apart.
	 */
	endpoint: SdkSessionEndpoint;
	scope: SdkSessionEndpointScope;
	endpointMtimeMs: number;
}

export interface SessionBindingAuthorityInput {
	sessionIndex: SessionIndex;
	sessionId: string;
	readEndpoint?: (
		repo: string,
		sessionId: string,
		scope?: SdkSessionEndpointScope,
	) => Promise<SdkSessionEndpoint | null>;
	statEndpoint?: (endpointPath: string) => Promise<{ mtimeMs: number } | undefined>;
}

/**
 * Resolve exact discovery/attachment authority for one session.
 *
 * `IndexedSession.live` alone is only pid liveness, which a terminated or
 * unregistered session can still satisfy through pid reuse or a stale record.
 * Adoption additionally requires an intact index replay, a non-terminal record,
 * and a discovery endpoint that is present, well-formed, not marked stale, and
 * owned by the same host pid the index recorded.
 */
export async function resolveSessionBindingAuthority(
	input: SessionBindingAuthorityInput,
): Promise<SlackSessionBindingAuthority | undefined> {
	await input.sessionIndex.refresh();
	const listing = input.sessionIndex.listSessions();
	// A truncated replay cannot prove the tail is free of a terminal or
	// unregistration event, so a degraded index is never binding authority.
	if (listing.warnings.length > 0) return undefined;
	const session = listing.sessions.find(candidate => candidate.sessionId === input.sessionId);
	if (!session?.live || session.terminalUncertain) return undefined;
	if (!Number.isSafeInteger(session.endpointGeneration) || session.endpointGeneration <= 0) return undefined;
	if (!Number.isSafeInteger(session.pid) || session.pid <= 0) return undefined;
	// Same scope derivation the runtime's attach() fence uses. Reading a
	// `.gjc/state/chat/sdk` session at the default scope would either miss it or
	// prove the wrong endpoint, so an underivable scope is not authority.
	const repo = path.resolve(session.locator.repo);
	const defaultStateRoot = path.join(repo, ".gjc", "state");
	const indexedStateRoot = path.resolve(session.locator.stateRoot);
	const scope: SdkSessionEndpointScope | undefined =
		indexedStateRoot === defaultStateRoot
			? "default"
			: indexedStateRoot === path.join(defaultStateRoot, "chat")
				? "chat"
				: undefined;
	if (!scope || session.endpointMtimeMs === undefined) return undefined;

	let endpoint: SdkSessionEndpoint | null;
	try {
		endpoint = await (input.readEndpoint ?? readSdkSessionEndpoint)(session.locator.repo, input.sessionId, scope);
	} catch {
		// A malformed discovery record is not authority for anything.
		return undefined;
	}
	if (!endpoint || endpoint.stale === true || !endpoint.url || !endpoint.token) return undefined;
	if (endpoint.pid === undefined || endpoint.pid !== session.pid) return undefined;

	// The endpoint file must be the exact one the index observed. Without this
	// the numeric generation is the only fence, and it repeats across processes.
	const stat = await (input.statEndpoint ?? defaultStatEndpoint)(endpoint.path);
	if (!stat || stat.mtimeMs !== session.endpointMtimeMs) return undefined;

	return {
		sessionId: input.sessionId,
		endpointGeneration: session.endpointGeneration,
		pid: session.pid,
		repo: session.locator.repo,
		endpoint,
		scope,
		endpointMtimeMs: session.endpointMtimeMs,
	};
}

/** States in which a mapping still owns its session's root claim. */
function holdsRootClaim(record: SlackConversation): boolean {
	return record.state === "active" || record.state === "posting_root" || record.state === "resumed_root";
}

export interface SlackThreadClaimInput {
	store: ConversationStore<SlackConversation>;
	/** The session root-claim key shared with stock root publication. */
	key: string;
	teamId: string;
	channelId: string;
	sessionId: string;
	rootTs: string;
	endpointGeneration: number;
	/**
	 * Re-proves session authority inside the store lock, immediately before
	 * commit. It may be invoked more than once for one claim: authority here is
	 * monotone — a rolled endpoint generation, a replaced daemon owner tuple and
	 * a retired single-winner request claim never come back — so repeating the
	 * proof can only ever narrow the window, never widen it. It must therefore be
	 * idempotent and must never perform a remote call.
	 */
	revalidate: () => Promise<boolean>;
	now?: () => number;
}

/**
 * Claim an existing Slack root for a session without publishing a replacement.
 *
 * The claim transacts the same `intent:<sessionId>` key that stock root
 * publication uses, so a bind and a concurrent first notification serialize on
 * one invariant: whichever commits first owns the session's single root, and
 * the loser observes it instead of creating a second one.
 */
export async function claimSlackThreadBinding(input: SlackThreadClaimInput): Promise<SlackConversation> {
	assertBoundedSlackRootTs(input.rootTs);
	const now = input.now ?? Date.now;
	let rejection: SlackThreadBindingError | undefined;
	let commitAuthorityGranted = false;
	let bound: SlackConversation | undefined;
	try {
		bound = await claimTransaction(input, now, {
			writeRejection: value => (rejection = value),
			grantCommitAuthority: () => {
				commitAuthorityGranted = true;
			},
		});
	} catch (error) {
		if (error instanceof SlackThreadBindingError) throw error;
		// An explicit domain rejection is a decision, and a decision is never
		// rewritten by a failure that happened after it.
		if (rejection) throw rejection;
		// Nothing else here is a decision. Once the final authority proof granted
		// commit authority, the replacement was handed to the store, and the store
		// renames the staged document *before* its parent-directory durability
		// barrier and before its lock cleanup run. A generic failure raised from
		// that point on may therefore be the failure of an already-applied
		// mapping, which is indeterminate — never a definitive rejection the
		// caller could safely retry against.
		if (commitAuthorityGranted)
			throw new SlackThreadBindingError(
				"binding_outcome_unknown",
				"The Slack mapping may already be applied but its commit could not be proven; rerun the binding to observe the settled state.",
			);
		throw new SlackThreadBindingError("binding_failed", "Slack root binding could not be claimed.");
	}
	if (rejection) throw rejection;
	if (
		bound?.state !== "active" ||
		bound.sessionId !== input.sessionId ||
		bound.rootTs !== input.rootTs ||
		bound.endpointGeneration !== input.endpointGeneration
	)
		throw new SlackThreadBindingError("binding_failed", "Slack root binding could not be claimed.");
	return bound;
}

interface ClaimTransactionHooks {
	writeRejection: (value: SlackThreadBindingError) => void;
	/** Called exactly when the final authority proof clears a mutation for commit. */
	grantCommitAuthority: () => void;
}

function claimTransaction(
	input: SlackThreadClaimInput,
	now: () => number,
	hooks: ClaimTransactionHooks,
): Promise<SlackConversation | undefined> {
	const rejectWith = (code: SlackThreadBindingErrorCode, message: string): undefined => {
		hooks.writeRejection(new SlackThreadBindingError(code, message));
		return undefined;
	};
	/**
	 * The final authority fence. Every mutation passes through it — the first
	 * create, an endpoint-generation advance, and nothing else — so no mapping
	 * can ever be stamped with an authority that had already rolled.
	 *
	 * It is two proofs, not one, because taking commit authority is itself
	 * asynchronous: the command-channel caller's proof re-reads the persisted
	 * owner record, takes the single-winner response claim, and re-reads the
	 * published request, and the session's endpoint generation can roll inside
	 * any of those awaits. A single proof would then report an authority it no
	 * longer holds. Authority here is monotone — a rolled generation, a replaced
	 * owner tuple and a retired request never come back — so live at the opening
	 * proof and live again at the closing proof means live across the whole
	 * interval between them.
	 *
	 * Both proofs are local work only: no provider or network call ever runs
	 * under the store lock. Authority that rolls after the closing proof is an
	 * ordinary lifecycle event, fenced by the endpoint generation the mapping
	 * records.
	 */
	const proveCommitAuthority = async (): Promise<boolean> => {
		// The opening proof, then the closing proof.
		for (let proof = 0; proof < 2; proof++) {
			if (await input.revalidate()) continue;
			rejectWith("session_not_live", "Slack session authority changed before the binding could commit.");
			return false;
		}
		hooks.grantCommitAuthority();
		return true;
	};
	return input.store.transactWithSnapshot(input.key, async (current, conversations) => {
		for (const [candidateKey, candidate] of Object.entries(conversations)) {
			if (!holdsRootClaim(candidate)) continue;
			if (
				candidate.teamId === input.teamId &&
				candidate.channelId === input.channelId &&
				candidate.rootTs === input.rootTs &&
				candidate.sessionId !== input.sessionId
			) {
				rejectWith("root_conflict", "Slack root is already bound to another session.");
				return current;
			}
			if (candidateKey !== input.key && candidate.sessionId === input.sessionId) {
				rejectWith("session_conflict", "Slack session already holds a different root claim.");
				return current;
			}
		}
		if (current) {
			const storedGeneration = current.endpointGeneration ?? 0;
			if (
				current.sessionId !== input.sessionId ||
				current.state !== "active" ||
				current.rootTs !== input.rootTs ||
				storedGeneration > input.endpointGeneration
			) {
				rejectWith("session_conflict", "Slack session already holds a different root claim.");
				return current;
			}
			// An exact replay must not mutate, but it still has to prove authority:
			// an unauthorized or cancelled request may not be answered with the
			// record a previous, authorized request created. Nothing is staged for
			// this branch, so one proof is the whole fence and a refusal here is a
			// definitive, mutation-free rejection.
			if (storedGeneration === input.endpointGeneration) {
				if (!(await input.revalidate()))
					rejectWith("session_not_live", "Slack session authority changed before the binding could commit.");
				return current;
			}
		}
		if (!(await proveCommitAuthority())) return current;
		return normalizeSlackConversation({
			generation: (current?.generation ?? 0) + 1,
			state: "active",
			teamId: input.teamId,
			channelId: input.channelId,
			rootTs: input.rootTs,
			sessionId: input.sessionId,
			endpointGeneration: input.endpointGeneration,
			updatedAt: now(),
			seenEventIds: current?.seenEventIds ?? [],
			seenContextIds: current?.seenContextIds ?? [],
			seenRetryKeys: current?.seenRetryKeys ?? [],
			seenInteractionIds: current?.seenInteractionIds ?? [],
			inboundDispatches: current?.inboundDispatches ?? [],
		});
	});
}

export interface ConfiguredSlackThreadBindingInput {
	settings: Settings;
	sessionId: string;
	threadTs: string;
}

export interface ConfiguredSlackThreadBindingDeps {
	ensureDaemon?: (settings: Settings) => Promise<EnsureChatDaemonResult>;
	timeoutMs?: number;
	pollIntervalMs?: number;
	/** Bounded wait for a daemon that took terminal authority before the caller gave up. */
	settleGraceMs?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

/** Safe confirmation of an applied binding. It carries identifiers only. */
export interface BoundSlackThread {
	sessionId: string;
	endpointGeneration: number;
	teamId: string;
	channelId: string;
	rootTs: string;
	ownerId: string;
	daemonGeneration: number;
}

/**
 * Adopt an existing Slack root for a live session through the running daemon.
 *
 * The CLI never writes the mapping store: it proves the configured target and
 * the exact current owner, then asks that owner to perform the mutation. A
 * daemon that is no longer the captured owner answers `owner_changed`, so a
 * replacement or restart between capture and execution can never apply the
 * request.
 *
 * A submission that is not answered is cancelled through the channel's
 * single-winner arbitration before it is reported as a failure. If that
 * cancellation loses to the daemon's own commit authority, the outcome is
 * reported as unknown instead of as a failure, because a mapping may already
 * exist; re-running the same command observes the settled state idempotently.
 *
 * The command channel proves *correlation*, never authorship: every field a
 * response echoes is copied verbatim out of the plaintext request published
 * beside it. A definitive answer is therefore reported only after this caller
 * itself observes the exact mutation in the conversation store — see
 * `corroborateBoundMapping`.
 */
export async function bindConfiguredSlackThread(
	input: ConfiguredSlackThreadBindingInput,
	deps: ConfiguredSlackThreadBindingDeps = {},
): Promise<BoundSlackThread> {
	assertBoundedSlackRootTs(input.threadTs);
	const config = getNotificationConfig(input.settings);
	if (!isSlackComplete(config))
		throw new SlackThreadBindingError(
			"target_not_configured",
			"Slack notifications must be fully configured before binding an existing thread.",
		);
	const agentDir = input.settings.getAgentDir();
	const ensured = await (deps.ensureDaemon ?? ensureSlackDaemon)(input.settings);
	if (ensured === "disabled")
		throw new SlackThreadBindingError(
			"target_not_configured",
			"Slack notifications must be fully configured before binding an existing thread.",
		);
	const status = await new ChatDaemonController(input.settings, "slack").status();
	if (status.health !== "running")
		throw new SlackThreadBindingError(
			"daemon_unavailable",
			`Slack daemon must be running to bind an existing thread (current: ${status.health}).`,
		);
	const state = await readChatDaemonState(agentDir, "slack");
	if (
		!hasSafeChatDaemonStateShape(state) ||
		state.kind !== "slack" ||
		state.stoppedAt !== undefined ||
		state.ownerId !== status.ownerId ||
		state.pid !== status.pid ||
		state.generation !== chatDaemonGeneration("slack")
	)
		throw new SlackThreadBindingError(
			"daemon_owner_changed",
			"Slack daemon ownership changed; rerun the binding against the current owner.",
		);
	const owner: ChatDaemonCommandOwner = {
		ownerId: state.ownerId,
		pid: state.pid,
		incarnation: state.incarnation,
		generation: state.generation,
	};
	const submission = await submitChatDaemonCommand({
		agentDir,
		kind: "slack",
		owner,
		command: "bind-thread",
		sessionId: input.sessionId,
		rootTs: input.threadTs,
		...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
		...(deps.pollIntervalMs === undefined ? {} : { pollIntervalMs: deps.pollIntervalMs }),
		...(deps.settleGraceMs === undefined ? {} : { settleGraceMs: deps.settleGraceMs }),
		...(deps.now === undefined ? {} : { now: deps.now }),
		...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
	});
	const target = { teamId: config.slack.workspaceId, channelId: config.slack.channelId };
	const bound = interpretBindSubmission(submission, { owner, input, ...target });
	return await corroborateBoundMapping(agentDir, bound, {
		...target,
		sessionId: input.sessionId,
		rootTs: input.threadTs,
	});
}

/**
 * Refuse a reported binding that the durable mapping store does not corroborate.
 *
 * The command channel authenticates nothing. Every field a response echoes is
 * copied verbatim out of the plaintext request that sits beside it, and
 * `<id>.response.json` is a single-winner object in the daemon's own command
 * directory, so a complete, envelope-correct `status:"ok"` document is
 * producible by a stale replay or a planted file with no daemon involvement at
 * all — and so is any companion document in the same directory.
 *
 * Authenticating the responder needs an authority the writer cannot copy —
 * kernel-verified peer identity over a local socket. That is not reachable from
 * this runtime, so nothing here claims to authenticate anything. Instead the one
 * definitive answer a caller can act on, `ok`, is refused unless this process
 * itself observes the exact mutation in the conversation store: an authority
 * outside the command directory, which a forged answer never produces because it
 * performs no mutation.
 *
 * An uncorroborated mapping is reported as indeterminate rather than as a
 * failure. A real daemon may have committed and had its mapping superseded
 * before this read, so the operator is told to rerun and observe the settled
 * state instead of being told the binding definitively failed.
 */
async function corroborateBoundMapping(
	agentDir: string,
	bound: BoundSlackThread,
	requested: { teamId: string; channelId: string; sessionId: string; rootTs: string },
): Promise<BoundSlackThread> {
	const key = slackConversationKey({
		teamId: requested.teamId,
		channelId: requested.channelId,
		rootTs: `intent:${requested.sessionId}`,
	});
	let record: SlackConversation | undefined;
	try {
		record = await new ConversationStore<SlackConversation>({ agentDir, kind: "slack" }).read(key);
	} catch {
		// An unreadable store proves nothing about the mapping, which is exactly
		// the indeterminate outcome reported below.
		record = undefined;
	}
	if (
		record?.state !== "active" ||
		record.sessionId !== requested.sessionId ||
		record.rootTs !== requested.rootTs ||
		record.teamId !== requested.teamId ||
		record.channelId !== requested.channelId ||
		record.endpointGeneration !== bound.endpointGeneration
	)
		throw new SlackThreadBindingError(
			"binding_outcome_unknown",
			"The Slack daemon reported a binding the durable mapping store does not corroborate; rerun the binding to observe the settled state.",
		);
	return bound;
}

function interpretBindSubmission(
	submission: ChatDaemonCommandSubmission,
	context: {
		owner: ChatDaemonCommandOwner;
		input: ConfiguredSlackThreadBindingInput;
		teamId: string;
		channelId: string;
	},
): BoundSlackThread {
	if (submission.outcome === "unavailable")
		throw new SlackThreadBindingError(
			"daemon_unavailable",
			"The Slack daemon command channel is not usable for this request.",
		);
	if (submission.outcome === "cancelled")
		throw new SlackThreadBindingError(
			"daemon_unavailable",
			"The Slack daemon did not answer in time; the request was cancelled before any mapping changed.",
		);
	if (submission.outcome === "unknown")
		throw new SlackThreadBindingError(
			"binding_outcome_unknown",
			"The Slack daemon took commit authority but did not report an outcome; rerun the binding to observe it.",
		);
	if (submission.outcome === "untrusted")
		throw new SlackThreadBindingError(
			"binding_outcome_unknown",
			"The Slack daemon channel holds an answer that does not carry this request's envelope; rerun the binding to observe the settled state.",
		);
	// `submitChatDaemonCommand` has proven that this document carries this exact
	// request's envelope, which is correlation only: the envelope is public, so a
	// forged answer satisfies it too. Nothing below may therefore be treated as
	// proof that the daemon acted — the definitive `ok` branch is corroborated
	// against the durable mapping store by `corroborateBoundMapping`.
	const response = submission.response;
	if (response.status === "owner_changed")
		throw new SlackThreadBindingError(
			"daemon_owner_changed",
			"Slack daemon ownership changed; rerun the binding against the current owner.",
		);
	if (response.status === "expired")
		throw new SlackThreadBindingError(
			"daemon_unavailable",
			"The Slack thread binding request expired before the daemon executed it.",
		);
	if (response.status === "outcome_unknown")
		throw new SlackThreadBindingError(
			"binding_outcome_unknown",
			"The Slack daemon exercised commit authority but could not prove the mapping's durable state; rerun the binding to observe it.",
		);
	if (response.status === "rejected")
		throw new SlackThreadBindingError(
			bindingErrorCode(response.code),
			`The Slack daemon refused the thread binding (${bindingErrorCode(response.code)}).`,
		);
	if (
		response.ownerId !== context.owner.ownerId ||
		response.pid !== context.owner.pid ||
		response.incarnation !== context.owner.incarnation ||
		response.generation !== context.owner.generation ||
		response.sessionId !== context.input.sessionId ||
		response.rootTs !== context.input.threadTs ||
		response.teamId !== context.teamId ||
		response.channelId !== context.channelId ||
		response.endpointGeneration === undefined
	)
		throw new SlackThreadBindingError(
			"binding_failed",
			"The Slack daemon answered with a binding that does not match the request.",
		);
	return {
		sessionId: response.sessionId,
		endpointGeneration: response.endpointGeneration,
		teamId: response.teamId,
		channelId: response.channelId,
		rootTs: response.rootTs,
		ownerId: response.ownerId,
		daemonGeneration: response.generation,
	};
}
