import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearConfigValueCache, resolveConfigValue } from "../src/config/resolve-config-value";

test("isolates command cache entries by caller scope", async () => {
	clearConfigValueCache();
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-resolve-config-value-"));
	const counterPath = path.join(tempDir, "counter");
	await Bun.write(counterPath, "0");
	const command = `!count=$(cat "${counterPath}"); next=$((count + 1)); printf %s "$next" > "${counterPath}"; printf %s "$next"`;

	try {
		await expect(resolveConfigValue(command, "first-credential")).resolves.toBe("1");
		await expect(resolveConfigValue(command, "first-credential")).resolves.toBe("1");
		await expect(resolveConfigValue(command, "replacement-credential")).resolves.toBe("2");
	} finally {
		clearConfigValueCache();
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
