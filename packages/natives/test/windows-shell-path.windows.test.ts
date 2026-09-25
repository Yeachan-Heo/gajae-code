import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "../native/index.js";

test.skipIf(process.platform !== "win32")("Git Bash ls and grep resolve through the translated shell PATH", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-shell-path-"));
	try {
		fs.writeFileSync(path.join(cwd, "marker.txt"), "path-translated\n");
		let output = "";
		const result = await executeShell(
			{
				command: "ls marker.txt && grep -q path-translated marker.txt",
				cwd,
				sessionEnv: { PATH: "/usr/bin" },
				timeoutMs: 45_000,
			},
			(error, chunk) => {
				if (error) throw error;
				output += chunk;
			},
		);

		expect(result.exitCode).toBe(0);
		expect(result.cancelled).toBe(false);
		expect(result.timedOut).toBe(false);
		expect(output).toContain("marker.txt");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
