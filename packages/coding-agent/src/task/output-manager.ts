/**
 * Session-scoped manager for agent output IDs.
 *
 * Ensures unique output IDs across task tool invocations within a session.
 * Prefixes each ID with a sequential number (e.g., "0-AuthProvider", "1-AuthApi").
 * If a parent prefix is provided, IDs are nested (e.g., "0-Auth.1-Subtask").
 *
 * This enables reliable agent:// URL resolution and prevents artifact collisions.
 */
import * as fs from "node:fs/promises";
import { validateAllocatedTaskId, validateTaskId } from "./id";

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const RESERVED_OUTPUT_EXTENSIONS_PATTERN = "(?:md|jsonl|patch)";

/**
 * Manages agent output ID allocation to ensure uniqueness.
 *
 * Each allocated ID gets a numeric prefix based on allocation order.
 * If configured with a parent prefix, the numeric prefix is appended after
 * the parent (e.g., "0-Parent.0-Child").
 * On resume, scans existing files to find the next available index.
 */
export class AgentOutputManager {
	#nextId = 0;
	#initPromise: Promise<void> | undefined;
	readonly #getArtifactsDir: () => string | null;
	readonly #parentPrefix: string | undefined;

	constructor(getArtifactsDir: () => string | null, options?: { parentPrefix?: string }) {
		this.#getArtifactsDir = getArtifactsDir;
		this.#parentPrefix = options?.parentPrefix;
	}

	/**
	 * Memoize the in-flight scan so concurrent `allocate*`/`peekNextIndex`
	 * calls await the SAME `readdir` before `#nextId` is derived. Assigning the
	 * promise synchronously (before any `await`) closes the TOCTOU window where a
	 * boolean "initialized" flag, flipped ahead of the awaited scan, let a second
	 * caller allocate at `#nextId === 0` while the first was still scanning —
	 * producing duplicate indices that overwrite prior outputs on resume.
	 */
	#ensureInitialized(): Promise<void> {
		this.#initPromise ??= this.#scanExistingOutputs();
		return this.#initPromise;
	}

	/**
	 * Scan existing agent output files to find the next available ID.
	 * This ensures we don't overwrite outputs when resuming a session.
	 */
	async #scanExistingOutputs(): Promise<void> {
		const dir = this.#getArtifactsDir();
		if (!dir) return;

		let files: string[];
		try {
			files = await fs.readdir(dir);
		} catch {
			return; // Directory doesn't exist yet
		}

		const pattern = this.#parentPrefix
			? new RegExp(`^${escapeRegExp(this.#parentPrefix)}\\.(\\d+)-.*\\.${RESERVED_OUTPUT_EXTENSIONS_PATTERN}$`)
			: new RegExp(`^(\\d+)-.*\\.${RESERVED_OUTPUT_EXTENSIONS_PATTERN}$`);

		let maxId = -1;
		for (const file of files) {
			const match = file.match(pattern);
			if (match) {
				const id = Number.parseInt(match[1], 10);
				if (id > maxId) maxId = id;
			}
		}
		this.#nextId = maxId + 1;
	}

	/**
	 * Allocate a unique ID with numeric prefix.
	 *
	 * @param id Requested ID (e.g., "AuthProvider")
	 * @returns Unique ID with prefix (e.g., "0-AuthProvider")
	 */
	async allocate(id: string): Promise<string> {
		await this.#ensureInitialized();
		const prefix = this.#parentPrefix ? `${validateAllocatedTaskId(this.#parentPrefix)}.` : "";
		return `${prefix}${this.#nextId++}-${validateTaskId(id)}`;
	}

	/**
	 * Allocate unique IDs for a batch of tasks.
	 *
	 * @param ids Array of requested IDs
	 * @returns Array of unique IDs in same order
	 */
	async allocateBatch(ids: string[]): Promise<string[]> {
		await this.#ensureInitialized();
		const prefix = this.#parentPrefix ? `${validateAllocatedTaskId(this.#parentPrefix)}.` : "";
		return ids.map(id => `${prefix}${this.#nextId++}-${validateTaskId(id)}`);
	}

	/**
	 * Get the next ID that would be allocated (without allocating).
	 */
	async peekNextIndex(): Promise<number> {
		await this.#ensureInitialized();
		return this.#nextId;
	}

	/**
	 * Reset state (primarily for testing).
	 */
	reset(): void {
		this.#nextId = 0;
		this.#initPromise = undefined;
	}
}
