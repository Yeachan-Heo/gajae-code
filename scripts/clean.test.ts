import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { absoluteTarget, assertRemovable, cleanPatterns, resolveCleanTargets, scopesFor } from "./clean-core";
import { parseArgs } from "./clean";

async function fixture(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-clean-"));
	await Bun.write(path.join(root, "packages/coding-agent/dist/gjc"), "binary");
	await Bun.write(path.join(root, "packages/coding-agent/.18c92f9fde7e85f6-00000000.bun-build"), "stray");
	await Bun.write(path.join(root, "packages/coding-agent/src/cli.ts"), "source");
	await Bun.write(path.join(root, "packages/natives/native/pi_natives.darwin-arm64.node"), "addon");
	await Bun.write(path.join(root, "packages/natives/native/index.js"), "loader");
	await Bun.write(path.join(root, "artifacts/g011-qa-report.json"), "{}");
	await Bun.write(path.join(root, "node_modules/left-pad/index.js"), "dep");
	await Bun.write(path.join(root, ".gjc/state/ledger.json"), "{}");
	return root;
}

test("removes build output but keeps sources, evidence, dependencies, and runtime state", async () => {
	const root = await fixture();
	try {
		const targets = await resolveCleanTargets(root);
		expect(targets).toEqual([
			"packages/coding-agent/.18c92f9fde7e85f6-00000000.bun-build",
			"packages/coding-agent/dist",
		]);
		for (const target of targets) {
			await fs.rm(absoluteTarget(root, target), { recursive: true, force: true });
		}
		expect(await fs.exists(path.join(root, "packages/coding-agent/dist"))).toBe(false);
		expect(await fs.exists(path.join(root, "packages/coding-agent/src/cli.ts"))).toBe(true);
		expect(await fs.exists(path.join(root, "artifacts/g011-qa-report.json"))).toBe(true);
		expect(await fs.exists(path.join(root, "node_modules/left-pad/index.js"))).toBe(true);
		expect(await fs.exists(path.join(root, ".gjc/state/ledger.json"))).toBe(true);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("keeps compiled native addons unless --native is requested", async () => {
	const root = await fixture();
	try {
		expect(await resolveCleanTargets(root, { native: false })).not.toContain(
			"packages/natives/native/pi_natives.darwin-arm64.node",
		);
		const withNative = await resolveCleanTargets(root, { native: true });
		expect(withNative).toContain("packages/natives/native/pi_natives.darwin-arm64.node");
		expect(withNative).not.toContain("packages/natives/native/index.js");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("scopes gate native patterns", () => {
	expect(Array.from(scopesFor({})).sort()).toEqual(["default"]);
	expect(Array.from(scopesFor({ native: true })).sort()).toEqual(["default", "native"]);
	expect(cleanPatterns.some(pattern => pattern.scope === "native")).toBe(true);
});

test.each([
	["../outside", "escape via parent"],
	["/etc/passwd", "absolute path"],
	["packages/../../etc", "embedded parent"],
	["", "empty path"],
	[".", "repo root"],
	["node_modules/left-pad", "installed dependency"],
	[".git/config", "git metadata"],
	[".gjc/state", "runtime state"],
	["artifacts/g011-qa-report.json", "test evidence"],
	["packages/coding-agent/artifacts", "nested test evidence"],
])("rejects %s (%s)", (candidate: string) => {
	expect(() => assertRemovable(candidate)).toThrow(/clean-target-invalid/);
});

test("normalizes accepted relative paths", () => {
	expect(assertRemovable("./packages/coding-agent/dist/")).toBe("packages/coding-agent/dist");
	expect(assertRemovable("packages\\stats\\dist")).toBe("packages/stats/dist");
});

test("absoluteTarget resolves under the root and rejects escapes", () => {
	expect(absoluteTarget("/repo", "packages/stats/dist")).toBe(path.resolve("/repo/packages/stats/dist"));
	expect(() => absoluteTarget("/repo", "../repo-sibling")).toThrow(/clean-target-invalid/);
});

test("parses flags and rejects unknown arguments", () => {
	expect(parseArgs([])).toEqual({ native: false, dryRun: false });
	expect(parseArgs(["--native"])).toEqual({ native: true, dryRun: false });
	expect(parseArgs(["--dry-run", "--native"])).toEqual({ native: true, dryRun: true });
	expect(() => parseArgs(["--all"])).toThrow("Unknown argument: --all");
});
