import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	InstalledPluginsRegistry,
	MarketplacesRegistry,
} from "@gajae-code/coding-agent/extensibility/plugins/marketplace";
import {
	writeInstalledPluginsRegistry,
	writeMarketplacesRegistry,
} from "@gajae-code/coding-agent/extensibility/plugins/marketplace";

const installed = (): InstalledPluginsRegistry => ({ version: 2, plugins: {} });
const markets = (): MarketplacesRegistry => ({ version: 1, marketplaces: [] });

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-mkt-tmp-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function registryPath(): string {
	return path.join(dir, "installed_plugins.json");
}

test("still allows a new ordinary registry write", async () => {
	const file = registryPath();
	await writeInstalledPluginsRegistry(file, installed());
	expect(fs.readFileSync(file, "utf8")).toContain('"version": 2');
	expect(fs.lstatSync(file).isFile()).toBe(true);
	expect(fs.existsSync(`${file}.tmp`)).toBe(false);
});

test("still allows replacing an existing ordinary registry file", async () => {
	const file = registryPath();
	await writeInstalledPluginsRegistry(file, installed());
	await writeInstalledPluginsRegistry(file, {
		version: 2,
		plugins: {
			"plug@mkt": [
				{
					scope: "project",
					installPath: path.join(dir, "plug"),
					version: "1.0.0",
					installedAt: "2025-01-15T10:30:00.000Z",
					lastUpdated: "2025-01-15T10:30:00.000Z",
				},
			],
		},
	});
	const text = fs.readFileSync(file, "utf8");
	expect(text).toContain("plug@mkt");
	expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
});

test("still allows a write over a leftover regular temp file", async () => {
	const file = registryPath();
	fs.writeFileSync(`${file}.tmp`, "stale");
	await writeInstalledPluginsRegistry(file, installed());
	const text = fs.readFileSync(file, "utf8");
	expect(text).toContain('"version": 2');
	expect(text).not.toContain("stale");
	expect(fs.existsSync(`${file}.tmp`)).toBe(false);
});

test("keeps a directory that already occupies the registry temp path", async () => {
	const file = registryPath();
	const blocker = `${file}.tmp`;
	fs.mkdirSync(blocker);
	fs.writeFileSync(path.join(blocker, "marker"), "keep");
	await expect(writeInstalledPluginsRegistry(file, installed())).rejects.toThrow();
	expect(fs.readFileSync(path.join(blocker, "marker"), "utf8")).toBe("keep");
	expect(fs.existsSync(file)).toBe(false);
});

test.skipIf(process.platform === "win32")("keeps the target of a symlinked registry path unchanged", async () => {
	const victim = path.join(dir, "victim");
	fs.writeFileSync(victim, "ORIGINAL USER CONTENT\n");
	const file = registryPath();
	fs.symlinkSync(victim, file);
	await writeInstalledPluginsRegistry(file, installed());
	expect(fs.readFileSync(victim, "utf8")).toBe("ORIGINAL USER CONTENT\n");
	expect(fs.lstatSync(file).isFile()).toBe(true);
	expect(fs.readFileSync(file, "utf8")).toContain('"version": 2');
});

test("still allows an installed registry write when parent directories are missing", async () => {
	const file = path.join(dir, "nested", "plugins", "installed_plugins.json");
	await writeInstalledPluginsRegistry(file, installed());
	expect(fs.readFileSync(file, "utf8")).toContain('"version": 2');
	expect(fs.existsSync(`${file}.tmp`)).toBe(false);
});

test("still allows a marketplaces registry write when parent directories are missing", async () => {
	const file = path.join(dir, "nested", "market", "marketplaces.json");
	await writeMarketplacesRegistry(file, markets());
	expect(fs.readFileSync(file, "utf8")).toContain('"version": 1');
	expect(fs.existsSync(`${file}.tmp`)).toBe(false);
});

test("still allows a marketplaces registry write", async () => {
	const file = path.join(dir, "marketplaces.json");
	await writeMarketplacesRegistry(file, markets());
	expect(fs.readFileSync(file, "utf8")).toContain('"version": 1');
	expect(fs.lstatSync(file).isFile()).toBe(true);
});

test.skipIf(process.platform === "win32")("does not follow a preexisting registry temp symlink", async () => {
	const victim = path.join(dir, "victim");
	fs.writeFileSync(victim, "ORIGINAL USER CONTENT\n");
	const file = registryPath();
	fs.symlinkSync(victim, `${file}.tmp`);
	await writeInstalledPluginsRegistry(file, installed());
	expect(fs.readFileSync(victim, "utf8")).toBe("ORIGINAL USER CONTENT\n");
	const st = fs.lstatSync(file);
	expect(st.isSymbolicLink()).toBe(false);
	expect(st.isFile()).toBe(true);
	expect((st.mode & 0o777) === 0o600).toBe(true);
	expect(fs.readFileSync(file, "utf8")).toContain('"version": 2');
});

test.skipIf(process.platform === "win32")(
	"does not truncate a file hard-linked from the registry temp path",
	async () => {
		const victim = path.join(dir, "victim");
		fs.writeFileSync(victim, "ORIGINAL USER CONTENT\n");
		const file = registryPath();
		fs.linkSync(victim, `${file}.tmp`);
		await writeInstalledPluginsRegistry(file, installed());
		expect(fs.readFileSync(victim, "utf8")).toBe("ORIGINAL USER CONTENT\n");
		expect(fs.readFileSync(file, "utf8")).toContain('"version": 2');
		expect(fs.lstatSync(file).ino).not.toBe(fs.lstatSync(victim).ino);
	},
);
