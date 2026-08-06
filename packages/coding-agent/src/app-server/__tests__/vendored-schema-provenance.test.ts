import { afterEach, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { materializeSchemaProfile } from "../../../../../scripts/codex-app-server-schema-materialize";
import {
	FROZEN_EXPERIMENTAL_SCHEMA_SUBTREE_OIDS,
	FROZEN_STABLE_SCHEMA_SUBTREE_OIDS,
	verifyVendoredSchemaProvenance,
	verifyVendoredStableSchemaProvenance,
} from "../vendored-schema-provenance";

const repositoryRoot = path.resolve(import.meta.dir, "../../../../..");
const vendorRoot = path.join(repositoryRoot, "packages/coding-agent/vendor/codex-app-server-schema");
const temporaryRoots: string[] = [];

// Only the import closure of the schema trees is committed; these tests hash the
// complete trees, so they reproduce them first. Materialization is a no-op once
// the trees already hash to the frozen OIDs.
beforeAll(async () => {
	await materializeSchemaProfile("stable");
	await materializeSchemaProfile("experimental");
}, 600_000);

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ repositoryRoot: string; stableRoot: string; experimentalRoot: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-vendored-schema-provenance-"));
	temporaryRoots.push(root);
	const destinationVendorRoot = path.join(root, "packages/coding-agent/vendor/codex-app-server-schema");
	const stableRoot = path.join(destinationVendorRoot, "stable");
	const experimentalRoot = path.join(destinationVendorRoot, "experimental");
	await fs.mkdir(destinationVendorRoot, { recursive: true });
	await Promise.all([
		fs.cp(path.join(vendorRoot, "stable"), stableRoot, { recursive: true }),
		fs.cp(path.join(vendorRoot, "experimental"), experimentalRoot, { recursive: true }),
		fs.copyFile(path.join(vendorRoot, "provenance.json"), path.join(destinationVendorRoot, "provenance.json")),
	]);
	return { repositoryRoot: root, stableRoot, experimentalRoot };
}

async function verificationError(root: string): Promise<string> {
	try {
		await verifyVendoredSchemaProvenance(root);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("Expected vendored schema provenance verification to fail.");
}

function experimentalMismatch(tree: "json" | "typescript"): string {
	return `Vendored experimental ${tree} schema tree OID mismatch: expected ${FROZEN_EXPERIMENTAL_SCHEMA_SUBTREE_OIDS[tree]}, actual `;
}

test("unmodified vendored stable and experimental trees reproduce the frozen subtree OIDs", async () => {
	await expect(verifyVendoredSchemaProvenance(repositoryRoot)).resolves.toEqual([
		{
			profile: "stable",
			tree: "json",
			expectedOid: FROZEN_STABLE_SCHEMA_SUBTREE_OIDS.json,
			actualOid: "21678ad2a396047ffa933db8bd4350fe3bc7729c",
		},
		{
			profile: "stable",
			tree: "typescript",
			expectedOid: FROZEN_STABLE_SCHEMA_SUBTREE_OIDS.typescript,
			actualOid: "76319ae92ff9b48824d86558d076963dc7cd6157",
		},
		{
			profile: "experimental",
			tree: "json",
			expectedOid: FROZEN_EXPERIMENTAL_SCHEMA_SUBTREE_OIDS.json,
			actualOid: "a6f333fed7efc24b4f45c70b0c220a13327bc2ae",
		},
		{
			profile: "experimental",
			tree: "typescript",
			expectedOid: FROZEN_EXPERIMENTAL_SCHEMA_SUBTREE_OIDS.typescript,
			actualOid: "670f3696b8ae24842ed6285b56f9752394dc6951",
		},
	]);
});

test("the legacy verifier now verifies both profiles", async () => {
	const { repositoryRoot: root, experimentalRoot } = await fixture();
	await fs.appendFile(path.join(experimentalRoot, "typescript/AgentPath.ts"), " ");
	await expect(verifyVendoredStableSchemaProvenance(root)).rejects.toThrow(experimentalMismatch("typescript"));
});

test("a changed CurrentTimeReadResponse field type in the experimental json tree fails", async () => {
	const { repositoryRoot: root, experimentalRoot } = await fixture();
	const target = path.join(experimentalRoot, "json/CurrentTimeReadResponse.json");
	const original = await fs.readFile(target, "utf8");
	const mutated = original.replace('"type": "integer"', '"type": "string"');
	expect(mutated).not.toBe(original);
	await fs.writeFile(target, mutated);
	expect(await verificationError(root)).toStartWith(experimentalMismatch("json"));
});

test("a changed byte in the experimental typescript tree fails", async () => {
	const { repositoryRoot: root, experimentalRoot } = await fixture();
	await fs.appendFile(path.join(experimentalRoot, "typescript/AgentPath.ts"), " ");
	expect(await verificationError(root)).toStartWith(experimentalMismatch("typescript"));
});

test("an added experimental json file fails", async () => {
	const { repositoryRoot: root, experimentalRoot } = await fixture();
	await fs.writeFile(path.join(experimentalRoot, "json/added-by-test.json"), "{}\n");
	expect(await verificationError(root)).toStartWith(experimentalMismatch("json"));
});

test("a deleted experimental typescript file fails", async () => {
	const { repositoryRoot: root, experimentalRoot } = await fixture();
	await fs.rm(path.join(experimentalRoot, "typescript/AgentPath.ts"));
	expect(await verificationError(root)).toStartWith(experimentalMismatch("typescript"));
});

test("a changed byte in the stable json tree still fails", async () => {
	const { repositoryRoot: root, stableRoot } = await fixture();
	await fs.appendFile(path.join(stableRoot, "json/v2/ThreadStartResponse.json"), " ");
	const error = await verificationError(root);
	expect(error).toStartWith(
		`Vendored stable json schema tree OID mismatch: expected ${FROZEN_STABLE_SCHEMA_SUBTREE_OIDS.json}, actual `,
	);
});

test("an added stable json file still fails", async () => {
	const { repositoryRoot: root, stableRoot } = await fixture();
	await fs.writeFile(path.join(stableRoot, "json/added-by-test.json"), "{}\n");
	const error = await verificationError(root);
	expect(error).toStartWith(
		`Vendored stable json schema tree OID mismatch: expected ${FROZEN_STABLE_SCHEMA_SUBTREE_OIDS.json}, actual `,
	);
});

test("a deleted stable typescript file still fails", async () => {
	const { repositoryRoot: root, stableRoot } = await fixture();
	await fs.rm(path.join(stableRoot, "typescript/v2/ThreadStartResponse.ts"));
	const error = await verificationError(root);
	expect(error).toStartWith(
		`Vendored stable typescript schema tree OID mismatch: expected ${FROZEN_STABLE_SCHEMA_SUBTREE_OIDS.typescript}, actual `,
	);
});

test("tampering provenance.json cannot make a mutated experimental tree pass", async () => {
	const { repositoryRoot: root, experimentalRoot } = await fixture();
	await fs.appendFile(path.join(experimentalRoot, "json/CurrentTimeReadResponse.json"), " ");
	await fs.writeFile(
		path.join(root, "packages/coding-agent/vendor/codex-app-server-schema/provenance.json"),
		JSON.stringify({ expectedSubtreeOids: { experimental: { json: "0".repeat(40), typescript: "0".repeat(40) } } }),
	);
	expect(await verificationError(root)).toStartWith(experimentalMismatch("json"));
});
