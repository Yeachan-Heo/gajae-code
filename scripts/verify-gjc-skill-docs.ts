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

const repoRoot = path.join(import.meta.dir, "..");
const skillsRoot = path.join(repoRoot, "packages", "coding-agent", "src", "defaults", "gjc", "skills");
const skills = new Set<string>(CANONICAL_GJC_WORKFLOW_SKILLS);

interface CommandRef {
	file: string;
	line: number;
	skill: CanonicalGjcWorkflowSkill;
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
function resolveManifestVerb(
	skill: CanonicalGjcWorkflowSkill,
	command: string,
): { verb: string; matchedLength: number } | undefined {
	for (const verb of [...listVerbs(skill)].sort((a, b) => b.length - a.length)) {
		const pattern = new RegExp(`^${verb.replaceAll(" ", "\\s+")}(?![a-z0-9-])`, "u");
		const match = command.match(pattern);
		if (match) return { verb, matchedLength: match[0].length };
	}
	return undefined;
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
			const firstVerbToken = match[2] ?? "";
			const commandStart = match.index ?? 0;
			const verbStart = commandStart + match[0].length - firstVerbToken.length;
			if (isRoleSelectorVerb(line, verbStart + firstVerbToken.length)) continue;
			const resolved = resolveManifestVerb(skill, line.slice(verbStart));
			const verb = resolved?.verb ?? firstVerbToken;
			const command = resolved ? line.slice(commandStart, verbStart + resolved.matchedLength) : match[0];
			const valid = resolved !== undefined;
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

	for (const skill of CANONICAL_GJC_WORKFLOW_SKILLS) {
		const file = path.join(skillsRoot, skill, "SKILL.md");
		const content = fs.readFileSync(file, "utf8");
		commandRefs.push(...collectCommandRefs(file, content));
		mutationRefs.push(...collectDirectGjcMutations(file, content));
	}

	const drift = commandRefs.filter(ref => !ref.valid);
	console.log(`gjc skill docs verifier - scanned ${path.relative(repoRoot, skillsRoot)}/*/SKILL.md`);
	console.log(`Found ${commandRefs.length} gjc command reference(s).`);
	console.log(`Found ${mutationRefs.length} direct .gjc shell mutation example(s).\n`);

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

	console.log(`\nSummary: ${drift.length} command drift issue(s), ${mutationRefs.length} direct .gjc shell mutation example(s).`);

	if (failMode && (drift.length > 0 || mutationRefs.length > 0)) {
		console.error(`\nG4 FAIL: skill docs must reference manifest verbs only and avoid direct .gjc shell mutation examples.`);
		process.exit(1);
	}
}

main();
