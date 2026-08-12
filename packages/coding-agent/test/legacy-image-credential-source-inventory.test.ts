import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import { FileLockTestHooks } from "../src/config/file-lock";
import {
	RetiredImageSecretGateError,
	type RetiredImageSecretSource,
	runRetiredImageSecretGate,
} from "../src/config/retired-image-secret-gate";

const tempDirs: string[] = [];
const originalFileLockHook = FileLockTestHooks.afterParentMkdir;

async function makeWorkspace(): Promise<{ root: string; cwd: string; agentDir: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-image-secret-inventory-"));
	tempDirs.push(root);
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	return { root, cwd, agentDir };
}

async function expectBlocked(
	action: Promise<unknown>,
	source: RetiredImageSecretSource,
	secrets: readonly string[] = [],
): Promise<void> {
	let caught: unknown;
	try {
		await action;
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(RetiredImageSecretGateError);
	if (!(caught instanceof RetiredImageSecretGateError)) return;
	expect(caught.source).toBe(source);
	expect(caught.code).toBe("RETIRED_IMAGE_SECRET_GATE_BLOCKED");
	expect(caught.message).toContain(`(${source})`);
	for (const secret of secrets) expect(caught.message).not.toContain(secret);
}

afterEach(async () => {
	FileLockTestHooks.afterParentMkdir = originalFileLockHook;
	for (const directory of tempDirs.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe("retired image credential source inventory", () => {
	it("scrubs owned YAML, JSON, and every bounded editor/database backup form without retaining retired values", async () => {
		const { agentDir, cwd } = await makeWorkspace();
		const secrets = [
			"yaml-legacy-secret",
			"yaml-env-secret",
			"json-legacy-secret",
			"json-env-secret",
			"yaml-bak-secret",
			"yaml-backup-secret",
			"yaml-old-secret",
			"yaml-tmp-secret",
			"yaml-editor-secret",
			"yaml-orig-secret",
			"yaml-timestamp-secret",
			"yaml-copy-secret",
			"yaml-bounded-secret",
			"json-bak-secret",
			"json-backup-secret",
			"json-old-secret",
			"json-tmp-secret",
			"json-editor-secret",
			"json-orig-secret",
			"json-timestamp-secret",
			"json-copy-secret",
			"json-bounded-secret",
		] as const;
		const configPath = path.join(agentDir, "config.yml");
		const settingsPath = path.join(agentDir, "settings.json");
		const yamlBackupPaths = [
			`${configPath}.bak`,
			`${configPath}.backup`,
			`${configPath}.old`,
			`${configPath}.tmp`,
			`${configPath}~`,
			`${configPath}.orig`,
			`${configPath}.2026-08-10T1200`,
			`${configPath} copy 2`,
			`${configPath}.bak.${"7".repeat(240 - path.basename(configPath).length - ".bak.".length)}`,
		];
		const jsonBackupPaths = [
			`${settingsPath}.bak`,
			`${settingsPath}.backup`,
			`${settingsPath}.old`,
			`${settingsPath}.tmp`,
			`${settingsPath}~`,
			`${settingsPath}.orig`,
			`${settingsPath}.2026-08-10T1200`,
			`${settingsPath} copy 2`,
			`${settingsPath}.bak.${"8".repeat(240 - path.basename(settingsPath).length - ".bak.".length)}`,
		];
		expect(path.basename(yamlBackupPaths.at(-1)!)).toHaveLength(240);
		expect(path.basename(jsonBackupPaths.at(-1)!)).toHaveLength(240);

		await fs.writeFile(
			configPath,
			[
				"providers:",
				`  imageCustomKey: ${JSON.stringify(secrets[0])}`,
				`  imageCustomKeyEnv: ${JSON.stringify(secrets[1])}`,
				"  image: custom",
				"safeSetting: retained",
				"",
			].join("\n"),
		);
		await fs.writeFile(
			settingsPath,
			JSON.stringify(
				{
					imageCustomKey: secrets[2],
					providers: { imageCustomKeyEnv: secrets[3], keep: true },
				},
				null,
				2,
			) + "\n",
		);
		for (const [index, backupPath] of yamlBackupPaths.entries()) {
			await fs.writeFile(
				backupPath,
				["providers:", `  imageCustomKey: ${JSON.stringify(secrets[index + 4])}`, "backupSafe: true", ""].join(
					"\n",
				),
			);
		}
		for (const [index, backupPath] of jsonBackupPaths.entries()) {
			await fs.writeFile(
				backupPath,
				JSON.stringify({ providers: { imageCustomKeyEnv: secrets[index + 13], backupSafe: true } }, null, 2) + "\n",
			);
		}

		await runRetiredImageSecretGate({ cwd, agentDir });

		for (const filePath of [configPath, settingsPath, ...yamlBackupPaths, ...jsonBackupPaths]) {
			const text = await fs.readFile(filePath, "utf8");
			for (const secret of secrets) expect(text).not.toContain(secret);
			for (const key of ["imageCustomKey", "imageCustomKeyEnv"]) expect(text).not.toContain(key);
		}
		const config = YAML.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
		expect(config.safeSetting).toBe("retained");
		expect((config.providers as Record<string, unknown>).image).toBe("custom");
		const settings = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
		expect(settings.imageCustomKey).toBeUndefined();
		expect((settings.providers as Record<string, unknown>).keep).toBe(true);
	});

	it("inventories case-variant backup basenames before allowing startup", async () => {
		const { agentDir, cwd } = await makeWorkspace();
		const configPath = path.join(agentDir, "config.yml");
		const settingsPath = path.join(agentDir, "settings.json");
		const backups: Array<{ path: string; format: "yaml" | "json"; secret: string }> = [
			{ path: `${configPath}.BAK`, format: "yaml", secret: "uppercase-yaml-backup-secret" },
			{ path: path.join(agentDir, "CONFIG.YML.BackUp"), format: "yaml", secret: "mixedcase-yaml-backup-secret" },
			{ path: `${settingsPath}.OLD`, format: "json", secret: "uppercase-json-backup-secret" },
			{ path: path.join(agentDir, "SETTINGS.JSON.TmP"), format: "json", secret: "mixedcase-json-backup-secret" },
		];
		await fs.writeFile(configPath, "safeConfig: true\n");
		await fs.writeFile(settingsPath, JSON.stringify({ safeSettings: true }) + "\n");
		for (const backup of backups) {
			const content =
				backup.format === "yaml"
					? ["providers:", `  imageCustomKey: ${JSON.stringify(backup.secret)}`, "backupSafe: true", ""].join("\n")
					: JSON.stringify({ providers: { imageCustomKeyEnv: backup.secret }, backupSafe: true }) + "\n";
			await fs.writeFile(backup.path, content);
		}

		await runRetiredImageSecretGate({ cwd, agentDir });

		for (const backup of backups) {
			const text = await fs.readFile(backup.path, "utf8");
			expect(text).not.toContain(backup.secret);
			expect(text).not.toContain("imageCustomKey");
			expect(text).not.toContain("imageCustomKeyEnv");
		}
	});

	it("blocks a matching backup symlink instead of following or scrubbing its target", async () => {
		const workspace = await makeWorkspace();
		const configPath = path.join(workspace.agentDir, "config.yml");
		const targetPath = path.join(workspace.root, "backup-target.yml");
		const backupPath = `${configPath}.bak`;
		const secret = "backup-symlink-secret";
		await fs.writeFile(targetPath, [`providers:`, `  imageCustomKey: ${secret}`, ""].join("\n"));
		await fs.symlink(targetPath, backupPath);

		await expectBlocked(runRetiredImageSecretGate(workspace), "global-config", [secret]);
		const linkStat = await fs.lstat(backupPath);
		expect(linkStat.isSymbolicLink()).toBe(true);
	});

	it("rejects project-owned/native and third-party ingress credential selectors closed", async () => {
		const native = await makeWorkspace();
		const nativeSecret = "native-selector-secret";
		const nativeConfigPath = path.join(native.cwd, ".gjc", "config.yml");
		await fs.mkdir(path.dirname(nativeConfigPath), { recursive: true });
		await fs.writeFile(
			nativeConfigPath,
			[
				"providers:",
				"  image: custom",
				"  imageCustomUrl: https://images.example.invalid/v1",
				`  imageCredentialRef: ${nativeSecret}`,
				"",
			].join("\n"),
		);
		await expectBlocked(runRetiredImageSecretGate(native), "project-config", [nativeSecret]);
		expect(await fs.readFile(nativeConfigPath, "utf8")).toContain(nativeSecret);

		const ingress = await makeWorkspace();
		const ingressSecret = "third-party-selector-secret";
		const ingressPath = path.join(ingress.cwd, ".cursor", "settings.json");
		await fs.mkdir(path.dirname(ingressPath), { recursive: true });
		await fs.writeFile(
			ingressPath,
			JSON.stringify({ providers: { image: "custom", imageCredentialSelector: ingressSecret } }, null, 2) + "\n",
		);
		await expectBlocked(runRetiredImageSecretGate(ingress), "project-ingress", [ingressSecret]);
		expect(await fs.readFile(ingressPath, "utf8")).toContain(ingressSecret);
	});

	it("redacts malformed, unreadable, symlink, and exact-consumed-object race failures", async () => {
		const malformed = await makeWorkspace();
		const malformedSecret = "malformed-secret";
		await fs.writeFile(
			path.join(malformed.agentDir, "config.yml"),
			`providers:\n  imageCustomKey: [${malformedSecret}\n`,
		);
		await expectBlocked(runRetiredImageSecretGate(malformed), "global-config", [malformedSecret]);

		const unreadable = await makeWorkspace();
		await fs.mkdir(path.join(unreadable.agentDir, "settings.json"));
		await expectBlocked(runRetiredImageSecretGate(unreadable), "global-legacy-json");

		const symlink = await makeWorkspace();
		const symlinkSecret = "symlink-secret";
		const targetPath = path.join(symlink.root, "target.json");
		const symlinkPath = path.join(symlink.agentDir, "settings.json");
		await fs.writeFile(targetPath, JSON.stringify({ imageCustomKey: symlinkSecret }));
		await fs.symlink(targetPath, symlinkPath);
		await expectBlocked(runRetiredImageSecretGate(symlink), "global-legacy-json", [symlinkSecret]);

		const racing = await makeWorkspace();
		const racingSecret = "racing-secret";
		const replacementSecret = "post-gate-replacement-secret";
		const racingPath = path.join(racing.agentDir, "settings.json");
		await fs.writeFile(racingPath, JSON.stringify({ imageCustomKey: racingSecret, retained: true }));
		FileLockTestHooks.afterParentMkdir = async lockPath => {
			if (lockPath === `${racingPath}.lock`) {
				await fs.writeFile(racingPath, JSON.stringify({ retained: replacementSecret }));
			}
		};
		await expectBlocked(runRetiredImageSecretGate(racing), "global-legacy-json", [racingSecret, replacementSecret]);
		expect(JSON.parse(await fs.readFile(racingPath, "utf8"))).toEqual({ retained: replacementSecret });
	});
});
