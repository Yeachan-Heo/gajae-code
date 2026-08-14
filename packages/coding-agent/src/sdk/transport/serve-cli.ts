import { getAgentDir } from "@gajae-code/utils";
import { CliParseError } from "@gajae-code/utils/cli";
import { readSdkBrokerDiscovery, SdkClient, SdkClientError } from "../client";
import { DEFAULT_PENDING_CEILING_BYTES, MIN_PENDING_CEILING_BYTES, startSocketServe, startStdioServe } from "./index";

const MAX_SESSION_LIST_PAGES = 10_000;

type ServeMode = { kind: "stdio" } | { kind: "socket"; socketPath: string };

interface ServeArguments {
	mode: ServeMode;
	sessionId?: string;
	pendingCeiling?: string;
}

function usageError(message: string): never {
	throw new CliParseError(`gjc sdk serve: ${message}`);
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

function brokerSessionRows(value: Record<string, unknown>): BrokerSessionRow[] {
	if (!Array.isArray(value.sessions)) return [];
	return value.sessions.flatMap(item => {
		if (!isRecord(item) || typeof item.sessionId !== "string" || !item.sessionId) return [];
		return [{ sessionId: item.sessionId, live: item.live === true, ambiguous: item.ambiguous === true }];
	});
}

/**
 * Exhausts broker `session.list` cursor pagination (default page limit 100) to
 * one full snapshot; exported for tests.
 */
export async function listBrokerSessions(broker: SdkClient): Promise<BrokerSessionRow[]> {
	const rows: BrokerSessionRow[] = [];
	let cursor: string | undefined;
	for (let pageCount = 0; pageCount < MAX_SESSION_LIST_PAGES; pageCount++) {
		const listed = brokerResult(await broker.global("session.list", cursor === undefined ? {} : { cursor }));
		rows.push(...brokerSessionRows(listed));
		const nextCursor =
			typeof listed.continuationCursor === "string" && listed.continuationCursor.length > 0
				? listed.continuationCursor
				: undefined;
		if (!nextCursor) return rows;
		cursor = nextCursor;
	}
	throw new SdkClientError("protocol_error", "session.list exceeded the page budget.");
}

/** Selects the session to serve through broker `session.list` truth (C10); exported for tests. */
export function selectBrokerSession(sessions: BrokerSessionRow[], explicitSessionId: string | undefined): string {
	if (explicitSessionId !== undefined) {
		const row = sessions.find(session => session.sessionId === explicitSessionId);
		if (!row) throw new Error(`not_found: session ${explicitSessionId} is not indexed by the broker`);
		if (row.ambiguous) throw new Error("ambiguous_session: session id maps to more than one state root");
		if (!row.live) throw new Error(`endpoint_stale: session ${explicitSessionId} endpoint is not live`);
		return row.sessionId;
	}
	const live = sessions.filter(session => session.live && !session.ambiguous);
	if (live.length === 0) throw new Error("no_live_endpoint: no live session endpoint");
	if (live.length > 1) throw new Error("multiple_live_endpoints: more than one live session; specify --session <id>");
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
		throw new Error("unsupported_platform: --socket is unavailable on Windows.");
	const pendingCeilingBytes = resolveServePendingCeiling(
		parsed.pendingCeiling,
		process.env.GJC_SDK_SERVE_PENDING_CEILING_BYTES,
	);
	const discovery = await readSdkBrokerDiscovery(getAgentDir());
	if (!discovery) throw new Error("broker_unavailable: SDK broker is not running");
	let broker: SdkClient;
	try {
		broker = await SdkClient.connect(discovery.url, discovery.token);
	} catch {
		throw new Error("broker_unavailable: SDK broker is not reachable");
	}
	try {
		const sessionId = selectBrokerSession(await listBrokerSessions(broker), parsed.sessionId);
		const endpoint = brokerResult(await broker.global("session.get_endpoint", { sessionId }));
		const url = typeof endpoint.url === "string" && endpoint.url ? endpoint.url : undefined;
		const token = typeof endpoint.token === "string" ? endpoint.token : "";
		if (!url) throw new Error("unavailable: broker returned an invalid endpoint record");
		const options = {
			url,
			token,
			pendingCeilingBytes,
			validateDownstreamFrame: (source: string): boolean => {
				try {
					const frame = JSON.parse(source) as { type?: unknown; elevationRequestId?: unknown };
					return frame.type !== "control_request" || frame.elevationRequestId === undefined;
				} catch {
					return true;
				}
			},
		};
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
		throw error instanceof SdkClientError ? new Error(`${error.code}: ${error.message}`) : error;
	} finally {
		await broker.close();
	}
}
