#!/usr/bin/env bun

import * as fs from "node:fs";
import * as path from "node:path";

import { listCommandRefBlocks } from "../packages/coding-agent/src/gjc-runtime/workflow-command-ref";
import { CANONICAL_GJC_WORKFLOW_SKILLS } from "../packages/coding-agent/src/skill-state/canonical-skills";

interface SectionBudget {
	blockId: string;
	bytes: number;
	approxTokens: number;
}

interface SkillBudget {
	skill: string;
	sourcePath: string;
	bytes: number;
	approxTokens: number;
	sections: SectionBudget[];
}

const repoRoot = path.join(import.meta.dir, "..");
const skillsRoot = path.join(repoRoot, "packages", "coding-agent", "src", "defaults", "gjc", "skills");

function usage(): never {
	console.error("Usage: bun scripts/audit-skill-token-budget.ts [--json]");
	process.exit(2);
}

function approxTokens(text: string): number {
	return Math.ceil(Buffer.byteLength(text) / 4);
}

function markerBlock(content: string, start: string, end: string): string | undefined {
	const startIndex = content.indexOf(start);
	if (startIndex < 0) return undefined;
	const endIndex = content.indexOf(end, startIndex + start.length);
	if (endIndex < 0) return undefined;
	return content.slice(startIndex, endIndex + end.length + (content[endIndex + end.length] === "\n" ? 1 : 0));
}

export function auditSkillTokenBudget(): SkillBudget[] {
	return CANONICAL_GJC_WORKFLOW_SKILLS.map(skill => {
		const sourcePath = path.join(skillsRoot, skill, "SKILL.md");
		const content = fs.readFileSync(sourcePath, "utf8");
		const sections = listCommandRefBlocks(skill).flatMap(block => {
			const existing = markerBlock(content, block.markers.start, block.markers.end);
			if (existing === undefined) return [];
			return [{ blockId: block.blockId, bytes: Buffer.byteLength(existing), approxTokens: approxTokens(existing) }];
		});
		return {
			skill,
			sourcePath: path.relative(repoRoot, sourcePath),
			bytes: Buffer.byteLength(content),
			approxTokens: approxTokens(content),
			sections,
		};
	});
}

function main(): void {
	const args = process.argv.slice(2);
	const json = args.includes("--json");
	if (args.some(arg => arg !== "--json")) usage();
	const report = auditSkillTokenBudget();
	if (json) {
		console.log(JSON.stringify({ skills: report }, null, 2));
		return;
	}
	console.log("GJC bundled skill token budget (approx. 1 token ~= 4 bytes)");
	console.log("Skill            Bytes   Approx tokens   Marked sections");
	console.log("---------------  ------  --------------  ---------------");
	for (const item of report) {
		const sections = item.sections.length === 0 ? "none" : item.sections.map(section => `${section.blockId}:${section.bytes}B/${section.approxTokens}t`).join(", ");
		console.log(`${item.skill.padEnd(15)}  ${String(item.bytes).padStart(6)}  ${String(item.approxTokens).padStart(14)}  ${sections}`);
	}
	const totalBytes = report.reduce((sum, item) => sum + item.bytes, 0);
	console.log(`Total            ${String(totalBytes).padStart(6)}  ${String(approxTokens("x".repeat(totalBytes))).padStart(14)}`);
}

main();
