import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isConfigHotReloadTrusted } from "../../src/config/config-hot-reload-trust";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "config-hot-reload-trust-"));
	await fs.chmod(directory, 0o700);
	temporaryDirectories.push(directory);
	return directory;
}

function configPaths(directory: string) {
	return {
		configPath: path.join(directory, "config.yaml"),
		modelsPath: path.join(directory, "models.json"),
	};
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("interactive configuration reload path trust", () => {
	test.skipIf(process.platform !== "linux")("accepts private temporary config and models directories", async () => {
		const directory = await temporaryDirectory();
		expect(await isConfigHotReloadTrusted(configPaths(directory))).toBe(true);
	});

	test.skipIf(process.platform !== "linux")("rejects a group-writable non-sticky ancestor", async () => {
		const root = await temporaryDirectory();
		const shared = path.join(root, "shared");
		const privateLeaf = path.join(shared, "private");
		await fs.mkdir(shared);
		await fs.chmod(shared, 0o770);
		await fs.mkdir(privateLeaf, { mode: 0o700 });
		await fs.chmod(privateLeaf, 0o700);
		expect(await isConfigHotReloadTrusted(configPaths(privateLeaf))).toBe(false);
	});

	test.skipIf(process.platform !== "linux")("rejects an unsafe canonical target of a config symlink", async () => {
		const root = await temporaryDirectory();
		const privateLeaf = path.join(root, "private");
		const shared = path.join(root, "shared");
		await fs.mkdir(privateLeaf, { mode: 0o700 });
		await fs.chmod(privateLeaf, 0o700);
		await fs.mkdir(shared);
		await fs.chmod(shared, 0o770);
		const configPath = path.join(privateLeaf, "config.yaml");
		await fs.writeFile(path.join(shared, "target.yaml"), "providers: {}\n");
		await fs.symlink(path.join(shared, "target.yaml"), configPath);
		expect(
			await isConfigHotReloadTrusted({
				configPath,
				modelsPath: path.join(privateLeaf, "models.json"),
			}),
		).toBe(false);
	});

	test.skipIf(process.platform !== "linux" || typeof process.getuid !== "function" || process.getuid() !== 0)(
		"rejects a foreign-owned effective config parent",
		async () => {
			const root = await temporaryDirectory();
			const foreign = path.join(root, "foreign");
			await fs.mkdir(foreign, { mode: 0o700 });
			await fs.chmod(foreign, 0o700);
			await fs.chown(foreign, 65534, 65534);
			expect(await isConfigHotReloadTrusted(configPaths(foreign))).toBe(false);
		},
	);

	test("fails closed when either path is not absolute or its parent cannot be resolved", async () => {
		const directory = await temporaryDirectory();
		expect(
			await isConfigHotReloadTrusted({
				configPath: path.join(directory, "config.yaml"),
				modelsPath: "relative-models.json",
			}),
		).toBe(false);
		expect(await isConfigHotReloadTrusted(configPaths(path.join(directory, "missing")))).toBe(false);
	});
});
