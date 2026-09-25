import { expect, setDefaultTimeout, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { executeShell } from "../native/index.js";

setDefaultTimeout(30_000);

type ShellOutput = { output: string; exitCode: number | null; cancelled: boolean; timedOut: boolean };
type ShellGolden = {
	schemaVersion: number;
	source: string;
	normalization: string;
	cases: Array<{ id: string; command: string; result: ShellOutput }>;
};
type AcceptedShellDivergence = {
	module: string;
	caseId: string;
	fields: { before: ShellOutput; after: ShellOutput };
	reason: string;
};

const shellGolden = JSON.parse(
	await readFile(`${import.meta.dir}/fixtures/goldens/shell/baseline.json`, "utf8"),
) as ShellGolden;
const acceptedDivergences = JSON.parse(
	await readFile(`${import.meta.dir}/fixtures/goldens/accepted-divergences.json`, "utf8"),
) as { schema: number; divergences: AcceptedShellDivergence[] };

test("Phase 3 shell output matches the pre-sync golden or an accepted upstream improvement", async () => {
	expect(shellGolden.schemaVersion).toBe(1);
	expect(acceptedDivergences.schema).toBe(1);

	const shellDivergences = acceptedDivergences.divergences.filter(divergence => divergence.module === "shell");
	expect(shellDivergences.map(({ caseId }) => caseId).sort()).toEqual(
		shellGolden.cases
			.filter(({ id }) => shellDivergences.some(({ caseId }) => caseId === id))
			.map(({ id }) => id)
			.sort(),
	);

	for (const { id, command, result: baseline } of shellGolden.cases) {
		let output = "";
		const result = await executeShell({ command, timeoutMs: 5_000 }, (error, chunk) => {
			if (error) throw error;
			output += chunk;
		});
		const observed = {
			output,
			exitCode: result.exitCode ?? null,
			cancelled: result.cancelled,
			timedOut: result.timedOut,
		};
		const divergence = shellDivergences.find(({ caseId }) => caseId === id);

		if (divergence) {
			expect(divergence.fields.before, `${id} pre-sync evidence`).toEqual(baseline);
			expect(observed, id).toEqual(divergence.fields.after);
		} else {
			expect(observed, id).toEqual(baseline);
		}
	}
});
