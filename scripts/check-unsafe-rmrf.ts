#!/usr/bin/env bun
/**
 * Static guard for issue #4794: repository test code must not combine HOME-seam
 * mutation (`process.env.HOME = …` / `vi.spyOn(os, "homedir")`) with raw
 * recursive removals (`fs.rm*`/`fs.rmdir*` with `recursive: true`, or a real
 * shell force-recursive `rm` invocation). That combination is exactly how an
 * operator's real home was destroyed: a cleanup path that deletes a variable
 * bug (or a lazily-captured consumer) resolved back to the real home.
 *
 * Files that need both must route deletions through the fail-closed contract
 * (`safeRm`/`safeRmSync` from `scripts/safe-cleanup.ts`) or the
 * `withTempHome()`/`temp-home-cleanup` helpers. The runtime guard in
 * `scripts/test-preload.ts` cannot intercept ESM top-level `fs.rmSync`
 * bindings in Bun 1.4.0, so this check is the deterministic enforcement layer
 * for repository source.
 *
 * Deliberate raw recursive removals inside test INPUT fixtures live under
 * `test-fixtures/` directories and are excluded: fixtures are data exercised
 * by tests, not test cleanup code.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface UnsafeRemovalViolation {
	path: string;
	line: number;
	snippet: string;
	message: string;
}

export interface UnsafeRemovalFile {
	/** Repository-relative path, used for reporting. */
	path: string;
	text: string;
}

const HOME_SEAM_PATTERN = /process\.env\.HOME\s*=|vi\.spyOn\(os,\s*["']homedir["']/;
const RM_CALL_PATTERN = /\.(rmSync|rmdirSync|rm|rmdir)\s*\(/g;
// A real shell force-recursive rm invocation: either a Bun-shell tagged
// template containing `rm` with recursive+force flags, or a spawn-style
// string array whose command element is `rm` followed by recursive+force
// flags. Bare strings on their own line (blocked-command fixtures) are not
// invocations.
const SHELL_TEMPLATE_RM_PATTERN = /\$`[^`]*\brm\s+(-[A-Za-z]*r[A-Za-z]*f|-[A-Za-z]*f[A-Za-z]*r)/g;
const SHELL_ARRAY_RM_PATTERN = /["'`]rm["'`]\s*,\s*["'`]-[A-Za-z]*r[A-Za-z]*f/g;
const RECURSIVE_WINDOW = 400;
const SCAN_ROOTS = ["packages", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "fixtures", "test-fixtures", "dist", "native", ".git"]);
// The scanner's own test file is fixture data by construction — it embeds the
// exact patterns the scanner must flag. The exemption does not weaken
// coverage of real test code.
const EXEMPT_FILES = new Set(["scripts/check-unsafe-rmrf.test.ts"]);
export function isFixturePath(relativePath: string): boolean {
	return /(^|\/)(test-)?fixtures\//.test(relativePath);
}

export function scanUnsafeRecursiveRemovals(files: readonly UnsafeRemovalFile[]): UnsafeRemovalViolation[] {
	const violations: UnsafeRemovalViolation[] = [];
	for (const file of files) {
		if (isFixturePath(file.path) || EXEMPT_FILES.has(file.path)) continue;
		if (!file.text.match(HOME_SEAM_PATTERN)) continue;
		const lines = file.text.split("\n");
		for (const match of file.text.matchAll(RM_CALL_PATTERN)) {
			const call = match[1];
			const start = match.index ?? 0;
			const window = file.text.slice(start, start + RECURSIVE_WINDOW);
			if (!/recursive\s*:\s*true/.test(window)) continue;
			const line = file.text.slice(0, start).split("\n").length;
			violations.push({
				path: file.path,
				line,
				snippet: lines[line - 1]?.trim() ?? "",
				message: `${file.path}:${line}: raw recursive removal \`.${call}(…, { recursive: true … })\` in a HOME-seam test file — use safeRm/safeRmSync from scripts/safe-cleanup.ts (or the temp-home helpers) instead`,
			});
		}
		for (const shellMatch of [
			...file.text.matchAll(SHELL_TEMPLATE_RM_PATTERN),
			...file.text.matchAll(SHELL_ARRAY_RM_PATTERN),
		]) {
			const start = shellMatch.index ?? 0;
			const line = file.text.slice(0, start).split("\n").length;
			violations.push({
				path: file.path,
				line,
				snippet: lines[line - 1]?.trim() ?? "",
				message: `${file.path}:${line}: shell force-recursive rm in a HOME-seam test file — route deletion through the safe-cleanup contract`,
			});
		}
	}
	return violations;
}

async function collectFiles(root: string, dir = root, out: string[] = []): Promise<string[]> {
	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			await collectFiles(root, fullPath, out);
		} else if (entry.isFile() && entry.name.endsWith(".ts")) {
			out.push(fullPath);
		}
	}
	return out;
}

export async function scanRepository(root: string): Promise<UnsafeRemovalViolation[]> {
	const files: UnsafeRemovalFile[] = [];
	for (const scanRoot of SCAN_ROOTS) {
		const base = path.join(root, scanRoot);
		for (const filePath of await collectFiles(base)) {
			files.push({
				path: path.relative(root, filePath).split(path.sep).join("/"),
				text: await fs.readFile(filePath, "utf8"),
			});
		}
	}
	return scanUnsafeRecursiveRemovals(files);
}

async function main(): Promise<void> {
	const root = path.join(import.meta.dir, "..");
	const violations = await scanRepository(root);
	if (violations.length > 0) {
		for (const violation of violations) {
			process.stderr.write(`${violation.message}\n    ${violation.snippet}\n`);
		}
		process.stderr.write(
			`\ncheck-unsafe-rmrf: ${violations.length} unsafe recursive removal(s) in HOME-seam test files (issue #4794)\n`,
		);
		process.exit(1);
	}
	console.log("check-unsafe-rmrf: no raw recursive removals in HOME-seam test files");
}

if (import.meta.main) await main();
