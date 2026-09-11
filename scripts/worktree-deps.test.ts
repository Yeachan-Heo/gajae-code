import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	WORKTREE_SETUP_COMMAND,
	WORKTREE_SETUP_STEPS,
	formatWorkspaceDependencyFailure,
	formatWorktreeReport,
	inspectWorkspaceDependencies,
	listWorkspacePackageNames,
	probeNativeAddon,
	type WorktreeReport,
} from "./worktree-deps";

const tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { force: true, recursive: true })));
});

async function tempRoot(prefix: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

async function writeWorkspacePackage(root: string, dir: string, manifest: Record<string, unknown>): Promise<void> {
	await fs.mkdir(path.join(root, "packages", dir), { recursive: true });
	await Bun.write(path.join(root, "packages", dir, "package.json"), JSON.stringify(manifest));
}

describe("workspace dependency inspection", () => {
	test("reports missing node_modules without attempting package resolution", () => {
		let resolved = 0;
		const snapshot = inspectWorkspaceDependencies({
			repoRoot: "/nonexistent/worktree",
			nodeModulesExists: () => false,
			listWorkspacePackages: () => ["@gajae-code/utils"],
			resolvePackage: () => {
				resolved += 1;
				return "unreachable";
			},
		});
		expect(snapshot.status).toBe("missing-node-modules");
		expect(snapshot.unresolvedPackages).toEqual([]);
		expect(snapshot.nodeModulesDir).toBe(path.join("/nonexistent/worktree", "node_modules"));
		expect(resolved).toBe(0);
	});

	test("lists the workspace packages that fail to resolve after install", () => {
		const snapshot = inspectWorkspaceDependencies({
			repoRoot: "/nonexistent/worktree",
			nodeModulesExists: () => true,
			listWorkspacePackages: () => ["@gajae-code/utils", "@gajae-code/ai", "@gajae-code/tui"],
			resolvePackage: specifier => {
				if (specifier !== "@gajae-code/utils") throw new Error(`Cannot find package '${specifier}'`);
				return "/nonexistent/worktree/node_modules/@gajae-code/utils/src/index.ts";
			},
		});
		expect(snapshot.status).toBe("unresolved-workspace-packages");
		expect(snapshot.unresolvedPackages).toEqual(["@gajae-code/ai", "@gajae-code/tui"]);
	});

	test("is ready only when every probed package resolves", () => {
		const snapshot = inspectWorkspaceDependencies({
			repoRoot: "/nonexistent/worktree",
			nodeModulesExists: () => true,
			listWorkspacePackages: () => ["@gajae-code/utils"],
			resolvePackage: specifier => `/resolved/${specifier}`,
		});
		expect(snapshot.status).toBe("ready");
		expect(snapshot.workspacePackages).toEqual(["@gajae-code/utils"]);
		expect(snapshot.unresolvedPackages).toEqual([]);
	});

	test("failure message names the worktree-safe command and warns off install:dev", () => {
		const message = formatWorkspaceDependencyFailure(
			inspectWorkspaceDependencies({
				repoRoot: "/nonexistent/worktree",
				nodeModulesExists: () => false,
				listWorkspacePackages: () => [],
			}),
		);
		expect(message).toContain(WORKTREE_SETUP_COMMAND);
		expect(message).toContain(WORKTREE_SETUP_STEPS);
		expect(message).toContain("node_modules/ is absent");
		expect(message).toContain("install:dev");
		expect(message).toContain("git worktree add");
	});

	test("failure message distinguishes unresolved packages from a missing install", () => {
		const message = formatWorkspaceDependencyFailure(
			inspectWorkspaceDependencies({
				repoRoot: "/nonexistent/worktree",
				nodeModulesExists: () => true,
				listWorkspacePackages: () => ["@gajae-code/utils"],
				resolvePackage: () => {
					throw new Error("Cannot find package '@gajae-code/utils'");
				},
			}),
		);
		expect(message).toContain("@gajae-code/utils");
		expect(message).toContain(WORKTREE_SETUP_COMMAND);
	});
});

describe("workspace package discovery", () => {
	test("includes workspace packages with a root entry point and skips manifest-only artifacts", async () => {
		const root = await tempRoot("gjc-worktree-packages-");
		await writeWorkspacePackage(root, "utils", {
			name: "@gajae-code/utils",
			exports: { ".": "./src/index.ts" },
		});
		await writeWorkspacePackage(root, "natives", { name: "@gajae-code/natives", main: "./native/index.js" });
		await writeWorkspacePackage(root, "bench", { name: "@gajae-code/bench", module: "./src/index.ts" });
		// Prebuilt platform packages intentionally export only ./package.json.
		await writeWorkspacePackage(root, "natives-linux-x64", {
			name: "@gajae-code/natives-linux-x64",
			exports: { "./package.json": "./package.json" },
		});
		await writeWorkspacePackage(root, "foreign", { name: "some-other-package", exports: { ".": "./index.js" } });
		await writeWorkspacePackage(root, "manifestless", { name: "@gajae-code/manifestless" });

		expect(listWorkspacePackageNames(root)).toEqual([
			"@gajae-code/bench",
			"@gajae-code/natives",
			"@gajae-code/utils",
		]);
	});

	test("this checkout's probe set covers the runtime packages and excludes prebuilt platform artifacts", () => {
		const repoRoot = path.join(import.meta.dir, "..");
		const names = listWorkspacePackageNames(repoRoot);
		for (const expected of ["@gajae-code/agent-core", "@gajae-code/ai", "@gajae-code/coding-agent", "@gajae-code/natives", "@gajae-code/utils"]) {
			expect(names).toContain(expected);
		}
		expect(names.some(name => name.includes("natives-linux") || name.includes("natives-darwin") || name.includes("natives-win32"))).toBe(false);
	});
});

describe("native addon probe", () => {
	test("reports a missing entry point instead of spawning", async () => {
		const root = await tempRoot("gjc-worktree-native-");
		const result = probeNativeAddon(root);
		expect(result.ok).toBe(false);
		expect(result.entryPath).toBe(path.join(root, "packages", "natives", "native", "index.js"));
		expect(result.output).toContain("is missing from this checkout");
	});

	test("reports success when the natives entry point loads", async () => {
		const root = await tempRoot("gjc-worktree-native-ok-");
		await fs.mkdir(path.join(root, "packages", "natives", "native"), { recursive: true });
		await Bun.write(path.join(root, "packages", "natives", "native", "index.js"), 'console.log("loader-ok");\n');
		const result = probeNativeAddon(root);
		expect(result.ok).toBe(true);
		expect(result.output).toContain("loader-ok");
	});
});

describe("worktree readiness report", () => {
	function readyReport(): WorktreeReport {
		return {
			snapshot: {
				repoRoot: "/nonexistent/worktree",
				nodeModulesDir: "/nonexistent/worktree/node_modules",
				nodeModulesPresent: true,
				workspacePackages: ["@gajae-code/utils"],
				unresolvedPackages: [],
				status: "ready",
			},
			native: { ok: true, entryPath: "/nonexistent/worktree/packages/natives/native/index.js", output: "" },
			ok: true,
		};
	}

	test("celebrates a ready worktree", () => {
		const report = formatWorktreeReport(readyReport());
		expect(report).toContain("node_modules:       present");
		expect(report).toContain("workspace packages: 1/1 resolve");
		expect(report).toContain("native addon:       loads");
		expect(report).toContain("✓ This checkout can resolve workspace dependencies");
		expect(report).not.toContain(WORKTREE_SETUP_COMMAND);
	});

	test("names the fix and indents the loader diagnostic when unusable", () => {
		const report = formatWorktreeReport({
			...readyReport(),
			native: {
				ok: false,
				entryPath: "/nonexistent/worktree/packages/natives/native/index.js",
				output: "Failed to load pi_natives native addon for linux-x64.",
			},
			ok: false,
		});
		expect(report).toContain("native addon:       UNAVAILABLE");
		expect(report).toContain("      Failed to load pi_natives native addon for linux-x64.");
		expect(report).toContain("✗ This checkout cannot run the test suite.");
		expect(report).toContain(WORKTREE_SETUP_COMMAND);
		expect(report).toContain("install:dev");
	});
});

describe("test preload worktree guard", () => {
	test("fails a dependency-less checkout with the fix instead of a bare module-resolution error", async () => {
		const root = await tempRoot("gjc-worktree-preload-");
		const scriptsDir = path.join(root, "scripts");
		await fs.mkdir(scriptsDir, { recursive: true });
		for (const file of ["test-preload.ts", "safe-cleanup.ts", "test-agent-dir-isolation.ts", "worktree-deps.ts"]) {
			await Bun.write(path.join(scriptsDir, file), Bun.file(path.join(import.meta.dir, file)));
		}
		await Bun.write(path.join(root, "bunfig.toml"), '[test]\npreload = ["./scripts/test-preload.ts"]\n');
		await Bun.write(
			path.join(root, "trivial.test.ts"),
			'import { expect, test } from "bun:test";\nimport "@gajae-code/utils";\ntest("never runs", () => expect(1).toBe(1));\n',
		);

		const result = Bun.spawnSync([process.execPath, "test", "trivial.test.ts"], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		});
		const output = `${result.stdout.toString()}${result.stderr.toString()}`;

		expect(result.exitCode).not.toBe(0);
		expect(output).toContain("Workspace dependencies are not installed in this checkout");
		expect(output).toContain(WORKTREE_SETUP_COMMAND);
		expect(output).toContain(WORKTREE_SETUP_STEPS);
		expect(output).toContain("node_modules/ is absent");
		// The whole point: the named preload fix replaces the bare import failure the
		// suite would otherwise report for `@gajae-code/utils`.
		expect(output).not.toContain("error: Cannot find module");
	});
});
