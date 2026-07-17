#!/usr/bin/env bun

import * as path from "node:path";
import { type Adapter, type AdapterDisposition, OPERATIONS } from "../src/sdk/protocol/operation-registry";
import { type Manifest, type ManifestAdapterRow, validateManifest } from "./manifest-schema";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const manifestPath = path.join(repoRoot, "packages/coding-agent/test/manifests/sdk-adapter-parity-v1.json");
const adapterTests: Record<Adapter, string[]> = {
	telegram: ["packages/coding-agent/test/sdk-adapter-dispositions.test.ts"],
	discord: ["packages/coding-agent/test/sdk-adapter-dispositions.test.ts"],
	slack: ["packages/coding-agent/test/sdk-adapter-dispositions.test.ts"],
	mcp: [
		"packages/coding-agent/test/sdk-mcp-adapter.test.ts",
		"packages/coding-agent/test/sdk-mcp-entrypoint-e2e.test.ts",
		"packages/coding-agent/test/sdk-adapter-dispositions.test.ts",
	],
	acp: [
		"packages/coding-agent/test/sdk-acp-adapter.test.ts",
		"packages/coding-agent/test/sdk-acp-two-client-race.test.ts",
		"packages/coding-agent/test/sdk-acp-provider-reconnect.test.ts",
		"packages/coding-agent/test/sdk-adapter-dispositions.test.ts",
	],
	daemonCli: [
		"packages/coding-agent/test/sdk-daemon-cli-e2e.test.ts",
		"packages/coding-agent/test/sdk-client.test.ts",
		"packages/coding-agent/test/sdk-adapter-dispositions.test.ts",
	],
};
const dispositionTestFile = "packages/coding-agent/test/sdk-adapter-dispositions.test.ts";
const commandFiles = [
	...new Set([...Object.values(adapterTests).flat(), "packages/coding-agent/test/sdk-host-wiring.test.ts"]),
].sort();
const commands: Manifest["commands"] = commandFiles.flatMap(file =>
	file === dispositionTestFile
		? ["^AD-M-", "^AD-A-", "^AD-L-", "^AD-(T|D|S)-"].map(pattern => ({
				argv: ["bun", "test", file, "--test-name-pattern", pattern],
			}))
		: [{ argv: ["bun", "test", file] }],
);
const required = [...commandFiles];
const excluded: Manifest["excluded"] = [];
const adapters = ["telegram", "discord", "slack", "mcp", "acp", "daemonCli"] as const;

function expectedOutcome(disposition: AdapterDisposition): ManifestAdapterRow["expected"] {
	return disposition === "prohibited"
		? "rejected_before_send"
		: disposition === "machine_only" || disposition === "provider_only"
			? "internal_only"
			: "forwarded";
}

function adapterTestPrefix(adapter: Adapter): string {
	return adapter === "telegram"
		? "T"
		: adapter === "discord"
			? "D"
			: adapter === "slack"
				? "S"
				: adapter === "daemonCli"
					? "L"
					: adapter === "mcp"
						? "M"
						: "A";
}
function row(adapter: Adapter, operation: (typeof OPERATIONS)[number], secret = false): ManifestAdapterRow {
	const suffix = secret ? "-secret" : "";
	return {
		adapterTestId: `AD-${adapterTestPrefix(adapter)}-${operation.id}${suffix}`,
		sdkId: operation.sdkId,
		adapter,
		disposition: operation.adapterDispositions[adapter],
		testFile: dispositionTestFile,
		testNamePattern: `AD-${adapterTestPrefix(adapter)}-${operation.id}${suffix}`,
		argv: [
			"bun",
			"test",
			dispositionTestFile,
			"--test-name-pattern",
			`^AD-${adapterTestPrefix(adapter)}-${operation.id}${suffix}:`,
		],
		expected: secret ? "rejected_before_send" : expectedOutcome(operation.adapterDispositions[adapter]),
	};
}

function generateRows(): ManifestAdapterRow[] {
	return OPERATIONS.flatMap(operation =>
		adapters.flatMap(adapter => [
			row(adapter, operation),
			...(operation.id === "C36" ? [row(adapter, operation, true)] : []),
		]),
	);
}

function generateManifest(): Manifest {
	return {
		version: 1,
		commands,
		excluded,
		required,
		rows: generateRows(),
	};
}

async function checkCoverage(manifest: Manifest): Promise<void> {
	const rows = manifest.rows ?? [];
	const expectedRows = generateRows();
	const rowKeys = new Set(rows.map(row => row.adapterTestId));
	for (const row of expectedRows) {
		if (!rowKeys.has(row.adapterTestId))
			throw new Error(`${row.adapterTestId} has no adapter-disposition manifest row.`);
	}
	if (rows.length !== expectedRows.length) throw new Error("SDK adapter parity manifest has unexpected rows.");
	const adapterTestIds = new Set<string>();
	for (const row of rows) {
		if (adapterTestIds.has(row.adapterTestId)) throw new Error(`Duplicate adapter test ID: ${row.adapterTestId}`);
		adapterTestIds.add(row.adapterTestId);
		if (/placeholder|todo|tbd|example/i.test(row.testNamePattern))
			throw new Error(`${row.adapterTestId} uses a placeholder test name pattern.`);
		if (
			row.argv.length !== 5 ||
			row.argv[0] !== "bun" ||
			row.argv[1] !== "test" ||
			row.argv[2] !== row.testFile ||
			row.argv[3] !== "--test-name-pattern"
		)
			throw new Error(`${row.adapterTestId} must execute its exact test-name pattern.`);
		const testPath = path.join(repoRoot, row.testFile);
		const testFile = Bun.file(testPath);
		if (!(await testFile.exists())) throw new Error(`${row.adapterTestId} test file does not exist: ${row.testFile}`);
		const testText = await testFile.text();
		// The disposition suite deliberately generates names from registry IDs. This source check
		// confirms its name template and the concrete row ID are both present in the registry.
		if (!testText.includes("AD-$" + "{adapterPrefix[adapter]}-$" + "{operation.id}"))
			throw new Error(`${row.adapterTestId} test name template was not found in ${row.testFile}.`);
		if (!OPERATIONS.some(operation => row.sdkId === operation.sdkId))
			throw new Error(`${row.adapterTestId} references an unknown SDK ID.`);
	}
	if (manifest.excluded.length !== 0) throw new Error("SDK adapter parity manifest must include all six adapters.");
}

async function checkManifest(expected: Manifest): Promise<void> {
	const actual = validateManifest(await Bun.file(manifestPath).json());
	if (JSON.stringify(actual) !== JSON.stringify(expected))
		throw new Error(`SDK adapter parity manifest is stale: ${path.relative(repoRoot, manifestPath)}`);
	await checkCoverage(actual);
}

const expected = validateManifest(generateManifest());
if (process.argv.slice(2).includes("--check")) {
	try {
		await checkManifest(expected);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	}
} else {
	await Bun.write(manifestPath, `${JSON.stringify(expected, null, "\t")}\n`);
	await checkCoverage(expected);
	process.stderr.write(
		`Generated ${path.relative(repoRoot, manifestPath)} (${expected.rows?.length ?? 0} row receipts)\n`,
	);
}
