import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { GjcPluginLoadError, installGjcPluginBundle, readRegistry } from "../src/extensibility/gjc-plugins";

const tempDirs: string[] = [];
const fixtureRoot = path.join(import.meta.dir, "fixtures", "gjc-plugins", "valid-six-surface-bundle");
const fixtureFiles = [
	"gajae-plugin.json",
	"subskills/design/SKILL.md",
	"tools/domain-note.ts",
	"hooks/audit-read.ts",
	"mcp/domain-docs.ts",
	"prompts/system-appendix.md",
	"prompts/executor-appendix.md",
];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function mkTempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function mkProjectCwd(): Promise<string> {
	return await mkTempDir("gjc-m2-redteam-project-");
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

async function listEntries(root: string): Promise<string[]> {
	try {
		return await fs.readdir(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

interface TarEntry {
	name: string;
	data?: string | Uint8Array;
	typeflag?: string;
	linkname?: string;
}

function writeOctal(header: Buffer, value: number, offset: number, length: number): void {
	const text = value
		.toString(8)
		.padStart(length - 1, "0")
		.slice(-(length - 1));
	header.write(text, offset, length - 1, "ascii");
	header[offset + length - 1] = 0;
}

function tarHeader(entry: TarEntry, size: number): Buffer {
	if (Buffer.byteLength(entry.name) > 100) throw new Error(`tar test entry name too long: ${entry.name}`);
	const header = Buffer.alloc(512);
	header.write(entry.name, 0, 100, "utf8");
	writeOctal(header, 0o644, 100, 8);
	writeOctal(header, 0, 108, 8);
	writeOctal(header, 0, 116, 8);
	writeOctal(header, size, 124, 12);
	writeOctal(header, 0, 136, 12);
	header.fill(0x20, 148, 156);
	header.write(entry.typeflag ?? "0", 156, 1, "ascii");
	if (entry.linkname !== undefined) header.write(entry.linkname, 157, 100, "utf8");
	header.write("ustar", 257, 6, "ascii");
	header.write("00", 263, 2, "ascii");
	let checksum = 0;
	for (const byte of header) checksum += byte;
	const checksumText = checksum.toString(8).padStart(6, "0");
	header.write(checksumText, 148, 6, "ascii");
	header[154] = 0;
	header[155] = 0x20;
	return header;
}

function makeTar(entries: TarEntry[]): Buffer {
	const chunks: Buffer[] = [];
	for (const entry of entries) {
		const data = entry.data === undefined ? Buffer.alloc(0) : Buffer.from(entry.data);
		chunks.push(tarHeader(entry, data.byteLength), data);
		const padding = (512 - (data.byteLength % 512)) % 512;
		if (padding > 0) chunks.push(Buffer.alloc(padding));
	}
	chunks.push(Buffer.alloc(1024));
	return Buffer.concat(chunks);
}

async function writeTarball(entries: TarEntry[], options: { gzip?: boolean } = {}): Promise<string> {
	const dir = await mkTempDir("gjc-m2-redteam-tar-");
	const tar = makeTar(entries);
	const file = path.join(dir, options.gzip ? "bundle.tar.gz" : "bundle.tar");
	await fs.writeFile(file, options.gzip ? gzipSync(tar) : tar);
	return file;
}

async function validBundleTarball(options: { prefix?: string; gzip?: boolean } = {}): Promise<string> {
	const prefix = options.prefix ?? "";
	const entries: TarEntry[] = [];
	for (const rel of fixtureFiles) {
		entries.push({ name: `${prefix}${rel}`, data: await fs.readFile(path.join(fixtureRoot, rel)) });
	}
	return await writeTarball(entries, { gzip: options.gzip });
}

async function makeBundleCopy(name: string, extra?: (dir: string) => Promise<void>): Promise<string> {
	const dir = await mkTempDir("gjc-m2-redteam-bundle-");
	await fs.cp(fixtureRoot, dir, { recursive: true });
	const manifestPath = path.join(dir, "gajae-plugin.json");
	const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
	manifest.name = name;
	await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	if (extra) await extra(dir);
	return dir;
}

describe("GJC plugin installer M2 red-team", () => {
	test("rejects a tarball traversal entry and writes nothing outside extraction root", async () => {
		const cwd = await mkProjectCwd();
		const escapeTarget = path.join(os.tmpdir(), "escape.txt");
		await fs.rm(escapeTarget, { force: true });
		const tarball = await writeTarball([{ name: "../escape.txt", data: "owned" }]);

		await expect(installGjcPluginBundle(tarball, { scope: "project", cwd })).rejects.toMatchObject({
			code: "security_policy",
		});
		expect(await exists(escapeTarget)).toBe(false);
		expect(await readRegistry("project", cwd)).toMatchObject({ plugins: [] });
	});

	test("rejects a tarball absolute-path entry", async () => {
		const cwd = await mkProjectCwd();
		const tarball = await writeTarball([{ name: "/etc/evil", data: "owned" }], { gzip: true });

		await expect(installGjcPluginBundle(tarball, { scope: "project", cwd })).rejects.toMatchObject({
			code: "security_policy",
		});
		expect(await readRegistry("project", cwd)).toMatchObject({ plugins: [] });
	});

	test("rejects a tarball symlink entry that could escape root", async () => {
		const cwd = await mkProjectCwd();
		const tarball = await writeTarball([{ name: "bundle-link", typeflag: "2", linkname: "../../escape" }]);

		await expect(installGjcPluginBundle(tarball, { scope: "project", cwd })).rejects.toMatchObject({
			code: "security_policy",
		});
		expect(await readRegistry("project", cwd)).toMatchObject({ plugins: [] });
	});

	test("rejects a tarball whose root and first-level directories lack gajae-plugin.json", async () => {
		const cwd = await mkProjectCwd();
		const tarball = await writeTarball([
			{ name: "not-a-plugin/readme.txt", data: "no manifest here" },
			{ name: "also-not-a-plugin/nested/file.txt", data: "still no manifest" },
		]);

		await expect(installGjcPluginBundle(tarball, { scope: "project", cwd })).rejects.toMatchObject({
			code: "missing_file",
		});
		expect(await readRegistry("project", cwd)).toMatchObject({ plugins: [] });
	});

	test("installs a valid gzipped tarball whose bundle root is a subdirectory", async () => {
		const cwd = await mkProjectCwd();
		const tarball = await validBundleTarball({ prefix: "nested-plugin/", gzip: true });

		const result = await installGjcPluginBundle(tarball, { scope: "project", cwd });

		expect(result.status).toBe("installed");
		const registry = await readRegistry("project", cwd);
		expect(registry.plugins.map(plugin => plugin.name)).toEqual(["valid-six-surface-bundle"]);
		expect(registry.plugins[0]?.source.kind).toBe("tarball");
		expect(await exists(path.join(cwd, ".gjc", "gjc-plugins", "valid-six-surface-bundle", "gajae-plugin.json"))).toBe(
			true,
		);
	});

	test("install of a forbidden-surface bundle leaves no scope files and no registry entry", async () => {
		const cwd = await mkProjectCwd();
		const bad = await mkTempDir("gjc-m2-redteam-bad-");
		await fs.writeFile(
			path.join(bad, "gajae-plugin.json"),
			JSON.stringify({ kind: "gajae-code-plugin", name: "forbidden-bundle", version: "1.0.0", commands: [] }),
		);

		await expect(installGjcPluginBundle(bad, { scope: "project", cwd })).rejects.toMatchObject({
			code: "forbidden_surface",
		});
		expect(await listEntries(path.join(cwd, ".gjc", "gjc-plugins"))).toEqual([]);
		expect(await readRegistry("project", cwd)).toMatchObject({ plugins: [] });
	});

	test("reinstall identical content is unchanged, changed content conflicts, and force updates", async () => {
		const cwd = await mkProjectCwd();
		const original = await makeBundleCopy("m2-reinstall-bundle");
		const modified = await makeBundleCopy("m2-reinstall-bundle", async dir => {
			await fs.appendFile(path.join(dir, "prompts", "system-appendix.md"), "\nChanged content.\n");
		});

		expect((await installGjcPluginBundle(original, { scope: "project", cwd })).status).toBe("installed");
		expect((await installGjcPluginBundle(original, { scope: "project", cwd })).status).toBe("unchanged");
		await expect(installGjcPluginBundle(modified, { scope: "project", cwd })).rejects.toMatchObject({
			code: "install_conflict",
		});
		expect((await installGjcPluginBundle(modified, { scope: "project", cwd, force: true })).status).toBe("updated");
		const installedPrompt = await fs.readFile(
			path.join(cwd, ".gjc", "gjc-plugins", "m2-reinstall-bundle", "prompts", "system-appendix.md"),
			"utf8",
		);
		expect(installedPrompt).toContain("Changed content.");
	});

	test("concurrent installs of the same bundle leave exactly one registry entry", async () => {
		const cwd = await mkProjectCwd();
		const bundle = await makeBundleCopy("m2-concurrent-bundle");

		const results = await Promise.allSettled([
			installGjcPluginBundle(bundle, { scope: "project", cwd }),
			installGjcPluginBundle(bundle, { scope: "project", cwd }),
		]);
		for (const result of results) {
			if (result.status === "rejected" && result.reason instanceof GjcPluginLoadError) {
				expect(result.reason.code).toBe("install_conflict");
			} else {
				expect(result.status).toBe("fulfilled");
			}
		}

		const registry = await readRegistry("project", cwd);
		expect(registry.plugins.map(plugin => plugin.name)).toEqual(["m2-concurrent-bundle"]);
		expect(await exists(path.join(cwd, ".gjc", "gjc-plugins", "m2-concurrent-bundle", "gajae-plugin.json"))).toBe(
			true,
		);
	});
});
