#!/usr/bin/env bun
import * as path from "node:path";
import { verifyVendoredSchemaProvenance } from "../src/app-server/vendored-schema-provenance";

const repositoryRoot = path.resolve(process.argv[2] ?? path.resolve(import.meta.dir, "../../.."));

try {
	const verifications = await verifyVendoredSchemaProvenance(repositoryRoot);
	for (const { profile, tree, expectedOid, actualOid } of verifications)
		process.stdout.write(`${profile}/${tree}: expected ${expectedOid}, actual ${actualOid}\n`);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
