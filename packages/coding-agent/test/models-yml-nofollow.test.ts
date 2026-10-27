import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import type { ModelProfileConfig } from "@gajae-code/coding-agent/config/models-config-schema";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { YAML } from "bun";

let tempDir: string;
let authStorage: AuthStorage;

const preset = (name: string, provider: string): ModelProfileConfig => ({
	display_name: name,
	required_providers: [provider],
	model_mapping: { default: `${provider}/gpt-custom:low` },
});

const modeOf = async (pathname: string): Promise<number> => (await fs.stat(pathname)).mode & 0o777;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-models-yml-nofollow-"));
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
});

afterEach(async () => {
	authStorage.close();
	await fs.rm(tempDir, { recursive: true, force: true });
});

describe("models.yml owner-only write", () => {
	it("still allows a regular models.yml save and a later profile", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);

		const profile = await registry.saveCustomModelProfile("my-fast", preset("my-fast", "my-oai"));

		expect(profile.displayName).toBe("my-fast");
		expect(registry.getModelProfile("my-fast")?.modelMapping.default).toBe("my-oai/gpt-custom:low");
		await fs.chmod(modelsPath, 0o600);
		await registry.saveCustomModelProfile("second", preset("second", "anthropic"));
		expect(await modeOf(modelsPath)).toBe(0o600);
		const later = YAML.parse(await Bun.file(modelsPath).text()) as {
			profiles: Record<string, { display_name?: string; model_mapping: Record<string, string> }>;
		};
		expect(later.profiles["my-fast"]?.model_mapping.default).toBe("my-oai/gpt-custom:low");
		expect(later.profiles.second?.display_name).toBe("second");
		expect(registry.getModelProfile("second")?.displayName).toBe("second");
	});

	it.skipIf(process.platform === "win32")("still allows a save when the parent directory is a symlink", async () => {
		const realDir = path.join(tempDir, "real");
		const alias = path.join(tempDir, "alias");
		await fs.mkdir(realDir);
		await fs.symlink(realDir, alias);
		const modelsPath = path.join(alias, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);

		await registry.saveCustomModelProfile("my-fast", preset("my-fast", "my-oai"));

		expect(registry.getModelProfile("my-fast")?.displayName).toBe("my-fast");
		expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
		expect((await fs.lstat(modelsPath)).isSymbolicLink()).toBe(false);
		const saved = YAML.parse(await Bun.file(path.join(realDir, "models.yml")).text()) as {
			profiles: Record<string, { display_name?: string }>;
		};
		expect(saved.profiles["my-fast"]?.display_name).toBe("my-fast");
	});

	it("still allows a save through an existing dotdot parent", async () => {
		const sub = path.join(tempDir, "sub");
		await fs.mkdir(sub);
		const modelsPath = `${sub}${path.sep}..${path.sep}models.yml`;
		const registry = new ModelRegistry(authStorage, modelsPath);

		await registry.saveCustomModelProfile("my-fast", preset("my-fast", "my-oai"));

		expect(registry.getModelProfile("my-fast")?.displayName).toBe("my-fast");
		const saved = YAML.parse(await Bun.file(path.join(tempDir, "models.yml")).text()) as {
			profiles: Record<string, { display_name?: string }>;
		};
		expect(saved.profiles["my-fast"]?.display_name).toBe("my-fast");
	});

	it("still allows a save when the parent directory is mode 0755", async () => {
		await fs.chmod(tempDir, 0o755);
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);

		await registry.saveCustomModelProfile("my-fast", preset("my-fast", "my-oai"));

		expect(await modeOf(tempDir)).toBe(0o755);
		expect(registry.getModelProfile("my-fast")?.displayName).toBe("my-fast");
		const saved = YAML.parse(await Bun.file(modelsPath).text()) as {
			profiles: Record<string, { display_name?: string }>;
		};
		expect(saved.profiles["my-fast"]?.display_name).toBe("my-fast");
	});

	it.skipIf(process.platform === "win32")("creates models.yml as mode 0600 under umask 022", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);
		const previousUmask = process.umask(0o022);
		try {
			await registry.saveCustomModelProfile("my-fast", preset("my-fast", "my-oai"));
			expect(await modeOf(modelsPath)).toBe(0o600);
		} finally {
			process.umask(previousUmask);
		}
	});

	it.skipIf(process.platform === "win32")(
		"creates a missing parent directory as mode 0700 under umask 022",
		async () => {
			const agentDir = path.join(tempDir, "agentDir");
			const modelsPath = path.join(agentDir, "models.yml");
			const registry = new ModelRegistry(authStorage, modelsPath);
			const previousUmask = process.umask(0o022);
			try {
				await registry.saveCustomModelProfile("my-fast", preset("my-fast", "my-oai"));
				expect(await modeOf(agentDir)).toBe(0o700);
				expect(await modeOf(modelsPath)).toBe(0o600);
			} finally {
				process.umask(previousUmask);
			}
		},
	);

	it.skipIf(process.platform === "win32")("tightens an existing world-writable models.yml to mode 0600", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		await fs.writeFile(modelsPath, "profiles: {}\n");
		await fs.chmod(modelsPath, 0o666);
		const registry = new ModelRegistry(authStorage, modelsPath);

		await registry.saveCustomModelProfile("my-fast", preset("my-fast", "my-oai"));

		expect(await modeOf(modelsPath)).toBe(0o600);
		const saved = YAML.parse(await Bun.file(modelsPath).text()) as {
			profiles: Record<string, { display_name?: string }>;
		};
		expect(saved.profiles["my-fast"]?.display_name).toBe("my-fast");
	});

	it.skipIf(process.platform === "win32")("does not follow a symlink at the models.yml path", async () => {
		const targetPath = path.join(tempDir, "secret-target.yml");
		const modelsPath = path.join(tempDir, "models.yml");
		const seed = new ModelRegistry(authStorage, targetPath);
		await seed.saveCustomModelProfile("existing", preset("existing", "my-oai"));
		const original = await fs.readFile(targetPath, "utf8");
		const before = await fs.stat(targetPath, { bigint: true });
		await fs.symlink(targetPath, modelsPath);
		const registry = new ModelRegistry(authStorage, modelsPath);

		await expect(registry.saveCustomModelProfile("my-fast", preset("my-fast", "anthropic"))).rejects.toMatchObject({
			code: "ELOOP",
		});

		const after = await fs.stat(targetPath, { bigint: true });
		expect(after.dev).toBe(before.dev);
		expect(after.ino).toBe(before.ino);
		expect(await fs.readFile(targetPath, "utf8")).toBe(original);
		expect(original).not.toContain("my-fast");
		expect((await fs.lstat(modelsPath)).isSymbolicLink()).toBe(true);
		expect(await fs.readlink(modelsPath)).toBe(targetPath);
		expect(registry.getModelProfile("my-fast")).toBeUndefined();
	});

	it.skipIf(process.platform === "win32")("does not create a file through a dangling models.yml symlink", async () => {
		const nested = path.join(tempDir, "nested");
		await fs.mkdir(nested);
		const targetPath = path.join(nested, "target.yml");
		const modelsPath = path.join(tempDir, "models.yml");
		await fs.symlink(path.join("nested", "target.yml"), modelsPath);
		const registry = new ModelRegistry(authStorage, modelsPath);

		await expect(registry.saveCustomModelProfile("my-fast", preset("my-fast", "anthropic"))).rejects.toMatchObject({
			code: "ELOOP",
		});

		await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await fs.lstat(modelsPath)).isSymbolicLink()).toBe(true);
		expect(registry.getModelProfile("my-fast")).toBeUndefined();
	});
});
