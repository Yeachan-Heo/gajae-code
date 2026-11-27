import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import fc from "fast-check";
import { installedPluginNames } from "../src/extensibility/plugins/installed-names";

const cliEntry = path.join(import.meta.dir, "../src/cli.ts");
const loaderEntry = path.join(import.meta.dir, "../src/extensibility/plugins/loader.ts");

const roots: string[] = [];

interface Sandbox {
	home: string;
	plugin: string;
	pluginsDir: string;
	cli: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
	/** What a session start would load, read through the real loader in an isolated process. */
	enabled: () => Promise<{ names: string[]; hooks: string[] }>;
	customize: () => Promise<{ items: Array<{ name: string; status: string; reason: string }> }>;
}

/** HOME and the agent directory are both redirected: plugin state resolves from either. */
async function makeSandbox(): Promise<Sandbox> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-plugin-link-"));
	roots.push(root);
	const home = path.join(root, "home");
	const cwd = path.join(root, "project");
	const plugin = path.join(root, "probe-hook");
	const agentDir = path.join(home, ".gjc", "agent");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(plugin, { recursive: true });
	await fs.writeFile(
		path.join(plugin, "package.json"),
		JSON.stringify({ name: "jjo-probe-hook", version: "0.0.1", gjc: { version: "0.0.1", hooks: "./hook.ts" } }),
	);
	await fs.writeFile(path.join(plugin, "hook.ts"), "export default function () {}\n");

	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: path.join(home, "config"),
		XDG_DATA_HOME: path.join(home, "data"),
		XDG_STATE_HOME: path.join(home, "state"),
		XDG_CACHE_HOME: path.join(root, "cache"),
		GJC_CONFIG_DIR: ".gjc",
		GJC_CODING_AGENT_DIR: agentDir,
		PI_CODING_AGENT_DIR: agentDir,
		NO_COLOR: "1",
		PI_NO_TITLE: "1",
		BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
	};
	const spawn = async (cmd: string[]) => {
		const proc = Bun.spawn({ cmd, cwd, env, stdout: "pipe", stderr: "pipe" });
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		return { exitCode, stdout, stderr };
	};

	const customizeEntry = path.join(import.meta.dir, "../src/cli/customize-doctor.ts");
	return {
		home,
		plugin,
		customize: async () => {
			const script = `import { runCustomizeDoctor } from ${JSON.stringify(customizeEntry)};
const report = await runCustomizeDoctor(process.cwd());
console.log(JSON.stringify({ items: report.surfaces.flatMap(surface => surface.items).map(i => ({ name: i.name, status: i.status, reason: i.reason })) }));`;
			const result = await spawn([process.execPath, "-e", script]);
			if (result.exitCode !== 0) throw new Error(result.stderr);
			return JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}");
		},
		pluginsDir: path.join(home, ".gjc", "plugins"),
		cli: args => spawn([process.execPath, cliEntry, "plugin", ...args]),
		enabled: async () => {
			const script = `import { getAllPluginHookPaths, getEnabledPlugins } from ${JSON.stringify(loaderEntry)};
const cwd = process.cwd();
console.log(JSON.stringify({ names: (await getEnabledPlugins(cwd)).map(p => p.name), hooks: await getAllPluginHookPaths(cwd) }));`;
			const result = await spawn([process.execPath, "-e", script]);
			expect(result.stderr).toBe("");
			return JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}");
		},
	};
}

const CLI_TEST_TIMEOUT_MS = 30_000;

describe("installedPluginNames", () => {
	it("adds linked plugins to the registry dependencies without duplicating", () => {
		expect(
			installedPluginNames(
				{ "from-registry": "1.0.0", both: "1.0.0" },
				{ plugins: { both: { linked: true }, linked: { linked: true }, "enabled-only": {} } },
			).sort(),
		).toEqual(["both", "from-registry", "linked"]);
	});

	it("treats a missing package.json and a missing lock as nothing installed", () => {
		expect(installedPluginNames(undefined, { plugins: undefined })).toEqual([]);
	});
});

describe("installedPluginNames properties", () => {
	const pluginName = fc.stringMatching(/^(@[a-z][a-z0-9-]{0,6}\/)?[a-z][a-z0-9_-]{0,10}$/);
	const dependencies = fc.uniqueArray(pluginName, { maxLength: 8 });
	const runtimeEntries = fc.uniqueArray(
		fc.record({ name: pluginName, linked: fc.constantFrom(true, false, undefined) }),
		{
			maxLength: 8,
			selector: entry => entry.name,
		},
	);

	function build(deps: string[], entries: Array<{ name: string; linked: boolean | undefined }>) {
		return {
			dependencies: Object.fromEntries(deps.map(name => [name, "1.0.0"])),
			runtimeConfig: { plugins: Object.fromEntries(entries.map(e => [e.name, { linked: e.linked }])) },
		};
	}

	it("is exactly the union of dependency names and linked names, with no duplicates", () => {
		fc.assert(
			fc.property(dependencies, runtimeEntries, (deps, entries) => {
				const input = build(deps, entries);
				const result = installedPluginNames(input.dependencies, input.runtimeConfig);
				const expected = new Set([...deps, ...entries.filter(e => e.linked === true).map(e => e.name)]);
				expect(new Set(result)).toEqual(expected);
				expect(result.length).toBe(expected.size);
			}),
		);
	});

	it("keeps every dependency name and never reports a runtime entry that is neither linked nor a dependency", () => {
		fc.assert(
			fc.property(dependencies, runtimeEntries, (deps, entries) => {
				const input = build(deps, entries);
				const result = new Set(installedPluginNames(input.dependencies, input.runtimeConfig));
				for (const name of deps) expect(result.has(name)).toBe(true);
				for (const entry of entries) {
					if (entry.linked !== true && !deps.includes(entry.name)) expect(result.has(entry.name)).toBe(false);
				}
			}),
		);
	});

	it("does not depend on the order of its inputs", () => {
		fc.assert(
			fc.property(dependencies, runtimeEntries, (deps, entries) => {
				const forward = build(deps, entries);
				const reversed = build([...deps].reverse(), [...entries].reverse());
				expect(new Set(installedPluginNames(reversed.dependencies, reversed.runtimeConfig))).toEqual(
					new Set(installedPluginNames(forward.dependencies, forward.runtimeConfig)),
				);
			}),
		);
	});
});

describe("plugin link", () => {
	afterEach(async () => {
		for (const dir of roots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
	});

	// The reported issue: `link` printed success, then `list`, `doctor` and a fresh session
	// all agreed that nothing was installed, because only package.json dependencies were read.
	it(
		"makes a linked plugin visible to list, doctor and the session loader alike",
		async () => {
			const sandbox = await makeSandbox();

			const link = await sandbox.cli(["link", sandbox.plugin]);
			expect(link.exitCode).toBe(0);
			expect(link.stdout).toContain("Linked jjo-probe-hook");

			const list = await sandbox.cli(["list", "--json"]);
			expect(list.exitCode).toBe(0);
			expect(JSON.parse(list.stdout).npm.map((p: { name: string }) => p.name)).toEqual(["jjo-probe-hook"]);

			const doctor = await sandbox.cli(["doctor", "--json"]);
			expect(doctor.exitCode).toBe(0);
			const checks = JSON.parse(doctor.stdout) as Array<{ name: string; status: string }>;
			expect(checks.find(check => check.name === "plugin:jjo-probe-hook")?.status).toBe("ok");
			expect(checks.some(check => check.status === "error")).toBe(false);

			const loaded = await sandbox.enabled();
			expect(loaded.names).toEqual(["jjo-probe-hook"]);
			expect(loaded.hooks).toEqual([path.join(sandbox.pluginsDir, "node_modules", "jjo-probe-hook", "hook.ts")]);
		},
		CLI_TEST_TIMEOUT_MS,
	);

	it(
		"honours disable, and re-linking does not duplicate the plugin",
		async () => {
			const sandbox = await makeSandbox();
			expect((await sandbox.cli(["link", sandbox.plugin])).exitCode).toBe(0);
			expect((await sandbox.cli(["link", sandbox.plugin])).exitCode).toBe(0);

			expect((await sandbox.enabled()).names).toEqual(["jjo-probe-hook"]);
			expect((await sandbox.cli(["disable", "jjo-probe-hook"])).exitCode).toBe(0);
			expect((await sandbox.enabled()).names).toEqual([]);
			expect((await sandbox.cli(["enable", "jjo-probe-hook"])).exitCode).toBe(0);
			expect((await sandbox.enabled()).names).toEqual(["jjo-probe-hook"]);
		},
		CLI_TEST_TIMEOUT_MS,
	);

	// `bun remove` exits 0 for a name that is not a dependency and leaves the symlink, so an
	// uninstall that only shells out would report success while the plugin kept loading.
	it(
		"uninstall removes the symlink and the record but never the linked checkout",
		async () => {
			const sandbox = await makeSandbox();
			expect((await sandbox.cli(["link", sandbox.plugin])).exitCode).toBe(0);

			const uninstall = await sandbox.cli(["uninstall", "jjo-probe-hook", "--user"]);
			expect(uninstall.exitCode).toBe(0);

			const symlink = path.join(sandbox.pluginsDir, "node_modules", "jjo-probe-hook");
			await expect(fs.lstat(symlink)).rejects.toMatchObject({ code: "ENOENT" });
			expect((await sandbox.enabled()).names).toEqual([]);
			// No bun involvement, so no package.json appears as a side effect either.
			await expect(fs.lstat(path.join(sandbox.pluginsDir, "package.json"))).rejects.toMatchObject({
				code: "ENOENT",
			});
			// The developer's working tree is the one thing unlink must not touch.
			expect(await Bun.file(path.join(sandbox.plugin, "hook.ts")).exists()).toBe(true);
			expect(await Bun.file(path.join(sandbox.plugin, "package.json")).exists()).toBe(true);
		},
		CLI_TEST_TIMEOUT_MS,
	);

	it(
		"reports nothing installed when no plugin was linked or installed",
		async () => {
			const sandbox = await makeSandbox();
			const list = await sandbox.cli(["list", "--json"]);
			expect(list.exitCode).toBe(0);
			expect(JSON.parse(list.stdout).npm).toEqual([]);
			expect((await sandbox.enabled()).names).toEqual([]);
		},
		CLI_TEST_TIMEOUT_MS,
	);
	// A linked package is not in package.json, so `bun install` cannot recreate it. With an unrelated
	// healthy dependency present, bun succeeds, and a repair that trusts the exit code reports a
	// plugin it did not restore as fixed (and exits 0) while the session loader still skips it.
	it(
		"doctor --fix does not claim a missing link was repaired when bun only reinstalled something else",
		async () => {
			const sandbox = await makeSandbox();
			expect((await sandbox.cli(["link", sandbox.plugin])).exitCode).toBe(0);
			// An unrelated registry-style dependency that bun can satisfy offline keeps package.json real.
			const other = path.join(sandbox.home, "other-dep");
			await fs.mkdir(other, { recursive: true });
			await fs.writeFile(path.join(other, "package.json"), JSON.stringify({ name: "other-dep", version: "1.0.0" }));
			await fs.writeFile(
				path.join(sandbox.pluginsDir, "package.json"),
				JSON.stringify({ name: "gjc-plugins", private: true, dependencies: { "other-dep": `file:${other}` } }),
			);
			const install = Bun.spawn(["bun", "install"], { cwd: sandbox.pluginsDir, stdout: "ignore", stderr: "ignore" });
			expect(await install.exited).toBe(0);

			// Break the link: the checkout is gone, the record remains.
			await fs.rm(path.join(sandbox.pluginsDir, "node_modules", "jjo-probe-hook"), { force: true });

			const doctor = await sandbox.cli(["doctor", "--fix", "--json"]);
			const checks = JSON.parse(doctor.stdout) as Array<{
				name: string;
				status: string;
				fixed?: boolean;
				message: string;
			}>;
			const check = checks.find(c => c.name === "plugin:jjo-probe-hook");
			expect(check?.status).toBe("error");
			expect(check?.fixed).toBeFalsy();
			expect(check?.message).toContain("gjc plugin link");
			// The loader agrees with the report: nothing was restored.
			expect((await sandbox.enabled()).names).toEqual([]);

			// Text mode must not suppress the unresolved error either: no "Fixed", non-zero exit.
			const text = await sandbox.cli(["doctor", "--fix"]);
			expect(text.stdout).not.toContain("Fixed");
			expect(text.stdout).toContain("1 errors");
			expect(text.exitCode).toBe(1);
		},
		CLI_TEST_TIMEOUT_MS,
	);
	// The loader skips a linked plugin whose symlink is gone. Calling that "disabled" sends the user to
	// `plugin enable`, which cannot restore a link.
	it(
		"customize doctor reports a link with a missing target as broken, not disabled",
		async () => {
			const sandbox = await makeSandbox();
			expect((await sandbox.cli(["link", sandbox.plugin])).exitCode).toBe(0);
			const healthy = (await sandbox.customize()).items.find(i => i.name === "jjo-probe-hook");
			expect(healthy).toMatchObject({ status: "loaded", reason: "loaded" });

			await fs.rm(path.join(sandbox.pluginsDir, "node_modules", "jjo-probe-hook"), { force: true });
			const broken = (await sandbox.customize()).items.find(i => i.name === "jjo-probe-hook");
			expect(broken).toMatchObject({ status: "rejected", reason: "load-error" });

			// A plugin the user really disabled while the link is intact stays "disabled".
			expect((await sandbox.cli(["link", sandbox.plugin])).exitCode).toBe(0);
			expect((await sandbox.cli(["disable", "jjo-probe-hook"])).exitCode).toBe(0);
			const disabled = (await sandbox.customize()).items.find(i => i.name === "jjo-probe-hook");
			expect(disabled).toMatchObject({ status: "disabled", reason: "disabled-bundle" });
		},
		CLI_TEST_TIMEOUT_MS,
	);
});
