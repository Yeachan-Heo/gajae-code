import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { getAgentDir } from "@gajae-code/utils/dirs";
import type { DoctorOptions } from "../src/cli/doctor/args";
import { BASIC_DOCTOR_COLLECTORS, type DoctorCollector } from "../src/cli/doctor/checks";
import { configTargetId, resolveDoctorRoot } from "../src/cli/doctor/ids";
import { collectDoctorReport } from "../src/cli/doctor/runner";
import type { DoctorCheck } from "../src/cli/doctor/types";

const configCollector = BASIC_DOCTOR_COLLECTORS.find(collector => collector.id === "config") as DoctorCollector;
const spies: { mockRestore(): void }[] = [];

function stubConfigCollect(implementation: DoctorCollector["collect"]): void {
	const spy = spyOn(configCollector, "collect");
	spy.mockImplementation(implementation);
	spies.push(spy);
}

afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
});

function fixOptions(targetId: string): DoctorOptions {
	return {
		mode: "fix",
		json: true,
		help: false,
		checks: ["config"],
		repair: "config.set-validated",
		targetId,
		setValue: true,
		allowRisks: ["config-change"],
		yes: true,
		// Shorter than the config collector's own 2s budget, so the collector loses
		// the timeout race while it is still running.
		timeoutMs: 40,
		cwd: process.cwd(),
		tty: false,
	};
}

describe("doctor collector timeout", () => {
	test("refuses --fix while a timed-out collector is still writing to the shared context", async () => {
		const targetId = configTargetId(resolveDoctorRoot("config-user", getAgentDir()).rootId, "user", "skills.enabled");
		let completed = false;
		const finished = Promise.withResolvers<void>();
		stubConfigCollect(async (context): Promise<DoctorCheck[]> => {
			await Bun.sleep(300);
			// The losing collector keeps mutating shared context after the race is
			// decided; a repair planned against that half-written map is exactly what
			// this refusal prevents.
			context.targets.set(targetId, {
				kind: "config",
				targetId,
				source: context.sources[0],
				schemaKey: "skills.enabled",
				observation: { status: "missing" },
				beforeValue: undefined,
			});
			completed = true;
			finished.resolve();
			return [];
		});

		const report = await collectDoctorReport(fixOptions(targetId));

		// The collector that lost the race had not finished when the report was produced.
		expect(completed).toBe(false);
		expect(report.repairs).toHaveLength(1);
		expect(report.repairs[0]).toMatchObject({
			id: "config.set-validated",
			targetId,
			state: "blocked",
			reasonCode: "incomplete_diagnostics",
			sideEffectStarted: false,
		});
		expect(report.repairs[0].readiness).toContain("target_resolution_incomplete");
		// An incomplete diagnosis is not a usage error: the run reports incomplete, not exit 2.
		expect(report.invocationError).toBeUndefined();
		expect(report.summary.exitCode).toBe(3);
		// Diagnosis still reports what it observed.
		expect(report.checks.some(check => check.execution === "timeout")).toBe(true);
		expect(report.coverage.timedOut).toBeGreaterThan(0);

		await finished.promise;
	});

	test("plans the selected repair once every collector settles", async () => {
		const targetId = configTargetId(resolveDoctorRoot("config-user", getAgentDir()).rootId, "user", "skills.enabled");
		stubConfigCollect(async (): Promise<DoctorCheck[]> => []);

		const report = await collectDoctorReport({ ...fixOptions(targetId), mode: "dry-run", timeoutMs: 5_000 });

		expect(report.repairs).toHaveLength(1);
		expect(report.repairs[0].reasonCode).not.toBe("incomplete_diagnostics");
	});
});
