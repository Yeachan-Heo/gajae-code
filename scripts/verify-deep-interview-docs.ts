#!/usr/bin/env bun

/**
 * Verifier for deep-interview schema-derived documentation.
 *
 * Renders the canonical contracts from source — the DRAFT_SCHEMAS descriptors
 * (deep-interview-payload.ts) and the DEEP_INTERVIEW_STATE_INVARIANTS registry
 * (deep-interview-state.ts) — and diffs them against the published docs so
 * drift becomes a CI failure instead of an agent-visible contradiction.
 *
 *   --report  (default)  print rendered contracts and doc coverage, exit 0
 *   --fail               exit non-zero on any drift
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
	DEEP_INTERVIEW_DRAFT_KINDS,
	type DraftDescriptor,
	deepInterviewDraftSchema,
} from "../packages/coding-agent/src/gjc-runtime/deep-interview-payload";
import { DEEP_INTERVIEW_STATE_INVARIANTS } from "../packages/coding-agent/src/gjc-runtime/deep-interview-state";

const repoRoot = path.join(import.meta.dir, "..");
const REPAIR_CLI_DOC = path.join(repoRoot, "docs", "deep-interview-repair-cli.md");
const SKILL_DOC = path.join(
	repoRoot,
	"packages",
	"coding-agent",
	"src",
	"defaults",
	"gjc",
	"skills",
	"deep-interview",
	"SKILL.md",
);

interface Drift {
	doc: string;
	problem: string;
}

const drifts: Drift[] = [];

function drift(doc: string, problem: string): void {
	drifts.push({ doc: path.relative(repoRoot, doc), problem });
}

/** Flatten a draft descriptor into `pointer -> leaf summary` rows. */
function leafRows(descriptor: DraftDescriptor, pointer: string, rows: Map<string, string>): void {
	if (descriptor.kind === "leaf") {
		const type = descriptor.type === "enum" ? `enum(${(descriptor.values ?? []).join("|")})` : descriptor.type;
		rows.set(pointer || "/", `${type}${descriptor.optional ? "" : " required"}${descriptor.nullable ? " nullable" : ""}`);
		return;
	}
	if (descriptor.kind === "array") {
		leafRows(descriptor.item, `${pointer}/N`, rows);
		return;
	}
	for (const [key, child] of Object.entries(descriptor.fields)) leafRows(child, `${pointer}/${key}`, rows);
	if (descriptor.dynamicValue) leafRows(descriptor.dynamicValue, `${pointer}/<ID>`, rows);
}

function renderDraftSchemas(): string {
	const lines: string[] = [];
	for (const kind of DEEP_INTERVIEW_DRAFT_KINDS) {
		const rows = new Map<string, string>();
		leafRows(deepInterviewDraftSchema(kind), "", rows);
		lines.push(`## ${kind}`);
		for (const [pointer, summary] of [...rows.entries()].sort(([a], [b]) => a.localeCompare(b)))
			lines.push(`  ${pointer}: ${summary}`);
	}
	return lines.join("\n");
}

const DRAFT_SCHEMA_BEGIN = "<!-- BEGIN GENERATED: deep-interview-draft-schemas (scripts/verify-deep-interview-docs.ts) -->";
const DRAFT_SCHEMA_END = "<!-- END GENERATED: deep-interview-draft-schemas -->";

function checkDraftSchemas(doc: string, content: string): void {
	const begin = content.indexOf(DRAFT_SCHEMA_BEGIN);
	const end = content.indexOf(DRAFT_SCHEMA_END);
	if (begin < 0 || end < 0 || end <= begin) {
		drift(doc, "missing generated deep-interview-draft-schemas block");
		return;
	}
	const block = content.slice(begin + DRAFT_SCHEMA_BEGIN.length, end).trim();
	const expected = `\`\`\`text\n${renderDraftSchemas()}\n\`\`\``;
	if (block !== expected) drift(doc, "generated deep-interview draft schema block does not match DRAFT_SCHEMAS");
}

function read(file: string): string {
	return fs.readFileSync(file, "utf8");
}

function checkInvariantTable(doc: string, content: string): void {
	const begin = content.indexOf("<!-- BEGIN GENERATED: deep-interview-state-invariants");
	const end = content.indexOf("<!-- END GENERATED: deep-interview-state-invariants -->");
	if (begin < 0 || end < 0) {
		drift(doc, "missing generated deep-interview-state-invariants block");
		return;
	}
	const block = content.slice(begin, end);
	const documented = new Map<string, string>();
	for (const match of block.matchAll(/^\| `([a-z0-9_]+)` \| (.+?) \|$/gmu)) documented.set(match[1], match[2]);
	for (const { id, description } of DEEP_INTERVIEW_STATE_INVARIANTS) {
		const docDescription = documented.get(id);
		if (docDescription === undefined) drift(doc, `invariant \`${id}\` is missing from the generated table`);
		else if (docDescription !== description)
			drift(doc, `invariant \`${id}\` description drifted: doc says ${JSON.stringify(docDescription)}, source says ${JSON.stringify(description)}`);
		documented.delete(id);
	}
	for (const stale of documented.keys())
		drift(doc, `invariant \`${stale}\` is documented but no longer exists in DEEP_INTERVIEW_STATE_INVARIANTS`);
}


/** Contract phrases the hardened CLI guarantees; docs must state them. */
const REQUIRED_CONTRACT_PHRASES: { phrase: string; why: string }[] = [
	{ phrase: "--expected-draft-revision N|latest", why: "edit-only latest revision selector" },
	{ phrase: "apply atomically", why: "batch --op groups are atomic" },
	{ phrase: "dry-run", why: "check runs the exact consume-side validation" },
	{ phrase: '"recovery"', why: "error payloads carry deterministic recovery commands" },
	{ phrase: '"invariant"', why: "state-invariant errors name the violated invariant" },
	{ phrase: "GJC_SESSION_ID", why: "typed commands inherit the active session" },
];

function checkContractPhrases(doc: string, content: string): void {
	for (const { phrase, why } of REQUIRED_CONTRACT_PHRASES) {
		if (!content.includes(phrase)) drift(doc, `missing contract statement (${why}): expected text ${JSON.stringify(phrase)}`);
	}
}

/** SKILL.md documents behavior prose-first; it must carry the hardened-behavior statements. */
const SKILL_REQUIRED_PHRASES: { phrase: string; why: string }[] = [
	{ phrase: "--expected-draft-revision latest", why: "edit-only latest revision selector" },
	{ phrase: "applied atomically", why: "batch --op groups are atomic" },
	{ phrase: "dry-runs the exact consume-side validation", why: "check==consume parity" },
	{ phrase: "recovery command", why: "invariant errors carry recovery" },
	{ phrase: "defaults its session from `GJC_SESSION_ID`", why: "typed commands inherit the active session" },
];

function main(): void {
	const args = process.argv.slice(2);
	const mode = args[0] ?? "--report";
	if (args.length > 1 || (mode !== "--report" && mode !== "--fail")) {
		console.error("Usage: bun scripts/verify-deep-interview-docs.ts [--report|--fail]");
		process.exit(2);
	}

	const repairDoc = read(REPAIR_CLI_DOC);
	const skillDoc = read(SKILL_DOC);

	checkInvariantTable(REPAIR_CLI_DOC, repairDoc);
	checkDraftSchemas(REPAIR_CLI_DOC, repairDoc);
	checkDraftSchemas(SKILL_DOC, skillDoc);
	checkContractPhrases(REPAIR_CLI_DOC, repairDoc);
	for (const { phrase, why } of SKILL_REQUIRED_PHRASES) {
		if (!skillDoc.includes(phrase))
			drift(SKILL_DOC, `missing contract statement (${why}): expected text ${JSON.stringify(phrase)}`);
	}

	if (mode === "--report") {
		console.log("Rendered draft schemas (from DRAFT_SCHEMAS):");
		console.log(renderDraftSchemas());
		console.log(`\nState invariants (from DEEP_INTERVIEW_STATE_INVARIANTS): ${DEEP_INTERVIEW_STATE_INVARIANTS.length}`);
	}

	if (drifts.length === 0) {
		console.log("deep-interview docs OK: schemas, invariants, and contract statements match source.");
		return;
	}
	for (const item of drifts) console.error(`DRIFT ${item.doc}: ${item.problem}`);
	if (mode === "--fail") process.exit(1);
}

main();
