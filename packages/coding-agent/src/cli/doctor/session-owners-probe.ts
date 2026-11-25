import { inspectSessionOwners, SessionOwnershipError } from "../../session/session-ownership";
import { doctorCheck } from "./checks";
import { doctorErrno } from "./files";
import type { DoctorProbeReceipt } from "./probe-types";
import type { DoctorCheck } from "./types";

/** A successor that just took a dead holder's lock replaces its record within this window. */
const RECHECK_MS = 250;
/** The collector replaces this with its own target id. */
const PROBE_TARGET = "t1:session-owners:probe";

function receipt(
	reasonCode: string,
	check: Pick<DoctorCheck, "execution" | "health" | "evidence">,
): DoctorProbeReceipt {
	return {
		schemaVersion: 1,
		kind: "session-owners",
		status: "completed",
		reasonCode,
		checks: [
			doctorCheck("session.owners.holders", PROBE_TARGET, { evidenceLevel: "observed", reasonCode, ...check }),
		],
	};
}

/**
 * Held sidecars whose record names a process that no longer exists: impossible under a kernel lock,
 * so a bug signal. A suspect is flagged only if a second look, at the suspects alone, finds its lock
 * still held and the same dead pid still named. The sidecar count is the collector's, from `readdir`.
 */
export async function collectSessionOwnersProbe(recheckMs = RECHECK_MS): Promise<DoctorProbeReceipt> {
	try {
		const first = await inspectSessionOwners();
		if (first.directory === "missing")
			return receipt("session_owners_absent", { execution: "completed", health: "not_applicable", evidence: {} });
		const held = first.held.filter(sidecar => sidecar.state === "held");
		let gone = held.filter(sidecar => sidecar.record === "holder_gone");
		if (gone.length > 0) {
			await Bun.sleep(recheckMs);
			const suspects = new Map(gone.map(sidecar => [sidecar.key, sidecar.gonePid]));
			const again = await inspectSessionOwners({ keys: [...suspects.keys()] });
			gone = again.held.filter(
				sidecar =>
					sidecar.record === "holder_gone" &&
					sidecar.state === "held" &&
					suspects.get(sidecar.key) === sidecar.gonePid,
			);
		}
		return receipt(gone.length > 0 ? "session_owner_holder_gone" : "session_owner_holders_consistent", {
			execution: "completed",
			health: gone.length > 0 ? "warning" : "ok",
			evidence: { count: held.length, counts: { holderGone: gone.length } },
		});
	} catch (error) {
		if (error instanceof SessionOwnershipError)
			return receipt(`session_${error.code}`, {
				execution: "completed",
				health: "error",
				evidence: error.errno ? { errno: error.errno } : {},
			});
		// Not a refused directory: the inspection itself failed (an unreadable entry, for example).
		return receipt("session_owners_inspection_failed", {
			execution: "blocked",
			health: "unknown",
			evidence: { errno: doctorErrno(error) },
		});
	}
}
