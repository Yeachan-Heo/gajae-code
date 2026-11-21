import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { confinedMkdirAll, confinedOpenRead, confinedUnlink, confinedWriteFileAtomic } from "@gajae-code/natives";
import { pathIsWithin } from "@gajae-code/utils";

/** Lexical containment: true when `candidate` is neither `root` nor beneath it. No filesystem access. */
export function pathEscapesWorkspace(root: string, candidate: string): boolean {
	const resolvedRoot = path.resolve(root);
	const resolvedCandidate = path.resolve(candidate);
	return resolvedCandidate !== resolvedRoot && !pathIsWithin(resolvedRoot, resolvedCandidate);
}

/** `root` as the native helpers see it: its canonical path and the directory identity pinned for it. */
interface PinnedRoot {
	realPath: string;
	/** `"<dev>:<ino>"`; the native helpers compare it with `fstat` on the root descriptor they open. */
	id: string;
}

/** A target admitted beneath the root, expressed relative to the pinned canonical root. */
interface ConfinedTarget {
	root: PinnedRoot;
	/** Symlink-free path relative to `root.realPath`. */
	relative: string;
}

const NATIVE_REASON_CODES: Record<string, string> = {
	not_found: "ENOENT",
	is_directory: "EISDIR",
	not_directory: "ENOTDIR",
	permission_denied: "EACCES",
	read_only: "EROFS",
};

/**
 * The filesystem boundary of a session opened with `gjc --confine`.
 *
 * Rule: while a session is confined, every file read, write, delete, and
 * mkdir a tool performs goes through one of these methods. Callers reach the
 * session's instance through the `...InsideActiveWorkspace` helpers in
 * `path-utils.ts`; they do not re-implement the checks.
 *
 * Each operation has two stages:
 *
 * 1. Path admission (TypeScript). The candidate is resolved through symlinks;
 *    a path that does not exist yet is resolved at its nearest existing
 *    ancestor, so creating `root/link/new` is rejected when `link` points
 *    outside. This only decides which relative path to ask for.
 * 2. Pinned access (native, `crates/pi-natives/src/confine_fs.rs`). The
 *    helper opens the root, checks that the descriptor is the directory
 *    pinned here, and walks every component with `openat(..., O_NOFOLLOW)`.
 *    A root or parent swapped after stage 1 fails the operation instead of
 *    redirecting it.
 *
 * The root's identity is pinned on the first operation and kept for the
 * lifetime of the instance. {@link WorkspaceConfinement.forRoot} hands out
 * one instance per root for the whole process, so every tool call of a
 * session checks against the same pin.
 */
export class WorkspaceConfinement {
	static readonly #byRoot = new Map<string, WorkspaceConfinement>();

	/** The process-wide boundary for `root`; created and pinned on first use. */
	static forRoot(root: string): WorkspaceConfinement {
		const resolved = path.resolve(root);
		let confinement = WorkspaceConfinement.#byRoot.get(resolved);
		if (!confinement) {
			confinement = new WorkspaceConfinement(resolved);
			WorkspaceConfinement.#byRoot.set(resolved, confinement);
		}
		return confinement;
	}

	readonly root: string;
	#pinned: Promise<PinnedRoot> | undefined;

	private constructor(root: string) {
		this.root = root;
	}

	/** Lexical check only; use {@link realpathEscapes} before touching the path. */
	escapes(candidate: string): boolean {
		return pathEscapesWorkspace(this.root, candidate);
	}

	/** True when `candidate` resolves, through symlinks, outside the root. */
	async realpathEscapes(candidate: string): Promise<boolean> {
		return (await this.#resolve(candidate, true)) === undefined;
	}

	/** Open an existing regular file for reading through the pinned walk. */
	async openFile(candidate: string): Promise<fs.FileHandle> {
		const target = await this.#require(candidate, true);
		const fd = this.#native(candidate, () => confinedOpenRead(target.root.realPath, target.root.id, target.relative));
		try {
			// Opening /dev/fd/N duplicates the already-open file; it does not walk
			// the original pathname again.
			return await fs.open(`/dev/fd/${fd}`, "r");
		} finally {
			fsSync.closeSync(fd);
		}
	}

	async readFile(candidate: string): Promise<Buffer> {
		const handle = await this.openFile(candidate);
		try {
			return Buffer.from(await handle.readFile());
		} finally {
			await handle.close();
		}
	}

	/** Atomically replace or create a file; missing parents are created through the same walk. */
	async writeFile(candidate: string, content: string | Uint8Array): Promise<void> {
		const target = await this.#require(candidate, true);
		const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
		this.#native(candidate, () =>
			confinedWriteFileAtomic(target.root.realPath, target.root.id, target.relative, bytes, true),
		);
	}

	/** Remove a file. A final symlink is removed itself; its target is untouched. */
	async unlink(candidate: string): Promise<void> {
		const target = await this.#require(candidate, false);
		this.#native(candidate, () => confinedUnlink(target.root.realPath, target.root.id, target.relative));
	}

	/** Create a directory and any missing ancestors. */
	async mkdir(candidate: string): Promise<void> {
		const target = await this.#require(candidate, true);
		this.#native(candidate, () => confinedMkdirAll(target.root.realPath, target.root.id, target.relative));
	}

	#pin(): Promise<PinnedRoot> {
		this.#pinned ??= (async () => {
			const realPath = await fs.realpath(this.root);
			const stat = await fs.stat(realPath, { bigint: true });
			if (!stat.isDirectory()) throw new Error(`Confined session root is not a directory: ${realPath}`);
			return { realPath, id: `${stat.dev}:${stat.ino}` };
		})();
		return this.#pinned;
	}

	/**
	 * Stage 1: admit `candidate` and express it relative to the pinned root,
	 * or return `undefined` when it escapes. With `followFinal` false the last
	 * component is kept as written (only its parent is resolved), so unlinking
	 * a symlink names the link rather than its target.
	 */
	async #resolve(candidate: string, followFinal: boolean): Promise<ConfinedTarget | undefined> {
		const absolute = path.resolve(candidate);
		if (!followFinal) {
			const parent = await this.#resolve(path.dirname(absolute), true);
			if (!parent) return undefined;
			const relative = path.join(parent.relative, path.basename(absolute));
			return relative === "" || relative.startsWith("..") ? undefined : { root: parent.root, relative };
		}
		const [root, existing] = await Promise.all([this.#pin(), nearestExistingPath(absolute)]);
		const isLink = (await fs.lstat(existing)).isSymbolicLink();
		// A dangling symlink has no real target to admit.
		const realExisting = isLink ? await fs.realpath(existing).catch(() => undefined) : await fs.realpath(existing);
		if (!realExisting) return undefined;
		const missingSuffix = path.relative(existing, absolute);
		const resolved = missingSuffix ? path.resolve(realExisting, missingSuffix) : realExisting;
		if (resolved !== root.realPath && !pathIsWithin(root.realPath, resolved)) return undefined;
		return { root, relative: path.relative(root.realPath, resolved) };
	}

	async #require(candidate: string, followFinal: boolean): Promise<ConfinedTarget> {
		const target = await this.#resolve(candidate, followFinal);
		if (!target) throw this.#escapeError(candidate);
		return target;
	}

	/** Stage 2: run a native helper and map its `confine:<reason>` error onto an fs-style error. */
	#native<T>(candidate: string, operation: () => T): T {
		try {
			return operation();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const match = /^confine:([a-z_]+): (.*)$/s.exec(message);
			if (!match) throw error;
			const [, reason, detail] = match;
			if (reason === "escape") throw this.#escapeError(candidate, error);
			const mapped = new Error(`${detail}: ${candidate}`, { cause: error }) as NodeJS.ErrnoException;
			const code = NATIVE_REASON_CODES[reason];
			if (code) mapped.code = code;
			throw mapped;
		}
	}

	#escapeError(candidate: string, cause?: unknown): Error {
		return new Error(
			`Path resolves outside the confined session root (${this.root}): ${candidate}`,
			cause === undefined ? undefined : { cause },
		);
	}
}

/** For callers that hold only a root path, e.g. a task child validating its cwd against the parent's root. */
export function directoryEscapesWorkspace(root: string, candidate: string): Promise<boolean> {
	return WorkspaceConfinement.forRoot(root).realpathEscapes(candidate);
}

async function nearestExistingPath(candidate: string): Promise<string> {
	let current = path.resolve(candidate);
	for (;;) {
		try {
			await fs.lstat(current);
			return current;
		} catch (error) {
			const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
			const parent = path.dirname(current);
			if (!missing || parent === current) throw error;
			current = parent;
		}
	}
}
