/**
 * Tests for project-scope registry resolution contracts.
 *
 * resolveActiveProjectRegistryPath: walk-up, .git fallback, null return, canonical path.
 * listAnthropic modelPluginRoots: project entries shadow user entries for same plugin ID.
 *
 * Note: helpers.ts imports @gajae-code/natives (Rust addon via glob).
 * This file imports from helpers.ts directly — the native addon IS present in the
 * test environment (verified: `bun run import-helpers.ts` succeeds).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { InstalledPluginEntry } from "@gajae-code/coding-agent/extensibility/plugins/marketplace";
import {
	addInstalledPlugin,
	buildPluginId,
	readInstalledPluginsRegistry,
	writeInstalledPluginsRegistry,
} from "@gajae-code/coding-agent/extensibility/plugins/marketplace";
import {
	clearClaudePluginRootsCache,
	listClaudePluginRoots,
	resolveActiveProjectRegistryPath,
} from "../../src/discovery/helpers";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeEntry(installPath: string, scope: InstalledPluginEntry["scope"] = "user"): InstalledPluginEntry {
	return {
		scope,
		installPath,
		version: "1.0.0",
		installedAt: "2025-01-01T00:00:00.000Z",
		lastUpdated: "2025-01-01T00:00:00.000Z",
	};
}

// ── resolveActiveProjectRegistryPath ─────────────────────────────────────────

describe("resolveActiveProjectRegistryPath", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-proj-scope-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("walk-up finds nearest .gjc/ directory", async () => {
		// Layout: tmpDir/.gjc/   +   tmpDir/sub/nested/  (cwd)
		// Resolver must climb from cwd → sub → tmpDir and find .gjc/ there.
		fs.mkdirSync(path.join(tmpDir, ".gjc"), { recursive: true });
		const cwd = path.join(tmpDir, "sub", "nested");
		fs.mkdirSync(cwd, { recursive: true });

		const result = await resolveActiveProjectRegistryPath(cwd);

		expect(result).toBe(path.join(tmpDir, ".gjc", "plugins", "installed_plugins.json"));
	});

	it("walk-up stops at the nearest .gjc/ — does not skip to a more distant one", async () => {
		// Layout: tmpDir/.gjc/   +   tmpDir/sub/.gjc/   +   tmpDir/sub/nested/  (cwd)
		// Resolver must stop at tmpDir/sub/.gjc/, not climb further to tmpDir/.gjc/.
		fs.mkdirSync(path.join(tmpDir, ".gjc"), { recursive: true });
		fs.mkdirSync(path.join(tmpDir, "sub", ".gjc"), { recursive: true });
		const cwd = path.join(tmpDir, "sub", "nested");
		fs.mkdirSync(cwd, { recursive: true });

		const result = await resolveActiveProjectRegistryPath(cwd);

		expect(result).toBe(path.join(tmpDir, "sub", ".gjc", "plugins", "installed_plugins.json"));
	});

	it("falls back to .git root when no .gjc/ exists", async () => {
		// Layout: tmpDir/.git/   +   tmpDir/sub/  (cwd)
		// No .gjc/ anywhere → second pass finds .git/ at tmpDir.
		// Returned path is relative to the .git root, not .git itself.
		fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
		const cwd = path.join(tmpDir, "sub");
		fs.mkdirSync(cwd, { recursive: true });

		// Bound the walk-up at os.tmpdir() so a `.gjc/` polluting a shared ancestor
		// (e.g. a /tmp/.gjc left by other processes on CI runners) cannot shadow the
		// intended .git fallback. resolveActiveProjectRegistryPath stops before homedir.
		const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(os.tmpdir());
		try {
			const result = await resolveActiveProjectRegistryPath(cwd);
			expect(result).toBe(path.join(tmpDir, ".gjc", "plugins", "installed_plugins.json"));
		} finally {
			homeSpy.mockRestore();
		}
	});

	it("returns null when neither .gjc/ nor .git/ found anywhere in the tree", async () => {
		// Start at the filesystem root — guaranteed to have no .gjc/ or .git/ ancestors.
		const result = await resolveActiveProjectRegistryPath(path.sep);

		expect(result).toBeNull();
	});

	it("does not treat ~/.git as a project root (pass-2 home-dir guard)", async () => {
		// Simulate a dotfiles repo managed with a bare-git technique: ~/.git exists.
		// resolveActiveProjectRegistryPath must NOT return ~/.gjc/.../installed_plugins.json.
		const homeDir = os.homedir();
		const fakeHomeGit = path.join(homeDir, ".git");
		const hadGit = await fs.promises
			.stat(fakeHomeGit)
			.then(() => true)
			.catch(() => false);
		if (!hadGit) {
			await fs.promises.mkdir(fakeHomeGit, { recursive: true });
		}
		try {
			// Start from a tmpDir that has no .gjc/ or .git/ of its own.
			const result = await resolveActiveProjectRegistryPath(tmpDir);
			// Must not resolve to the home-dir GJC registry.
			const homeGjcPath = path.join(homeDir, ".gjc", "plugins", "installed_plugins.json");
			expect(result).not.toBe(homeGjcPath);
		} finally {
			if (!hadGit) await fs.promises.rm(fakeHomeGit, { recursive: true, force: true });
		}
	});

	it("canonical path — /repo and /repo/src resolve to the same registry file", async () => {
		// Both sub-directories of the same project must produce identical paths.
		fs.mkdirSync(path.join(tmpDir, ".gjc"), { recursive: true });
		const src = path.join(tmpDir, "src");
		fs.mkdirSync(src, { recursive: true });

		const fromRoot = await resolveActiveProjectRegistryPath(tmpDir);
		const fromSrc = await resolveActiveProjectRegistryPath(src);

		expect(fromRoot).not.toBeNull();
		expect(fromRoot).toBe(fromSrc);
	});
});

// ── listAnthropic modelPluginRoots: project shadows user ───────────────────────────────

describe("listClaudePluginRoots — project shadows user", () => {
	let tmpHome: string;
	let tmpProject: string;
	/** Path where listAnthropic modelPluginRoots reads the user GJC registry. */
	let userRegPath: string;
	/** Path where listAnthropic modelPluginRoots reads the project registry (resolved from tmpProject). */
	let projectRegPath: string;

	beforeEach(() => {
		tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-shadow-home-"));
		tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-shadow-proj-"));

		// Create .gjc/ in project so resolveActiveProjectRegistryPath finds it.
		fs.mkdirSync(path.join(tmpProject, ".gjc", "plugins"), { recursive: true });

		userRegPath = path.join(tmpHome, ".gjc", "plugins", "installed_plugins.json");
		fs.mkdirSync(path.dirname(userRegPath), { recursive: true });

		projectRegPath = path.join(tmpProject, ".gjc", "plugins", "installed_plugins.json");
	});

	afterEach(() => {
		// Cache is keyed by home:projectPath — must clear between tests.
		clearClaudePluginRootsCache();
		fs.rmSync(tmpHome, { recursive: true, force: true });
		fs.rmSync(tmpProject, { recursive: true, force: true });
	});

	it("project entry shadows user entry when plugin IDs match", async () => {
		const pluginId = buildPluginId("shared-plugin", "test-mkt");

		// User registry has the plugin at a user-side install path.
		let userReg = await readInstalledPluginsRegistry(userRegPath);
		userReg = addInstalledPlugin(userReg, pluginId, makeEntry("/user/install/shared-plugin"));
		await writeInstalledPluginsRegistry(userRegPath, userReg);

		// Project registry has the same plugin ID at a project-side install path.
		let projReg = await readInstalledPluginsRegistry(projectRegPath);
		projReg = addInstalledPlugin(projReg, pluginId, makeEntry("/project/install/shared-plugin", "project"));
		await writeInstalledPluginsRegistry(projectRegPath, projReg);

		const { roots } = await listClaudePluginRoots(tmpHome, tmpProject);
		const matching = roots.filter(r => r.id === pluginId);

		// Exactly one entry survives — the user entry is suppressed.
		expect(matching).toHaveLength(1);
		expect(matching[0]?.path).toBe("/project/install/shared-plugin");
		expect(matching[0]?.scope).toBe("project");
	});
});
