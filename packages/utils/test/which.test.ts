import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "../src/temp";
import { $which, WhichCachePolicy } from "../src/which";

describe.skipIf(process.platform === "win32")("$which lookup options", () => {
	it("honors explicit PATH and cwd overrides without cache collisions", async () => {
		const tempDir = await TempDir.create();
		try {
			const command = "gjc-which-option-test";
			const executable = tempDir.join(command);
			await Bun.write(executable, "#!/bin/sh\nexit 0\n");
			await fs.chmod(executable, 0o755);

			expect($which(command, { PATH: tempDir.path(), cache: WhichCachePolicy.Fresh })).toBe(executable);
			expect($which(command, { PATH: "", cwd: tempDir.path(), cache: WhichCachePolicy.Cached })).toBeNull();
			expect(
				$which(`.${path.sep}${command}`, {
					PATH: "",
					cwd: tempDir.path(),
					cache: WhichCachePolicy.Bypass,
				}),
			).toBe(executable);
			expect($which("clang", { PATH: tempDir.path(), cache: WhichCachePolicy.Bypass })).toBeNull();
		} finally {
			await tempDir.remove();
		}
	});
});
