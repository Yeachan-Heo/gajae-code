import * as path from "node:path";

export interface CorpusEntry {
	id: string;
	sourceClass: "sanitized-real" | "dogfood-redacted" | "synthetic";
	sourceSha256: string;
	sanitizerVersion: string;
	redactionNotes: string;
	file: string;
	assistantTurns: number;
	toolCalls: number;
	toolKinds: string[];
	hasCompaction: boolean;
	bytes: number;
	toolCallSeqSha256: string;
}

export interface CorpusManifest {
	schema: "gjc.session-replay-corpus/1";
	sanitizerVersion: string;
	entries: CorpusEntry[];
}

export interface SessionJsonlEntry {
	type: string;
	message?: unknown;
}

const MANIFEST_SCHEMA = "gjc.session-replay-corpus/1" as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCorpusEntry(value: unknown): value is CorpusEntry {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		(value.sourceClass === "sanitized-real" || value.sourceClass === "dogfood-redacted" || value.sourceClass === "synthetic") &&
		typeof value.sourceSha256 === "string" &&
		SHA256_PATTERN.test(value.sourceSha256) &&
		typeof value.sanitizerVersion === "string" &&
		typeof value.redactionNotes === "string" &&
		typeof value.file === "string" &&
		numberIsNonnegativeInteger(value.assistantTurns) &&
		numberIsNonnegativeInteger(value.toolCalls) &&
		Array.isArray(value.toolKinds) &&
		value.toolKinds.every((kind: unknown) => typeof kind === "string") &&
		typeof value.hasCompaction === "boolean" &&
		numberIsNonnegativeInteger(value.bytes) &&
		typeof value.toolCallSeqSha256 === "string" &&
		SHA256_PATTERN.test(value.toolCallSeqSha256)
	);
}

function numberIsNonnegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export async function loadCorpusManifest(dir: string): Promise<CorpusManifest> {
	const manifestPath = path.join(dir, "manifest.json");
	const parsed: unknown = JSON.parse(await Bun.file(manifestPath).text());
	if (!isRecord(parsed) || parsed.schema !== MANIFEST_SCHEMA) {
		throw new Error(`Invalid session replay corpus manifest schema at ${manifestPath}`);
	}
	if (typeof parsed.sanitizerVersion !== "string" || !Array.isArray(parsed.entries)) {
		throw new Error(`Invalid session replay corpus manifest fields at ${manifestPath}`);
	}
	const entries = parsed.entries as unknown[];
	if (!entries.every((entry: unknown) => isCorpusEntry(entry))) {
		throw new Error(`Invalid session replay corpus entry at ${manifestPath}`);
	}
	return {
		schema: MANIFEST_SCHEMA,
		sanitizerVersion: parsed.sanitizerVersion,
		entries: entries as CorpusEntry[],
	};
}

export function toolCallSequence(entries: SessionJsonlEntry[]): string[] {
	const sequence: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (!isRecord(entry.message) || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
		for (const block of entry.message.content) {
			if (isRecord(block) && block.type === "toolCall" && typeof block.name === "string") {
				sequence.push(block.name);
			}
		}
	}
	return sequence;
}

export function sha256Hex(data: string | Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}
