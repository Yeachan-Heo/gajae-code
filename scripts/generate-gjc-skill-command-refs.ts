#!/usr/bin/env bun

import * as fs from "node:fs";
import * as path from "node:path";

import { listCommandRefBlocks, renderCommandRefBlock } from "../packages/coding-agent/src/gjc-runtime/workflow-command-ref";

interface CommandRefCheckResult {
	skill: string;
	blockId: string;
	sourcePath: string;
	status: "BYTE-EQUAL" | "GAP";
	reason?: string;
	currentBytes?: number;
	renderedBytes: number;
	firstMismatchOffset?: number;
}

const repoRoot = path.join(import.meta.dir, "..");

function usage(): never {
	console.error("Usage: bun scripts/generate-gjc-skill-command-refs.ts [--check] [--strict] [--json]");
	process.exit(2);
}

function parseArgs(): { strict: boolean; json: boolean } {
	const args = process.argv.slice(2);
	let strict = false;
	let json = false;
	for (const arg of args) {
		if (arg === "--check") continue;
		if (arg === "--strict") {
			strict = true;
			continue;
		}
		if (arg === "--json") {
			json = true;
			continue;
		}
		usage();
	}
	return { strict, json };
}

function markerBlock(content: string, start: string, end: string): string | undefined {
	const startIndex = content.indexOf(start);
	if (startIndex < 0) return undefined;
	const endIndex = content.indexOf(end, startIndex + start.length);
	if (endIndex < 0) return undefined;
	return content.slice(startIndex, endIndex + end.length + (content[endIndex + end.length] === "\n" ? 1 : 0));
}

function firstMismatchOffset(a: string, b: string): number | undefined {
	const max = Math.min(a.length, b.length);
	for (let i = 0; i < max; i++) {
		if (a.charCodeAt(i) !== b.charCodeAt(i)) return i;
	}
	return a.length === b.length ? undefined : max;
}

export function checkSkillCommandRefs(): CommandRefCheckResult[] {
	return listCommandRefBlocks().map(block => {
		const sourcePath = path.join(repoRoot, block.sourcePath);
		const current = fs.readFileSync(sourcePath, "utf8");
		const rendered = renderCommandRefBlock(block.skill, block.blockId).bytes;
		const existing = markerBlock(current, block.markers.start, block.markers.end);
		const relative = path.relative(repoRoot, sourcePath);
		if (existing === undefined) {
			return {
				skill: block.skill,
				blockId: block.blockId,
				sourcePath: relative,
				status: "GAP",
				reason: "unmarked / not yet generated",
				renderedBytes: Buffer.byteLength(rendered),
			};
		}
		if (existing === rendered) {
			return {
				skill: block.skill,
				blockId: block.blockId,
				sourcePath: relative,
				status: "BYTE-EQUAL",
				currentBytes: Buffer.byteLength(existing),
				renderedBytes: Buffer.byteLength(rendered),
			};
		}
		return {
			skill: block.skill,
			blockId: block.blockId,
			sourcePath: relative,
			status: "GAP",
			reason: "marked block is not byte-equal to rendered model",
			currentBytes: Buffer.byteLength(existing),
			renderedBytes: Buffer.byteLength(rendered),
			firstMismatchOffset: firstMismatchOffset(existing, rendered),
		};
	});
}

function main(): void {
	const { strict, json } = parseArgs();
	const results = checkSkillCommandRefs();
	if (json) {
		console.log(JSON.stringify({ results }, null, 2));
	} else {
		console.log("GJC skill command-ref proof spike (read-only)");
		for (const result of results) {
			const suffix = result.status === "BYTE-EQUAL" ? "" : ` (${result.reason ?? "gap"})`;
			console.log(`${result.skill}/${result.blockId}: ${result.status}${suffix} rendered=${result.renderedBytes}B${result.currentBytes === undefined ? "" : ` current=${result.currentBytes}B`}`);
		}
		const gaps = results.filter(result => result.status === "GAP").length;
		console.log(`Summary: ${results.length - gaps} byte-equal, ${gaps} gap(s).`);
	}
	if (strict && results.some(result => result.status !== "BYTE-EQUAL")) process.exit(1);
}

main();
