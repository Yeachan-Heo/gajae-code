#!/usr/bin/env bun
// Codex app-server schema oracle.
//
// The obligations manifest's `oracle-stable` / `oracle-experimental` gates run this script. It
// verifies that the schema trees hash to the frozen subtree OIDs recorded in
// `vendored-schema-provenance.ts`, which are the review-time authority (provenance.json is
// evidence, not authority).
//
// The trees are not committed. They are materialized from `openai/codex` at the pinned commit
// (stable: `git archive`; experimental: the pinned Rust exporter) and then verified, so the gate
// proves reproduction from source rather than the integrity of checked-in bytes. Materialization
// is skipped when the working tree already hashes to the frozen OIDs.
//
// Usage:
//   bun scripts/verify-codex-app-server-oracle.ts --stable [--verify-frozen-subtree-oids]
//   bun scripts/verify-codex-app-server-oracle.ts --experimental [--verify-frozen-subtree-oids]

import * as path from "node:path";
import {
	FROZEN_EXPERIMENTAL_SCHEMA_SUBTREE_OIDS,
	FROZEN_STABLE_SCHEMA_SUBTREE_OIDS,
	computeGitTreeOid,
	type SchemaProfile,
	type SchemaTreeName,
} from "../packages/coding-agent/src/app-server/vendored-schema-provenance";
import { materializeSchemaProfile } from "./codex-app-server-schema-materialize";

const repositoryRoot = path.resolve(import.meta.dir, "..");

function requestedProfile(argv: readonly string[]): SchemaProfile {
	const stable = argv.includes("--stable");
	const experimental = argv.includes("--experimental");
	if (stable === experimental)
		throw new Error("Pass exactly one of --stable or --experimental to select the schema profile.");
	return stable ? "stable" : "experimental";
}

async function main(): Promise<void> {
	const profile = requestedProfile(process.argv.slice(2));
	const frozen = profile === "stable" ? FROZEN_STABLE_SCHEMA_SUBTREE_OIDS : FROZEN_EXPERIMENTAL_SCHEMA_SUBTREE_OIDS;
	const outcome = await materializeSchemaProfile(profile);
	process.stdout.write(`${profile}: schema trees ${outcome} from the pinned upstream source\n`);
	const mismatches: string[] = [];
	for (const [tree, expectedOid] of Object.entries(frozen) as [SchemaTreeName, string][]) {
		const directory = path.join(repositoryRoot, "packages/coding-agent/vendor/codex-app-server-schema", profile, tree);
		const actualOid = await computeGitTreeOid(directory);
		const status = actualOid === expectedOid ? "OK" : "MISMATCH";
		process.stdout.write(`${profile}/${tree}: expected ${expectedOid} actual ${actualOid} ${status}\n`);
		if (actualOid !== expectedOid) mismatches.push(`${profile}/${tree}`);
	}
	if (mismatches.length > 0) {
		process.stdout.write(`FAIL ${profile} schema oracle: frozen subtree OID mismatch for ${mismatches.join(", ")}\n`);
		process.exit(1);
	}
	// The marker the obligations manifest greps for.
	process.stdout.write(`PASS ${profile} schema oracle: frozen subtree OIDs verified\n`);
}

await main();
