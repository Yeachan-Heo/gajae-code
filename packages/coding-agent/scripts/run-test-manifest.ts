#!/usr/bin/env bun

import * as path from "node:path";
import { CHAT_OPERATION_POLICY } from "../src/sdk/bus/chat-command-policy";
import { ADAPTERS, OPERATIONS } from "../src/sdk/protocol/operation-registry";
import { type Manifest, type ManifestAdapterRow, validateManifest } from "./manifest-schema";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");

function usage(): never {
	process.stderr.write(
		"Usage: bun run packages/coding-agent/scripts/run-test-manifest.ts <manifest.json> [--check]\n",
	);
	process.exit(2);
}

function testCount(output: string): number | undefined {
	const ran = output.match(/Ran\s+(\d+)\s+tests?\s+across\b/);
	if (ran) return Number(ran[1]);
	const summary = output.match(/^(\d+) pass(?:\s*,?\s*\d+ fail)?$/m);
	return summary ? Number(summary[1]) : undefined;
}

const [manifestArgument, ...flags] = process.argv.slice(2);
if (manifestArgument === undefined || flags.some(flag => flag !== "--check")) usage();
const checkOnly = flags.includes("--check");
const manifestPath = path.resolve(manifestArgument);
let manifest: Manifest;
try {
	manifest = validateManifest(await Bun.file(manifestPath).json());
} catch (error) {
	process.stderr.write(`Unable to read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(2);
}

function validateRowReceipts(rows: ManifestAdapterRow[]): void {
	const ids = new Set<string>();
	const counts = new Map<string, number>();
	for (const row of rows) {
		if (ids.has(row.adapterTestId)) throw new Error(`Duplicate adapter test ID: ${row.adapterTestId}`);
		ids.add(row.adapterTestId);
		if (/placeholder|todo|tbd|example/i.test(row.testNamePattern))
			throw new Error(`${row.adapterTestId} has a placeholder test pattern.`);
		if (row.argv[4] === undefined || !row.argv[4].includes(row.adapterTestId))
			throw new Error(`${row.adapterTestId} receipt does not select its exact test.`);

		const [, , operationId] = row.adapterTestId.split("-");
		const operation = OPERATIONS.find(candidate => candidate.id === operationId && candidate.sdkId === row.sdkId);
		if (!operation) throw new Error(`${row.adapterTestId} does not identify a registry operation.`);
		if (row.disposition !== operation.adapterDispositions[row.adapter])
			throw new Error(`${row.adapterTestId} disposition diverges from the operation registry.`);
		if (row.adapter === "telegram" || row.adapter === "discord" || row.adapter === "slack") {
			const policyExpected = row.adapterTestId.endsWith("-secret")
				? "rejected_before_send"
				: CHAT_OPERATION_POLICY[row.adapter][operation.id] === "allowed"
					? "forwarded"
					: "rejected_before_send";
			if (row.expected !== policyExpected)
				throw new Error(`${row.adapterTestId} expected outcome diverges from chat command policy.`);
		}
		counts.set(row.adapter, (counts.get(row.adapter) ?? 0) + 1);
	}
	if (rows.length !== ADAPTERS.length * 93)
		throw new Error(`Expected ${ADAPTERS.length * 93} adapter rows; received ${rows.length}.`);
	for (const adapter of ADAPTERS) {
		if (counts.get(adapter) !== 93)
			throw new Error(`Expected 93 ${adapter} rows; received ${counts.get(adapter) ?? 0}.`);
	}
	process.stdout.write(
		`manifest check: ${rows.length} row receipts (${[...counts].map(([adapter, count]) => `${adapter}=${count}`).join(", ")})\n`,
	);
}

// Required files must be either exact `bun test <file>` commands or fail-closed
// anchored partitions that collectively match every declared row for that file.
const rows = manifest.rows ?? [];
const exactExecutableFiles = new Set(
	manifest.commands
		.filter(command => command.argv.length === 3 && command.argv[0] === "bun" && command.argv[1] === "test")
		.map(command => command.argv[2]),
);
for (const file of manifest.required ?? []) {
	if (exactExecutableFiles.has(file)) continue;
	const fileRows = rows.filter(row => row.testFile === file);
	const partitions = manifest.commands
		.filter(
			command =>
				command.argv.length === 5 &&
				command.argv[0] === "bun" &&
				command.argv[1] === "test" &&
				command.argv[2] === file &&
				command.argv[3] === "--test-name-pattern" &&
				command.argv[4]?.startsWith("^"),
		)
		.map(command => new RegExp(command.argv[4]!));
	if (
		fileRows.length === 0 ||
		partitions.length === 0 ||
		fileRows.some(row => !partitions.some(pattern => pattern.test(row.testNamePattern)))
	) {
		process.stderr.write(`Manifest required file is not covered by executable commands: ${file}\n`);
		process.exit(1);
	}
}
if (rows.length > 0) {
	try {
		validateRowReceipts(rows);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	}
}
if (checkOnly) process.exit(0);

const startedAt = performance.now();
let commandReceipts = 0;
let rowReceipts = 0;
const perAdapter = new Map<string, number>();

async function executeReceipt(argv: string[]): Promise<void> {
	const child = Bun.spawn(argv, { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	process.stdout.write(stdout);
	process.stderr.write(stderr);
	const tests = testCount(`${stdout}\n${stderr}`);
	process.stdout.write(`receipt: ${argv.join(" ")} exit=${exitCode} tests=${tests ?? "unknown"}\n`);
	if (exitCode === 0 && tests !== undefined && tests >= 1) return;
	const reason = exitCode !== 0 ? `exit ${exitCode}` : "did not report at least one test";
	process.stderr.write(`Manifest receipt failed: ${argv.join(" ")} (${reason})\n`);
	process.exit(1);
}

for (const command of manifest.commands) {
	await executeReceipt(command.argv);
	commandReceipts++;
}
process.stdout.write(`manifest command receipts complete: ${commandReceipts}\n`);

for (const row of rows) {
	await executeReceipt(row.argv);
	rowReceipts++;
	perAdapter.set(row.adapter, (perAdapter.get(row.adapter) ?? 0) + 1);
}
if (rows.length > 0) {
	process.stdout.write(
		`manifest row receipts complete: ${rowReceipts} (${[...perAdapter].map(([adapter, count]) => `${adapter}=${count}`).join(", ")})\n`,
	);
}
process.stdout.write(`manifest receipts runtime=${Math.round(performance.now() - startedAt)}ms\n`);
