#!/usr/bin/env bun

import * as path from "node:path";
import {
	DEEP_INTERVIEW_DRAFT_KINDS,
	type DraftDescriptor,
	type DraftObjectDescriptor,
	deepInterviewDraftSchema,
} from "../packages/coding-agent/src/gjc-runtime/deep-interview-payload";

const repoRoot = path.join(import.meta.dir, "..");
const documentPath = path.join(repoRoot, "docs", "deep-interview-repair-cli.md");
const startMarker = "<!-- BEGIN GENERATED DEEP-INTERVIEW DRAFT PATHS -->";
const endMarker = "<!-- END GENERATED DEEP-INTERVIEW DRAFT PATHS -->";

function describe(descriptor: DraftDescriptor): string {
	const required = descriptor.optional === true ? "optional" : "required";
	if (descriptor.kind === "leaf") {
		const values = descriptor.values ? ` enum=${descriptor.values.join("|")}` : "";
		return `${descriptor.type} ${required}${descriptor.nullable ? " nullable" : ""}${values}`;
	}
	if (descriptor.kind === "array") return `array ${required} maxItems=${descriptor.maxItems}`;
	return `object ${required}`;
}

function rows(descriptor: DraftDescriptor, pointer: string): string[] {
	const output = [`| \`${pointer || "/"}\` | ${describe(descriptor)} |`];
	if (descriptor.kind === "array") return [...output, ...rows(descriptor.item, `${pointer}/<index>`)];
	if (descriptor.kind !== "object") return output;
	for (const [key, child] of Object.entries(descriptor.fields)) output.push(...rows(child, `${pointer}/${key}`));
	if (descriptor.dynamicValue) output.push(...rows(descriptor.dynamicValue, `${pointer}/<id>`));
	return output;
}

function section(): string {
	const content = [
		startMarker,
		"## Generated editable draft paths",
		"",
		"This table is generated from the runtime draft descriptors. It defines paths accepted by `draft edit`/`edit-batch`; `draft check` additionally evaluates state-dependent transition invariants.",
		"",
	];
	for (const kind of DEEP_INTERVIEW_DRAFT_KINDS) {
		content.push(`### \`${kind}\``, "", "| Path | Descriptor |", "|---|---|");
		content.push(...rows(deepInterviewDraftSchema(kind) as DraftObjectDescriptor, ""), "");
	}
	content.push(endMarker);
	return content.join("\n");
}

function projectedDocument(current: string): string {
	const start = current.indexOf(startMarker);
	const end = current.indexOf(endMarker);
	if (start < 0 || end < start) throw new Error(`Missing generated draft path markers in ${documentPath}`);
	return `${current.slice(0, start)}${section()}${current.slice(end + endMarker.length)}`;
}

const mode = process.argv[2] ?? "--check";
const current = await Bun.file(documentPath).text();
const projected = projectedDocument(current);
if (mode === "--write") {
	await Bun.write(documentPath, projected);
	process.stdout.write(`Updated ${path.relative(repoRoot, documentPath)}.\n`);
} else if (mode === "--check") {
	if (current !== projected) {
		process.stderr.write("Deep-interview draft reference drifted; run bun scripts/generate-deep-interview-draft-reference.ts --write.\n");
		process.exit(1);
	}
	process.stdout.write("Deep-interview draft reference is up to date.\n");
} else {
	process.stderr.write("Usage: bun scripts/generate-deep-interview-draft-reference.ts [--write|--check]\n");
	process.exit(2);
}
