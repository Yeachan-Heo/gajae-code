import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Process, ProcessStatus } from "../native/index.js";

type PsGolden = {
	schemaVersion: number;
	source: string;
	normalization: string;
	result: {
		status: string;
		pidMatches: boolean;
		ppidPositive: boolean;
		incarnationPresent: boolean;
		observationStatus: string;
		observationIncarnationPresent: boolean;
		runningEnum: string;
	};
};

const psGolden = JSON.parse(await readFile(`${import.meta.dir}/fixtures/goldens/ps/baseline.json`, "utf8")) as PsGolden;

test("Phase 3 process observation output matches the pre-sync golden", () => {
	expect(psGolden.schemaVersion).toBe(1);
	const reference = Process.fromPid(process.pid);
	expect(reference).not.toBeNull();
	if (!reference) return;
	const observation = Process.observe(process.pid);

	expect({
		status: reference.status(),
		pidMatches: reference.pid === process.pid,
		ppidPositive: (reference.ppid ?? 0) > 0,
		incarnationPresent: reference.incarnation.length > 0,
		observationStatus: observation.status,
		observationIncarnationPresent: observation.incarnation !== null,
		runningEnum: ProcessStatus.Running,
	}).toEqual(psGolden.result);
});
