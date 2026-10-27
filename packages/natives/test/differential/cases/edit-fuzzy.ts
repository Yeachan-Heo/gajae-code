import * as path from "node:path";
import type {
	FuzzyMatch,
	MatchOutcome,
	SequenceMatchStrategy,
	SequenceSearchResult,
} from "../../../../coding-agent/src/edit/modes/replace";
import { EditMatchError } from "../../../../coding-agent/src/edit/modes/replace";
import type { EditFindMatchResult } from "../../../native/index.js";
import { editFindMatch, editSeekSequence } from "../../../native/index.js";
import type { DifferentialCase } from "../harness";
import { defineDifferential } from "../harness";

const repositoryRoot = path.resolve(import.meta.dir, "../../../../..");
const benchmarkArchive = path.join(repositoryRoot, "packages", "typescript-edit-benchmark", "fixtures.tar.gz");
const DEFAULT_THRESHOLD = 0.95;
const MAX_RECORDED_MATCHES = 5;

export interface EditFuzzyInput {
	taskId: string;
	corpusSha256: string;
}

interface BenchmarkMatcherInput {
	path: string;
	content: string;
	line: number;
	target: string;
	missingTarget: string;
}

interface ErrorStrings {
	strict: string | null;
	fuzzy: string | null;
}

export interface EditFuzzyOutput {
	strict: MatchOutcome;
	fuzzy: MatchOutcome;
	sequence: SequenceSearchResult;
	strictError: string | null;
	fuzzyError: string | null;
	missing: {
		strict: MatchOutcome;
		fuzzy: MatchOutcome;
		errors: ErrorStrings;
	};
}

function formatOccurrenceError(pathname: string, result: MatchOutcome): string {
	const occurrences = result.occurrences ?? 0;
	const more = occurrences > MAX_RECORDED_MATCHES ? ` (showing first ${MAX_RECORDED_MATCHES} of ${occurrences})` : "";
	const previews = result.occurrencePreviews?.join("\n\n") ?? "";
	return `Found ${occurrences} occurrences in ${pathname}${more}:\n\n${previews}\n\nAdd more context lines to disambiguate.`;
}

function formatFindError(pathname: string, target: string, result: MatchOutcome, allowFuzzy: boolean): string | null {
	if (result.occurrences && result.occurrences > 1) return formatOccurrenceError(pathname, result);
	if (result.match) return null;
	return EditMatchError.formatMessage(pathname, target, result.closest, {
		allowFuzzy,
		threshold: DEFAULT_THRESHOLD,
		fuzzyMatches: result.fuzzyMatches,
	});
}

async function loadEditBenchmarkCases(): Promise<{
	cases: DifferentialCase<EditFuzzyInput>[];
	inputs: Map<string, BenchmarkMatcherInput>;
	archiveSha256: string;
}> {
	const archiveBytes = new Uint8Array(await Bun.file(benchmarkArchive).arrayBuffer());
	const archive = new Bun.Archive(archiveBytes);
	const archivedFiles = await archive.files();
	const files = new Map(
		[...archivedFiles].map(([name, contents]) => [name.replaceAll("\\", "/").replace(/^\.\//, ""), contents]),
	);
	const taskIds = [...files.keys()]
		.map(file => /^fixtures\/([^/]+)\/metadata\.json$/.exec(file)?.[1])
		.filter((taskId): taskId is string => taskId !== undefined)
		.sort();
	if (taskIds.length === 0) throw new Error(`No edit-benchmark tasks found in ${benchmarkArchive}`);

	const archiveSha256 = new Bun.CryptoHasher("sha256").update(archiveBytes).digest("hex");
	const inputs = new Map<string, BenchmarkMatcherInput>();
	const cases = await Promise.all(
		taskIds.map(async taskId => {
			const metadataBytes = files.get(`fixtures/${taskId}/metadata.json`);
			if (!metadataBytes) throw new Error(`Missing edit-benchmark metadata for ${taskId}`);
			const metadata = JSON.parse(await metadataBytes.text()) as {
				file_path?: string;
				line_number?: number;
				original_snippet?: string;
			};
			if (typeof metadata.file_path !== "string" || typeof metadata.original_snippet !== "string") {
				throw new Error(`Incomplete edit-benchmark matcher metadata for ${taskId}`);
			}
			const inputPath = `fixtures/${taskId}/input/${path.posix.basename(metadata.file_path)}`;
			const inputFile = files.get(inputPath);
			if (!inputFile) throw new Error(`Missing edit-benchmark input ${inputPath}`);
			const target = metadata.original_snippet;
			inputs.set(taskId, {
				path: metadata.file_path,
				content: await inputFile.text(),
				line: Math.max(0, (metadata.line_number ?? 1) - 1),
				target,
				missingTarget: `${target}\n__gjc_edit_fuzzy_missing_${taskId}__`,
			});
			return { id: taskId, input: { taskId, corpusSha256: archiveSha256 } };
		}),
	);
	return { cases, inputs, archiveSha256 };
}

const benchmark = await loadEditBenchmarkCases();

function matcherInput(input: EditFuzzyInput): BenchmarkMatcherInput {
	if (input.corpusSha256 !== benchmark.archiveSha256) throw new Error("Edit-benchmark fixture archive hash changed");
	const matcherInput = benchmark.inputs.get(input.taskId);
	if (!matcherInput) throw new Error(`Unknown edit-benchmark task ${input.taskId}`);
	return matcherInput;
}

function mapNativeMatch(match: EditFindMatchResult["matched"]): FuzzyMatch | undefined {
	return match
		? {
				actualText: match.actualText,
				startIndex: match.startIndex,
				startLine: match.startLine,
				confidence: match.confidence,
			}
		: undefined;
}

function mapNativeMatchOutcome(result: EditFindMatchResult): MatchOutcome {
	const match = mapNativeMatch(result.matched);
	const closest = mapNativeMatch(result.closest);
	return {
		...(match ? { match } : {}),
		...(closest ? { closest } : {}),
		...(result.occurrences != null ? { occurrences: result.occurrences } : {}),
		...(result.occurrenceLines != null ? { occurrenceLines: result.occurrenceLines } : {}),
		...(result.occurrencePreviews != null ? { occurrencePreviews: result.occurrencePreviews } : {}),
		...(result.fuzzyMatches != null ? { fuzzyMatches: result.fuzzyMatches } : {}),
		...(result.dominantFuzzy != null ? { dominantFuzzy: result.dominantFuzzy } : {}),
	};
}

function evaluate(input: EditFuzzyInput): EditFuzzyOutput {
	const fixture = matcherInput(input);
	const strict = mapNativeMatchOutcome(editFindMatch(fixture.content, fixture.target, false, DEFAULT_THRESHOLD));
	const fuzzy = mapNativeMatchOutcome(editFindMatch(fixture.content, fixture.target, true, DEFAULT_THRESHOLD));
	const missingStrict = mapNativeMatchOutcome(
		editFindMatch(fixture.content, fixture.missingTarget, false, DEFAULT_THRESHOLD),
	);
	const missingFuzzy = mapNativeMatchOutcome(
		editFindMatch(fixture.content, fixture.missingTarget, true, DEFAULT_THRESHOLD),
	);
	const sequenceResult = editSeekSequence(
		fixture.content.split("\n"),
		fixture.target.split("\n"),
		fixture.line,
		false,
		true,
	);
	const sequence: SequenceSearchResult = {
		index: sequenceResult.index,
		confidence: sequenceResult.confidence,
		...(sequenceResult.matchCount != null ? { matchCount: sequenceResult.matchCount } : {}),
		...(sequenceResult.matchIndices ? { matchIndices: sequenceResult.matchIndices } : {}),
		...(sequenceResult.strategy ? { strategy: sequenceResult.strategy as SequenceMatchStrategy } : {}),
	};
	return {
		strict,
		fuzzy,
		sequence,
		strictError: formatFindError(fixture.path, fixture.target, strict, false),
		fuzzyError: formatFindError(fixture.path, fixture.target, fuzzy, true),
		missing: {
			strict: missingStrict,
			fuzzy: missingFuzzy,
			errors: {
				strict: formatFindError(fixture.path, fixture.missingTarget, missingStrict, false),
				fuzzy: formatFindError(fixture.path, fixture.missingTarget, missingFuzzy, true),
			},
		},
	};
}

export const editFuzzyDifferential = defineDifferential<EditFuzzyInput, EditFuzzyOutput>({
	module: "edit-fuzzy",
	cases: benchmark.cases,
	native: evaluate,
});
