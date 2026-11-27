import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getTrustedHomeDir } from "@gajae-code/utils";
import {
	countSessionOwnerEntries,
	SESSION_OWNERS_RELATIVE_DIR,
	type SessionOwnerEntryCounts,
} from "../../session/session-owners-layout";
import { type DoctorCollector, doctorCheck } from "./checks";
import { doctorErrno } from "./files";
import { canonicalDigest } from "./ids";
import { collectDoctorProbe, type DoctorProbeResult } from "./probe-client";
import type { DoctorCheck } from "./types";

/**
 * Above this many sidecars the doctor warns. Sidecar pruning is not implemented yet, so one empty
 * `.session-owner` file per session ever opened accumulates; they are harmless, and must not be
 * deleted by hand while gjc runs (a deleted sidecar lets a second process lock a new one). 100,000
 * is years of heavy use (about 50 sessions a day for five years), so the warning means an outlier
 * worth reporting, not ordinary use; 10,000 fired within a year for heavy users.
 */
export const SESSION_OWNER_SIDECAR_LIMIT = 100_000;

/** The sidecar count, from `readdir` alone, so it stands even when the lock probe times out. */
function sidecarCheck(targetId: string, counts: SessionOwnerEntryCounts | { readonly errno?: string }): DoctorCheck {
	if (!("sidecars" in counts))
		return doctorCheck("session.owners.sidecars", targetId, {
			execution: "blocked",
			health: "unknown",
			evidenceLevel: "observed",
			reasonCode: "session_owner_sidecars_unreadable",
			evidence: counts.errno ? { errno: counts.errno } : {},
		});
	const over = counts.sidecars > SESSION_OWNER_SIDECAR_LIMIT;
	return doctorCheck("session.owners.sidecars", targetId, {
		execution: "completed",
		health: over ? "warning" : "ok",
		evidenceLevel: "observed",
		reasonCode: over ? "session_owner_sidecars_over_limit" : "session_owner_sidecars_within_limit",
		evidence: {
			count: counts.sidecars,
			counts: { records: counts.records, unrecognized: counts.unrecognized, limit: SESSION_OWNER_SIDECAR_LIMIT },
		},
	});
}

/** The holders check from the probe child, or why the probe gave none. */
function holdersChecks(targetId: string, result: DoctorProbeResult): DoctorCheck[] {
	if (result.status === "completed" && result.receipt)
		return result.receipt.checks
			.filter(check => check.id === "session.owners.holders")
			.map(check => ({ ...check, targetId }));
	return [
		doctorCheck("session.owners.holders", targetId, {
			execution: result.status === "timeout" ? "timeout" : result.status === "cancelled" ? "cancelled" : "blocked",
			health: "unknown",
			evidenceLevel: "observed",
			reasonCode: result.reasonCode,
		}),
	];
}

/** Both checks for a present owners directory; exported for tests of the probe-failure paths. */
export function sessionOwnersChecks(
	targetId: string,
	counts: SessionOwnerEntryCounts | { readonly errno?: string },
	probe: DoctorProbeResult,
): DoctorCheck[] {
	return [...holdersChecks(targetId, probe), sidecarCheck(targetId, counts)];
}

/**
 * Session ownership (design §2.9). A home with no owners directory has nothing to check, so no
 * probe runs. Otherwise the sidecar count comes from `readdir` here, and a probe child does the
 * lock work, as native code may fail to load.
 */
export const SESSION_COLLECTOR: DoctorCollector = {
	id: "session",
	dependsOn: [],
	timeoutMs: 5_000,
	async collect(context) {
		let owners: string;
		try {
			owners = path.join(getTrustedHomeDir(), SESSION_OWNERS_RELATIVE_DIR);
		} catch {
			owners = "";
		}
		const targetId = `t1:session-owners:r${canonicalDigest(["session-owners", owners])}`;
		const absent =
			owners !== "" &&
			(await fs.lstat(owners).then(
				() => false,
				(error: NodeJS.ErrnoException) => error.code === "ENOENT",
			));
		if (absent)
			return ["session.owners.holders", "session.owners.sidecars"].map(id =>
				doctorCheck(id, targetId, {
					execution: "completed",
					health: "not_applicable",
					evidenceLevel: "observed",
					reasonCode: "session_owners_absent",
				}),
			);
		let counts: SessionOwnerEntryCounts | { readonly errno?: string };
		try {
			counts = countSessionOwnerEntries(owners);
		} catch (error) {
			counts = { errno: doctorErrno(error) };
		}
		return sessionOwnersChecks(targetId, counts, await collectDoctorProbe(context, "session-owners"));
	},
};
