import { expect, test } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { WORKTREE_SETUP_STEPS } from "./worktree-deps";

interface RootManifest {
	scripts: Record<string, string>;
}

test("install:dev builds the native addon and links the source CLI without overriding Git hooks", async () => {
	const repoRoot = path.resolve(import.meta.dir, "..");
	const manifest = (await Bun.file(path.join(repoRoot, "package.json")).json()) as RootManifest;

	expect(manifest.scripts["install:dev"]?.split(" && ")).toEqual([
		"bun install",
		"bun run build:native",
		"bun --cwd=packages/coding-agent link",
		"bun --cwd=packages/ai link",
		"bun run dev:link",
		"bun packages/coding-agent/src/cli.ts setup defaults",
	]);
	expect(manifest.scripts["dev:hooks"]).toBeUndefined();
});

test("setup:worktree installs dependencies and builds natives without touching primary-checkout global state", async () => {
	const repoRoot = path.resolve(import.meta.dir, "..");
	const manifest = (await Bun.file(path.join(repoRoot, "package.json")).json()) as RootManifest;
	const script = manifest.scripts["setup:worktree"] ?? "";

	expect(script.split(" && ")).toEqual(["bun install", "bun run build:native"]);
	// The canonical step string lives in scripts/worktree-deps.ts; pin the manifest to it.
	expect(script).toBe(WORKTREE_SETUP_STEPS);
	// install:dev's global-state steps would hijack the primary checkout from a worktree.
	for (const forbidden of ["link", "setup defaults"]) {
		expect(script).not.toContain(forbidden);
	}
});
