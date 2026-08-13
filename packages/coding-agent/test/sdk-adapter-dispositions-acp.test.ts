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
import { test } from "bun:test";
import {
	adapterPrefix,
	assertAcpRow,
	expectedOutcome,
	type MachineAdapter,
	OPERATIONS,
} from "./helpers/sdk-adapter-dispositions-shared";

const adapter: MachineAdapter = "acp";
for (const operation of OPERATIONS) {
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
