/**
 * `gjc session owners`: which processes hold sessions open for writing (design §2.9).
 *
 * Read-only. It probes sidecar locks and reads holder records; it never claims, breaks or
 * rewrites anything, and never creates the owners directory. Every printed field comes from
 * {@link inspectSessionOwners}, which checks record fields against fixed shapes.
 */
import { formatBytes, formatDuration } from "@gajae-code/utils";
import { nativeProcessBindings } from "@gajae-code/utils/native-process";
import {
	inspectSessionOwners,
	type SessionOwnerSidecar,
	type SessionOwnersInventory,
} from "../session/session-ownership";

const MAX_ANCESTORS = 64;

/** This process's ancestors, nearest first; init and anything unreadable end the walk. */
function processAncestors(): Set<number> {
	const ancestors = new Set<number>();
	let pid: number | null | undefined = process.ppid;
	while (pid && pid > 1 && !ancestors.has(pid) && ancestors.size < MAX_ANCESTORS) {
		ancestors.add(pid);
		try {
			pid = nativeProcessBindings().Process.fromPid(pid)?.ppid;
		} catch {
			pid = undefined;
		}
	}
	return ancestors;
}

export interface SessionOwnerRow extends SessionOwnerSidecar {
	/** Held by this process or one of its ancestors (a gjc whose shell ran this command). */
	readonly processTree: boolean;
	readonly ageMs?: number;
}

export interface SessionOwnersReport extends Omit<SessionOwnersInventory, "held"> {
	readonly owners: readonly SessionOwnerRow[];
}

export async function collectSessionOwnersReport(now = Date.now()): Promise<SessionOwnersReport> {
	const inventory = await inspectSessionOwners();
	const ancestors = processAncestors();
	const { held, ...counts } = inventory;
	const owners = held.map((sidecar): SessionOwnerRow => {
		const holder = sidecar.holder;
		const claimedAt = holder?.claimedAt ? Date.parse(holder.claimedAt) : Number.NaN;
		const ageMs = Number.isFinite(claimedAt) && claimedAt <= now ? now - claimedAt : undefined;
		const processTree =
			sidecar.self || (holder !== undefined && holder.host === undefined && ancestors.has(holder.pid));
		return { ...sidecar, processTree, ...(ageMs === undefined ? {} : { ageMs }) };
	});
	return { ...counts, owners };
}

function ownerLine(owner: SessionOwnerRow): string {
	const fields = [owner.sessionId ?? owner.key];
	const holder = owner.holder;
	if (owner.state === "unknown") fields.push("lock state unknown");
	if (holder) {
		fields.push(holder.surface, `pid ${holder.pid}`);
		if (holder.host) fields.push(`host ${holder.host}`);
		if (owner.ageMs !== undefined) fields.push(`held ${formatDuration(owner.ageMs)}`);
		if (holder.gjcVersion) fields.push(`gjc ${holder.gjcVersion}`);
		if (owner.self) fields.push("this process");
	} else if (owner.record === "holder_gone") fields.push(`holder pid ${owner.gonePid} is gone (record is stale)`);
	else fields.push(`another gjc process (record ${owner.record})`);
	return `  ${fields.join("  ")}`;
}

export function renderSessionOwnersText(report: SessionOwnersReport): string[] {
	if (report.directory === "missing" && report.owners.length === 0)
		return ["No session owners directory: no session has been claimed under this home."];
	const lines = [
		`Sidecars: ${report.sidecars}, records: ${report.records}, on disk: ${formatBytes(report.diskBytes)}` +
			(report.unrecognized > 0 ? `, unrecognized entries: ${report.unrecognized}` : ""),
	];
	const tree = report.owners.filter(owner => owner.processTree);
	const others = report.owners.filter(owner => !owner.processTree);
	lines.push("Held by this process tree:", ...(tree.length > 0 ? tree.map(ownerLine) : ["  none"]));
	lines.push("Held by other processes:", ...(others.length > 0 ? others.map(ownerLine) : ["  none"]));
	return lines;
}
