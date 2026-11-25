import { inspectSessionOwners, SessionOwnershipError } from "../../session/session-ownership";
import { doctorCheck } from "./checks";
import type { DoctorProbeReceipt } from "./probe-types";
import type { DoctorCheck } from "./types";

/** Above this many sidecars, gc pruning is not keeping up (design §2.9). */
export const SESSION_OWNER_SIDECAR_LIMIT = 10_000;
/** A successor that just took a dead holder's lock replaces its record within this window. */
const RECHECK_MS = 250;
/** The collector replaces this with its own target id. */
const PROBE_TARGET = "t1:session-owners:probe";

function check(id: string, result: Pick<DoctorCheck, "health" | "reasonCode" | "evidence">): DoctorCheck {
	return doctorCheck(id, PROBE_TARGET, { execution: "completed", evidenceLevel: "observed", ...result });
}

/**
 * Held sidecars whose record names a process that no longer exists (impossible under a kernel
 * lock, so a bug signal), confirmed on a second look, and the sidecar count against its limit.
 */
export async function collectSessionOwnersProbe(
	recheckMs = RECHECK_MS,
	limit = SESSION_OWNER_SIDECAR_LIMIT,
): Promise<DoctorProbeReceipt> {
	const receipt = (reasonCode: string, checks: DoctorCheck[]): DoctorProbeReceipt => ({
		schemaVersion: 1,
		kind: "session-owners",
		status: "completed",
		reasonCode,
		checks,
	});
	try {
		const first = await inspectSessionOwners();
		if (first.directory === "missing") {
			const absent = { health: "not_applicable", reasonCode: "session_owners_absent", evidence: {} } as const;
			return receipt("session_owners_absent", [
				check("session.owners.holders", absent),
				check("session.owners.sidecars", absent),
			]);
		}
		let inventory = first;
		let gone = first.held.filter(sidecar => sidecar.record === "holder_gone");
		if (gone.length > 0) {
			await Bun.sleep(recheckMs);
			inventory = await inspectSessionOwners();
			const suspects = new Map(gone.map(sidecar => [sidecar.key, sidecar.gonePid]));
			gone = inventory.held.filter(
				sidecar =>
					sidecar.record === "holder_gone" &&
					sidecar.state === "held" &&
					suspects.get(sidecar.key) === sidecar.gonePid,
			);
		}
		const over = inventory.sidecars > limit;
		return receipt("session_owners_inspected", [
			check("session.owners.holders", {
				health: gone.length > 0 ? "warning" : "ok",
				reasonCode: gone.length > 0 ? "session_owner_holder_gone" : "session_owner_holders_consistent",
				evidence: { count: inventory.held.length, counts: { holderGone: gone.length } },
			}),
			check("session.owners.sidecars", {
				health: over ? "warning" : "ok",
				reasonCode: over ? "session_owner_sidecars_over_limit" : "session_owner_sidecars_within_limit",
				evidence: {
					count: inventory.sidecars,
					counts: {
						records: inventory.records,
						unrecognized: inventory.unrecognized,
						diskBytes: inventory.diskBytes,
						limit,
					},
				},
			}),
		]);
	} catch (error) {
		if (!(error instanceof SessionOwnershipError)) throw error;
		return receipt(`session_${error.code}`, [
			check("session.owners.holders", {
				health: "error",
				reasonCode: `session_${error.code}`,
				evidence: error.errno ? { errno: error.errno } : {},
			}),
		]);
	}
}
