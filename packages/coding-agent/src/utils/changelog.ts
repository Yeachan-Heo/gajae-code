import { isEnoent, logger } from "@gajae-code/utils";
import CHANGELOG_TEXT from "../../CHANGELOG.md" with { type: "text" };

export interface ChangelogEntry {
	major: number;
	minor: number;
	patch: number;
	content: string;
}

/**
 * Parse changelog entries from a CHANGELOG.md text body.
 * Scans for ## lines and collects content until next ## or EOF.
 * Pure and synchronous so it can be reused by the embedded display path.
 */
export function parseChangelogContent(content: string): ChangelogEntry[] {
	const lines = content.split("\n");
	const entries: ChangelogEntry[] = [];

	let currentLines: string[] = [];
	let currentVersion: { major: number; minor: number; patch: number } | null = null;

	for (const line of lines) {
		// Check if this is a version header (## [x.y.z] ...)
		if (line.startsWith("## ")) {
			// Save previous entry if exists
			if (currentVersion && currentLines.length > 0) {
				entries.push({
					...currentVersion,
					content: currentLines.join("\n").trim(),
				});
			}

			// Try to parse version from this line
			const versionMatch = line.match(/##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/);
			if (versionMatch) {
				currentVersion = {
					major: Number.parseInt(versionMatch[1], 10),
					minor: Number.parseInt(versionMatch[2], 10),
					patch: Number.parseInt(versionMatch[3], 10),
				};
				currentLines = [line];
			} else {
				// Reset if we can't parse version
				currentVersion = null;
				currentLines = [];
			}
		} else if (currentVersion) {
			// Collect lines for current version
			currentLines.push(line);
		}
	}

	// Save last entry
	if (currentVersion && currentLines.length > 0) {
		entries.push({
			...currentVersion,
			content: currentLines.join("\n").trim(),
		});
	}

	return entries;
}

/**
 * Parse changelog entries from a CHANGELOG.md file on disk.
 * Returns [] on ENOENT; logs and returns [] on other read/parse errors.
 */
export async function parseChangelog(changelogPath: string): Promise<ChangelogEntry[]> {
	try {
		const content = await Bun.file(changelogPath).text();
		return parseChangelogContent(content);
	} catch (error) {
		if (isEnoent(error)) {
			return [];
		}
		logger.error(`Warning: Could not parse changelog: ${error}`);
		return [];
	}
}

/**
 * Return changelog entries from the CHANGELOG.md that shipped with this binary.
 *
 * The text is embedded at build time via `with { type: "text" }`, so the
 * displayed changelog is deterministic across compiled binaries, source-tree
 * dev runs, and `GJC_PACKAGE_DIR` / `PI_PACKAGE_DIR` overrides (which scope to
 * optional package assets like docs/examples and do not influence the
 * binary-identity changelog).
 */
export function getDisplayChangelogEntries(): ChangelogEntry[] {
	return parseChangelogContent(CHANGELOG_TEXT);
}

/**
 * Compare versions. Returns: -1 if v1 < v2, 0 if v1 === v2, 1 if v1 > v2
 */
export function compareVersions(v1: ChangelogEntry, v2: ChangelogEntry): number {
	if (v1.major !== v2.major) return v1.major - v2.major;
	if (v1.minor !== v2.minor) return v1.minor - v2.minor;
	return v1.patch - v2.patch;
}

/**
 * Get entries newer than lastVersion
 */
export function getNewEntries(entries: ChangelogEntry[], lastVersion: string): ChangelogEntry[] {
	// Parse lastVersion
	const parts = lastVersion.split(".").map(Number);
	const last: ChangelogEntry = {
		major: parts[0] || 0,
		minor: parts[1] || 0,
		patch: parts[2] || 0,
		content: "",
	};

	return entries.filter(entry => compareVersions(entry, last) > 0);
}

// Re-export getChangelogPath from paths.ts for convenience
export { getChangelogPath } from "../config";
