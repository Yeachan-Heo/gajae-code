#!/usr/bin/env bun
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
export const codexAppServerSchemaVendorRoot = path.join(repoRoot, "packages/coding-agent/vendor/codex-app-server-schema");
export const pinnedCodexAppServerCommit = "81da9deb065d7adb283816b19b40f89bcc484276";
export const expectedStableSubtreeOids = {
	json: "21678ad2a396047ffa933db8bd4350fe3bc7729c",
	typescript: "76319ae92ff9b48824d86558d076963dc7cd6157",
} as const;

export type SchemaProfile = "stable" | "experimental";
export type SchemaTree = keyof typeof expectedStableSubtreeOids;
type TreeEntry = { name: string; mode: "100644" | "40000"; oid: string };

const sourceRoot = "codex-rs/app-server-protocol/schema";
const retrievalCommand = `git -C /tmp/codexprobe archive --format=tar ${pinnedCodexAppServerCommit} -- ${sourceRoot}/json ${sourceRoot}/typescript`;

function gitObjectOid(kind: "blob" | "tree", content: Uint8Array): string {
	const header = Buffer.from(`${kind} ${content.length}\0`);
	return crypto.createHash("sha1").update(header).update(content).digest("hex");
}

function gitTreeOid(entries: TreeEntry[]): string {
	const content = Buffer.concat(entries.sort((left, right) => Buffer.compare(Buffer.from(`${left.name}${left.mode === "40000" ? "/" : ""}`), Buffer.from(`${right.name}${right.mode === "40000" ? "/" : ""}`))).map(entry => Buffer.concat([Buffer.from(`${entry.mode} ${entry.name}\0`), Buffer.from(entry.oid, "hex")]))) as Uint8Array;
	return gitObjectOid("tree", content);
}

async function runGit(clone: string, args: string[]): Promise<Uint8Array> {
	const process = Bun.spawn(["git", "-C", clone, ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([new Response(process.stdout).arrayBuffer(), new Response(process.stderr).text(), process.exited]);
	if (exitCode !== 0) throw new Error(`git -C ${clone} ${args.join(" ")} failed with exit ${exitCode}: ${stderr.trim()}`);
	return new Uint8Array(stdout);
}

async function filesAtTree(clone: string, tree: SchemaTree): Promise<Array<{ relativePath: string; oid: string }>> {
	const listing = Buffer.from(await runGit(clone, ["ls-tree", "-r", "-z", pinnedCodexAppServerCommit, "--", `${sourceRoot}/${tree}`]));
	return listing.toString("utf8").split("\0").filter(Boolean).map(line => {
		const match = line.match(/^100644 blob ([0-9a-f]{40})\t(?:codex-rs\/app-server-protocol\/schema\/(?:json|typescript)\/)(.+)$/);
		if (!match) throw new Error(`unexpected upstream ${tree} tree entry: ${line}`);
		return { oid: match[1]!, relativePath: match[2]! };
	}).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function treeOidAtDirectory(directory: string): Promise<string> {
	const entries = await fs.readdir(directory, { withFileTypes: true });
	const treeEntries = await Promise.all(entries.map(async entry => {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) return { name: entry.name, mode: "40000" as const, oid: await treeOidAtDirectory(entryPath) };
		if (!entry.isFile()) throw new Error(`vendored schema contains unsupported entry: ${entryPath}`);
		return { name: entry.name, mode: "100644" as const, oid: gitObjectOid("blob", await fs.readFile(entryPath)) };
	}));
	return gitTreeOid(treeEntries);
}

export async function recomputeVendoredStableSubtreeOids(vendorRoot = codexAppServerSchemaVendorRoot): Promise<Record<SchemaTree, string>> {
	return {
		json: await treeOidAtDirectory(path.join(vendorRoot, "stable/json")),
		typescript: await treeOidAtDirectory(path.join(vendorRoot, "stable/typescript")),
	};
}

export async function assertVendoredStableSubtreeOids(vendorRoot = codexAppServerSchemaVendorRoot): Promise<Record<SchemaTree, string>> {
	const actual = await recomputeVendoredStableSubtreeOids(vendorRoot);
	for (const tree of ["json", "typescript"] as const) if (actual[tree] !== expectedStableSubtreeOids[tree]) throw new Error(`vendored stable ${tree} subtree OID mismatch: expected frozen ${expectedStableSubtreeOids[tree]}, got ${actual[tree]}`);
	return actual;
}

export async function syncVendoredStableSchemas(clone = "/tmp/codexprobe", vendorRoot = codexAppServerSchemaVendorRoot): Promise<{ fileCounts: Record<SchemaTree, number>; files: Record<string, string> }> {
	const sourceCommit = new TextDecoder().decode(await runGit(clone, ["rev-parse", `${pinnedCodexAppServerCommit}^{commit}`])).trim();
	if (sourceCommit !== pinnedCodexAppServerCommit) throw new Error(`pinned Codex commit mismatch: expected ${pinnedCodexAppServerCommit}, got ${sourceCommit}`);
	const archive = await runGit(clone, ["archive", "--format=tar", pinnedCodexAppServerCommit, "--", `${sourceRoot}/json`, `${sourceRoot}/typescript`]);
	if (!archive.length) throw new Error("pinned Codex schema archive was empty");
	const allFiles: Record<string, string> = {};
	const fileCounts = { json: 0, typescript: 0 };
	for (const tree of ["json", "typescript"] as const) {
		const files = await filesAtTree(clone, tree);
		await fs.rm(path.join(vendorRoot, "stable", tree), { recursive: true, force: true });
		for (const file of files) {
			const destination = path.join(vendorRoot, "stable", tree, file.relativePath);
			await fs.mkdir(path.dirname(destination), { recursive: true });
			const content = await runGit(clone, ["cat-file", "blob", file.oid]);
			if (gitObjectOid("blob", content) !== file.oid) throw new Error(`upstream blob checksum mismatch: ${tree}/${file.relativePath}`);
			await Bun.write(destination, content);
			allFiles[`stable/${tree}/${file.relativePath}`] = file.oid;
		}
		fileCounts[tree] = files.length;
	}
	const subtreeOids = await assertVendoredStableSubtreeOids(vendorRoot);
	const provenance = {
		sourceCommit: pinnedCodexAppServerCommit,
		expectedSubtreeOids: { stable: expectedStableSubtreeOids },
		recomputedSubtreeOids: { stable: subtreeOids },
		files: allFiles,
		retrievalCommand,
		retrievedAt: new Date().toISOString(),
	};
	await fs.mkdir(vendorRoot, { recursive: true });
	await Bun.write(path.join(vendorRoot, "provenance.json"), `${JSON.stringify(provenance, null, "\t")}\n`);
	return { fileCounts, files: allFiles };
}

if (import.meta.main) {
	const result = await syncVendoredStableSchemas(process.argv[2]);
	const oids = await assertVendoredStableSubtreeOids();
	console.log(`Vendored stable schemas: json=${result.fileCounts.json}, typescript=${result.fileCounts.typescript}`);
	console.log(`stable/json: expected=${expectedStableSubtreeOids.json} actual=${oids.json}`);
	console.log(`stable/typescript: expected=${expectedStableSubtreeOids.typescript} actual=${oids.typescript}`);
}
