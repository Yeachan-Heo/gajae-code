import * as path from "node:path";
import { EditMatchError, findMatch, seekSequence } from "../../../../coding-agent/src/edit/modes/replace";
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
	strict: Awaited<ReturnType<typeof findMatch>>;
	fuzzy: Awaited<ReturnType<typeof findMatch>>;
	sequence: Awaited<ReturnType<typeof seekSequence>>;
	strictError: string | null;
	fuzzyError: string | null;
	missing: {
		strict: Awaited<ReturnType<typeof findMatch>>;
		fuzzy: Awaited<ReturnType<typeof findMatch>>;
		errors: ErrorStrings;
	};
}

function formatOccurrenceError(pathname: string, result: Awaited<ReturnType<typeof findMatch>>): string {
	const occurrences = result.occurrences ?? 0;
	const more = occurrences > MAX_RECORDED_MATCHES ? ` (showing first ${MAX_RECORDED_MATCHES} of ${occurrences})` : "";
	const previews = result.occurrencePreviews?.join("\n\n") ?? "";
	return `Found ${occurrences} occurrences in ${pathname}${more}:\n\n${previews}\n\nAdd more context lines to disambiguate.`;
}

function formatFindError(
	pathname: string,
	target: string,
	result: Awaited<ReturnType<typeof findMatch>>,
	allowFuzzy: boolean,
): string | null {
	if (result.occurrences && result.occurrences > 1) return formatOccurrenceError(pathname, result);
	if (result.match) return null;
	return EditMatchError.formatMessage(pathname, target, result.closest, {
		allowFuzzy,
		threshold: DEFAULT_THRESHOLD,
		fuzzyMatches: result.fuzzyMatches,
	});
}

async function loadEditBenchmarkCases(): Promise<{ cases: DifferentialCase<EditFuzzyInput>[]; inputs: Map<string, BenchmarkMatcherInput>; archiveSha256: string }> {
	const archiveBytes = new Uint8Array(await Bun.file(benchmarkArchive).arrayBuffer());
	const archive = new Bun.Archive(archiveBytes);
	const archivedFiles = await archive.files();
	const files = new Map([...archivedFiles].map(([name, contents]) => [name.replaceAll("\\", "/").replace(/^\.\//, ""), contents]));
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
			const fileName = path.posix.basename(metadata.file_path);
			const inputPath = `fixtures/${taskId}/input/${fileName}`;
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

function evaluate(input: EditFuzzyInput): EditFuzzyOutput {
	const fixture = matcherInput(input);
	const strict = findMatch(fixture.content, fixture.target, { allowFuzzy: false, threshold: DEFAULT_THRESHOLD });
	const fuzzy = findMatch(fixture.content, fixture.target, { allowFuzzy: true, threshold: DEFAULT_THRESHOLD });
	const missingStrict = findMatch(fixture.content, fixture.missingTarget, {
		allowFuzzy: false,
		threshold: DEFAULT_THRESHOLD,
	});
	const missingFuzzy = findMatch(fixture.content, fixture.missingTarget, {
		allowFuzzy: true,
		threshold: DEFAULT_THRESHOLD,
	});
	const sequence = seekSequence(
		fixture.content.split("\n"),
		fixture.target.split("\n"),
		fixture.line,
		false,
		{ allowFuzzy: true },
	);
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

const tsBaselines = new WeakMap<EditFuzzyInput, EditFuzzyOutput>();
for (const testCase of benchmark.cases) tsBaselines.set(testCase.input, evaluate(testCase.input));

export const editFuzzyDifferential = defineDifferential<EditFuzzyInput, EditFuzzyOutput>({
	module: "edit-fuzzy",
	cases: benchmark.cases,
	reference: input => {
		const baseline = tsBaselines.get(input);
		if (!baseline) throw new Error("Edit-fuzzy TS golden input is not registered");
		return baseline;
	},
	native: evaluate,
});
