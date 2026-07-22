import { CliParseError } from "@gajae-code/utils/cli";
import type { SdkSessionEndpoint } from "../client/discovery";
import { listSdkSessionEndpoints } from "../client/discovery";
import { type SdkEndpointSelectionError, selectLiveEndpoint } from "../client/liveness";
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

function isSelectionError(value: SdkSessionEndpoint | SdkEndpointSelectionError): value is SdkEndpointSelectionError {
	return "code" in value;
}

/** Attaches a stdio or Unix-socket relay to one live SDK session endpoint. */
export async function runSdkServe(argv: string[]): Promise<void> {
	const parsed = parseServeArguments(argv);
	if (parsed.mode.kind === "socket" && process.platform === "win32")
		throw new Error("unsupported_platform: --socket is unavailable on Windows.");
	const pendingCeilingBytes = resolveServePendingCeiling(
		parsed.pendingCeiling,
		process.env.GJC_SDK_SERVE_PENDING_CEILING_BYTES,
	);
	const discovered = await listSdkSessionEndpoints(process.cwd());
	const selected = selectLiveEndpoint(discovered.endpoints, parsed.sessionId);
	if (isSelectionError(selected)) {
		const sessionHint = parsed.sessionId ? ` for session ${parsed.sessionId}` : "; specify --session <id>";
		throw new Error(`${selected.code}${sessionHint}`);
	}
	const options = { url: selected.url, token: selected.token, pendingCeilingBytes };
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
}
