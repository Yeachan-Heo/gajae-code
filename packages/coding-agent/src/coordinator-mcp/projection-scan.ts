/**
 * Coordinator directory scans that must not treat native exact-unlink debris
 * as live JSON, and must not make start/status unreadable on a large dirent pile.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Post-filter parse-candidate cap. Exhaustion returns a bounded result, never unreadable. */
export const COORDINATOR_JSON_SCAN_CAP = 10_000;

export interface ProjectionScanStat {
	size: number;
	isFile(): boolean;
	isSymbolicLink(): boolean;
}

export interface ProjectionScanFs {
	readdir(dir: string): Promise<string[]>;
	lstat(file: string): Promise<ProjectionScanStat>;
	readFile(file: string, encoding: "utf8"): Promise<string>;
}

export interface ProjectionScanResult {
	values: unknown[];
	parsed: number;
	capped: boolean;
	skippedDebris: number;
	skippedEmpty: number;
}

const defaultFs: ProjectionScanFs = {
	readdir: dir => fs.readdir(dir),
	lstat: file => fs.lstat(file),
	readFile: (file, encoding) => fs.readFile(file, encoding),
};

export function isCoordinatorScanDebrisName(name: string): boolean {
	return name.startsWith(".");
}

export async function listCoordinatorJsonFiles(
	dir: string,
	io: ProjectionScanFs = defaultFs,
	cap: number = COORDINATOR_JSON_SCAN_CAP,
): Promise<ProjectionScanResult> {
	let entries: string[];
	try {
		entries = await io.readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { values: [], parsed: 0, capped: false, skippedDebris: 0, skippedEmpty: 0 };
		}
		throw error;
	}

	let skippedDebris = 0;
	let skippedEmpty = 0;
	const parseCandidates: string[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json") || isCoordinatorScanDebrisName(entry)) {
			if (entry.endsWith(".json") && isCoordinatorScanDebrisName(entry)) skippedDebris += 1;
			continue;
		}
		const file = path.join(dir, entry);
		let stat: ProjectionScanStat;
		try {
			stat = await io.lstat(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) {
			skippedEmpty += 1;
			continue;
		}
		parseCandidates.push(entry);
	}

	const capped = parseCandidates.length > cap;
	const toParse = capped ? parseCandidates.slice(0, cap) : parseCandidates;
	const values: unknown[] = [];
	for (const entry of toParse) {
		const file = path.join(dir, entry);
		let source: string;
		try {
			source = await io.readFile(file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		try {
			values.push(JSON.parse(source));
		} catch (error) {
			throw new Error(
				`invalid coordinator projection ${file}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return {
		values: values.filter(value => value !== null),
		parsed: values.length,
		capped,
		skippedDebris,
		skippedEmpty,
	};
}
