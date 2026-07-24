/**
 * Path-scoped mutation coordinator for edit tools.
 *
 * Serializes concurrent read→compute→write windows against the same absolute
 * path so independent sessions cannot silently overwrite each other's successful
 * disjoint edits (https://github.com/Yeachan-Heo/gajae-code/issues/2900).
 *
 * - Always: in-process async mutex keyed by resolved absolute path.
 * - Optionally: durable cross-process lock under the host temp directory via
 *   `withFileLock` for real filesystem mutations (subagents / separate processes).
 *   Detached locks survive source-directory renames and never create target parents.
 *
 * Nested acquisition of the same path is not supported; callers that already
 * hold the lock must not re-enter.
 */
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { type FileLockOptions, withFileLock } from "../config/file-lock";

type AsyncMutex = {
	acquire(): Promise<() => void>;
};

const pathMutexes = new Map<string, AsyncMutex>();

function createAsyncMutex(): AsyncMutex {
	let locked = false;
	const waiters: Array<() => void> = [];
	return {
		async acquire(): Promise<() => void> {
			if (!locked) {
				locked = true;
				return () => release();
			}
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.push(resolve);
			await promise;
			return () => release();
		},
	};

	function release(): void {
		const next = waiters.shift();
		if (next) {
			next();
			return;
		}
		locked = false;
	}
}

function mutexFor(absolutePath: string): AsyncMutex {
	const key = path.resolve(absolutePath);
	let mutex = pathMutexes.get(key);
	if (!mutex) {
		mutex = createAsyncMutex();
		pathMutexes.set(key, mutex);
	}
	return mutex;
}

async function withInProcessPathLock<T>(absolutePath: string, fn: () => Promise<T>): Promise<T> {
	const release = await mutexFor(absolutePath).acquire();
	try {
		return await fn();
	} finally {
		release();
	}
}

/** Default lock budget: long enough for large writes + formatter writeback. */
const DEFAULT_CROSS_PROCESS_LOCK: FileLockOptions = {
	staleMs: 60_000,
	retries: 600,
	retryDelayMs: 50,
};

function durableMutationLockTarget(absolutePath: string): string {
	const digest = createHash("sha256").update(path.resolve(absolutePath)).digest("hex");
	return path.join(os.tmpdir(), "gjc-edit-path-locks", digest);
}

export type EditPathMutationOptions = {
	/**
	 * When true (default), also acquire a durable cross-process file lock.
	 * Disable for injectible/in-memory filesystem tests that do not touch disk.
	 */
	crossProcess?: boolean;
	fileLock?: FileLockOptions;
};

/**
 * Run `fn` while holding exclusive mutation rights for every absolute path.
 * Paths are locked in lexicographic order to avoid deadlocks on multi-path ops
 * (e.g. rename source + destination).
 */
export async function withEditPathMutation<T>(
	absolutePaths: readonly string[],
	fn: () => Promise<T>,
	options: EditPathMutationOptions = {},
): Promise<T> {
	const unique = [...new Set(absolutePaths.map(entry => path.resolve(entry)))].sort();
	if (unique.length === 0) return fn();

	const crossProcess = options.crossProcess !== false;
	const fileLock = { ...DEFAULT_CROSS_PROCESS_LOCK, ...options.fileLock };

	const runAt = async (index: number): Promise<T> => {
		if (index >= unique.length) return fn();
		const target = unique[index];
		const next = () => runAt(index + 1);
		return withInProcessPathLock(target, async () => {
			if (!crossProcess) return next();
			return withFileLock(durableMutationLockTarget(target), next, fileLock);
		});
	};

	return runAt(0);
}
