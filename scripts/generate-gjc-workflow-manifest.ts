#!/usr/bin/env bun

import * as fs from "node:fs";
import * as path from "node:path";

import { serializeManifestProjection } from "../packages/coding-agent/src/gjc-runtime/workflow-manifest";

const repoRoot = path.join(import.meta.dir, "..");
const GENERATED_MANIFEST = path.join(
	repoRoot,
	"packages",
	"coding-agent",
	"src",
	"gjc-runtime",
	"workflow-manifest.generated.json",
);

function usage(): never {
	console.error("Usage: bun scripts/generate-gjc-workflow-manifest.ts [--write|--check]");
	process.exit(2);
}

function main(): void {
	const args = process.argv.slice(2);
	if (args.length > 1) usage();

	const mode = args[0] ?? "--write";
	if (mode !== "--write" && mode !== "--check") usage();

	const generated = serializeManifestProjection();

	if (mode === "--write") {
		fs.writeFileSync(GENERATED_MANIFEST, generated, "utf8");
		console.log(`G3 OK: wrote ${path.relative(repoRoot, GENERATED_MANIFEST)}.`);
		return;
	}

	const committed = fs.readFileSync(GENERATED_MANIFEST, "utf8");
	if (committed === generated) {
		console.log(`G3 OK: ${path.relative(repoRoot, GENERATED_MANIFEST)} is up to date.`);
		return;
	}

	console.error(
		`G3 DRIFT: ${path.relative(repoRoot, GENERATED_MANIFEST)} does not match serializeManifestProjection(). Run bun scripts/generate-gjc-workflow-manifest.ts --write.`,
	);
	process.exit(1);
}

main();
