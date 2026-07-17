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
});
