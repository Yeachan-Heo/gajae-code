import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	applyRedactions,
	asOriginalText,
	findPrivateKeySpans,
	type OriginalText,
	type RedactedText,
} from "../src/crash-redaction";

/**
 * The only place a plain string may become `OriginalText` is `asOriginalText` in
 * `src/crash-redaction.ts`. Any other cast would launder redacted output back into detection.
 */
const CAST_HELPER = path.resolve(import.meta.dir, "../src/crash-redaction.ts");
const THIS_TEST = path.resolve(import.meta.dir, "crash-redaction-brand.test.ts");
const SCANNED_ROOTS = [path.resolve(import.meta.dir, "../../..")].map(root => path.join(root, "packages"));
const SCANNED_SCRIPT_ROOT = path.resolve(import.meta.dir, "../../../scripts");
const CAST_PATTERNS = [/\bas\s+OriginalText\b/, /\bas\s+unknown\s+as\s+OriginalText\b/, /<OriginalText>/];

function collectTypeScriptFiles(directory: string, out: string[]): void {
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
		const fullPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			collectTypeScriptFiles(fullPath, out);
			continue;
		}
		if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name)) out.push(fullPath);
	}
}

describe("crash-redaction brand boundary", () => {
	it("does not accept redacted text at a detection boundary", () => {
		const redacted: RedactedText = applyRedactions(asOriginalText("plain diagnostic"), []);
		// @ts-expect-error a RedactedText is not an OriginalText: a rule cannot re-read masked output.
		findPrivateKeySpans(redacted);
		// @ts-expect-error RedactedText is not assignable to OriginalText either.
		const replayed: OriginalText = redacted;
		expect<string>(replayed).toBe(redacted);
	});

	it("has exactly one cast helper for OriginalText", () => {
		const files: string[] = [];
		for (const root of [...SCANNED_ROOTS, SCANNED_SCRIPT_ROOT]) {
			if (fs.existsSync(root)) collectTypeScriptFiles(root, files);
		}
		const violations: string[] = [];
		for (const file of files) {
			if (file === CAST_HELPER || file === THIS_TEST) continue;
			const source = fs.readFileSync(file, "utf8");
			for (const pattern of CAST_PATTERNS) {
				if (pattern.test(source)) violations.push(`${path.relative(process.cwd(), file)} matches ${pattern}`);
			}
		}
		expect(violations).toEqual([]);
	});
});
