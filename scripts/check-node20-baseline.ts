#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import type * as fsTypes from "node:fs";
import * as path from "node:path";

export interface BaselineViolation {
	path: string;
	line: number;
	message: string;
	snippet: string;
}

interface WorkflowJob {
	name: string;
	startLine: number;
	lines: string[];
}

const DEFAULT_ROOT = path.join(import.meta.dir, "..");
const NODE20_CLAIM_PATTERNS: RegExp[] = [
	/\bNode(?:\.js)?\s*20\+(?=$|[^A-Za-z0-9])/i,
	/\bNode(?:\.js)?\s*>?=\s*20\b/i,
	/(^|[^A-Za-z0-9-])node20(?=$|[^A-Za-z0-9-])/i,
	/\bnode-version:\s*["']?20(?:["']?\b|\.)/i,
	/"node"\s*:\s*"[^"]*20[^"]*"/i,
	/\bNode(?:\.js)?\s*20\s+(?:or newer|and later|or later|LTS|is required|required)\b/i,
	/\b(?:requires|required|minimum(?:\s+supported)?|baseline)\b[^\n]*\bNode(?:\.js)?(?:\s+v?|\s* v|v)20\b/i,
	/\bNode(?:\.js)?(?:\s+v?|\s* v|v)20\b[^\n]*\b(?:required|minimum|baseline|support(?:ed)?|runtime|release tooling)\b/i,
	/\b(?:supports?|support(?:ed)?\s+runtime|runtime\s+support)\b[^\n]*\bNode(?:\.js)?(?:\s+v?|\s* v|v)20\+?(?=$|[^A-Za-z0-9])/i,
];
const RELEASE_PUBLISH_INDICATOR =
	/\b(release|publish|npm publish|bun publish|ci:release:publish|action-gh-release|upload-artifact)\b/i;
const SETUP_NODE_PATTERN = /uses:\s*["']?actions\/setup-node@/i;
const NODE_VERSION_PATTERN = /node-version:\s*['"]?([^'"\s#}]+)['"]?/i;

function toRepoPath(root: string, filePath: string): string {
	return path.relative(root, filePath).split(path.sep).join("/");
}

function isFixturePath(relativePath: string): boolean {
	return /(^|\/)test\/fixtures\//.test(relativePath) || /(^|\/)tests\/fixtures\//.test(relativePath);
}

function isChangelogPath(relativePath: string): boolean {
	return /(^|\/)CHANGELOG\.md$/i.test(relativePath);
}

function isLiveSurface(relativePath: string): boolean {
	if (relativePath.startsWith(".github/workflows/") && /\.ya?ml$/i.test(relativePath)) return true;
	if (relativePath.startsWith(".github/actions/") && /\.ya?ml$/i.test(relativePath)) return true;
	if (relativePath === "package.json" || relativePath.endsWith("/package.json")) return true;
	if (relativePath === "README.md") return true;
	if (/^packages\/[^/]+\/README\.md$/i.test(relativePath)) return true;
	if (relativePath.startsWith("docs/") && /\.mdx?$/i.test(relativePath)) return true;
	if (isChangelogPath(relativePath)) return true;
	return false;
}

async function collectFiles(root: string, dir = root): Promise<string[]> {
	let entries: fsTypes.Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const files: string[] = [];
	for (const entry of entries) {
		if (entry.name === ".git" || entry.name === "node_modules") continue;
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectFiles(root, fullPath)));
		} else if (entry.isFile()) {
			files.push(fullPath);
		}
	}
	return files;
}

function unreleasedChangelogLines(text: string): Set<number> {
	const selected = new Set<number>();
	const lines = text.split(/\r?\n/);
	let inUnreleased = false;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (/^##\s+\[?Unreleased\]?\b/i.test(line)) {
			inUnreleased = true;
			selected.add(index + 1);
			continue;
		}
		if (inUnreleased && /^##\s+/.test(line)) {
			break;
		}
		if (inUnreleased) selected.add(index + 1);
	}
	return selected;
}

function claimViolations(relativePath: string, text: string): BaselineViolation[] {
	const allowedLines = isChangelogPath(relativePath) ? unreleasedChangelogLines(text) : null;
	const violations: BaselineViolation[] = [];
	const lines = text.split(/\r?\n/);

	for (let index = 0; index < lines.length; index += 1) {
		const lineNumber = index + 1;
		if (allowedLines && !allowedLines.has(lineNumber)) continue;
		const line = lines[index] ?? "";
		if (!NODE20_CLAIM_PATTERNS.some((pattern) => pattern.test(line))) continue;
		violations.push({
			path: relativePath,
			line: lineNumber,
			message: "Live/current surface claims Node 20 as an active runtime baseline; update to Node 24 or remove the claim.",
			snippet: line.trim(),
		});
	}
	return violations;
}

function indentOf(line: string): number {
	return line.match(/^\s*/)?.[0].length ?? 0;
}

function collectWorkflowJobs(text: string): WorkflowJob[] {
	const lines = text.split(/\r?\n/);
	const jobsLineIndex = lines.findIndex((line) => /^\s*jobs:\s*$/.test(line));
	if (jobsLineIndex < 0) return [];

	const jobsIndent = indentOf(lines[jobsLineIndex] ?? "");
	let jobIndent: number | null = null;
	const jobStarts: Array<{ name: string; index: number }> = [];

	for (let index = jobsLineIndex + 1; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (!line.trim()) continue;
		const indent = indentOf(line);
		if (indent <= jobsIndent) break;
		const match = /^(\s*)([A-Za-z0-9_-]+):\s*(?:#.*)?$/.exec(line);
		if (!match?.[2]) continue;
		if (jobIndent === null && indent > jobsIndent) jobIndent = indent;
		if (indent === jobIndent) jobStarts.push({ name: match[2], index });
	}

	return jobStarts.map((job, startIndex) => {
		const next = jobStarts[startIndex + 1];
		const endIndex = next ? next.index : lines.length;
		return {
			name: job.name,
			startLine: job.index + 1,
			lines: lines.slice(job.index, endIndex),
		};
	});
}

function stepStartIndex(lines: string[], setupIndex: number): number {
	for (let index = setupIndex; index >= 0; index -= 1) {
		const line = lines[index] ?? "";
		if (line.trim() && /^-\s/.test(line.trim())) return index;
	}
	return setupIndex;
}

function setupNodeVersion(stepLines: string[], setupIndent: number): string | null {
	let withIndent: number | null = null;
	for (const stepLine of stepLines) {
		const trimmed = stepLine.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const indent = indentOf(stepLine);
		if (withIndent === null) {
			if (indent > setupIndent && /^with:\s*(?:#.*)?$/.test(trimmed)) withIndent = indent;
			continue;
		}
		if (indent <= withIndent) break;
		const match = NODE_VERSION_PATTERN.exec(stepLine);
		if (match?.[1]) return match[1];
	}
	return null;
}

function setupNodeStepViolations(relativePath: string, job: WorkflowJob): BaselineViolation[] {
	const violations: BaselineViolation[] = [];
	for (let index = 0; index < job.lines.length; index += 1) {
		const line = job.lines[index] ?? "";
		if (!SETUP_NODE_PATTERN.test(line)) continue;

		const startIndex = stepStartIndex(job.lines, index);
		const stepIndent = indentOf(job.lines[startIndex] ?? line);
		const stepLines: string[] = [];
		for (let stepIndex = startIndex; stepIndex < job.lines.length; stepIndex += 1) {
			const stepLine = job.lines[stepIndex] ?? "";
			if (stepIndex > startIndex && stepLine.trim() && indentOf(stepLine) <= stepIndent && /^-\s/.test(stepLine.trim())) break;
			stepLines.push(stepLine);
		}

		const nodeVersion = setupNodeVersion(stepLines, stepIndent);
		if (nodeVersion === "24") continue;

		violations.push({
			path: relativePath,
			line: job.startLine + index,
			message: `Release-capable job '${job.name}' uses actions/setup-node but does not pin node-version: "24".`,
			snippet: line.trim(),
		});
	}
	return violations;
}

function workflowViolations(relativePath: string, text: string): BaselineViolation[] {
	const violations: BaselineViolation[] = [];
	for (const job of collectWorkflowJobs(text)) {
		const jobText = job.lines.join("\n");
		const releaseCapable = RELEASE_PUBLISH_INDICATOR.test(job.name) || RELEASE_PUBLISH_INDICATOR.test(jobText);
		if (!releaseCapable || !SETUP_NODE_PATTERN.test(jobText)) continue;

		violations.push(...setupNodeStepViolations(relativePath, job));
	}
	return violations;
}

export async function checkNode20Baseline(root = DEFAULT_ROOT): Promise<BaselineViolation[]> {
	const absoluteRoot = path.resolve(root);
	const files = await collectFiles(absoluteRoot);
	const violations: BaselineViolation[] = [];

	for (const filePath of files) {
		const relativePath = toRepoPath(absoluteRoot, filePath);
		if (isFixturePath(relativePath)) continue;
		if (!isLiveSurface(relativePath)) continue;

		const text = await Bun.file(filePath).text();
		violations.push(...claimViolations(relativePath, text));
		if (relativePath.startsWith(".github/workflows/") && /\.ya?ml$/i.test(relativePath)) {
			violations.push(...workflowViolations(relativePath, text));
		}
	}

	return violations;
}

if (import.meta.main) {
	const root = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_ROOT;
	const violations = await checkNode20Baseline(root);
	if (violations.length === 0) {
		console.log("[OK] Node 20 baseline guard passed.");
		process.exit(0);
	}

	console.error(`[FAIL] Found ${violations.length} Node 20 baseline violation${violations.length === 1 ? "" : "s"}:`);
	for (const violation of violations) {
		console.error(`- ${violation.path}:${violation.line}: ${violation.message}`);
		console.error(`  ${violation.snippet}`);
	}
	process.exit(1);
}
