import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { executeShell } from "../native/index.js";

type ShellGolden = {
	schemaVersion: number;
	source: string;
	normalization: string;
	cases: Array<{
		id: string;
		command: string;
		result: { output: string; exitCode: number | null; cancelled: boolean; timedOut: boolean };
	}>;
};

const shellGolden = JSON.parse(
	await readFile(`${import.meta.dir}/fixtures/goldens/shell/baseline.json`, "utf8"),
) as ShellGolden;

test("Phase 3 shell output matches the pre-sync golden", async () => {
	expect(shellGolden.schemaVersion).toBe(1);
	expect(shellGolden.cases.length).toBeGreaterThanOrEqual(3);

	for (const { id, command, result: expected } of shellGolden.cases) {
		let output = "";
		const result = await executeShell({ command, timeoutMs: 5_000 }, (error, chunk) => {
			if (error) throw error;
			output += chunk;
		});

		expect(
			{
				output,
				exitCode: result.exitCode ?? null,
				cancelled: result.cancelled,
				timedOut: result.timedOut,
			},
			id,
		).toEqual(expected);
	}
});
