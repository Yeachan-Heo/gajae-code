#!/usr/bin/env bun

/**
 * G4 verifier for bundled GJC skill documentation.
 *
 *   --report  (default)  list command references and direct `.gjc` shell mutations, exit 0
 *   --fail               exit non-zero on manifest drift or direct `.gjc` shell mutations
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { listVerbs } from "../packages/coding-agent/src/gjc-runtime/workflow-manifest";
import { CANONICAL_GJC_WORKFLOW_SKILLS, type CanonicalGjcWorkflowSkill } from "../packages/coding-agent/src/skill-state/canonical-skills";
import { SDK_SESSION_CLI_VERBS, SDK_SESSION_RAW_KINDS } from "./generate-gjc-plugins";

const repoRoot = path.join(import.meta.dir, "..");
const skillsRoot = path.join(repoRoot, "packages", "coding-agent", "src", "defaults", "gjc", "skills");
const skills = new Set<string>(CANONICAL_GJC_WORKFLOW_SKILLS);

type AdvisorySkill = "gjc-sdk-session" | "gjc-sdk-guides";
type DocumentedSkill = CanonicalGjcWorkflowSkill | AdvisorySkill;

interface CommandRef {
	file: string;
	line: number;
	skill: DocumentedSkill;
	verb: string;
	command: string;
	valid: boolean;
}

interface MutationRef {
	file: string;
	line: number;
	text: string;
}

function isSkill(value: string): value is CanonicalGjcWorkflowSkill {
	return skills.has(value);
}

function stripInlineCode(line: string): string {
	return line.replace(/`[^`]*`/gu, "");
}

function isRoleSelectorVerb(line: string, commandEndIndex: number): boolean {
	return line.slice(0, commandEndIndex).endsWith("gjc team executor") && /\bgjc\s+team\s+executor\s+["'`]/u.test(line);
}

/** Generated advisory plugin skills rendered by `scripts/generate-gjc-plugins.ts`. */
const ADVISORY_SKILLS = new Set<string>([
	"gjc-sdk-session",
	"gjc-sdk-guides",
]);
const ADVISORY_SKILL_DIRS = [
	"gjc-sdk-session",
	"gjc-sdk-guides",
];

const FORBIDDEN_DAEMON_SESSION_ROUTE = /\bgjc\s+daemon\s+session\b/gu;
// Credential material: an embedded secret-shaped value (a token/secret/password
// field or header carrying a non-trivial value) or an instruction that reveals
// one. Prose statements that the CLI is credential-free are allowed.
const FORBIDDEN_CREDENTIAL_VALUE =
	/(?:\b(?:token|secret|password|api[_-]?key|credential)\b\s*[:=]\s*(?:"[^"]{4,}"|'[^']{4,}'|\S{6,}))|\b(?:print|render|echo|output|display|show)\s+the\s+(?:endpoint|session)\s+credential\b/giu;
const FORBIDDEN_MUTATION_CMD =
	/\b(?:gjc\s+config\b|gjc\s+settings\b|gjc\s+setup\b|gjc\s+gc\b|gjc\s+plugin\s+(?:install|remove|enable|disable)\b|gjc\s+notify\s+setup\b|gjc\s+update\b)/gu;
const FORBIDDEN_GUIDE_EXECUTION =
	/\b(?:run|execute|invoke|start|launch|dispatch|run\s+through|work\s+through)\s+(?:the\s+)?(?:advisory\s+)?(?:guide|guide\s+skills?|gjc-sdk-guides?)\b/giu;

function collectSdkSessionVerbRefs(file: string, content: string): CommandRef[] {
	const refs: CommandRef[] = [];
	const relative = path.relative(repoRoot, file);
	const lines = content.split("\n");
	const verbs = SDK_SESSION_CLI_VERBS.join("|");
	const commandPattern = new RegExp(`\\bgjc\\s+sdk\\s+session\\s+(${verbs})\\s*([a-z][a-z0-9-]*)?\\b`, "gu");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		for (const match of line.matchAll(commandPattern)) {
			const verb = match[1] ?? "";
			const target = match[2] ?? "";
			const command = match[0];
			const valid = SDK_SESSION_CLI_VERBS.includes(verb as (typeof SDK_SESSION_CLI_VERBS)[number]);
			if (!valid) continue;
			const kindValid =
				verb !== "raw" ||
				target === "" ||
				(SDK_SESSION_RAW_KINDS as readonly string[]).includes(target);
			refs.push({
				file: relative,
				line: i + 1,
				skill: "gjc-sdk-session",
				verb: target !== "" && verb === "raw" ? `raw ${target}` : verb,
				command,
				valid,
			});
			if (!kindValid) {
				refs.push({
					file: relative,
					line: i + 1,
					skill: "gjc-sdk-session",
					verb: `raw ${target}`,
					command,
					valid: false,
				});
			}
		}
	}
	return refs;
}

function collectSdkSkillContentGates(file: string, content: string): string[] {
	const violations: string[] = [];
	const relative = path.relative(repoRoot, file);
	if (FORBIDDEN_DAEMON_SESSION_ROUTE.test(content))
		violations.push(`${relative}: references the removed \`gjc daemon session\` route`);
	for (const match of content.matchAll(FORBIDDEN_CREDENTIAL_VALUE)) {
		violations.push(`${relative}:${lineOf(content, match.index ?? 0)}: embeds or reveals a secret-shaped value (${match[0].slice(0, 80)})`);
	}
	for (const match of content.matchAll(FORBIDDEN_MUTATION_CMD)) {
		violations.push(
			`${relative}:${lineOf(content, match.index ?? 0)}: references configuration or state mutation automation (${match[0]})`,
		);
	}
	for (const match of content.matchAll(FORBIDDEN_GUIDE_EXECUTION)) {
		violations.push(
			`${relative}:${lineOf(content, match.index ?? 0)}: contains guide execution language (${match[0]})`,
		);
	}
	return violations;
}

function lineOf(content: string, offset: number): number {
	return content.slice(0, offset).split(/\r?\n/).length;
}

function collectCommandRefs(file: string, content: string): CommandRef[] {
	const refs: CommandRef[] = [];
	const relative = path.relative(repoRoot, file);
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const commandPattern = /\bgjc\s+(?:state\s+)?(deep-interview|ralplan|ultragoal|team)\s+([a-z][a-z0-9-]*)\b/gu;
		for (const match of line.matchAll(commandPattern)) {
			const skill = match[1];
			if (!isSkill(skill)) continue;
			const verb = match[2] ?? "";
			const command = match[0];
			if (isRoleSelectorVerb(line, (match.index ?? 0) + command.length)) continue;
			const valid = listVerbs(skill).includes(verb);
			refs.push({ file: relative, line: i + 1, skill, verb, command, valid });
		}
	}
	return refs;
}

function collectDirectGjcMutations(file: string, content: string): MutationRef[] {
	const refs: MutationRef[] = [];
	const relative = path.relative(repoRoot, file);
	const lines = content.split("\n");
	const mutationPattern = /(?:^|[;&|]\s*)(?:rm\s+(?:-[A-Za-z]*\s+)*|rmdir\s+|mkdir\s+(?:-[A-Za-z]*\s+)*|touch\s+|mv\s+|cp\s+|install\s+|tee\s+(?:-[A-Za-z]*\s+)*|printf\b[^|;>]*>|echo\b[^|;>]*>|cat\b[^|;>]*>|>+\s*)\.?\.gjc(?:\b|\/)/u;
	for (let i = 0; i < lines.length; i++) {
		const line = stripInlineCode(lines[i] ?? "");
		if (mutationPattern.test(line)) {
			refs.push({ file: relative, line: i + 1, text: (lines[i] ?? "").trim().slice(0, 180) });
		}
	}
	return refs;
}

function main(): void {
	const argv = process.argv.slice(2);
	const failMode = argv.includes("--fail");
	const commandRefs: CommandRef[] = [];
	const mutationRefs: MutationRef[] = [];
	const advisoryContentGates: string[] = [];

	for (const skill of CANONICAL_GJC_WORKFLOW_SKILLS) {
		const file = path.join(skillsRoot, skill, "SKILL.md");
		const content = fs.readFileSync(file, "utf8");
		commandRefs.push(...collectCommandRefs(file, content));
		mutationRefs.push(...collectDirectGjcMutations(file, content));
	}

	// Generated advisory plugin skills (inventory + content gates).
	for (const dir of ADVISORY_SKILL_DIRS) {
		const file = path.join(repoRoot, "plugins", "gajae-code", "skills", dir, "SKILL.md");
		const content = fs.readFileSync(file, "utf8");
		commandRefs.push(...collectSdkSessionVerbRefs(file, content));
		mutationRefs.push(...collectDirectGjcMutations(file, content));
		advisoryContentGates.push(...collectSdkSkillContentGates(file, content));
	}
	const missingAdvisory = ADVISORY_SKILL_DIRS.filter(
		dir => !fs.existsSync(path.join(repoRoot, "plugins", "gajae-code", "skills", dir, "SKILL.md")),
	);

	const drift = commandRefs.filter(ref => !ref.valid);
	console.log(`gjc skill docs verifier - scanned ${path.relative(repoRoot, skillsRoot)}/*/SKILL.md`);
	console.log(`Found ${commandRefs.length} gjc command reference(s).`);
	console.log(`Found ${mutationRefs.length} direct .gjc shell mutation example(s).\n`);
	if (missingAdvisory.length > 0) {
		console.log(`MISSING advisory plugin skill(s): ${missingAdvisory.join(", ")}`);
	}
	if (advisoryContentGates.length > 0) {
		console.log("\n[ADVISORY-SKILL-CONTENT-GATE]");
		for (const violation of advisoryContentGates) {
			console.log(`    ${violation}`);
		}
	}

	const byFile = new Map<string, CommandRef[]>();
	for (const ref of commandRefs) {
		const list = byFile.get(ref.file) ?? [];
		list.push(ref);
		byFile.set(ref.file, list);
	}

	for (const [file, refs] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		console.log(`[${refs.every(ref => ref.valid) ? "OK" : "DRIFT"}] ${file}  (${refs.length} command(s))`);
		for (const ref of refs) {
			console.log(`    ${ref.line}: ${ref.command}  ${ref.valid ? "OK" : `UNKNOWN VERB for ${ref.skill}`}`);
		}
	}

	if (mutationRefs.length > 0) {
		console.log("\n[DIRECT-.GJC-MUTATION]");
		for (const ref of mutationRefs) {
			console.log(`    ${ref.file}:${ref.line}: ${ref.text}`);
		}
	}

	console.log(
		`\nSummary: ${drift.length} command drift issue(s), ${mutationRefs.length} direct .gjc shell mutation example(s), ` +
			`${missingAdvisory.length} missing advisory skill(s), ${advisoryContentGates.length} advisory content gate issue(s).`,
	);

	if (failMode && (drift.length > 0 || mutationRefs.length > 0 || missingAdvisory.length > 0 || advisoryContentGates.length > 0)) {
		console.error(
			`\nG4 FAIL: skill docs must reference manifest verbs only, avoid direct .gjc shell mutation examples, ` +
				`and keep advisory plugin skills inventory-clean and content-gated.`,
		);
		process.exit(1);
	}
}

main();
