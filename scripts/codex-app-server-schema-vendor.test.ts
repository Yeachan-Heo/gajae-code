import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { assertVendoredStableSubtreeOids, codexAppServerSchemaVendorRoot, expectedStableSubtreeOids, recomputeVendoredStableSubtreeOids } from "./codex-app-server-schema-vendor.ts";

const temporaryRoots: string[] = [];

async function copiedVendorRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "g002-codex-schema-"));
	temporaryRoots.push(root);
	await fs.cp(codexAppServerSchemaVendorRoot, root, { recursive: true });
	return root;
}

afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

describe("vendored Codex app-server stable schema trees", () => {
	test("reproduces the independently frozen stable subtree OIDs", async () => {
		await expect(recomputeVendoredStableSubtreeOids()).resolves.toEqual(expectedStableSubtreeOids);
		await expect(assertVendoredStableSubtreeOids()).resolves.toEqual(expectedStableSubtreeOids);
	});

	test("fails closed when a vendored file changes", async () => {
		const root = await copiedVendorRoot();
		const target = path.join(root, "stable/json/ClientRequest.json");
		await fs.appendFile(target, "\n");
		await expect(assertVendoredStableSubtreeOids(root)).rejects.toThrow(`expected frozen ${expectedStableSubtreeOids.json}`);
	});

	test("uses literal frozen OIDs rather than deriving its expectation from vendored content", async () => {
		const source = await Bun.file(path.join(import.meta.dir, "codex-app-server-schema-vendor.ts")).text();
		expect(source).toContain('json: "21678ad2a396047ffa933db8bd4350fe3bc7729c"');
		expect(source).toContain('typescript: "76319ae92ff9b48824d86558d076963dc7cd6157"');
		expect(source).toContain("actual[tree] !== expectedStableSubtreeOids[tree]");
		expect(source).not.toMatch(/expectedStableSubtreeOids\s*=\s*await\s+recomputeVendoredStableSubtreeOids/);
	});
});
