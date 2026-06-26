import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	GjcPluginLoadError,
	installGjcPluginBundle,
	isGjcPluginBundleSource,
	readRegistry,
} from "../src/extensibility/gjc-plugins";

const fixturesRoot = path.join(import.meta.dir, "fixtures", "gjc-plugins");
const sixSurface = path.join(fixturesRoot, "valid-six-surface-bundle");
const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function mkProjectCwd(): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-install-"));
	tempDirs.push(cwd);
	return cwd;
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

describe("GJC plugin installer", () => {
	test("installs a local-path bundle into the project scope", async () => {
		const cwd = await mkProjectCwd();
		const result = await installGjcPluginBundle(sixSurface, { scope: "project", cwd });
		expect(result.status).toBe("installed");

		const installedDir = path.join(cwd, ".gjc", "gjc-plugins", "valid-six-surface-bundle");
		expect(await exists(path.join(installedDir, "gajae-plugin.json"))).toBe(true);

		const registry = await readRegistry("project", cwd);
		expect(registry.plugins.map(p => p.name)).toEqual(["valid-six-surface-bundle"]);
		expect(registry.plugins[0]?.surfaces.tools[0]?.name).toBe("domain_note");
	});

	test("reinstalling identical content is a no-op", async () => {
		const cwd = await mkProjectCwd();
		await installGjcPluginBundle(sixSurface, { scope: "project", cwd });
		const second = await installGjcPluginBundle(sixSurface, { scope: "project", cwd });
		expect(second.status).toBe("unchanged");
	});

	test("reinstalling different content requires --force", async () => {
		const cwd = await mkProjectCwd();
		await installGjcPluginBundle(sixSurface, { scope: "project", cwd });

		// Make a modified copy with the same plugin name but different content.
		const modified = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-modsrc-"));
		tempDirs.push(modified);
		await fs.cp(sixSurface, modified, { recursive: true });
		await fs.appendFile(path.join(modified, "prompts", "system-appendix.md"), "\nExtra policy line.\n");

		await expect(installGjcPluginBundle(modified, { scope: "project", cwd })).rejects.toMatchObject({
			code: "install_conflict",
		});

		const forced = await installGjcPluginBundle(modified, { scope: "project", cwd, force: true });
		expect(forced.status).toBe("updated");
	});

	test("a bad bundle leaves no files and no registry entry", async () => {
		const cwd = await mkProjectCwd();
		const bad = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-bad-"));
		tempDirs.push(bad);
		await fs.writeFile(
			path.join(bad, "gajae-plugin.json"),
			JSON.stringify({ kind: "gajae-code-plugin", name: "bad-bundle", version: "1.0.0", agents: [] }),
		);
		await expect(installGjcPluginBundle(bad, { scope: "project", cwd })).rejects.toBeInstanceOf(GjcPluginLoadError);

		expect(await exists(path.join(cwd, ".gjc", "gjc-plugins", "bad-bundle"))).toBe(false);
		const registry = await readRegistry("project", cwd);
		expect(registry.plugins).toEqual([]);
	});

	test("install never imports plugin code", async () => {
		const cwd = await mkProjectCwd();
		const sentinelDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-install-sentinel-"));
		tempDirs.push(sentinelDir);
		const sentinel = path.join(sentinelDir, "sentinel.txt");
		const prev = process.env.GJC_TEST_IMPORT_SENTINEL;
		process.env.GJC_TEST_IMPORT_SENTINEL = sentinel;
		try {
			await installGjcPluginBundle(sixSurface, { scope: "project", cwd });
		} finally {
			if (prev === undefined) delete process.env.GJC_TEST_IMPORT_SENTINEL;
			else process.env.GJC_TEST_IMPORT_SENTINEL = prev;
		}
		expect(await exists(sentinel)).toBe(false);
	});

	test("installs from a tarball through the same validate step", async () => {
		const cwd = await mkProjectCwd();
		const tarDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tar-"));
		tempDirs.push(tarDir);
		const tarball = path.join(tarDir, "bundle.tar.gz");
		// Pack the fixture contents at the archive root.
		const res = spawnSync("tar", ["-czf", tarball, "-C", sixSurface, "."], {
			env: { ...process.env, COPYFILE_DISABLE: "1" },
		});
		if (res.status !== 0) {
			// tar unavailable in this environment; skip without failing the suite.
			return;
		}
		const result = await installGjcPluginBundle(tarball, { scope: "project", cwd });
		expect(result.status).toBe("installed");
		expect(await isGjcPluginBundleSource(tarball)).toBe(true);
		const registry = await readRegistry("project", cwd);
		expect(registry.plugins[0]?.source.kind).toBe("tarball");
	});
});
