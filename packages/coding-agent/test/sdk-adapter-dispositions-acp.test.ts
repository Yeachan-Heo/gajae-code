/**
 * ACP adapter disposition tests, split from sdk-adapter-dispositions.test.ts
 * (issue #4475): the combined machine-adapter cohorts exceeded the CI 300s
 * file-timeout budget at ~489s of genuine per-fixture runtime (291 production
 * SDK host startups at ~1.7s each). This is not a leaked-resource defect: the
 * process exits ~200ms after the final test. Each adapter cohort runs as its
 * own fresh process under the unchanged timeout.
 *
 * Coverage is byte-identical to the original monolithic file's ACP loop.
 */
import { expect, test } from "bun:test";
import { AcpSdkAdapter } from "../src/sdk/acp";
import type { SdkClient } from "../src/sdk/client";
import {
	adapterPrefix,
	assertAcpRow,
	expectedOutcome,
	type MachineAdapter,
	operationsForAcpCohort,
} from "./helpers/sdk-adapter-dispositions-shared";

const adapter: MachineAdapter = "acp";
for (const operation of operationsForAcpCohort(0)) {
	const name = `AD-${adapterPrefix[adapter]}-${operation.id}: ${operation.sdkId} ${expectedOutcome(adapter, operation)}`;
	test(name, async () => {
		await assertAcpRow(operation, false);
	}, 60_000);
	if (operation.id === "C36") {
		test(`AD-${adapterPrefix[adapter]}-C36-secret: config.patch secret input rejected before send`, async () => {
			await assertAcpRow(operation, true);
		}, 60_000);
	}
}

test("session.spawn rejects capability-shaped input before ACP Broker dispatch", async () => {
	const adapter = new AcpSdkAdapter({ client: {} as SdkClient });
	await expect(
		adapter.global("session.spawn", {
			cwd: process.cwd(),
			task: "adapter disposition probe",
			masterCapability: "capability-shaped-probe",
			model: "openai/gpt-4o-mini",
			profile: "default",
		}),
	).rejects.toMatchObject({ code: "operation_prohibited" });
});
