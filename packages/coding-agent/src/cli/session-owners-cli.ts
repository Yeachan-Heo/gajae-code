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
	SessionOwnershipError,
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

/** A refusal the operator can act on: a fixed message and a machine code, never a stack or a path. */
function commandFailure(error: unknown): { code: string; message: string } | undefined {
	if (error instanceof SessionOwnershipError) return { code: error.code, message: error.operatorMessage };
	const errno = (error as { code?: unknown } | undefined)?.code;
	if (typeof errno === "string" && /^E[A-Z0-9]+$/.test(errno))
		return { code: errno, message: `gjc could not read the session owners directory (${errno}).` };
	return undefined;
}

/** `gjc session owners [--json]`. A refused or unreadable directory exits 1 with its code. */
export async function runSessionOwnersCommand(json: boolean): Promise<void> {
	let report: SessionOwnersReport;
	try {
		report = await collectSessionOwnersReport();
	} catch (error) {
		const failure = commandFailure(error);
		if (!failure) throw error;
		if (json)
			process.stdout.write(
				`${JSON.stringify({ ok: false, reason: "session_owners_unavailable", code: failure.code }, null, 2)}\n`,
			);
		else process.stderr.write(`${failure.message}\n`);
		process.exitCode = 1;
		return;
	}
	process.stdout.write(
		json
			? `${JSON.stringify({ ok: true, ...report }, null, 2)}\n`
			: `${renderSessionOwnersText(report).join("\n")}\n`,
	);
}
