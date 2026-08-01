// app-server CLI runtime: the `gjc app-server` command entry point.
//
// Implements this SUBSET of the codex app-server CLI entrypoints. Entries marked
// NOT IMPLEMENTED are recognised codex surface this command does not provide;
// entries marked GJC OVERRIDE deviate deliberately from upstream codex behaviour.
//   gjc app-server                          (default stdio)
//   gjc app-server --stdio                  (explicit stdio)
//   gjc app-server --listen stdio://        (explicit stdio URL)
//   gjc app-server --listen ws://IP:PORT    (WebSocket TCP)
//   gjc app-server --listen unix://PATH     (WebSocket over Unix socket)
//   gjc app-server --listen off             (no transport; GJC OVERRIDE, standalone)
//   gjc app-server proxy --sock PATH        (NOT IMPLEMENTED: no proxy branch, no --sock flag)
//   gjc app-server generate-ts --out DIR    (emit generated TypeScript types)
//   gjc app-server generate-json-schema --out DIR (emit JSON Schema bundle)
//
// Auth flags: ws:// listeners beyond loopback require --ws-auth. Loopback ws://
// listeners may omit authentication for local development. unix:// listeners may
// omit authentication; filesystem socket permissions are their access boundary.
//   --ws-auth capability-token|signed-bearer-token
//   --ws-token-file | --ws-token-sha256 (mutually exclusive)
//   --ws-shared-secret-file --ws-issuer --ws-audience --ws-max-clock-skew-seconds

import { type AppServerRuntime, createAppServerRuntime } from "../create-app-server";
import { createProductionThreadStartAdapter } from "../thread-runtime/production-child";
import { parseWsAuthFlags, type WsAuthConfig } from "../transport/auth";
import { isLoopback, type ListenMode, parseListenUrl } from "../transport/listen";

export interface AppServerCliArgs {
	listen?: string;
	stdio?: boolean;
	wsAuth?: string;
	wsTokenFile?: string;
	wsTokenSha256?: string;
	wsSharedSecretFile?: string;
	wsIssuer?: string;
	wsAudience?: string;
	wsMaxClockSkewSeconds?: string;
	maxFrameBytes?: string;
	maxLoadedThreads?: string;
}

export interface ResolvedAppServerConfig {
	mode: ListenMode;
	maxFrameBytes: number;
	maxLoadedThreads: number;
	wsAuth?: WsAuthConfig;
}

/**
 * Resolve CLI args into a listen mode + server config. Throws on invalid flags.
 */
export function resolveAppServerArgs(args: AppServerCliArgs): ResolvedAppServerConfig {
	const mode = parseListenUrl(args.listen ?? (args.stdio ? "stdio" : undefined));
	const maxFrameBytes = args.maxFrameBytes ? Number(args.maxFrameBytes) : undefined;
	const maxLoadedThreads = args.maxLoadedThreads ? Number(args.maxLoadedThreads) : undefined;
	if (maxFrameBytes !== undefined && (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1)) {
		throw new Error("--max-frame-bytes must be a positive integer");
	}
	if (maxLoadedThreads !== undefined && (!Number.isInteger(maxLoadedThreads) || maxLoadedThreads < 1)) {
		throw new Error("--max-loaded-threads must be a positive integer");
	}
	const hasWsAuthArg = [
		args.wsAuth,
		args.wsTokenFile,
		args.wsTokenSha256,
		args.wsSharedSecretFile,
		args.wsIssuer,
		args.wsAudience,
		args.wsMaxClockSkewSeconds,
	].some(value => value !== undefined);
	const wsAuth = hasWsAuthArg
		? parseWsAuthFlags({
				"ws-auth": args.wsAuth,
				"ws-token-file": args.wsTokenFile,
				"ws-token-sha256": args.wsTokenSha256,
				"ws-shared-secret-file": args.wsSharedSecretFile,
				"ws-issuer": args.wsIssuer,
				"ws-audience": args.wsAudience,
				"ws-max-clock-skew-seconds": args.wsMaxClockSkewSeconds,
			})
		: undefined;
	if (mode.kind === "ws" && !isLoopback(mode) && !wsAuth) {
		throw new Error(
			"non-loopback ws:// listeners require authentication; configure --ws-auth with --ws-token-file or --ws-token-sha256",
		);
	}
	return {
		mode,
		maxFrameBytes: maxFrameBytes ?? 4 * 1024 * 1024,
		maxLoadedThreads: maxLoadedThreads ?? 16,
		wsAuth,
	};
}

export interface StdioWriter {
	write(frame: Uint8Array): boolean;
	once(event: "drain" | "error", listener: (() => void) | ((error: Error) => void)): void;
	off(event: "drain" | "error", listener: (() => void) | ((error: Error) => void)): void;
}

export function writeStdioFrame(writer: StdioWriter, frame: Uint8Array): Promise<void> {
	if (writer.write(frame)) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		const onDrain = () => {
			writer.off("error", onError);
			resolve();
		};
		const onError = (error: Error) => {
			writer.off("drain", onDrain);
			reject(error);
		};
		writer.once("drain", onDrain);
		writer.once("error", onError);
	});
}

/**
 * Start the app-server in stdio mode. Reads JSONL frames from stdin, processes them
 * through the full server pipeline, and writes responses to stdout. This is the
 * production stdio entry point.
 */
export async function runStdioServer(config: ResolvedAppServerConfig): Promise<void> {
	let runtime: AppServerRuntime | undefined;
	const threadStartAdapter = createProductionThreadStartAdapter({
		requestApproval: (method, params, signal) => {
			const owner = runtime;
			if (!owner) return Promise.reject(new Error("App-server runtime is not ready for approval requests."));
			return owner.requestApproval(params.conversationId, method, params, signal);
		},
	});
	const serverRuntime = createAppServerRuntime(
		{ maxLoadedThreads: config.maxLoadedThreads },
		{ maxFrameBytes: config.maxFrameBytes },
		{ threadStartAdapter },
	);
	runtime = serverRuntime;
	const readline = require("node:readline");
	const rl = readline.createInterface({ input: process.stdin, terminal: false });
	const connection = serverRuntime.createConnection(
		frame => writeStdioFrame(process.stdout, frame),
		"stdio",
		() => rl.close(),
	);
	let signalClose: Promise<void> | undefined;
	const onSignal = (): void => {
		process.exitCode = 0;
		rl.close();
		signalClose ??= connection.close();
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	try {
		for await (const line of rl) await connection.process(new TextEncoder().encode(line));
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		rl.close();
		await connection.close();
		await signalClose;
	}
}

/**
 * The `generate-ts` subcommand: emit generated TypeScript types to an output directory.
 */
export async function generateTs(outDir: string): Promise<void> {
	const { copyFileSync, mkdirSync, existsSync } = require("node:fs");
	const { join } = require("node:path");
	const source = join(__dirname, "..", "protocol-source");
	mkdirSync(outDir, { recursive: true });
	for (const file of [
		"types.generated.ts",
		"validators.generated.ts",
		"catalogs.generated.ts",
		"support-manifest.generated.ts",
	]) {
		const src = join(source, file);
		if (!existsSync(src)) throw new Error(`Generated artifact not found: ${file}`);
		copyFileSync(src, join(outDir, file));
	}
}

/**
 * The `generate-json-schema` subcommand: emit the JSON Schema bundle.
 */
export async function generateJsonSchema(outDir: string): Promise<void> {
	const { copyFileSync, mkdirSync, existsSync } = require("node:fs");
	const { join } = require("node:path");
	const source = join(__dirname, "..", "protocol-source", "vendor");
	mkdirSync(outDir, { recursive: true });
	const src = join(source, "app-server.schema.bundle.json");
	if (!existsSync(src)) throw new Error("Schema bundle not found");
	copyFileSync(src, join(outDir, "app-server.schema.bundle.json"));
}
