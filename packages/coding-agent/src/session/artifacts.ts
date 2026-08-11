/**
 * Session-scoped artifact storage for truncated tool outputs.
 *
 * Artifacts are stored in a directory alongside the session file,
 * accessible via artifact:// URLs.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";

import * as path from "node:path";
import {
	ensureManagedDirectory,
	type ManagedSessionDescendantStore,
	publishManagedFileNoReplace,
	publishManagedFileNoReplaceSync,
} from "./internal/managed-session-storage";
import { DEFAULT_ARTIFACT_MAX_BYTES, truncateHeadBytes } from "./streaming-output";

export interface ManagedOutputGeneration {
	outputFilename: string;
	metadataFilename: string;
	outputSizeBytes: number;
	outputSha256: string;
	metadataSizeBytes: number;
	metadataSha256: string;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function isSafeFilename(filename: string): boolean {
	return /^[a-zA-Z0-9_.-]+$/.test(filename);
}

const MAX_ATTEMPT_ID_LENGTH = 128;

function assertSafeAttemptId(attemptId: string): void {
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(attemptId) || attemptId.length > MAX_ATTEMPT_ID_LENGTH)
		throw new Error("Unsafe artifact attempt id");
}

function parseManagedOutputGeneration(value: Uint8Array, outputFilenamePrefix: string): ManagedOutputGeneration | null {
	try {
		const parsed = JSON.parse(Buffer.from(value).toString("utf8")) as Partial<ManagedOutputGeneration>;
		if (
			typeof parsed.outputFilename !== "string" ||
			typeof parsed.metadataFilename !== "string" ||
			typeof parsed.outputSizeBytes !== "number" ||
			typeof parsed.outputSha256 !== "string" ||
			typeof parsed.metadataSizeBytes !== "number" ||
			typeof parsed.metadataSha256 !== "string" ||
			!isSafeFilename(parsed.outputFilename) ||
			!isSafeFilename(parsed.metadataFilename) ||
			!parsed.outputFilename.startsWith(`${outputFilenamePrefix}.`) ||
			!parsed.outputFilename.endsWith(".output") ||
			parsed.metadataFilename !== `${parsed.outputFilename}.meta.json`
		)
			return null;
		return parsed as ManagedOutputGeneration;
	} catch {
		return null;
	}
}

function sameGeneration(left: ManagedOutputGeneration, right: ManagedOutputGeneration): boolean {
	return left.outputFilename === right.outputFilename && left.metadataFilename === right.metadataFilename;
}
export interface ArtifactSaveOptions {
	maxBytes?: number;
}

export type ArtifactPublishOutcome =
	| { outcome: "saved"; handle: import("../tools/output-meta").EvictedToolOutputHandle }
	| { outcome: "incomplete"; bytes: number; maxBytes: number }
	| { outcome: "unavailable"; diagnostic: string }
	| { outcome: "failed"; diagnostic: string };

export interface ArtifactPublishOptions {
	/** Disable persistence explicitly; this fails closed without writing. */
	persist?: boolean;
	maxBytes?: number;
	toolType?: string;
}

export interface ArtifactByteRange {
	start?: number;
	endExclusive?: number;
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
	readonly #store: ManagedSessionDescendantStore | undefined;
	#dirCreated = false;
	#initialized: Promise<void> | undefined;
	#initializedComplete = false;
	readonly #attemptId: string | undefined;
	readonly #allocatedIds = new Set<string>();
	readonly #retiredIds = new Set<string>();
	#reservations = new Map<string, { start: number; count: number; names: string[] }>();
	readonly #stagingParentStore: ManagedSessionDescendantStore | undefined;
	readonly #stagingRelativePath: string | undefined;

	/**
	 * @param dir Directory that will hold artifact files. Created lazily on first save.
	 */
	constructor(
		target: string | ManagedSessionDescendantStore,
		options?: {
			readonly attemptId?: string;
			readonly stagingParentStore?: ManagedSessionDescendantStore;
			readonly stagingRelativePath?: string;
		},
	) {
		this.#store = typeof target === "string" ? undefined : target;
		this.#dir = typeof target === "string" ? target : target.dir;
		this.#attemptId = options?.attemptId;
		this.#stagingParentStore = options?.stagingParentStore;
		this.#stagingRelativePath = options?.stagingRelativePath;
	}

	/**
	 * Artifact directory path.
	 * Directory may not exist until first artifact is saved.
	 */
	get dir(): string {
		return this.#dir;
	}

	getManagedRootAuthority() {
		return this.#store?.rootAuthority;
	}

	getManagedSubtreeRootAuthority() {
		return this.#store?.subtreeRootAuthority;
	}

	getManagedStore(): ManagedSessionDescendantStore | undefined {
		return this.#store;
	}

	assertManagedBinding(): void {
		this.#store?.assertBound();
	}

	async #ensureDir(): Promise<void> {
		if (!this.#dirCreated) {
			if (this.#store) this.#store.ensureDirectory();
			else ensureManagedDirectory(this.#dir);
			this.#dirCreated = true;
		}
		// Memoized: concurrent first writers must not each rescan and restart the
		// ID counter at the same value, which would collide on publish.
		this.#initialized ??= this.#scanExistingIds();
		await this.#initialized;
	}

	#filename(id: string, toolType: string): string {
		if (!/^[a-zA-Z0-9_-]+$/.test(toolType)) throw new Error("Unsafe artifact tool type");
		return `${id}.${toolType}.log`;
	}

	#claimFilename(id: number): string {
		return `.artifact-id-${id}`;
	}

	#nextCandidateId(): number {
		const id = this.#nextId++;
		if (!Number.isSafeInteger(id) || id < 0) throw new Error("artifact_id_out_of_range");
		return id;
	}

	async #claimNextId(): Promise<number> {
		while (true) {
			const id = this.#nextCandidateId();
			try {
				await this.#publish("", this.#claimFilename(id));
				return id;
			} catch (error) {
				if (!(error instanceof Error) || error.message !== "destination_conflict") throw error;
			}
		}
	}

	#claimNextIdSync(): number {
		if (!this.#initializedComplete)
			throw new Error("ArtifactManager must be initialized before synchronous allocation");
		while (true) {
			const id = this.#nextCandidateId();
			try {
				const filename = this.#claimFilename(id);
				if (this.#store) this.#store.publishNoReplaceSync(filename, new Uint8Array());
				else publishManagedFileNoReplaceSync(path.join(this.#dir, filename), new Uint8Array());
				return id;
			} catch (error) {
				if (!(error instanceof Error) || error.message !== "destination_conflict") throw error;
			}
		}
	}

	async #publish(content: string, filename: string): Promise<void> {
		await this.#publishBytes(Buffer.from(content, "utf8"), filename);
	}

	async #publishBytes(bytes: Uint8Array, filename: string): Promise<void> {
		if (this.#store) await this.#store.publishNoReplace(filename, bytes);
		else await publishManagedFileNoReplace(path.join(this.#dir, filename), bytes);
	}

	async replaceNamed(filename: string, content: string): Promise<void> {
		if (!/^[a-zA-Z0-9_.-]+$/.test(filename)) throw new Error("Unsafe named artifact");
		await this.#ensureDir();
		if (this.#store) await this.#store.replace(filename, Buffer.from(content, "utf8"));
		else await Bun.write(path.join(this.#dir, filename), content);
	}

	async replaceNamedBytes(filename: string, bytes: Uint8Array): Promise<void> {
		if (!/^[a-zA-Z0-9_.-]+$/.test(filename)) throw new Error("Unsafe named artifact");
		await this.#ensureDir();
		if (this.#store) await this.#store.replace(filename, bytes);
		else await Bun.write(path.join(this.#dir, filename), bytes);
	}

	async publishManagedOutputGeneration(
		selectorFilename: string,
		outputFilenamePrefix: string,
		outputBytes: Uint8Array,
		metadataBytes: Uint8Array,
	): Promise<void> {
		if (!isSafeFilename(selectorFilename) || !isSafeFilename(outputFilenamePrefix)) {
			throw new Error("Unsafe managed output generation");
		}
		await this.#ensureDir();
		if (!this.#store) throw new Error("Managed output generation requires retained authority");

		const priorSelector = this.#store.readExpected(selectorFilename);
		const priorGeneration = priorSelector
			? parseManagedOutputGeneration(priorSelector.bytes, outputFilenamePrefix)
			: null;
		const generationId = randomUUID();
		const outputFilename = `${outputFilenamePrefix}.${generationId}.output`;
		const metadataFilename = `${outputFilename}.meta.json`;
		const generation: ManagedOutputGeneration = {
			outputFilename,
			metadataFilename,
			outputSizeBytes: outputBytes.byteLength,
			outputSha256: sha256(outputBytes),
			metadataSizeBytes: metadataBytes.byteLength,
			metadataSha256: sha256(metadataBytes),
		};

		// Immutable generations are not visible until the selector is replaced.
		await this.#store.publishNoReplace(outputFilename, outputBytes);
		await this.#store.publishNoReplace(metadataFilename, metadataBytes);
		const stagedOutput = this.#store.readExpected(outputFilename);
		const stagedMetadata = this.#store.readExpected(metadataFilename);
		if (
			!stagedOutput ||
			!stagedMetadata ||
			stagedOutput.bytes.byteLength !== generation.outputSizeBytes ||
			stagedMetadata.bytes.byteLength !== generation.metadataSizeBytes ||
			sha256(stagedOutput.bytes) !== generation.outputSha256 ||
			sha256(stagedMetadata.bytes) !== generation.metadataSha256
		) {
			throw new Error("managed_output_generation_verification_failed");
		}

		await this.#store.replace(selectorFilename, Buffer.from(JSON.stringify(generation), "utf8"));
		const publishedSelector = this.#store.readExpected(selectorFilename);
		const publishedGeneration = publishedSelector
			? parseManagedOutputGeneration(publishedSelector.bytes, outputFilenamePrefix)
			: null;
		if (!publishedGeneration || !sameGeneration(publishedGeneration, generation)) {
			throw new Error("managed_output_selector_verification_failed");
		}

		// Cleanup cannot affect the selected generation or publication outcome.
		if (priorGeneration && !sameGeneration(priorGeneration, generation)) {
			for (const filename of [priorGeneration.outputFilename, priorGeneration.metadataFilename]) {
				try {
					const previous = this.#store.readExpected(filename);
					if (previous) this.#store.removeExpected(filename, previous);
				} catch {
					// Retain unreachable generations for a later safe cleanup.
				}
			}
		}
	}
	async publishNamedNoReplace(filename: string, bytes: Uint8Array): Promise<void> {
		if (!/^[a-zA-Z0-9_.-]+$/.test(filename)) throw new Error("Unsafe named artifact");
		await this.#ensureDir();
		if (this.#store) await this.#store.publishNoReplace(filename, bytes);
		else await publishManagedFileNoReplace(path.join(this.#dir, filename), bytes);
	}

	/**
	 * Best-effort removal of a previously published named artifact. Used to roll
	 * back staged publications when a transactional operation (e.g. gated
	 * maintenance pruning) is rejected after publication succeeded. Returns false
	 * when the artifact could not be removed so callers can log the failure
	 * instead of silently treating the rollback as complete.
	 */
	async removeNamedBestEffort(filename: string): Promise<boolean> {
		if (!/^[a-zA-Z0-9_.-]+$/.test(filename)) return false;
		try {
			if (this.#store) {
				const beforePaths = new Set(await fs.readdir(this.#store.dir));
				const staged = this.#store.readExpected(filename);
				if (staged) this.#store.removeExpected(filename, staged);
				// Capture only root names outside retained authority so foreign sibling
				// placeholders cannot make rollback fail before exact removal runs.
				for (const basename of await fs.readdir(this.#store.dir)) {
					const nativeResidue = /^\.gjc-/u.test(basename);
					const ownQuarantine = basename === `${filename}.removing` || basename.startsWith(`${filename}.`);
					if (beforePaths.has(basename) || (!nativeResidue && !ownQuarantine)) continue;
					const residuePath = path.join(this.#store.dir, basename);
					const stat = await fs.lstat(residuePath);
					await fs.rm(residuePath, { recursive: stat.isDirectory(), force: true });
				}
			} else {
				await fs.unlink(path.join(this.#dir, filename));
			}
			return true;
		} catch {
			return false;
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
			// Published artifacts are `{id}.{toolType}.log`; hidden claim files reserve
			// the numeric namespace across independent managers and processes.
			const match = file.match(/^(\d+)\..*\.log$/) ?? file.match(/^\.artifact-id-(\d+)$/);
			if (match) {
				const id = Number(match[1]);
				if (!Number.isSafeInteger(id) || id < 0) throw new Error("artifact_id_out_of_range");
				if (id > maxId) maxId = id;
			}
		}
		this.#nextId = maxId + 1;
		this.#initializedComplete = true;
	}

	/**
	 * Atomically claim the next artifact ID after this manager has been initialized.
	 * Prefer `allocatePath` or `save`; this synchronous seam exists for pruning callbacks.
	 */
	allocateId(): number {
		while (this.#retiredIds.has(String(this.#nextId))) this.#nextId++;
		const id = this.#claimNextIdSync();
		this.#allocatedIds.add(String(id));
		return id;
	}

	/**
	 * Reserve an artifact ID without exposing a writable managed pathname.
	 *
	 * Streaming callers that only understand bare paths fail closed; use `save`
	 * for terminally published artifact content.
	 */
	async allocatePath(toolType: string): Promise<{ id: string; path?: string }> {
		await this.#ensureDir();
		const id = String(await this.#claimNextId());
		this.#allocatedIds.add(id);
		if (this.#store) return { id };
		return { id, path: path.join(this.#dir, this.#filename(id, toolType)) };
	}

	/**
	 * Save content as an artifact and return the artifact ID.
	 * Content is written to a private temporary inode, synced, and linked into
	 * the artifact directory only after the complete terminal payload exists.
	 */
	async save(content: string, toolType: string, options: ArtifactSaveOptions = {}): Promise<string> {
		await this.#ensureDir();
		const id = String(await this.#claimNextId());
		this.#allocatedIds.add(id);
		const maxBytes = Math.max(0, options.maxBytes ?? DEFAULT_ARTIFACT_MAX_BYTES);
		const contentBytes = Buffer.byteLength(content, "utf-8");
		const published =
			contentBytes > maxBytes
				? (() => {
						const truncated = truncateHeadBytes(content, maxBytes);
						return `${truncated.text}\n[artifact truncated after ${truncated.bytes} bytes; omitted at least ${contentBytes - truncated.bytes} bytes]\n`;
					})()
				: content;
		await this.#publish(published, this.#filename(id, toolType));
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
			if (this.#store) {
				return this.#store
					.captureTree("")
					.entries.filter(entry => entry.kind === "file" && entry.relativePath.length > 0)
					.map(entry => entry.relativePath);
			}
			return await fs.readdir(this.#dir);
		} catch {
			return [];
		}
	}
	getAttemptId(): string | undefined {
		return this.#attemptId;
	}

	getAllocatedIds(): readonly string[] {
		return [...this.#allocatedIds].sort((a, b) => Number(a) - Number(b));
	}

	/** Create an isolated artifact manager rooted below this manager's staging area. */
	createAttemptStaging(attemptId: string): ArtifactManager {
		assertSafeAttemptId(attemptId);
		const stagingRelativePath = path.posix.join(".staging", attemptId);
		const target = this.#store
			? this.#store.deriveSubtree(stagingRelativePath)
			: path.join(this.#dir, stagingRelativePath);
		return new ArtifactManager(target, {
			attemptId,
			...(this.#store ? { stagingParentStore: this.#store, stagingRelativePath } : {}),
		});
	}

	/** Reserve and publish a candidate's staged artifacts with a contiguous parent ID block. */
	async commitAttemptStaging(
		staging: ArtifactManager,
		attemptId: string,
		options?: { beforePublish?: (mapping: ReadonlyMap<string, string>) => Promise<void> | void },
	): Promise<ReadonlyMap<string, string>> {
		if (staging.#attemptId !== attemptId) throw new Error("Artifact staging ownership mismatch");
		assertSafeAttemptId(attemptId);
		await this.#ensureDir();
		await staging.#ensureDir();
		const ids = staging.getAllocatedIds();
		const start = this.#nextId;
		this.#nextId += ids.length;
		const mapping = new Map<string, string>();
		for (let index = 0; index < ids.length; index++) mapping.set(ids[index]!, String(start + index));
		const frozenMap = new Map(mapping) as Map<string, string> & ReadonlyMap<string, string>;
		Object.defineProperties(frozenMap, {
			set: {
				value: () => {
					throw new Error("Artifact ID map is immutable");
				},
			},
			delete: {
				value: () => {
					throw new Error("Artifact ID map is immutable");
				},
			},
			clear: {
				value: () => {
					throw new Error("Artifact ID map is immutable");
				},
			},
		});
		Object.freeze(frozenMap);
		const publishedNames: string[] = [];
		try {
			await options?.beforePublish?.(frozenMap);
			for (const filename of await staging.listFiles()) {
				if (/^\.artifact-id-\d+$/.test(filename)) continue;
				const bytes = staging.#store
					? staging.#store.readExpected(filename)?.bytes
					: await fs.readFile(path.join(staging.#dir, filename));
				if (!bytes) continue;
				const match = filename.match(/^(\d+)(\..*)$/);
				const mappedFilename = match ? `${mapping.get(match[1]!) ?? match[1]}${match[2]}` : filename;
				await this.#publishBytes(bytes, mappedFilename);
				publishedNames.push(mappedFilename);
			}
			this.#reservations.set(attemptId, { start, count: ids.length, names: [...publishedNames] });
			await staging.discardAttemptStaging();
			return frozenMap;
		} catch (error) {
			// Cleanup is best-effort, but a durable removal failure must never be silent: it leaves a
			// published artifact behind under an id we are about to retire. Surface it alongside the
			// original publication error rather than dropping the boolean.
			const unremoved: string[] = [];
			for (const filename of publishedNames.reverse())
				if (!(await this.removeNamedBestEffort(filename))) unremoved.push(filename);
			// Only rewind the tail when every published artifact was actually removed. If any removal
			// failed, the file still occupies its id, so retire the whole block instead of handing the
			// ids out again.
			if (unremoved.length === 0 && this.#nextId === start + ids.length) this.#nextId = start;
			else for (const id of mapping.values()) this.#retiredIds.add(id);
			if (unremoved.length > 0)
				throw new AggregateError(
					[error, new Error(`Failed to roll back published artifacts: ${unremoved.join(", ")}`)],
					"Attempt-staging publication failed and rollback left artifacts behind.",
				);
			throw error;
		}
	}
	async rollbackLastAttemptCommit(attemptId?: string): Promise<void> {
		if (attemptId === undefined) return;
		const reservation = this.#reservations.get(attemptId);
		if (!reservation) return;
		const unremoved: string[] = [];
		for (const filename of [...reservation.names].reverse())
			if (!(await this.removeNamedBestEffort(filename))) unremoved.push(filename);
		// Only rewind the tail when every published artifact was actually removed; otherwise retire the
		// whole block so a leaked file's id can never be reallocated.
		if (unremoved.length === 0 && this.#nextId === reservation.start + reservation.count)
			this.#nextId = reservation.start;
		else
			for (let index = 0; index < reservation.count; index++)
				this.#retiredIds.add(String(reservation.start + index));
		this.#reservations.delete(attemptId);
		// The reservation is always released so ids can never be reused, but a failed durable removal
		// is reported rather than swallowed.
		if (unremoved.length > 0) throw new Error(`Failed to roll back published artifacts: ${unremoved.join(", ")}`);
	}

	finalizeLastAttemptCommit(attemptId?: string): void {
		if (attemptId !== undefined) this.#reservations.delete(attemptId);
	}

	async discardAttemptStaging(): Promise<void> {
		if (this.#store) {
			const cleanupStore = this.#stagingParentStore ?? this.#store;
			const cleanupPath = this.#stagingParentStore ? this.#stagingRelativePath! : "";
			const parentCleanupPath = cleanupPath ? path.posix.dirname(cleanupPath) : "";
			let parentBefore: ReturnType<ManagedSessionDescendantStore["captureTree"]> | undefined;
			if (this.#stagingParentStore) {
				try {
					parentBefore = cleanupStore.captureTree(parentCleanupPath);
				} catch {
					parentBefore = undefined;
				}
			}
			try {
				const snapshot = cleanupStore.captureTree(cleanupPath);
				cleanupStore.removeTreeExpected(cleanupPath, snapshot);
			} catch (error) {
				if (!(error instanceof Error && (error.message === "not_found" || error.message === "cleanup_pending")))
					throw error;
			}
			if (this.#stagingParentStore && parentBefore) {
				try {
					const after = cleanupStore.captureTree(parentCleanupPath);
					const beforePaths = new Set(parentBefore.entries.map(entry => entry.relativePath));
					for (const entry of after.entries) {
						if (
							entry.kind === "directory" &&
							entry.relativePath.length > 0 &&
							!beforePaths.has(entry.relativePath) &&
							/\.removing$/u.test(path.posix.basename(entry.relativePath))
						) {
							await fs.rm(path.join(cleanupStore.dir, parentCleanupPath, entry.relativePath), {
								recursive: true,
								force: true,
							});
							continue;
						}
						if (
							entry.kind !== "file" ||
							beforePaths.has(entry.relativePath) ||
							!/^\\.gjc-(?:exact-unlink-placeholder|remove)-/u.test(path.posix.basename(entry.relativePath))
						)
							continue;
						const relative = path.posix.join(parentCleanupPath, entry.relativePath);
						const expected = cleanupStore.readExpected(relative);
						if (expected) {
							try {
								cleanupStore.removeExpected(relative, expected);
							} catch (cleanupError) {
								if (!(cleanupError instanceof Error && cleanupError.message === "cleanup_pending"))
									throw cleanupError;
							}
						}
						await fs.rm(path.join(cleanupStore.dir, relative), { force: true }).catch(() => undefined);
					}
				} catch {
					// Retained cleanup evidence is safe to leave for a later maintenance pass.
				}
			}
			this.#store.close();
		} else {
			await fs.rm(this.#dir, { recursive: true, force: true });
		}
		this.#dirCreated = false;
	}

	/** Persist exact UTF-8 text for heap-eviction rehydration. */
	async publishExactText(text: string, options: ArtifactPublishOptions = {}): Promise<ArtifactPublishOutcome> {
		const bytes = Buffer.from(text, "utf8");
		const maxBytes = Math.max(0, options.maxBytes ?? DEFAULT_ARTIFACT_MAX_BYTES);
		if (options.persist === false) return { outcome: "unavailable", diagnostic: "artifact persistence disabled" };
		if (bytes.byteLength > maxBytes) return { outcome: "incomplete", bytes: bytes.byteLength, maxBytes };
		let filename: string | undefined;
		try {
			const toolType = options.toolType ?? "evicted";
			const id = String((await this.allocatePath(toolType)).id);
			filename = this.#filename(id, toolType);
			await this.#publish(bytes.toString("utf8"), filename);
			const written = this.#store
				? this.#store.readExpected(filename)?.bytes
				: await fs.readFile(path.join(this.#dir, filename));
			if (!written || written.byteLength !== bytes.byteLength || sha256(written) !== sha256(bytes)) {
				throw new Error("artifact publication verification failed");
			}
			return {
				outcome: "saved",
				handle: {
					v: 1,
					artifactId: id,
					uri: `artifact://${id}`,
					encoding: "utf-8",
					bytes: bytes.byteLength,
					sha256: sha256(bytes),
					complete: true,
				},
			};
		} catch (error) {
			if (filename) await this.removeNamedBestEffort(filename);
			return { outcome: "failed", diagnostic: error instanceof Error ? error.message : String(error) };
		}
	}

	async readRange(id: string, range: ArtifactByteRange = {}): Promise<string> {
		const artifactPath = await this.getPath(id);
		if (!artifactPath) throw new Error(`artifact://${id} not found`);
		const file = Bun.file(artifactPath);
		const size = file.size;
		const start = Math.max(0, Math.min(size, range.start ?? 0));
		const end = Math.max(start, Math.min(size, range.endExclusive ?? size));
		return await file.slice(start, end).text();
	}

	async openReadStream(id: string, range: ArtifactByteRange = {}): Promise<ReadableStream<Uint8Array>> {
		const artifactPath = await this.getPath(id);
		if (!artifactPath) throw new Error(`artifact://${id} not found`);
		const file = Bun.file(artifactPath);
		const size = file.size;
		const start = Math.max(0, Math.min(size, range.start ?? 0));
		const end = Math.max(start, Math.min(size, range.endExclusive ?? size));
		return file.slice(start, end).stream();
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
