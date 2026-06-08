import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, peekFile, toError } from "@gajae-code/utils";

const utf8Decoder = new TextDecoder("utf-8");

export interface SessionStorageStat {
	size: number;
	mtimeMs: number;
	mtime: Date;
}

export interface SessionStorageWriter {
	writeLine(line: string): Promise<void>;
	/**
	 * Synchronously append a single line. Returns once the bytes are handed to the kernel
	 * (page cache), so the data survives a non-graceful process death (OOM, SIGKILL, etc.)
	 * even though it has not yet been fsynced to the underlying disk.
	 *
	 * `line` MUST already include the trailing newline. Throws synchronously on I/O error.
	 */
	writeLineSync(line: string): void;
	flush(): Promise<void>;
	fsync(): Promise<void>;
	close(): Promise<void>;
	getError(): Error | undefined;
}

export interface SessionStorage {
	ensureDirSync(dir: string): void;
	existsSync(path: string): boolean;
	writeTextSync(path: string, content: string): void;
	readTextSync(path: string): string;
	statSync(path: string): SessionStorageStat;
	listFilesSync(dir: string, pattern: string): string[];

	exists(path: string): Promise<boolean>;
	readText(path: string): Promise<string>;
	readTextPrefix(path: string, maxBytes: number): Promise<string>;
	writeText(path: string, content: string): Promise<void>;
	rename(path: string, nextPath: string): Promise<void>;
	renameSync(path: string, nextPath: string): void;
	unlink(path: string): Promise<void>;
	unlinkSync(path: string): void;
	deleteSessionWithArtifacts(sessionPath: string): Promise<void>;
	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter;
}

// FinalizationRegistry to clean up leaked file descriptors
const writerRegistry = new FinalizationRegistry<number>(fd => {
	try {
		fs.closeSync(fd);
	} catch {
		// Ignore - fd may already be closed or invalid
	}
});

class FileSessionStorageWriter implements SessionStorageWriter {
	#fd: number;
	#closed = false;
	#error: Error | undefined;
	#onError: ((err: Error) => void) | undefined;

	constructor(fpath: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }) {
		this.#onError = options?.onError;
		const flags = options?.flags ?? "a";
		// Ensure parent directory exists
		const dir = path.dirname(fpath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		// Open file once, keep fd for lifetime
		this.#fd = fs.openSync(fpath, flags === "w" ? "w" : "a");
		// Register for cleanup if abandoned without close()
		writerRegistry.register(this, this.#fd, this);
	}

	#recordError(err: unknown): Error {
		const error = toError(err);
		if (!this.#error) this.#error = error;
		this.#onError?.(error);
		return error;
	}

	writeLineSync(line: string): void {
		if (this.#closed) throw new Error("Writer closed");
		if (this.#error) throw this.#error;
		try {
			const buf = Buffer.from(line, "utf-8");
			let offset = 0;
			while (offset < buf.length) {
				const written = fs.writeSync(this.#fd, buf, offset, buf.length - offset);
				if (written === 0) {
					throw new Error("Short write");
				}
				offset += written;
			}
		} catch (err) {
			throw this.#recordError(err);
		}
	}

	async writeLine(line: string): Promise<void> {
		this.writeLineSync(line);
	}

	async flush(): Promise<void> {
		if (this.#error) throw this.#error;
		// OS buffers are flushed on fsync, nothing to do here
	}

	async fsync(): Promise<void> {
		if (this.#closed) throw new Error("Writer closed");
		if (this.#error) throw this.#error;
		try {
			fs.fsyncSync(this.#fd);
		} catch (err) {
			throw this.#recordError(err);
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		// Unregister from finalization - we're closing properly
		writerRegistry.unregister(this);
		try {
			fs.closeSync(this.#fd);
		} catch {
			// Ignore close errors
		}
	}

	getError(): Error | undefined {
		return this.#error;
	}
}

export class FileSessionStorage implements SessionStorage {
	ensureDirSync(dir: string): void {
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
	}

	existsSync(path: string): boolean {
		return fs.existsSync(path);
	}

	writeTextSync(fpath: string, content: string): void {
		this.ensureDirSync(path.dirname(fpath));
		fs.writeFileSync(fpath, content);
	}

	readTextSync(fpath: string): string {
		return fs.readFileSync(fpath, "utf-8");
	}

	statSync(path: string): SessionStorageStat {
		const stats = fs.statSync(path);
		return { size: stats.size, mtimeMs: stats.mtimeMs, mtime: stats.mtime };
	}

	listFilesSync(dir: string, pattern: string): string[] {
		try {
			return Array.from(new Bun.Glob(pattern).scanSync(dir)).map(name => path.join(dir, name));
		} catch {
			return [];
		}
	}

	async exists(path: string): Promise<boolean> {
		try {
			await fs.promises.access(path);
			return true;
		} catch (err) {
			if (isEnoent(err)) return false;
			throw err;
		}
	}

	readText(path: string): Promise<string> {
		return Bun.file(path).text();
	}

	async readTextPrefix(path: string, maxBytes: number): Promise<string> {
		return peekFile(path, maxBytes, header => utf8Decoder.decode(header));
	}

	async writeText(path: string, content: string): Promise<void> {
		await Bun.write(path, content, { createPath: true });
	}

	async rename(path: string, nextPath: string): Promise<void> {
		try {
			await fs.promises.rename(path, nextPath);
		} catch (err) {
			throw toError(err);
		}
	}

	renameSync(path: string, nextPath: string): void {
		try {
			fs.renameSync(path, nextPath);
		} catch (err) {
			throw toError(err);
		}
	}

	unlink(path: string): Promise<void> {
		return fs.promises.unlink(path);
	}

	unlinkSync(path: string): void {
		fs.unlinkSync(path);
	}

	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		return new FileSessionStorageWriter(path, options);
	}

	/**
	 * Delete a session file and its artifacts directory.
	 * Artifacts are stored in a sibling directory with the same name minus .jsonl extension.
	 */
	async deleteSessionWithArtifacts(sessionPath: string): Promise<void> {
		// Delete the session file itself
		await this.unlink(sessionPath);

		// Compute artifacts directory: /path/to/session.jsonl -> /path/to/session
		const artifactsDir = sessionPath.slice(0, -6);

		// Delete artifacts directory if it exists. Missing directories are fine, but
		// surface real cleanup failures because the session file is already gone.
		try {
			await fsp.rm(artifactsDir, { recursive: true, force: true });
		} catch (err) {
			const error = toError(err);
			throw new Error(
				`Session file deleted but failed to remove artifacts directory ${artifactsDir}: ${error.message}`,
				{
					cause: error,
				},
			);
		}
	}
}

function matchesPattern(name: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (pattern.startsWith("*.")) {
		return name.endsWith(pattern.slice(1));
	}
	return name === pattern;
}

class MemorySessionStorageWriter implements SessionStorageWriter {
	#storage: MemorySessionStorage;
	#path: string;
	#closed = false;
	#error: Error | undefined;
	#onError: ((err: Error) => void) | undefined;

	constructor(
		storage: MemorySessionStorage,
		path: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	) {
		this.#storage = storage;
		this.#path = path;
		this.#onError = options?.onError;
		if ((options?.flags ?? "a") === "w") {
			this.#storage.writeTextSync(path, "");
		}
	}

	#recordError(err: unknown): Error {
		const error = toError(err);
		if (!this.#error) this.#error = error;
		this.#onError?.(error);
		return error;
	}

	writeLineSync(line: string): void {
		if (this.#closed) throw new Error("Writer closed");
		if (this.#error) throw this.#error;
		try {
			const existing = this.#storage.existsSync(this.#path) ? this.#storage.readTextSync(this.#path) : "";
			this.#storage.writeTextSync(this.#path, `${existing}${line}`);
		} catch (err) {
			throw this.#recordError(err);
		}
	}

	async writeLine(line: string): Promise<void> {
		this.writeLineSync(line);
	}

	async flush(): Promise<void> {
		if (this.#error) throw this.#error;
	}

	async fsync(): Promise<void> {
		// No-op for in-memory storage
		if (this.#error) throw this.#error;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
	}

	getError(): Error | undefined {
		return this.#error;
	}
}

export class MemorySessionStorage implements SessionStorage {
	#files = new Map<string, { content: string; mtimeMs: number }>();

	ensureDirSync(_dir: string): void {
		// No-op for in-memory storage.
	}

	existsSync(path: string): boolean {
		return this.#files.has(path);
	}

	writeTextSync(path: string, content: string): void {
		this.#files.set(path, { content, mtimeMs: Date.now() });
	}

	readTextSync(path: string): string {
		const entry = this.#files.get(path);
		if (!entry) throw new Error(`File not found: ${path}`);
		return entry.content;
	}

	statSync(path: string): SessionStorageStat {
		const entry = this.#files.get(path);
		if (!entry) throw new Error(`File not found: ${path}`);
		return {
			size: entry.content.length,
			mtimeMs: entry.mtimeMs,
			mtime: new Date(entry.mtimeMs),
		};
	}

	listFilesSync(dir: string, pattern: string): string[] {
		const prefix = dir.endsWith("/") ? dir : `${dir}/`;
		const files: string[] = [];
		for (const path of this.#files.keys()) {
			if (!path.startsWith(prefix)) continue;
			const name = path.slice(prefix.length);
			if (name.includes("/") || name.includes("\\")) continue;
			if (!matchesPattern(name, pattern)) continue;
			files.push(path);
		}
		return files;
	}

	exists(path: string): Promise<boolean> {
		return Promise.resolve(this.existsSync(path));
	}

	readText(path: string): Promise<string> {
		const entry = this.#files.get(path);
		if (!entry) return Promise.reject(new Error(`File not found: ${path}`));
		return Promise.resolve(entry.content);
	}

	readTextPrefix(path: string, maxBytes: number): Promise<string> {
		const entry = this.#files.get(path);
		if (!entry) return Promise.reject(new Error(`File not found: ${path}`));
		return Promise.resolve(entry.content.slice(0, maxBytes));
	}

	writeText(path: string, content: string): Promise<void> {
		this.writeTextSync(path, content);
		return Promise.resolve();
	}

	rename(path: string, nextPath: string): Promise<void> {
		const entry = this.#files.get(path);
		if (!entry) return Promise.reject(new Error(`File not found: ${path}`));
		this.#files.set(nextPath, entry);
		this.#files.delete(path);
		return Promise.resolve();
	}

	renameSync(path: string, nextPath: string): void {
		const entry = this.#files.get(path);
		if (!entry) throw new Error(`File not found: ${path}`);
		this.#files.set(nextPath, entry);
		this.#files.delete(path);
	}

	unlink(path: string): Promise<void> {
		this.#files.delete(path);
		return Promise.resolve();
	}

	unlinkSync(path: string): void {
		this.#files.delete(path);
	}

	deleteSessionWithArtifacts(_sessionPath: string): Promise<void> {
		return Promise.resolve();
	}

	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		return new MemorySessionStorageWriter(this, path, options);
	}
}
