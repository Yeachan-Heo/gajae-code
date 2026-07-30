// app-server suites: handler registry for backable client-request methods.
//
// Per the plan D10: every client request has a support manifest row with
// implemented|not_supported|planned. The handler registry maps implemented methods
// to their handler functions. Not-supported methods (realtime, remoteControl,
// marketplace, windowsSandbox, ChatGPT auth) return -32081 automatically by the
// dispatcher (no handler registered = notSupported verdict from dispatchClientRequest).

import type { ThreadRuntimeManager } from "../thread-runtime/thread-runtime-manager";
import type { TurnController } from "../thread-runtime/turn-controller";
import { commandExecHandlers } from "./command-exec-handlers";
import { environmentAppHandlers } from "./environment-app-handlers";
import { fsWatchHandlers } from "./fs-watch-handlers";
import { goalsReviewHandlers } from "./goals-review-handlers";
import { hooksHandlers } from "./hooks-handlers";
import { liveRuntimeHandlers } from "./live-runtime-handlers";
import { mcpHandlers } from "./mcp-handlers";
import { modelConfigHandlers } from "./model-config-handlers";
import { pluginHandlers } from "./plugin-handlers";
import { policyConfigHandlers } from "./policy-config-handlers";
import { processHandlers } from "./process-handlers";
import { skillsHandlers } from "./skills-handlers";
import { threadMutationHandlers } from "./thread-mutation-handlers";
import { threadReadHandlers } from "./thread-read-handlers";
import { threadSessionOpsHandlers } from "./thread-session-ops-handlers";
import { workspaceQueryHandlers } from "./workspace-query-handlers";

export interface HandlerContext {
	/** Connection the request arrived on; notification handlers target it directly. */
	readonly connectionId?: string;
	/** Loaded-thread runtime, for handlers that act on live threads. */
	readonly manager?: ThreadRuntimeManager;
	/** Live-turn controller, for handlers that interrupt or steer a running turn. */
	readonly turnController?: TurnController;
	/** Stop delivering thread notifications to this connection. */
	unsubscribe?: (threadId: string) => void | Promise<void>;
	respond?: (result: unknown) => void;
	emitTo?: (connectionId: string, method: string, params: unknown) => void;
	broadcastThread?: (threadId: string, method: string, params: unknown) => void;
	requestClient?: (threadId: string, method: string, params: unknown) => string | undefined;
	subscribe?: (threadId: string) => void;
}

export type HandlerResult =
	| { ok: true; result: unknown }
	| { ok: false; errorKey: import("../transport/errors").AppServerErrorKey };

export type MethodHandler = (params: unknown, context?: HandlerContext) => HandlerResult | Promise<HandlerResult>;

/** Registry of handlers for implemented client-request methods. */
export class HandlerRegistry {
	readonly #handlers = new Map<string, MethodHandler>();

	/** Register a handler for a method. */
	register(method: string, handler: MethodHandler): void {
		this.#handlers.set(method, handler);
	}

	/** Look up a handler. */
	get(method: string): MethodHandler | undefined {
		return this.#handlers.get(method);
	}

	/** Whether a handler is registered. */
	has(method: string): boolean {
		return this.#handlers.has(method);
	}

	/** List all registered methods. */
	get registeredMethods(): string[] {
		return [...this.#handlers.keys()];
	}

	/** Remove a handler. */
	unregister(method: string): boolean {
		return this.#handlers.delete(method);
	}
}

// --- Built-in handlers for trivially backable methods ---

/** fs/readFile: read a file and return base64. */
export const fsReadFileHandler: MethodHandler = params => {
	const p = params as Record<string, unknown> | undefined;
	const path = p?.path;
	if (typeof path !== "string") return { ok: false, errorKey: "invalidParams" };
	try {
		const { readFileSync } = require("node:fs");
		const data = readFileSync(path);
		return { ok: true, result: { dataBase64: data.toString("base64") } };
	} catch {
		return { ok: false, errorKey: "notFound" };
	}
};

/** fs/writeFile: write a file from base64. */
export const fsWriteFileHandler: MethodHandler = params => {
	const p = params as Record<string, unknown> | undefined;
	const path = p?.path;
	const dataBase64 = p?.dataBase64;
	if (typeof path !== "string" || typeof dataBase64 !== "string") return { ok: false, errorKey: "invalidParams" };
	try {
		const { writeFileSync, mkdirSync } = require("node:fs");
		const { dirname } = require("node:path");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, Buffer.from(dataBase64, "base64"));
		return { ok: true, result: {} };
	} catch {
		return { ok: false, errorKey: "internalError" };
	}
};

/** fs/getMetadata: return metadata for a path. */
export const fsGetMetadataHandler: MethodHandler = params => {
	const p = params as Record<string, unknown> | undefined;
	const path = p?.path;
	if (typeof path !== "string") return { ok: false, errorKey: "invalidParams" };
	try {
		const { statSync } = require("node:fs");
		const stat = statSync(path);
		return {
			ok: true,
			result: {
				isDirectory: stat.isDirectory(),
				isFile: stat.isFile(),
				isSymlink: stat.isSymbolicLink(),
				createdAtMs: Math.trunc(stat.birthtimeMs),
				modifiedAtMs: Math.trunc(stat.mtimeMs),
			},
		};
	} catch {
		return { ok: false, errorKey: "notFound" };
	}
};

/** fs/readDirectory: list directory entries. */
export const fsReadDirectoryHandler: MethodHandler = params => {
	const p = params as Record<string, unknown> | undefined;
	const path = p?.path;
	if (typeof path !== "string") return { ok: false, errorKey: "invalidParams" };
	try {
		const { readdirSync, statSync } = require("node:fs");
		const entries = readdirSync(path);
		const result = entries.map((fileName: string) => {
			const stat = statSync(`${path}/${fileName}`);
			return { fileName, isDirectory: stat.isDirectory(), isFile: stat.isFile() };
		});
		return { ok: true, result: { entries: result } };
	} catch {
		return { ok: false, errorKey: "notFound" };
	}
};

/** fs/createDirectory: create a directory. */
export const fsCreateDirectoryHandler: MethodHandler = params => {
	const p = params as Record<string, unknown> | undefined;
	const path = p?.path;
	const recursive = p?.recursive !== false; // default true
	if (typeof path !== "string") return { ok: false, errorKey: "invalidParams" };
	try {
		const { mkdirSync } = require("node:fs");
		mkdirSync(path, { recursive });
		return { ok: true, result: {} };
	} catch {
		return { ok: false, errorKey: "internalError" };
	}
};

/** fs/remove: remove a file or directory tree. */
export const fsRemoveHandler: MethodHandler = params => {
	const p = params as Record<string, unknown> | undefined;
	const path = p?.path;
	if (typeof path !== "string") return { ok: false, errorKey: "invalidParams" };
	try {
		const { rmSync } = require("node:fs");
		rmSync(path, { recursive: p?.recursive !== false, force: p?.force !== false });
		return { ok: true, result: {} };
	} catch {
		return { ok: false, errorKey: "internalError" };
	}
};

/** experimentalFeature/list: list feature flags. */
export const experimentalFeatureListHandler: MethodHandler = () => {
	return { ok: true, result: { data: [] } };
};

/**
 * Register all built-in handlers on a registry.
 * The server calls this during initialization.
 */
export function registerBuiltinHandlers(registry: HandlerRegistry): void {
	registry.register("fs/readFile", fsReadFileHandler);
	registry.register("fs/writeFile", fsWriteFileHandler);
	registry.register("fs/getMetadata", fsGetMetadataHandler);
	registry.register("fs/readDirectory", fsReadDirectoryHandler);
	registry.register("fs/createDirectory", fsCreateDirectoryHandler);
	registry.register("fs/remove", fsRemoveHandler);
	registry.register("experimentalFeature/list", experimentalFeatureListHandler);
	for (const [method, handler] of Object.entries(fsWatchHandlers)) registry.register(method, handler);
	for (const [method, handler] of Object.entries(commandExecHandlers)) registry.register(method, handler);
	for (const [method, handler] of Object.entries(processHandlers)) registry.register(method, handler);
	for (const [method, handler] of Object.entries(modelConfigHandlers)) registry.register(method, handler);
	for (const [method, handler] of Object.entries(mcpHandlers)) registry.register(method, handler);
	for (const [method, handler] of Object.entries(skillsHandlers)) registry.register(method, handler);
	for (const [method, handler] of Object.entries(hooksHandlers)) registry.register(method, handler);
	for (const [method, handler] of Object.entries(goalsReviewHandlers)) registry.register(method, handler);
	for (const [method, handler] of Object.entries(threadReadHandlers)) registry.register(method, handler);
	for (const [method, handler] of Object.entries(threadMutationHandlers)) registry.register(method, handler);
	for (const [method, handler] of Object.entries(workspaceQueryHandlers)) registry.register(method, handler);
	for (const [method, handler] of Object.entries(environmentAppHandlers)) registry.register(method, handler);
	for (const [method, handler] of Object.entries(pluginHandlers)) registry.register(method, handler);
	for (const [method, handler] of Object.entries(policyConfigHandlers)) registry.register(method, handler);
	for (const [method, handler] of Object.entries(liveRuntimeHandlers)) registry.register(method, handler);
	for (const [method, handler] of Object.entries(threadSessionOpsHandlers)) registry.register(method, handler);
}
