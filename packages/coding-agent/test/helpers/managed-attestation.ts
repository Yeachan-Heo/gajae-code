import * as path from "node:path";
import type { Broker } from "../../src/sdk/broker/broker";
import { processIncarnation } from "../../src/sdk/broker/process-incarnation";

/**
 * Build the broker-index attestation writer used by the managed-task suites.
 * `ownerId` and `epoch` stay caller-supplied because each suite scopes its own
 * owner generation.
 */
export function createAttest(ownerId: string, epoch: string): (broker: Broker, cwd: string) => Promise<void> {
	return async (broker, cwd) => {
		const incarnation = processIncarnation(process.pid);
		if (!incarnation) throw new Error("Test owner has no process incarnation");
		for (const endpointGeneration of [0, 1]) {
			await broker.index.append({
				type: "host_registered",
				sessionId: ownerId,
				locator: { cwd, worktreeRoot: null, stateRoot: path.join(cwd, ".gjc", "state") },
				endpointGeneration,
				pid: process.pid,
				hostIncarnation: incarnation,
				masterRole: {
					version: 2,
					ownerSessionId: ownerId,
					launchPid: process.pid,
					launchProcessIncarnation: incarnation,
					role: "master",
					attestationEpoch: epoch,
				},
			});
		}
	};
}
