import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { safeRm } from "../../../scripts/safe-cleanup";
import { resolveDoctorRoot } from "../src/cli/doctor/ids";
import {
	applyPluginQuarantine as applyQuarantineWithBaseline,
	type PluginQuarantineRequest,
	previewPluginQuarantine as previewQuarantine,
} from "../src/cli/doctor/plugin-quarantine";
import { clearClaudePluginRootsCache, listClaudePluginRoots } from "../src/discovery/helpers";
import { installGjcBundle } from "../src/extensibility/gjc-plugins";
import { PluginManager } from "../src/extensibility/plugins/manager";
import {
	getInstalledPluginsRegistryPath,
	writeInstalledPluginsRegistry,
} from "../src/extensibility/plugins/marketplace/registry";
import type { InstalledPluginsRegistry } from "../src/extensibility/plugins/marketplace/types";

const fixture = path.join(import.meta.dir, "fixtures", "gjc-plugins", "valid-six-surface-bundle");

let originalAgentDir: string;
let agentDir: string;
let originalHome: string | undefined;
let tempHome: string;
let cwd: string;
let journalRoot: string;
let runCounter = 0;

beforeEach(async () => {
	clearClaudePluginRootsCache();
	originalAgentDir = getAgentDir();
	originalHome = process.env.HOME;
	tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-doctor-quarantine-home-"));
	agentDir = path.join(tempHome, ".gjc", "agent");
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-doctor-quarantine-cwd-"));
	journalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-doctor-quarantine-journal-"));
	process.env.HOME = tempHome;
	vi.spyOn(os, "homedir").mockReturnValue(tempHome);
	setAgentDir(agentDir);
});

afterEach(async () => {
	clearClaudePluginRootsCache();
	vi.restoreAllMocks();
	setAgentDir(originalAgentDir);
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	await safeRm(tempHome, { recursive: true, force: true });
	await safeRm(cwd, { recursive: true, force: true });
	await safeRm(journalRoot, { recursive: true, force: true });
});

type QuarantineFixtureInput = Omit<PluginQuarantineRequest, "rootId"> & { rootId?: string };
function boundInput(input: QuarantineFixtureInput): PluginQuarantineRequest {
	return {
		...input,
		rootId:
			input.rootId ??
			resolveDoctorRoot(
				input.scope === "user" ? "config-user" : "config-project",
				input.scope === "user" ? agentDir : path.join(input.cwd, ".gjc"),
			).rootId,
	};
}
async function previewPluginQuarantine(input: QuarantineFixtureInput) {
	return await previewQuarantine(boundInput(input));
}
async function applyPluginQuarantine(input: QuarantineFixtureInput, authorizations: readonly string[]) {
	const bound = boundInput(input);
	const before = await previewQuarantine(bound);
	return await applyQuarantineWithBaseline(bound, authorizations, before);
}

function nextRunId(): string {
	runCounter += 1;
	return `run-${runCounter}-${Date.now()}`;
}

function lockPath(): string {
	return path.join(tempHome, ".gjc", "plugins", "gjc-plugins.lock.json");
}

async function installGjcFixture(): Promise<void> {
	const source = path.join(cwd, "source");
	await fs.cp(fixture, source, { recursive: true });
	const installed = await installGjcBundle({ cwd }, "project", source);
	expect(installed.ok).toBe(true);
}

async function installNpmFixture(name: string, enabled = true): Promise<void> {
	const path_ = lockPath();
	await fs.mkdir(path.dirname(path_), { recursive: true });
	let existing: { plugins: Record<string, unknown>; settings: Record<string, unknown> } = {
		plugins: {},
		settings: {},
	};
	try {
		existing = JSON.parse(await fs.readFile(path_, "utf8"));
	} catch {
		// first plugin in this test
	}
	existing.plugins[name] = { version: "1.0.0", enabledFeatures: null, enabled };
	await fs.writeFile(path_, JSON.stringify(existing, null, 2));
}

async function installMarketplaceFixture(id: string, scope: "user" | "project", enabled = true): Promise<string> {
	const registryPath = getInstalledPluginsRegistryPath();
	const existing = await readExistingMarketplace(registryPath);
	existing.plugins[id] = [
		{
			scope,
			installPath: path.join(cwd, "cache", id),
			version: "1.0.0",
			installedAt: "2020-01-01T00:00:00.000Z",
			lastUpdated: "2020-01-01T00:00:00.000Z",
			enabled,
		},
	];
	await writeInstalledPluginsRegistry(registryPath, existing);
	return registryPath;
}

async function readExistingMarketplace(registryPath: string): Promise<InstalledPluginsRegistry> {
	try {
		const raw = JSON.parse(await fs.readFile(registryPath, "utf8"));
		if (raw && typeof raw === "object" && raw.plugins) return raw as InstalledPluginsRegistry;
	} catch {
		// none yet
	}
	return { version: 2, plugins: {} };
}

describe("D7 plugin.quarantine-selected", () => {
	test("does not replace original apply authority with a fresh baseline", async () => {
		await installNpmFixture("original-target");
		const input = boundInput({
			family: "npm",
			scope: "user",
			name: "original-target",
			cwd,
			home: tempHome,
			journalRoot,
			runId: nextRunId(),
		});
		const original = await previewQuarantine(input);
		const current = await Bun.file(lockPath()).json();
		current.plugins["original-target"].version = "2.0.0";
		await Bun.write(lockPath(), JSON.stringify(current));
		const result = await applyQuarantineWithBaseline(input, ["plugin-change"], original);
		expect(result).toMatchObject({ status: "conflict", reason: "stale_baseline", sideEffectStarted: false });
		expect((await Bun.file(lockPath()).json()).plugins["original-target"]).toMatchObject({
			version: "2.0.0",
			enabled: true,
		});
		expect(await fs.readdir(journalRoot)).toEqual([]);
	});

	test("succeeds for all three families", async () => {
		await installGjcFixture();
		await installNpmFixture("npm-target");
		await installMarketplaceFixture("mkt-target@private", "user");

		const gjc = await applyPluginQuarantine(
			{
				family: "gjc",
				scope: "project",
				name: "valid-six-surface-bundle",
				cwd,
				home: tempHome,
				journalRoot,
				runId: nextRunId(),
			},
			["plugin-change"],
		);
		expect(gjc.status).toBe("verified");
		expect(gjc.targetExcludedFromStartup).toBe(true);

		const npm = await applyPluginQuarantine(
			{ family: "npm", scope: "user", name: "npm-target", cwd, home: tempHome, journalRoot, runId: nextRunId() },
			["plugin-change"],
		);
		expect(npm.status).toBe("verified");
		expect(npm.targetExcludedFromStartup).toBe(true);

		const marketplace = await applyPluginQuarantine(
			{
				family: "marketplace",
				scope: "user",
				name: "mkt-target@private",
				cwd,
				home: tempHome,
				journalRoot,
				runId: nextRunId(),
			},
			["plugin-change"],
		);
		expect(marketplace.status).toBe("verified");
		expect(marketplace.targetExcludedFromStartup).toBe(true);
	});

	test("one of many changed: sibling npm plugin stays enabled", async () => {
		await installNpmFixture("target-a");
		await installNpmFixture("target-b");

		const result = await applyPluginQuarantine(
			{ family: "npm", scope: "user", name: "target-a", cwd, home: tempHome, journalRoot, runId: nextRunId() },
			["plugin-change"],
		);
		expect(result.status).toBe("verified");
		const after = JSON.parse(await fs.readFile(lockPath(), "utf8"));
		expect(after.plugins["target-a"].enabled).toBe(false);
		expect(after.plugins["target-b"].enabled).toBe(true);
	});

	test("scope conflict: npm target installed in neither scope is not_installed", async () => {
		const plan = await previewPluginQuarantine({
			family: "npm",
			scope: "project",
			name: "ghost",
			cwd,
			home: tempHome,
		});
		expect(plan.status).toBe("blocked");
		expect(plan.reason).toBe("not_installed");
	});

	test("expected baseline/file/parent race refusal", async () => {
		await installNpmFixture("race-target");
		const plan = await previewPluginQuarantine({
			family: "npm",
			scope: "user",
			name: "race-target",
			cwd,
			home: tempHome,
		});
		expect(plan.status).toBe("ready");

		// Concurrent mutation invalidates the baseline before apply runs.
		const raw = JSON.parse(await fs.readFile(lockPath(), "utf8"));
		raw.plugins["race-target"].version = "2.0.0";
		await fs.writeFile(lockPath(), JSON.stringify(raw, null, 2));

		const manager = new PluginManager(cwd);
		await expect(manager.setEnabled("race-target", false, "user", plan.baseline)).rejects.toMatchObject({
			code: "stale_baseline",
		});
	});

	test("read-only preview: no writes, no auth needed", async () => {
		await installNpmFixture("readonly-target");
		const before = JSON.parse(await fs.readFile(lockPath(), "utf8"));
		const plan = await previewPluginQuarantine({
			family: "npm",
			scope: "user",
			name: "readonly-target",
			cwd,
			home: tempHome,
		});
		expect(plan.status).toBe("ready");
		const after = JSON.parse(await fs.readFile(lockPath(), "utf8"));
		expect(after).toEqual(before);
	});

	test("apply without authorization makes no changes", async () => {
		await installNpmFixture("noauth-target");
		const before = JSON.parse(await fs.readFile(lockPath(), "utf8"));
		const result = await applyPluginQuarantine(
			{ family: "npm", scope: "user", name: "noauth-target", cwd, home: tempHome, journalRoot, runId: nextRunId() },
			[],
		);
		expect(result.status).toBe("blocked");
		expect(result.reason).toBe("authorization_missing");
		expect(result.sideEffectStarted).toBe(false);
		const after = JSON.parse(await fs.readFile(lockPath(), "utf8"));
		expect(after).toEqual(before);
	});

	test("unsafe plugin: quarantine mutates metadata only, never imports code", async () => {
		// Sentinel: if the loader ever imported this module the process would
		// throw/crash. Quarantine must never resolve, read, or import it.
		const sentinelDir = path.join(cwd, "unsafe-plugin");
		await fs.mkdir(sentinelDir, { recursive: true });
		await fs.writeFile(path.join(sentinelDir, "index.js"), "throw new Error('SENTINEL: plugin code executed');");
		await installMarketplaceFixture("unsafe@private", "user");

		const result = await applyPluginQuarantine(
			{
				family: "marketplace",
				scope: "user",
				name: "unsafe@private",
				cwd,
				home: tempHome,
				journalRoot,
				runId: nextRunId(),
			},
			["plugin-change"],
		);
		expect(result.status).toBe("verified");
	});

	test("actual startup filter: target excluded, other family member still present", async () => {
		await installMarketplaceFixture("keep@private", "user");
		await installMarketplaceFixture("drop@private", "user");

		const result = await applyPluginQuarantine(
			{
				family: "marketplace",
				scope: "user",
				name: "drop@private",
				cwd,
				home: tempHome,
				journalRoot,
				runId: nextRunId(),
			},
			["plugin-change"],
		);
		expect(result.status).toBe("verified");
		expect(result.targetExcludedFromStartup).toBe(true);

		const { roots } = await listClaudePluginRoots(tempHome, cwd);
		expect(roots.some(r => r.plugin === "keep")).toBe(true);
		expect(roots.some(r => r.plugin === "drop")).toBe(false);
	});

	test("desired disabled state already achieved returns not_needed without writes", async () => {
		await installNpmFixture("already-off", false);
		const before = JSON.parse(await fs.readFile(lockPath(), "utf8"));
		const result = await applyPluginQuarantine(
			{ family: "npm", scope: "user", name: "already-off", cwd, home: tempHome, journalRoot, runId: nextRunId() },
			["plugin-change"],
		);
		expect(result.status).toBe("not_needed");
		expect(result.sideEffectStarted).toBe(false);
		const after = JSON.parse(await fs.readFile(lockPath(), "utf8"));
		expect(after).toEqual(before);
	});

	test("D7 has no enable path: a disabled target previews as not_needed", async () => {
		await installNpmFixture("disabled-target", false);
		const plan = await previewPluginQuarantine({
			family: "npm",
			scope: "user",
			name: "disabled-target",
			cwd,
			home: tempHome,
		});
		// A disabled target previews as not_needed — there is no request field
		// that could ask this module to flip it back on.
		expect(plan.status).toBe("not_needed");
		expect(plan.enabled).toBe(false);
	});

	test("symlinked marketplace registry file is refused, not silently treated as empty", async () => {
		const registryPath = await installMarketplaceFixture("linked@private", "user");
		const real = `${registryPath}.real`;
		await fs.rename(registryPath, real);
		await fs.symlink(real, registryPath);

		const plan = await previewPluginQuarantine({
			family: "marketplace",
			scope: "user",
			name: "linked@private",
			cwd,
			home: tempHome,
		});
		expect(plan.status).toBe("blocked");
		expect(plan.reason).toBe("unsafe_link");
	});

	test("hard-linked marketplace registry file is refused", async () => {
		const registryPath = await installMarketplaceFixture("hardlinked@private", "user");
		const hardlinkPath = `${registryPath}.hardlink`;
		await fs.link(registryPath, hardlinkPath);

		const plan = await previewPluginQuarantine({
			family: "marketplace",
			scope: "user",
			name: "hardlinked@private",
			cwd,
			home: tempHome,
		});
		expect(plan.status).toBe("blocked");
		expect(plan.reason).toBe("unsafe_link");
		await fs.rm(hardlinkPath, { force: true });
	});

	test("marketplace quarantine succeeds even when the cached artifact is missing", async () => {
		// installMarketplaceFixture points installPath at a directory that is
		// never created — the artifact is absent from disk.
		await installMarketplaceFixture("missing-artifact@private", "user");
		const result = await applyPluginQuarantine(
			{
				family: "marketplace",
				scope: "user",
				name: "missing-artifact@private",
				cwd,
				home: tempHome,
				journalRoot,
				runId: nextRunId(),
			},
			["plugin-change"],
		);
		expect(result.status).toBe("verified");
	});

	test("malformed marketplace source is blocked distinctly, not treated as empty/not_installed", async () => {
		const registryPath = getInstalledPluginsRegistryPath();
		await fs.mkdir(path.dirname(registryPath), { recursive: true });
		await fs.writeFile(registryPath, "{ not valid json");
		const plan = await previewPluginQuarantine({
			family: "marketplace",
			scope: "user",
			name: "anything@private",
			cwd,
			home: tempHome,
		});
		expect(plan.status).toBe("blocked");
		expect(plan.reason).toBe("malformed_registry");
	});
});
