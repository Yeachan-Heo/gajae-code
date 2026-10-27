/**
 * Daemon CLI adapter disposition tests, split from sdk-adapter-dispositions.test.ts
 * (issue #4475): the combined machine-adapter cohorts exceeded the CI 300s
 * file-timeout budget at ~489s of genuine per-fixture runtime (291 production
 * SDK host startups at ~1.7s each). This is not a leaked-resource defect: the
 * process exits ~200ms after the final test. Each adapter cohort runs as its
 * its own fresh process. The current production-host startup authority path is
 * intentionally proof-heavy, so CI grants this cohort the shared coding-agent
 * harness's 15-minute per-file ceiling while retaining 60-second row bounds.
 *
 * Coverage is byte-identical to the original monolithic file's daemonCli loop.
 */
import { expect, spyOn, test } from "bun:test";
import * as brokerEnsure from "../src/sdk/broker/ensure";
import {
	adapterPrefix,
	assertDaemonCliRow,
	expectedOutcome,
	type MachineAdapter,
	OPERATIONS,
	runDaemonCli,
} from "./helpers/sdk-adapter-dispositions-shared";

const adapter: MachineAdapter = "daemonCli";
for (const operation of OPERATIONS) {
	const name = `AD-${adapterPrefix[adapter]}-${operation.id}: ${operation.sdkId} ${expectedOutcome(adapter, operation)}`;
	test(name, async () => {
		await assertDaemonCliRow(operation, false);
	}, 60_000);
	if (operation.id === "C36") {
		test(`AD-${adapterPrefix[adapter]}-C36-secret: config.patch secret input rejected before send`, async () => {
			await assertDaemonCliRow(operation, true);
		}, 60_000);
	}
}

test("raw global session.spawn rejects capability-shaped input before dispatch", async () => {
	const ensure = spyOn(brokerEnsure, "ensureBroker").mockRejectedValue(new Error("Unexpected broker contact"));
	try {
		const result = await runDaemonCli({
			action: "raw",
			rawAction: "global",
			operation: "session.spawn",
			jsonInput: JSON.stringify({
				cwd: process.cwd(),
				task: "adapter disposition probe",
				masterCapability: "capability-shaped-probe",
				model: "openai/gpt-4o-mini",
				profile: "default",
			}),
		});
		expect(result).toMatchObject({
			exitCode: 1,
			output: {
				schema: "gjc.command-error",
				ok: false,
				error: {
					code: "authorization_denied",
					outcomeCertainty: "not-applied",
					retryability: "no",
					references: [],
				},
			},
		});
		expect(ensure).not.toHaveBeenCalled();
		expect(JSON.stringify(result.output)).not.toContain("capability-shaped-probe");
		expect(JSON.stringify(result.output)).not.toContain("masterCapability");
	} finally {
		ensure.mockRestore();
	}
});
