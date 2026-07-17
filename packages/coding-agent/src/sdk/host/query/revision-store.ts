import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_REVISIONS_PER_RESOURCE = 8;
export const MAX_PINNED_REVISIONS = 128;
export const MAX_MEMORY_BYTES = 16 * 1024 * 1024;
export const SNAPSHOT_TTL_MS = 15 * 60 * 1000;
const CHUNK_BYTES = 4 * 1024 * 1024;
const STRING_INDEX_BYTES = 64 * 1024;
const STRING_READ_BYTES = 512 * 1024;

export class RevisionStoreError extends Error {
	constructor(
		readonly code: "resource_gone" | "snapshot_capacity_exceeded",
		message: string = code,
	) {
		super(message);
	}
}

interface StringCheckpoint {
	decodedOffset: number;
	serializedOffset: number;
}

interface EscapedStringIndex {
	byteLength: number;
	checkpoints: StringCheckpoint[];
}

interface IndexedField {
	start: number;
	end: number;
	plainStringBytes?: number;
	isString?: boolean;
	stringIndex?: EscapedStringIndex;
}

interface RevisionIndex {
	items?: {
		start: number;
		end: number;
		entryId?: string;
		fields?: Record<string, IndexedField>;
	}[];
	fields?: Record<string, IndexedField>;
}

interface Revision {
	id: string;
	hash: string;
	bytes: number;
	payload?: Buffer;
	manifest?: string;
	chunks?: string[];
	chunkLengths?: number[];
	index?: RevisionIndex;
	pins: Set<string>;
	lastAccessed: number;
	createdAt: number;
}

interface SerializedRevision {
	hash: string;
	bytes: number;
	payload?: Buffer;
	manifest: string;
	chunks: string[];
	chunkLengths: number[];
	index: RevisionIndex;
}

class ChunkJsonParser {
	#chunkIndex = 0;
	#offset = 0;
	#text = "";
	readonly #decoder = new TextDecoder();

	constructor(
		private readonly directory: string,
		private readonly chunks: readonly string[],
		private readonly lengths: readonly number[],
		private readonly recordBufferedBytes: (bytes: number) => void,
	) {}

	async parse(): Promise<unknown> {
		const value = await this.#value();
		await this.#whitespace();
		if ((await this.#peek()) !== undefined) throw new SyntaxError("unexpected data after JSON value");
		return value;
	}

	async #fill(): Promise<boolean> {
		while (this.#offset >= this.#text.length && this.#chunkIndex < this.chunks.length) {
			const chunk = this.chunks[this.#chunkIndex]!;
			const data = await readFile(join(this.directory, "objects", chunk));
			const expectedLength = this.lengths[this.#chunkIndex];
			if (expectedLength !== undefined && data.length !== expectedLength)
				throw new SyntaxError("snapshot chunk length does not match manifest");
			if (createHash("sha256").update(data).digest("hex") !== chunk)
				throw new SyntaxError("snapshot chunk hash does not match manifest");
			this.#chunkIndex++;
			this.#text = this.#decoder.decode(data, { stream: this.#chunkIndex < this.chunks.length });
			this.#offset = 0;
			this.recordBufferedBytes(data.length + Buffer.byteLength(this.#text));
		}
		return this.#offset < this.#text.length;
	}

	async #peek(): Promise<string | undefined> {
		return (await this.#fill()) ? this.#text[this.#offset] : undefined;
	}
	async #take(): Promise<string> {
		const character = await this.#peek();
		if (character === undefined) throw new SyntaxError("unexpected end of JSON snapshot");
		this.#offset++;
		return character;
	}
	async #expect(expected: string): Promise<void> {
		if ((await this.#take()) !== expected) throw new SyntaxError(`expected ${expected} in JSON snapshot`);
	}
	async #whitespace(): Promise<void> {
		while (/\s/.test((await this.#peek()) ?? "")) this.#offset++;
	}

	async #value(): Promise<unknown> {
		await this.#whitespace();
		switch (await this.#peek()) {
			case "{":
				return this.#object();
			case "[":
				return this.#array();
			case '"':
				return this.#string();
			case "t":
				await this.#literal("true");
				return true;
			case "f":
				await this.#literal("false");
				return false;
			case "n":
				await this.#literal("null");
				return null;
			default:
				return this.#number();
		}
	}

	async #object(): Promise<Record<string, unknown>> {
		const result: Record<string, unknown> = {};
		await this.#expect("{");
		await this.#whitespace();
		if ((await this.#peek()) === "}") {
			this.#offset++;
			return result;
		}
		while (true) {
			if ((await this.#peek()) !== '"') throw new SyntaxError("expected object key in JSON snapshot");
			const key = await this.#string();
			await this.#whitespace();
			await this.#expect(":");
			Object.defineProperty(result, key, {
				configurable: true,
				enumerable: true,
				value: await this.#value(),
				writable: true,
			});
			await this.#whitespace();
			const separator = await this.#take();
			if (separator === "}") return result;
			if (separator !== ",") throw new SyntaxError("expected object separator in JSON snapshot");
			await this.#whitespace();
		}
	}

	async #array(): Promise<unknown[]> {
		const result: unknown[] = [];
		await this.#expect("[");
		await this.#whitespace();
		if ((await this.#peek()) === "]") {
			this.#offset++;
			return result;
		}
		while (true) {
			result.push(await this.#value());
			await this.#whitespace();
			const separator = await this.#take();
			if (separator === "]") return result;
			if (separator !== ",") throw new SyntaxError("expected array separator in JSON snapshot");
			await this.#whitespace();
		}
	}

	async #string(): Promise<string> {
		await this.#expect('"');
		const parts: string[] = [];
		let output = "";
		const append = (value: string): void => {
			output += value;
			if (output.length >= 64 * 1024) {
				parts.push(output);
				output = "";
			}
		};
		while (true) {
			if (!(await this.#fill())) throw new SyntaxError("unexpected end of JSON snapshot");
			const start = this.#offset;
			while (this.#offset < this.#text.length) {
				const character = this.#text[this.#offset]!;
				if (character === '"' || character === "\\" || character < " ") break;
				this.#offset++;
			}
			if (this.#offset > start) {
				append(this.#text.slice(start, this.#offset));
				continue;
			}
			const character = await this.#take();
			if (character === '"') return parts.length === 0 ? output : `${parts.join("")}${output}`;
			if (character < " ") throw new SyntaxError("unescaped control character in JSON snapshot");
			switch (await this.#take()) {
				case '"':
					append('"');
					break;
				case "\\":
					append("\\");
					break;
				case "/":
					append("/");
					break;
				case "b":
					append("\b");
					break;
				case "f":
					append("\f");
					break;
				case "n":
					append("\n");
					break;
				case "r":
					append("\r");
					break;
				case "t":
					append("\t");
					break;
				case "u": {
					let hex = "";
					for (let index = 0; index < 4; index++) hex += await this.#take();
					if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new SyntaxError("invalid Unicode escape in JSON snapshot");
					append(String.fromCharCode(Number.parseInt(hex, 16)));
					break;
				}
				default:
					throw new SyntaxError("invalid string escape in JSON snapshot");
			}
		}
	}

	async #literal(expected: string): Promise<void> {
		for (const character of expected) await this.#expect(character);
	}
	async #number(): Promise<number> {
		let text = "";
		while (true) {
			const character = await this.#peek();
			if (character === undefined || /[\s,}\]]/.test(character)) break;
			text += await this.#take();
		}
		if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text))
			throw new SyntaxError("invalid number in JSON snapshot");
		return Number(text);
	}
}

/** Per-session MVCC snapshots. Payloads hold canonical JSON UTF-8. */
export class RevisionStore {
	readonly #resources = new Map<string, Revision[]>();
	readonly #pinIndex = new Map<string, Revision>();
	#memoryBytes = 0;
	#directory?: string;
	#chunkRefs = new Map<string, number>();
	#manifestRefs = new Map<string, number>();
	#peakBufferedBytes = 0;
	#peakReadBufferedBytes = 0;
	readonly #onReadRange?: (start: number, end: number) => void;
	#closing = false;
	#closePromise: Promise<void> | undefined;
	#writesInFlight = 0;
	#writesDrained: PromiseWithResolvers<void> | undefined;

	constructor(
		readonly sessionId: string,
		private readonly now: () => number = Date.now,
		options?: { storageDir?: string; onReadRange?: (start: number, end: number) => void },
	) {
		this.#directory = options?.storageDir ? join(options.storageDir, "sdk", "snapshots", sessionId) : undefined;
		this.#onReadRange = options?.onReadRange;
	}

	async createRevision(resourceKind: string, resourceId: string, payload: unknown): Promise<string> {
		if (this.#closing) throw new RevisionStoreError("resource_gone", "snapshot store is closing");
		this.#writesInFlight++;
		try {
			if (payload === undefined) throw new RevisionStoreError("resource_gone", "snapshot payload is unavailable");
			const serialised = await this.#serialise(payload);
			const key = `${resourceKind}:${resourceId}`;
			const revisions = this.#resources.get(key) ?? [];
			const previous = revisions.length === 0 ? undefined : revisions[revisions.length - 1];
			if (previous?.hash === serialised.hash) {
				await this.#discardUnreferenced(serialised.chunks, serialised.manifest);
				return previous.id;
			}
			const revision: Revision = {
				id: String(previous ? Number(previous.id) + 1 : 1),
				hash: serialised.hash,
				bytes: serialised.bytes,
				payload: serialised.payload,
				manifest: serialised.manifest,
				chunks: serialised.chunks,
				chunkLengths: serialised.chunkLengths,
				index: serialised.index,
				pins: new Set(),
				lastAccessed: this.now(),
				createdAt: this.now(),
			};
			revisions.push(revision);
			this.#resources.set(key, revisions);
			this.#retainSpill(revision);
			if (revision.payload) this.#memoryBytes += revision.bytes;
			await this.#enforceMemory();
			while (revisions.length > MAX_REVISIONS_PER_RESOURCE) {
				const candidate = revisions.find(item => item.pins.size === 0);
				if (!candidate) break;
				revisions.splice(revisions.indexOf(candidate), 1);
				this.#drop(candidate);
			}
			return revision.id;
		} finally {
			this.#writesInFlight--;
			if (this.#writesInFlight === 0) this.#writesDrained?.resolve();
		}
	}

	async readRevision(resourceKind: string, resourceId: string, id: string): Promise<unknown> {
		const revision = this.#resources.get(`${resourceKind}:${resourceId}`)?.find(item => item.id === id);
		if (!revision) return undefined;
		revision.lastAccessed = this.now();
		if (revision.payload !== undefined) return JSON.parse(revision.payload.toString("utf8"));
		return revision.chunks === undefined
			? undefined
			: this.#parseChunks(revision.chunks, revision.chunkLengths ?? []);
	}
	async revisionByteLength(resourceKind: string, resourceId: string, id: string): Promise<number | undefined> {
		const revision = this.#resources.get(`${resourceKind}:${resourceId}`)?.find(item => item.id === id);
		if (!revision) return undefined;
		revision.lastAccessed = this.now();
		return revision.bytes;
	}

	async readPage(
		resourceKind: string,
		resourceId: string,
		id: string,
		offset: number,
		targetBytes: number,
	): Promise<{ items: unknown[]; complete: boolean } | undefined> {
		const revision = this.#resources.get(`${resourceKind}:${resourceId}`)?.find(item => item.id === id);
		if (!revision) return undefined;
		revision.lastAccessed = this.now();
		if (!revision.index?.items) return undefined;
		const items: unknown[] = [];
		let itemsBytes = 2; // []
		for (const range of revision.index.items.slice(offset)) {
			// The manifest records the canonical item length, so reject an oversized
			// item before reading or parsing its complete range.
			if (range.end - range.start > targetBytes) break;
			const value = JSON.parse(await this.#readRange(revision, range));
			const itemBytes = Buffer.byteLength(JSON.stringify(value));
			const candidateBytes = itemsBytes + itemBytes + (items.length ? 1 : 0);
			if (candidateBytes > targetBytes && items.length) break;
			if (candidateBytes > 1024 * 1024) break;
			items.push(value);
			itemsBytes = candidateBytes;
		}
		return { items, complete: offset + items.length >= revision.index.items.length };
	}
	/** Returns canonical root JSON in a UTF-8-safe bounded range without parsing it. */
	async readRootRange(
		resourceKind: string,
		resourceId: string,
		id: string,
		offset: number,
		length: number,
	): Promise<{ body: string; complete: boolean; offset: number } | undefined> {
		const revision = this.#resources.get(`${resourceKind}:${resourceId}`)?.find(item => item.id === id);
		if (!revision || offset < 0 || length <= 0) return undefined;
		revision.lastAccessed = this.now();
		const requestedStart = Math.min(offset, revision.bytes);
		const source = await this.#readBytes(
			revision,
			requestedStart,
			Math.min(revision.bytes, requestedStart + length + 7),
		);
		const skipped = utf8ContinuationPrefixLength(source);
		const start = requestedStart + skipped;
		const body = source.subarray(skipped);
		const end = utf8BoundaryAtOrBefore(body, Math.min(body.length, length));
		if (end === 0 && start < revision.bytes) return undefined;
		return { body: body.subarray(0, end).toString("utf8"), complete: start + end === revision.bytes, offset: start };
	}

	async readStringRange(
		resourceKind: string,
		resourceId: string,
		id: string,
		field: string,
		offset: number,
		length: number,
	): Promise<{ body: string; complete: boolean; offset: number } | undefined> {
		const revision = this.#resources.get(`${resourceKind}:${resourceId}`)?.find(item => item.id === id);
		if (!revision) return undefined;
		revision.lastAccessed = this.now();
		const range = revision.index?.fields?.[field];
		return range ? this.#readStringRange(revision, range, offset, length) : undefined;
	}
	async readIndexedStringRange(
		resourceKind: string,
		resourceId: string,
		id: string,
		itemId: string,
		field: string,
		offset: number,
		length: number,
	): Promise<{ body: string; complete: boolean; offset: number } | undefined> {
		const revision = this.#resources.get(`${resourceKind}:${resourceId}`)?.find(item => item.id === id);
		if (!revision) return undefined;
		revision.lastAccessed = this.now();
		const item = revision.index?.items?.find(candidate => candidate.entryId === itemId);
		const range = item?.fields?.[field];
		return range ? this.#readStringRange(revision, range, offset, length) : undefined;
	}
	async describeIndexedItem(
		resourceKind: string,
		resourceId: string,
		id: string,
		offset: number,
	): Promise<{ itemId?: string; fields: string[] } | undefined> {
		const revision = this.#resources.get(`${resourceKind}:${resourceId}`)?.find(item => item.id === id);
		const item = revision?.index?.items?.[offset];
		if (!item) return undefined;
		return {
			itemId: item.entryId,
			fields: Object.entries(item.fields ?? {})
				.filter(([, range]) => range.isString)
				.map(([field]) => field),
		};
	}
	async readTranscriptBodyRange(
		resourceId: string,
		id: string,
		entryId: string,
		offset: number,
		length: number,
	): Promise<{ body: string; complete: boolean; offset: number } | undefined> {
		return (
			(await this.readIndexedStringRange("transcript", resourceId, id, entryId, "body", offset, length)) ??
			(await this.readIndexedStringRange("transcript", resourceId, id, entryId, "content", offset, length))
		);
	}

	async pin(cursorId: string, resourceKind: string, resourceId: string, id: string): Promise<void> {
		if (this.#pinIndex.has(cursorId)) return;
		if (this.#pinIndex.size >= MAX_PINNED_REVISIONS) throw new RevisionStoreError("snapshot_capacity_exceeded");
		const revision = this.#resources.get(`${resourceKind}:${resourceId}`)?.find(item => item.id === id);
		if (!revision) throw new RevisionStoreError("snapshot_capacity_exceeded", "snapshot is unavailable");
		revision.pins.add(cursorId);
		this.#pinIndex.set(cursorId, revision);
		await this.#enforceMemory();
	}

	unpin(cursorId: string): void {
		const revision = this.#pinIndex.get(cursorId);
		if (!revision) return;
		revision.pins.delete(cursorId);
		this.#pinIndex.delete(cursorId);
	}

	sweep(): void {
		const cutoff = this.now() - SNAPSHOT_TTL_MS;
		for (const [key, revisions] of this.#resources) {
			for (const revision of [...revisions]) {
				if (revision.pins.size === 0 && revision.lastAccessed < cutoff) {
					revisions.splice(revisions.indexOf(revision), 1);
					this.#drop(revision);
				}
			}
			if (revisions.length === 0) this.#resources.delete(key);
		}
	}

	async close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closing = true;
		this.#closePromise = (async () => {
			if (this.#writesInFlight > 0) {
				this.#writesDrained ??= Promise.withResolvers<void>();
				await this.#writesDrained.promise;
			}
			this.#resources.clear();
			this.#pinIndex.clear();
			this.#memoryBytes = 0;
			this.#chunkRefs.clear();
			this.#manifestRefs.clear();
			if (this.#directory) await rm(this.#directory, { recursive: true, force: true });
		})();
		return this.#closePromise;
	}

	get pinnedCount(): number {
		return this.#pinIndex.size;
	}
	get memoryBytes(): number {
		return this.#memoryBytes;
	}
	/** Test-only accounting for the bounded serializer's staging buffer. */
	get peakBufferedBytes(): number {
		return this.#peakBufferedBytes;
	}
	/** Test-only accounting for a spilled reader's raw chunk and decoded-text buffers. */
	get peakReadBufferedBytes(): number {
		return this.#peakReadBufferedBytes;
	}

	async #enforceMemory(): Promise<void> {
		while (this.#memoryBytes > MAX_MEMORY_BYTES) {
			const candidates = [...this.#resources.values()]
				.flat()
				.filter(item => item.payload)
				.sort((a, b) => a.pins.size - b.pins.size || a.lastAccessed - b.lastAccessed);
			const candidate = candidates[0];
			if (!candidate) break;
			candidate.payload = undefined;
			this.#memoryBytes -= candidate.bytes;
		}
	}

	async #serialise(value: unknown): Promise<SerializedRevision> {
		const directory = await this.#spillDirectory();
		const chunks: string[] = [];
		const chunkLengths: number[] = [];
		const hash = createHash("sha256");
		let bytes = 0;
		// Reuse one staging chunk across flushes. Nested large strings therefore retain
		// one chunk-sized buffer rather than allocating one buffer per emitted chunk.
		const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
		let bufferBytes = 0;
		const flush = async () => {
			if (bufferBytes === 0) return;
			const data = buffer.subarray(0, bufferBytes);
			bufferBytes = 0;
			const chunkHash = createHash("sha256").update(data).digest("hex");
			const file = join(directory, "objects", chunkHash);
			await this.#writeAtomic(file, data);
			chunks.push(chunkHash);
			chunkLengths.push(data.length);
		};
		const append = async (text: string) => {
			for (let offset = 0; offset < text.length; ) {
				let remaining = CHUNK_BYTES - bufferBytes;
				if (remaining === 0) {
					await flush();
					remaining = CHUNK_BYTES;
				}
				const end = utf8ChunkEnd(text, offset, remaining);
				if (end === offset) {
					await flush();
					continue;
				}
				const data = Buffer.from(text.slice(offset, end));
				data.copy(buffer, bufferBytes);
				hash.update(data);
				bytes += data.length;
				bufferBytes += data.length;
				this.#peakBufferedBytes = Math.max(this.#peakBufferedBytes, bufferBytes);
				offset = end;
				if (bufferBytes === CHUNK_BYTES) await flush();
			}
		};
		const index: RevisionIndex = {};
		const root =
			value && typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function"
				? (value as { toJSON: (key: string) => unknown }).toJSON("")
				: value;
		if (Array.isArray(root)) {
			index.items = [];
			await append("[");
			for (let position = 0; position < root.length; position++) {
				if (position) await append(",");
				const start = bytes;
				const item = await this.#encodeIndexedItem(root[position], append, () => bytes);
				index.items.push({ start, end: bytes, ...item });
			}
			await append("]");
		} else if (root && typeof root === "object") {
			index.fields = {};
			await append("{");
			let first = true;
			for (const [key, child] of Object.entries(root as Record<string, unknown>)) {
				if (child === undefined || typeof child === "function" || typeof child === "symbol") continue;
				if (!first) await append(",");
				first = false;
				await this.#encodeString(key, append);
				await append(":");
				const start = bytes;
				const field = await this.#encodeIndexedValue(child, append);
				index.fields[key] = { start, end: bytes, ...field };
			}
			await append("}");
		} else await this.#encode(root, append, false);
		await flush();
		const revisionHash = hash.digest("hex");
		const manifest = join(directory, "manifests", `${revisionHash}.json`);
		const manifestChunks = chunks.map((hash, index) => ({ hash, length: chunkLengths[index]! }));
		await this.#writeAtomic(manifest, Buffer.from(JSON.stringify({ chunks: manifestChunks, index })));
		return {
			hash: revisionHash,
			bytes,
			payload: bytes <= MAX_MEMORY_BYTES ? await this.#readChunks(chunks, chunkLengths) : undefined,
			manifest,
			chunks,
			chunkLengths,
			index,
		};
	}

	async #encode(value: unknown, append: (text: string) => Promise<void>, inArray: boolean): Promise<void> {
		if (value === null || typeof value === "number" || typeof value === "boolean") {
			const serialised = JSON.stringify(value);
			return append(serialised ?? "null");
		}
		if (typeof value === "string") {
			await this.#encodeString(value, append);
			return;
		}
		if (typeof value === "bigint") throw new TypeError("Do not know how to serialize a BigInt");
		if (value === undefined || typeof value === "function" || typeof value === "symbol") return append("null");
		if (typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function")
			return this.#encode((value as { toJSON: (key: string) => unknown }).toJSON(""), append, inArray);
		if (Array.isArray(value)) {
			await append("[");
			for (let index = 0; index < value.length; index++) {
				if (index) await append(",");
				await this.#encode(value[index], append, true);
			}
			return append("]");
		}
		if (typeof value === "object") {
			await append("{");
			let first = true;
			for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
				if (child === undefined || typeof child === "function" || typeof child === "symbol") continue;
				if (!first) await append(",");
				first = false;
				await this.#encodeString(key, append);
				await append(":");
				await this.#encode(child, append, false);
			}
			return append("}");
		}
		return append("null");
	}

	async #encodeString(
		value: string,
		append: (text: string) => Promise<void>,
		indexEscapedString = false,
	): Promise<EscapedStringIndex | undefined> {
		await append('"');
		let output = "";
		let serializedOffset = 1;
		const stringIndex = indexEscapedString
			? { byteLength: 0, checkpoints: [{ decodedOffset: 0, serializedOffset }] }
			: undefined;
		for (let index = 0; index < value.length; index++) {
			const code = value.charCodeAt(index);
			let encoded: string;
			let decoded: string;
			if (code === 0x22) {
				encoded = '\\"';
				decoded = '"';
			} else if (code === 0x5c) {
				encoded = "\\\\";
				decoded = "\\";
			} else if (code === 0x08) {
				encoded = "\\b";
				decoded = "\b";
			} else if (code === 0x0c) {
				encoded = "\\f";
				decoded = "\f";
			} else if (code === 0x0a) {
				encoded = "\\n";
				decoded = "\n";
			} else if (code === 0x0d) {
				encoded = "\\r";
				decoded = "\r";
			} else if (code === 0x09) {
				encoded = "\\t";
				decoded = "\t";
			} else if (
				code >= 0xd800 &&
				code <= 0xdbff &&
				index + 1 < value.length &&
				value.charCodeAt(index + 1) >= 0xdc00 &&
				value.charCodeAt(index + 1) <= 0xdfff
			) {
				decoded = value.slice(index, index + 2);
				encoded = decoded;
				index++;
			} else if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) {
				encoded = `\\u${code.toString(16).padStart(4, "0")}`;
				decoded = value[index]!;
			} else {
				encoded = value[index]!;
				decoded = encoded;
			}
			output += encoded;
			if (stringIndex) {
				serializedOffset += Buffer.byteLength(encoded);
				stringIndex.byteLength += Buffer.byteLength(decoded);
				const last = stringIndex.checkpoints[stringIndex.checkpoints.length - 1]!;
				if (stringIndex.byteLength - last.decodedOffset >= STRING_INDEX_BYTES)
					stringIndex.checkpoints.push({
						decodedOffset: stringIndex.byteLength,
						serializedOffset,
					});
			}
			if (output.length >= 64 * 1024) {
				await append(output);
				output = "";
			}
		}
		if (output) await append(output);
		await append('"');
		if (stringIndex) {
			const last = stringIndex.checkpoints[stringIndex.checkpoints.length - 1]!;
			if (last.decodedOffset !== stringIndex.byteLength)
				stringIndex.checkpoints.push({
					decodedOffset: stringIndex.byteLength,
					serializedOffset,
				});
		}
		return stringIndex;
	}

	async #encodeIndexedValue(
		value: unknown,
		append: (text: string) => Promise<void>,
	): Promise<Omit<IndexedField, "start" | "end">> {
		if (typeof value !== "string") {
			await this.#encode(value, append, false);
			return {};
		}
		if (isPlainJsonString(value)) {
			await this.#encodeString(value, append);
			return { plainStringBytes: Buffer.byteLength(value), isString: true };
		}
		const stringIndex = await this.#encodeString(value, append, true);
		if (!stringIndex) throw new SyntaxError("escaped string index is unavailable");
		return { isString: true, stringIndex };
	}

	async #readStringRange(
		revision: Revision,
		range: IndexedField,
		offset: number,
		length: number,
	): Promise<{ body: string; complete: boolean; offset: number } | undefined> {
		if (offset < 0 || length <= 0 || !range.isString) return undefined;
		if (range.plainStringBytes !== undefined) {
			const requestedStart = Math.min(offset, range.plainStringBytes);
			const source = await this.#readBytes(
				revision,
				range.start + 1 + requestedStart,
				range.start + 1 + Math.min(range.plainStringBytes, requestedStart + length + 7),
			);
			const skipped = utf8ContinuationPrefixLength(source);
			const start = requestedStart + skipped;
			const body = source.subarray(skipped);
			const end = utf8BoundaryAtOrBefore(body, Math.min(body.length, length));
			if (end === 0 && start < range.plainStringBytes) return undefined;
			return {
				body: body.subarray(0, end).toString("utf8"),
				complete: start + end === range.plainStringBytes,
				offset: start,
			};
		}
		if (!range.stringIndex) throw new SyntaxError("escaped string index is unavailable");
		return this.#readEscapedStringRange(revision, range, offset, length);
	}

	async #readEscapedStringRange(
		revision: Revision,
		range: IndexedField,
		offset: number,
		length: number,
	): Promise<{ body: string; complete: boolean; offset: number } | undefined> {
		const stringIndex = range.stringIndex;
		if (!stringIndex) throw new SyntaxError("escaped string index is unavailable");
		const openingQuote = await this.#readBytes(revision, range.start, range.start + 1);
		if (openingQuote.length !== 1 || openingQuote[0] !== 0x22)
			throw new SyntaxError("expected string in JSON snapshot");
		const requestedOffset = Math.min(offset, stringIndex.byteLength);
		const checkpoint = stringCheckpointAtOrBefore(stringIndex.checkpoints, requestedOffset);
		let position = range.start + checkpoint.serializedOffset;
		let source: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let sourceStart = position;
		const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
		const fill = async (needed = 1): Promise<boolean> => {
			if (position + needed > range.end) return false;
			if (position >= sourceStart && position + needed <= sourceStart + source.length) return true;
			sourceStart = position;
			source = await this.#readBytes(
				revision,
				position,
				Math.min(range.end, position + Math.max(STRING_READ_BYTES, needed)),
			);
			return source.length >= needed;
		};
		const take = async (): Promise<number> => {
			if (!(await fill())) throw new SyntaxError("unexpected end of JSON string");
			return source[position++ - sourceStart]!;
		};
		const readUnicodeEscape = async (): Promise<number> => {
			let hex = "";
			for (let index = 0; index < 4; index++) hex += String.fromCharCode(await take());
			if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new SyntaxError("invalid Unicode escape in JSON snapshot");
			return Number.parseInt(hex, 16);
		};
		const hasEscapedLowSurrogate = async (): Promise<boolean> => {
			if (!(await fill(6))) return false;
			const start = position - sourceStart;
			if (source[start] !== 0x5c || source[start + 1] !== 0x75) return false;
			const hex = source.subarray(start + 2, start + 6).toString("ascii");
			if (!/^[0-9a-fA-F]{4}$/.test(hex)) return false;
			const code = Number.parseInt(hex, 16);
			return code >= 0xdc00 && code <= 0xdfff;
		};
		const readUnit = async (): Promise<string | undefined> => {
			if (!(await fill())) throw new SyntaxError("unexpected end of JSON string");
			const start = position - sourceStart;
			const first = source[start]!;
			if (first === 0x22) {
				position++;
				return undefined;
			}
			if (first === 0x5c) {
				position++;
				switch (await take()) {
					case 0x22:
						return '"';
					case 0x5c:
						return "\\";
					case 0x2f:
						return "/";
					case 0x62:
						return "\b";
					case 0x66:
						return "\f";
					case 0x6e:
						return "\n";
					case 0x72:
						return "\r";
					case 0x74:
						return "\t";
					case 0x75: {
						const code = await readUnicodeEscape();
						let decoded = String.fromCharCode(code);
						if (code >= 0xd800 && code <= 0xdbff && (await hasEscapedLowSurrogate())) {
							position += 2;
							decoded += String.fromCharCode(await readUnicodeEscape());
						}
						return decoded;
					}
					default:
						throw new SyntaxError("invalid string escape in JSON snapshot");
				}
			}
			if (first < 0x20) throw new SyntaxError("unescaped control character in JSON snapshot");
			if (first < 0x80) {
				position++;
				return String.fromCharCode(first);
			}
			const width =
				first >= 0xc2 && first <= 0xdf
					? 2
					: first >= 0xe0 && first <= 0xef
						? 3
						: first >= 0xf0 && first <= 0xf4
							? 4
							: 0;
			if (width === 0 || !(await fill(width))) throw new SyntaxError("invalid UTF-8 in JSON string");
			const bytes = source.subarray(position - sourceStart, position - sourceStart + width);
			if (bytes.subarray(1).some(byte => (byte & 0xc0) !== 0x80))
				throw new SyntaxError("invalid UTF-8 in JSON string");
			position += width;
			try {
				return utf8Decoder.decode(bytes);
			} catch {
				throw new SyntaxError("invalid UTF-8 in JSON string");
			}
		};
		let decodedOffset = checkpoint.decodedOffset;
		let responseOffset: number | undefined;
		let bodyBytes = 0;
		const parts: string[] = [];
		let body = "";
		const append = (value: string): void => {
			body += value;
			if (body.length >= 64 * 1024) {
				parts.push(body);
				body = "";
			}
		};
		const result = (complete: boolean) => ({
			body: parts.length === 0 ? body : `${parts.join("")}${body}`,
			complete,
			offset: responseOffset ?? requestedOffset,
		});
		while (true) {
			const unit = await readUnit();
			if (unit === undefined) {
				if (position !== range.end || decodedOffset !== stringIndex.byteLength)
					throw new SyntaxError("escaped string index does not match JSON snapshot");
				return result(true);
			}
			const unitBytes = Buffer.byteLength(unit);
			if (responseOffset === undefined) {
				if (decodedOffset < requestedOffset) {
					decodedOffset += unitBytes;
					if (decodedOffset <= requestedOffset) continue;
					responseOffset = decodedOffset;
					continue;
				}
				responseOffset = decodedOffset;
			}
			if (bodyBytes + unitBytes > length) return bodyBytes === 0 ? undefined : result(false);
			append(unit);
			bodyBytes += unitBytes;
			decodedOffset += unitBytes;
			if (decodedOffset === stringIndex.byteLength) {
				if ((await readUnit()) !== undefined || position !== range.end)
					throw new SyntaxError("escaped string index does not match JSON snapshot");
				return result(true);
			}
			if (bodyBytes === length) return result(false);
		}
	}

	async #encodeIndexedItem(
		value: unknown,
		append: (text: string) => Promise<void>,
		position: () => number,
	): Promise<{
		entryId?: string;
		fields?: Record<string, IndexedField>;
	}> {
		const root =
			value && typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function"
				? (value as { toJSON: (key: string) => unknown }).toJSON("")
				: value;
		if (!root || typeof root !== "object" || Array.isArray(root)) {
			await this.#encode(root, append, true);
			return {};
		}
		const fields: Record<string, IndexedField> = {};
		let entryId: string | undefined;
		await append("{");
		let first = true;
		for (const [key, child] of Object.entries(root as Record<string, unknown>)) {
			if (child === undefined || typeof child === "function" || typeof child === "symbol") continue;
			if (!first) await append(",");
			first = false;
			await this.#encodeString(key, append);
			await append(":");
			const start = position();
			const field = await this.#encodeIndexedValue(child, append);
			fields[key] = { start, end: position(), ...field };
			if (key === "id") entryId = String(child ?? "");
		}
		await append("}");
		return { ...(entryId === undefined ? {} : { entryId }), fields };
	}

	async #readBytes(revision: Revision, start: number, end: number): Promise<Buffer> {
		this.#onReadRange?.(start, end);
		if (revision.payload !== undefined) return revision.payload.subarray(start, end);
		if (!this.#directory || !revision.chunks || !revision.chunkLengths)
			throw new SyntaxError("snapshot range is unavailable");
		const values: Buffer[] = [];
		let position = 0;
		for (const [index, chunk] of revision.chunks.entries()) {
			const length = revision.chunkLengths[index]!;
			const chunkEnd = position + length;
			if (chunkEnd > start && position < end) {
				const data = await readFile(join(this.#directory, "objects", chunk));
				if (data.length !== length || createHash("sha256").update(data).digest("hex") !== chunk)
					throw new SyntaxError("snapshot chunk does not match manifest");
				const sliceStart = Math.max(0, start - position);
				const sliceEnd = Math.min(length, end - position);
				values.push(data.subarray(sliceStart, sliceEnd));
				this.#peakReadBufferedBytes = Math.max(this.#peakReadBufferedBytes, data.length + sliceEnd - sliceStart);
			}
			position = chunkEnd;
			if (position >= end) break;
		}
		return Buffer.concat(values);
	}
	async #readRange(revision: Revision, range: { start: number; end: number }): Promise<string> {
		return (await this.#readBytes(revision, range.start, range.end)).toString("utf8");
	}

	async #readChunks(chunks: string[], lengths: number[]): Promise<Buffer | undefined> {
		if (!this.#directory || chunks.length === 0) return undefined;
		const values: Buffer[] = [];
		for (const [index, chunk] of chunks.entries()) {
			const data = await readFile(join(this.#directory, "objects", chunk));
			if (data.length !== lengths[index] || createHash("sha256").update(data).digest("hex") !== chunk)
				throw new SyntaxError("snapshot chunk does not match manifest");
			values.push(data);
		}
		return Buffer.concat(values);
	}

	async #parseChunks(chunks: string[], lengths: number[]): Promise<unknown> {
		if (!this.#directory || chunks.length === 0) return undefined;
		return new ChunkJsonParser(this.#directory, chunks, lengths, bytes => {
			this.#peakReadBufferedBytes = Math.max(this.#peakReadBufferedBytes, bytes);
		}).parse();
	}

	async #spillDirectory(): Promise<string> {
		if (!this.#directory) this.#directory = await mkdtemp(join(tmpdir(), "gjc-sdk-snapshots-"));
		await mkdir(join(this.#directory, "objects"), { recursive: true, mode: 0o700 });
		await mkdir(join(this.#directory, "manifests"), { recursive: true, mode: 0o700 });
		await chmod(this.#directory, 0o700);
		return this.#directory;
	}

	async #writeAtomic(file: string, data: Buffer): Promise<void> {
		const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
		const handle = await open(temporary, "w", 0o600);
		try {
			await handle.writeFile(data);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await chmod(temporary, 0o600);
		await rename(temporary, file);
	}

	#retainSpill(revision: Revision): void {
		if (revision.manifest)
			this.#manifestRefs.set(revision.manifest, (this.#manifestRefs.get(revision.manifest) ?? 0) + 1);
		for (const chunk of revision.chunks ?? []) this.#chunkRefs.set(chunk, (this.#chunkRefs.get(chunk) ?? 0) + 1);
	}

	#drop(revision: Revision): void {
		if (revision.payload) this.#memoryBytes -= revision.bytes;
		for (const cursorId of revision.pins) this.#pinIndex.delete(cursorId);
		for (const chunk of revision.chunks ?? []) this.#releaseChunk(chunk);
		if (revision.manifest) this.#releaseManifest(revision.manifest);
	}

	#releaseChunk(chunk: string): void {
		const refs = (this.#chunkRefs.get(chunk) ?? 1) - 1;
		if (refs > 0) this.#chunkRefs.set(chunk, refs);
		else {
			this.#chunkRefs.delete(chunk);
			if (this.#directory) void unlink(join(this.#directory, "objects", chunk)).catch(() => undefined);
		}
	}

	#releaseManifest(manifest: string): void {
		const refs = (this.#manifestRefs.get(manifest) ?? 1) - 1;
		if (refs > 0) this.#manifestRefs.set(manifest, refs);
		else {
			this.#manifestRefs.delete(manifest);
			void unlink(manifest).catch(() => undefined);
		}
	}

	async #discardUnreferenced(chunks: string[], manifest: string): Promise<void> {
		await Promise.all(
			chunks
				.filter(chunk => !this.#chunkRefs.has(chunk))
				.map(chunk =>
					this.#directory ? unlink(join(this.#directory, "objects", chunk)).catch(() => undefined) : undefined,
				),
		);
		if (!this.#manifestRefs.has(manifest)) await unlink(manifest).catch(() => undefined);
	}
}

function isPlainJsonString(value: unknown): value is string {
	return typeof value === "string" && !/["\\\u0000-\u001f\ud800-\udfff]/.test(value);
}

/** Finds the furthest UTF-16 boundary whose UTF-8 encoding fits in maxBytes. */
function utf8ChunkEnd(text: string, start: number, maxBytes: number): number {
	let low = start;
	let high = Math.min(text.length, start + maxBytes);
	while (low < high) {
		const middle = low + Math.ceil((high - low) / 2);
		if (Buffer.byteLength(text.slice(start, middle)) <= maxBytes) low = middle;
		else high = middle - 1;
	}
	if (
		low > start &&
		low < text.length &&
		text.charCodeAt(low - 1) >= 0xd800 &&
		text.charCodeAt(low - 1) <= 0xdbff &&
		text.charCodeAt(low) >= 0xdc00 &&
		text.charCodeAt(low) <= 0xdfff
	)
		low--;
	return low;
}
function stringCheckpointAtOrBefore(checkpoints: readonly StringCheckpoint[], offset: number): StringCheckpoint {
	if (checkpoints.length === 0) throw new SyntaxError("escaped string index has no checkpoints");
	let low = 0;
	let high = checkpoints.length;
	while (low < high) {
		const middle = low + Math.floor((high - low) / 2);
		if (checkpoints[middle]!.decodedOffset <= offset) low = middle + 1;
		else high = middle;
	}
	return checkpoints[Math.max(0, low - 1)]!;
}
function utf8BoundaryAtOrBefore(bytes: Buffer, offset: number): number {
	while (offset > 0 && offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) offset--;
	return offset;
}
function utf8ContinuationPrefixLength(bytes: Buffer): number {
	let offset = 0;
	while (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) offset++;
	return offset;
}
