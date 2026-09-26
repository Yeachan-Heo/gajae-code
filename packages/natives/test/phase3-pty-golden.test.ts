import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PtySession } from "../native/index.js";

type PtyGolden = {
	schemaVersion: number;
	source: string;
	normalization: string;
	result: { output: string; exitCode: number | null; cancelled: boolean; timedOut: boolean };
};

const ptyGolden = JSON.parse(
	await readFile(`${import.meta.dir}/fixtures/goldens/pty/baseline.json`, "utf8"),
) as PtyGolden;

test("Phase 3 PTY output and completion state match the pre-sync golden", async () => {
	expect(ptyGolden.schemaVersion).toBe(1);
	const command =
		process.platform === "win32" ? "echo pty-phase3-golden & exit /b 7" : "printf 'pty-phase3-golden\\n'; exit 7";
	const session = new PtySession();
	let output = "";
	const result = await session.start(
		{
			command,
			shell: process.platform === "win32" ? "cmd.exe" : "sh",
			cols: 80,
			rows: 24,
		},
		(error, chunk) => {
			if (error) throw error;
			output += chunk;
		},
	);

	expect({
		output: output.replace(/\r\n/g, "\n"),
		exitCode: result.exitCode ?? null,
		cancelled: result.cancelled,
		timedOut: result.timedOut,
	}).toEqual(ptyGolden.result);
});
