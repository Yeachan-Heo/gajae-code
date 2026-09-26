import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface DifferentialCase<Input = unknown> {
	id: string;
	input: Input;
}

export interface GoldenRecord<Input = unknown, Output = unknown> {
	module: string;
	caseId: string;
	inputHash: string;
	input: Input;
	output: Output;
}

export interface DifferentialConfig<Input, Output> {
	module: string;
	cases: readonly DifferentialCase<Input>[];
	reference?: (input: Input) => Output | Promise<Output>;
	native: (input: Input) => Output | Promise<Output>;
	normalize?: (value: unknown) => unknown;
	compare?: (actual: unknown, expected: unknown) => boolean;
	accepted?: ReadonlyMap<string, { reason: string }>;
}

export interface DifferentialReport {
	total: number;
	identical: number;
	accepted: string[];
	unlisted: string[];
	stale: string[];
}

export interface DifferentialDefinition<Input, Output> extends DifferentialConfig<Input, Output> {}

function canonical(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, nested]) => [key, sortKeys(nested)]),
		);
	}
	return value;
}

export function inputHash(input: unknown): string {
	return new Bun.CryptoHasher("sha256").update(canonical(input)).digest("hex");
}

export function defineDifferential<Input, Output>(
	config: DifferentialConfig<Input, Output>,
): DifferentialDefinition<Input, Output> {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(config.module))
		throw new Error(`invalid differential module name: ${config.module}`);
	const ids = new Set<string>();
	for (const testCase of config.cases) {
		if (!testCase.id.trim()) throw new Error("differential case id must not be empty");
		if (ids.has(testCase.id)) throw new Error(`duplicate differential case id: ${testCase.id}`);
		ids.add(testCase.id);
	}
	return config;
}

export async function recordGoldens<Input, Output>(
	definition: DifferentialDefinition<Input, Output>,
	goldenPath: string,
): Promise<GoldenRecord<Input, Output>[]> {
	if (!definition.reference) throw new Error("record mode requires a live reference implementation");
	const records: GoldenRecord<Input, Output>[] = [];
	for (const testCase of definition.cases) {
		records.push({
			module: definition.module,
			caseId: testCase.id,
			inputHash: inputHash(testCase.input),
			input: testCase.input,
			output: await definition.reference(testCase.input),
		});
	}
	await fs.mkdir(path.dirname(goldenPath), { recursive: true });
	await fs.writeFile(goldenPath, `${records.map(record => JSON.stringify(record)).join("\n")}\n`, "utf8");
	return records;
}

export async function readGoldens(goldenPath: string): Promise<GoldenRecord[]> {
	const contents = await fs.readFile(goldenPath, "utf8");
	const records: GoldenRecord[] = [];
	const ids = new Set<string>();
	for (const [index, line] of contents.split(/\r?\n/).entries()) {
		if (!line.trim()) continue;
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch (error) {
			throw new Error(
				`invalid golden JSONL at ${goldenPath}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!isGoldenRecord(record)) throw new Error(`invalid golden record at ${goldenPath}:${index + 1}`);
		if (ids.has(record.caseId)) throw new Error(`duplicate golden case id: ${record.caseId}`);
		ids.add(record.caseId);
		records.push(record);
	}
	return records;
}

function isGoldenRecord(value: unknown): value is GoldenRecord {
	if (value === null || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.module === "string" &&
		typeof record.caseId === "string" &&
		/^[0-9a-f]{64}$/.test(String(record.inputHash)) &&
		"input" in record &&
		"output" in record
	);
}

function equalByDefault(actual: unknown, expected: unknown): boolean {
	return canonical(actual) === canonical(expected);
}

export async function compareGoldens<Input, Output>(
	definition: DifferentialDefinition<Input, Output>,
	goldens: readonly GoldenRecord[],
): Promise<DifferentialReport> {
	const goldenById = new Map(goldens.map(record => [record.caseId, record]));
	const currentIds = new Set(definition.cases.map(testCase => testCase.id));
	const stale = goldens
		.filter(record => record.module !== definition.module || !currentIds.has(record.caseId))
		.map(record => record.caseId);
	const report: DifferentialReport = {
		total: definition.cases.length,
		identical: 0,
		accepted: [],
		unlisted: [],
		stale,
	};
	const normalize = definition.normalize ?? (value => value);
	const compare = definition.compare ?? equalByDefault;
	for (const testCase of definition.cases) {
		const golden = goldenById.get(testCase.id);
		if (!golden || golden.module !== definition.module || golden.inputHash !== inputHash(testCase.input)) {
			report.unlisted.push(testCase.id);
			continue;
		}
		const nativeValue = await definition.native(testCase.input);
		const liveReference = definition.reference ? await definition.reference(testCase.input) : undefined;
		const nativeNormalized = normalize(nativeValue);
		const goldenNormalized = normalize(golden.output);
		const referenceMatches =
			definition.reference === undefined || compare(nativeNormalized, normalize(liveReference));
		if (compare(nativeNormalized, goldenNormalized) && referenceMatches) {
			report.identical += 1;
			continue;
		}
		if (definition.accepted?.has(testCase.id)) report.accepted.push(testCase.id);
		else report.unlisted.push(testCase.id);
	}
	return report;
}

export async function verifyDifferential<Input, Output>(
	definition: DifferentialDefinition<Input, Output>,
	goldenPath: string,
): Promise<DifferentialReport> {
	return compareGoldens(definition, await readGoldens(goldenPath));
}
