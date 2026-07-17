#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const ignorePath = path.join(repoRoot, "Dockerfile.dockerignore");
const dockerfilePath = path.join(repoRoot, "Dockerfile");
const requiredExclusions = ["assets/", "issues/", ".plans/", "geobench/"];

function stripComment(line: string): string {
	const hash = line.indexOf("#");
	return (hash === -1 ? line : line.slice(0, hash)).trim();
}

function normalizePattern(line: string): string {
	return stripComment(line).replace(/^\/+/, "");
}

function formatBytes(bytes: number): string {
	const units = ["B", "KiB", "MiB", "GiB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function topLevelPatternMatches(pattern: string, entryName: string, isDirectory: boolean): boolean {
	if (!pattern || pattern.startsWith("!")) {
		return false;
	}
	const normalized = pattern.replace(/^\/+/, "");
	if (normalized === `**/${entryName}` || (isDirectory && normalized === `**/${entryName}/`)) {
		return true;
	}
	if (normalized.includes("*")) {
		return false;
	}
	if (normalized.includes("/")) {
		return normalized === `${entryName}/` || normalized === entryName;
	}
	return normalized === entryName || (isDirectory && normalized === `${entryName}/`);
}

async function sizeOfPath(target: string): Promise<number> {
	const stat = await fs.lstat(target);
	if (!stat.isDirectory()) {
		return stat.size;
	}
	let total = 0;
	let entries: string[];
	try {
		entries = await fs.readdir(target);
	} catch {
		return total;
	}
	for (const entry of entries) {
		const child = path.join(target, entry);
		const childStat = await fs.lstat(child);
		if (childStat.isSymbolicLink()) {
			continue;
		}
		total += childStat.isDirectory() ? await sizeOfPath(child) : childStat.size;
	}
	return total;
}

function parseDockerfile(dockerfile: string): { stages: Set<string>; copyFrom: string[] } {
	const logicalLines: string[] = [];
	let pending = "";
	for (const rawLine of dockerfile.split(/\r?\n/)) {
		const line = rawLine.trimEnd();
		if (line.endsWith("\\")) {
			pending += `${line.slice(0, -1)} `;
			continue;
		}
		logicalLines.push(`${pending}${line}`);
		pending = "";
	}
	if (pending) {
		throw new Error("Dockerfile ends with an unterminated line continuation");
	}

	const stages = new Set<string>();
	const copyFrom: string[] = [];
	for (const line of logicalLines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) {
			continue;
		}
		const fromMatch = trimmed.match(/^FROM\s+\S+(?:\s+AS\s+([A-Za-z0-9_.-]+))?$/i);
		if (fromMatch?.[1]) {
			if (stages.has(fromMatch[1])) {
				throw new Error(`Duplicate Dockerfile stage alias: ${fromMatch[1]}`);
			}
			stages.add(fromMatch[1]);
		}
		const copyFromMatch = trimmed.match(/^COPY\s+.*--from=([^\s]+)\s+/i);
		if (copyFromMatch?.[1]) {
			copyFrom.push(copyFromMatch[1]);
		}
	}
	for (const from of copyFrom) {
		if (!stages.has(from) && !from.includes("/") && !from.includes(":")) {
			throw new Error(`COPY --from references unknown local stage: ${from}`);
		}
	}
	return { stages, copyFrom };
}

const [ignoreText, dockerfileText] = await Promise.all([
	fs.readFile(ignorePath, "utf8"),
	fs.readFile(dockerfilePath, "utf8"),
]);
const patterns = ignoreText.split(/\r?\n/).map(normalizePattern).filter(Boolean);
const missing = requiredExclusions.filter((pattern) => !patterns.includes(pattern));
if (missing.length > 0) {
	throw new Error(`Dockerfile.dockerignore is missing required exclusions: ${missing.join(", ")}`);
}

const parsed = parseDockerfile(dockerfileText);
if (!dockerfileText.includes("generate-docs-index")) {
	console.warn("WARN Dockerfile does not run generate-docs-index; reconsider whether docs/ belongs in the context.");
}

const entries = await fs.readdir(repoRoot, { withFileTypes: true });
const contextEntries = [];
for (const entry of entries) {
	const ignored = patterns.some((pattern) => topLevelPatternMatches(pattern, entry.name, entry.isDirectory()));
	if (ignored) {
		continue;
	}
	const bytes = await sizeOfPath(path.join(repoRoot, entry.name));
	contextEntries.push({ name: entry.name, bytes, kind: entry.isDirectory() ? "dir" : "file" });
}
contextEntries.sort((a, b) => b.bytes - a.bytes);
const largeEntries = contextEntries.slice(0, 12);

console.log("PASS Dockerfile.dockerignore required exclusions present:", requiredExclusions.join(", "));
console.log(`PASS Dockerfile structural sanity: ${parsed.stages.size} named stages; COPY --from refs: ${parsed.copyFrom.join(", ") || "none"}`);
console.log("Context top-level entries that would still enter the Docker build context (largest first):");
for (const entry of largeEntries) {
	console.log(`  ${entry.kind.padEnd(4)} ${entry.name.padEnd(36)} ${formatBytes(entry.bytes)}`);
}
