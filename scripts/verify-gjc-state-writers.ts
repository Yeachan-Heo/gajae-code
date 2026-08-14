#!/usr/bin/env bun

/**
 * Inventory / enforcement for the single-sanctioned-writer invariant (gate G1).
 *
 * The locked design requires that EVERY native write to `.gjc/**` flows through one sanctioned
 * writer module. This verifier reports filesystem mutation call sites whose path argument is
 * locally tied to a `.gjc` path literal or a known `.gjc` path helper.
 *
 *   --report  (default)  list every candidate `.gjc/**` write site, exit 0
 *   --fail               exit non-zero unless all candidates are allowlisted
 */

import * as fs from "node:fs";
import * as path from "node:path";

const rootArgIndex = process.argv.indexOf("--root");
const repoRoot = rootArgIndex >= 0 && process.argv[rootArgIndex + 1]
	? path.resolve(process.cwd(), process.argv[rootArgIndex + 1])
	: path.join(import.meta.dir, "..");
const SCAN_ROOT = path.join(repoRoot, "packages", "coding-agent", "src");

// The one module allowed to perform raw `.gjc/**` filesystem mutations once routing is complete.
const ALLOWED_WRITER_RELATIVE = path.join("packages", "coding-agent", "src", "gjc-runtime", "state-writer.ts");

// Remaining intentional non-writer direct operations: empty mailbox directory creation and legacy
// session-directory lifecycle moves/removes. These do not write state file contents.
const KNOWN_ALLOWED_SITES = new Set<string>([
	"packages/coding-agent/src/gjc-runtime/team-runtime.ts:1610:fs.mkdir",
	"packages/coding-agent/src/gjc-runtime/team-runtime.ts:1612:fs.mkdir",
	"packages/coding-agent/src/gjc-runtime/team-runtime.ts:1623:fs.mkdir",
	"packages/coding-agent/src/session/session-manager.ts:399:renameSync",
	"packages/coding-agent/src/session/session-manager.ts:402:rmSync",
	"packages/coding-agent/src/session/session-manager.ts:406:rmSync",
	"packages/coding-agent/src/session/session-manager.ts:408:renameSync",
]);

// Filesystem-mutation APIs we treat as candidate writers.
const MUTATION_API_PATTERNS: readonly RegExp[] = [
	/\bfs(?:\/promises)?\.(?:writeFile|appendFile|mkdir|rm|rmdir|unlink|rename|cp|copyFile|open)\s*\(/u,
	/\b[A-Za-z_$][\w$]*\.promises\.(?:writeFile|appendFile|mkdir|rm|rmdir|unlink|rename|cp|copyFile|open)\s*\(/u,
	/\bfsp?\.(?:writeFile|appendFile|mkdir|rm|rmdir|unlink|rename|cp|copyFile|open)\s*\(/u,
	/\bwriteFileSync\s*\(|\bappendFileSync\s*\(|\bmkdirSync\s*\(|\brmSync\s*\(|\bunlinkSync\s*\(|\brenameSync\s*\(/u,
	/\bBun\.write\s*\(/u,
	/\bcreateWriteStream\s*\(/u,
];

const MUTATION_EXPORTS = new Set([
	"appendFile",
	"appendFileSync",
	"copyFile",
	"cp",
	"createWriteStream",
	"mkdir",
	"mkdirSync",
	"open",
	"rename",
	"renameSync",
	"rm",
	"rmSync",
	"rmdir",
	"unlink",
	"unlinkSync",
	"writeFile",
	"writeFileSync",
]);

// `.gjc` is referenced directly, or via a known path-helper symbol that resolves under `.gjc`.
const GJC_REFERENCE_PATTERNS: readonly RegExp[] = [
	/["'`]\.gjc(?:[\\/]|["'`])/u,
	/\bstateDirFor\b/u,
	/\bmodeStateFile\b/u,
	/\bworkflowStateStoragePath\b/u,
	/\bresolveGjcTeamStateRoot\b/u,
	/\bdeepInterviewStatePath\b/u,
	/\bspecsDir\b/u,
	/\brunDir\b/u,
	/\bledgerPath\b/u,
	/\bgoalsPath\b/u,
	/\bbriefPath\b/u,
	/\bintegrationReportPath\b/u,
	/\bbreadcrumbFile\b/u,
	/\bhandoffFilePath\b/u,
	/\bgetUltragoalPaths\b/u,
];

interface Finding {
	file: string;
	line: number;
	api: string;
	text: string;
	allowed: boolean;
	knownAllowed: boolean;
}

function listTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "__snapshots__") continue;
			out.push(...listTsFiles(full));
		} else if (/\.(?:[cm]?[jt]s|tsx)$/u.test(entry.name) && !/\.test\.(?:[cm]?[jt]s|tsx)$/u.test(entry.name) && !/\.d\.ts$/u.test(entry.name)) {
			out.push(full);
		}
	}
	return out;
}

function importedMutationAliases(content: string): Set<string> {
	const aliases = new Set<string>();
	for (const match of content.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']node:fs(?:\/promises)?["']/gu)) {
		for (const raw of match[1]!.split(",")) {
			const binding = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/u.exec(raw);
			if (binding && MUTATION_EXPORTS.has(binding[1]!)) aliases.add(binding[2] ?? binding[1]!);
		}
	}
	return aliases;
}

function importedFsNamespaces(content: string): Set<string> {
	const aliases = new Set<string>();
	for (const match of content.matchAll(/import\s*\*\s*as\s*([A-Za-z_$][\w$]*)\s*from\s*["']node:fs(?:\/promises)?["']/gu)) {
		aliases.add(match[1]!);
	}
	return aliases;
}

function dynamicMutationBindings(content: string): { aliases: Set<string>; namespaces: Set<string> } {
	const aliases = new Set<string>();
	const namespaces = new Set<string>();
	for (const match of content.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+import\(\s*["']node:fs(?:\/promises)?["']\s*\)/gu)) {
		namespaces.add(match[1]!);
	}
	for (const match of content.matchAll(/(?:const|let|var)\s*\{([^}]+)\}\s*=\s*await\s+import\(\s*["']node:fs(?:\/promises)?["']\s*\)/gu)) {
		for (const raw of match[1]!.split(",")) {
			const binding = /^\s*([A-Za-z_$][\w$]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?\s*$/u.exec(raw);
			if (binding && MUTATION_EXPORTS.has(binding[1]!)) aliases.add(binding[2] ?? binding[1]!);
		}
	}
	for (const match of content.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*Bun\.write\b/gu)) aliases.add(match[1]!);
	const namespaceNames = new Set([...importedFsNamespaces(content), ...namespaces]);
	for (const namespace of namespaceNames) {
		const member = `(?:${[...MUTATION_EXPORTS].join("|")})`;
		for (const match of content.matchAll(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${namespace}(?:\\.promises)?(?:\\.${member}\\b|\\[['\"]${member}['\"]\\])`, "gu"))) {
			aliases.add(match[1]!);
		}
	}
	return { aliases, namespaces };
}

function matchedApi(line: string, aliases: ReadonlySet<string>, namespaces: ReadonlySet<string>): string | null {
	for (const re of MUTATION_API_PATTERNS) {
		const m = re.exec(line);
		if (m) return m[0].replace(/\s*\($/u, "");
	}
	for (const alias of aliases) {
		if (new RegExp(`\\b${alias}\\s*\\(`, "u").test(line)) return alias;
	}
	for (const namespace of namespaces) {
		const member = "(?:writeFile|appendFile|mkdir|rm|rmdir|unlink|rename|cp|copyFile|open|createWriteStream)";
		const match = new RegExp(`\\b${namespace}(?:\\.promises)?(?:\\.${member}|\\[['\"]${member}['\"]\\])\\s*\\(`, "u").exec(line);
		if (match) return match[0].replace(/\s*\($/u, "");
	}
	return null;
}

function lineLooksLikeGeneratedStringLiteral(line: string): boolean {
	return /^["'`][^"'`]+["'`]\s*:/u.test(line.trim());
}

function nearbyAssignmentTargetsThisLine(lines: readonly string[], index: number): boolean {
	const line = lines[index]?.trim() ?? "";
	const start = Math.max(0, index - 25);
	for (let i = start; i < index; i++) {
		const prior = lines[i]?.trim() ?? "";
		if (!sameLineReferencesGjc(prior)) continue;
		const assignment = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/u.exec(prior);
		if (assignment && new RegExp(`\\b${assignment[1]}\\b`, "u").test(line)) return true;
	}
	return false;
}

function sameLineReferencesGjc(line: string): boolean {
	if (GJC_REFERENCE_PATTERNS.some(re => re.test(line))) return true;
	if (lineLooksLikeGeneratedStringLiteral(line)) return false;
	const stringParts = [...line.matchAll(/["'`]([^"'`]*)["'`]/gu)].map(match => match[1]!).join("");
	return /(?:^|[\\/])?\.gjc(?:[\\/]|$)/u.test(stringParts);
}


function isGuardedOutsideProjectGjcFallback(lines: readonly string[], index: number): boolean {
	const start = Math.max(0, index - 8);
	const context = lines.slice(start, index + 1).join("\n");
	return /isUnderProjectGjc\([\s\S]*?\}\s*else\s*\{[\s\S]*$/u.test(context);
}

function isGuardedOutsideProjectGjcTernaryFallback(lines: readonly string[], index: number): boolean {
	const start = Math.max(0, index - 6);
	const context = lines.slice(start, index + 1).join("\n");
	return /isUnderProjectGjc\([\s\S]*?\?[\s\S]*?:\s*[^\n]*$/u.test(context);
}


function collectFindings(): Finding[] {
	const findings: Finding[] = [];
	for (const file of listTsFiles(SCAN_ROOT)) {
		const content = fs.readFileSync(file, "utf8");
		const mutationAliases = importedMutationAliases(content);
		const fsNamespaces = importedFsNamespaces(content);
		const dynamicBindings = dynamicMutationBindings(content);
		for (const alias of dynamicBindings.aliases) mutationAliases.add(alias);
		for (const namespace of dynamicBindings.namespaces) fsNamespaces.add(namespace);
		const relative = path.relative(repoRoot, file);
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const raw = lines[i];
			const line = raw.trim();
			if (line.startsWith("//") || line.startsWith("*")) continue;
			const api = matchedApi(line, mutationAliases, fsNamespaces);
			if (!api) continue;
			const knownAllowed = KNOWN_ALLOWED_SITES.has(`${relative}:${i + 1}:${api}`);
			const allowed = relative === ALLOWED_WRITER_RELATIVE || knownAllowed;
			if (!allowed && !sameLineReferencesGjc(line) && !nearbyAssignmentTargetsThisLine(lines, i)) continue;
			if (!allowed && (isGuardedOutsideProjectGjcFallback(lines, i) || isGuardedOutsideProjectGjcTernaryFallback(lines, i))) continue;
			findings.push({ file: relative, line: i + 1, api, text: line.slice(0, 160), allowed, knownAllowed });
		}
	}
	return findings;
}

function main(): void {
	const argv = process.argv.slice(2);
	const failMode = argv.includes("--fail");
	const findings = collectFindings();

	const byFile = new Map<string, Finding[]>();
	for (const f of findings) {
		const list = byFile.get(f.file) ?? [];
		list.push(f);
		byFile.set(f.file, list);
	}

	const offending = findings.filter(f => !f.allowed);

	console.log(`gjc .gjc/** writer inventory - scanned ${path.relative(repoRoot, SCAN_ROOT)}`);
	console.log(`Found ${findings.length} candidate write site(s) across ${byFile.size} file(s).`);
	console.log(`Allowlisted sanctioned writer: ${ALLOWED_WRITER_RELATIVE}`);
	console.log(`Known-allowed non-writer sites: ${KNOWN_ALLOWED_SITES.size}\n`);

	for (const [file, list] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		const tag = list.every(f => f.file === ALLOWED_WRITER_RELATIVE)
			? "OK"
			: list.every(f => f.allowed)
				? "KNOWN-ALLOWED"
				: "ROUTE";
		console.log(`[${tag}] ${file}  (${list.length} site(s))`);
		for (const f of list) {
			const suffix = f.knownAllowed ? "  KNOWN-ALLOWED" : "";
			console.log(`    ${f.line}: ${f.api}  ${f.text}${suffix}`);
		}
	}

	console.log(`\nSummary: ${offending.length} write site(s) outside the sanctioned writer / known allowlist.`);

	if (failMode && offending.length > 0) {
		console.error(`\nG1 FAIL: ${offending.length} direct .gjc/** write site(s) must route through ${ALLOWED_WRITER_RELATIVE}.`);
		process.exit(1);
	}
}

main();
