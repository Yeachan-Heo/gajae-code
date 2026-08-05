/**
 * Request/response control channel for chat-daemon commands that must be
 * executed *by* the running owner instead of terminating it.
 *
 * `control.json` is the lifecycle channel: every request the owner recognizes
 * there ends its serving loop (stop/reload). Adopting an existing Slack root
 * must not stop a healthy daemon, so operator commands travel on this separate
 * per-request channel and are answered in place.
 *
 * Invariants:
 * - Every request is addressed to an exact owner (`ownerId`, `pid`,
 *   `incarnation`, daemon `generation`). A daemon that is not that exact owner
 *   answers `owner_changed` and performs no work, so a replaced or restarted
 *   owner can never satisfy a request captured against its predecessor. The
 *   same tuple is re-proven inside the commit fence and echoed in the answer,
 *   so the submitter can verify who actually acted.
 * - `<id>.response.json` is a single-winner arbitration object created with
 *   `O_CREAT|O_EXCL`. The serving daemon must win it *before* it commits, and a
 *   submitter that has given up must win it before reporting failure. Whoever
 *   loses learns so definitively, which removes the commit-vs-timeout race
 *   without any sleep: a definitive `cancelled` answer proves no dispatch can
 *   follow within this submission's race, and a lost cancellation is reported
 *   as `unknown` rather than as a failure the caller could act on. The
 *   arbitration is scoped to that race under the trust boundary below; it is
 *   not durable settlement across a crashed and resurrected daemon.
 * - Documents live in an owner-only (`0700`) directory below the agent
 *   directory, are bounded, and are rejected unless they are ordinary regular
 *   files. This matches the product's existing same-UID local trust boundary;
 *   it is not a defence against a hostile process running as the same user.
 * - Only identifiers travel through the channel. Tokens, message bodies, and
 *   control secrets are never written here.
 *
 * The channel proves *correlation*, never authorship: every field a response
 * echoes is copied verbatim out of the plaintext request published beside it,
 * so a definitive answer is only actionable once the caller corroborates the
 * mutation against an authority outside this directory.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@gajae-code/utils";
import { type ChatDaemonKind, chatDaemonPaths } from "./chat-daemon-control";

export const CHAT_DAEMON_COMMAND_VERSION = 1;
export const DEFAULT_CHAT_DAEMON_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 25;
/** How long a completed response and an expired request stay readable before sweeping. */
const COMMAND_RETENTION_MS = 60_000;
const DEFAULT_REQUEST_TTL_MS = 30_000;
/** Bounded wait for a daemon that won the response claim before the submitter gave up. */
const DEFAULT_SETTLE_GRACE_MS = 5_000;
const REQUEST_SUFFIX = ".request.json";
const RESPONSE_SUFFIX = ".response.json";
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_COMMAND_FIELD_LENGTH = 256;
/** Command documents are identifiers only; anything larger is not ours. */
const MAX_COMMAND_ENTRY_BYTES = 8 * 1024;
const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;

export type ChatDaemonCommandName = "bind-thread";
export type ChatDaemonCommandStatus = "ok" | "rejected" | "owner_changed" | "expired" | "outcome_unknown";

/** Exact owner authority a request is addressed to. */
export interface ChatDaemonCommandOwner {
	ownerId: string;
	pid: number;
	incarnation: string;
	generation: number;
}

export interface ChatDaemonCommandRequest extends ChatDaemonCommandOwner {
	version: typeof CHAT_DAEMON_COMMAND_VERSION;
	requestId: string;
	kind: ChatDaemonKind;
	command: ChatDaemonCommandName;
	sessionId: string;
	rootTs: string;
	createdAt: number;
	expiresAt: number;
}

/**
 * The answer to exactly one request.
 *
 * The owner tuple, session, and root are the *addressed* request's, echoed
 * verbatim. A response therefore carries the complete request envelope, and a
 * submitter can prove that the document in front of it is correlated with its
 * own request rather than with a replayed or concurrent one.
 *
 * That is correlation, not authentication. Every echoed field is public: it is
 * copied out of the plaintext request published in the same command directory,
 * so a stale or planted document can satisfy the envelope without the addressed
 * daemon ever running. A caller that needs a definitive outcome must corroborate
 * it against an authority outside this directory (the durable mutation itself).
 */
export interface ChatDaemonCommandResponse extends ChatDaemonCommandOwner {
	version: typeof CHAT_DAEMON_COMMAND_VERSION;
	requestId: string;
	kind: ChatDaemonKind;
	command: ChatDaemonCommandName;
	sessionId: string;
	rootTs: string;
	status: ChatDaemonCommandStatus;
	/** Machine-readable rejection category; never a message body or credential. */
	code?: string;
	endpointGeneration?: number;
	teamId?: string;
	channelId?: string;
	completedAt: number;
}

/**
 * Result of one handler dispatch, carrying explicit commit certainty.
 *
 * A failure is never just a code. `rejected` asserts that no mapping changed, so
 * the caller may be told the binding definitively failed. `unknown` asserts the
 * opposite: commit authority was exercised and the mapping may already be
 * applied, so no definitive rejection may be reported for it. Handlers state
 * this directly instead of leaving the channel to infer it from error text.
 */
export type ChatDaemonCommandOutcome =
	| {
			ok: true;
			sessionId: string;
			endpointGeneration: number;
			teamId: string;
			channelId: string;
			rootTs: string;
	  }
	| { ok: false; certainty: "rejected"; code: string }
	| { ok: false; certainty: "unknown"; code: string };

export interface ChatDaemonCommandBindInput {
	sessionId: string;
	rootTs: string;
	/**
	 * Terminal authority for this exact request. It must be awaited inside the
	 * store fence, immediately before the commit, and the commit must be
	 * abandoned when it answers `false`. It re-proves the exact daemon owner
	 * tuple, that the request is still published and unexpired, and takes the
	 * single-winner response claim, after which no cancellation can succeed.
	 */
	commitAuthority?: () => Promise<boolean>;
}

/** Daemon-side executor. Implemented by the runtime that owns the live transports. */
export interface ChatDaemonCommandHandler {
	bindExistingRoot(input: ChatDaemonCommandBindInput): Promise<ChatDaemonCommandOutcome>;
}

function requestEntry(requestId: string): string {
	return `${requestId}${REQUEST_SUFFIX}`;
}

function responseEntry(requestId: string): string {
	return `${requestId}${RESPONSE_SUFFIX}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_COMMAND_FIELD_LENGTH;
}

function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isChatDaemonCommandRequest(value: unknown): value is ChatDaemonCommandRequest {
	if (!isRecord(value)) return false;
	return (
		value.version === CHAT_DAEMON_COMMAND_VERSION &&
		typeof value.requestId === "string" &&
		REQUEST_ID_PATTERN.test(value.requestId) &&
		(value.kind === "discord" || value.kind === "slack") &&
		value.command === "bind-thread" &&
		boundedString(value.ownerId) &&
		positiveInteger(value.pid) &&
		boundedString(value.incarnation) &&
		typeof value.generation === "number" &&
		Number.isSafeInteger(value.generation) &&
		value.generation >= 0 &&
		boundedString(value.sessionId) &&
		boundedString(value.rootTs) &&
		typeof value.createdAt === "number" &&
		Number.isFinite(value.createdAt) &&
		typeof value.expiresAt === "number" &&
		Number.isFinite(value.expiresAt)
	);
}

export function isChatDaemonCommandResponse(value: unknown): value is ChatDaemonCommandResponse {
	if (!isRecord(value)) return false;
	return (
		value.version === CHAT_DAEMON_COMMAND_VERSION &&
		typeof value.requestId === "string" &&
		REQUEST_ID_PATTERN.test(value.requestId) &&
		(value.kind === "discord" || value.kind === "slack") &&
		value.command === "bind-thread" &&
		boundedString(value.ownerId) &&
		positiveInteger(value.pid) &&
		boundedString(value.incarnation) &&
		typeof value.generation === "number" &&
		Number.isSafeInteger(value.generation) &&
		(value.status === "ok" ||
			value.status === "rejected" ||
			value.status === "owner_changed" ||
			value.status === "expired" ||
			value.status === "outcome_unknown") &&
		(value.code === undefined || boundedString(value.code)) &&
		boundedString(value.sessionId) &&
		boundedString(value.rootTs) &&
		(value.endpointGeneration === undefined || positiveInteger(value.endpointGeneration)) &&
		(value.teamId === undefined || boundedString(value.teamId)) &&
		(value.channelId === undefined || boundedString(value.channelId)) &&
		typeof value.completedAt === "number" &&
		Number.isFinite(value.completedAt)
	);
}

/** Two request documents describe the same authorization only when every field agrees. */
function isSameChatDaemonCommandRequest(left: ChatDaemonCommandRequest, right: ChatDaemonCommandRequest): boolean {
	return (
		left.version === right.version &&
		left.requestId === right.requestId &&
		left.kind === right.kind &&
		left.command === right.command &&
		left.ownerId === right.ownerId &&
		left.pid === right.pid &&
		left.incarnation === right.incarnation &&
		left.generation === right.generation &&
		left.sessionId === right.sessionId &&
		left.rootTs === right.rootTs &&
		left.createdAt === right.createdAt &&
		left.expiresAt === right.expiresAt
	);
}

/**
 * A response may influence caller behaviour only when its complete envelope is
 * the request's own.
 *
 * This runs *before* any status is interpreted. A document that agrees on the
 * request id but disagrees on the addressed daemon tuple, the command, or the
 * session/root binding is stale or planted material: it is neither a success
 * nor a trusted business rejection, and it is never allowed to settle the
 * submission as an answer.
 */
function answersRequest(response: ChatDaemonCommandResponse, request: ChatDaemonCommandRequest): boolean {
	return (
		response.version === request.version &&
		response.requestId === request.requestId &&
		response.kind === request.kind &&
		response.command === request.command &&
		response.ownerId === request.ownerId &&
		response.pid === request.pid &&
		response.incarnation === request.incarnation &&
		response.generation === request.generation &&
		response.sessionId === request.sessionId &&
		response.rootTs === request.rootTs
	);
}

/** Entry names are built from validated request ids; reject anything that could traverse. */
function assertSafeEntryName(name: string): string {
	if (
		name.length === 0 ||
		name.length > 128 ||
		name.includes("/") ||
		name.includes("\\") ||
		name.includes("\0") ||
		name === "." ||
		name === ".."
	)
		throw new Error("chat daemon command entry name is not addressable");
	return name;
}

/**
 * The owner-only directory the channel exchanges its documents in.
 *
 * `directory` is a plain pathname: this codebase already trusts same-UID local
 * processes, and every document below it is bounded and validated, so the
 * channel does not attempt hostile-filesystem hardening it cannot honestly
 * provide from TypeScript.
 */
export interface ChatDaemonCommandScope {
	readonly directory: string;
}

export interface OpenChatDaemonCommandScopeInput {
	agentDir: string;
	kind: ChatDaemonKind;
	/** Creates the daemon and command directories owner-only when absent. */
	create?: boolean;
}

/** Capture the command directory, or report the channel unusable. */
export async function openChatDaemonCommandScope(
	input: OpenChatDaemonCommandScopeInput,
): Promise<ChatDaemonCommandScope | undefined> {
	const directory = path.join(chatDaemonPaths(input.agentDir, input.kind).dir, "commands");
	try {
		if (input.create === true) {
			await fs.mkdir(directory, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE });
			await fs.chmod(directory, OWNER_ONLY_DIRECTORY_MODE);
		}
		const stats = await fs.lstat(directory);
		if (!stats.isDirectory()) return undefined;
		return { directory };
	} catch {
		return undefined;
	}
}

function entryPath(scope: ChatDaemonCommandScope, name: string): string {
	return path.join(scope.directory, assertSafeEntryName(name));
}

async function listScopedEntries(scope: ChatDaemonCommandScope): Promise<string[]> {
	try {
		return await fs.readdir(scope.directory);
	} catch {
		return [];
	}
}

/**
 * Read one bounded regular-file document.
 *
 * A symlink, directory, FIFO, device, or oversized entry is not a command
 * document and never becomes one: it is reported as absent rather than opened.
 */
async function readScopedJson(scope: ChatDaemonCommandScope, name: string): Promise<unknown> {
	const file = entryPath(scope, name);
	try {
		const stats = await fs.lstat(file);
		if (!stats.isFile() || stats.size > MAX_COMMAND_ENTRY_BYTES) return undefined;
		const text = await fs.readFile(file, "utf8");
		if (text.length === 0) return undefined;
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** Age of an entry by its own (non-dereferenced) mtime, used only for retention sweeps. */
async function scopedEntryAgeMs(scope: ChatDaemonCommandScope, name: string, now: number): Promise<number | undefined> {
	try {
		return now - (await fs.lstat(entryPath(scope, name))).mtimeMs;
	} catch {
		return undefined;
	}
}

async function scopedEntryExists(scope: ChatDaemonCommandScope, name: string): Promise<boolean> {
	try {
		await fs.lstat(entryPath(scope, name));
		return true;
	} catch (error) {
		// An entry that cannot be classified is treated as present so nothing
		// downstream proceeds on an unproven path.
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
}

/**
 * Create an entry exclusively.
 *
 * `O_CREAT|O_EXCL` is the arbitration primitive of this channel: exactly one of
 * the submitter and the serving daemon can create a given response object, and
 * the loser learns it definitively through `exists`.
 */
async function claimScopedEntry(scope: ChatDaemonCommandScope, name: string): Promise<boolean> {
	try {
		const handle = await fs.open(entryPath(scope, name), "wx", OWNER_ONLY_FILE_MODE);
		await handle.close();
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EEXIST") return false;
		throw new Error(`chat daemon command entry could not be claimed (${code ?? "unknown"})`);
	}
}

async function writeTemporary(scope: ChatDaemonCommandScope, value: unknown): Promise<string> {
	const temporary = path.join(scope.directory, `${process.pid}.${crypto.randomUUID()}.tmp`);
	const text = `${JSON.stringify(value)}\n`;
	if (new TextEncoder().encode(text).byteLength > MAX_COMMAND_ENTRY_BYTES)
		throw new Error("chat daemon command document is not bounded");
	await fs.writeFile(temporary, text, { mode: OWNER_ONLY_FILE_MODE, flag: "wx" });
	return temporary;
}

/** Replace an entry atomically. The document is complete before it is ever visible. */
async function writeScopedJson(scope: ChatDaemonCommandScope, name: string, value: unknown): Promise<void> {
	const target = entryPath(scope, name);
	const temporary = await writeTemporary(scope, value);
	try {
		await fs.rename(temporary, target);
	} catch (error) {
		await fs.unlink(temporary).catch(() => undefined);
		throw error;
	}
}

/**
 * Publish an entry that must not already exist.
 *
 * `link()` from a fully written temporary makes the document atomically visible
 * under its final name and fails `exists` when the name is taken, so a replayed
 * or planted identifier can never be silently overwritten.
 */
async function publishScopedJsonExclusive(
	scope: ChatDaemonCommandScope,
	name: string,
	value: unknown,
): Promise<"published" | "exists"> {
	const target = entryPath(scope, name);
	const temporary = await writeTemporary(scope, value);
	try {
		await fs.link(temporary, target);
		return "published";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
		throw error;
	} finally {
		await fs.unlink(temporary).catch(() => undefined);
	}
}

/** Returns whether the entry is gone: unlinked now, or already absent. */
async function unlinkScopedEntry(scope: ChatDaemonCommandScope, name: string): Promise<boolean> {
	try {
		await fs.unlink(entryPath(scope, name));
		return true;
	} catch (error) {
		return isEnoent(error);
	}
}

/**
 * Single-winner terminal authority for one request.
 *
 * The claim is the exclusive creation of `<id>.response.json`. Acquiring it is
 * idempotent within a serve, and losing it is permanent for that request: the
 * submitter cancelled, so nothing may be committed or published afterwards.
 *
 * A holder that then discovers it must not act releases the claim instead of
 * publishing, so an abandoned command leaves no orphan behind.
 */
class ChatDaemonResponseClaim {
	#scope: ChatDaemonCommandScope;
	#entry: string;
	#state: "unclaimed" | "held" | "lost" = "unclaimed";

	constructor(scope: ChatDaemonCommandScope, requestId: string) {
		this.#scope = scope;
		this.#entry = responseEntry(requestId);
	}

	get held(): boolean {
		return this.#state === "held";
	}

	async acquire(): Promise<boolean> {
		if (this.#state !== "unclaimed") return this.#state === "held";
		try {
			this.#state = (await claimScopedEntry(this.#scope, this.#entry)) ? "held" : "lost";
		} catch {
			this.#state = "lost";
		}
		return this.#state === "held";
	}

	async release(): Promise<void> {
		if (this.#state !== "held") return;
		this.#state = "lost";
		await unlinkScopedEntry(this.#scope, this.#entry);
	}

	async publish(response: ChatDaemonCommandResponse): Promise<void> {
		if (!(await this.acquire())) return;
		await writeScopedJson(this.#scope, this.#entry, response);
	}
}

/** Build a request addressed to one exact owner. */
export function buildChatDaemonCommandRequest(input: {
	kind: ChatDaemonKind;
	command: ChatDaemonCommandName;
	owner: ChatDaemonCommandOwner;
	sessionId: string;
	rootTs: string;
	now?: number;
	ttlMs?: number;
	requestId?: string;
}): ChatDaemonCommandRequest {
	const createdAt = input.now ?? Date.now();
	return {
		version: CHAT_DAEMON_COMMAND_VERSION,
		requestId: input.requestId ?? crypto.randomUUID(),
		kind: input.kind,
		command: input.command,
		ownerId: input.owner.ownerId,
		pid: input.owner.pid,
		incarnation: input.owner.incarnation,
		generation: input.owner.generation,
		sessionId: input.sessionId,
		rootTs: input.rootTs,
		createdAt,
		expiresAt: createdAt + (input.ttlMs ?? DEFAULT_REQUEST_TTL_MS),
	};
}

export interface SubmitChatDaemonCommandInput {
	agentDir: string;
	kind: ChatDaemonKind;
	owner: ChatDaemonCommandOwner;
	command: ChatDaemonCommandName;
	sessionId: string;
	rootTs: string;
	timeoutMs?: number;
	pollIntervalMs?: number;
	/** Bounded wait after a lost cancellation, before the outcome is reported unknown. */
	settleGraceMs?: number;
	ttlMs?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	requestId?: string;
}

/**
 * Terminal result of one submission.
 *
 * `cancelled` is the only definitive failure: the submitter won the response
 * claim, so the addressed owner cannot dispatch this request from here on within
 * this submission's race. `unknown` means the daemon won that claim first and its
 * answer was not observed; the caller must not report a definitive failure,
 * because a commit may already be applied.
 *
 * `untrusted` means the response object under this identifier is a complete,
 * well-formed document that does not carry this request's envelope. It is
 * channel corruption — stale or planted — so it may not be read as an answer of
 * any status, and because the identifier is now occupied the real outcome is
 * unknowable from here; the caller must treat it exactly like `unknown`.
 */
export type ChatDaemonCommandSubmission =
	| { outcome: "answered"; response: ChatDaemonCommandResponse }
	| { outcome: "cancelled" }
	| { outcome: "unknown" }
	| { outcome: "untrusted"; code: "response_envelope_mismatch" }
	| { outcome: "unavailable"; code: "command_channel_unavailable" | "request_id_unavailable" };

/**
 * Publish a command for the addressed owner and wait for its answer.
 *
 * The wait ends in exactly one of four states, and the commit-vs-timeout race is
 * arbitrated by the exclusive creation of the response object rather than by any
 * timing assumption.
 */
export async function submitChatDaemonCommand(
	input: SubmitChatDaemonCommandInput,
): Promise<ChatDaemonCommandSubmission> {
	const scope = await openChatDaemonCommandScope({ agentDir: input.agentDir, kind: input.kind, create: true });
	if (!scope) return { outcome: "unavailable", code: "command_channel_unavailable" };
	return await submitAgainstScope(scope, input);
}

async function submitAgainstScope(
	scope: ChatDaemonCommandScope,
	input: SubmitChatDaemonCommandInput,
): Promise<ChatDaemonCommandSubmission> {
	const now = input.now ?? Date.now;
	const sleep = input.sleep ?? (async ms => await Bun.sleep(ms));
	const timeoutMs = Math.max(input.timeoutMs ?? DEFAULT_CHAT_DAEMON_COMMAND_TIMEOUT_MS, 0);
	const pollIntervalMs = Math.max(input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, 1);
	const settleGraceMs = Math.max(input.settleGraceMs ?? DEFAULT_SETTLE_GRACE_MS, 0);
	const request = buildChatDaemonCommandRequest({
		kind: input.kind,
		command: input.command,
		owner: input.owner,
		sessionId: input.sessionId,
		rootTs: input.rootTs,
		now: now(),
		ttlMs: input.ttlMs ?? Math.max(timeoutMs * 2, DEFAULT_REQUEST_TTL_MS),
		requestId: input.requestId,
	});
	const requestName = requestEntry(request.requestId);
	const responseName = responseEntry(request.requestId);
	// Stale or planted material under this identifier must neither authorize an
	// answer nor silently suppress the command: the submission fails closed and
	// the caller re-runs with a fresh identifier.
	if (await scopedEntryExists(scope, responseName)) return { outcome: "unavailable", code: "request_id_unavailable" };
	let published: "published" | "exists";
	try {
		published = await publishScopedJsonExclusive(scope, requestName, request);
	} catch {
		return { outcome: "unavailable", code: "command_channel_unavailable" };
	}
	if (published === "exists") return { outcome: "unavailable", code: "request_id_unavailable" };
	try {
		const answered = await awaitChatDaemonCommandResponse({
			scope,
			request,
			responseName,
			deadline: now() + timeoutMs,
			now,
			sleep,
			pollIntervalMs,
		});
		if (answered.kind === "untrusted") return { outcome: "untrusted", code: "response_envelope_mismatch" };
		if (answered.kind === "answer") return { outcome: "answered", response: answered.response };
		// Winning the response claim makes a dispatch by the addressed owner
		// impossible for the rest of this submission's race, which is what turns a
		// timeout into a definitive, mutation-free failure without a sleep.
		if (await claimScopedEntry(scope, responseName)) return { outcome: "cancelled" };
		const settled = await awaitChatDaemonCommandResponse({
			scope,
			request,
			responseName,
			deadline: now() + settleGraceMs,
			now,
			sleep,
			pollIntervalMs,
		});
		if (settled.kind === "untrusted") return { outcome: "untrusted", code: "response_envelope_mismatch" };
		return settled.kind === "answer" ? { outcome: "answered", response: settled.response } : { outcome: "unknown" };
	} finally {
		// Order matters: the request is retired before the settled response
		// object. A daemon that re-creates a removed response claim then proves
		// the request is gone and abandons, so no *later dispatch* can follow a
		// settled submission.
		//
		// The scope of that guarantee is exactly this submission's race against a
		// concurrent serve, under the same-UID trusted-pathname model documented
		// at the top of this module. It is not durable settlement: it says nothing
		// about a daemon that crashed mid-commit and is resurrected against
		// replayed material, and nothing about a same-UID process that rewrites
		// these documents. Both are out of scope here, and neither is what a
		// caller may rely on for commit certainty — that comes only from
		// corroborating the mutation itself.
		// The response claim is what fences an already-settled request: a serve
		// that finds no response entry re-claims the request and commits it. So the
		// claim may only be released once the request is *proven* gone. When the
		// request unlink fails the claim is deliberately left behind — a leaked
		// response object is inert, whereas releasing it would let a submission the
		// caller was told was `cancelled` commit later.
		if (await unlinkScopedEntry(scope, requestName)) await unlinkScopedEntry(scope, responseName);
	}
}

/** What one poll of the response object proved: an answer, corruption, or nothing yet. */
type ChatDaemonResponseObservation =
	| { kind: "answer"; response: ChatDaemonCommandResponse }
	| { kind: "untrusted" }
	| { kind: "pending" };

async function awaitChatDaemonCommandResponse(input: {
	scope: ChatDaemonCommandScope;
	request: ChatDaemonCommandRequest;
	responseName: string;
	deadline: number;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	pollIntervalMs: number;
}): Promise<ChatDaemonResponseObservation> {
	for (;;) {
		const document = await readScopedJson(input.scope, input.responseName);
		if (document !== undefined) {
			// An empty or unclassifiable entry is the in-flight claim placeholder and
			// must keep the caller waiting. Any *complete* document is terminal
			// material: either it is this request's exact answer, or it is stale or
			// planted content that can never become one, and waiting for the deadline
			// would only delay a fail-closed report.
			if (!isChatDaemonCommandResponse(document) || !answersRequest(document, input.request))
				return { kind: "untrusted" };
			return { kind: "answer", response: document };
		}
		if (input.now() >= input.deadline) return { kind: "pending" };
		await input.sleep(input.pollIntervalMs);
	}
}

export interface ServeChatDaemonCommandsInput {
	agentDir: string;
	kind: ChatDaemonKind;
	/** The serving daemon's own proven authority. */
	ownerId: string;
	pid: number;
	incarnation: string;
	generation: number;
	handler: ChatDaemonCommandHandler;
	/**
	 * Re-proves that this process still holds the persisted owner record. It is
	 * checked before any work is dispatched *and again* inside the commit fence,
	 * so a daemon that lost ownership after dispatch mutates nothing.
	 */
	verifyOwnership?: () => Promise<boolean>;
	now?: () => number;
}

/**
 * Answer every pending request addressed to this exact owner. Requests aimed at
 * any other owner identity are answered `owner_changed` without doing work, and
 * expired requests are answered `expired`; neither performs a mutation.
 */
export async function serveChatDaemonCommandsOnce(input: ServeChatDaemonCommandsInput): Promise<number> {
	const scope = await openChatDaemonCommandScope({ agentDir: input.agentDir, kind: input.kind });
	if (!scope) return 0;
	return await serveChatDaemonCommandsAgainstScope(scope, input);
}

/**
 * Answer every pending request against an already-captured command scope.
 *
 * Exposed so a caller that already holds the directory authority drives exactly
 * the production path.
 */
export async function serveChatDaemonCommandsAgainstScope(
	scope: ChatDaemonCommandScope,
	input: ServeChatDaemonCommandsInput,
): Promise<number> {
	const now = input.now ?? Date.now;
	let served = 0;
	for (const name of await listScopedEntries(scope)) {
		if (name.endsWith(RESPONSE_SUFFIX)) {
			await sweepCompletedResponse(scope, name, now());
			continue;
		}
		if (!name.endsWith(REQUEST_SUFFIX)) continue;
		const requestId = name.slice(0, -REQUEST_SUFFIX.length);
		if (!REQUEST_ID_PATTERN.test(requestId)) continue;
		const request = await readScopedJson(scope, name);
		if (!isChatDaemonCommandRequest(request) || request.requestId !== requestId || request.kind !== input.kind) {
			await unlinkScopedEntry(scope, name);
			continue;
		}
		// A response object already exists for this identifier: the request is a
		// replay of settled material, the submitter cancelled, or a stale/planted
		// answer occupies the name. Either way this request may never authorize
		// work, and a definitive answer for it was already reported elsewhere.
		if (await scopedEntryExists(scope, responseEntry(requestId))) {
			if (request.expiresAt + COMMAND_RETENTION_MS <= now()) await unlinkScopedEntry(scope, name);
			continue;
		}
		const claim = new ChatDaemonResponseClaim(scope, requestId);
		const answered = await answerChatDaemonCommand({ request, input, scope, claim, now: now() });
		await claim.publish(answered);
		await unlinkScopedEntry(scope, name);
		served++;
	}
	return served;
}

/** Why the commit fence refused, so the answer names the real authority failure. */
type CommitFenceFailure = "owner_changed" | "cancelled" | "abandoned";

async function answerChatDaemonCommand(context: {
	request: ChatDaemonCommandRequest;
	input: ServeChatDaemonCommandsInput;
	scope: ChatDaemonCommandScope;
	claim: ChatDaemonResponseClaim;
	now: number;
}): Promise<ChatDaemonCommandResponse> {
	const { request, input, scope, claim } = context;
	const now = input.now ?? Date.now;
	// Every answer echoes the *addressed* request envelope, not the responding
	// process's own identity. That is what lets a submitter validate the complete
	// tuple before it interprets any status: an `owner_changed` answer published
	// by a replacement daemon is still provably the answer to this request, while
	// a document carrying some other tuple is provably not.
	const envelope = {
		version: CHAT_DAEMON_COMMAND_VERSION,
		requestId: request.requestId,
		kind: request.kind,
		command: request.command,
		ownerId: request.ownerId,
		pid: request.pid,
		incarnation: request.incarnation,
		generation: request.generation,
		sessionId: request.sessionId,
		rootTs: request.rootTs,
		completedAt: context.now,
	} as const;
	if (
		request.ownerId !== input.ownerId ||
		request.pid !== input.pid ||
		request.incarnation !== input.incarnation ||
		request.generation !== input.generation
	)
		return { ...envelope, status: "owner_changed" };
	if (request.expiresAt <= context.now) return { ...envelope, status: "expired" };
	// Ownership can lapse between capture and execution. Re-prove it here so a
	// daemon that no longer holds the owner record performs no mutation.
	if (input.verifyOwnership && !(await input.verifyOwnership())) return { ...envelope, status: "owner_changed" };
	let fenceFailure: CommitFenceFailure | undefined;
	/**
	 * The commit fence. It runs inside the caller's store lock, immediately
	 * before the mutation, and every check is local: the persisted owner record,
	 * the single-winner claim, then the still-published request material.
	 *
	 * The claim is taken *before* the request is re-read on purpose. A submitter
	 * that gives up claims the response, then removes its request and its own
	 * claim; taking the claim first and only then proving the request is still
	 * published closes the window in which a daemon could re-create the removed
	 * claim and commit behind a caller that already reported cancellation.
	 */
	const commitAuthority = async (): Promise<boolean> => {
		if (input.verifyOwnership && !(await input.verifyOwnership())) {
			fenceFailure = "owner_changed";
			return false;
		}
		if (!(await claim.acquire())) {
			fenceFailure = "cancelled";
			return false;
		}
		const current = await readScopedJson(scope, requestEntry(request.requestId));
		if (
			!isChatDaemonCommandRequest(current) ||
			!isSameChatDaemonCommandRequest(current, request) ||
			current.expiresAt <= now()
		) {
			fenceFailure = "abandoned";
			return false;
		}
		return true;
	};
	const answer = await dispatchChatDaemonCommand({
		input,
		request,
		envelope,
		commitAuthority,
		claim,
		fenceFailure: () => fenceFailure,
	});
	// An abandoned request has no reader left: its submitter already settled.
	// Release the claim rather than publishing an answer nobody can consume.
	if (fenceFailure === "abandoned") await claim.release();
	return answer;
}

async function dispatchChatDaemonCommand(context: {
	input: ServeChatDaemonCommandsInput;
	request: ChatDaemonCommandRequest;
	envelope: Omit<ChatDaemonCommandResponse, "status">;
	commitAuthority: () => Promise<boolean>;
	claim: ChatDaemonResponseClaim;
	fenceFailure: () => CommitFenceFailure | undefined;
}): Promise<ChatDaemonCommandResponse> {
	const { envelope, claim } = context;
	// Whether the fence ever handed out commit authority. Once it has, the
	// handler may have applied a mapping, and an exception carries no evidence
	// either way — so a thrown failure after that point is indeterminate, not a
	// rejection the caller may act on.
	let authorized = false;
	const commitAuthority = async (): Promise<boolean> => {
		const granted = await context.commitAuthority();
		authorized = authorized || granted;
		return granted;
	};
	let outcome: ChatDaemonCommandOutcome;
	try {
		outcome = await context.input.handler.bindExistingRoot({
			sessionId: context.request.sessionId,
			rootTs: context.request.rootTs,
			commitAuthority,
		});
	} catch {
		outcome = authorized
			? { ok: false, certainty: "unknown", code: "binding_outcome_unknown" }
			: { ok: false, certainty: "rejected", code: "binding_failed" };
	}
	if (!outcome.ok) {
		// A handler that reports an indeterminate commit outranks everything: the
		// mapping may already be applied, so no definitive answer may be published.
		if (outcome.certainty === "unknown") return { ...envelope, status: "outcome_unknown", code: outcome.code };
		// The fence is the authority on *why* a refused commit was refused: a
		// handler-level error text can never outrank a proven authority change.
		const failure = context.fenceFailure();
		if (failure === "owner_changed") return { ...envelope, status: "owner_changed" };
		if (failure !== undefined) return { ...envelope, status: "expired" };
		return { ...envelope, status: "rejected", code: outcome.code };
	}
	// A success is only reportable when this serve holds the terminal claim; a
	// handler that never passed the fence has not proven exact commit authority.
	if (!claim.held) return { ...envelope, status: "rejected", code: "commit_authority_missing" };
	// The answer must describe the binding that was asked for. A handler that
	// reports some other session or root has not answered this request, and
	// publishing it would produce a document the submitter must reject as
	// untrusted rather than a usable outcome.
	if (outcome.sessionId !== context.request.sessionId || outcome.rootTs !== context.request.rootTs)
		return { ...envelope, status: "rejected", code: "binding_mismatch" };
	return {
		...envelope,
		status: "ok",
		endpointGeneration: outcome.endpointGeneration,
		teamId: outcome.teamId,
		channelId: outcome.channelId,
	};
}

/**
 * Retire one completed response once its retention window has passed.
 *
 * An unparseable entry can be a live claim placeholder held by an in-flight
 * commit, so only age retires it; deleting it early would break arbitration.
 */
async function sweepCompletedResponse(scope: ChatDaemonCommandScope, name: string, now: number): Promise<void> {
	const document = await readScopedJson(scope, name);
	if (isChatDaemonCommandResponse(document)) {
		if (now - document.completedAt >= COMMAND_RETENTION_MS) await unlinkScopedEntry(scope, name);
		return;
	}
	const age = await scopedEntryAgeMs(scope, name, now);
	if (age !== undefined && age >= COMMAND_RETENTION_MS) await unlinkScopedEntry(scope, name);
}
