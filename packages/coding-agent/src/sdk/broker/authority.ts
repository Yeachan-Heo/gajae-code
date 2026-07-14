import { constants } from "node:fs";
import { type FileHandle, open as openFileHandle, realpath, stat } from "node:fs/promises";
import path from "node:path";

const { O_DIRECTORY = 0, O_NOFOLLOW = 0, O_RDONLY } = constants;

/**
 * Canonical filesystem identity of an opened workspace directory, captured as
 * stringified bigint `{dev,ino}` from an fstat of the retained directory handle.
 * Stable across broker restarts for the same on-disk directory, distinct for a
 * swapped or recreated root.
 */
export interface WorkspaceIdentity {
	readonly dev: string;
	readonly ino: string;
}

/** Narrows an unknown caller-supplied value to the exact workspace identity shape. */
export function isWorkspaceIdentity(value: unknown): value is WorkspaceIdentity {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { dev?: unknown }).dev === "string" &&
		(value as { dev: string }).dev.length > 0 &&
		typeof (value as { ino?: unknown }).ino === "string" &&
		(value as { ino: string }).ino.length > 0
	);
}

/**
 * Opened, handle-retained workspace authority. Realpaths the cwd, opens the
 * directory no-follow where the platform supports it, captures a bigint
 * `{dev,ino}` identity from the opened handle, and closes deterministically.
 *
 * The handle is retained for the lifetime of the request so that
 * {@link WorkspaceCapability.assertPathStillBound} can detect a root swap
 * (rename/recreate/symlink) performed between the initial open and a later
 * filesystem effect on the same path.
 */
export class WorkspaceCapability {
	readonly #canonicalCwd: string;
	readonly #identity: WorkspaceIdentity;
	readonly #handle: FileHandle;
	#closed = false;

	private constructor(canonicalCwd: string, identity: WorkspaceIdentity, handle: FileHandle) {
		this.#canonicalCwd = canonicalCwd;
		this.#identity = identity;
		this.#handle = handle;
	}

	get canonicalCwd(): string {
		return this.#canonicalCwd;
	}

	get identity(): WorkspaceIdentity {
		return this.#identity;
	}

	get closed(): boolean {
		return this.#closed;
	}

	/** Realpath the cwd, open the directory no-follow, and capture its bigint identity. */
	static async open(cwd: string): Promise<WorkspaceCapability> {
		const resolved = path.resolve(cwd);
		const canonical = await realpath(resolved);
		const handle = await openDirectoryNoFollow(canonical);
		try {
			const descriptor = await handle.stat({ bigint: true });
			if (!descriptor.isDirectory()) {
				throw new Error(`workspace capability requires a directory: ${canonical}`);
			}
			return new WorkspaceCapability(
				canonical,
				{
					dev: descriptor.dev.toString(),
					ino: descriptor.ino.toString(),
				},
				handle,
			);
		} catch (e) {
			try {
				await handle.close();
			} catch {}
			throw e;
		}
	}

	/**
	 * Re-resolves {@link targetPath} and rejects if it no longer binds to this
	 * capability's captured directory identity. Defends against a workspace root
	 * swap performed after the capability was opened.
	 */
	async assertPathStillBound(targetPath: string): Promise<void> {
		if (this.#closed) throw new Error("workspace capability is closed");
		const real = await realpath(path.resolve(targetPath));
		const descriptor = await stat(real, { bigint: true });
		if (descriptor.dev.toString() !== this.#identity.dev || descriptor.ino.toString() !== this.#identity.ino)
			throw new Error(`workspace root no longer bound to capability: ${targetPath}`);
	}

	/** Deterministic, idempotent release of the retained directory handle. */
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		try {
			await this.#handle.close();
		} catch {}
	}
}

/** Open a directory read-only, no-follow where the platform supports the flags. */
async function openDirectoryNoFollow(canonical: string): Promise<FileHandle> {
	const noFollow = O_NOFOLLOW as number | undefined;
	const directory = O_DIRECTORY as number | undefined;
	const noFollowFlags = O_RDONLY | (noFollow ?? 0) | (directory ?? 0);
	if (noFollowFlags !== O_RDONLY) {
		try {
			return await openFileHandle(canonical, noFollowFlags);
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			// Genuine failures (missing dir, symlink swap, permissions) carry an errno and
			// must propagate fail-closed. Unsupported flag semantics, or a non-errno error
			// from a runtime that rejects numeric flags, fall back to a plain read open.
			if (typeof code === "string" && code !== "EINVAL" && code !== "ENOSYS" && code !== "EOPNOTSUPP") throw e;
		}
	}
	return openFileHandle(canonical, "r");
}
