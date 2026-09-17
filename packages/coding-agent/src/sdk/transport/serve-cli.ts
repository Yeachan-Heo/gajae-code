import { getAgentDir } from "@gajae-code/utils";
import { CliParseError } from "@gajae-code/utils/cli";
import { readSdkBrokerDiscovery, SdkClient, SdkClientError } from "../client";
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

type BrokerSessionRow = { sessionId: string; live: boolean; ambiguous: boolean };

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

function brokerSessionRows(sessions: readonly unknown[]): BrokerSessionRow[] {
	return sessions.flatMap(item => {
		if (!isRecord(item) || typeof item.sessionId !== "string" || !item.sessionId) return [];
		return [{ sessionId: item.sessionId, live: item.live === true, ambiguous: item.ambiguous === true }];
	});
}

/** Exhausts strict broker `session.list` pages into one full session snapshot. */
export async function listBrokerSessions(broker: SdkClient, explicitSessionId?: string): Promise<BrokerSessionRow[]> {
	try {
		const pages = await traverseSessionList(
			{ ...(explicitSessionId ? { resolveSessionId: explicitSessionId } : {}) },
			async input => await broker.global("session.list", input),
			response => {
				brokerResult(response);
				return sessionListPageFromResponse(response);
			},
		);
		return pages.flatMap(page => brokerSessionRows(page.sessions));
	} catch (error) {
		if (error instanceof SessionListTraversalError) throw new SdkClientError("protocol_error", error.message);
		throw error;
	}
}

/** Selects the session to serve through broker `session.list` truth (C10); exported for tests. */
export function selectBrokerSession(sessions: BrokerSessionRow[], explicitSessionId: string | undefined): string {
	if (explicitSessionId !== undefined) {
		const row = sessions.find(session => session.sessionId === explicitSessionId);
		if (!row) throw new SdkServeError("not_found", `session ${explicitSessionId} is not indexed by the broker`, 1);
		if (row.ambiguous) throw new SdkServeError("ambiguous_session", "session id maps to more than one state root", 1);
		if (!row.live) throw new SdkServeError("endpoint_stale", `session ${explicitSessionId} endpoint is not live`, 1);
		return row.sessionId;
	}
	const live = sessions.filter(session => session.live && !session.ambiguous);
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
	const discovery = await readSdkBrokerDiscovery(getAgentDir());
	if (!discovery) throw new SdkServeError("broker_unavailable", "SDK broker is not running", 1);
	let broker: SdkClient;
	try {
		broker = await SdkClient.connect(discovery.url, discovery.token);
	} catch {
		throw new SdkServeError("broker_unavailable", "SDK broker is not reachable", 1);
	}
	let primary: Error | undefined;
	try {
		const sessionId = selectBrokerSession(await listBrokerSessions(broker, parsed.sessionId), parsed.sessionId);
		const endpoint = brokerResult(await broker.global("session.get_endpoint", { sessionId }));
		const url = typeof endpoint.url === "string" && endpoint.url ? endpoint.url : undefined;
		const token = typeof endpoint.token === "string" ? endpoint.token : "";
		if (!url) throw new SdkServeError("unavailable", "broker returned an invalid endpoint record", 1);
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
