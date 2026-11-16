import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type * as NativeBindings from "@gajae-code/natives";
import type { NativeExactFileIdentity, Process as NativeProcess } from "@gajae-code/natives";
import { nativeProcessBindings } from "@gajae-code/utils/native-process";
import { parseMacPlatformUuid, parseWindowsMachineGuid } from "../config/machine-identity";
import { isProcessIncarnation } from "../sdk/broker/process-incarnation";
import { statFromNode } from "../sdk/session-readonly/storage";
import type { SdkResumeCheckpoint } from "./resume-cursor";
import { FileSessionStorage, type SessionStorageExclusiveLock } from "./session-storage";

/** Internal, transcript-adjacent authority. No agentDir, endpoint age, or heartbeat is authority here. */
export type OwnerMode = "cooperative" | "exclusive_native";
export type OwnerState = "live" | "retired" | "transfer_reserved" | "incoming" | "moved" | "settled";
export type OwnerLiveness = "live" | "dead" | "unknown";
export type OwnershipVeto =
	| "legacy_lifecycle_ambiguous"
	| "authority_roots_unresolved"
	| "owned_by_other"
	| "unknown_ownership";
export type OwnerRefusal =
	| OwnershipVeto
	| "authority_changed"
	| "stale_snapshot"
	| "legacy_attestation_required"
	| "authority_lost_unresolved"
	| "participation_lost"
	| "policy_mismatch"
	| "transfer_in_progress"
	| "transfer_abandoned_ambiguous"
	| "destination_authority_conflict"
	| "session_moved"
	| "authority_busy"
	| "invalid_owner_target"
	| "transcript_hardlinked"
	| "invalid_membership"
	| "invalid_transfer";

export class OwnerAuthorityError extends Error {
	constructor(readonly code: OwnerRefusal) {
		super(code);
		this.name = "OwnerAuthorityError";
	}
}
function refuse(code: OwnerRefusal): never {
	throw new OwnerAuthorityError(code);
}

export interface OwnerRoot {
	readonly realpath: string;
	readonly dev: string;
	readonly ino: string;
}
export interface OwnerTarget {
	readonly transcriptPath: string;
	readonly headerId: string;
	readonly authorityKey: string;
	readonly authorityRoot: OwnerRoot;
	readonly snapshotDigest: string;
	readonly transcriptExists: boolean;
}
export interface OwnerMember {
	readonly memberId: string;
	readonly runtime: string;
	readonly pid: number;
	readonly processIncarnation: string;
	readonly hostId: string;
	readonly capabilities: readonly string[];
}
export interface LegacyTakeoverAttestation {
	readonly kind: "legacy_takeover";
	readonly authorityKey: string;
	readonly snapshotDigest: string;
	readonly vetoDigest: string;
	readonly markerDigest: string;
}
export type SessionOwnerPolicy =
	| Readonly<{ kind: "cooperative" }>
	| Readonly<{
			kind: "exclusive_native";
			expected: { readonly snapshotDigest: string; readonly resolved: SdkResumeCheckpoint };
			legacyAttestation?: LegacyTakeoverAttestation;
	  }>;
export interface OwnerVetoEvidence {
	readonly kind: "clear" | OwnershipVeto;
	readonly digest: string;
	readonly evidence: readonly unknown[];
}
export type OwnerMarkerEvidence = Readonly<{
	kind: "absent" | "present" | "unknown";
	digest: string;
	snapshotDigest: string;
	members: readonly OwnerMember[];
}>;
/** These are internal read-only inspectors, not user-controllable bypass switches. */
export interface OwnerInspectors {
	readonly inspectVetoes: (target: OwnerTarget) => OwnerVetoEvidence;
	readonly readMarkers: (target: OwnerTarget) => OwnerMarkerEvidence;
}
export interface OwnerAsyncInspectors {
	readonly inspectVetoes: (target: OwnerTarget) => Promise<OwnerVetoEvidence>;
	readonly readMarkers: (target: OwnerTarget) => Promise<OwnerMarkerEvidence>;
}
export interface OwnerAsyncAdmissionOptions extends OwnerAsyncInspectors {
	readonly runtime: string;
	readonly capabilities: readonly string[];
}
export interface OwnerAdmissionOptions extends OwnerInspectors {
	readonly runtime: string;
	readonly capabilities: readonly string[];
}
export interface OwnerMembershipEvidence {
	readonly policy: SessionOwnerPolicy;
	readonly memberKind: OwnerMode;
	readonly authorityKey: string;
	readonly memberId: string;
	readonly epoch: string;
	readonly rev: number;
	readonly snapshotDigest: string;
}
declare const ownerMembershipBrand: unique symbol;
export interface OwnerMembership {
	readonly [ownerMembershipBrand]: true;
}
declare const ownerTransferBrand: unique symbol;
export interface OwnerTransfer {
	readonly [ownerTransferBrand]: true;
}
export interface OwnerFirstWriteMarker {
	readonly authorityKey: string;
	readonly headerId: string;
	readonly epoch: string;
	readonly rev: number;
	readonly memberId: string;
	readonly runtime: string;
	readonly pid: number;
	readonly processIncarnation: string;
	readonly hostId: string;
	readonly capabilities: readonly string[];
}
export interface OwnerTransferData {
	transferId: string;
	from: OwnerTarget;
	to: OwnerTarget;
	initiator: OwnerMember;
}
export interface OwnerRecord {
	readonly v: 1;
	readonly rev: number;
	readonly state: OwnerState;
	readonly headerId: string;
	readonly authorityRoot: OwnerRoot;
	readonly ownerDirectory: OwnerRoot;
	readonly epoch: string;
	readonly mode: OwnerMode;
	readonly members: readonly OwnerMember[];
	readonly transfer?: OwnerTransferData;
}
export interface OwnerDirectoryPublicationReceipt {
	readonly kind: "checked_directory_rename";
	readonly sourceDirectory: string;
	readonly destinationDirectory: string;
	readonly namespaceSynced: true;
}
interface MembershipData {
	target: OwnerTarget;
	policy: SessionOwnerPolicy;
	member: OwnerMember;
	epoch: string;
	rev: number;
	snapshotDigest: string;
	markerRequired: boolean;
	marker?: OwnerFirstWriteMarker;
	retired: boolean;
	inspectors: OwnerInspectors;
	asyncInspectors?: OwnerAsyncInspectors;
	publishing: boolean;
	admissionStamp: string;
	pendingTransfer?: OwnerTransfer;
	directoryPublicationEligible?: boolean;
	directoryPublicationUnresolved?: boolean;
}
interface TransferHandle {
	data: OwnerTransferData;
	membership: OwnerMembership;
	epoch: string;
	rev: number;
}
const memberships = new WeakMap<OwnerMembership, MembershipData>();
const transfers = new WeakMap<OwnerTransfer, TransferHandle>();
const consumedAttestations = new WeakSet<LegacyTakeoverAttestation>();
const issuedAttestations = new WeakSet<LegacyTakeoverAttestation>();
const storage = new FileSessionStorage();
const lockedDirectories = new Map<string, OwnerRoot>();
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_READ_BYTES = 64 * 1024;
const MAX_MEMBERS = 256;
const HEX = /^[0-9a-f]{64}$/;
const EPOCH = /^[0-9a-f]{32}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
let nativeBindings: typeof NativeBindings | undefined;
function native(): typeof NativeBindings {
	nativeBindings ??= require("@gajae-code/natives") as typeof NativeBindings;
	return nativeBindings;
}
function hash(bytes: string | Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}
function nonce(): string {
	return randomBytes(16).toString("hex");
}
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 1024;
}
function sameRoot(a: OwnerRoot, b: OwnerRoot): boolean {
	return a.realpath === b.realpath && a.dev === b.dev && a.ino === b.ino;
}
function sameStat(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
	return (
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.nlink === b.nlink &&
		a.size === b.size &&
		a.mtimeNs === b.mtimeNs &&
		a.ctimeNs === b.ctimeNs
	);
}
function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
function rootAt(directory: string): OwnerRoot {
	const realpath = fs.realpathSync.native(directory);
	const stat = fs.lstatSync(realpath, { bigint: true });
	if (!stat.isDirectory() || stat.isSymbolicLink()) refuse("authority_roots_unresolved");
	return Object.freeze({ realpath, dev: stat.dev.toString(), ino: stat.ino.toString() });
}
function assertRoot(root: OwnerRoot): void {
	try {
		if (!sameRoot(rootAt(root.realpath), root)) refuse("authority_changed");
	} catch (error) {
		if (error instanceof OwnerAuthorityError) throw error;
		refuse("authority_changed");
	}
}
interface FileBytes {
	bytes: Buffer;
	stat: fs.BigIntStats;
	digest: string;
}
/** Exact descriptor observation: retain only the requested prefix, but hash and revalidate the entire file. */
function readExact(
	file: string,
	limit: number,
	ownerOnly: boolean,
	singleLink: boolean,
	retainByteLimit = limit,
): FileBytes | undefined {
	let before: fs.BigIntStats;
	try {
		before = fs.lstatSync(file, { bigint: true });
	} catch (error) {
		if (missing(error)) return undefined;
		throw error;
	}
	if (
		!before.isFile() ||
		before.isSymbolicLink() ||
		(singleLink && before.nlink !== 1n) ||
		before.size > BigInt(limit)
	)
		refuse("unknown_ownership");
	const fd = fs.openSync(file, FLAGS);
	try {
		const opened = fs.fstatSync(fd, { bigint: true });
		if (!sameStat(before, opened)) refuse("authority_changed");
		if (ownerOnly && !native().verifyOwnerOnlyFdSecurity(file, "file", fd).ok) refuse("unknown_ownership");
		const size = Number(opened.size);
		const bytes = Buffer.alloc(Math.min(size, retainByteLimit));
		const scratch = Buffer.alloc(Math.max(1, Math.min(size, MAX_READ_BYTES)));
		const digest = createHash("sha256");
		let offset = 0;
		while (offset < size) {
			const count = fs.readSync(fd, scratch, 0, Math.min(scratch.length, size - offset), offset);
			if (count === 0) refuse("authority_changed");
			digest.update(scratch.subarray(0, count));
			if (offset < bytes.length) scratch.copy(bytes, offset, 0, Math.min(count, bytes.length - offset));
			offset += count;
		}
		if (fs.readSync(fd, scratch, 0, 1, offset) !== 0) refuse("authority_changed");
		if (
			!sameStat(opened, fs.fstatSync(fd, { bigint: true })) ||
			!sameStat(opened, fs.lstatSync(file, { bigint: true }))
		)
			refuse("authority_changed");
		return { bytes, stat: opened, digest: digest.digest("hex") };
	} finally {
		fs.closeSync(fd);
	}
}
function transcriptSnapshot(
	target: Pick<OwnerTarget, "transcriptPath" | "headerId" | "authorityRoot">,
	exclusive: boolean,
): FileBytes | undefined {
	assertRoot(target.authorityRoot);
	const named = (() => {
		try {
			return fs.lstatSync(target.transcriptPath, { bigint: true });
		} catch (error) {
			if (missing(error)) return undefined;
			throw error;
		}
	})();
	if (named?.isSymbolicLink()) refuse("invalid_owner_target");
	if (exclusive && named && named.nlink !== 1n) refuse("transcript_hardlinked");
	const snap = readExact(target.transcriptPath, MAX_TRANSCRIPT_BYTES, false, exclusive, MAX_HEADER_BYTES + 1);
	if (snap) {
		const end = snap.bytes.indexOf(10);
		if ((end === -1 ? snap.bytes.length : end) > MAX_HEADER_BYTES) refuse("invalid_owner_target");
		let header: unknown;
		try {
			header = JSON.parse(snap.bytes.subarray(0, end === -1 ? snap.bytes.length : end).toString("utf8"));
		} catch {
			refuse("invalid_owner_target");
		}
		if (!object(header) || header.type !== "session" || header.id !== target.headerId) refuse("invalid_owner_target");
	}
	assertRoot(target.authorityRoot);
	return snap;
}

export function captureOwnerTargetSync(input: {
	readonly transcriptPath: string;
	readonly headerId: string;
	readonly snapshotDigest?: string;
}): OwnerTarget {
	if (!SAFE_ID.test(input.headerId)) refuse("invalid_owner_target");
	try {
		const parent = rootAt(path.dirname(path.resolve(input.transcriptPath)));
		const transcriptPath = path.join(parent.realpath, path.basename(input.transcriptPath));
		const draft = { transcriptPath, headerId: input.headerId, authorityRoot: parent };
		const snapshot = transcriptSnapshot(draft, false);
		const snapshotDigest = snapshot?.digest ?? hash("");
		if (input.snapshotDigest !== undefined && input.snapshotDigest !== snapshotDigest) refuse("stale_snapshot");
		return Object.freeze({
			...draft,
			authorityKey: path.join(parent.realpath, ".gjc-owners", `${input.headerId}.json`),
			snapshotDigest,
			transcriptExists: snapshot !== undefined,
		});
	} catch (error) {
		if (error instanceof OwnerAuthorityError) throw error;
		refuse("authority_roots_unresolved");
	}
}
function validRoot(value: unknown): value is OwnerRoot {
	return (
		object(value) &&
		text(value.realpath) &&
		path.isAbsolute(value.realpath) &&
		typeof value.dev === "string" &&
		/^\d+$/.test(value.dev) &&
		typeof value.ino === "string" &&
		/^\d+$/.test(value.ino)
	);
}
function validTarget(value: unknown): value is OwnerTarget {
	return (
		object(value) &&
		text(value.transcriptPath) &&
		path.isAbsolute(value.transcriptPath) &&
		typeof value.headerId === "string" &&
		SAFE_ID.test(value.headerId) &&
		validRoot(value.authorityRoot) &&
		value.transcriptPath === path.join(value.authorityRoot.realpath, path.basename(value.transcriptPath)) &&
		value.authorityKey === path.join(value.authorityRoot.realpath, ".gjc-owners", `${value.headerId}.json`) &&
		typeof value.snapshotDigest === "string" &&
		HEX.test(value.snapshotDigest) &&
		typeof value.transcriptExists === "boolean"
	);
}
function validateTarget(target: OwnerTarget): void {
	if (!validTarget(target)) refuse("invalid_owner_target");
	assertRoot(target.authorityRoot);
}
function copyTarget(target: OwnerTarget): OwnerTarget {
	return Object.freeze({ ...target, authorityRoot: Object.freeze({ ...target.authorityRoot }) });
}
function validMember(value: unknown): value is OwnerMember {
	return (
		object(value) &&
		typeof value.memberId === "string" &&
		EPOCH.test(value.memberId) &&
		text(value.runtime) &&
		Number.isSafeInteger(value.pid) &&
		(value.pid as number) > 0 &&
		isProcessIncarnation(value.processIncarnation) &&
		typeof value.hostId === "string" &&
		HEX.test(value.hostId) &&
		Array.isArray(value.capabilities) &&
		value.capabilities.length <= 64 &&
		value.capabilities.every(text) &&
		new Set(value.capabilities).size === value.capabilities.length
	);
}
function validTransfer(value: unknown): value is OwnerTransferData {
	return (
		object(value) &&
		typeof value.transferId === "string" &&
		EPOCH.test(value.transferId) &&
		validTarget(value.from) &&
		validTarget(value.to) &&
		value.from.authorityKey !== value.to.authorityKey &&
		value.from.headerId === value.to.headerId &&
		validMember(value.initiator)
	);
}
function validRecord(value: unknown): value is OwnerRecord {
	return (
		object(value) &&
		value.v === 1 &&
		Number.isSafeInteger(value.rev) &&
		(value.rev as number) > 0 &&
		["live", "retired", "transfer_reserved", "incoming", "moved", "settled"].includes(value.state as string) &&
		typeof value.headerId === "string" &&
		SAFE_ID.test(value.headerId) &&
		validRoot(value.authorityRoot) &&
		validRoot(value.ownerDirectory) &&
		typeof value.epoch === "string" &&
		EPOCH.test(value.epoch) &&
		["cooperative", "exclusive_native"].includes(value.mode as string) &&
		Array.isArray(value.members) &&
		value.members.length <= MAX_MEMBERS &&
		value.members.every(validMember) &&
		new Set(value.members.map(member => member.memberId)).size === value.members.length &&
		(value.mode !== "exclusive_native" || value.members.length <= 1) &&
		(value.state === "retired" ? value.members.length === 0 : value.members.length > 0) &&
		(["transfer_reserved", "incoming", "moved", "settled"].includes(value.state as string)
			? validTransfer(value.transfer)
			: value.transfer === undefined)
	);
}
function directory(target: OwnerTarget, create: boolean): OwnerRoot | undefined {
	validateTarget(target);
	const dir = path.dirname(target.authorityKey);
	let created = false;
	if (create) {
		try {
			fs.mkdirSync(dir, { mode: 0o700 });
			created = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	let stat: fs.BigIntStats;
	try {
		stat = fs.lstatSync(dir, { bigint: true });
	} catch (error) {
		if (missing(error) && !create) return undefined;
		throw error;
	}
	if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(dir) !== dir) refuse("authority_changed");
	const fd = fs.openSync(dir, FLAGS | (fs.constants.O_DIRECTORY ?? 0));
	try {
		const opened = fs.fstatSync(fd, { bigint: true });
		if (!opened.isDirectory() || stat.dev !== opened.dev || stat.ino !== opened.ino) refuse("authority_changed");
		if (!sameRoot({ realpath: dir, dev: opened.dev.toString(), ino: opened.ino.toString() }, rootAt(dir)))
			refuse("authority_changed");
		const security = created
			? native().applyOwnerOnlyFdSecurity(dir, "directory", fd)
			: native().verifyOwnerOnlyFdSecurity(dir, "directory", fd);
		if (!security.ok) refuse("unknown_ownership");
		if (created) {
			fs.fsyncSync(fd);
			syncDirectory(target.authorityRoot.realpath);
		}
	} finally {
		fs.closeSync(fd);
	}
	const root = Object.freeze({ realpath: dir, dev: stat.dev.toString(), ino: stat.ino.toString() });
	const locked = lockedDirectories.get(target.authorityKey);
	if (locked && !sameRoot(root, locked)) refuse("authority_changed");
	return root;
}
function syncDirectory(dir: string): void {
	// A platform/filesystem that cannot establish namespace durability must refuse, not claim success.
	const fd = fs.openSync(dir, FLAGS | (fs.constants.O_DIRECTORY ?? 0));
	try {
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}
interface RecordSnapshot {
	kind: "absent" | "corrupt" | "record";
	file?: FileBytes;
	record?: OwnerRecord;
	ownerDirectory?: OwnerRoot;
}
function readRecord(target: OwnerTarget): RecordSnapshot {
	try {
		return readRecordExact(target);
	} catch (error) {
		if (error instanceof OwnerAuthorityError) throw error;
		refuse("unknown_ownership");
	}
}
function readRecordExact(target: OwnerTarget): RecordSnapshot {
	const ownerDirectory = directory(target, false);
	if (!ownerDirectory) return { kind: "absent" };
	const file = readExact(target.authorityKey, MAX_RECORD_BYTES, true, true);
	if (!file) return { kind: "absent", ownerDirectory };
	let value: unknown;
	try {
		value = JSON.parse(file.bytes.toString("utf8"));
	} catch {
		return { kind: "corrupt", file, ownerDirectory };
	}
	// A decoded identity with missing/unverifiable roots or OS fields is protected, not an empty group.
	if (object(value) && ("members" in value || "epoch" in value || "authorityRoot" in value)) {
		if (
			!validRoot(value.authorityRoot) ||
			!validRoot(value.ownerDirectory) ||
			!sameRoot(value.authorityRoot, target.authorityRoot) ||
			!sameRoot(value.ownerDirectory, ownerDirectory)
		)
			refuse("authority_changed");
		if (!Array.isArray(value.members) || value.members.some(member => !validMember(member)))
			refuse("unknown_ownership");
	}
	if (object(value) && value.v !== undefined && value.v !== 1) refuse("unknown_ownership");
	if (!validRecord(value)) return { kind: "corrupt", file, ownerDirectory };
	if (
		value.headerId !== target.headerId ||
		!sameRoot(value.authorityRoot, target.authorityRoot) ||
		!sameRoot(value.ownerDirectory, ownerDirectory)
	)
		refuse("authority_changed");
	if (value.transfer) {
		if (!value.members.some(member => exactMember(member, value.transfer!.initiator))) refuse("unknown_ownership");
		const location =
			value.state === "incoming" || value.state === "settled" ? value.transfer.to : value.transfer.from;
		if (location.authorityKey !== target.authorityKey || !sameRoot(location.authorityRoot, target.authorityRoot))
			refuse("authority_changed");
	}
	return { kind: "record", file, record: value, ownerDirectory };
}
function assertSnapshot(target: OwnerTarget, snapshot: RecordSnapshot): void {
	const current = readRecord(target);
	if (
		current.kind !== snapshot.kind ||
		current.file?.digest !== snapshot.file?.digest ||
		(current.file && snapshot.file && !sameStat(current.file.stat, snapshot.file.stat))
	)
		refuse("authority_changed");
}
function writeExclusive(file: string, bytes: Buffer): FileBytes {
	const fd = fs.openSync(
		file,
		fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0),
		0o600,
	);
	try {
		if (!native().applyOwnerOnlyFdSecurity(file, "file", fd).ok) refuse("unknown_ownership");
		let offset = 0;
		while (offset < bytes.length) {
			const count = fs.writeSync(fd, bytes, offset, bytes.length - offset);
			if (!count) throw new Error("owner_record_short_write");
			offset += count;
		}
		fs.fsyncSync(fd);
		if (!native().verifyOwnerOnlyFdSecurity(file, "file", fd).ok) refuse("unknown_ownership");
		const stat = fs.fstatSync(fd, { bigint: true });
		if (
			!stat.isFile() ||
			stat.nlink !== 1n ||
			stat.size !== BigInt(bytes.length) ||
			!sameStat(stat, fs.lstatSync(file, { bigint: true }))
		)
			refuse("authority_changed");
		return { bytes: Buffer.from(bytes), stat, digest: hash(bytes) };
	} finally {
		fs.closeSync(fd);
	}
}
function exactIdentity(file: FileBytes, parent: OwnerRoot): NativeExactFileIdentity {
	return {
		dev: file.stat.dev,
		ino: file.stat.ino,
		nlink: file.stat.nlink,
		parentDev: BigInt(parent.dev),
		parentIno: BigInt(parent.ino),
		size: file.stat.size,
		mtimeNs: file.stat.mtimeNs,
		sha256: file.digest,
	};
}
function exactRemove(target: OwnerTarget, snapshot: RecordSnapshot): void {
	if (!snapshot.file || !snapshot.ownerDirectory) return;
	assertSnapshot(target, snapshot);
	const result = native().exactUnlinkDirect(target.authorityKey, {
		...exactIdentity(snapshot.file, snapshot.ownerDirectory),
		quarantineName: `.owner-delete-${nonce()}`,
	});
	if (!result.ok) refuse("authority_changed");
	syncDirectory(path.dirname(target.authorityKey));
}
function replaceRecord(target: OwnerTarget, previous: RecordSnapshot, record: OwnerRecord): void {
	if (!validRecord(record)) refuse("authority_changed");
	const ownerDirectory = directory(target, true)!;
	if (!sameRoot(record.ownerDirectory, ownerDirectory)) refuse("authority_changed");
	assertSnapshot(target, previous);
	if (previous.kind === "corrupt") {
		// Durable, unique no-replace evidence survives every later failure and every replacement.
		const quarantine = `${target.authorityKey}.corrupt-${nonce()}`;
		writeExclusive(quarantine, previous.file!.bytes);
		syncDirectory(ownerDirectory.realpath);
		if (readExact(quarantine, MAX_RECORD_BYTES, true, true)?.digest !== previous.file!.digest)
			refuse("authority_changed");
		assertSnapshot(target, previous);
	}
	const staged = `${target.authorityKey}.${nonce()}.tmp`;
	const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
	if (bytes.length > MAX_RECORD_BYTES) refuse("unknown_ownership");
	writeExclusive(staged, bytes);
	// On uncertain publication retain the staged evidence; never unlink a possible successor by pathname.
	if (previous.file) {
		if (
			!storage.replaceExactSync(staged, target.authorityKey, {
				stat: statFromNode(previous.file.stat),
				sha256: previous.file.digest,
			})
		)
			refuse("authority_changed");
	} else {
		const published = native().renameNoReplacePath(staged, target.authorityKey);
		if (!published.ok) refuse("authority_changed");
	}
	syncDirectory(ownerDirectory.realpath);
	const installed = readRecord(target);
	if (installed.kind !== "record" || installed.file?.digest !== hash(bytes)) refuse("authority_changed");
}

let cachedHost: { pid: number; value?: string } | undefined;
let cachedOwn: { pid: number; reference: NativeProcess; incarnation: string; hostId: string } | undefined;
/** Machine-local, agentDir-independent identity. Raw OS IDs never leave this function or reach disk/logs. */
export function ownerHostIdSync(): string | undefined {
	if (cachedHost?.pid === process.pid) return cachedHost.value;
	let value: string | undefined;
	try {
		let raw: string | undefined;
		if (process.platform === "linux") {
			for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
				const bytes = readExact(file, 256, false, false);
				const candidate = bytes?.bytes.toString("utf8").trim().toLowerCase();
				if (candidate && /^[0-9a-f]{32}$/.test(candidate) && !/^0+$/.test(candidate)) {
					raw = candidate;
					break;
				}
			}
		} else if (process.platform === "darwin" || process.platform === "win32") {
			const command =
				process.platform === "darwin"
					? ["/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"]
					: ["reg", "query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"];
			const result = Bun.spawnSync(command, {
				stdout: "pipe",
				stderr: "ignore",
				windowsHide: true,
				timeout: 2000,
				maxBuffer: 64 * 1024,
			});
			if (result.exitCode === 0 && result.stdout.byteLength <= 64 * 1024)
				raw =
					process.platform === "darwin"
						? parseMacPlatformUuid(new TextDecoder().decode(result.stdout))
						: parseWindowsMachineGuid(new TextDecoder().decode(result.stdout));
		}
		if (raw) value = hash(`gajae-code:transcript-owner:os-host:v1\0${process.platform}\0${raw}`);
	} catch {
		/* Unavailable identity remains unknown; never substitute an installation/profile ID. */
	}
	cachedHost = { pid: process.pid, value };
	return value;
}
function ownProcess(): { reference: NativeProcess; incarnation: string; hostId: string } {
	if (cachedOwn?.pid === process.pid) return cachedOwn;
	const hostId = ownerHostIdSync();
	if (!hostId) refuse("unknown_ownership");
	try {
		const reference = nativeProcessBindings().Process.fromPid(process.pid);
		if (!reference || !isProcessIncarnation(reference.incarnation) || reference.status() !== "running")
			refuse("unknown_ownership");
		cachedOwn = { pid: process.pid, reference, incarnation: reference.incarnation, hostId };
		return cachedOwn;
	} catch {
		refuse("unknown_ownership");
	}
}
/** Retain the kernel reference across incarnation/status checks. Null alone is NOT proof of death. */
export function probeOwnerMemberSync(member: OwnerMember): OwnerLiveness {
	const local = ownerHostIdSync();
	if (!validMember(member) || !local || member.hostId !== local) return "unknown";
	try {
		const bindings = nativeProcessBindings();
		const reference = bindings.Process.fromPid(member.pid);
		if (reference && isProcessIncarnation(reference.incarnation)) {
			if (reference.incarnation !== member.processIncarnation) return "dead";
			if (reference.status() === "running") return "live";
		}
		const observation = bindings.Process.observe(member.pid);
		if (observation.status === "absent") return "dead";
		if (
			observation.status === "present" &&
			isProcessIncarnation(observation.incarnation) &&
			observation.incarnation !== member.processIncarnation
		)
			return "dead";
		return "unknown";
	} catch {
		return "unknown";
	}
}
function aggregate(members: readonly OwnerMember[]): OwnerLiveness {
	const results = members.map(probeOwnerMemberSync);
	return results.includes("unknown") ? "unknown" : results.includes("live") ? "live" : "dead";
}
function newMember(runtime: string, capabilities: readonly string[]): OwnerMember {
	const own = ownProcess();
	const member = Object.freeze({
		memberId: nonce(),
		runtime,
		capabilities: Object.freeze([...capabilities]),
		pid: process.pid,
		processIncarnation: own.incarnation,
		hostId: own.hostId,
	});
	if (!validMember(member)) refuse("unknown_ownership");
	return member;
}
interface AuthorityLock {
	target: OwnerTarget;
	root: OwnerRoot;
	lock: SessionStorageExclusiveLock;
}
function releaseLocks(locks: readonly AuthorityLock[], failures: unknown[]): void {
	for (const { target, root, lock } of locks.toReversed()) {
		try {
			lock.releaseSync();
		} catch (error) {
			failures.push(error);
		} finally {
			if (lockedDirectories.get(target.authorityKey) === root) lockedDirectories.delete(target.authorityKey);
		}
	}
}
function throwFailures(failures: readonly unknown[]): void {
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, "Owner authority operation and cleanup failed");
}
function acquireLocks(targets: readonly OwnerTarget[]): AuthorityLock[] {
	const hostId = ownProcess().hostId;
	const ordered = [...new Map(targets.map(target => [target.authorityKey, target])).values()].sort((a, b) =>
		a.authorityKey < b.authorityKey ? -1 : a.authorityKey > b.authorityKey ? 1 : 0,
	);
	const locks: AuthorityLock[] = [];
	if (ordered.some(target => lockedDirectories.has(target.authorityKey))) refuse("authority_busy");
	try {
		for (const target of ordered) {
			const root = directory(target, true)!;
			const lock = storage.acquireExclusiveLockSync(`${target.authorityKey}.lock`, { ownerHostId: hostId });
			if (!lock) refuse("authority_busy");
			locks.push({ target, root, lock });
			const installedRoot = directory(target, false);
			if (!installedRoot || !sameRoot(installedRoot, root)) refuse("authority_changed");
			lockedDirectories.set(target.authorityKey, root);
		}
		return locks;
	} catch (error) {
		const failures = [error];
		releaseLocks(locks, failures);
		throwFailures(failures);
		throw error;
	}
}
function withLocks<T>(targets: readonly OwnerTarget[], body: () => T): T {
	const locks = acquireLocks(targets);
	const failures: unknown[] = [];
	try {
		return body();
	} catch (error) {
		failures.push(error);
		throw error;
	} finally {
		releaseLocks(locks, failures);
		throwFailures(failures);
	}
}
async function acquireLocksBounded(targets: readonly OwnerTarget[], timeoutMs = 1000): Promise<AuthorityLock[]> {
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000)
		throw new RangeError("Invalid owner lock timeout");
	const end = performance.now() + timeoutMs;
	for (;;) {
		try {
			return acquireLocks(targets);
		} catch (error) {
			if (!(error instanceof OwnerAuthorityError) || error.code !== "authority_busy" || performance.now() >= end)
				throw error;
			await Bun.sleep(Math.min(10, Math.max(0, end - performance.now())));
		}
	}
}
async function withLocksAsync<T>(
	targets: readonly OwnerTarget[],
	body: () => Promise<T>,
	timeoutMs = 1000,
): Promise<T> {
	const locks = await acquireLocksBounded(targets, timeoutMs);
	const failures: unknown[] = [];
	try {
		return await body();
	} catch (error) {
		failures.push(error);
		throw error;
	} finally {
		releaseLocks(locks, failures);
		throwFailures(failures);
	}
}
interface AdmissionObservation {
	veto: OwnerVetoEvidence;
	marker: OwnerMarkerEvidence;
	record: RecordSnapshot;
}
function evidenceStamp(observation: AdmissionObservation): string {
	return hash(JSON.stringify({ veto: observation.veto, marker: observation.marker }));
}
function detachEvidence<T>(value: T): T {
	const encoded = JSON.stringify(value);
	if (Buffer.byteLength(encoded) > MAX_RECORD_BYTES) refuse("unknown_ownership");
	return JSON.parse(encoded) as T;
}
function observe(target: OwnerTarget, inspectors: OwnerInspectors, exclusive: boolean): AdmissionObservation {
	try {
		return observeExact(target, inspectors, exclusive);
	} catch (error) {
		if (error instanceof OwnerAuthorityError) throw error;
		refuse("unknown_ownership");
	}
}
function observeExact(target: OwnerTarget, inspectors: OwnerInspectors, exclusive: boolean): AdmissionObservation {
	validateTarget(target);
	let veto: OwnerVetoEvidence;
	try {
		veto = detachEvidence(inspectors.inspectVetoes(target));
	} catch {
		refuse("unknown_ownership");
	}
	if (
		!veto ||
		![
			"clear",
			"legacy_lifecycle_ambiguous",
			"authority_roots_unresolved",
			"owned_by_other",
			"unknown_ownership",
		].includes(veto.kind) ||
		!HEX.test(veto.digest) ||
		!Array.isArray(veto.evidence)
	)
		refuse("unknown_ownership");
	if (veto.kind !== "clear") refuse(veto.kind);
	const snapshot = transcriptSnapshot(target, exclusive);
	if ((snapshot !== undefined) !== target.transcriptExists || (snapshot?.digest ?? hash("")) !== target.snapshotDigest)
		refuse("stale_snapshot");
	let marker: OwnerMarkerEvidence;
	try {
		marker = detachEvidence(inspectors.readMarkers(target));
	} catch {
		refuse("unknown_ownership");
	}
	if (
		!marker ||
		!["absent", "present", "unknown"].includes(marker.kind) ||
		!HEX.test(marker.digest) ||
		marker.snapshotDigest !== target.snapshotDigest ||
		!Array.isArray(marker.members) ||
		marker.members.length > MAX_MEMBERS ||
		!marker.members.every(validMember) ||
		(marker.kind === "absent" && marker.members.length > 0)
	)
		refuse("unknown_ownership");
	if (marker.kind === "unknown") refuse("unknown_ownership");
	const record = readRecord(target);
	return { veto, marker, record };
}
async function observeAsync(
	target: OwnerTarget,
	inspectors: OwnerAsyncInspectors,
	exclusive: boolean,
): Promise<AdmissionObservation> {
	try {
		validateTarget(target);
		const veto = detachEvidence(await inspectors.inspectVetoes(target));
		if (veto.kind !== "clear") {
			if (
				[
					"legacy_lifecycle_ambiguous",
					"authority_roots_unresolved",
					"owned_by_other",
					"unknown_ownership",
				].includes(veto.kind)
			)
				refuse(veto.kind);
			refuse("unknown_ownership");
		}
		const marker = detachEvidence(await inspectors.readMarkers(target));
		// Recheck exact transcript/root bytes after the awaited independent scans.
		return observe(target, { inspectVetoes: () => veto, readMarkers: () => marker }, exclusive);
	} catch (error) {
		if (error instanceof OwnerAuthorityError) throw error;
		refuse("unknown_ownership");
	}
}
export interface OwnerProbe {
	readonly kind: "available" | "cooperative_group" | "refused";
	readonly advisory: true;
	readonly reason?: OwnerRefusal;
	readonly authorityKey: string;
	readonly snapshotDigest: string;
	readonly recordState?: OwnerState;
	readonly epoch?: string;
	readonly rev?: number;
	readonly vetoDigest?: string;
	readonly markerDigest?: string;
}
function decision(
	observation: AdmissionObservation,
	mode: OwnerMode,
	policy?: SessionOwnerPolicy,
	target?: OwnerTarget,
): "fresh" | "join" {
	const record = observation.record.record;
	if (record?.state === "moved") refuse("session_moved");
	if (record && ["transfer_reserved", "incoming", "settled"].includes(record.state)) refuse("transfer_in_progress");
	if (record?.state === "live") {
		const state = aggregate(record.members);
		if (state === "unknown") refuse("unknown_ownership");
		if (state === "live") {
			if (mode !== "cooperative" || record.mode !== "cooperative") refuse("owned_by_other");
			if (record.members.length >= MAX_MEMBERS) refuse("owned_by_other");
			return "join";
		}
		return "fresh";
	}
	if (record?.state === "retired") return "fresh";
	if (observation.marker.kind === "present") {
		if (!observation.marker.members.length || aggregate(observation.marker.members) !== "dead")
			refuse("authority_lost_unresolved");
		return "fresh";
	}
	if (mode === "exclusive_native") {
		const attestation = policy?.kind === "exclusive_native" ? policy.legacyAttestation : undefined;
		if (
			!attestation ||
			attestation.kind !== "legacy_takeover" ||
			attestation.authorityKey !== target?.authorityKey ||
			attestation.snapshotDigest !== target?.snapshotDigest ||
			attestation.vetoDigest !== observation.veto.digest ||
			attestation.markerDigest !== observation.marker.digest ||
			!issuedAttestations.has(attestation) ||
			consumedAttestations.has(attestation)
		)
			refuse("legacy_attestation_required");
	}
	return "fresh";
}
export function probeSessionOwnershipSync(
	target: OwnerTarget,
	inspectors: OwnerInspectors,
	mode: OwnerMode = "exclusive_native",
): OwnerProbe {
	try {
		const observation = observe(target, inspectors, mode === "exclusive_native");
		let result: "fresh" | "join";
		try {
			result = decision(observation, mode);
		} catch (error) {
			if (!(error instanceof OwnerAuthorityError) || error.code !== "legacy_attestation_required") throw error;
			return {
				kind: "refused",
				advisory: true,
				reason: error.code,
				authorityKey: target.authorityKey,
				snapshotDigest: target.snapshotDigest,
				vetoDigest: observation.veto.digest,
				markerDigest: observation.marker.digest,
			};
		}
		return {
			kind: result === "join" ? "cooperative_group" : "available",
			advisory: true,
			authorityKey: target.authorityKey,
			snapshotDigest: target.snapshotDigest,
			recordState: observation.record.record?.state,
			epoch: observation.record.record?.epoch,
			rev: observation.record.record?.rev,
			vetoDigest: observation.veto.digest,
			markerDigest: observation.marker.digest,
		};
	} catch (error) {
		return {
			kind: "refused",
			advisory: true,
			reason: error instanceof OwnerAuthorityError ? error.code : "unknown_ownership",
			authorityKey: target.authorityKey,
			snapshotDigest: target.snapshotDigest,
		};
	}
}
/** Mint only after the internal read-only inspectors authorized this exact legacy snapshot. */
export function captureLegacyTakeoverAttestationSync(
	target: OwnerTarget,
	inspectors: OwnerInspectors,
): LegacyTakeoverAttestation {
	const observed = observe(target, inspectors, true);
	if (observed.record.record || observed.marker.kind !== "absent") refuse("authority_lost_unresolved");
	const attestation: LegacyTakeoverAttestation = Object.freeze({
		kind: "legacy_takeover",
		authorityKey: target.authorityKey,
		snapshotDigest: target.snapshotDigest,
		vetoDigest: observed.veto.digest,
		markerDigest: observed.marker.digest,
	});
	issuedAttestations.add(attestation);
	return attestation;
}
/** Caller must obtain explicit legacy acknowledgement before exposing this proof. */
export async function captureLegacyTakeoverAttestationWithAsyncEvidence(
	target: OwnerTarget,
	inspectors: OwnerAsyncInspectors,
): Promise<LegacyTakeoverAttestation> {
	target = copyTarget(target);
	const observed = await observeAsync(target, inspectors, true);
	if (observed.record.record || observed.marker.kind !== "absent") refuse("authority_lost_unresolved");
	const attestation: LegacyTakeoverAttestation = Object.freeze({
		kind: "legacy_takeover",
		authorityKey: target.authorityKey,
		snapshotDigest: target.snapshotDigest,
		vetoDigest: observed.veto.digest,
		markerDigest: observed.marker.digest,
	});
	issuedAttestations.add(attestation);
	return attestation;
}
function copyPolicy(policy: SessionOwnerPolicy): SessionOwnerPolicy {
	if (policy.kind === "cooperative") return Object.freeze({ kind: "cooperative" });
	const resolved = { ...policy.expected.resolved };
	if (resolved.candidates) resolved.candidates = [...resolved.candidates];
	if (resolved.candidates) Object.freeze(resolved.candidates);
	return Object.freeze({
		kind: "exclusive_native",
		expected: Object.freeze({ snapshotDigest: policy.expected.snapshotDigest, resolved: Object.freeze(resolved) }),
		legacyAttestation: policy.legacyAttestation,
	});
}
export function admitOwnerMembershipSync(
	target: OwnerTarget,
	policy: SessionOwnerPolicy,
	options: OwnerAdmissionOptions,
): OwnerMembership {
	target = copyTarget(target);
	if (policy.kind !== "cooperative" && policy.kind !== "exclusive_native") refuse("policy_mismatch");
	if (
		policy.kind === "exclusive_native" &&
		(policy.expected.snapshotDigest !== target.snapshotDigest ||
			!object(policy.expected.resolved) ||
			policy.expected.resolved.headerId !== target.headerId ||
			policy.expected.resolved.snapshotDigest !== policy.expected.snapshotDigest)
	)
		refuse("stale_snapshot");
	policy = copyPolicy(policy);
	// ALL independent vetoes precede lock acquisition and namespace creation.
	const before = observe(target, options, policy.kind === "exclusive_native");
	decision(before, policy.kind, policy, target);
	const member = newMember(options.runtime, options.capabilities);
	return withLocks([target], () => {
		const current = observe(target, options, policy.kind === "exclusive_native");
		return installAdmission(target, policy, options, member, before, current);
	});
}
/** Cooperative admission may wait for an active writer, then enroll against its fresh locked snapshot. */
export async function admitOwnerMembership(
	target: OwnerTarget,
	policy: SessionOwnerPolicy,
	options: OwnerAdmissionOptions,
	timeoutMs = 1000,
): Promise<OwnerMembership> {
	target = copyTarget(target);
	if (policy.kind !== "cooperative" && policy.kind !== "exclusive_native") refuse("policy_mismatch");
	if (
		policy.kind === "exclusive_native" &&
		(policy.expected.snapshotDigest !== target.snapshotDigest ||
			!object(policy.expected.resolved) ||
			policy.expected.resolved.headerId !== target.headerId ||
			policy.expected.resolved.snapshotDigest !== policy.expected.snapshotDigest)
	)
		refuse("stale_snapshot");
	policy = copyPolicy(policy);
	// Independent vetoes still precede namespace creation; none are cached across the wait.
	const before = observe(target, options, policy.kind === "exclusive_native");
	decision(before, policy.kind, policy, target);
	const member = newMember(options.runtime, options.capabilities);
	return withLocksAsync(
		[target],
		async () => {
			if (policy.kind === "cooperative") {
				const currentTarget = captureOwnerTargetSync({
					transcriptPath: target.transcriptPath,
					headerId: target.headerId,
				});
				if (
					!sameRoot(currentTarget.authorityRoot, target.authorityRoot) ||
					currentTarget.authorityKey !== target.authorityKey
				)
					refuse("authority_changed");
				const current = observe(currentTarget, options, false);
				return installAdmission(currentTarget, policy, options, member, current, current);
			}
			const current = observe(target, options, true);
			return installAdmission(target, policy, options, member, before, current);
		},
		timeoutMs,
	);
}
function installAdmission(
	target: OwnerTarget,
	policy: SessionOwnerPolicy,
	options: OwnerAdmissionOptions,
	member: OwnerMember,
	before: AdmissionObservation,
	current: AdmissionObservation,
	asyncInspectors?: OwnerAsyncInspectors,
): OwnerMembership {
	// Creating our own empty private directory is allowed, but evidence changes are not.
	const beforeStamp = hash(
		JSON.stringify({
			veto: before.veto,
			marker: before.marker,
			kind: before.record.kind,
			bytes: before.record.file?.digest,
		}),
	);
	const currentStamp = hash(
		JSON.stringify({
			veto: current.veto,
			marker: current.marker,
			kind: current.record.kind,
			bytes: current.record.file?.digest,
		}),
	);
	if (
		beforeStamp !== currentStamp ||
		(before.record.file && (!current.record.file || !sameStat(before.record.file.stat, current.record.file.stat))) ||
		(before.record.ownerDirectory &&
			(!current.record.ownerDirectory || !sameRoot(before.record.ownerDirectory, current.record.ownerDirectory)))
	)
		refuse("authority_changed");
	const action = decision(current, policy.kind, policy, target);
	const old = current.record.record;
	const record: OwnerRecord = {
		v: 1,
		rev: (old?.rev ?? 0) + 1,
		state: "live",
		headerId: target.headerId,
		authorityRoot: target.authorityRoot,
		ownerDirectory: directory(target, false)!,
		epoch: action === "join" ? old!.epoch : nonce(),
		mode: policy.kind,
		members:
			action === "join"
				? [...old!.members.filter(existing => probeOwnerMemberSync(existing) !== "dead"), member]
				: [member],
	};
	if (action === "fresh" && old?.state === "live") {
		// Preserve the explicit dead-epoch retirement transition before replacing it.
		replaceRecord(target, current.record, { ...old, rev: old.rev + 1, state: "retired", members: [] });
		const retired = readRecord(target);
		replaceRecord(target, retired, { ...record, rev: old.rev + 2 });
	} else replaceRecord(target, current.record, record);
	const installed = readRecord(target).record!;
	if (policy.kind === "exclusive_native" && policy.legacyAttestation)
		consumedAttestations.add(policy.legacyAttestation);
	const token = Object.freeze({}) as OwnerMembership;
	memberships.set(token, {
		target,
		policy: copyPolicy(policy),
		member,
		epoch: installed.epoch,
		rev: installed.rev,
		snapshotDigest: target.snapshotDigest,
		markerRequired: true,
		retired: false,
		inspectors: Object.freeze({ inspectVetoes: options.inspectVetoes, readMarkers: options.readMarkers }),
		asyncInspectors,
		publishing: false,
		admissionStamp: evidenceStamp(current),
		directoryPublicationEligible:
			policy.kind === "cooperative" &&
			!target.transcriptExists &&
			current.record.kind === "absent" &&
			old === undefined,
	});
	return token;
}
/** Native admission with fresh independent asynchronous evidence under the authority lock. */
export async function admitOwnerMembershipWithAsyncEvidence(
	target: OwnerTarget,
	policy: SessionOwnerPolicy,
	options: OwnerAsyncAdmissionOptions,
	timeoutMs = 1000,
): Promise<OwnerMembership> {
	target = copyTarget(target);
	if (policy.kind !== "exclusive_native") refuse("policy_mismatch");
	if (
		policy.expected.snapshotDigest !== target.snapshotDigest ||
		!object(policy.expected.resolved) ||
		policy.expected.resolved.headerId !== target.headerId ||
		policy.expected.resolved.snapshotDigest !== policy.expected.snapshotDigest
	)
		refuse("stale_snapshot");
	policy = copyPolicy(policy);
	const inspectors = Object.freeze({ inspectVetoes: options.inspectVetoes, readMarkers: options.readMarkers });
	const before = await observeAsync(target, inspectors, true);
	decision(before, policy.kind, policy, target);
	const member = newMember(options.runtime, options.capabilities);
	// Sync evidence consumers must fail closed, never reuse a stale async scan.
	const syncOptions: OwnerAdmissionOptions = {
		runtime: options.runtime,
		capabilities: options.capabilities,
		inspectVetoes: () => refuse("unknown_ownership"),
		readMarkers: () => refuse("unknown_ownership"),
	};
	return withLocksAsync(
		[target],
		async () => {
			const current = await observeAsync(target, inspectors, true);
			return installAdmission(target, policy, syncOptions, member, before, current, inspectors);
		},
		timeoutMs,
	);
}
export async function probeSessionOwnershipWithAsyncEvidence(
	target: OwnerTarget,
	inspectors: OwnerAsyncInspectors,
	mode: OwnerMode = "exclusive_native",
): Promise<OwnerProbe> {
	try {
		const observation = await observeAsync(target, inspectors, mode === "exclusive_native");
		try {
			const action = decision(observation, mode);
			return {
				kind: action === "join" ? "cooperative_group" : "available",
				advisory: true,
				authorityKey: target.authorityKey,
				snapshotDigest: target.snapshotDigest,
				recordState: observation.record.record?.state,
				epoch: observation.record.record?.epoch,
				rev: observation.record.record?.rev,
				vetoDigest: observation.veto.digest,
				markerDigest: observation.marker.digest,
			};
		} catch (error) {
			if (!(error instanceof OwnerAuthorityError)) throw error;
			return {
				kind: "refused",
				advisory: true,
				reason: error.code,
				authorityKey: target.authorityKey,
				snapshotDigest: target.snapshotDigest,
				vetoDigest: observation.veto.digest,
				markerDigest: observation.marker.digest,
			};
		}
	} catch (error) {
		return {
			kind: "refused",
			advisory: true,
			reason: error instanceof OwnerAuthorityError ? error.code : "unknown_ownership",
			authorityKey: target.authorityKey,
			snapshotDigest: target.snapshotDigest,
		};
	}
}
export async function recheckOwnerAdmissionWithAsyncEvidence(token: OwnerMembership): Promise<OwnerMembershipEvidence> {
	const data = membership(token);
	const inspectors = data.asyncInspectors;
	if (!inspectors || data.policy.kind !== "exclusive_native") refuse("policy_mismatch");
	const target = data.target;
	const before = await observeAsync(target, inspectors, true);
	if (evidenceStamp(before) !== data.admissionStamp) refuse("authority_changed");
	return withLocksAsync([target], async () => {
		if (data.target !== target) refuse("participation_lost");
		const current = await observeAsync(target, inspectors, true);
		if (data.target !== target || evidenceStamp(current) !== data.admissionStamp) refuse("authority_changed");
		currentMember(data, true);
		return getOwnerMembershipEvidence(token);
	});
}
function membership(token: OwnerMembership): MembershipData {
	const data = memberships.get(token);
	if (!data) refuse("invalid_membership");
	if (data.retired || data.directoryPublicationUnresolved) refuse("participation_lost");
	return data;
}
export function getOwnerMembershipEvidence(token: OwnerMembership): OwnerMembershipEvidence {
	const data = membership(token);
	return Object.freeze({
		policy: data.policy,
		memberKind: data.policy.kind,
		authorityKey: data.target.authorityKey,
		memberId: data.member.memberId,
		epoch: data.epoch,
		rev: data.rev,
		snapshotDigest: data.snapshotDigest,
	});
}
function exactMember(a: OwnerMember, b: OwnerMember): boolean {
	return (
		a.memberId === b.memberId &&
		a.runtime === b.runtime &&
		a.pid === b.pid &&
		a.processIncarnation === b.processIncarnation &&
		a.hostId === b.hostId &&
		a.capabilities.length === b.capabilities.length &&
		a.capabilities.every((capability, index) => capability === b.capabilities[index])
	);
}
/** Recheck after read-only hydration, before any publication/factory effects. */
export function recheckOwnerAdmissionSync(token: OwnerMembership): OwnerMembershipEvidence {
	const data = membership(token);
	const before = observe(data.target, data.inspectors, data.policy.kind === "exclusive_native");
	if (evidenceStamp(before) !== data.admissionStamp) refuse("authority_changed");
	return withLocks([data.target], () => {
		const current = observe(data.target, data.inspectors, data.policy.kind === "exclusive_native");
		if (evidenceStamp(current) !== data.admissionStamp) refuse("authority_changed");
		currentMember(data, true);
		return getOwnerMembershipEvidence(token);
	});
}
function currentMember(
	data: MembershipData,
	exactRev: boolean,
	transcript: "required" | "optional" | "unchecked" = "required",
): RecordSnapshot {
	if (data.retired || data.directoryPublicationUnresolved) refuse("participation_lost");
	validateTarget(data.target);
	const observed = readRecord(data.target);
	const record = observed.record;
	if (
		!record ||
		record.state !== "live" ||
		record.epoch !== data.epoch ||
		record.mode !== data.policy.kind ||
		(exactRev && record.rev !== data.rev) ||
		!record.members.some(member => exactMember(member, data.member))
	)
		refuse("participation_lost");
	if (probeOwnerMemberSync(data.member) !== "live") refuse("participation_lost");
	if (
		transcript === "required" &&
		!transcriptSnapshot(data.target, data.policy.kind === "exclusive_native") &&
		data.target.transcriptExists
	)
		refuse("participation_lost");
	return observed;
}
/** All processes must be exact live local members of ONE validated adjacent cooperative record. */
export function captureLiveCooperativeOwnerProcessesSync(
	target: OwnerTarget,
	processes: readonly Pick<OwnerMember, "pid" | "processIncarnation">[],
): { readonly authorityKey: string; readonly epoch: string; readonly hostId: string } | undefined {
	validateTarget(target);
	const record = readRecord(target).record;
	const hostId = ownerHostIdSync();
	if (record?.state !== "live" || record.mode !== "cooperative" || !hostId || !processes.length) return undefined;
	for (const process of processes) {
		if (
			!record.members.some(
				member =>
					member.pid === process.pid &&
					member.processIncarnation === process.processIncarnation &&
					member.hostId === hostId &&
					probeOwnerMemberSync(member) === "live",
			)
		)
			return undefined;
	}
	return Object.freeze({ authorityKey: target.authorityKey, epoch: record.epoch, hostId });
}
/** A direct CLI registration is cooperative only when adjacent authority proves its exact live member. */
export function isLiveCooperativeOwnerProcessSync(
	target: OwnerTarget,
	pid: number,
	processIncarnation: string,
): boolean {
	return captureLiveCooperativeOwnerProcessesSync(target, [{ pid, processIncarnation }]) !== undefined;
}
/** Explicit cooperative revision refresh; never changes epoch/member/mode or promotes policy. */
export function revalidateOwnerMembershipSync(token: OwnerMembership): OwnerMembershipEvidence {
	const data = membership(token);
	return withLocks([data.target], () => {
		data.rev = currentMember(data, false).record!.rev;
		return getOwnerMembershipEvidence(token);
	});
}
/** Await authority contention before acquiring any managed transaction or transcript lease. */
export async function revalidateOwnerMembership(
	token: OwnerMembership,
	timeoutMs = 1000,
): Promise<OwnerMembershipEvidence> {
	const data = membership(token);
	const target = data.target;
	return withLocksAsync(
		[target],
		async () => {
			if (data.target !== target) refuse("participation_lost");
			data.rev = currentMember(data, false).record!.rev;
			return getOwnerMembershipEvidence(token);
		},
		timeoutMs,
	);
}
/** Caller holds its ownership transaction and transcript lease INSIDE this non-yielding callback. */
export function withOwnerPublicationSync<T>(token: OwnerMembership, body: () => T): T {
	const data = membership(token);
	if (data.publishing || Object.prototype.toString.call(body) === "[object AsyncFunction]")
		refuse("participation_lost");
	return withLocks([data.target], () => {
		currentMember(data, true, "unchecked");
		data.publishing = true;
		const failures: unknown[] = [];
		let result!: T;
		try {
			try {
				result = body();
				if (
					result !== null &&
					(typeof result === "object" || typeof result === "function") &&
					typeof (result as { then?: unknown }).then === "function"
				)
					refuse("participation_lost");
			} catch (error) {
				failures.push(error);
			}
			try {
				currentMember(data, true, "unchecked");
			} catch (error) {
				failures.push(error);
			}
			throwFailures(failures);
			return result;
		} finally {
			data.publishing = false;
		}
	});
}
/**
 * Hold authority across awaited managed transaction acquisition, body and release.
 * The body must acquire in order: authority (held here), ownership transaction,
 * transcript lease. It must not include provider, tool or user-input waits.
 */
export async function withOwnerPublication<T>(token: OwnerMembership, body: () => Promise<T>): Promise<T> {
	return withOwnerPublicationMode(token, body, false);
}
/** Cooperative refresh and publication are one authority transaction, never an unlocked revision refresh. */
export async function withCooperativeOwnerPublication<T>(token: OwnerMembership, body: () => Promise<T>): Promise<T> {
	if (membership(token).policy.kind !== "cooperative") refuse("policy_mismatch");
	return withOwnerPublicationMode(token, body, true);
}
async function withOwnerPublicationMode<T>(
	token: OwnerMembership,
	body: () => Promise<T>,
	cooperativeRefresh: boolean,
): Promise<T> {
	const data = membership(token);
	if (data.publishing) refuse("participation_lost");
	const target = data.target;
	return withLocksAsync([target], async () => {
		if (data.target !== target) refuse("participation_lost");
		if (cooperativeRefresh) {
			currentMember(data, false);
			const currentTarget = captureOwnerTargetSync({
				transcriptPath: target.transcriptPath,
				headerId: target.headerId,
			});
			if (
				!sameRoot(currentTarget.authorityRoot, target.authorityRoot) ||
				currentTarget.authorityKey !== target.authorityKey
			)
				refuse("authority_changed");
			observe(currentTarget, data.inspectors, false);
			data.rev = currentMember(data, false).record!.rev;
		} else currentMember(data, true, "unchecked");
		data.publishing = true;
		const failures: unknown[] = [];
		let result!: T;
		try {
			try {
				result = await body();
			} catch (error) {
				failures.push(error);
			}
			try {
				if (data.target !== target) refuse("participation_lost");
				currentMember(data, true, cooperativeRefresh ? "required" : "unchecked");
			} catch (error) {
				failures.push(error);
			}
			throwFailures(failures);
			return result;
		} finally {
			data.publishing = false;
		}
	});
}
/**
 * Publish one freshly admitted private fork directory, not an arbitrary owner-root move.
 * The callback performs the checked no-replace rename and namespace sync. Once dispatched,
 * any uncertainty retains the lock and v1 record evidence; there is no pathname fallback.
 */
export async function publishOwnerDirectory(
	token: OwnerMembership,
	finalTranscriptPath: string,
	publish: () => Promise<OwnerDirectoryPublicationReceipt>,
): Promise<OwnerMembershipEvidence> {
	const data = membership(token);
	if (
		data.publishing ||
		data.pendingTransfer ||
		data.policy.kind !== "cooperative" ||
		!data.directoryPublicationEligible ||
		data.markerRequired
	)
		refuse("participation_lost");
	const source = data.target;
	const sourceRoot = source.authorityRoot;
	const finalDirectory = path.dirname(finalTranscriptPath);
	const parentPath = path.dirname(sourceRoot.realpath);
	if (
		!path.isAbsolute(finalTranscriptPath) ||
		path.resolve(finalTranscriptPath) !== finalTranscriptPath ||
		path.basename(finalTranscriptPath) !== path.basename(source.transcriptPath) ||
		path.dirname(finalDirectory) !== parentPath ||
		finalDirectory === sourceRoot.realpath
	)
		refuse("invalid_owner_target");
	const parent = rootAt(parentPath);
	const assertCanonicalRoot = (root: OwnerRoot): void => {
		try {
			if (fs.realpathSync.native(root.realpath) !== root.realpath) refuse("authority_changed");
			assertRoot(root);
		} catch (error) {
			if (error instanceof OwnerAuthorityError) throw error;
			refuse("authority_changed");
		}
	};
	const assertAbsent = (name: string): void => {
		try {
			fs.lstatSync(name);
		} catch (error) {
			if (missing(error)) return;
			throw error;
		}
		refuse("destination_authority_conflict");
	};
	assertCanonicalRoot(parent);
	assertCanonicalRoot(sourceRoot);
	assertAbsent(finalDirectory);
	// Refresh bytes, never the admitted member/epoch/policy. Independent vetoes still apply.
	observe(
		captureOwnerTargetSync({ transcriptPath: source.transcriptPath, headerId: source.headerId }),
		data.inspectors,
		false,
	);
	const locks = await acquireLocksBounded([source]);
	const failures: unknown[] = [];
	const descriptors: number[] = [];
	let dispatched = false;
	let released = false;
	try {
		if (data.target !== source || data.publishing || data.directoryPublicationUnresolved)
			refuse("participation_lost");
		assertCanonicalRoot(parent);
		assertCanonicalRoot(sourceRoot);
		assertAbsent(finalDirectory);
		const observed = currentMember(data, true);
		const record = observed.record!;
		if (
			!observed.file ||
			!observed.ownerDirectory ||
			record.members.length !== 1 ||
			!exactMember(record.members[0], data.member) ||
			record.transfer
		)
			refuse("participation_lost");
		observe(
			captureOwnerTargetSync({ transcriptPath: source.transcriptPath, headerId: source.headerId }),
			data.inspectors,
			false,
		);
		const transcript = transcriptSnapshot(source, true);
		if (!transcript) refuse("participation_lost");
		const ownerDirectory = observed.ownerDirectory;
		const finalRoot = Object.freeze({ ...sourceRoot, realpath: finalDirectory });
		const finalOwnerDirectory = Object.freeze({
			...ownerDirectory,
			realpath: path.join(finalDirectory, ".gjc-owners"),
		});
		const destination = copyTarget({
			...source,
			transcriptPath: finalTranscriptPath,
			authorityRoot: finalRoot,
			authorityKey: path.join(finalOwnerDirectory.realpath, path.basename(source.authorityKey)),
			snapshotDigest: transcript.digest,
			transcriptExists: true,
		});
		if (lockedDirectories.has(destination.authorityKey)) refuse("authority_busy");
		const retained = [parent, sourceRoot, ownerDirectory].map(root => {
			assertCanonicalRoot(root);
			const fd = fs.openSync(root.realpath, FLAGS | (fs.constants.O_DIRECTORY ?? 0));
			descriptors.push(fd);
			const stat = fs.fstatSync(fd, { bigint: true });
			if (!stat.isDirectory() || stat.dev.toString() !== root.dev || stat.ino.toString() !== root.ino)
				refuse("authority_changed");
			return { fd, root };
		});
		const checkRetained = (): void => {
			for (const { fd, root } of retained) {
				const stat = fs.fstatSync(fd, { bigint: true });
				if (!stat.isDirectory() || stat.dev.toString() !== root.dev || stat.ino.toString() !== root.ino)
					refuse("authority_changed");
			}
			assertCanonicalRoot(parent);
		};
		const assertFile = (name: string, expected: FileBytes): FileBytes => {
			const actual = readExact(name, MAX_TRANSCRIPT_BYTES, true, true, expected.bytes.length);
			if (!actual || !sameStat(actual.stat, expected.stat) || actual.digest !== expected.digest)
				refuse("authority_changed");
			return actual;
		};
		const lockPath = `${source.authorityKey}.lock`;
		const lock = readExact(lockPath, MAX_RECORD_BYTES, true, true);
		const acquired = locks[0].lock.acquiredFile;
		if (!lock || !acquired) refuse("authority_changed");
		const lockIdentity = exactIdentity(lock, ownerDirectory);
		const expectedLock = acquired.identity;
		if (
			lockIdentity.dev !== expectedLock.dev ||
			lockIdentity.ino !== expectedLock.ino ||
			lockIdentity.nlink !== expectedLock.nlink ||
			lockIdentity.parentDev !== expectedLock.parentDev ||
			lockIdentity.parentIno !== expectedLock.parentIno ||
			lockIdentity.size !== expectedLock.size ||
			lockIdentity.mtimeNs !== expectedLock.mtimeNs ||
			lockIdentity.sha256 !== expectedLock.sha256
		)
			refuse("authority_changed");
		let lockOwner: unknown;
		try {
			lockOwner = JSON.parse(lock.bytes.toString("utf8"));
		} catch {
			refuse("authority_changed");
		}
		if (
			!object(lockOwner) ||
			lockOwner.token !== acquired.generation ||
			lockOwner.pid !== data.member.pid ||
			lockOwner.incarnation !== data.member.processIncarnation ||
			lockOwner.hostId !== data.member.hostId
		)
			refuse("authority_changed");
		const suffix = nonce();
		const stagedName = `${path.basename(source.authorityKey)}.${suffix}.tmp`;
		const evidenceName = `${path.basename(source.authorityKey)}.directory-publication-old-root-${suffix}`;
		const rebound: OwnerRecord = {
			...record,
			rev: record.rev + 1,
			authorityRoot: finalRoot,
			ownerDirectory: finalOwnerDirectory,
		};
		if (!validRecord(rebound)) refuse("authority_changed");
		const bytes = Buffer.from(`${JSON.stringify(rebound)}\n`);
		if (bytes.length > MAX_RECORD_BYTES) refuse("unknown_ownership");
		const staged = writeExclusive(path.join(ownerDirectory.realpath, stagedName), bytes);
		// Existing v1 record bytes are retained as evidence, never adopted as authority.
		const evidence = writeExclusive(path.join(ownerDirectory.realpath, evidenceName), observed.file.bytes);
		for (const { fd } of retained) fs.fsyncSync(fd);
		checkRetained();
		assertCanonicalRoot(sourceRoot);
		assertCanonicalRoot(ownerDirectory);
		assertAbsent(finalDirectory);
		assertSnapshot(source, observed);
		assertFile(lockPath, lock);
		assertFile(source.transcriptPath, transcript);
		data.publishing = true;
		data.directoryPublicationUnresolved = true;
		data.directoryPublicationEligible = false;
		lockedDirectories.set(destination.authorityKey, finalOwnerDirectory);
		dispatched = true;
		const receipt = await publish();
		const assertMoved = (): void => {
			checkRetained();
			assertCanonicalRoot(finalRoot);
			assertCanonicalRoot(finalOwnerDirectory);
			assertAbsent(sourceRoot.realpath);
			assertFile(destination.transcriptPath, transcript);
			assertFile(`${destination.authorityKey}.lock`, lock);
		};
		assertMoved();
		if (
			!receipt ||
			receipt.kind !== "checked_directory_rename" ||
			receipt.sourceDirectory !== sourceRoot.realpath ||
			receipt.destinationDirectory !== finalDirectory ||
			receipt.namespaceSynced !== true
		)
			refuse("authority_changed");
		assertFile(destination.authorityKey, observed.file);
		const movedStaged = path.join(finalOwnerDirectory.realpath, stagedName);
		const movedEvidence = path.join(finalOwnerDirectory.realpath, evidenceName);
		assertFile(movedStaged, staged);
		assertFile(movedEvidence, evidence);
		// Both exact identities come from before dispatch, not equal hashes or fresh adoption.
		const replaced = native().exactReplacePath(
			movedStaged,
			destination.authorityKey,
			exactIdentity(staged, finalOwnerDirectory),
			exactIdentity(observed.file, finalOwnerDirectory),
		);
		if (!replaced.ok) refuse("authority_changed");
		for (const { fd } of retained) fs.fsyncSync(fd);
		assertMoved();
		const installed = readRecord(destination);
		if (
			!installed.file ||
			!installed.record ||
			installed.file.stat.dev !== staged.stat.dev ||
			installed.file.stat.ino !== staged.stat.ino ||
			installed.file.stat.nlink !== 1n ||
			installed.file.stat.size !== staged.stat.size ||
			installed.file.stat.mtimeNs !== staged.stat.mtimeNs ||
			installed.file.digest !== staged.digest ||
			installed.record.rev !== rebound.rev
		)
			refuse("authority_changed");
		// Keep the old-root v1 record as durable, non-authoritative recovery evidence.
		assertFile(movedEvidence, evidence);
		assertMoved();
		if (
			!native().exactUnlinkDirect(`${destination.authorityKey}.lock`, {
				...exactIdentity(lock, finalOwnerDirectory),
				quarantineName: `.owner-publication-lock-${nonce()}`,
			}).ok
		)
			refuse("authority_changed");
		fs.fsyncSync(retained[2].fd);
		checkRetained();
		assertCanonicalRoot(finalRoot);
		assertCanonicalRoot(finalOwnerDirectory);
		assertAbsent(sourceRoot.realpath);
		assertSnapshot(destination, installed);
		while (descriptors.length) fs.closeSync(descriptors.pop()!);
		released = true;
		// No fallible filesystem operation after granting the rebound capability.
		data.target = destination;
		data.snapshotDigest = destination.snapshotDigest;
		data.rev = rebound.rev;
		data.directoryPublicationUnresolved = false;
		return getOwnerMembershipEvidence(token);
	} catch (error) {
		failures.push(error);
		throw error;
	} finally {
		data.publishing = false;
		if (!dispatched) releaseLocks(locks, failures);
		else if (released) {
			lockedDirectories.delete(source.authorityKey);
			lockedDirectories.delete(path.join(finalDirectory, ".gjc-owners", path.basename(source.authorityKey)));
		}
		for (const fd of descriptors.toReversed()) {
			try {
				fs.closeSync(fd);
			} catch (error) {
				failures.push(error);
			}
		}
		throwFailures(failures);
	}
}

/** Merely returns required marker data. It does NOT claim that any marker was written. */
export function ownerFirstWriteMarkerSync(token: OwnerMembership): OwnerFirstWriteMarker | undefined {
	const data = membership(token);
	if (!data.publishing) refuse("participation_lost");
	if (!data.markerRequired) return undefined;
	if (!data.marker || data.marker.rev !== data.rev)
		data.marker = Object.freeze({
			authorityKey: data.target.authorityKey,
			headerId: data.target.headerId,
			epoch: data.epoch,
			rev: data.rev,
			...data.member,
		});
	return data.marker;
}
/** The callback must freshly verify actual durable marker bytes under the publication lock. */
export function confirmOwnerFirstWriteMarkerSync(
	token: OwnerMembership,
	marker: OwnerFirstWriteMarker,
	verifyDurableCapture: (marker: OwnerFirstWriteMarker) => boolean,
): void {
	const data = membership(token);
	if (!data.publishing || !data.marker || marker !== data.marker || verifyDurableCapture(marker) !== true)
		refuse("participation_lost");
	data.markerRequired = false;
}

/** Registry caller, not this primitive, must establish the independent P_retire predicate. */
export function retireOwnerMembershipSync(token: OwnerMembership): "retired" | "already_retired" {
	const data = memberships.get(token);
	if (!data) refuse("invalid_membership");
	if (data.directoryPublicationUnresolved) refuse("participation_lost");
	if (data.retired) return "already_retired";
	const chain = ownerChain(data.target);
	// Follow only exact moved generations; never remove a successor epoch.
	for (const entry of chain)
		if (!entry.snapshot.record || entry.snapshot.record.epoch !== data.epoch) refuse("participation_lost");
	return withLocks(
		chain.map(entry => entry.target),
		() => {
			for (const entry of chain) assertSnapshot(entry.target, entry.snapshot);
			const last = chain[chain.length - 1];
			const next = readRecord(last.target).record;
			if (
				!next ||
				next.epoch !== data.epoch ||
				next.mode !== data.policy.kind ||
				!next.members.some(member => exactMember(member, data.member))
			)
				refuse("participation_lost");
			data.target = last.target;
			data.rev = next.rev;
			return retireUnderLock(data);
		},
	);
}
function retireUnderLock(data: MembershipData): "retired" {
	const snapshot = currentMember(data, false, "optional");
	const record = snapshot.record!;
	const members = record.members.filter(member => !exactMember(member, data.member));
	replaceRecord(data.target, snapshot, {
		...record,
		rev: record.rev + 1,
		state: members.length ? "live" : "retired",
		members,
	});
	data.retired = true;
	return "retired";
}

interface OwnerChainEntry {
	target: OwnerTarget;
	snapshot: RecordSnapshot;
}
function ownerChain(target: OwnerTarget): OwnerChainEntry[] {
	const chain: OwnerChainEntry[] = [];
	for (let index = 0; index < 16; index++) {
		if (chain.some(entry => entry.target.authorityKey === target.authorityKey)) refuse("authority_changed");
		const snapshot = readRecord(target);
		chain.push({ target, snapshot });
		if (snapshot.record?.state !== "moved") return chain;
		if (!snapshot.record.transfer) refuse("authority_changed");
		target = snapshot.record.transfer.to;
	}
	refuse("authority_changed");
}
export function deleteWithOwnerCheckSync<T>(
	target: OwnerTarget,
	inspectors: OwnerInspectors,
	verifiedDelete: (resolved: OwnerTarget) => { readonly deleted: true; readonly value: T },
): T {
	const chain = ownerChain(target);
	const observations = chain.map(entry => {
		const captured = captureOwnerTargetSync({
			transcriptPath: entry.target.transcriptPath,
			headerId: entry.target.headerId,
		});
		if (!sameRoot(captured.authorityRoot, entry.target.authorityRoot)) refuse("authority_changed");
		if (
			chain.length === 1 &&
			(captured.snapshotDigest !== target.snapshotDigest || captured.transcriptExists !== target.transcriptExists)
		)
			refuse("stale_snapshot");
		return { target: captured, before: observe(captured, inspectors, true) };
	});
	const last = observations[observations.length - 1];
	assertDeletable(last.before.record, last.before.marker);
	// Old moved locations must really be absent, not another transcript hidden behind a tombstone.
	for (const entry of observations.slice(0, -1)) if (entry.target.transcriptExists) refuse("authority_changed");
	return withLocks(
		observations.map(entry => entry.target),
		() => {
			const current = observations.map(entry => {
				const observed = observe(entry.target, inspectors, true);
				if (
					evidenceStamp(entry.before) !== evidenceStamp(observed) ||
					entry.before.record.file?.digest !== observed.record.file?.digest
				)
					refuse("authority_changed");
				return { target: entry.target, observation: observed };
			});
			const final = current[current.length - 1];
			assertDeletable(final.observation.record, final.observation.marker);
			const result = verifiedDelete(final.target);
			if (!result || result.deleted !== true) refuse("unknown_ownership");
			// A callback's claim alone is not sufficient to erase any authority/tombstone fence.
			for (const entry of current) {
				try {
					fs.lstatSync(entry.target.transcriptPath);
					refuse("unknown_ownership");
				} catch (error) {
					if (!missing(error)) throw error;
				}
			}
			// Keep source locators until destination cleanup completes, so interrupted cleanup is retryable.
			for (const entry of current.toReversed()) exactRemove(entry.target, entry.observation.record);
			return result.value;
		},
	);
}
/** Retain authority through actual asynchronous deletion, including artifact cleanup. */
export async function deleteWithOwnerCheck<T>(
	target: OwnerTarget,
	inspectors: OwnerAsyncInspectors,
	verifiedDelete: (resolved: OwnerTarget) => Promise<{ readonly deleted: true; readonly value: T }>,
): Promise<T> {
	target = copyTarget(target);
	const chain = ownerChain(target);
	const observations: Array<{ target: OwnerTarget; before: AdmissionObservation; transcript?: FileBytes }> = [];
	for (const entry of chain) {
		const captured = captureOwnerTargetSync({
			transcriptPath: entry.target.transcriptPath,
			headerId: entry.target.headerId,
		});
		if (!sameRoot(captured.authorityRoot, entry.target.authorityRoot)) refuse("authority_changed");
		if (
			chain.length === 1 &&
			(captured.snapshotDigest !== target.snapshotDigest || captured.transcriptExists !== target.transcriptExists)
		)
			refuse("stale_snapshot");
		const transcript = transcriptSnapshot(captured, true);
		const before = await observeAsync(captured, inspectors, true);
		assertTranscriptSnapshot(captured, transcript);
		assertSnapshot(entry.target, entry.snapshot);
		observations.push({ target: captured, before, transcript });
	}
	const last = observations[observations.length - 1];
	assertDeletable(last.before.record, last.before.marker);
	for (const entry of observations.slice(0, -1)) if (entry.target.transcriptExists) refuse("authority_changed");
	return withLocksAsync(
		observations.map(entry => entry.target),
		async () => {
			const current: Array<{ target: OwnerTarget; observation: AdmissionObservation }> = [];
			for (const entry of observations) {
				const observed = await observeAsync(entry.target, inspectors, true);
				if (evidenceStamp(entry.before) !== evidenceStamp(observed)) refuse("authority_changed");
				assertSnapshot(entry.target, entry.before.record);
				current.push({ target: entry.target, observation: observed });
			}
			// Later scans yielded: bind every earlier record and physical transcript again.
			for (const [index, entry] of observations.entries()) {
				assertSnapshot(entry.target, current[index].observation.record);
				assertTranscriptSnapshot(entry.target, entry.transcript);
			}
			const final = current[current.length - 1];
			assertDeletable(final.observation.record, final.observation.marker);
			const result = await verifiedDelete(final.target);
			if (!result || result.deleted !== true) refuse("unknown_ownership");
			for (const entry of current) {
				try {
					fs.lstatSync(entry.target.transcriptPath);
					refuse("unknown_ownership");
				} catch (error) {
					if (!missing(error)) throw error;
				}
			}
			// A thrown/uncertain delete never reaches authority or tombstone cleanup.
			for (const entry of current.toReversed()) exactRemove(entry.target, entry.observation.record);
			return result.value;
		},
	);
}
function assertTranscriptSnapshot(target: OwnerTarget, expected: FileBytes | undefined): void {
	const current = transcriptSnapshot(target, true);
	if (
		(current === undefined) !== (expected === undefined) ||
		(current && expected && (current.digest !== expected.digest || !sameStat(current.stat, expected.stat)))
	)
		refuse("authority_changed");
}
function assertDeletable(snapshot: RecordSnapshot, markers: OwnerMarkerEvidence): void {
	if (snapshot.kind === "corrupt") refuse("unknown_ownership");
	const record = snapshot.record;
	if (record && ["transfer_reserved", "incoming", "settled"].includes(record.state)) refuse("transfer_in_progress");
	if (record?.state === "moved") refuse("session_moved");
	if (record?.state === "live") {
		const state = aggregate(record.members);
		if (state === "unknown") refuse("unknown_ownership");
		if (state === "live") refuse("owned_by_other");
	}
	if (!record && markers.kind === "present" && (!markers.members.length || aggregate(markers.members) !== "dead"))
		refuse("authority_lost_unresolved");
}

/** Reserve before manager move listeners perform any actual transcript move. */
export function reserveOwnerTransferSync(token: OwnerMembership, destination: OwnerTarget): OwnerTransfer {
	destination = copyTarget(destination);
	const data = membership(token);
	validateTarget(destination);
	if (destination.headerId !== data.target.headerId || destination.authorityKey === data.target.authorityKey)
		refuse("invalid_transfer");
	const sourceTarget = captureOwnerTargetSync({
		transcriptPath: data.target.transcriptPath,
		headerId: data.target.headerId,
	});
	if (!sameRoot(sourceTarget.authorityRoot, data.target.authorityRoot)) refuse("authority_changed");
	const before = observe(sourceTarget, data.inspectors, data.policy.kind === "exclusive_native");
	// Destination vetoes also precede all namespace/lock mutation. No endpoint-absence shortcut.
	const veto = data.inspectors.inspectVetoes(destination);
	if (veto.kind !== "clear") refuse(veto.kind);
	if (transcriptSnapshot(destination, true)) refuse("destination_authority_conflict");
	const destinationBefore = observe(destination, data.inspectors, true);
	if (
		destinationBefore.record.kind !== "absent" ||
		destinationBefore.marker.kind !== "absent" ||
		destination.transcriptExists
	)
		refuse("destination_authority_conflict");
	return withLocks([data.target, destination], () => {
		const source = currentMember(data, true);
		const sourceUnder = observe(sourceTarget, data.inspectors, data.policy.kind === "exclusive_native");
		const destinationUnder = observe(destination, data.inspectors, true);
		return reserveUnderLocks(
			token,
			data,
			sourceTarget,
			destination,
			source,
			before,
			destinationBefore,
			sourceUnder,
			destinationUnder,
		);
	});
}
function reserveUnderLocks(
	token: OwnerMembership,
	data: MembershipData,
	sourceTarget: OwnerTarget,
	destination: OwnerTarget,
	source: RecordSnapshot,
	before: AdmissionObservation,
	destinationBefore: AdmissionObservation,
	sourceUnder: AdmissionObservation,
	destinationUnder: AdmissionObservation,
): OwnerTransfer {
	if (
		evidenceStamp(sourceUnder) !== evidenceStamp(before) ||
		evidenceStamp(destinationUnder) !== evidenceStamp(destinationBefore)
	)
		refuse("authority_changed");
	const dest = destinationUnder.record;
	if (dest.kind !== "absent" || destinationUnder.marker.kind !== "absent") refuse("destination_authority_conflict");
	const transfer: OwnerTransferData = {
		transferId: nonce(),
		from: sourceTarget,
		to: destination,
		initiator: data.member,
	};
	const sourceRecord = source.record!;
	const reserved: OwnerRecord = { ...sourceRecord, rev: sourceRecord.rev + 1, state: "transfer_reserved", transfer };
	const handle = Object.freeze({}) as OwnerTransfer;
	transfers.set(handle, { data: transfer, membership: token, epoch: data.epoch, rev: reserved.rev });
	// Retain the opaque backstop even if a later durable publication throws.
	data.pendingTransfer = handle;
	replaceRecord(data.target, source, reserved);
	// If incoming publication fails, the reserved old record remains a recoverable fence.
	replaceRecord(destination, dest, {
		...reserved,
		rev: reserved.rev + 1,
		state: "incoming",
		authorityRoot: destination.authorityRoot,
		ownerDirectory: directory(destination, false)!,
	});
	data.rev = reserved.rev;
	return handle;
}
/** Async evidence is freshly scanned before and inside the same sorted double lock. */
export async function reserveOwnerTransfer(token: OwnerMembership, destination: OwnerTarget): Promise<OwnerTransfer> {
	const data = membership(token);
	const originalTarget = data.target;
	destination = copyTarget(destination);
	validateTarget(destination);
	if (destination.headerId !== data.target.headerId || destination.authorityKey === data.target.authorityKey)
		refuse("invalid_transfer");
	const sourceTarget = captureOwnerTargetSync({
		transcriptPath: data.target.transcriptPath,
		headerId: data.target.headerId,
	});
	if (!sameRoot(sourceTarget.authorityRoot, data.target.authorityRoot)) refuse("authority_changed");
	const inspectors: OwnerAsyncInspectors = data.asyncInspectors ?? {
		inspectVetoes: async target => data.inspectors.inspectVetoes(target),
		readMarkers: async target => data.inspectors.readMarkers(target),
	};
	const exclusive = data.policy.kind === "exclusive_native";
	const before = await observeAsync(sourceTarget, inspectors, exclusive);
	const destinationBefore = await observeAsync(destination, inspectors, true);
	if (
		destinationBefore.record.kind !== "absent" ||
		destinationBefore.marker.kind !== "absent" ||
		destination.transcriptExists
	)
		refuse("destination_authority_conflict");
	return withLocksAsync([originalTarget, destination], async () => {
		if (data.target !== originalTarget) refuse("participation_lost");
		const sourceEvidence = await observeAsync(sourceTarget, inspectors, exclusive);
		const destinationUnder = await observeAsync(destination, inspectors, true);
		// Destination scanning yielded: bind the source again before either CAS.
		const sourceUnder = observe(
			sourceTarget,
			{ inspectVetoes: () => sourceEvidence.veto, readMarkers: () => sourceEvidence.marker },
			exclusive,
		);
		const source = currentMember(data, true);
		return reserveUnderLocks(
			token,
			data,
			sourceTarget,
			destination,
			source,
			before,
			destinationBefore,
			sourceUnder,
			destinationUnder,
		);
	});
}
/** Available even when reserve threw after publishing the old-location fence. */
export function getPendingOwnerTransfer(token: OwnerMembership): OwnerTransfer | undefined {
	return membership(token).pendingTransfer;
}
function matchingTransfer(
	record: OwnerRecord | undefined,
	transfer: OwnerTransferData,
	epoch: string,
): record is OwnerRecord {
	return (
		record !== undefined &&
		record.epoch === epoch &&
		record.transfer?.transferId === transfer.transferId &&
		record.transfer.from.authorityKey === transfer.from.authorityKey &&
		record.transfer.to.authorityKey === transfer.to.authorityKey &&
		sameRoot(record.transfer.from.authorityRoot, transfer.from.authorityRoot) &&
		sameRoot(record.transfer.to.authorityRoot, transfer.to.authorityRoot) &&
		exactMember(record.transfer.initiator, transfer.initiator)
	);
}
function existsTranscript(target: OwnerTarget): boolean {
	return transcriptSnapshot(target, true) !== undefined;
}
function transferPublication(handle: OwnerTransfer): { entry: TransferHandle; data: MembershipData } {
	const entry = transfers.get(handle);
	if (!entry) refuse("invalid_transfer");
	const data = membership(entry.membership);
	const own = ownProcess();
	const initiator = entry.data.initiator;
	if (
		data.pendingTransfer !== handle ||
		initiator.pid !== process.pid ||
		initiator.hostId !== own.hostId ||
		initiator.processIncarnation !== own.incarnation ||
		!exactMember(initiator, data.member)
	)
		refuse("invalid_transfer");
	return { entry, data };
}
function currentTransferPublication(
	handle: OwnerTransfer,
	entry: TransferHandle,
	data: MembershipData,
): readonly [RecordSnapshot, RecordSnapshot] {
	const transfer = entry.data;
	if (
		data.retired ||
		data.pendingTransfer !== handle ||
		data.epoch !== entry.epoch ||
		data.rev !== entry.rev ||
		data.target.authorityKey !== transfer.from.authorityKey ||
		!sameRoot(data.target.authorityRoot, transfer.from.authorityRoot) ||
		probeOwnerMemberSync(data.member) !== "live"
	)
		refuse("invalid_transfer");
	const source = readRecord(transfer.from);
	const destination = readRecord(transfer.to);
	for (const [snapshot, state, rev] of [
		[source, "transfer_reserved", entry.rev],
		[destination, "incoming", entry.rev + 1],
	] as const) {
		const record = snapshot.record;
		if (
			!matchingTransfer(record, transfer, entry.epoch) ||
			record.state !== state ||
			record.rev !== rev ||
			record.mode !== data.policy.kind ||
			!record.members.some(member => exactMember(member, data.member))
		)
			refuse("invalid_transfer");
		const from = record.transfer!.from;
		const to = record.transfer!.to;
		if (
			from.transcriptPath !== transfer.from.transcriptPath ||
			from.headerId !== transfer.from.headerId ||
			from.snapshotDigest !== transfer.from.snapshotDigest ||
			from.transcriptExists !== transfer.from.transcriptExists ||
			to.transcriptPath !== transfer.to.transcriptPath ||
			to.headerId !== transfer.to.headerId ||
			to.snapshotDigest !== transfer.to.snapshotDigest ||
			to.transcriptExists !== transfer.to.transcriptExists
		)
			refuse("invalid_transfer");
	}
	return [source, destination];
}
/** Short destination metadata writes only; settlement/rollback remains the caller's explicit step. */
export async function withOwnerTransferPublication<T>(handle: OwnerTransfer, body: () => Promise<T>): Promise<T> {
	const { entry, data } = transferPublication(handle);
	if (data.publishing) refuse("participation_lost");
	return withLocksAsync([entry.data.from, entry.data.to], async () => {
		const [source, destination] = currentTransferPublication(handle, entry, data);
		data.publishing = true;
		const failures: unknown[] = [];
		let result!: T;
		try {
			try {
				result = await body();
			} catch (error) {
				failures.push(error);
			}
			try {
				currentTransferPublication(handle, entry, data);
				assertSnapshot(entry.data.from, source);
				assertSnapshot(entry.data.to, destination);
			} catch (error) {
				failures.push(error);
			}
			throwFailures(failures);
			return result;
		} finally {
			data.publishing = false;
		}
	});
}
/** Non-yielding equivalent for standalone synchronous destination metadata writes. */
export function withOwnerTransferPublicationSync<T>(handle: OwnerTransfer, body: () => T): T {
	const { entry, data } = transferPublication(handle);
	if (data.publishing || Object.prototype.toString.call(body) === "[object AsyncFunction]")
		refuse("participation_lost");
	return withLocks([entry.data.from, entry.data.to], () => {
		const [source, destination] = currentTransferPublication(handle, entry, data);
		data.publishing = true;
		const failures: unknown[] = [];
		let result!: T;
		try {
			try {
				result = body();
				if (
					result !== null &&
					(typeof result === "object" || typeof result === "function") &&
					typeof (result as { then?: unknown }).then === "function"
				)
					refuse("participation_lost");
			} catch (error) {
				failures.push(error);
			}
			try {
				currentTransferPublication(handle, entry, data);
				assertSnapshot(entry.data.from, source);
				assertSnapshot(entry.data.to, destination);
			} catch (error) {
				failures.push(error);
			}
			throwFailures(failures);
			return result;
		} finally {
			data.publishing = false;
		}
	});
}
/** Idempotent initiator backstop; manager after/abort listener failures must call this again. */
export function settleOwnerTransferSync(handle: OwnerTransfer, outcome: "success" | "abort"): "moved" | "aborted" {
	const entry = transfers.get(handle);
	if (!entry) refuse("invalid_transfer");
	const data = membership(entry.membership);
	const transfer = entry.data;
	const own = ownProcess();
	if (
		transfer.initiator.pid !== process.pid ||
		transfer.initiator.hostId !== own.hostId ||
		transfer.initiator.processIncarnation !== own.incarnation ||
		!exactMember(transfer.initiator, data.member)
	)
		refuse("invalid_transfer");
	return withLocks([transfer.from, transfer.to], () => settleUnderLocks(transfer, data.epoch, outcome, data));
}
/** Async lock acquisition retains the identical transfer CAS and initiator backstop. */
export async function settleOwnerTransfer(
	handle: OwnerTransfer,
	outcome: "success" | "abort",
): Promise<"moved" | "aborted"> {
	const entry = transfers.get(handle);
	if (!entry) refuse("invalid_transfer");
	const data = membership(entry.membership);
	const transfer = entry.data;
	const own = ownProcess();
	if (
		transfer.initiator.pid !== process.pid ||
		transfer.initiator.hostId !== own.hostId ||
		transfer.initiator.processIncarnation !== own.incarnation ||
		!exactMember(transfer.initiator, data.member)
	)
		refuse("invalid_transfer");
	return withLocksAsync([transfer.from, transfer.to], async () =>
		settleUnderLocks(transfer, data.epoch, outcome, data),
	);
}
function settleUnderLocks(
	transfer: OwnerTransferData,
	epoch: string,
	outcome: "success" | "abort",
	data?: MembershipData,
): "moved" | "aborted" {
	let old = readRecord(transfer.from);
	let next = readRecord(transfer.to);
	if (outcome === "success") {
		if (!matchingTransfer(old.record, transfer, epoch) || !["transfer_reserved", "moved"].includes(old.record.state))
			refuse("invalid_transfer");
		if (
			!next.record ||
			next.record.epoch !== epoch ||
			next.record.mode !== old.record.mode ||
			!["incoming", "settled", "live"].includes(next.record.state) ||
			(next.record.state === "live" ? old.record.state !== "moved" : !matchingTransfer(next.record, transfer, epoch))
		)
			refuse("invalid_transfer");
		if (existsTranscript(transfer.from) || !existsTranscript(transfer.to)) refuse("transfer_abandoned_ambiguous");
		// settled keeps the transfer id until the old tombstone is durable: every crash stage is fenced.
		if (next.record.state === "incoming") {
			replaceRecord(transfer.to, next, { ...next.record, rev: next.record.rev + 1, state: "settled" });
			next = readRecord(transfer.to);
		}
		if (old.record!.state !== "moved") {
			replaceRecord(transfer.from, old, { ...old.record!, rev: old.record!.rev + 1, state: "moved" });
			old = readRecord(transfer.from);
		}
		if (next.record!.state === "settled") {
			const { transfer: _transfer, ...live } = next.record!;
			replaceRecord(transfer.to, next, { ...live, rev: live.rev + 1, state: "live" });
			next = readRecord(transfer.to);
		}
		if (data) {
			data.target = captureOwnerTargetSync({
				transcriptPath: transfer.to.transcriptPath,
				headerId: transfer.to.headerId,
			});
			data.rev = next.record!.rev;
			data.markerRequired = true;
			data.marker = undefined;
		}
		return "moved";
	}
	if (old.record?.state === "live" && old.record.epoch === epoch && next.kind === "absent") {
		if (!existsTranscript(transfer.from) || existsTranscript(transfer.to)) refuse("transfer_abandoned_ambiguous");
		if (data) data.rev = old.record.rev;
		return "aborted";
	}
	if (
		!matchingTransfer(old.record, transfer, epoch) ||
		old.record.state !== "transfer_reserved" ||
		(next.kind !== "absent" &&
			(!matchingTransfer(next.record, transfer, epoch) || !["incoming", "settled"].includes(next.record.state)))
	)
		refuse("invalid_transfer");
	if (!existsTranscript(transfer.from) || existsTranscript(transfer.to)) refuse("transfer_abandoned_ambiguous");
	if (next.kind !== "absent") exactRemove(transfer.to, next);
	const { transfer: _transfer, ...live } = old.record;
	replaceRecord(transfer.from, old, { ...live, rev: live.rev + 1, state: "live" });
	if (data) {
		data.target = captureOwnerTargetSync({
			transcriptPath: transfer.from.transcriptPath,
			headerId: transfer.from.headerId,
		});
		data.rev = live.rev + 1;
	}
	return "aborted";
}
/** Recovery is read-only until the initiating exact OS incarnation is positively dead. */
export async function recoverOwnerTransfer(target: OwnerTarget): Promise<"moved" | "aborted"> {
	const observed = readRecord(target).record;
	if (!observed?.transfer) refuse("invalid_transfer");
	const transfer = observed.transfer;
	if (probeOwnerMemberSync(transfer.initiator) !== "dead") refuse("transfer_in_progress");
	return withLocksAsync([transfer.from, transfer.to], async () => {
		const current = readRecord(target).record;
		if (!matchingTransfer(current, transfer, observed.epoch)) refuse("authority_changed");
		if (probeOwnerMemberSync(transfer.initiator) !== "dead") refuse("transfer_in_progress");
		const oldExists = existsTranscript(transfer.from);
		const newExists = existsTranscript(transfer.to);
		if (oldExists === newExists) refuse("transfer_abandoned_ambiguous");
		return settleUnderLocks(transfer, observed.epoch, newExists ? "success" : "abort");
	});
}
/** Recovery is read-only until the initiating exact OS incarnation is positively dead. */
export function recoverOwnerTransferSync(target: OwnerTarget): "moved" | "aborted" {
	const observed = readRecord(target).record;
	if (!observed?.transfer) refuse("invalid_transfer");
	const transfer = observed.transfer;
	if (probeOwnerMemberSync(transfer.initiator) !== "dead") refuse("transfer_in_progress");
	return withLocks([transfer.from, transfer.to], () => {
		const current = readRecord(target).record;
		if (!matchingTransfer(current, transfer, observed.epoch)) refuse("authority_changed");
		if (probeOwnerMemberSync(transfer.initiator) !== "dead") refuse("transfer_in_progress");
		const oldExists = existsTranscript(transfer.from);
		const newExists = existsTranscript(transfer.to);
		if (oldExists === newExists) refuse("transfer_abandoned_ambiguous");
		return settleUnderLocks(transfer, observed.epoch, newExists ? "success" : "abort");
	});
}
