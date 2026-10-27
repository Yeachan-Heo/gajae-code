#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import { sanitizeDisplayLine } from "../packages/utils/src/sanitize-text";

// Discussion #6286, Phase 0. These are review signals, never deletion verdicts.
// Only Git-tracked .ts/.tsx files under packages/ and scripts/ are counted.
// Counts describe lexical occurrences (including comments), not executed tests.
const signals = {
	sourceTextStrict: "cat 1: source read + text assertion (heuristic)",
	sourceTextBroad: "cat 1: file read + src/ mention (broad heuristic)",
	issueNamed: "cat 2: issue-numbered filename (not proof of duplication)",
	sleeps: "cat 7: sleep/setTimeout calls",
	longLiterals: "cat 5: assertion string literals >=60 characters",
	negatives: "cat 6: .not assertions (not proof of redundancy)",
	skips: "cat 8: .skip/.todo calls (ownership not inferred)",
	giants: "Phase 4: test files >=3000 lines",
} as const;

type Signal = keyof typeof signals;
interface FileCount {
	file: string;
	count: number;
}
interface PackageInventory {
	package: string;
	testFiles: number;
	testCases: number;
	testLines: number;
	sourceLines: number;
	categories: Record<Signal, FileCount[]>;
}

function occurrences(text: string, pattern: RegExp): number {
	return [...text.matchAll(pattern)].length;
}

function lines(text: string): number {
	if (text.length === 0) return 0;
	return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function emptyPackage(name: string): PackageInventory {
	return {
		package: name,
		testFiles: 0,
		testCases: 0,
		testLines: 0,
		sourceLines: 0,
		categories: {
			sourceTextStrict: [],
			sourceTextBroad: [],
			issueNamed: [],
			sleeps: [],
			longLiterals: [],
			negatives: [],
			skips: [],
			giants: [],
		},
	};
}

function classify(file: string, text: string): Record<Signal, number> {
	const readsFile = /\b(?:readFileSync|readFile|Bun\.file)\s*\(/.test(text);
	const mentionsSource = /\bsrc\//.test(text);
	// Deliberately conservative name: "strict" still co-occurs at file scope;
	// it does not establish data flow from the source read to the assertion.
	const sourceRead = /(?:readFileSync|readFile|Bun\.file)\s*\([^;\n]*["'`][^"'`\n]*src\/[^"'`\n]*\.tsx?["'`]/.test(
		text,
	);
	const textAssertion = /\.(?:toContain|toInclude|toMatch)(?:Equal|Object)?\s*\(/.test(text);
	return {
		sourceTextStrict: Number(sourceRead && textAssertion),
		sourceTextBroad: Number(readsFile && mentionsSource),
		issueNamed: Number(/(?:^|[/-])issue-\d+(?:[-.]|$)/.test(file)),
		sleeps: occurrences(text, /\b(?:Bun\.sleep|setTimeout|sleep)\s*\(/g),
		longLiterals: occurrences(
			text,
			/\.(?:to\w+)\s*\(\s*(?:"(?:\\.|[^"\\\n]){60,}"|'(?:\\.|[^'\\\n]){60,}'|`(?:\\.|[^`\\]){60,}`)/g,
		),
		negatives: occurrences(text, /\.not\s*\.\s*to\w+\s*\(/g),
		skips: occurrences(text, /\b(?:it|test|describe)\.(?:skip|todo)\s*\(/g),
		giants: Number(lines(text) >= 3000),
	};
}

async function inventory(root: string): Promise<PackageInventory[]> {
	const tracked = await $`git -C ${root} ls-files -z -- packages scripts`.quiet().text();
	const files = tracked
		.split("\0")
		.filter(file => /\.tsx?$/.test(file))
		.sort();
	const packages = new Map<string, PackageInventory>();
	for (const file of files) {
		const name = file.startsWith("packages/") ? file.split("/")[1] : "scripts";
		let item = packages.get(name);
		if (!item) {
			item = emptyPackage(name);
			packages.set(name, item);
		}
		const isTest = /\.test\.tsx?$/.test(file);
		if (!isTest && !file.includes("/src/")) continue;
		const filePath = path.join(root, file);
		if (!(await fs.lstat(filePath)).isFile()) {
			throw new Error(`Expected a regular tracked file: ${sanitizeDisplayLine(file).replaceAll("\t", " ")}`);
		}
		const text = await Bun.file(filePath).text();
		if (!isTest) {
			item.sourceLines += lines(text);
			continue;
		}
		item.testFiles++;
		item.testLines += lines(text);
		item.testCases += occurrences(text, /\b(?:it|test)(?:\.(?:only|skip|todo|concurrent|failing))*\s*\(/g);
		const counts = classify(file, text);
		for (const signal of Object.keys(signals) as Signal[]) {
			if (counts[signal] > 0) item.categories[signal].push({ file, count: counts[signal] });
		}
	}
	return [...packages.values()].sort((a, b) => a.package.localeCompare(b.package));
}

async function main(): Promise<void> {
	let root = path.resolve(import.meta.dir, "..");
	let json = false;
	const args = process.argv.slice(2);
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--json") json = true;
		else if (args[i] === "--root" && args[i + 1] && !args[i + 1].startsWith("--")) root = path.resolve(args[++i]);
		else throw new Error("Usage: bun scripts/test-slop-inventory.ts [--json] [--root <git-worktree>]");
	}
	const packages = await inventory(root);
	const notes = [
		"Reporting only; no thresholds, CI gate, or deletion verdicts. Categories overlap.",
		"Scope: Git-tracked packages/ and scripts/ .ts/.tsx working-tree contents; stage additions AND deletions before measurement.",
		"Requires a stable, fully materialized checkout of regular files, not a sparse checkout or symlinked inputs.",
		"Test files end in .test.ts/.test.tsx. Source LOC: non-test files under src/ (including generated/declaration files).",
		"All counts are lexical heuristics, may include comments/strings, and do not count executed parameterized cases.",
		"Strict source-text means a source-path read and a text matcher co-occur in a file, not proven data flow.",
		"Categories 2/6 need duplicate/behavior review; categories 3/4 and stale APIs require manual review (not measured).",
		"Long literals measure direct matcher string arguments only; skips do not infer owners/issues; filenames do not justify deletion.",
		"Summary signals count affected files except Not asserts, which counts occurrences. File lists retain occurrence counts.",
	];
	if (json) {
		console.log(JSON.stringify({ notes, signals, packages }, null, 2));
		return;
	}
	console.log(notes.join("\n"));
	console.log(
		"\nPackage\tTest files\tTest cases~\tTest LOC\tSource LOC\tStrict files\tBroad files\tIssue files\tSleep files\tLong files\tNot asserts\tSkip files\tGiant files",
	);
	for (const item of packages) {
		const counts = (Object.keys(signals) as Signal[]).map(signal =>
			signal === "negatives"
				? item.categories[signal].reduce((sum, row) => sum + row.count, 0)
				: item.categories[signal].length,
		);
		console.log(
			[
				sanitizeDisplayLine(item.package).replaceAll("\t", " "),
				item.testFiles,
				item.testCases,
				item.testLines,
				item.sourceLines,
				...counts,
			].join("\t"),
		);
	}
	for (const item of packages) {
		for (const signal of Object.keys(signals) as Signal[]) {
			const rows = item.categories[signal];
			console.log(
				`\n${sanitizeDisplayLine(item.package).replaceAll("\t", " ")} — ${signals[signal]}: ${rows.length} files`,
			);
			for (const row of rows) console.log(`  ${sanitizeDisplayLine(row.file).replaceAll("\t", " ")}\t${row.count}`);
		}
	}
}

if (import.meta.main) await main();
