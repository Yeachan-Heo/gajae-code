import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const cliEntry = path.join(import.meta.dir, "../src/cli.ts");
const marketplaceFixture = path.join(import.meta.dir, "marketplace/fixtures/valid-marketplace");
const gjcBundleFixture = path.join(import.meta.dir, "fixtures/gjc-plugins/valid-six-surface-bundle");
const legacyBundleFixture = path.join(import.meta.dir, "fixtures/gjc-plugins/valid-skill-plugin");

const sandboxes: string[] = [];

interface Sandbox {
	home: string;
	cwd: string;
	run: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
	/**
	 * Content-addressed snapshot of the whole sandbox root: the home AND the
	 * project cwd. Project-scope GJC state lives at `<cwd>/.gjc/gjc-plugins`,
	 * outside the home, so a home-only snapshot cannot see a project-scope
	 * registry write or lock.
	 */
	snapshot: () => Promise<Map<string, string>>;
	/** Installs a legacy bundle directory with no registry entry of its own. */
	plantLegacyProjectBundle: (fixture: string) => Promise<void>;
}

/**
 * A `gjc plugin` command resolves user-scope state from HOME, not only from the
 * agent directory: the marketplace registry lives under `<home>/.gjc` and the
 * plugin cache under the plugins dir. Overriding GJC_CODING_AGENT_DIR alone
 * would leave these tests writing into the developer's real home.
 */
async function makeSandbox(): Promise<Sandbox> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-plugin-dry-run-"));
	sandboxes.push(root);
	const home = path.join(root, "home");
	const cwd = path.join(root, "project");
	// The child's temp dir must stay outside the snapshotted surface: it is the
	// runtime's scratch space, not plugin state.
	const tmp = path.join(root, "scratch", "tmp");
	const agentDir = path.join(home, ".gjc", "agent");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(tmp, { recursive: true });

	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		USERPROFILE: home,
		TMPDIR: tmp,
		TMP: tmp,
		TEMP: tmp,
		XDG_CONFIG_HOME: path.join(home, "config"),
		XDG_DATA_HOME: path.join(home, "data"),
		XDG_STATE_HOME: path.join(home, "state"),
		XDG_CACHE_HOME: path.join(root, "scratch", "cache"),
		GJC_CONFIG_DIR: ".gjc",
		GJC_CODING_AGENT_DIR: agentDir,
		PI_CODING_AGENT_DIR: agentDir,
		NO_COLOR: "1",
		PI_NO_TITLE: "1",
		// Bun caches transpiled output under XDG_CACHE_HOME when the CLI is run from
		// source. That is a harness artifact, not a product write, and a released
		// binary never produces it. Disable it so the snapshot below measures only
		// what the plugin command itself wrote.
		BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
	};

	return {
		home,
		cwd,
		plantLegacyProjectBundle: async fixture => {
			// Files on disk under the project scope root, deliberately with no
			// registry.json: exactly the shape legacy discovery migrates in.
			const projectRoot = path.join(cwd, ".gjc", "gjc-plugins", path.basename(fixture));
			await fs.cp(fixture, projectRoot, { recursive: true });
		},
		run: async args => {
			const proc = Bun.spawn({
				cmd: [process.execPath, cliEntry, "plugin", ...args],
				cwd,
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			return { exitCode, stdout, stderr };
		},
		snapshot: async () => {
			const snapshot = new Map<string, string>();
			const walk = async (dir: string): Promise<void> => {
				const entries = await fs.readdir(dir, { withFileTypes: true });
				for (const entry of entries) {
					const full = path.join(dir, entry.name);
					const rel = path.relative(root, full);
					if (entry.isSymbolicLink()) {
						snapshot.set(rel, `<symlink>${await fs.readlink(full)}`);
					} else if (entry.isDirectory()) {
						snapshot.set(`${rel}/`, "<dir>");
						await walk(full);
					} else {
						snapshot.set(rel, Bun.SHA256.hash(await fs.readFile(full), "hex"));
					}
				}
			};
			for (const surface of [home, cwd]) await walk(surface);
			return snapshot;
		},
	};
}

// Every case below drives the real `gjc plugin` CLI as a child process, up to
// five spawns per case, each paying source-CLI startup. That is well past the 5s
// default whenever the machine is cold or the suite runs alongside other files,
// and a timeout there would retire this regression without any assertion having
// failed.
const CLI_TEST_TIMEOUT_MS = 20_000;

function expectUnchanged(before: Map<string, string>, after: Map<string, string>): void {
	const added = [...after.keys()].filter(key => !before.has(key));
	const removed = [...before.keys()].filter(key => !after.has(key));
	const modified = [...before.entries()].filter(([key, hash]) => after.has(key) && after.get(key) !== hash);
	expect({ added, removed, modified: modified.map(([key]) => key) }).toEqual({
		added: [],
		removed: [],
		modified: [],
	});
}

describe("plugin uninstall --dry-run", () => {
	afterEach(async () => {
		for (const dir of sandboxes.splice(0)) await fs.rm(dir, { recursive: true, force: true });
	});

	// The reported regression: a marketplace plugin was actually removed by a
	// command that only asked for a preview.
	it(
		"previews a marketplace uninstall without touching the registry or the plugin cache",
		async () => {
			const sandbox = await makeSandbox();
			expect((await sandbox.run(["marketplace", "add", marketplaceFixture])).exitCode).toBe(0);
			expect((await sandbox.run(["install", "hello-plugin@test-marketplace", "--scope", "user"])).exitCode).toBe(0);

			const listedBefore = await sandbox.run(["list", "--json"]);
			const before = await sandbox.snapshot();

			const dryRun = await sandbox.run([
				"uninstall",
				"hello-plugin@test-marketplace",
				"--scope",
				"user",
				"--dry-run",
				"--json",
			]);

			expect(dryRun.exitCode).toBe(0);
			expect(dryRun.stderr).toBe("");
			expect(JSON.parse(dryRun.stdout)).toEqual({
				dryRun: true,
				wouldUninstall: "hello-plugin@test-marketplace",
				scope: "user",
			});

			expectUnchanged(before, await sandbox.snapshot());
			expect((await sandbox.run(["list", "--json"])).stdout).toBe(listedBefore.stdout);
		},
		CLI_TEST_TIMEOUT_MS,
	);

	it(
		"reports a marketplace dry run as a preview in human output",
		async () => {
			const sandbox = await makeSandbox();
			expect((await sandbox.run(["marketplace", "add", marketplaceFixture])).exitCode).toBe(0);
			expect((await sandbox.run(["install", "hello-plugin@test-marketplace", "--scope", "user"])).exitCode).toBe(0);
			const before = await sandbox.snapshot();

			const dryRun = await sandbox.run([
				"uninstall",
				"hello-plugin@test-marketplace",
				"--scope",
				"user",
				"--dry-run",
			]);

			expect(dryRun.exitCode).toBe(0);
			expect(dryRun.stdout).toContain("[dry-run] Would uninstall hello-plugin@test-marketplace (user)");
			// A preview must never claim the removal happened.
			expect(dryRun.stdout).not.toMatch(/(?:^|[^ ])\bUninstalled\b/);
			expectUnchanged(before, await sandbox.snapshot());
		},
		CLI_TEST_TIMEOUT_MS,
	);

	it(
		"previews a GJC bundle uninstall without removing the bundle or its registry entry",
		async () => {
			const sandbox = await makeSandbox();
			expect((await sandbox.run(["install", gjcBundleFixture, "--user"])).exitCode).toBe(0);

			const listedBefore = await sandbox.run(["list", "--json"]);
			const before = await sandbox.snapshot();

			const dryRun = await sandbox.run(["uninstall", "valid-six-surface-bundle", "--user", "--dry-run", "--json"]);

			expect(dryRun.exitCode).toBe(0);
			expect(dryRun.stderr).toBe("");
			expect(JSON.parse(dryRun.stdout)).toEqual({
				dryRun: true,
				wouldUninstall: { kind: "gjc-bundle", scope: "user", name: "valid-six-surface-bundle" },
			});

			expectUnchanged(before, await sandbox.snapshot());
			expect((await sandbox.run(["list", "--json"])).stdout).toBe(listedBefore.stdout);
		},
		CLI_TEST_TIMEOUT_MS,
	);

	it(
		"reports a GJC bundle dry run as a preview in human output",
		async () => {
			const sandbox = await makeSandbox();
			expect((await sandbox.run(["install", gjcBundleFixture, "--user"])).exitCode).toBe(0);
			const before = await sandbox.snapshot();

			const dryRun = await sandbox.run(["uninstall", "valid-six-surface-bundle", "--user", "--dry-run"]);

			expect(dryRun.exitCode).toBe(0);
			expect(dryRun.stdout).toContain("[dry-run] Would uninstall valid-six-surface-bundle (user)");
			expect(dryRun.stdout).not.toMatch(/(?:^|[^ ])\bUninstalled\b/);
			expectUnchanged(before, await sandbox.snapshot());
		},
		CLI_TEST_TIMEOUT_MS,
	);

	// The npm fallback path runs `bun uninstall` and rewrites the plugin runtime
	// config. Under --dry-run it must not even materialize the plugins directory.
	it(
		"previews the npm fallback uninstall without creating or rewriting plugin state",
		async () => {
			const sandbox = await makeSandbox();
			const before = await sandbox.snapshot();

			const dryRun = await sandbox.run(["uninstall", "some-npm-plugin", "--dry-run", "--json"]);

			expect(dryRun.exitCode).toBe(0);
			expect(dryRun.stderr).toBe("");
			expect(JSON.parse(dryRun.stdout)).toEqual({ dryRun: true, wouldUninstall: "some-npm-plugin" });
			expectUnchanged(before, await sandbox.snapshot());
		},
		CLI_TEST_TIMEOUT_MS,
	);

	// Classification runs before any target is selected, so it touches the GJC
	// registry for every uninstall target -- including npm and marketplace names
	// that will never reach the GJC path. A legacy bundle on disk with no
	// registry entry is what legacy discovery migrates and persists, so
	// classifying under --dry-run must not perform that migration.
	it(
		"classifies an npm target without migrating a discoverable legacy project bundle",
		async () => {
			const sandbox = await makeSandbox();
			await sandbox.plantLegacyProjectBundle(legacyBundleFixture);
			const before = await sandbox.snapshot();

			const dryRun = await sandbox.run(["uninstall", "totally-unrelated-npm-name", "--dry-run", "--json"]);

			expect(dryRun.exitCode).toBe(0);
			expect(JSON.parse(dryRun.stdout)).toEqual({ dryRun: true, wouldUninstall: "totally-unrelated-npm-name" });
			expectUnchanged(before, await sandbox.snapshot());
		},
		CLI_TEST_TIMEOUT_MS,
	);

	// An unreadable GJC registry means ownership of the target is unknown: the
	// corrupt scope may be the one that owns the name. Classification fails
	// closed for both dry-run and real uninstall instead of falling through to
	// the marketplace or npm branch, which could remove a same-named plugin the
	// user never targeted.
	it(
		"fails closed on a corrupt user registry instead of previewing a marketplace dry run",
		async () => {
			const sandbox = await makeSandbox();
			expect((await sandbox.run(["marketplace", "add", marketplaceFixture])).exitCode).toBe(0);
			expect((await sandbox.run(["install", "hello-plugin@test-marketplace", "--scope", "user"])).exitCode).toBe(0);
			const registryPath = path.join(sandbox.home, ".gjc", "agent", "gjc-plugins", "registry.json");
			await fs.mkdir(path.dirname(registryPath), { recursive: true });
			await fs.writeFile(registryPath, "{ corrupt");
			const before = await sandbox.snapshot();

			const dryRun = await sandbox.run([
				"uninstall",
				"hello-plugin@test-marketplace",
				"--scope",
				"user",
				"--dry-run",
			]);

			expect(dryRun.exitCode).toBe(3);
			expect(dryRun.stderr).toContain("Could not read the GJC user plugin registry");
			// The installed marketplace plugin must survive the refusal untouched.
			expectUnchanged(before, await sandbox.snapshot());
		},
		CLI_TEST_TIMEOUT_MS,
	);

	it(
		"fails closed on a corrupt user registry for an npm-target dry run",
		async () => {
			const sandbox = await makeSandbox();
			const registryPath = path.join(sandbox.home, ".gjc", "agent", "gjc-plugins", "registry.json");
			await fs.mkdir(path.dirname(registryPath), { recursive: true });
			await fs.writeFile(registryPath, "{ corrupt");
			const before = await sandbox.snapshot();

			const dryRun = await sandbox.run(["uninstall", "some-npm-name", "--dry-run", "--json"]);

			expect(dryRun.exitCode).toBe(3);
			expect(dryRun.stderr).toContain("Could not read the GJC user plugin registry");
			expectUnchanged(before, await sandbox.snapshot());
		},
		CLI_TEST_TIMEOUT_MS,
	);

	// The reviewer-reported collision: the corrupt GJC registry may own the name
	// while npm has a same-named plugin installed. Neither the dry run nor the
	// real uninstall may touch the npm plugin when GJC ownership is unreadable.
	it(
		"never removes a same-named npm plugin when the GJC registry is corrupt",
		async () => {
			const sandbox = await makeSandbox();
			const pluginsDir = path.join(sandbox.home, ".gjc", "plugins");
			const npmPluginDir = path.join(pluginsDir, "node_modules", "collide-plugin");
			await fs.mkdir(npmPluginDir, { recursive: true });
			await fs.writeFile(
				path.join(pluginsDir, "package.json"),
				JSON.stringify(
					{ name: "gjc-plugins", private: true, dependencies: { "collide-plugin": "1.0.0" } },
					null,
					"\t",
				),
			);
			await fs.writeFile(
				path.join(npmPluginDir, "package.json"),
				JSON.stringify({ name: "collide-plugin", version: "1.0.0", gjc: { version: "1.0.0" } }),
			);
			const registryPath = path.join(sandbox.home, ".gjc", "agent", "gjc-plugins", "registry.json");
			await fs.mkdir(path.dirname(registryPath), { recursive: true });
			await fs.writeFile(registryPath, "{ corrupt");
			const before = await sandbox.snapshot();

			const dryRun = await sandbox.run(["uninstall", "collide-plugin", "--dry-run"]);

			expect(dryRun.exitCode).toBe(3);
			expect(dryRun.stderr).toContain("Could not read the GJC user plugin registry");

			const real = await sandbox.run(["uninstall", "collide-plugin"]);

			expect(real.exitCode).toBe(3);
			expect(real.stderr).toContain("Could not read the GJC user plugin registry");
			// The npm plugin must still be on disk after both refusals.
			expectUnchanged(before, await sandbox.snapshot());
		},
		CLI_TEST_TIMEOUT_MS,
	);

	// A registry entry that is present but not uninstallable must surface as the
	// same refusal in dry-run and real mode; the preview may never report a
	// would-uninstall the real command would refuse with invalid_target.
	it(
		"refuses a non-uninstallable GJC entry identically in dry-run and real mode",
		async () => {
			const sandbox = await makeSandbox();
			expect((await sandbox.run(["install", gjcBundleFixture, "--user"])).exitCode).toBe(0);
			const registryPath = path.join(sandbox.home, ".gjc", "agent", "gjc-plugins", "registry.json");
			const raw = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
				plugins: Array<Record<string, unknown>>;
			};
			delete raw.plugins[0].version;
			await fs.writeFile(registryPath, JSON.stringify(raw));
			const before = await sandbox.snapshot();

			const dryRun = await sandbox.run(["uninstall", "valid-six-surface-bundle", "--user", "--dry-run"]);

			expect(dryRun.exitCode).toBe(3);
			expect(dryRun.stderr).toContain("its installed metadata is invalid");
			expectUnchanged(before, await sandbox.snapshot());
		},
		CLI_TEST_TIMEOUT_MS,
	);

	it(
		"previews a legacy project bundle by name without migrating or locking the registry",
		async () => {
			const sandbox = await makeSandbox();
			await sandbox.plantLegacyProjectBundle(legacyBundleFixture);
			const before = await sandbox.snapshot();

			const dryRun = await sandbox.run(["uninstall", "valid-skill-plugin", "--project", "--dry-run", "--json"]);

			// The bundle is not in the registry, so the GJC path does not own it and the
			// command falls through to the npm preview. Either way, nothing is written.
			expect(dryRun.exitCode).toBe(0);
			expect(dryRun.stdout).toContain("valid-skill-plugin");
			expectUnchanged(before, await sandbox.snapshot());
		},
		CLI_TEST_TIMEOUT_MS,
	);

	// The same classification under a marketplace target: a dry run that resolves
	// to the marketplace path must still leave project scope untouched.
	it(
		"classifies a marketplace target without migrating a legacy project bundle",
		async () => {
			const sandbox = await makeSandbox();
			expect((await sandbox.run(["marketplace", "add", marketplaceFixture])).exitCode).toBe(0);
			expect((await sandbox.run(["install", "hello-plugin@test-marketplace", "--scope", "user"])).exitCode).toBe(0);
			await sandbox.plantLegacyProjectBundle(legacyBundleFixture);
			const before = await sandbox.snapshot();

			const dryRun = await sandbox.run([
				"uninstall",
				"hello-plugin@test-marketplace",
				"--scope",
				"user",
				"--dry-run",
				"--json",
			]);

			expect(dryRun.exitCode).toBe(0);
			expect(JSON.parse(dryRun.stdout)).toEqual({
				dryRun: true,
				wouldUninstall: "hello-plugin@test-marketplace",
				scope: "user",
			});
			expectUnchanged(before, await sandbox.snapshot());
		},
		CLI_TEST_TIMEOUT_MS,
	);

	// A real uninstall keeps the migrating read: only the preview is read-only.
	it(
		"still migrates a discoverable legacy project bundle on a real uninstall",
		async () => {
			const sandbox = await makeSandbox();
			await sandbox.plantLegacyProjectBundle(legacyBundleFixture);

			const uninstall = await sandbox.run(["uninstall", "valid-skill-plugin", "--project"]);

			expect(uninstall.exitCode).toBe(0);
			expect(uninstall.stdout).toContain("Uninstalled valid-skill-plugin (project)");
			expect(JSON.parse((await sandbox.run(["list", "--json"])).stdout)).toMatchObject({ gjc: [] });
		},
		CLI_TEST_TIMEOUT_MS,
	);

	// Guardrail: the fix must not turn a real uninstall into a no-op.
	it(
		"still removes a marketplace plugin without --dry-run",
		async () => {
			const sandbox = await makeSandbox();
			expect((await sandbox.run(["marketplace", "add", marketplaceFixture])).exitCode).toBe(0);
			expect((await sandbox.run(["install", "hello-plugin@test-marketplace", "--scope", "user"])).exitCode).toBe(0);

			const uninstall = await sandbox.run([
				"uninstall",
				"hello-plugin@test-marketplace",
				"--scope",
				"user",
				"--json",
			]);

			expect(uninstall.exitCode).toBe(0);
			expect(JSON.parse(uninstall.stdout)).toEqual({ uninstalled: "hello-plugin@test-marketplace" });
			expect(JSON.parse((await sandbox.run(["list", "--json"])).stdout)).toMatchObject({ marketplace: [] });
		},
		CLI_TEST_TIMEOUT_MS,
	);

	it(
		"still removes a GJC bundle without --dry-run",
		async () => {
			const sandbox = await makeSandbox();
			expect((await sandbox.run(["install", gjcBundleFixture, "--user"])).exitCode).toBe(0);

			const uninstall = await sandbox.run(["uninstall", "valid-six-surface-bundle", "--user"]);

			expect(uninstall.exitCode).toBe(0);
			expect(uninstall.stdout).toContain("Uninstalled valid-six-surface-bundle (user)");
			expect(JSON.parse((await sandbox.run(["list", "--json"])).stdout)).toMatchObject({ gjc: [] });
		},
		CLI_TEST_TIMEOUT_MS,
	);
});
