import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadCorpusManifest, sha256Hex, toolCallSequence, type CorpusEntry, type CorpusManifest, type SessionJsonlEntry } from "./corpus.js";
import { isStructuralStringKey, SANITIZER_VERSION, sanitizeSession } from "./sanitize.js";

interface BuildOptions {
	id: string;
	outDir: string;
	fixtureRoot: string;
	sourceClass: "sanitized-real" | "dogfood-redacted" | "synthetic";
	raw: string;
	sourceSha256: string;
	privacyCheck: boolean;
	redactionNotes: string;
}

interface WordScanContext {
	insideArguments: boolean;
}

const MANIFEST_SCHEMA: CorpusManifest["schema"] = "gjc.session-replay-corpus/1";
const WORD_PATTERN = /[\p{L}\p{N}]{6,}/gu;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonlEntries(jsonl: string): SessionJsonlEntry[] {
	const entries: SessionJsonlEntry[] = [];
	for (const line of jsonl.split(/\r?\n/)) {
		if (line.trim().length === 0) continue;
		const value: unknown = JSON.parse(line);
		if (!isRecord(value) || typeof value.type !== "string") {
			throw new Error("Session replay JSONL contains an entry without a string type");
		}
		entries.push({ type: value.type, message: value.message });
	}
	return entries;
}

function addWordsFromString(value: string, words: Set<string>): void {
	WORD_PATTERN.lastIndex = 0;
	for (const match of value.matchAll(WORD_PATTERN)) {
		if (match[0] !== undefined) words.add(match[0]);
	}
}

function collectPrivacyWords(
	value: unknown,
	key: string,
	parentType: unknown,
	context: WordScanContext,
	words: Set<string>,
): void {
	if (typeof value === "string") {
		if (key === "arguments" && !context.insideArguments) {
			try {
				collectPrivacyWords(JSON.parse(value) as unknown, key, parentType, { insideArguments: true }, words);
				return;
			} catch {
				// Non-JSON argument payloads are still free text and must be checked.
			}
		}
		if (!isStructuralStringKey(key, parentType, value, context.insideArguments)) addWordsFromString(value, words);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectPrivacyWords(item, key, parentType, context, words);
		return;
	}
	if (!isRecord(value)) return;
	const insideArguments = context.insideArguments || key === "arguments";
	for (const [childKey, childValue] of Object.entries(value)) {
		collectPrivacyWords(childValue, childKey, value.type, { insideArguments }, words);
	}
}

function privacyWords(jsonl: string): Set<string> {
	const words = new Set<string>();
	for (const line of jsonl.split(/\r?\n/)) {
		if (line.trim().length === 0) continue;
		collectPrivacyWords(JSON.parse(line) as unknown, "", undefined, { insideArguments: false }, words);
	}
	return words;
}

function sampleWords(words: Set<string>, seed: string): string[] {
	return [...words]
		.map(word => ({ word, digest: sha256Hex(`${seed}\0${word}`) }))
		.sort((left, right) => (left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : left.word < right.word ? -1 : 1))
		.slice(0, Math.min(512, words.size))
		.map(item => item.word);
}

function assertRealSourcePrivacy(raw: string, sanitized: string, sourceSha256: string): { checked: number; distinct: number } {
	const sourceWords = privacyWords(raw);
	if (sourceWords.size < 200) {
		throw new Error(`Real session privacy scan needs at least 200 distinct source words; found ${sourceWords.size}`);
	}
	const sample = sampleWords(sourceWords, sourceSha256);
	const outputWords = privacyWords(sanitized);
	for (const word of sample) {
		if (outputWords.has(word)) throw new Error("Sanitized session privacy scan found original free text");
	}
	return { checked: sample.length, distinct: sourceWords.size };
}

function buildSyntheticSession(id: string, turns: number): string {
	const entries: Record<string, unknown>[] = [
		{
			type: "session",
			version: 3,
			id: `${id}-session`,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/private/source/worktree",
			provider: "synthetic",
			modelId: "synthetic-replay-model",
		},
	];
	const toolNames = ["read", "search", "edit", "bash", "grep", "glob"];
	let parentId: string | null = null;
	const append = (entry: Record<string, unknown>): void => {
		entry.parentId = parentId;
		entries.push(entry);
		parentId = typeof entry.id === "string" ? entry.id : parentId;
	};
	for (let turn = 0; turn < turns; turn++) {
		const userId = `${id}-user-${turn}`;
		append({
			type: "message",
			id: userId,
			timestamp: `2026-01-01T00:${String(turn % 60).padStart(2, "0")}:00.000Z`,
			message: { role: "user", content: [{ type: "text", text: `Synthetic workload request ${turn}: summarize the project files and explain the implementation details.` }], timestamp: turn },
		});
		const callId = `${id}-call-${turn}`;
		const toolName = toolNames[turn % toolNames.length];
		append({
			type: "message",
			id: `${id}-assistant-tool-${turn}`,
			timestamp: `2026-01-01T00:${String(turn % 60).padStart(2, "0")}:01.000Z`,
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: `Completed synthetic replay workload turn ${turn}; the generated result has stable structure and representative Unicode: 漢字 한글 😀.` },
					{ type: "thinking", thinking: `Inspecting a synthetic source document before producing a carefully reasoned response for turn ${turn}.` },
					{
						type: "toolCall",
						id: callId,
					name: toolName,
					arguments: {
						path: `/private/source/project/src/module-${turn}.ts`,
						query: `synthetic query text with several searchable terms number ${turn}`,
						limit: 20,
						includeHidden: false,
					},
					},
				],
				provider: "synthetic",
				model: "synthetic-replay-model",
				api: "synthetic-api",
				usage: { input: 100 + turn, output: 40, totalTokens: 140 + turn },
				stopReason: "toolUse",
				timestamp: turn,
			},
		});
		append({
			type: "message",
			id: `${id}-tool-result-${turn}`,
			timestamp: `2026-01-01T00:${String(turn % 60).padStart(2, "0")}:02.000Z`,
			message: {
				role: "toolResult",
				toolCallId: callId,
				toolName,
				content: [{ type: "text", text: `Synthetic tool output includes representative results and diagnostics for workload turn ${turn}.` }],
				isError: false,
				timestamp: turn,
			},
		});
	}
	return `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`;
}

function buildEntry(options: BuildOptions, sanitizedJsonl: string, privacyScan?: { checked: number; distinct: number }): CorpusEntry {
	const entries = parseJsonlEntries(sanitizedJsonl);
	const sequence = toolCallSequence(entries);
	const toolKinds = [...new Set(sequence)].sort();
	let assistantTurns = 0;
	let hasCompaction = false;
	for (const entry of entries) {
		if (entry.type === "compaction") hasCompaction = true;
		if (entry.type === "message" && isRecord(entry.message) && entry.message.role === "assistant") assistantTurns++;
	}
	const safeFilename = `${options.id}.jsonl`;
	const privacyNote = privacyScan ? `; privacy scan checked ${privacyScan.checked}/${privacyScan.distinct} distinct words` : "";
	const redactionNotes = `${options.redactionNotes}${privacyNote}`;
	return {
		id: options.id,
		sourceClass: options.sourceClass,
		sourceSha256: options.sourceSha256,
		sanitizerVersion: SANITIZER_VERSION,
		redactionNotes,
		file: safeFilename,
		assistantTurns,
		toolCalls: sequence.length,
		toolKinds,
		hasCompaction,
		bytes: new TextEncoder().encode(sanitizedJsonl).byteLength,
		toolCallSeqSha256: sha256Hex(JSON.stringify(sequence)),
	};
}

function validateId(id: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id) || id === "." || id === "..") {
		throw new Error("Corpus id must be a short filename-safe identifier");
	}
}

async function writeCorpusEntry(options: BuildOptions): Promise<CorpusEntry> {
	validateId(options.id);
	const sanitized = sanitizeSession(options.raw, { seed: options.sourceSha256, fixtureRoot: options.fixtureRoot });
	const privacyScan = options.privacyCheck ? assertRealSourcePrivacy(options.raw, sanitized.jsonl, options.sourceSha256) : undefined;
	const entry = buildEntry({ ...options, redactionNotes: sanitized.redactionNotes }, sanitized.jsonl, privacyScan);
	await fs.mkdir(options.outDir, { recursive: true });
	const sessionPath = path.join(options.outDir, entry.file);
	await Bun.write(sessionPath, sanitized.jsonl);

	const manifestPath = path.join(options.outDir, "manifest.json");
	const current = await Bun.file(manifestPath).exists()
		? await loadCorpusManifest(options.outDir)
		: { schema: MANIFEST_SCHEMA, sanitizerVersion: SANITIZER_VERSION, entries: [] };
	const next: CorpusManifest = {
		schema: MANIFEST_SCHEMA,
		sanitizerVersion: SANITIZER_VERSION,
		entries: [...current.entries.filter(existing => existing.id !== entry.id), entry].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
	};
	await Bun.write(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
	return entry;
}

function defaultFixtureRoot(): string {
	return "/r";
}

function usage(): string {
	return [
		"Usage:",
		"  bun packages/coding-agent/bench/session-replay/build-corpus.ts --source <raw.jsonl> --id <id> --class sanitized-real [--out <dir>] [--fixture-root <dir>]",
		"  bun packages/coding-agent/bench/session-replay/build-corpus.ts --synthetic <id> --turns N --seed S [--out <dir>] [--fixture-root <dir>]",
	].join("\n");
}

async function runCli(args: string[]): Promise<void> {
	let source: string | undefined;
	let id: string | undefined;
	let sourceClass: "sanitized-real" | "dogfood-redacted" | undefined;
	let syntheticId: string | undefined;
	let turns: number | undefined;
	let seed: string | undefined;
	let outDir = path.join(import.meta.dir, "corpus");
	let fixtureRoot = defaultFixtureRoot();
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		const value = args[index + 1];
		if (argument === "--source" && value) source = value;
		else if (argument === "--id" && value) id = value;
		else if (argument === "--class" && (value === "sanitized-real" || value === "dogfood-redacted")) sourceClass = value;
		else if (argument === "--synthetic" && value) syntheticId = value;
		else if (argument === "--turns" && value) turns = Number(value);
		else if (argument === "--seed" && value) seed = value;
		else if (argument === "--out" && value) outDir = path.resolve(value);
		else if (argument === "--fixture-root" && value) fixtureRoot = path.resolve(value);
		else throw new Error(`Unknown or incomplete option ${argument ?? ""}\n${usage()}`);
		index++;
	}
	if (syntheticId !== undefined) {
		if (source || id || sourceClass || !Number.isSafeInteger(turns) || (turns ?? 0) < 1 || (turns ?? 0) > 10000 || seed === undefined || seed.length === 0) {
			throw new Error(`Synthetic corpus input requires only --synthetic <id> --turns N --seed S\n${usage()}`);
		}
		const sourceSeed = seed;
		const raw = buildSyntheticSession(syntheticId, turns as number);
		const entry = await writeCorpusEntry({
			id: syntheticId,
			outDir,
			fixtureRoot,
			sourceClass: "synthetic",
			raw,
			sourceSha256: sha256Hex(sourceSeed),
			privacyCheck: false,
			redactionNotes: "",
		});
		process.stdout.write(`${JSON.stringify(entry)}\n`);
		return;
	}
	if (!source || !id || !sourceClass || syntheticId || turns !== undefined || seed !== undefined) {
		throw new Error(`Real corpus input requires --source <raw.jsonl> --id <id> --class sanitized-real\n${usage()}`);
	}
	const sourceBytes = await Bun.file(source).bytes();
	const raw = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
	const entry = await writeCorpusEntry({
		id,
		outDir,
		fixtureRoot,
		sourceClass,
		raw,
		sourceSha256: sha256Hex(sourceBytes),
		privacyCheck: true,
		redactionNotes: "",
	});
	process.stdout.write(`${JSON.stringify(entry)}\n`);
}

if (import.meta.main) {
	void runCli(process.argv.slice(2)).catch(error => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
