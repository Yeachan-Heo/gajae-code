#!/usr/bin/env bun
// Materializes the vendored Codex app-server schema trees from source.
//
// The schema trees are no longer committed: they are ~1.9k files that are fully
// reproducible from `openai/codex` at the pinned commit, so the repository keeps
// the reproducer instead of the bytes.
//
//   stable/{json,typescript}       git archive of the pinned commit's schema trees
//   experimental/{json,typescript} `cargo run --bin export -- --experimental`
//
// Both are verified against the frozen subtree OIDs in
// `src/app-server/vendored-schema-provenance.ts`, which remain the only
// verification authority. Materialization is idempotent: when the trees already
// hash to the frozen OIDs, nothing is fetched, built, or written.
//
// Usage:
//   bun scripts/codex-app-server-schema-materialize.ts [--profile stable|experimental|all] [--force]

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	FROZEN_EXPERIMENTAL_SCHEMA_SUBTREE_OIDS,
	FROZEN_STABLE_SCHEMA_SUBTREE_OIDS,
	computeGitTreeOid,
	type SchemaProfile,
	type SchemaTreeName,
} from "../packages/coding-agent/src/app-server/vendored-schema-provenance";
import { pinnedCodexAppServerCommit } from "./codex-app-server-schema-vendor";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const vendorRoot = path.join(repositoryRoot, "packages/coding-agent/vendor/codex-app-server-schema");
const upstreamRemote = "https://github.com/openai/codex";
const schemaSourceRoot = "codex-rs/app-server-protocol/schema";
const exporterPackage = "codex-app-server-protocol";

const FROZEN_OIDS: Record<SchemaProfile, Record<SchemaTreeName, string>> = {
	stable: FROZEN_STABLE_SCHEMA_SUBTREE_OIDS,
	experimental: FROZEN_EXPERIMENTAL_SCHEMA_SUBTREE_OIDS,
};

function profileDirectory(profile: SchemaProfile, tree: SchemaTreeName): string {
	return path.join(vendorRoot, profile, tree);
}

async function run(command: string[], cwd: string): Promise<string> {
	const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`${command.join(" ")} failed with exit ${exitCode}: ${stderr.trim() || stdout.trim()}`);
	}
	return stdout;
}

/** Same as `run`, but returns raw bytes for binary stdout such as a tar stream. */
async function runBinary(command: string[], cwd: string): Promise<Uint8Array> {
	const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).bytes(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(`${command.join(" ")} failed with exit ${exitCode}: ${stderr.trim()}`);
	return stdout;
}

async function pathExists(target: string): Promise<boolean> {
	return fs
		.access(target)
		.then(() => true)
		.catch(() => false);
}

/** True when every tree of the profile already hashes to its frozen OID. */
async function profileMatchesFrozenOids(profile: SchemaProfile): Promise<boolean> {
	for (const [tree, expectedOid] of Object.entries(FROZEN_OIDS[profile]) as [SchemaTreeName, string][]) {
		const directory = profileDirectory(profile, tree);
		if (!(await pathExists(directory))) return false;
		if ((await computeGitTreeOid(directory)) !== expectedOid) return false;
	}
	return true;
}

async function assertProfileOids(profile: SchemaProfile): Promise<void> {
	const mismatches: string[] = [];
	for (const [tree, expectedOid] of Object.entries(FROZEN_OIDS[profile]) as [SchemaTreeName, string][]) {
		const actualOid = await computeGitTreeOid(profileDirectory(profile, tree));
		if (actualOid !== expectedOid) {
			mismatches.push(`${profile}/${tree}: expected ${expectedOid}, got ${actualOid}`);
		}
	}
	if (mismatches.length > 0) {
		throw new Error(`materialized ${profile} schema trees do not match the frozen subtree OIDs: ${mismatches.join("; ")}`);
	}
}

/**
 * Fetches the pinned commit into a reusable partial clone. `blob:none` keeps the
 * fetch small; the exporter build pulls the blobs it actually needs on demand.
 */
async function ensureUpstreamClone(): Promise<string> {
	const clone = process.env.CODEX_APP_SERVER_CLONE ?? path.join(os.tmpdir(), "gjc-codex-app-server-oracle");
	await fs.mkdir(clone, { recursive: true });
	if (!(await pathExists(path.join(clone, ".git")))) {
		await run(["git", "init", "-q", "."], clone);
	}
	const remotes = await run(["git", "remote"], clone);
	if (!remotes.split("\n").includes("origin")) {
		await run(["git", "remote", "add", "origin", upstreamRemote], clone);
	}
	const alreadyPresent = await run(["git", "cat-file", "-t", pinnedCodexAppServerCommit], clone)
		.then(type => type.trim() === "commit")
		.catch(() => false);
	if (!alreadyPresent) {
		await run(["git", "fetch", "--filter=blob:none", "--depth", "1", "origin", pinnedCodexAppServerCommit], clone);
	}
	const resolved = (await run(["git", "rev-parse", `${pinnedCodexAppServerCommit}^{commit}`], clone)).trim();
	if (resolved !== pinnedCodexAppServerCommit) {
		throw new Error(`pinned Codex commit mismatch: expected ${pinnedCodexAppServerCommit}, got ${resolved}`);
	}
	return clone;
}

/** Stable trees are upstream Git objects, so they are extracted verbatim. */
async function materializeStable(clone: string): Promise<void> {
	// `git archive` is used rather than `git checkout --work-tree` so a
	// verification run never mutates the shared clone's index.
	const stripComponents = `${schemaSourceRoot}/json`.split("/").length;
	for (const tree of ["json", "typescript"] as SchemaTreeName[]) {
		const destination = profileDirectory("stable", tree);
		await fs.rm(destination, { recursive: true, force: true });
		await fs.mkdir(destination, { recursive: true });
		const staging = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-codex-schema-tar-"));
		const archive = path.join(staging, "tree.tar");
		try {
			await Bun.write(
				archive,
				await runBinary(
					["git", "archive", "--format=tar", pinnedCodexAppServerCommit, "--", `${schemaSourceRoot}/${tree}`],
					clone,
				),
			);
			await run(["tar", "-x", "-f", archive, "-C", destination, `--strip-components=${stripComponents}`], destination);
		} finally {
			await fs.rm(staging, { recursive: true, force: true });
		}
	}
}

/**
 * Experimental trees are exporter output rather than upstream Git objects. The
 * exporter emits JSON and TypeScript into one directory tree; the vendored
 * layout splits them by extension while preserving relative paths.
 */
async function materializeExperimental(clone: string): Promise<void> {
	const exportRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-codex-schema-export-"));
	try {
		await run(
			["cargo", "run", "-q", "-p", exporterPackage, "--bin", "export", "--", "--out", exportRoot, "--experimental"],
			path.join(clone, "codex-rs"),
		);
		const suffixes: Record<SchemaTreeName, string> = { json: ".json", typescript: ".ts" };
		for (const tree of ["json", "typescript"] as SchemaTreeName[]) {
			const destination = profileDirectory("experimental", tree);
			await fs.rm(destination, { recursive: true, force: true });
			await fs.mkdir(destination, { recursive: true });
			for (const relative of await listFiles(exportRoot, suffixes[tree])) {
				const target = path.join(destination, relative);
				await fs.mkdir(path.dirname(target), { recursive: true });
				await fs.copyFile(path.join(exportRoot, relative), target);
			}
		}
	} finally {
		await fs.rm(exportRoot, { recursive: true, force: true });
	}
}

async function listFiles(root: string, suffix: string, prefix = ""): Promise<string[]> {
	const entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const relative = prefix ? path.join(prefix, entry.name) : entry.name;
		if (entry.isDirectory()) {
			files.push(...(await listFiles(root, suffix, relative)));
			continue;
		}
		if (entry.name.endsWith(suffix)) files.push(relative);
	}
	return files;
}

export async function materializeSchemaProfile(profile: SchemaProfile, force = false): Promise<"cached" | "materialized"> {
	if (!force && (await profileMatchesFrozenOids(profile))) return "cached";
	const clone = await ensureUpstreamClone();
	if (profile === "stable") await materializeStable(clone);
	else await materializeExperimental(clone);
	await assertProfileOids(profile);
	return "materialized";
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const requested = argv.includes("--profile") ? argv[argv.indexOf("--profile") + 1] : "all";
	if (requested !== "stable" && requested !== "experimental" && requested !== "all") {
		throw new Error("--profile must be stable, experimental, or all");
	}
	const profiles: SchemaProfile[] = requested === "all" ? ["stable", "experimental"] : [requested];
	for (const profile of profiles) {
		const outcome = await materializeSchemaProfile(profile, argv.includes("--force"));
		console.log(`${profile}: ${outcome} (frozen subtree OIDs verified)`);
	}
}
