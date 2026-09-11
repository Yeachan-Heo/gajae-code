import { getAgentDir } from "@gajae-code/utils";
import {
	normalizePublicCommandFailure,
	type PublicCommandDiagnosticCode,
	PublicCommandFailure,
} from "../../cli/public-command-errors";
import { readSdkBrokerDiscovery, SdkClient, SdkClientError } from "../client";
import { SessionListTraversalError, sessionListPageFromResponse, traverseSessionList } from "../session-list";
import type { ServeHandle } from "./index";
import { DEFAULT_PENDING_CEILING_BYTES, MIN_PENDING_CEILING_BYTES, startSocketServe, startStdioServe } from "./index";

type ServeMode = { kind: "stdio" } | { kind: "socket"; socketPath: string };

interface ServeArguments {
	mode: ServeMode;
	sessionId?: string;
	pendingCeiling?: string;
}

/**
 * Usage failures keep a static, allowlisted reason instead of the parser's raw text:
 * the concrete diagnostic is what makes an unknown flag or a missing operand
 * actionable, and it never echoes caller argv back into output or the evidence store.
 */
function usageError(diagnostic: PublicCommandDiagnosticCode): never {
	throw new PublicCommandFailure({ kind: "usage", proof: "pre-effect", diagnostics: [diagnostic] });
}

function readFlagValue(argv: string[], index: number): string {
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("-")) usageError("usage_missing_value");
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
				if (stdio) usageError("usage_duplicate_option");
				stdio = true;
				break;
			case "--socket":
				if (socketPath !== undefined) usageError("usage_duplicate_option");
				socketPath = readFlagValue(argv, index);
				index++;
				break;
			case "--session":
				if (sessionId !== undefined) usageError("usage_duplicate_option");
				sessionId = readFlagValue(argv, index);
				index++;
				break;
			case "--pending-ceiling":
				if (pendingCeiling !== undefined) usageError("usage_duplicate_option");
				pendingCeiling = readFlagValue(argv, index);
				index++;
				break;
			default:
				usageError("usage_unknown_argument");
		}
	}
	if (stdio === (socketPath !== undefined)) usageError("usage_transport_exclusive");
	return { mode: stdio ? { kind: "stdio" } : { kind: "socket", socketPath: socketPath! }, sessionId, pendingCeiling };
}

/** Resolves the pending ceiling with flag > env > default precedence; exported for tests. */
export function resolveServePendingCeiling(flagValue: string | undefined, envValue: string | undefined): number {
	const value = flagValue ?? envValue;
	if (value === undefined) return DEFAULT_PENDING_CEILING_BYTES;
	if (!/^\d+$/.test(value)) usageError("usage_invalid_option_value");
	const ceiling = Number(value);
	if (!Number.isSafeInteger(ceiling) || ceiling < MIN_PENDING_CEILING_BYTES) usageError("usage_invalid_option_value");
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
export async function listBrokerSessions(
	broker: Pick<SdkClient, "global">,
	explicitSessionId?: string,
): Promise<BrokerSessionRow[]> {
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
		if (!row || row.ambiguous) throw new PublicCommandFailure({ kind: "unavailable", proof: "pre-effect" });
		if (!row.live) throw new PublicCommandFailure({ kind: "endpoint_stale", proof: "pre-effect" });
		return row.sessionId;
	}
	const live = sessions.filter(session => session.live && !session.ambiguous);
	if (live.length === 0) throw new PublicCommandFailure({ kind: "endpoint_stale", proof: "pre-effect" });
	if (live.length > 1) throw new PublicCommandFailure({ kind: "usage", proof: "pre-effect" });
	return live[0]!.sessionId;
}

/** Only SDK-owned error codes carry classification authority at preflight. */
function servePreflightFailure(error: unknown): PublicCommandFailure {
	if (!(error instanceof SdkClientError)) return normalizePublicCommandFailure(error);
	switch (error.code) {
		case "broker_restarting":
			return new PublicCommandFailure({ kind: "broker_restarting", proof: "pre-effect" });
		case "broker_unavailable":
			return new PublicCommandFailure({ kind: "broker_unavailable", proof: "pre-effect" });
		case "endpoint_stale":
			return new PublicCommandFailure({ kind: "endpoint_stale", proof: "pre-effect" });
		case "authorization_denied":
		case "unauthorized":
		case "forbidden":
		case "master_context_required":
		case "adapter_operation_prohibited":
		case "endpoint_credential_forbidden":
			return new PublicCommandFailure({ kind: "authorization_denied", proof: "pre-effect" });
		case "timeout":
			return new PublicCommandFailure({ kind: "timeout", proof: "unknown" });
		case "unavailable":
			return new PublicCommandFailure({ kind: "unavailable", proof: "unknown" });
		case "uncertain_after_send":
			return new PublicCommandFailure({ kind: "uncertain_after_send", proof: "sent" });
		default:
			return normalizePublicCommandFailure(error);
	}
}

/** Bounded dependency seam for preflight tests; production keeps the same transport factories. */
export interface SdkServeDependencies {
	readDiscovery: (agentDir: string) => Promise<{ url: string; token: string } | null>;
	connect: (url: string, token: string) => Promise<Pick<SdkClient, "global" | "close">>;
	startStdio: typeof startStdioServe;
	startSocket: typeof startSocketServe;
}

const serveDependencies: SdkServeDependencies = {
	readDiscovery: readSdkBrokerDiscovery,
	connect: (url, token) => SdkClient.connect(url, token),
	startStdio: startStdioServe,
	startSocket: startSocketServe,
};

/**
 * Attaches a stdio or Unix-socket relay to one live SDK session endpoint.
 * Session targeting is broker-bound (C10): `session.list` resolves the session
 * and `session.get_endpoint` mints the exact credential — never a direct
 * endpoint-file read. A missing or unreachable broker fails closed.
 */
export async function runSdkServe(
	argv: string[],
	dependencies: SdkServeDependencies = serveDependencies,
): Promise<void> {
	let broker: Pick<SdkClient, "global" | "close"> | undefined;
	let transport: ServeHandle | undefined;
	try {
		const parsed = parseServeArguments(argv);
		if (parsed.mode.kind === "socket" && process.platform === "win32")
			throw new PublicCommandFailure({ kind: "unavailable", proof: "pre-effect" });
		const pendingCeilingBytes = resolveServePendingCeiling(
			parsed.pendingCeiling,
			process.env.GJC_SDK_SERVE_PENDING_CEILING_BYTES,
		);
		const discovery = await dependencies.readDiscovery(getAgentDir());
		if (!discovery) throw new PublicCommandFailure({ kind: "broker_unavailable", proof: "pre-effect" });
		try {
			broker = await dependencies.connect(discovery.url, discovery.token);
		} catch (error) {
			if (error instanceof SdkClientError || error instanceof PublicCommandFailure) throw error;
			throw new PublicCommandFailure({ kind: "broker_unavailable", proof: "pre-effect" });
		}
		const sessionId = selectBrokerSession(await listBrokerSessions(broker, parsed.sessionId), parsed.sessionId);
		const endpoint = brokerResult(await broker.global("session.get_endpoint", { sessionId }));
		const url = typeof endpoint.url === "string" && endpoint.url ? endpoint.url : undefined;
		const token = typeof endpoint.token === "string" ? endpoint.token : "";
		// An endpoint without its minted credential cannot authenticate any relayed
		// client, so starting the listener would advertise a serve that always fails.
		if (!url || !token) throw new PublicCommandFailure({ kind: "unavailable", proof: "pre-effect" });
		const options = { url, token, pendingCeilingBytes };
		transport =
			parsed.mode.kind === "stdio"
				? await dependencies.startStdio(options)
				: await dependencies.startSocket({ ...options, socketPath: parsed.mode.socketPath });
	} catch (error) {
		// No transport handle has transferred ownership. Cleanup diagnostics are
		// attached to the original failure instance, never substituted for it, and
		// broker credentials never reach a raw error.
		const failure = servePreflightFailure(error);
		try {
			await broker?.close();
		} catch {
			failure.input.diagnostics = [...(failure.input.diagnostics ?? []), "broker_cleanup_failed"];
		}
		throw failure;
	}
	await ownSdkServeTransport(transport, () => broker!.close());
}

/**
 * Acquiring a ServeHandle transfers output/termination ownership to transport.
 * This boundary never rejects into the ordinary public command writer, even
 * when no frame has been written. Raw relay framing remains transport-owned.
 */
export async function ownSdkServeTransport(handle: ServeHandle, closeBroker: () => Promise<void>): Promise<void> {
	let failed = false;
	const reportFailure = (): void => {
		process.exitCode = 1;
		if (failed) return;
		failed = true;
		try {
			process.stderr.write(`${JSON.stringify({ type: "transport_error", code: "serve_failed" })}\n`);
		} catch {
			// A broken diagnostic stream cannot transfer ownership back to the CLI.
		}
	};
	const stop = (): void => {
		void handle.close().catch(reportFailure);
	};
	try {
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
		await handle.done;
	} catch {
		reportFailure();
	} finally {
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
		try {
			await handle.close();
		} catch {
			reportFailure();
		}
		try {
			await closeBroker();
		} catch {
			reportFailure();
		}
	}
}
