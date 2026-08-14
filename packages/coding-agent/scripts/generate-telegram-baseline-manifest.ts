#!/usr/bin/env bun

import * as path from "node:path";
import { Glob } from "bun";
import { type Manifest, validateManifest } from "./manifest-schema";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const testDirectory = process.env.GJC_TELEGRAM_BASELINE_TEST_DIR
	? path.resolve(process.env.GJC_TELEGRAM_BASELINE_TEST_DIR)
	: path.join(repoRoot, "packages", "coding-agent", "test");
const manifestPath = process.env.GJC_TELEGRAM_BASELINE_MANIFEST
	? path.resolve(process.env.GJC_TELEGRAM_BASELINE_MANIFEST)
	: path.join(testDirectory, "manifests", "telegram-baseline-v1.json");
const reviewedExclusions: Manifest["excluded"] = [];

const explicitTests = [
	"daemon-control.test.ts",
	"telegram-send-tool.test.ts",
	"telegram-onboarding-docs.test.ts",
	"lifecycle-notification-docs.test.ts",
];
const requiredTests = [
	"packages/coding-agent/test/daemon-control.test.ts",
	"packages/coding-agent/test/notifications-chat-adapters.test.ts",
];

function toRepoPath(relativeTestPath: string): string {
	return path.posix.join("packages/coding-agent/test", relativeTestPath.split(path.sep).join("/"));
}

async function discoverTests(): Promise<string[]> {
	const tests = new Set<string>();
	for (const pattern of ["notifications-*.test.ts", "telegram-*.test.ts"]) {
		for await (const relativePath of new Glob(pattern).scan(testDirectory)) {
			tests.add(toRepoPath(relativePath));
		}
	}

	for (const filename of explicitTests) {
		const filePath = path.join(testDirectory, filename);
		if (await Bun.file(filePath).exists()) {
			tests.add(toRepoPath(filename));
		}
	}

	return [...tests].sort();
}

function generateManifest(tests: string[]): Manifest {
	const excludedFiles = new Set(reviewedExclusions.map(exclusion => exclusion.file));
	return {
		version: 1,
		commands: tests.filter(test => !excludedFiles.has(test)).map(file => ({ argv: ["bun", "test", file] })),
		excluded: [...reviewedExclusions],
		required: requiredTests,
	};
}

function normalizedManifest(manifest: Manifest): Manifest {
	return {
		version: manifest.version,
		commands: manifest.commands
			.map(command => ({ argv: [...command.argv] }))
			.sort((left, right) => left.argv.join("\0").localeCompare(right.argv.join("\0"))),
		excluded: manifest.excluded
			.map(exclusion => ({ ...exclusion }))
			.sort((left, right) => left.file.localeCompare(right.file) || left.reason.localeCompare(right.reason)),
		required: [...(manifest.required ?? [])].sort(),
		rows: (manifest.rows ?? [])
			.map(row => ({ ...row, argv: [...row.argv] }))
			.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
	};
}

function describeMismatch(expected: Manifest, actual: Manifest): string {
	const expectedCommands = new Set(expected.commands.map(command => command.argv.join("\0")));
	const actualCommands = new Set(actual.commands.map(command => command.argv.join("\0")));
	const expectedExclusions = new Set(expected.excluded.map(exclusion => `${exclusion.file}\0${exclusion.reason}`));
	const actualExclusions = new Set(actual.excluded.map(exclusion => `${exclusion.file}\0${exclusion.reason}`));
	const differences = [
		...actual.commands
			.filter(command => !expectedCommands.has(command.argv.join("\0")))
			.map(command => `- stale command: ${command.argv.join(" ")}`),
		...expected.commands
			.filter(command => !actualCommands.has(command.argv.join("\0")))
			.map(command => `- missing command: ${command.argv.join(" ")}`),
		...actual.excluded
			.filter(exclusion => !expectedExclusions.has(`${exclusion.file}\0${exclusion.reason}`))
			.map(exclusion => `- unapproved exclusion: ${exclusion.file} (${exclusion.reason})`),
		...expected.excluded
			.filter(exclusion => !actualExclusions.has(`${exclusion.file}\0${exclusion.reason}`))
			.map(exclusion => `- missing reviewed exclusion: ${exclusion.file} (${exclusion.reason})`),
	];
	return differences.length > 0 ? differences.join("\n") : "- manifest fields differ";
}

async function checkManifest(expected: Manifest): Promise<void> {
	let manifest: Manifest;
	try {
		manifest = validateManifest(await Bun.file(manifestPath).json());
	} catch (error) {
		throw new Error(
			`Unable to read ${path.relative(repoRoot, manifestPath)}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const normalizedExpected = normalizedManifest(expected);
	const normalizedManifestFile = normalizedManifest(manifest);
	if (JSON.stringify(normalizedManifestFile) !== JSON.stringify(normalizedExpected)) {
		throw new Error(
			`Telegram baseline manifest does not exactly match the generated baseline:\n${describeMismatch(normalizedExpected, normalizedManifestFile)}`,
		);
	}
}

const tests = await discoverTests();
const generatedManifest = validateManifest(generateManifest(tests));
if (process.argv.slice(2).includes("--check")) {
	try {
		await checkManifest(generatedManifest);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	}
} else {
	await Bun.write(manifestPath, `${JSON.stringify(generatedManifest, null, "\t")}\n`);
	process.stderr.write(`Generated ${path.relative(repoRoot, manifestPath)} (${tests.length} commands)\n`);
}
