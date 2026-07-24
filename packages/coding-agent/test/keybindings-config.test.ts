import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { KeybindingsManager } from "../src/config/keybindings";

let tempDir: string | undefined;
afterEach(async () => {
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

describe("keybindings config", () => {
	it("does not write back a malformed config", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-keybindings-"));
		const file = path.join(tempDir, "keybindings.json");
		const malformed = "{ not valid json";
		await fs.writeFile(file, malformed);
		KeybindingsManager.create(tempDir);
		expect(await fs.readFile(file, "utf8")).toBe(malformed);
		expect(await Bun.file(`${file}.bak`).exists()).toBe(false);
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
