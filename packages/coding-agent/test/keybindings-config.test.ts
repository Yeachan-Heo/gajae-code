import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type KeybindingMigrationStage,
	KeybindingsManager,
	loadKeybindingsConfigForTest,
} from "../src/config/keybindings";

let tempDir: string | undefined;
afterEach(async () => {
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

async function migrationTemps(directory: string): Promise<string[]> {
	return (await fs.readdir(directory)).filter(entry => entry.endsWith(".tmp"));
}

describe("keybindings config", () => {
	it("does not write back a malformed config", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-keybindings-"));
		const file = path.join(tempDir, "keybindings.json");
		const malformed = "{ not valid json";
		await fs.writeFile(file, malformed);
		KeybindingsManager.create(tempDir);
		expect(await fs.readFile(file, "utf8")).toBe(malformed);
		expect(await Bun.file(`${file}.bak`).exists()).toBe(false);
		expect(await Bun.file(`${file}.migration-v1`).exists()).toBe(false);
		expect(await migrationTemps(tempDir)).toEqual([]);
	});
	it("migrates legacy keys added after an initial canonical-only load", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-keybindings-"));
		const file = path.join(tempDir, "keybindings.json");
		await fs.writeFile(file, '{"app.clear":"ctrl+c"}\n');

		expect(KeybindingsManager.create(tempDir).getKeys("app.clear")).toEqual(["ctrl+c"]);
		expect(await Bun.file(`${file}.migration-v1`).exists()).toBe(false);
		expect(await Bun.file(`${file}.bak`).exists()).toBe(false);

		const legacy = '{"interrupt":"escape"}\n';
		await fs.writeFile(file, legacy);
		expect(KeybindingsManager.create(tempDir).getKeys("app.interrupt")).toEqual(["escape"]);
		expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ "app.interrupt": "escape" });
		expect(await fs.readFile(`${file}.bak`, "utf8")).toBe(legacy);
		expect(await fs.readFile(`${file}.migration-v1`, "utf8")).toBe("v1\n");
	});
	it("publishes migration files atomically and preserves the first backup", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-keybindings-"));
		const file = path.join(tempDir, "keybindings.json");
		const legacy = '{"interrupt":"escape"}\n';
		const firstBackup = "first backup\n";
		await fs.writeFile(file, legacy);
		await fs.writeFile(`${file}.bak`, firstBackup);

		const manager = KeybindingsManager.create(tempDir);
		expect(manager.getKeys("app.interrupt")).toEqual(["escape"]);
		expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ "app.interrupt": "escape" });
		expect(await fs.readFile(`${file}.bak`, "utf8")).toBe(firstBackup);
		expect(await fs.readFile(`${file}.migration-v1`, "utf8")).toBe("v1\n");
		expect(await migrationTemps(tempDir)).toEqual([]);

		const primaryStat = await fs.stat(file, { bigint: true });
		const markerStat = await fs.stat(`${file}.migration-v1`, { bigint: true });
		KeybindingsManager.create(tempDir);
		expect((await fs.stat(file, { bigint: true })).mtimeNs).toBe(primaryStat.mtimeNs);
		expect((await fs.stat(`${file}.migration-v1`, { bigint: true })).mtimeNs).toBe(markerStat.mtimeNs);
		expect(await fs.readFile(`${file}.bak`, "utf8")).toBe(firstBackup);
		expect(await migrationTemps(tempDir)).toEqual([]);
	});

	it("leaves no temporary file at any failed migration publication stage and resumes idempotently", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-keybindings-"));
		const stages: KeybindingMigrationStage[] = [
			"backup",
			"primary-open",
			"primary-write",
			"primary-fsync",
			"primary-close",
			"primary-rename",
			"marker-open",
			"marker-write",
			"marker-fsync",
			"marker-close",
			"marker-rename",
		];
		const legacy = '{"interrupt":"escape"}\n';

		for (const [index, failedStage] of stages.entries()) {
			const directory = path.join(tempDir, String(index));
			const file = path.join(directory, "keybindings.json");
			await fs.mkdir(directory);
			await fs.writeFile(file, legacy);

			const config = loadKeybindingsConfigForTest(file, stage => {
				if (stage === failedStage) throw new Error(`injected ${stage} failure`);
			});
			expect(config["app.interrupt"]).toBe("escape");
			expect(await Bun.file(`${file}.migration-v1`).exists()).toBe(false);
			expect(await migrationTemps(directory)).toEqual([]);

			const failedAfterPrimary = failedStage.startsWith("marker-");
			if (failedAfterPrimary) {
				expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ "app.interrupt": "escape" });
			} else {
				expect(await fs.readFile(file, "utf8")).toBe(legacy);
			}
			if (failedStage === "backup") {
				expect(await Bun.file(`${file}.bak`).exists()).toBe(false);
			} else {
				expect(await fs.readFile(`${file}.bak`, "utf8")).toBe(legacy);
			}

			const resumed = KeybindingsManager.create(directory);
			expect(resumed.getKeys("app.interrupt")).toEqual(["escape"]);
			expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ "app.interrupt": "escape" });
			expect(await fs.readFile(`${file}.bak`, "utf8")).toBe(legacy);
			expect(await Bun.file(`${file}.migration-v1`).exists()).toBe(!failedAfterPrimary);
			expect(await migrationTemps(directory)).toEqual([]);
		}
	});
	it("rejects invalid overrides atomically and retains defaults", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-keybindings-"));
		await fs.writeFile(
			path.join(tempDir, "keybindings.json"),
			JSON.stringify({
				"app.clear": "command+p",
				"app.message.dequeue": ["alt+up", "ctrl+\u001b[31m"],
				"app.commandPalette.open": "CTRL+P",
			}),
		);

		const keybindings = KeybindingsManager.create(tempDir);
		expect(keybindings.getKeys("app.clear")).toEqual(["ctrl+c"]);
		expect(keybindings.getKeys("app.message.dequeue")).toEqual(["alt+up", "alt+down"]);
		expect(keybindings.getKeys("app.commandPalette.open")).toEqual(["ctrl+p"]);
	});

	it("accepts literal plus as a configured base key", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-keybindings-"));
		await fs.writeFile(path.join(tempDir, "keybindings.json"), JSON.stringify({ "app.clear": "ctrl++" }));

		expect(KeybindingsManager.create(tempDir).getKeys("app.clear")).toEqual(["ctrl++"]);
	});
});
