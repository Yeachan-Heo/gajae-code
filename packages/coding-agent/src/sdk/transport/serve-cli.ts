import * as crypto from "node:crypto";
import { getAgentDir } from "@gajae-code/utils";
import { CliParseError } from "@gajae-code/utils/cli";
import { normalizeBrokerInput } from "../broker/broker";
import type { BrokerDiscovery } from "../broker/discovery";
import { lifecycleRequestTimeoutMs } from "../broker/startup-budget";
import { readSdkBrokerDiscovery, SdkClient, SdkClientError, SdkDiscoveryError } from "../client";
import { SessionListTraversalError, sessionListPageFromResponse, traverseSessionList } from "../session-list";
import { DEFAULT_PENDING_CEILING_BYTES, MIN_PENDING_CEILING_BYTES, startSocketServe, startStdioServe } from "./index";

type ServeMode = { kind: "stdio" } | { kind: "socket"; socketPath: string };

interface ServeArguments {
	mode: ServeMode;
	sessionId?: string;
	pendingCeiling?: string;
}

function usageError(message: string): never {
	throw new CliParseError(`gjc sdk serve: ${message}`);
}

/**
 * A `gjc sdk serve` operational failure with a stable machine-readable code and a
 * documented exit code, mirroring `SdkSessionCliError`. Usage errors keep their own
 * `CliParseError` path; this type covers only failures an embedder must branch on.
 */
export class SdkServeError extends Error {
	/**
	 * Diagnostics for a broker-teardown failure that happened alongside this primary
	 * failure. It rides beside `details` rather than inside it because `details`
	 * carries the broker's own error payload verbatim and embedders already read it.
	 */
	cleanupError?: { code: string; message: string };

	constructor(
		readonly code: string,
		message: string,
		readonly exitCode: 1,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "SdkServeError";
	}
}

/** Normalizes a serve-path failure into a typed error so nothing escapes untyped. */
function toServeError(error: unknown): Error {
	if (error instanceof SdkServeError || error instanceof CliParseError) return error;
	if (error instanceof SdkClientError) return new SdkServeError(error.code, error.message, 1, error.details);
	return new SdkServeError("serve_failed", error instanceof Error ? error.message : "SDK serve failed.", 1);
}

/**
 * Reads the broker discovery record so an unreadable one — a permission or file-kind
 * failure, or a record from a newer state version — fails as a typed serve error
 * instead of escaping the command boundary untyped. A missing record still reads as
 * `null`, which the caller reports as `broker_unavailable`.
 */
async function readServeDiscovery(agentDir: string): Promise<BrokerDiscovery | null> {
	try {
		return await readSdkBrokerDiscovery(agentDir);
	} catch (error) {
		// The path is a local file inside the agent dir, already named by this
		// command's other diagnostics; the broker token is never surfaced.
		const details =
			error instanceof SdkDiscoveryError
				? { code: error.code, message: error.message, path: error.path }
				: { code: "discovery_error", message: error instanceof Error ? error.message : String(error) };
		throw new SdkServeError("broker_discovery_unreadable", "SDK broker discovery record is unreadable", 1, details);
	}
}

/** Reduces a teardown failure to the code and message an embedder can branch on. */
function cleanupDiagnostics(error: Error): { code: string; message: string } {
	return { code: error instanceof SdkClientError ? error.code : "serve_cleanup_failed", message: error.message };
}

/** Runs broker teardown to completion, handing back its failure instead of throwing it. */
async function brokerCloseFailure(broker: SdkClient): Promise<Error | undefined> {
	try {
		await broker.close();
		return undefined;
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
}

/**
 * Combines the serve body's failure with the broker-teardown failure. The primary
 * failure always wins — a rejected teardown only ever rides along as diagnostics, it
 * never replaces the error an embedder branches on — and a teardown that fails on its
 * own still leaves typed. Exported for tests.
 */
export function resolveServeOutcome(primary: Error | undefined, cleanup: Error | undefined): Error | undefined {
	if (primary) {
		if (cleanup && primary instanceof SdkServeError) primary.cleanupError = cleanupDiagnostics(cleanup);
		return primary;
	}
	if (!cleanup) return undefined;
	const diagnostics = cleanupDiagnostics(cleanup);
	return new SdkServeError("serve_cleanup_failed", `SDK broker cleanup failed: ${cleanup.message}`, 1, diagnostics);
}

function readFlagValue(argv: string[], index: number, flag: string): string {
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("-")) usageError(`${flag} requires a value`);
	return value;
}

function parseServeArguments(argv: string[]): ServeArguments {
	let stdio = false;
	let socketPath: string | undefined;
	let sessionId: string | undefined;
	let pendingCeiling: string | undefined;
	for (let index = 0; index < argv.length; index++) {
		switch (argv[index]) {
			case "--stdio":
				if (stdio) usageError("--stdio may only be specified once");
				stdio = true;
				break;
			case "--socket":
				if (socketPath !== undefined) usageError("--socket may only be specified once");
				socketPath = readFlagValue(argv, index, "--socket");
				index++;
				break;
			case "--session":
				if (sessionId !== undefined) usageError("--session may only be specified once");
				sessionId = readFlagValue(argv, index, "--session");
				index++;
				break;
			case "--pending-ceiling":
				if (pendingCeiling !== undefined) usageError("--pending-ceiling may only be specified once");
				pendingCeiling = readFlagValue(argv, index, "--pending-ceiling");
				index++;
				break;
			default:
				usageError(`unknown argument: ${argv[index]}`);
		}
	}
	if (stdio === (socketPath !== undefined)) usageError("specify exactly one of --stdio or --socket <path>");
	return { mode: stdio ? { kind: "stdio" } : { kind: "socket", socketPath: socketPath! }, sessionId, pendingCeiling };
}

/** Resolves the pending ceiling with flag > env > default precedence; exported for tests. */
export function resolveServePendingCeiling(flagValue: string | undefined, envValue: string | undefined): number {
	const value = flagValue ?? envValue;
	if (value === undefined) return DEFAULT_PENDING_CEILING_BYTES;
	if (!/^\d+$/.test(value)) usageError("--pending-ceiling must be a positive integer");
	const ceiling = Number(value);
	if (!Number.isSafeInteger(ceiling) || ceiling < MIN_PENDING_CEILING_BYTES)
		usageError(`--pending-ceiling must be an integer of at least ${MIN_PENDING_CEILING_BYTES}`);
	return ceiling;
}

type BrokerTranscriptIdentity = {
	dev: string;
	ino: string;
	size: number;
	mtimeMs: number;
	mtimeNs: string;
	sha256: string;
};
type BrokerSavedSession = { id: string; path: string; identity: BrokerTranscriptIdentity };
type BrokerSessionLocator = { cwd: string; worktreeRoot: string | null; stateRoot: string };
type BrokerSessionRow = {
	sessionId: string;
	live: boolean;
	ambiguous: boolean;
	terminal?: boolean;
	hostUnregisteredReason?: "process_exited" | "detached_idle";
	terminalUncertain?: boolean;
	locator?: BrokerSessionLocator;
	savedSession?: BrokerSavedSession;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extracts the broker `result` envelope, converting an explicit error frame into a typed throw. */
function brokerResult(value: unknown): Record<string, unknown> {
	if (isRecord(value) && value.ok === false) {
		const error = isRecord(value.error) ? value.error : {};
		const code = typeof error.code === "string" ? error.code : "unavailable";
		const message = typeof error.message === "string" ? error.message : "SDK broker request failed";
		throw new SdkClientError(code, message, value.error);
	}
	return isRecord(value) && isRecord(value.result) ? value.result : {};
}

function brokerSessionLocator(value: unknown): BrokerSessionLocator | undefined {
	if (!isRecord(value)) return undefined;
	const { cwd, worktreeRoot, stateRoot } = value;
	return typeof cwd === "string" &&
		cwd.length > 0 &&
		(worktreeRoot === null || typeof worktreeRoot === "string") &&
		typeof stateRoot === "string" &&
		stateRoot.length > 0
		? { cwd, worktreeRoot, stateRoot }
		: undefined;
}

function brokerSavedSession(value: unknown): BrokerSavedSession | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || !value.id || typeof value.path !== "string" || !value.path)
		return undefined;
	if (!isRecord(value.identity)) return undefined;
	const { dev, ino, size, mtimeMs, mtimeNs, sha256 } = value.identity;
	if (
		typeof dev !== "string" ||
		!/^[0-9]+$/.test(dev) ||
		typeof ino !== "string" ||
		!/^[0-9]+$/.test(ino) ||
		typeof size !== "number" ||
		!Number.isSafeInteger(size) ||
		size < 0 ||
		typeof mtimeMs !== "number" ||
		!Number.isFinite(mtimeMs) ||
		mtimeMs < 0 ||
		typeof mtimeNs !== "string" ||
		!/^[0-9]+$/.test(mtimeNs) ||
		typeof sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(sha256)
	)
		return undefined;
	return { id: value.id, path: value.path, identity: { dev, ino, size, mtimeMs, mtimeNs, sha256 } };
}

function brokerSessionRows(sessions: readonly unknown[], savedSession?: unknown): BrokerSessionRow[] {
	const pageSavedSession = brokerSavedSession(savedSession);
	return sessions.flatMap(item => {
		if (!isRecord(item) || typeof item.sessionId !== "string" || !item.sessionId) return [];
		const locator = brokerSessionLocator(item.locator);
		const saved = pageSavedSession?.id === item.sessionId ? pageSavedSession : brokerSavedSession(item.savedSession);
		const hostUnregisteredReason =
			item.hostUnregisteredReason === "process_exited" || item.hostUnregisteredReason === "detached_idle"
				? item.hostUnregisteredReason
				: undefined;
		const terminalUncertain = item.terminalUncertain === true || item.terminal_uncertain === true;
		return [
			{
				sessionId: item.sessionId,
				live: item.live === true,
				ambiguous: item.ambiguous === true,
				...(item.terminal === true ? { terminal: true } : {}),
				...(hostUnregisteredReason === undefined ? {} : { hostUnregisteredReason }),
				...(terminalUncertain ? { terminalUncertain: true } : {}),
				...(locator === undefined ? {} : { locator }),
				...(saved === undefined ? {} : { savedSession: saved }),
			},
		];
	});
}

/** Exhausts strict broker `session.list` pages into one full session snapshot. */
export async function listBrokerSessions(
	broker: SdkClient,
	explicitSessionId?: string,
	cwd?: string,
): Promise<BrokerSessionRow[]> {
	try {
		const pages = await traverseSessionList(
			{
				...(explicitSessionId ? { resolveSessionId: explicitSessionId } : {}),
				...(cwd === undefined ? {} : { cwd }),
			},
			async input => await broker.global("session.list", input),
			response => {
				brokerResult(response);
				return sessionListPageFromResponse(response);
			},
		);
		return pages.flatMap(page =>
			brokerSessionRows(page.sessions, isRecord(page.page) ? page.page.savedSession : undefined),
		);
	} catch (error) {
		if (error instanceof SessionListTraversalError) throw new SdkClientError("protocol_error", error.message);
		throw error;
	}
}

function endpointStaleError(sessionId: string): Error {
	// A typed error, because `toServeError` only passes `SdkServeError` through: a plain
	// Error here is rewritten to `serve_failed`, which hides the one code that tells a
	// caller recovery was attempted and the endpoint is still not live.
	return new SdkServeError("endpoint_stale", `session ${sessionId} endpoint is not live`, 1);
}

async function recoverBrokerSession(broker: SdkClient, row: BrokerSessionRow, sessionId: string): Promise<void> {
	const locator = row.locator;
	const authority =
		row.savedSession?.id === sessionId
			? row.savedSession
			: locator === undefined
				? undefined
				: (await listBrokerSessions(broker, sessionId, locator.cwd)).find(
						candidate => candidate.sessionId === sessionId,
					)?.savedSession;
	if (locator === undefined || authority?.id !== sessionId) throw endpointStaleError(sessionId);
	const normalized = normalizeBrokerInput("session.resume", { sessionId, cwd: locator.cwd });
	if (!("input" in normalized)) {
		brokerResult(normalized);
		throw endpointStaleError(sessionId);
	}
	const input = {
		...normalized.input,
		sessionPath: authority.path,
		sessionIdentity: authority.identity,
	};
	const timeoutMs = lifecycleRequestTimeoutMs("session.resume", input);
	brokerResult(
		await broker.global("session.resume", input, {
			idempotencyKey: crypto.randomUUID(),
			...(timeoutMs === undefined ? {} : { timeoutMs }),
		}),
	);
}

/** Resolves an explicit or automatic serve target, reattaching one stale explicit session at most once. */
export async function resolveServeSession(broker: SdkClient, explicitSessionId?: string): Promise<string> {
	const sessions = await listBrokerSessions(broker, explicitSessionId);
	if (explicitSessionId !== undefined) {
		const row = sessions.find(session => session.sessionId === explicitSessionId);
		// An indexed, unambiguous row that is not live is the recoverable
		// self-reap case (#5633). Every other targeting outcome — unindexed,
		// ambiguous, no explicit id — stays the selector's to report, so this
		// decision does not depend on the selector's error text.
		// Recovery requires durable retirement provenance. A non-live row without a terminal
		// retirement event may only have stale heartbeat evidence, which does not prove that the
		// previous host exited and must not authorize a second host for the same transcript.
		if (
			row !== undefined &&
			!row.ambiguous &&
			!row.terminalUncertain &&
			!row.live &&
			row.terminal === true &&
			(row.hostUnregisteredReason === "process_exited" || row.hostUnregisteredReason === "detached_idle")
		) {
			await recoverBrokerSession(broker, row, explicitSessionId);
			return selectBrokerSession(await listBrokerSessions(broker, explicitSessionId), explicitSessionId);
		}
	}
	return selectBrokerSession(sessions, explicitSessionId);
}

/** Selects the session to serve through broker `session.list` truth (C10); exported for tests. */
export function selectBrokerSession(sessions: BrokerSessionRow[], explicitSessionId: string | undefined): string {
	if (explicitSessionId !== undefined) {
		const row = sessions.find(session => session.sessionId === explicitSessionId);
		if (!row) throw new SdkServeError("not_found", `session ${explicitSessionId} is not indexed by the broker`, 1);
		if (row.ambiguous) throw new SdkServeError("ambiguous_session", "session id maps to more than one state root", 1);
		if (row.terminalUncertain)
			throw new SdkServeError("terminal_uncertain", `session ${explicitSessionId} ownership is uncertain`, 1);
		if (!row.live) throw new SdkServeError("endpoint_stale", `session ${explicitSessionId} endpoint is not live`, 1);
		return row.sessionId;
	}
	const live = sessions.filter(session => session.live && !session.ambiguous && !session.terminalUncertain);
	if (live.length === 0) throw new SdkServeError("no_live_endpoint", "no live session endpoint", 1);
	if (live.length > 1)
		throw new SdkServeError("multiple_live_endpoints", "more than one live session; specify --session <id>", 1);
	return live[0]!.sessionId;
}

/**
 * Attaches a stdio or Unix-socket relay to one live SDK session endpoint.
 * Session targeting is broker-bound (C10): `session.list` resolves the session
 * and `session.get_endpoint` mints the exact credential — never a direct
 * endpoint-file read. A missing or unreachable broker fails closed.
 */
export async function runSdkServe(argv: string[]): Promise<void> {
	const parsed = parseServeArguments(argv);
	if (parsed.mode.kind === "socket" && process.platform === "win32")
		throw new SdkServeError("unsupported_platform", "--socket is unavailable on Windows.", 1);
	const pendingCeilingBytes = resolveServePendingCeiling(
		parsed.pendingCeiling,
		process.env.GJC_SDK_SERVE_PENDING_CEILING_BYTES,
	);
	const discovery = await readServeDiscovery(getAgentDir());
	if (!discovery) throw new SdkServeError("broker_unavailable", "SDK broker is not running", 1);
	let broker: SdkClient;
	try {
		broker = await SdkClient.connect(discovery.url, discovery.token);
	} catch {
		throw new SdkServeError("broker_unavailable", "SDK broker is not reachable", 1);
	}
	let primary: Error | undefined;
	try {
		const sessionId = await resolveServeSession(broker, parsed.sessionId);
		const endpoint = brokerResult(await broker.global("session.get_endpoint", { sessionId }));
		const url = typeof endpoint.url === "string" && endpoint.url ? endpoint.url : undefined;
		const token = typeof endpoint.token === "string" && endpoint.token ? endpoint.token : undefined;
		// An empty credential has to die here rather than at the transport: the relay
		// writes it straight into the upstream URL, where it resurfaces as a generic
		// connection failure and this stable malformed-endpoint code is lost.
		if (!url || !token) throw new SdkServeError("unavailable", "broker returned an invalid endpoint record", 1);
		const options = { url, token, pendingCeilingBytes };
		const handle =
			parsed.mode.kind === "stdio"
				? await startStdioServe(options)
				: await startSocketServe({ ...options, socketPath: parsed.mode.socketPath });
		const stop = () => {
			void handle.close();
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
		try {
			await handle.done;
		} finally {
			process.removeListener("SIGINT", stop);
			process.removeListener("SIGTERM", stop);
		}
	} catch (error) {
		primary = toServeError(error);
	}
	// Teardown always runs, but never through a `finally` throw: a rejected
	// `broker.close()` there would replace the typed failure with its own.
	const failure = resolveServeOutcome(primary, await brokerCloseFailure(broker));
	if (failure) throw failure;
}
