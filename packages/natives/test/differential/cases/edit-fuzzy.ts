import * as path from "node:path";
import { EditMatchError, findMatch, seekSequence } from "../../../../coding-agent/src/edit/modes/replace";
import type { DifferentialCase } from "../harness";
import { defineDifferential } from "../harness";

const repositoryRoot = path.resolve(import.meta.dir, "../../../../..");
const benchmarkArchive = path.join(repositoryRoot, "packages", "typescript-edit-benchmark", "fixtures.tar.gz");
const DEFAULT_THRESHOLD = 0.95;
const MAX_RECORDED_MATCHES = 5;

export interface EditFuzzyInput {
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

async function decodeUtf8(file: Blob): Promise<string> {
	return file.text();
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

async function loadEditBenchmarkCases(): Promise<DifferentialCase<EditFuzzyInput>[]> {
	const archiveBytes = new Uint8Array(await Bun.file(benchmarkArchive).arrayBuffer());
	const archive = new Bun.Archive(archiveBytes);
	const archivedFiles = await archive.files();
	const files = new Map([...archivedFiles].map(([name, contents]) => [name.replaceAll("\\", "/").replace(/^\.\//, ""), contents]));
	const taskIds = [...files.keys()]
		.map(file => /^fixtures\/([^/]+)\/metadata\.json$/.exec(file)?.[1])
		.filter((taskId): taskId is string => taskId !== undefined)
		.sort();
	if (taskIds.length === 0) throw new Error(`No edit-benchmark tasks found in ${benchmarkArchive}`);

	return Promise.all(taskIds.map(async taskId => {
		const metadataBytes = files.get(`fixtures/${taskId}/metadata.json`);
		if (!metadataBytes) throw new Error(`Missing edit-benchmark metadata for ${taskId}`);
		const metadata = JSON.parse(await decodeUtf8(metadataBytes)) as {
			file_path?: string;
			line_number?: number;
			original_snippet?: string;
		};
		if (typeof metadata.file_path !== "string" || typeof metadata.original_snippet !== "string") {
			throw new Error(`Incomplete edit-benchmark matcher metadata for ${taskId}`);
		}
		const fileName = path.posix.basename(metadata.file_path);
		const inputPath = `fixtures/${taskId}/input/${fileName}`;
		const inputBytes = files.get(inputPath);
		if (!inputBytes) throw new Error(`Missing edit-benchmark input ${inputPath}`);
		const target = metadata.original_snippet;
		return {
			id: taskId,
			input: {
				path: metadata.file_path,
				content: await decodeUtf8(inputBytes),
				line: Math.max(0, (metadata.line_number ?? 1) - 1),
				target,
				missingTarget: `${target}\n__gjc_edit_fuzzy_missing_${taskId}__`,
			},
		};
	}));
}

const cases = await loadEditBenchmarkCases();

function evaluate(input: EditFuzzyInput): EditFuzzyOutput {
	const strict = findMatch(input.content, input.target, { allowFuzzy: false, threshold: DEFAULT_THRESHOLD });
	const fuzzy = findMatch(input.content, input.target, { allowFuzzy: true, threshold: DEFAULT_THRESHOLD });
	const missingStrict = findMatch(input.content, input.missingTarget, {
		allowFuzzy: false,
		threshold: DEFAULT_THRESHOLD,
	});
	const missingFuzzy = findMatch(input.content, input.missingTarget, {
		allowFuzzy: true,
		threshold: DEFAULT_THRESHOLD,
	});
	const lines = input.content.split("\n");
	const pattern = input.target.split("\n");
	const sequence = seekSequence(lines, pattern, input.line, false, { allowFuzzy: true });
	return {
		strict,
		fuzzy,
		sequence,
		strictError: formatFindError(input.path, input.target, strict, false),
		fuzzyError: formatFindError(input.path, input.target, fuzzy, true),
		missing: {
			strict: missingStrict,
			fuzzy: missingFuzzy,
			errors: {
				strict: formatFindError(input.path, input.missingTarget, missingStrict, false),
				fuzzy: formatFindError(input.path, input.missingTarget, missingFuzzy, true),
			},
		},
	};
}

const tsBaselines = new WeakMap<EditFuzzyInput, EditFuzzyOutput>();
for (const testCase of cases) tsBaselines.set(testCase.input, evaluate(testCase.input));

export const editFuzzyDifferential = defineDifferential<EditFuzzyInput, EditFuzzyOutput>({
	module: "edit-fuzzy",
	cases,
	reference: input => {
		const baseline = tsBaselines.get(input);
		if (!baseline) throw new Error("Edit-fuzzy TS golden input is not registered");
		return baseline;
	},
	native: evaluate,
});
