/**
 * Session-scoped artifact storage for truncated tool outputs.
 *
 * Artifacts are stored in a directory alongside the session file,
 * accessible via artifact:// URLs.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@gajae-code/utils";
import { DEFAULT_ARTIFACT_MAX_BYTES, truncateHeadBytes } from "./streaming-output";
export interface ArtifactSaveOptions {
	maxBytes?: number;
}

/**
 * Manages artifact storage for a session.
 *
 * Artifacts are stored with sequential IDs in the session's artifact directory.
 * The directory is created lazily on first write.
 *
 * Subagents do not own their own `ArtifactManager`. The parent's instance is
 * adopted via `SessionManager.adoptArtifactManager`, so the whole parent +
 * subagent tree shares one ID space and one directory.
 */
export class ArtifactManager {
	#nextId = 0;
	readonly #dir: string;
	#dirCreated = false;
	#initialized = false;

	/**
	 * @param dir Directory that will hold artifact files. Created lazily on first save.
	 */
	constructor(dir: string) {
		this.#dir = dir;
	}

	/**
	 * Artifact directory path.
	 * Directory may not exist until first artifact is saved.
	 */
	get dir(): string {
		return this.#dir;
	}

	async #ensureDir(): Promise<void> {
		if (!this.#dirCreated) {
			await fs.mkdir(this.#dir, { recursive: true });
			this.#dirCreated = true;
		}
		if (!this.#initialized) {
			await this.#scanExistingIds();
			this.#initialized = true;
		}
	}

	/**
	 * Scan existing artifact files to find the next available ID.
	 * This ensures we don't overwrite artifacts when resuming a session.
	 */
	async #scanExistingIds(): Promise<void> {
		const files = await this.listFiles();
		let maxId = -1;
		for (const file of files) {
			// Files are named: {id}.{toolType}.log
			const match = file.match(/^(\d+)\..*\.log$/);
			if (match) {
				const id = parseInt(match[1], 10);
				if (id > maxId) maxId = id;
			}
		}
		this.#nextId = maxId + 1;
	}

	/**
	 * Atomically allocate next artifact ID.
	 * IDs are sequential within the session.
	 */
	allocateId(): number {
		return this.#nextId++;
	}

	/**
	 * Allocate a new artifact path and ID without writing content.
	 *
	 * @param toolType Tool name for file extension (e.g., "bash", "read")
	 */
	async allocatePath(toolType: string): Promise<{ id: string; path: string }> {
		await this.#ensureDir();
		const id = String(this.allocateId());
		const filename = `${id}.${toolType}.log`;
		return { id, path: path.join(this.#dir, filename) };
	}

	/**
	 * Save content as an artifact and return the artifact ID.
	 *
	 * @param content Full content to save
	 * @param toolType Tool name for file extension (e.g., "bash", "read")
	 * @returns Artifact ID (numeric string)
	 */
	async save(content: string, toolType: string, options: ArtifactSaveOptions = {}): Promise<string> {
		const { id, path } = await this.allocatePath(toolType);
		const maxBytes = Math.max(0, options.maxBytes ?? DEFAULT_ARTIFACT_MAX_BYTES);
		const contentBytes = Buffer.byteLength(content, "utf-8");
		if (contentBytes > maxBytes) {
			const truncated = truncateHeadBytes(content, maxBytes);
			await Bun.write(
				path,
				`${truncated.text}\n[artifact truncated after ${truncated.bytes} bytes; omitted at least ${contentBytes - truncated.bytes} bytes]\n`,
			);
		} else {
			await Bun.write(path, content);
		}
		return id;
	}

	/**
	 * Check if an artifact exists.
	 * @param id Artifact ID (numeric string)
	 */
	async exists(id: string): Promise<boolean> {
		const files = await this.listFiles();
		return files.some(f => f.startsWith(`${id}.`));
	}

	/**
	 * List all artifact files in the directory.
	 * Returns empty array if directory doesn't exist.
	 */
	async listFiles(): Promise<string[]> {
		try {
			return await fs.readdir(this.#dir);
		} catch {
			return [];
		}
	}

	/**
	 * Get the full path to an artifact file.
	 * Returns null if artifact doesn't exist.
	 *
	 * @param id Artifact ID (numeric string)
	 */
	async getPath(id: string): Promise<string | null> {
		const files = await this.listFiles();
		const match = files.find(f => f.startsWith(`${id}.`));
		return match ? path.join(this.#dir, match) : null;
	}
}

/**
 * Narrow exclusive clone of a session artifact directory used by the fork
 * transaction. The destination MUST be new even when the source is absent:
 * any pre-existing path fails closed (no overwrite, no merge). The helper
 * returns true only while it owns a successfully cloned destination; an absent
 * source returns false after removing the empty destination it acquired.
 * Only regular files and directories are cloned; a symlink, socket, device,
 * FIFO, or other special entry aborts the clone. On any failure the
 * transaction-owned destination is removed before throwing.
 */
export async function cloneArtifactsExclusive(sourceDir: string, destDir: string): Promise<boolean> {
	try {
		await fs.mkdir(destDir, { recursive: false });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error(`Artifact destination already exists: ${destDir}`);
		}
		throw err;
	}

	try {
		let sourceStat: Awaited<ReturnType<typeof fs.lstat>>;
		try {
			sourceStat = await fs.lstat(sourceDir);
		} catch (err) {
			if (isEnoent(err)) {
				await fs.rmdir(destDir);
				return false;
			}
			throw err;
		}
		if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
			throw new Error(`Artifact source is not a regular directory: ${sourceDir}`);
		}
		await cloneArtifactsTreeExclusive(sourceDir, destDir);
		return true;
	} catch (err) {
		// Remove only the destination acquired by this invocation.
		await fs.rm(destDir, { recursive: true, force: true }).catch(() => {});
		throw err;
	}
}

async function cloneArtifactsTreeExclusive(source: string, dest: string): Promise<void> {
	const entries = await fs.readdir(source, { withFileTypes: true });
	for (const entry of entries) {
		const srcPath = path.join(source, entry.name);
		const destPath = path.join(dest, entry.name);
		if (entry.isDirectory()) {
			await fs.mkdir(destPath, { recursive: false });
			await cloneArtifactsTreeExclusive(srcPath, destPath);
		} else if (entry.isFile()) {
			await fs.copyFile(srcPath, destPath);
		} else {
			// symlink / socket / device / FIFO / …: never clone special entries.
			throw new Error(`Refusing to clone non-regular artifact entry: ${srcPath}`);
		}
	}
}
