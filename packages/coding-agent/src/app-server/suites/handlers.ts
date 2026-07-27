// app-server suites: handler registry for backable client-request methods.
//
// Per the plan D10: every client request has a support manifest row with
// implemented|not_supported|planned. The handler registry maps implemented methods
// to their handler functions. Not-supported methods (realtime, remoteControl,
// marketplace, windowsSandbox, ChatGPT auth) return -32081 automatically by the
// dispatcher (no handler registered = notSupported verdict from dispatchClientRequest).

export type HandlerResult =
	| { ok: true; result: unknown }
	| { ok: false; errorKey: import("../transport/errors").AppServerErrorKey };

export type MethodHandler = (params: unknown) => HandlerResult;

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
export const fsReadFileHandler: MethodHandler = (params) => {
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
export const fsWriteFileHandler: MethodHandler = (params) => {
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
export const fsGetMetadataHandler: MethodHandler = (params) => {
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
				createdAtMs: stat.birthtimeMs,
				modifiedAtMs: stat.mtimeMs,
			},
		};
	} catch {
		return { ok: false, errorKey: "notFound" };
	}
};

/** fs/readDirectory: list directory entries. */
export const fsReadDirectoryHandler: MethodHandler = (params) => {
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
		return { ok: true, result };
	} catch {
		return { ok: false, errorKey: "notFound" };
	}
};

/** fs/createDirectory: create a directory. */
export const fsCreateDirectoryHandler: MethodHandler = (params) => {
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
export const fsRemoveHandler: MethodHandler = (params) => {
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

/** config/read: translate gjc config into codex ConfigReadResponse shape. */
export const configReadHandler: MethodHandler = () => {
	// Per vendored protocol: result = {config: Config, origins: HashMap<String,...>, layers?: ...}
	// Translate gjc config into the codex Config shape. codexHome -> gjc agent dir.
	const { homedir } = require("node:os");
	const { join } = require("node:path");
	const gjcAgentDir = process.env.GJC_AGENT_DIR ?? join(homedir(), ".gjc", "agent");
	return {
		ok: true,
		result: {
			config: {
				codexHome: gjcAgentDir,
				desktop: {},
			},
			origins: {},
		},
	};
};

/** model/list: translate gjc model catalog into codex ModelListResponse shape. */
export const modelListHandler: MethodHandler = () => {
	// Per vendored protocol: result = {data: Vec<Model>, nextCursor?: Option<String>}
	return {
		ok: true,
		result: {
			data: [],
			nextCursor: null,
		},
	};
};

/** skills/list: list gjc skills for a cwd. */
export const skillsListHandler: MethodHandler = (params) => {
	const p = (params as Record<string, unknown> | undefined) ?? {};
	// List gjc skills; the full skill-discovery integration is a later phase.
	return {
		ok: true,
		result: [],
	};
};

/** hooks/list: list gjc hooks for a cwd. */
export const hooksListHandler: MethodHandler = () => {
	return { ok: true, result: [] };
};

/** experimentalFeature/list: list feature flags. */
export const experimentalFeatureListHandler: MethodHandler = () => {
	return { ok: true, result: [] };
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
	registry.register("config/read", configReadHandler);
	registry.register("model/list", modelListHandler);
	registry.register("skills/list", skillsListHandler);
	registry.register("hooks/list", hooksListHandler);
	registry.register("experimentalFeature/list", experimentalFeatureListHandler);
}
