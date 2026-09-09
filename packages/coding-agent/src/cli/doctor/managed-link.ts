import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	exactReplacePath,
	exactSwapManagedLink,
	getDoctorLinkProtocolVersion,
	type NativeExactFileIdentity,
	verifyOwnerOnlyFdSecurity,
} from "@gajae-code/natives";
import { type DoctorFileObservation, readDoctorFile } from "./files";
import { candidateLinkId, linkTargetId, resolveDoctorRoot } from "./ids";
import { DoctorJournal, DoctorJournalCreateError } from "./journal";

export type ManagedLinkKind = "source" | "wrapper" | "binary";
export interface ManagedLinkCandidate {
	readonly id: string;
	readonly kind: ManagedLinkKind;
	readonly path: string;
	readonly exists: boolean;
	readonly provenance: "workspace" | "unknown";
}
export interface ManagedLinkDescriptor {
	readonly schemaVersion: 1;
	readonly targetId: string;
	readonly alias: string;
	readonly targetPath: string;
	readonly parentPath: string;
	readonly status: "healthy" | "broken" | "foreign" | "unknown";
	readonly receiptTrusted: boolean;
	readonly candidates: readonly ManagedLinkCandidate[];
	readonly reasonCode?: string;
}
export interface ManagedLinkRepairRequest {
	readonly targetPath: string;
	readonly alias: string;
	readonly root: string;
	readonly ref: string;
	readonly mode: "dry-run" | "fix";
	readonly allowRisks: readonly string[];
	readonly yes: boolean;
	readonly journalRoot?: string;
	readonly runId?: string;
}
export interface ManagedLinkRepairResult {
	readonly state:
		| "planned"
		| "verified"
		| "not_needed"
		| "blocked"
		| "rolled_back"
		| "rollback_conflict"
		| "unsupported"
		| "failed"
		| "uncertain";
	readonly changed: boolean;
	readonly sideEffectStarted: boolean;
	readonly reasonCode?: string;
}
interface ReceiptBody {
	readonly version: 1;
	readonly alias: string;
	readonly target: string;
	readonly root: string;
	readonly source: string;
	readonly parent: string;
	readonly identity: { readonly dev: string; readonly ino: string };
}
interface LinkSnapshot {
	readonly stat: BigIntStats;
	readonly parent: BigIntStats;
	readonly target: string;
}
interface CandidateSnapshot {
	readonly stat: BigIntStats;
	readonly candidate: ManagedLinkCandidate;
}
interface LinkAuthority {
	readonly root: string;
	readonly targetPath: string;
	readonly alias: string;
	/** Absent only when the managed alias name is unoccupied and the receipt still proves ownership. */
	readonly link?: LinkSnapshot;
	readonly parent: BigIntStats;
	readonly receipt: Extract<DoctorFileObservation, { status: "read" }>;
	readonly body: ReceiptBody;
	readonly candidates: readonly CandidateSnapshot[];
}
const authorities = new WeakMap<ManagedLinkDescriptor, LinkAuthority>();
const REPAIR_ID = "install.repair-managed-link";
function digest(body: ReceiptBody): string {
	return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}
function receiptPath(target: string): string {
	return `${target}.gjc-managed.json`;
}
function sameStat(a: BigIntStats, b: BigIntStats): boolean {
	return (
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.nlink === b.nlink &&
		a.size === b.size &&
		a.mtimeNs === b.mtimeNs &&
		a.mode === b.mode &&
		a.uid === b.uid
	);
}
async function linkSnapshot(target: string): Promise<LinkSnapshot | undefined> {
	try {
		const before = await fs.lstat(target, { bigint: true });
		if (!before.isSymbolicLink()) return undefined;
		const parent = await fs.lstat(path.dirname(target), { bigint: true });
		if (!parent.isDirectory() || parent.isSymbolicLink()) return undefined;
		const value = await fs.readlink(target);
		const after = await fs.lstat(target, { bigint: true });
		const parentAfter = await fs.lstat(path.dirname(target), { bigint: true });
		if (
			!sameStat(before, after) ||
			before.ctimeNs !== after.ctimeNs ||
			parent.dev !== parentAfter.dev ||
			parent.ino !== parentAfter.ino
		)
			return undefined;
		return { stat: after, parent, target: value };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
function parseReceipt(
	observation: DoctorFileObservation,
	target: string,
	root: string,
	alias: string,
): ReceiptBody | undefined {
	if (observation.status !== "read") return undefined;
	let value: unknown;
	try {
		value = JSON.parse(observation.text);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Partial<ReceiptBody> & { auth?: unknown };
	if (
		record.version !== 1 ||
		record.alias !== alias ||
		record.target !== target ||
		record.root !== root ||
		record.parent !== path.dirname(target) ||
		typeof record.source !== "string" ||
		!record.identity ||
		typeof record.identity.dev !== "string" ||
		typeof record.identity.ino !== "string"
	)
		return undefined;
	const body: ReceiptBody = {
		version: 1,
		alias,
		target,
		root,
		source: record.source,
		parent: record.parent,
		identity: record.identity,
	};
	return record.auth === digest(body) ? body : undefined;
}
function ownedReceipt(observation: DoctorFileObservation): boolean {
	return (
		observation.status === "read" &&
		(observation.identity.mode & 0o077) === 0 &&
		observation.identity.links === 1 &&
		(process.getuid === undefined || observation.identity.owner === process.getuid())
	);
}

/** Public values describe candidates; the private map retains the original filesystem authority. */
export async function describeManagedLink(
	targetPath: string,
	root: string,
	alias = "gjc",
): Promise<ManagedLinkDescriptor> {
	const target = path.resolve(targetPath);
	const workspace = path.resolve(root);
	const parentPath = path.dirname(target);
	const rootId = resolveDoctorRoot("install", parentPath).rootId;
	const candidates: CandidateSnapshot[] = [];
	const publicCandidates: ManagedLinkCandidate[] = [];
	for (const [kind, relative] of [
		["source", "packages/coding-agent/src/cli.ts"],
		["wrapper", "packages/coding-agent/bin/gjc.js"],
		["binary", "packages/coding-agent/dist/gjc"],
	] as const) {
		const candidatePath = path.join(workspace, relative);
		let stat: BigIntStats | undefined;
		try {
			stat = await fs.lstat(candidatePath, { bigint: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const exists = stat?.isFile() === true && !stat.isSymbolicLink() && stat.nlink === 1n;
		const candidate: ManagedLinkCandidate = {
			id: candidateLinkId(rootId, kind, candidatePath),
			kind,
			path: candidatePath,
			exists,
			provenance: exists ? "workspace" : "unknown",
		};
		publicCandidates.push(candidate);
		if (exists && stat) candidates.push({ stat, candidate });
	}
	const receipt = await readDoctorFile(receiptPath(target), 16 * 1024);
	const body = parseReceipt(receipt, target, workspace, alias);
	const link = await linkSnapshot(target);
	const occupant = await fs.lstat(target).catch(() => undefined);
	const parent = await fs.lstat(parentPath, { bigint: true }).catch(() => undefined);
	const trustedReceipt =
		!!body && ownedReceipt(receipt) && publicCandidates.some(candidate => candidate.path === body.source);
	const identityMatches =
		!!body &&
		!!link &&
		body.identity.dev === link.stat.dev.toString() &&
		body.identity.ino === link.stat.ino.toString();
	const owned = trustedReceipt && (link ? identityMatches : occupant === undefined);
	const recordedCandidate = body && publicCandidates.find(candidate => candidate.path === body.source);
	let status: ManagedLinkDescriptor["status"] = "unknown";
	let reasonCode: string | undefined = "ownership_receipt_untrusted";
	if (owned && body) {
		if (!link) {
			status = "broken";
			reasonCode = "target_missing";
		} else if (path.resolve(parentPath, link.target) !== body.source) {
			status = "broken";
			reasonCode = "target_drifted_from_receipt";
		} else if (!recordedCandidate?.exists) {
			status = "broken";
			reasonCode = "recorded_source_missing";
		} else {
			status = "healthy";
			reasonCode = undefined;
		}
	} else if (occupant) status = "foreign";
	else if (link) status = "foreign";
	const descriptor: ManagedLinkDescriptor = {
		schemaVersion: 1,
		targetId: linkTargetId(rootId, alias),
		alias,
		targetPath: target,
		parentPath,
		status,
		receiptTrusted: owned,
		candidates: publicCandidates,
		...(reasonCode ? { reasonCode } : {}),
	};
	if (owned && body && receipt.status === "read" && parent)
		authorities.set(descriptor, {
			root: workspace,
			targetPath: target,
			alias,
			link,
			parent,
			receipt,
			body,
			candidates,
		});
	return descriptor;
}

async function refreshReceipt(
	authority: LinkAuthority,
	parent: BigIntStats,
	source: string,
	published: LinkSnapshot,
): Promise<void> {
	const body: ReceiptBody = {
		...authority.body,
		source,
		identity: { dev: published.stat.dev.toString(), ino: published.stat.ino.toString() },
	};
	const text = `${JSON.stringify({ ...body, auth: digest(body) })}\n`;
	const temporary = `${receiptPath(authority.targetPath)}.${randomUUID()}.tmp`;
	const handle = await fs.open(
		temporary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	let expected: NativeExactFileIdentity;
	try {
		await handle.writeFile(text, "utf8");
		await handle.sync();
		const stat = await handle.stat({ bigint: true });
		expected = {
			dev: stat.dev,
			ino: stat.ino,
			nlink: stat.nlink,
			size: stat.size,
			mtimeNs: stat.mtimeNs,
			parentDev: parent.dev,
			parentIno: parent.ino,
			sha256: createHash("sha256").update(text).digest("hex"),
		};
	} finally {
		await handle.close();
	}
	if (!exactReplacePath(temporary, receiptPath(authority.targetPath), expected, authority.receipt.exactIdentity).ok)
		throw new Error("receipt_changed");
}

async function syncParent(parentPath: string, expected: BigIntStats): Promise<void> {
	const parent = await fs.open(
		parentPath,
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const stat = await parent.stat({ bigint: true });
		if (stat.dev !== expected.dev || stat.ino !== expected.ino) throw new Error("parent_changed");
		await parent.sync();
	} finally {
		await parent.close();
	}
}

export async function repairManagedLink(
	request: ManagedLinkRepairRequest,
	descriptor: ManagedLinkDescriptor,
): Promise<ManagedLinkRepairResult> {
	const refuse = (reasonCode: string): ManagedLinkRepairResult => ({
		state: "blocked",
		changed: false,
		sideEffectStarted: false,
		reasonCode,
	});
	if (!request.allowRisks.includes("install-replace") || !request.yes) return refuse("authorization_missing");
	if (!request.ref) return refuse("candidate_selection_missing");
	const known = descriptor.candidates.find(candidate => candidate.id === request.ref);
	if (!known) return refuse("candidate_selection_missing");
	const authority = authorities.get(descriptor);
	if (
		!authority ||
		path.resolve(request.targetPath) !== authority.targetPath ||
		path.resolve(request.root) !== authority.root ||
		request.alias !== authority.alias
	)
		return refuse(descriptor.reasonCode ?? "original_authority_missing");
	const selected = authority.candidates.find(item => item.candidate.id === request.ref);
	if (!selected) return refuse("candidate_unresolved");
	if (request.mode === "dry-run") return { state: "planned", changed: false, sideEffectStarted: false };
	const current = await linkSnapshot(authority.targetPath);
	const receipt = await readDoctorFile(receiptPath(authority.targetPath), 16 * 1024);
	const parent = await fs.lstat(descriptor.parentPath, { bigint: true }).catch(() => undefined);
	const candidateNow = await fs.lstat(selected.candidate.path, { bigint: true }).catch(() => undefined);
	const linkUnchanged = authority.link
		? !!current && sameStat(current.stat, authority.link.stat) && current.target === authority.link.target
		: current === undefined && (await fs.lstat(authority.targetPath).catch(() => undefined)) === undefined;
	if (
		!linkUnchanged ||
		!parent ||
		parent.dev !== authority.parent.dev ||
		parent.ino !== authority.parent.ino ||
		receipt.status !== "read" ||
		receipt.text !== authority.receipt.text ||
		receipt.exactIdentity.dev !== authority.receipt.exactIdentity.dev ||
		receipt.exactIdentity.ino !== authority.receipt.exactIdentity.ino ||
		!candidateNow ||
		!sameStat(candidateNow, selected.stat)
	)
		return refuse("identity_recheck_required");
	if (getDoctorLinkProtocolVersion() !== 2) return refuse("native_boundary_unavailable");
	const receiptHandle = await fs.open(
		receiptPath(authority.targetPath),
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		if (!verifyOwnerOnlyFdSecurity(receiptPath(authority.targetPath), "file", receiptHandle.fd).ok)
			return refuse("receipt_security_unproven");
	} finally {
		await receiptHandle.close();
	}
	if (current && path.resolve(descriptor.parentPath, current.target) === selected.candidate.path)
		return { state: "not_needed", changed: false, sideEffectStarted: false };
	if (!request.journalRoot || !request.runId) return refuse("journal_identity_missing");
	let journal: DoctorJournal;
	try {
		journal = await DoctorJournal.create(request.journalRoot, request.runId);
	} catch (error) {
		const started = error instanceof DoctorJournalCreateError ? error.sideEffectStarted : true;
		return {
			state: started ? "uncertain" : "blocked",
			changed: false,
			sideEffectStarted: started,
			reasonCode: "journal_unavailable",
		};
	}
	const staged = `${authority.targetPath}.doctor-stage-${request.runId}`;
	const quarantine = `${authority.targetPath}.doctor-old-${request.runId}`;
	let published: LinkSnapshot | undefined;
	let retained = staged;
	try {
		await journal.append({
			repairId: REPAIR_ID,
			targetId: descriptor.targetId,
			phase: "before",
			before: current
				? {
						exists: true,
						dev: current.stat.dev.toString(),
						ino: current.stat.ino.toString(),
						parentDev: parent.dev.toString(),
						parentIno: parent.ino.toString(),
						quarantineName: path.basename(quarantine),
					}
				: { exists: false, parentDev: parent.dev.toString(), parentIno: parent.ino.toString() },
		});
		await journal.append({ repairId: REPAIR_ID, targetId: descriptor.targetId, phase: "applying" });
		if (!current) {
			// The managed name is unoccupied: exclusive creation is the whole mutation.
			await fs.symlink(selected.candidate.path, authority.targetPath);
			published = await linkSnapshot(authority.targetPath);
			if (!published || published.target !== selected.candidate.path) throw new Error("link_postcheck_failed");
			retained = authority.targetPath;
		} else {
			await fs.symlink(selected.candidate.path, staged);
			const stage = await linkSnapshot(staged);
			if (!stage) throw new Error("stage_unverified");
			const result = exactSwapManagedLink(
				staged,
				authority.targetPath,
				quarantine,
				parent.dev.toString(),
				parent.ino.toString(),
				current.stat.dev.toString(),
				current.stat.ino.toString(),
				current.target,
				stage.stat.dev.toString(),
				stage.stat.ino.toString(),
				selected.candidate.path,
			);
			if (!result.verified || result.status !== "verified") throw new Error("swap_unverified");
			retained = result.code === "old_artifact_retained_at_quarantine" ? quarantine : staged;
			published = await linkSnapshot(authority.targetPath);
			const old = await linkSnapshot(retained);
			if (
				!published ||
				!old ||
				published.stat.dev !== stage.stat.dev ||
				published.stat.ino !== stage.stat.ino ||
				published.target !== selected.candidate.path ||
				old.stat.dev !== current.stat.dev ||
				old.stat.ino !== current.stat.ino ||
				old.target !== current.target
			)
				throw new Error("link_postcheck_failed");
		}
		await refreshReceipt(authority, parent, selected.candidate.path, published);
		await syncParent(descriptor.parentPath, parent);
		const after = await describeManagedLink(authority.targetPath, authority.root, authority.alias);
		if (!after.receiptTrusted || after.status !== "healthy") throw new Error("receipt_postcheck_failed");
		await journal.append({
			repairId: REPAIR_ID,
			targetId: descriptor.targetId,
			phase: "verified",
			after: {
				exists: true,
				dev: published.stat.dev.toString(),
				ino: published.stat.ino.toString(),
				parentDev: parent.dev.toString(),
				parentIno: parent.ino.toString(),
			},
			outcome: "verified",
		});
		return { state: "verified", changed: true, sideEffectStarted: true };
	} catch {
		let state: ManagedLinkRepairResult["state"] = "uncertain";
		if (published && current) {
			try {
				const result = exactSwapManagedLink(
					retained,
					authority.targetPath,
					`${authority.targetPath}.doctor-failed-${request.runId}`,
					parent.dev.toString(),
					parent.ino.toString(),
					published.stat.dev.toString(),
					published.stat.ino.toString(),
					published.target,
					current.stat.dev.toString(),
					current.stat.ino.toString(),
					current.target,
				);
				state = result.verified ? "rolled_back" : "rollback_conflict";
			} catch {
				state = "rollback_conflict";
			}
		}
		try {
			await journal.append({
				repairId: REPAIR_ID,
				targetId: descriptor.targetId,
				phase: state === "rolled_back" ? "failed" : "uncertain",
				outcome: state,
			});
		} catch {
			state = "uncertain";
		}
		return {
			state,
			changed: published !== undefined,
			sideEffectStarted: true,
			reasonCode: "managed_link_transaction_unverified",
		};
	} finally {
		journal.close();
	}
}
