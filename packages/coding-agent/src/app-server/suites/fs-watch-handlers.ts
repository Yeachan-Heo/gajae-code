import { cpSync, type FSWatcher, realpathSync, statSync, watch } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { HandlerContext, HandlerResult, MethodHandler } from "./handlers";

type FsParams = Record<string, unknown>;

type WatchRecord = {
	key: string;
	watchId: string;
	connectionId: string;
	context?: HandlerContext;
	path: string;
	isDirectory: boolean;
	watcher: FSWatcher;
	active: boolean;
};

const watchRegistry = new Map<string, WatchRecord>();

function isRecord(value: unknown): value is FsParams {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function connectionIdOf(context: HandlerContext | undefined): string {
	return context?.connectionId ?? "";
}

function registryKey(watchId: string, context: HandlerContext | undefined): string {
	return `${connectionIdOf(context)}\u0000${watchId}`;
}

function invalidParams(): HandlerResult {
	return { ok: false, errorKey: "invalidParams" };
}

function errorKey(error: unknown): "invalidParams" | "notFound" | "internalError" {
	const code = (error as { code?: unknown } | null)?.code;
	if (code === "ENOENT" || code === "ENOTDIR") return "notFound";
	if (code === "EINVAL" || code === "ERR_INVALID_ARG_TYPE") return "invalidParams";
	return "internalError";
}

function normalizedAbsolutePath(value: unknown): string | undefined {
	return typeof value === "string" && isAbsolute(value) ? value : undefined;
}

function changedPath(record: WatchRecord, filename: string | Buffer | null): string {
	if (!record.isDirectory) return record.path;
	if (typeof filename !== "string" && !Buffer.isBuffer(filename)) return record.path;
	const name = typeof filename === "string" ? filename : filename.toString();
	return name.length === 0 ? record.path : isAbsolute(name) ? resolve(name) : resolve(record.path, name);
}

function emitChanged(record: WatchRecord, filename: string | Buffer | null): void {
	if (!record.active || watchRegistry.get(record.key) !== record) return;
	try {
		record.context?.emitTo?.(record.connectionId, "fs/changed", {
			watchId: record.watchId,
			changedPaths: [changedPath(record, filename)],
		});
	} catch {
		// A disconnected or failed transport must not prevent watcher cleanup.
	}
}

function closeRecord(record: WatchRecord): void {
	if (!record.active) return;
	record.active = false;
	if (watchRegistry.get(record.key) === record) watchRegistry.delete(record.key);
	try {
		record.watcher.close();
	} catch {
		// The registry is still cleared even if the platform reports a close error.
	}
}

/** fs/copy: copy a file or recursively copy a directory tree. */
export const fsCopyHandler: MethodHandler = params => {
	if (!isRecord(params)) return invalidParams();
	const sourcePath = normalizedAbsolutePath(params.sourcePath);
	const destinationPath = normalizedAbsolutePath(params.destinationPath);
	if (!sourcePath || !destinationPath) return invalidParams();
	const recursive = params.recursive === undefined ? false : params.recursive;
	if (typeof recursive !== "boolean") return invalidParams();
	try {
		const source = statSync(sourcePath);
		if (source.isDirectory() && !recursive) return invalidParams();
		cpSync(sourcePath, destinationPath, {
			errorOnExist: false,
			force: true,
			recursive,
		});
		return { ok: true, result: {} };
	} catch (error) {
		return { ok: false, errorKey: errorKey(error) };
	}
};

/** fs/watch: register a real recursive filesystem watcher. */
export const fsWatchHandler: MethodHandler = (params, context) => {
	if (!isRecord(params) || typeof params.watchId !== "string") return invalidParams();
	const path = normalizedAbsolutePath(params.path);
	if (!path) return invalidParams();
	const key = registryKey(params.watchId, context);
	if (watchRegistry.has(key)) return { ok: false, errorKey: "conflict" };

	try {
		const canonicalPath = realpathSync(path);
		const isDirectory = statSync(canonicalPath).isDirectory();
		const watcher = watch(
			canonicalPath,
			{ encoding: "utf8", persistent: false, recursive: isDirectory },
			(_eventType, filename) => {
				const record = watchRegistry.get(key);
				if (record) emitChanged(record, filename);
			},
		);
		const record: WatchRecord = {
			key,
			watchId: params.watchId,
			connectionId: connectionIdOf(context),
			context,
			path: canonicalPath,
			isDirectory,
			watcher,
			active: true,
		};
		watchRegistry.set(key, record);
		watcher.on("error", () => closeRecord(record));
		return { ok: true, result: { path: canonicalPath } };
	} catch (error) {
		return { ok: false, errorKey: errorKey(error) };
	}
};

/** fs/unwatch: stop and close a watcher previously registered by fs/watch. */
export const fsUnwatchHandler: MethodHandler = (params, context) => {
	if (!isRecord(params) || typeof params.watchId !== "string") return invalidParams();
	const key = registryKey(params.watchId, context);
	const record = watchRegistry.get(key);
	if (!record) return { ok: false, errorKey: "notFound" };
	closeRecord(record);
	return { ok: true, result: {} };
};

export const fsWatchHandlers: Record<string, MethodHandler> = {
	"fs/copy": fsCopyHandler,
	"fs/watch": fsWatchHandler,
	"fs/unwatch": fsUnwatchHandler,
};

export function getFsWatchRegistrySize(): number {
	return watchRegistry.size;
}

export async function disposeFsWatchers(): Promise<void> {
	for (const record of [...watchRegistry.values()]) closeRecord(record);
}
