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
	#initialized = false;

	/**
	 * @param dir Directory that will hold artifact files. Created lazily on first save.
	 */
	constructor(target: string | ManagedSessionDescendantStore) {
		this.#store = typeof target === "string" ? undefined : target;
		this.#dir = typeof target === "string" ? target : target.dir;
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
		if (!this.#initialized) {
			await this.#scanExistingIds();
			this.#initialized = true;
		}
	}

	#filename(id: string, toolType: string): string {
		if (!/^[a-zA-Z0-9_-]+$/.test(toolType)) throw new Error("Unsafe artifact tool type");
		return `${id}.${toolType}.log`;
	}

	async #publish(content: string, filename: string): Promise<void> {
		if (this.#store) await this.#store.publishNoReplace(filename, Buffer.from(content, "utf8"));
		else await publishManagedFileNoReplace(path.join(this.#dir, filename), Buffer.from(content, "utf8"));
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
	 * Reserve an artifact ID without exposing a writable managed pathname.
	 *
	 * Streaming callers that only understand bare paths fail closed; use `save`
	 * for terminally published artifact content.
	 */
	async allocatePath(toolType: string): Promise<{ id: string; path?: string }> {
		await this.#ensureDir();
		const id = String(this.allocateId());
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
		const id = String(this.allocateId());
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
