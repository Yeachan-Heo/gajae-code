// app-server CLI runtime: the `gjc app-server` command entry point.
//
// Replicates all codex app-server CLI entrypoints:
//   gjc app-server                          (default stdio)
//   gjc app-server --stdio                  (explicit stdio)
//   gjc app-server --listen stdio://        (explicit stdio URL)
//   gjc app-server --listen ws://IP:PORT    (WebSocket TCP)
//   gjc app-server --listen unix://PATH     (WebSocket over Unix socket)
//   gjc app-server --listen off             (no transport; valid standalone)
//   gjc app-server proxy --sock PATH        (raw stream proxy to a Unix socket)
//   gjc app-server generate-ts --out DIR    (emit generated TypeScript types)
//   gjc app-server generate-json-schema --out DIR (emit JSON Schema bundle)
//
// Auth flags (ws/unix non-loopback only, pinned from vendored behavior.json):
//   --ws-auth capability-token|signed-bearer-token
//   --ws-token-file | --ws-token-sha256 (mutually exclusive)
//   --ws-shared-secret-file --ws-issuer --ws-audience --ws-max-clock-skew-seconds

import { parseListenUrl, type ListenMode } from "../transport/listen";
import { createAppServer, type AppServer } from "../create-app-server";

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
	return {
		mode,
		maxFrameBytes: maxFrameBytes ?? 4 * 1024 * 1024,
		maxLoadedThreads: maxLoadedThreads ?? 16,
	};
}

/**
 * Start the app-server in stdio mode. Reads JSONL frames from stdin, processes them
 * through the full server pipeline, and writes responses to stdout. This is the
 * production stdio entry point.
 */
export async function runStdioServer(config: ResolvedAppServerConfig): Promise<void> {
	const server = createAppServer({ maxLoadedThreads: config.maxLoadedThreads }, { maxFrameBytes: config.maxFrameBytes });
	const readline = require("node:readline");
	const rl = readline.createInterface({ input: process.stdin, terminal: false });
	rl.on("line", (line: string) => {
		const result = server.process(new TextEncoder().encode(line), "stdio");
		if (result.response) {
			process.stdout.write(result.response);
		}
	});
	return new Promise(resolve => {
		rl.on("close", () => resolve());
	});
}

/**
 * The `generate-ts` subcommand: emit generated TypeScript types to an output directory.
 */
export async function generateTs(outDir: string): Promise<void> {
	const { copyFileSync, mkdirSync, existsSync } = require("node:fs");
	const { join } = require("node:path");
	const source = join(__dirname, "..", "protocol-source");
	mkdirSync(outDir, { recursive: true });
	for (const file of ["types.generated.ts", "validators.generated.ts", "catalogs.generated.ts", "support-manifest.generated.ts"]) {
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
