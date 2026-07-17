#!/usr/bin/env bun

import * as path from "node:path";

const repoRoot = process.env.GJC_SDK_RENAME_SCAN_ROOT
	? path.resolve(process.env.GJC_SDK_RENAME_SCAN_ROOT)
	: path.resolve(import.meta.dir, "..", "..", "..");
const scannerPath = "packages/coding-agent/scripts/verify-gjc-sdk-rename.ts";
const pinnedRollbackFixturePaths = new Set([
	"packages/coding-agent/test/manifests/sdk-pretrain-binary.json",
	"packages/coding-agent/test/sdk-downgrade-rollback.test.ts",
	"scripts/transform-sdk-state-for-rollback.ts",
]);
const forbidden = [
	{ label: "gjc-notifications", pattern: /\bgjc-notifications\b/i },
	{ label: "gjc_notifications", pattern: /\bgjc_notifications\b/ },
	{ label: "@gajae-code/notifications", pattern: /@gajae-code[/_-]notifications\b/i },
	{ label: "notifications SDK", pattern: /\bnotifications[\s_-]+sdk\b/i },
	{ label: "src/notifications/", pattern: /\bsrc[/\\]notifications(?:[/\\]|\b)/i },
	{ label: "state/notifications", pattern: /\bstate[/\\]notifications(?:[/\\]|\b)/i },
	{ label: "src/sdk.ts", pattern: /\bsrc[/\\]sdk\.ts\b/i },
];

function isAllowed(file: string): boolean {
	return (
		file.startsWith("artifacts/") ||
		file === "REPORT.md" ||
		path.basename(file).toLowerCase() === "changelog.md" ||
		pinnedRollbackFixturePaths.has(file)
	);
}

const filesResult = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
	cwd: repoRoot,
	stdout: "pipe",
	stderr: "pipe",
});
if (filesResult.exitCode !== 0) {
	process.stderr.write(`Unable to list repository files: ${new TextDecoder().decode(filesResult.stderr)}\n`);
	process.exit(2);
}

// Files deleted in the working tree (e.g. staged/unstaged deletions mid-rename)
// are excluded explicitly: they have no content to scan and must not abort the gate.
const deletedResult = Bun.spawnSync(["git", "ls-files", "-z", "--deleted"], {
	cwd: repoRoot,
	stdout: "pipe",
	stderr: "pipe",
});
if (deletedResult.exitCode !== 0) {
	process.stderr.write(`Unable to list deleted files: ${new TextDecoder().decode(deletedResult.stderr)}\n`);
	process.exit(2);
}
const deleted = new Set(new TextDecoder().decode(deletedResult.stdout).split("\0").filter(Boolean));

const files = new TextDecoder()
	.decode(filesResult.stdout)
	.split("\0")
	.filter(file => file.length > 0 && !deleted.has(file));
const violations: string[] = [];
for (const file of files) {
	if (file === scannerPath || isAllowed(file)) continue;
	for (const { label, pattern } of forbidden) {
		if (pattern.test(file)) violations.push(`${file}: forbidden filename ${JSON.stringify(label)}`);
	}

	const filePath = path.join(repoRoot, file);
	let contents: string;
	try {
		contents = await Bun.file(filePath).text();
	} catch (error) {
		process.stderr.write(
			`Unable to scan tracked file ${file}: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exit(2);
	}

	for (const [index, line] of contents.split(/\r?\n/).entries()) {
		for (const { label, pattern } of forbidden) {
			if (pattern.test(line)) violations.push(`${file}:${index + 1}: forbidden ${JSON.stringify(label)}`);
		}
	}
}

if (violations.length > 0) {
	process.stderr.write(`Forbidden pre-rename SDK references found:\n${violations.join("\n")}\n`);
	process.exit(1);
}

process.stdout.write("GJC SDK rename verification passed.\n");
