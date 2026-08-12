import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const PLUGIN_PROVENANCE_SCHEMA = "gjc-plugin-provenance.v1" as const;

export interface PluginProvenance {
	schema: typeof PLUGIN_PROVENANCE_SCHEMA;
	corpus: string;
	upstream: string;
	fork: string;
	commit: string;
	version: string;
	license: "MIT";
	licenseBlobHash: string;
	treeDigest: { version: 1; algorithm: "sha256"; hex: string };
	refresh: string;
}

const SECRET_PATTERN = /(BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-)/;
const TRACKER_PATTERN = /(utm_source=|doubleclick\.net|google-analytics\.com|pixel\.gif)/i;
const BINARY_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "ico", "exe", "dll", "so", "dylib", "bin", "wasm"]);

export function sha256Bytes(bytes: Uint8Array | string): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function neutralizeRemoteBadges(markdown: string): string {
	return markdown.replace(/!\[[^\]]*]\(https?:\/\/[^)]+\)/g, "[badge omitted]");
}

export function assertHermeticPluginSource(root: string): string[] {
	const problems: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const abs = path.join(dir, entry.name);
			if (entry.isSymbolicLink()) {
				problems.push(`symlink: ${path.relative(root, abs)}`);
				continue;
			}
			if (entry.isDirectory()) {
				walk(abs);
				continue;
			}
			if (!entry.isFile()) {
				problems.push(`non-regular: ${path.relative(root, abs)}`);
				continue;
			}
			const rel = path.relative(root, abs);
			const ext = path.extname(entry.name).slice(1).toLowerCase();
			if (BINARY_EXT.has(ext)) {
				problems.push(`binary: ${rel}`);
				continue;
			}
			const mode = fs.statSync(abs).mode;
			if ((mode & 0o111) !== 0) {
				problems.push(`executable: ${rel}`);
			}
			const text = fs.readFileSync(abs, "utf8");
			if (SECRET_PATTERN.test(text)) problems.push(`secret-pattern: ${rel}`);
			if (TRACKER_PATTERN.test(text)) problems.push(`tracker-payload: ${rel}`);
		}
	};
	walk(root);
	return problems;
}

export function computeSourceTreeDigest(root: string): { version: 1; algorithm: "sha256"; hex: string } {
	const hasher = crypto.createHash("sha256");
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const abs = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(abs);
			else if (entry.isFile()) files.push(abs);
		}
	};
	walk(root);
	files.sort();
	for (const abs of files) {
		hasher.update(path.relative(root, abs).replaceAll("\\", "/"));
		hasher.update("\0");
		hasher.update(fs.readFileSync(abs));
		hasher.update("\0");
	}
	return { version: 1, algorithm: "sha256", hex: hasher.digest("hex") };
}

export function buildRustSkillsProvenance(srcRoot: string): PluginProvenance {
	const corpusRoot = path.join(srcRoot, "skills", "rust-skills");
	const licensePath = path.join(corpusRoot, "LICENSE");
	return {
		schema: PLUGIN_PROVENANCE_SCHEMA,
		corpus: "skills/rust-skills",
		upstream: "https://github.com/leonardomso/rust-skills",
		fork: "https://github.com/jason931225/rust-skills",
		commit: "fd2a861ab0406a4ac536a55274d14ea6fd1ca9c9",
		version: "1.5.1",
		license: "MIT",
		licenseBlobHash: sha256Bytes(fs.readFileSync(licensePath)),
		treeDigest: computeSourceTreeDigest(corpusRoot),
		refresh:
			"shallow-clone the fork at the new tip, re-copy SKILL.md + rules/ + LICENSE + README.md into skills/rust-skills, bump commit and version here, then run bun scripts/generate-gjc-plugins.ts",
	};
}
