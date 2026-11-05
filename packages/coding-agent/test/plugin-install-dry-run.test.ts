import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const cliEntry = path.join(import.meta.dir, "../src/cli.ts");
const gjcBundleFixture = path.join(import.meta.dir, "fixtures/gjc-plugins/valid-six-surface-bundle");

const sandboxes: string[] = [];

interface Sandbox {
	home: string;
	cwd: string;
	run: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
	snapshot: () => Promise<Map<string, string>>;
}

/**
 * A `gjc plugin` command resolves user-scope state from HOME, not only from the
 * agent directory: the marketplace registry lives under `<home>/.gjc` and the
 * plugin cache under the plugins dir. Overriding GJC_CODING_AGENT_DIR alone
 * would leave these tests writing into the developer's real home.
 */
async function makeSandbox(): Promise<Sandbox> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-plugin-install-dry-run-"));
	sandboxes.push(root);
	const home = path.join(root, "home");
	const cwd = path.join(root, "project");
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
		BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
	};

	return {
		home,
		cwd,
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

describe("plugin install --dry-run", () => {
	afterEach(async () => {
		for (const dir of sandboxes.splice(0)) await fs.rm(dir, { recursive: true, force: true });
	});

	// The reported issue: --dry-run copies the bundle and writes a registry entry,
	// and a second identical run fails with "already installed".
	it(
		"previews a GJC bundle install without copying the bundle or writing a registry entry",
		async () => {
			const sandbox = await makeSandbox();
			const before = await sandbox.snapshot();

			const dryRun = await sandbox.run(["install", gjcBundleFixture, "--user", "--dry-run", "--json"]);

			expect(dryRun.exitCode).toBe(0);
			expect(dryRun.stderr).toBe("");
			const result = JSON.parse(dryRun.stdout);
			expect(result.dryRun).toBe(true);
			expect(result.wouldInstall).toBeDefined();
			expect(result.wouldInstall.identity.name).toBe("valid-six-surface-bundle");

			// Verify nothing was written to disk
			expectUnchanged(before, await sandbox.snapshot());

			// Running the same dry-run again should succeed
			const dryRunAgain = await sandbox.run(["install", gjcBundleFixture, "--user", "--dry-run"]);
			expect(dryRunAgain.exitCode).toBe(0);
			expect(dryRunAgain.stdout).toContain("[dry-run] Would install");
		},
		CLI_TEST_TIMEOUT_MS,
	);

	it(
		"reports a GJC bundle dry run as a preview in human output",
		async () => {
			const sandbox = await makeSandbox();
			const before = await sandbox.snapshot();

			const dryRun = await sandbox.run(["install", gjcBundleFixture, "--user", "--dry-run"]);

			expect(dryRun.exitCode).toBe(0);
			expect(dryRun.stdout).toContain("[dry-run] Would install");
			expect(dryRun.stdout).not.toMatch(/\binstalled\b/i);
			expectUnchanged(before, await sandbox.snapshot());
		},
		CLI_TEST_TIMEOUT_MS,
	);

	// Guardrail: the fix must not turn a real install into a no-op.
	it(
		"still installs a GJC bundle without --dry-run",
		async () => {
			const sandbox = await makeSandbox();

			const install = await sandbox.run(["install", gjcBundleFixture, "--user"]);

			expect(install.exitCode).toBe(0);
			expect(install.stdout).toContain("installed");
			expect(JSON.parse((await sandbox.run(["list", "--json"])).stdout)).toMatchObject({
				gjc: expect.arrayContaining([
					expect.objectContaining({ identity: expect.objectContaining({ name: "valid-six-surface-bundle" }) }),
				]),
			});
		},
		CLI_TEST_TIMEOUT_MS,
	);

	it(
		"sanitizes terminal control characters in error output",
		async () => {
			const sandbox = await makeSandbox();
			// Create a malicious bundle with terminal control characters in the manifest
			const tempBundleDir = await fs.mkdtemp(path.join(sandbox.home, "malicious-bundle-"));
			try {
				// Create a minimal manifest with an ESC character (\u001b) in a field name
				const maliciousManifest = {
					name: "malicious-bundle",
					version: "1.0.0",
					"unknown\u001b[2Jfield": "should be sanitized",
					plugins: [],
				};
				await fs.writeFile(path.join(tempBundleDir, "gjc.json"), JSON.stringify(maliciousManifest));

				const result = await sandbox.run(["install", tempBundleDir, "--user", "--dry-run", "--json"]);
				// Should fail due to invalid schema, but the output should not contain the raw control character
				expect(result.exitCode).not.toBe(0);
				// The error message should be sanitized (control characters removed)
				expect(result.stdout + result.stderr).not.toContain("\u001b[2J");
			} finally {
				await fs.rm(tempBundleDir, { recursive: true, force: true });
			}
		},
		CLI_TEST_TIMEOUT_MS,
	);

	it(
		"returns invalid_target error code for validation failures (not source_unavailable)",
		async () => {
			const sandbox = await makeSandbox();
			// Create a bundle with a non-existent file to trigger missing_file error
			const tempBundleDir = await fs.mkdtemp(path.join(sandbox.home, "invalid-bundle-"));
			try {
				const manifest = {
					name: "invalid-bundle",
					version: "1.0.0",
					plugins: [
						{
							name: "test-plugin",
							root: "./plugins/missing",
						},
					],
				};
				await fs.writeFile(path.join(tempBundleDir, "gjc.json"), JSON.stringify(manifest));

				const result = await sandbox.run(["install", tempBundleDir, "--user", "--dry-run", "--json"]);
				// Should fail with a validation error
				expect(result.exitCode).not.toBe(0);
				const errorOutput = JSON.parse(result.stdout || result.stderr);
				// Error code should be invalid_target (for validation failures), not source_unavailable
				if (typeof errorOutput === "object" && errorOutput !== null && "error" in errorOutput) {
					expect(errorOutput.error.code).toBe("invalid_target");
				}
			} finally {
				await fs.rm(tempBundleDir, { recursive: true, force: true });
			}
		},
		CLI_TEST_TIMEOUT_MS,
	);
});
