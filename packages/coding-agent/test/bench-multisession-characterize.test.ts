import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type CharacterizationOutcome, characterize } from "../bench/multisession/characterize";

const evidenceRoots: string[] = [];

afterEach(async () => {
	for (const root of evidenceRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function isOutcome(value: CharacterizationOutcome): boolean {
	if (value.outcome === "unavailable") return value.reason.trim().length > 0;
	if (value.outcome === "equal") return value.brokerEvidenceDir.length > 0 && value.runnerEvidenceDir.length > 0;
	return value.fields.length > 0 && value.brokerEvidenceDir.length > 0 && value.runnerEvidenceDir.length > 0;
}

test("live Broker characterization returns observed outcome and evidence", async () => {
	const baselineRoots = new Set(
		(await fs.readdir(os.tmpdir())).filter(name => name.startsWith("gjc-bench-multisession-characterize-")),
	);
	const result = await characterize();
	expect(isOutcome(result)).toBe(true);
	if (result.outcome === "unavailable") {
		expect(result.reason).toContain('"code":"internal"');
		expect(result.reason).toContain("hostExit=");
		expect(result.hostExit).toBeDefined();
		if (!result.hostExit) throw new Error("Unavailable characterization omitted host exit evidence.");
		expect(result.hostExit.exitStatusObserved).toBe(false);
		expect(result.hostExit.processObservation).toMatch(/->(absent|pid-reused)$/);
		expect(typeof result.hostExit.stderrTail).toBe("string");
		const remainingRoots = (await fs.readdir(os.tmpdir())).filter(
			name => name.startsWith("gjc-bench-multisession-characterize-") && !baselineRoots.has(name),
		);
		expect(remainingRoots).toEqual([]);
		return;
	}

	const brokerRoot = path.dirname(result.brokerEvidenceDir);
	evidenceRoots.push(brokerRoot);
	for (const evidenceDir of [result.brokerEvidenceDir, result.runnerEvidenceDir]) {
		for (const file of ["transcript.jsonl", "requests.jsonl", "tools.jsonl", "events.jsonl"]) {
			expect(await Bun.file(path.join(evidenceDir, file)).exists()).toBe(true);
		}
	}
	if (result.outcome === "differs") expect(result.fields.length).toBeGreaterThan(0);
}, 180_000);
