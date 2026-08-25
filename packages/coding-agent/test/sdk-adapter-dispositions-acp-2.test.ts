/**
 * ACP adapter disposition tests, operation cohort 2 of 4.
 *
 * Each cohort runs in a fresh process so the ACP production-host fixtures stay
 * below the unchanged test timeout while preserving the complete operation set.
 */
import { test } from "bun:test";
import {
	adapterPrefix,
	assertAcpRow,
	expectedOutcome,
	type MachineAdapter,
	operationsForAcpCohort,
} from "./helpers/sdk-adapter-dispositions-shared";

const adapter: MachineAdapter = "acp";
for (const operation of operationsForAcpCohort(1)) {
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
