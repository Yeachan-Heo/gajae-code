import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import * as sync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { observeProcessIncarnation } from "../../src/sdk/broker/process-incarnation";
import { SessionIndex } from "../../src/sdk/broker/session-index";
import { createCooperativeOwnerInspectors, createNativeOwnerInspectors } from "../../src/sdk/native-ownership";
import { withManagedSessionTransaction } from "../../src/session/internal/managed-session-transaction";
import {
	admitOwnerMembership,
	admitOwnerMembershipSync,
	admitOwnerMembershipWithAsyncEvidence,
	allocateFreshOwnerCreation,
	captureLegacyTakeoverAttestationSync,
	captureLegacyTakeoverAttestationWithAsyncEvidence,
	captureLiveCooperativeOwnerProcessesSync,
	captureOwnerTargetSync,
	confirmOwnerFirstWriteMarkerSync,
	deleteWithOwnerCheck,
	deleteWithOwnerCheckSync,
	getOwnerMembershipEvidence,
	isLiveCooperativeOwnerProcessSync,
	type OwnerAdmissionOptions,
	OwnerAuthorityError,
	type OwnerMarkerEvidence,
	type OwnerMembership,
	type OwnerRecord,
	type OwnerRefusal,
	type OwnerTarget,
	type OwnerVetoEvidence,
	ownerFirstWriteMarkerSync,
	ownerHostIdSync,
	probeOwnerMemberSync,
	probeSessionOwnershipSync,
	probeSessionOwnershipWithAsyncEvidence,
	recheckOwnerAdmissionSync,
	recheckOwnerAdmissionWithAsyncEvidence,
	retireOwnerMembershipSync,
	revalidateOwnerMembership,
	revalidateOwnerMembershipSync,
	withCooperativeOwnerPublication,
	withOwnerPublication,
	withOwnerPublicationSync,
} from "../../src/session/owner-group";
import { resolveResumeCheckpoint } from "../../src/session/resume-cursor";
import type { SessionHeader } from "../../src/session/session-manager";
import { FileSessionStorage } from "../../src/session/session-storage";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const previousIncarnation = (value: string) => value.replace(/\d+$/, digits => String(BigInt(digits) + 1n));
const clear: OwnerVetoEvidence = { kind: "clear", digest: digest("clear"), evidence: [] };
function code(body: () => unknown, expected: OwnerRefusal): void {
	try {
		body();
		throw new Error(`Expected ${expected}`);
	} catch (error) {
		expect(error).toBeInstanceOf(OwnerAuthorityError);
		if (!(error instanceof OwnerAuthorityError)) throw error;
		expect(error.code).toBe(expected);
	}
}

describe("adjacent owner-group authority", () => {
	let dir: string;
	let transcript: string;
	let target: OwnerTarget;
	let header: SessionHeader;
	let veto: OwnerVetoEvidence;
	let markers: OwnerMarkerEvidence;
	let options: OwnerAdmissionOptions;
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-group-"));
		transcript = path.join(dir, "unrelated-basename.jsonl");
		header = { type: "session", version: 5, id: "header-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir };
		await Bun.write(transcript, `${JSON.stringify(header)}\n`);
		target = captureOwnerTargetSync({ transcriptPath: transcript, headerId: "header-1" });
		veto = clear;
		markers = {
			kind: "absent",
			digest: digest("markers absent"),
			snapshotDigest: target.snapshotDigest,
			members: [],
		};
		options = {
			runtime: "sdk-owner-test",
			capabilities: ["publication"],
			inspectVetoes: () => veto,
			readMarkers: () => markers,
		};
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});
	const cooperative = { kind: "cooperative" } as const;
	function exclusive() {
		return {
			kind: "exclusive_native",
			expected: {
				snapshotDigest: target.snapshotDigest,
				resolved: resolveResumeCheckpoint([header], target.snapshotDigest),
			},
		} as const;
	}
	async function record(): Promise<OwnerRecord> {
		return await Bun.file(target.authorityKey).json();
	}
	async function seed(value: OwnerRecord | string): Promise<void> {
		await fs.mkdir(path.dirname(target.authorityKey), { recursive: true, mode: 0o700 });
		await Bun.write(target.authorityKey, typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
		await fs.chmod(target.authorityKey, 0o600);
	}
	async function deadRecord(): Promise<OwnerRecord> {
		admitOwnerMembershipSync(target, cooperative, options);
		const live = await record();
		await seed({
			...live,
			members: live.members.map(member => ({
				...member,
				processIncarnation: previousIncarnation(member.processIncarnation),
			})),
		});
		return live;
	}

	it("requires a genuine firstborn identity rather than missing bytes or a cloned creation claim", async () => {
		const creation = allocateFreshOwnerCreation();
		header = { ...header, id: creation.headerId };
		target = captureOwnerTargetSync({ transcriptPath: path.join(dir, `${header.id}.jsonl`), headerId: header.id });
		markers = { ...markers, snapshotDigest: target.snapshotDigest };
		const before = await fs.readdir(dir);
		code(() => admitOwnerMembershipSync(target, exclusive(), options), "legacy_attestation_required");
		code(
			() => admitOwnerMembershipSync(target, { ...exclusive(), freshCreation: { ...creation } }, options),
			"legacy_attestation_required",
		);
		code(
			() =>
				admitOwnerMembershipSync(target, { ...exclusive(), freshCreation: allocateFreshOwnerCreation() }, options),
			"legacy_attestation_required",
		);
		expect(await fs.readdir(dir)).toEqual(before);
		const membership = admitOwnerMembershipSync(target, { ...exclusive(), freshCreation: creation }, options);
		expect(getOwnerMembershipEvidence(membership).policy.kind).toBe("exclusive_native");
		expect((await record()).state).toBe("live");
		expect(await Bun.file(target.transcriptPath).exists()).toBe(false);
		const otherRoot = path.join(dir, "other");
		await fs.mkdir(otherRoot, { mode: 0o700 });
		target = captureOwnerTargetSync({
			transcriptPath: path.join(otherRoot, `${header.id}.jsonl`),
			headerId: header.id,
		});
		markers = { ...markers, snapshotDigest: target.snapshotDigest };
		code(
			() => admitOwnerMembershipSync(target, { ...exclusive(), freshCreation: creation }, options),
			"legacy_attestation_required",
		);
		expect(await fs.readdir(otherRoot)).toEqual([]);
	});

	it("never treats an allocated identity as permission to take over existing transcript bytes", async () => {
		const creation = allocateFreshOwnerCreation();
		header = { ...header, id: creation.headerId };
		const file = path.join(dir, `${header.id}.jsonl`);
		const bytes = `${JSON.stringify(header)}\n`;
		await Bun.write(file, bytes);
		target = captureOwnerTargetSync({ transcriptPath: file, headerId: header.id });
		markers = { ...markers, snapshotDigest: target.snapshotDigest };
		code(
			() => admitOwnerMembershipSync(target, { ...exclusive(), freshCreation: creation }, options),
			"legacy_attestation_required",
		);
		expect(await Bun.file(file).text()).toBe(bytes);
		expect(await Bun.file(target.authorityKey).exists()).toBe(false);
	});

	it("keeps independent unknown ownership vetoes before genuine firstborn admission effects", async () => {
		const creation = allocateFreshOwnerCreation();
		header = { ...header, id: creation.headerId };
		target = captureOwnerTargetSync({ transcriptPath: path.join(dir, `${header.id}.jsonl`), headerId: header.id });
		markers = { ...markers, snapshotDigest: target.snapshotDigest };
		veto = { kind: "unknown_ownership", digest: digest("unknown firstborn veto"), evidence: [] };
		const before = await fs.readdir(dir);
		code(
			() => admitOwnerMembershipSync(target, { ...exclusive(), freshCreation: creation }, options),
			"unknown_ownership",
		);
		expect(await fs.readdir(dir)).toEqual(before);
	});

	it("streams a real 10 MiB transcript hash while retaining only its header", async () => {
		const messages = Array.from({ length: 10 * 1024 }, (_, index) =>
			JSON.stringify({
				type: "message",
				id: `message-${index}`,
				parentId: index === 0 ? null : `message-${index - 1}`,
				timestamp: header.timestamp,
				message: {
					role: "user",
					content: [{ type: "text", text: "x".repeat(1024) }],
					timestamp: Date.parse(header.timestamp),
				},
			}),
		);
		const fixture = `${JSON.stringify(header)}\n${messages.join("\n")}\n`;
		expect(Buffer.byteLength(fixture)).toBeGreaterThanOrEqual(10 * 1024 * 1024);
		await Bun.write(transcript, fixture);
		const expectedDigest = digest(fixture);
		const originalRead = sync.readSync;
		let reads = 0;
		let maxBuffer = 0;
		let maxLength = 0;
		const read = spyOn(sync, "readSync").mockImplementation(((
			fd: number,
			buffer: NodeJS.ArrayBufferView,
			offset: number,
			length: number,
			position: number,
		) => {
			reads++;
			maxBuffer = Math.max(maxBuffer, buffer.byteLength);
			maxLength = Math.max(maxLength, length);
			return originalRead(fd, buffer, offset, Math.min(length, 17 * 1024), position);
		}) as typeof sync.readSync);
		const allocate = spyOn(Buffer, "alloc");
		const wholeRead = spyOn(sync, "readFileSync");
		try {
			target = captureOwnerTargetSync({ transcriptPath: transcript, headerId: header.id });
			expect(target.snapshotDigest).toBe(expectedDigest);
			expect(reads).toBeGreaterThan(10);
			expect(maxBuffer).toBeLessThanOrEqual(64 * 1024);
			expect(maxLength).toBeLessThanOrEqual(64 * 1024);
			expect(Math.max(...allocate.mock.calls.map(([size]) => size))).toBeLessThanOrEqual(64 * 1024 + 1);
			expect(wholeRead).not.toHaveBeenCalled();
		} finally {
			wholeRead.mockRestore();
			allocate.mockRestore();
			read.mockRestore();
		}
		const inspectors = createCooperativeOwnerInspectors({ agentDir: path.join(dir, "agent"), cwd: dir });
		const observed = inspectors.readMarkers(target);
		expect(observed.kind).toBe("absent");
		expect(observed.snapshotDigest).toBe(expectedDigest);
		const admission = { ...options, readMarkers: inspectors.readMarkers };
		const first = admitOwnerMembershipSync(target, cooperative, admission);
		const second = admitOwnerMembershipSync(target, cooperative, admission);
		expect(getOwnerMembershipEvidence(first).snapshotDigest).toBe(expectedDigest);
		expect(getOwnerMembershipEvidence(second).epoch).toBe(getOwnerMembershipEvidence(first).epoch);
		expect((await record()).members).toHaveLength(2);
	});

	it("accepts bounded headers with or without a final newline and rejects an oversized first line", async () => {
		const firstLine = JSON.stringify(header);
		for (const size of [Buffer.byteLength(firstLine), 64 * 1024, 64 * 1024 + 1]) {
			for (const newline of ["", "\n"]) {
				const fixture = `${firstLine}${" ".repeat(size - Buffer.byteLength(firstLine))}${newline}`;
				await Bun.write(transcript, fixture);
				if (size > 64 * 1024) {
					code(
						() => captureOwnerTargetSync({ transcriptPath: transcript, headerId: header.id }),
						"invalid_owner_target",
					);
				} else {
					expect(captureOwnerTargetSync({ transcriptPath: transcript, headerId: header.id }).snapshotDigest).toBe(
						digest(fixture),
					);
				}
			}
		}
	});

	it("rejects mid-stream mutation, early EOF and same-content inode replacement and closes the descriptor", async () => {
		const fixture = `${JSON.stringify(header)}\n${`${JSON.stringify({ type: "message", text: "x".repeat(1024) })}\n`.repeat(256)}`;
		for (const mutation of ["append", "truncate", "same-size", "replace", "early-eof"]) {
			await Bun.write(transcript, fixture);
			const replacement = path.join(dir, "same-content.tmp");
			if (mutation === "replace") {
				await Bun.write(replacement, fixture);
				expect((await fs.stat(replacement, { bigint: true })).ino).not.toBe(
					(await fs.stat(transcript, { bigint: true })).ino,
				);
			}
			const originalRead = sync.readSync;
			let descriptor: number | undefined;
			let reads = 0;
			const read = spyOn(sync, "readSync").mockImplementation(((
				fd: number,
				buffer: NodeJS.ArrayBufferView,
				offset: number,
				length: number,
				position: number,
			) => {
				descriptor = fd;
				if (++reads === 2 && mutation === "early-eof") return 0;
				const count = originalRead(fd, buffer, offset, length, position);
				if (reads === 1) {
					if (mutation === "replace") sync.renameSync(replacement, transcript);
					else if (mutation === "truncate") sync.truncateSync(transcript, count);
					else if (mutation === "append" || mutation === "same-size") {
						const writer = sync.openSync(transcript, "r+");
						try {
							sync.writeSync(
								writer,
								Buffer.from("z"),
								0,
								1,
								mutation === "append" ? Buffer.byteLength(fixture) : count + 20,
							);
							sync.futimesSync(
								writer,
								new Date("2030-01-01T00:00:00.000Z"),
								new Date("2030-01-01T00:00:00.000Z"),
							);
						} finally {
							sync.closeSync(writer);
						}
					}
				}
				return count;
			}) as typeof sync.readSync);
			const close = spyOn(sync, "closeSync");
			try {
				code(
					() => captureOwnerTargetSync({ transcriptPath: transcript, headerId: header.id }),
					"authority_changed",
				);
				expect(descriptor).toBeDefined();
				expect(close.mock.calls.some(([fd]) => fd === descriptor)).toBe(true);
			} finally {
				close.mockRestore();
				read.mockRestore();
			}
			if (mutation === "replace") expect(await Bun.file(transcript).text()).toBe(fixture);
		}
	});

	it("parses and republishes complete owner records larger than one read buffer", async () => {
		const capabilities = Array.from(
			{ length: 64 },
			(_, index) => `${String(index).padStart(4, "0")}${"x".repeat(1020)}`,
		);
		const first = admitOwnerMembershipSync(target, cooperative, { ...options, capabilities });
		expect((await fs.stat(target.authorityKey)).size).toBeGreaterThan(64 * 1024);
		const second = admitOwnerMembershipSync(target, cooperative, options);
		const current = await record();
		expect(current.members).toHaveLength(2);
		expect(current.members[0].capabilities).toEqual(capabilities);
		expect(current.members[0].memberId).toBe(getOwnerMembershipEvidence(first).memberId);
		expect(current.members[1].memberId).toBe(getOwnerMembershipEvidence(second).memberId);
	});

	it("retains complete multi-read owner records as quarantine evidence", async () => {
		const corrupt = `{${"x".repeat(256 * 1024 - 1)}`;
		await seed(corrupt);
		const token = admitOwnerMembershipSync(target, cooperative, options);
		const copies = (await fs.readdir(path.dirname(target.authorityKey))).filter(name =>
			name.startsWith("header-1.json.corrupt-"),
		);
		expect(copies).toHaveLength(1);
		expect(await Bun.file(path.join(path.dirname(target.authorityKey), copies[0])).text()).toBe(corrupt);
		expect((await record()).members[0].memberId).toBe(getOwnerMembershipEvidence(token).memberId);
	});

	it("native expected binds an actual reducer checkpoint and copies its candidates", async () => {
		const policy = exclusive();
		expect(policy.expected.resolved.kind).toBe("empty");
		for (const expected of [
			{
				snapshotDigest: target.snapshotDigest,
				resolved: resolveResumeCheckpoint([{ ...header, id: "other-header" }], target.snapshotDigest),
			},
			{
				snapshotDigest: target.snapshotDigest,
				resolved: resolveResumeCheckpoint([header], digest("different snapshot")),
			},
			{ snapshotDigest: digest("different expectation"), resolved: policy.expected.resolved },
		]) {
			code(
				() => admitOwnerMembershipSync(target, { kind: "exclusive_native", expected }, options),
				"stale_snapshot",
			);
			expect(await Bun.file(path.dirname(target.authorityKey)).exists()).toBe(false);
		}
		const attestation = captureLegacyTakeoverAttestationSync(target, options);
		const token = admitOwnerMembershipSync(target, { ...policy, legacyAttestation: attestation }, options);
		policy.expected.resolved.candidates!.push("caller mutation");
		const stored = getOwnerMembershipEvidence(token).policy;
		if (stored.kind !== "exclusive_native") throw new Error("Expected native policy");
		expect(stored.expected.resolved.candidates).toEqual([]);
		expect(Object.isFrozen(stored.expected.resolved)).toBe(true);
		expect(Object.isFrozen(stored.expected.resolved.candidates)).toBe(true);
	});

	it("keeps exact directory authority when another writer changes only its children", () => {
		const ownerDirectory = path.dirname(target.authorityKey);
		const open = sync.openSync;
		let changed = false;
		const spy = spyOn(sync, "openSync").mockImplementation((file, flags, mode) => {
			const fd = open(file, flags, mode);
			if (file === ownerDirectory && !changed) {
				changed = true;
				sync.closeSync(open(path.join(ownerDirectory, "concurrent-unrelated-entry"), "wx", 0o600));
			}
			return fd;
		});
		let token: OwnerMembership | undefined;
		try {
			token = admitOwnerMembershipSync(target, cooperative, options);
			expect(changed).toBe(true);
			expect(getOwnerMembershipEvidence(token).authorityKey).toBe(target.authorityKey);
			expect(sync.statSync(path.join(ownerDirectory, "concurrent-unrelated-entry")).size).toBe(0);
		} finally {
			spy.mockRestore();
			if (token) retireOwnerMembershipSync(token);
		}
	});

	it("row 1: two cooperative members join one epoch; a native facade never joins", async () => {
		const first = admitOwnerMembershipSync(target, cooperative, options);
		const second = admitOwnerMembershipSync(target, cooperative, { ...options, runtime: "another-agentDir" });
		const a = getOwnerMembershipEvidence(first);
		const b = getOwnerMembershipEvidence(second);
		expect(a.authorityKey).toBe(path.join(await fs.realpath(dir), ".gjc-owners", "header-1.json"));
		expect(a.epoch).toBe(b.epoch);
		expect(a.memberId).not.toBe(b.memberId);
		expect((await record()).members).toHaveLength(2);
		code(() => admitOwnerMembershipSync(target, exclusive(), options), "owned_by_other");
		let published = false;
		code(
			() =>
				withOwnerPublicationSync(first, () => {
					published = true;
				}),
			"participation_lost",
		);
		expect(published).toBe(false);
		revalidateOwnerMembershipSync(first);
		withOwnerPublicationSync(first, () => {
			published = true;
		});
		expect(published).toBe(true);
		retireOwnerMembershipSync(second);
		expect((await record()).members.map(member => member.memberId)).toEqual([a.memberId]);
		retireOwnerMembershipSync(first);
		expect((await record()).state).toBe("retired");
	});

	it("row 1: a foreign-host member is unknown even when its PID is absent locally", async () => {
		admitOwnerMembershipSync(target, cooperative, options);
		const live = await record();
		await seed({
			...live,
			members: live.members.map(member => ({ ...member, hostId: digest("foreign"), pid: 2_147_483_647 })),
		});
		code(() => admitOwnerMembershipSync(target, cooperative, options), "unknown_ownership");
		code(() => admitOwnerMembershipSync(target, exclusive(), options), "unknown_ownership");
		expect((await record()).epoch).toBe(live.epoch);
	});

	it("row 2: kernel-proven old incarnation retires before a fresh epoch", async () => {
		const previous = await deadRecord();
		const next = admitOwnerMembershipSync(target, exclusive(), options);
		expect(getOwnerMembershipEvidence(next).epoch).not.toBe(previous.epoch);
		expect((await record()).rev).toBe(previous.rev + 2);
		expect((await record()).mode).toBe("exclusive_native");
	});

	it("row 3: a retired record grants a fresh epoch without legacy attestation", async () => {
		const first = admitOwnerMembershipSync(target, cooperative, options);
		const epoch = getOwnerMembershipEvidence(first).epoch;
		retireOwnerMembershipSync(first);
		const next = admitOwnerMembershipSync(target, exclusive(), options);
		expect(getOwnerMembershipEvidence(next).epoch).not.toBe(epoch);
		expect(retireOwnerMembershipSync(first)).toBe("already_retired");
		expect((await record()).state).toBe("live");
	});

	it("row 4: absent legacy native admission needs one issued exact-snapshot attestation", async () => {
		expect(probeSessionOwnershipSync(target, options).reason).toBe("legacy_attestation_required");
		expect(await Bun.file(path.dirname(target.authorityKey)).exists()).toBe(false);
		code(() => admitOwnerMembershipSync(target, exclusive(), options), "legacy_attestation_required");
		const attestation = captureLegacyTakeoverAttestationSync(target, options);
		code(
			() => admitOwnerMembershipSync(target, { ...exclusive(), legacyAttestation: { ...attestation } }, options),
			"legacy_attestation_required",
		);
		const token = admitOwnerMembershipSync(target, { ...exclusive(), legacyAttestation: attestation }, options);
		expect(getOwnerMembershipEvidence(token).memberKind).toBe("exclusive_native");
		code(() => admitOwnerMembershipSync(target, cooperative, options), "owned_by_other");
		expect((await record()).members).toHaveLength(1);
	});

	it("row 4: corrupt bytes are durable unique evidence before authorized replacement", async () => {
		const bad = "{partial authority evidence\n";
		await seed(bad);
		const token = admitOwnerMembershipSync(target, cooperative, options);
		expect(getOwnerMembershipEvidence(token).epoch).toMatch(/^[0-9a-f]{32}$/);
		const names = await fs.readdir(path.dirname(target.authorityKey));
		const copies = names.filter(name => name.startsWith("header-1.json.corrupt-"));
		expect(copies).toHaveLength(1);
		expect(await Bun.file(path.join(path.dirname(target.authorityKey), copies[0])).text()).toBe(bad);
		if (process.platform !== "win32") {
			expect((await fs.stat(path.dirname(target.authorityKey))).mode & 0o777).toBe(0o700);
			expect((await fs.stat(target.authorityKey)).mode & 0o777).toBe(0o600);
		}
	});

	it("row 5: live/foreign/missing marker evidence cannot be attested away", async () => {
		const live = await deadRecord();
		await fs.unlink(target.authorityKey);
		for (const members of [
			live.members,
			live.members.map(member => ({ ...member, hostId: digest("foreign host") })),
			[],
		]) {
			markers = { ...markers, kind: "present", members };
			code(() => admitOwnerMembershipSync(target, cooperative, options), "authority_lost_unresolved");
			code(() => captureLegacyTakeoverAttestationSync(target, options), "authority_lost_unresolved");
		}
		expect(await Bun.file(target.authorityKey).exists()).toBe(false);
	});

	it("row 5: all exact marker incarnations dead permit a fresh native epoch", async () => {
		const live = await deadRecord();
		const dead = (await record()).members;
		await fs.unlink(target.authorityKey);
		markers = { ...markers, kind: "present", members: dead };
		const token = admitOwnerMembershipSync(target, exclusive(), options);
		expect(getOwnerMembershipEvidence(token).epoch).not.toBe(live.epoch);
	});

	it("row 6: non-regular, hardlinked, oversize and symlinked records stay protected", async () => {
		const token = admitOwnerMembershipSync(target, cooperative, options);
		const bytes = await Bun.file(target.authorityKey).text();
		await fs.link(target.authorityKey, path.join(dir, "record-alias"));
		code(() => admitOwnerMembershipSync(target, cooperative, options), "unknown_ownership");
		await fs.unlink(path.join(dir, "record-alias"));
		await fs.unlink(target.authorityKey);
		await fs.symlink(path.join(dir, "missing-owner"), target.authorityKey);
		code(() => admitOwnerMembershipSync(target, cooperative, options), "unknown_ownership");
		await fs.unlink(target.authorityKey);
		await fs.mkdir(target.authorityKey);
		code(() => admitOwnerMembershipSync(target, cooperative, options), "unknown_ownership");
		await fs.rmdir(target.authorityKey);
		await seed("x".repeat(256 * 1024 + 1));
		code(() => admitOwnerMembershipSync(target, cooperative, options), "unknown_ownership");
		expect(bytes).toContain(getOwnerMembershipEvidence(token).memberId);
	});

	it("actual OS host and kernel incarnations distinguish reuse, foreign and malformed evidence", async () => {
		admitOwnerMembershipSync(target, cooperative, options);
		const member = (await record()).members[0];
		const hostId = ownerHostIdSync();
		if (hostId === undefined) throw new Error("Expected actual OS host identity");
		expect(hostId).toMatch(/^[0-9a-f]{64}$/);
		expect(member.hostId).toBe(hostId);
		expect(probeOwnerMemberSync(member)).toBe("live");
		expect(
			probeOwnerMemberSync({ ...member, processIncarnation: previousIncarnation(member.processIncarnation) }),
		).toBe("dead");
		expect(probeOwnerMemberSync({ ...member, hostId: digest("foreign"), pid: 2_147_483_647 })).toBe("unknown");
		expect(probeOwnerMemberSync({ ...member, processIncarnation: "" })).toBe("unknown");
		expect(probeOwnerMemberSync({ ...member, pid: 0 })).toBe("unknown");
	});

	it("every independent veto runs before owner namespace/lock mutation, including corrupt evidence", async () => {
		for (const kind of [
			"legacy_lifecycle_ambiguous",
			"authority_roots_unresolved",
			"owned_by_other",
			"unknown_ownership",
		] as const) {
			veto = { kind, digest: digest(kind), evidence: [kind] };
			code(() => admitOwnerMembershipSync(target, cooperative, options), kind);
			expect(await Bun.file(path.dirname(target.authorityKey)).exists()).toBe(false);
		}
		await seed("corrupt");
		code(() => admitOwnerMembershipSync(target, cooperative, options), "unknown_ownership");
		expect(await Bun.file(target.authorityKey).text()).toBe("corrupt");
		expect(await fs.readdir(path.dirname(target.authorityKey))).toEqual(["header-1.json"]);
	});

	it("veto or marker digest change under the lock refuses instead of registering", async () => {
		let calls = 0;
		const changing = { ...options, inspectVetoes: () => ({ ...clear, digest: digest(String(++calls)) }) };
		code(() => admitOwnerMembershipSync(target, cooperative, changing), "authority_changed");
		expect(await Bun.file(target.authorityKey).exists()).toBe(false);
		calls = 0;
		code(
			() =>
				admitOwnerMembershipSync(target, cooperative, {
					...options,
					readMarkers: () => ({ ...markers, digest: digest(String(++calls)) }),
				}),
			"authority_changed",
		);
		expect(await Bun.file(target.authorityKey).exists()).toBe(false);
	});

	it("missing identity in a decoded owner record stays unknown instead of becoming corrupt bootstrap", async () => {
		admitOwnerMembershipSync(target, cooperative, options);
		const live = await record();
		await seed({ ...live, members: live.members.map(member => ({ ...member, processIncarnation: "" })) });
		const bytes = await Bun.file(target.authorityKey).text();
		code(() => admitOwnerMembershipSync(target, cooperative, options), "unknown_ownership");
		expect(await Bun.file(target.authorityKey).text()).toBe(bytes);
	});

	it("post-hydration recheck observes fresh independent vetoes and copied evidence", () => {
		const mutable = { kind: "clear", digest: digest("initial"), evidence: ["initial"] } as OwnerVetoEvidence;
		const token = admitOwnerMembershipSync(target, cooperative, { ...options, inspectVetoes: () => mutable });
		expect(recheckOwnerAdmissionSync(token).memberKind).toBe("cooperative");
		Object.assign(mutable, { digest: digest("changed"), evidence: ["changed"] });
		code(() => recheckOwnerAdmissionSync(token), "authority_changed");
		Object.assign(mutable, { kind: "owned_by_other" });
		code(() => recheckOwnerAdmissionSync(token), "owned_by_other");
	});

	it("root replacement, record root mismatch and unsafe header IDs fail closed", async () => {
		code(() => captureOwnerTargetSync({ transcriptPath: transcript, headerId: "../escape" }), "invalid_owner_target");
		admitOwnerMembershipSync(target, cooperative, options);
		const original = await record();
		await seed({
			...original,
			authorityRoot: { ...original.authorityRoot, ino: String(BigInt(original.authorityRoot.ino) + 1n) },
		});
		code(() => admitOwnerMembershipSync(target, cooperative, options), "authority_changed");
		await seed(original);
		const renamed = `${dir}-old`;
		await fs.rename(dir, renamed);
		try {
			await fs.mkdir(dir, { mode: 0o700 });
			await Bun.write(transcript, `${JSON.stringify({ type: "session", id: "header-1" })}\n`);
			code(() => admitOwnerMembershipSync(target, cooperative, options), "authority_changed");
		} finally {
			await fs.rm(renamed, { recursive: true, force: true });
		}
	});

	it("symlinked transcript/owner directory and native hardlinks are not authority", async () => {
		await fs.link(transcript, path.join(dir, "transcript-alias"));
		code(() => admitOwnerMembershipSync(target, exclusive(), options), "transcript_hardlinked");
		await fs.unlink(path.join(dir, "transcript-alias"));
		await fs.rename(transcript, path.join(dir, "real.jsonl"));
		await fs.symlink(path.join(dir, "real.jsonl"), transcript);
		code(() => captureOwnerTargetSync({ transcriptPath: transcript, headerId: "header-1" }), "invalid_owner_target");
		await fs.unlink(transcript);
		await fs.rename(path.join(dir, "real.jsonl"), transcript);
		const foreign = path.join(dir, "foreign");
		await fs.mkdir(foreign, { mode: 0o700 });
		await fs.symlink(foreign, path.dirname(target.authorityKey));
		code(() => admitOwnerMembershipSync(target, cooperative, options), "authority_changed");
		expect(await fs.readdir(foreign)).toEqual([]);
	});

	it("snapshot changes refuse before effects and opaque membership strings cannot authorize", async () => {
		await fs.appendFile(transcript, "\n");
		code(() => admitOwnerMembershipSync(target, cooperative, options), "stale_snapshot");
		expect(await Bun.file(path.dirname(target.authorityKey)).exists()).toBe(false);
		for (const fake of [{}, { memberId: "made-up", epoch: "made-up" }, "token"]) {
			code(
				() =>
					withOwnerPublicationSync(fake as OwnerMembership, () => {
						throw new Error("must not execute");
					}),
				"invalid_membership",
			);
		}
	});

	it("exact rev/member/epoch fencing never runs a publication body after participation loss", async () => {
		const token = admitOwnerMembershipSync(target, cooperative, options);
		const original = await record();
		let calls = 0;
		for (const replacement of [
			{ ...original, rev: original.rev + 1 },
			{ ...original, members: [] },
			{ ...original, epoch: randomBytes(16).toString("hex") },
		]) {
			await seed(replacement);
			code(() => withOwnerPublicationSync(token, () => ++calls), "participation_lost");
		}
		expect(calls).toBe(0);
		code(() => retireOwnerMembershipSync(token), "participation_lost");
		expect((await record()).epoch).not.toBe(original.epoch);
	});

	it("native mode cannot be promoted/mutated, and async bodies never run", async () => {
		const token = admitOwnerMembershipSync(target, cooperative, options);
		const evidence = getOwnerMembershipEvidence(token);
		expect(Object.isFrozen(evidence.policy)).toBe(true);
		expect(evidence.policy.kind).toBe("cooperative");
		let calls = 0;
		code(
			() =>
				withOwnerPublicationSync(token, async () => {
					calls++;
				}),
			"participation_lost",
		);
		expect(calls).toBe(0);
		code(() => withOwnerPublicationSync(token, () => Promise.resolve("not synchronous")), "participation_lost");
	});

	it("first-write marker contains actual identity, remains required until durable capture, and follows inode replacement", async () => {
		const token = admitOwnerMembershipSync(target, cooperative, options);
		code(() => ownerFirstWriteMarkerSync(token), "participation_lost");
		withOwnerPublicationSync(token, () => {
			const marker = ownerFirstWriteMarkerSync(token)!;
			expect(marker.pid).toBe(process.pid);
			const hostId = ownerHostIdSync();
			if (hostId === undefined) throw new Error("Expected actual OS host identity");
			expect(marker.hostId).toBe(hostId);
			code(() => confirmOwnerFirstWriteMarkerSync(token, marker, () => false), "participation_lost");
			expect(ownerFirstWriteMarkerSync(token)).toBe(marker);
			const bytes = `${JSON.stringify({ type: "session", id: "header-1" })}\n${JSON.stringify({ type: "owner_group", ...marker })}\n`;
			const replacement = path.join(dir, "rewrite.tmp");
			const fd = sync.openSync(replacement, "wx", 0o600);
			try {
				sync.writeSync(fd, bytes);
				sync.fsyncSync(fd);
			} finally {
				sync.closeSync(fd);
			}
			sync.renameSync(replacement, transcript);
			confirmOwnerFirstWriteMarkerSync(token, marker, () => sync.readFileSync(transcript, "utf8") === bytes);
			expect(ownerFirstWriteMarkerSync(token)).toBeUndefined();
		});
		withOwnerPublicationSync(token, () => expect(ownerFirstWriteMarkerSync(token)).toBeUndefined());
	});

	it("admits descriptor-verified pre-graph cooperative history without native migration authority", async () => {
		const legacy = `${JSON.stringify({ type: "session", id: header.id, cwd: dir })}\n${JSON.stringify({ type: "message", timestamp: "2025-01-01T00:00:00.000Z", message: { role: "user", content: "legacy" } })}\n`;
		await Bun.write(transcript, legacy);
		target = captureOwnerTargetSync({ transcriptPath: transcript, headerId: header.id });
		const input = { agentDir: path.join(dir, "agent"), cwd: dir };
		const inspectors = createCooperativeOwnerInspectors(input);
		expect(inspectors.readMarkers(target).kind).toBe("absent");
		expect((await createNativeOwnerInspectors(input).readMarkers(target)).kind).toBe("unknown");
		const token = admitOwnerMembershipSync(target, cooperative, { ...options, ...inspectors });
		expect(getOwnerMembershipEvidence(token).policy.kind).toBe("cooperative");
		expect(await Bun.file(transcript).text()).toBe(legacy);
		await Bun.write(
			transcript,
			`${legacy}${JSON.stringify({ type: "custom", customType: "gjc.owner_enroll", data: { v: 1 } })}\n`,
		);
		const changed = captureOwnerTargetSync({ transcriptPath: transcript, headerId: header.id });
		expect(inspectors.readMarkers(changed).kind).toBe("unknown");
		expect(inspectors.readMarkers(target).kind).toBe("unknown");
	});

	it("generation-zero direct registration permits self admission but keeps native and endpoint vetoes", async () => {
		const agentDir = path.join(dir, "agent");
		await fs.mkdir(agentDir);
		const own = observeProcessIncarnation(process.pid);
		if (own.status !== "present") throw new Error("Expected exact live process identity");
		await new SessionIndex(agentDir).append({
			type: "host_registered",
			sessionId: header.id,
			locator: { cwd: dir, worktreeRoot: null, stateRoot: agentDir },
			endpointGeneration: 0,
			pid: process.pid,
			processIncarnation: own.incarnation,
		});
		const inspectors = createCooperativeOwnerInspectors({ agentDir, cwd: dir });
		expect(inspectors.inspectVetoes(target).kind).toBe("clear");
		expect((await createNativeOwnerInspectors({ agentDir, cwd: dir }).inspectVetoes(target)).kind).toBe(
			"unknown_ownership",
		);
		const token = admitOwnerMembershipSync(target, cooperative, { ...options, ...inspectors });
		expect(getOwnerMembershipEvidence(token).memberKind).toBe("cooperative");
		await Bun.write(path.join(agentDir, "sdk", `${header.id}.json`), "{malformed");
		expect(inspectors.inspectVetoes(target).kind).toBe("unknown_ownership");
	});

	async function directEndpointFixture() {
		const agentDir = path.join(dir, "agent");
		await fs.mkdir(agentDir);
		const own = observeProcessIncarnation(process.pid);
		if (own.status !== "present") throw new Error("Expected exact live process identity");
		const index = new SessionIndex(agentDir);
		await index.append({
			type: "host_registered",
			sessionId: header.id,
			locator: { cwd: dir, worktreeRoot: null, stateRoot: agentDir },
			endpointGeneration: 0,
			pid: process.pid,
			processIncarnation: own.incarnation,
			hostIncarnation: own.incarnation,
		});
		return {
			agentDir,
			index,
			own,
			inspectors: createCooperativeOwnerInspectors({ agentDir, cwd: dir }),
			endpointFile: path.join(dir, ".gjc", "state", "sdk", `${header.id}.json`),
			endpoint: { sessionId: header.id, pid: process.pid, version: 1 },
		};
	}

	async function endpointTransitionFixture(peerPid: number) {
		const agentDir = path.join(dir, "agent");
		await fs.mkdir(agentDir);
		const own = observeProcessIncarnation(process.pid);
		const peer = observeProcessIncarnation(peerPid);
		if (own.status !== "present" || peer.status !== "present") throw new Error("Expected exact live members");
		admitOwnerMembershipSync(target, cooperative, options);
		const initial = await record();
		await seed({
			...initial,
			members: [
				...initial.members,
				{
					...initial.members[0]!,
					memberId: randomBytes(16).toString("hex"),
					pid: peerPid,
					processIncarnation: peer.incarnation,
				},
			],
		});
		const inspectors = createCooperativeOwnerInspectors({ agentDir, cwd: dir });
		const token = admitOwnerMembershipSync(target, cooperative, { ...options, ...inspectors });
		const group = await record();
		const index = new SessionIndex(agentDir);
		const endpointFile = path.join(agentDir, "sdk", `${header.id}.json`);
		const endpoint = { sessionId: header.id, pid: peerPid, version: 1 };
		await Bun.write(endpointFile, JSON.stringify({ ...endpoint, pid: process.pid }));
		const oldStat = await fs.stat(endpointFile, { bigint: true });
		const indexed = {
			type: "host_registered" as const,
			sessionId: header.id,
			locator: { cwd: dir, worktreeRoot: null, stateRoot: agentDir },
			endpointGeneration: 1,
			pid: process.pid,
			endpointFileId: `${oldStat.dev}:${oldStat.ino}`,
			endpointMtimeMs: Number(oldStat.mtimeNs) / 1_000_000,
		};
		// Match default session-runtime registration: no processIncarnation; append derives hostIncarnation.
		const published = await index.append(indexed);
		expect(published.processIncarnation).toBeUndefined();
		expect(published.hostIncarnation).toBe(own.incarnation);
		await Bun.write(`${endpointFile}.replacement`, JSON.stringify(endpoint));
		await fs.rename(`${endpointFile}.replacement`, endpointFile);
		const stat = await fs.stat(endpointFile, { bigint: true });
		expect(stat.ino).not.toBe(oldStat.ino);
		return { agentDir, own, peer, inspectors, token, group, index, indexed, endpointFile, endpoint, stat };
	}

	it("proves a host-only indexed A to already-cooperative endpoint B transition without changing its epoch", async () => {
		const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60000)"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		try {
			const { agentDir, inspectors, token, group, own, peer } = await endpointTransitionFixture(child.pid);
			const observed = SessionIndex.readAuthorityRootsReadOnlySync(agentDir, header.id);
			expect(observed.kind).toBe("resolved");
			if (observed.kind !== "resolved") throw new Error("Expected healthy index");
			expect(observed.identities).toHaveLength(1);
			expect(observed.identities[0]!.processIncarnation).toBeUndefined();
			expect(observed.identities[0]!.hostIncarnation).toBe(own.incarnation);
			expect(inspectors.inspectVetoes(target).kind).toBe("clear");
			const hostId = ownerHostIdSync();
			if (!hostId) throw new Error("Expected positively identified local host");
			const open = spyOn(sync, "openSync");
			try {
				expect(
					captureLiveCooperativeOwnerProcessesSync(target, [
						{ pid: process.pid, processIncarnation: own.incarnation },
						{ pid: child.pid, processIncarnation: peer.incarnation },
					]),
				).toEqual({ authorityKey: target.authorityKey, epoch: group.epoch, hostId });
				expect(open.mock.calls.filter(([file]) => file === target.authorityKey)).toHaveLength(1);
			} finally {
				open.mockRestore();
			}
			expect(isLiveCooperativeOwnerProcessSync(target, child.pid, peer.incarnation)).toBe(true);
			let calls = 0;
			await expect(withCooperativeOwnerPublication(token, async () => ++calls)).resolves.toBe(1);
			const joined = admitOwnerMembershipSync(target, cooperative, { ...options, ...inspectors });
			expect(getOwnerMembershipEvidence(joined).epoch).toBe(group.epoch);
			expect(recheckOwnerAdmissionSync(joined).epoch).toBe(group.epoch);
			await expect(withCooperativeOwnerPublication(token, async () => ++calls)).resolves.toBe(2);
			expect((await record()).epoch).toBe(group.epoch);
			expect((await createNativeOwnerInspectors({ agentDir, cwd: dir }).inspectVetoes(target)).kind).toBe(
				"unknown_ownership",
			);
		} finally {
			child.kill();
			await child.exited;
		}
	});

	it.each([
		false,
		true,
	])("checks every duplicate-path indexed claim independent of order (reverse=%s)", async reverse => {
		const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60000)"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		try {
			const { inspectors, index, indexed, own, peer, stat } = await endpointTransitionFixture(child.pid);
			const claims = [
				{ ...indexed, processIncarnation: own.incarnation, hostIncarnation: own.incarnation },
				{
					...indexed,
					pid: child.pid,
					processIncarnation: peer.incarnation,
					endpointFileId: `${stat.dev}:${stat.ino}`,
					endpointMtimeMs: Number(stat.mtimeNs) / 1_000_000,
				},
			];
			if (reverse) claims.reverse();
			for (let offset = 0; offset < claims.length; offset++)
				await index.append({ ...claims[offset]!, endpointGeneration: offset + 2 });
			expect(inspectors.inspectVetoes(target).kind).toBe("clear");
		} finally {
			child.kill();
			await child.exited;
		}
	});

	it.each([
		false,
		true,
	])("never overwrites a foreign duplicate-path claim with a good one (reverse=%s)", async reverse => {
		const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60000)"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		try {
			const { inspectors, index, indexed, own, peer, group } = await endpointTransitionFixture(child.pid);
			await seed({ ...group, members: group.members.filter(member => member.pid !== process.pid) });
			const claims = [
				{ ...indexed, processIncarnation: own.incarnation, hostIncarnation: own.incarnation },
				{ ...indexed, pid: child.pid, processIncarnation: peer.incarnation, hostIncarnation: peer.incarnation },
			];
			if (reverse) claims.reverse();
			const stat = await fs.stat(path.join(indexed.locator.stateRoot, "sdk", `${header.id}.json`), { bigint: true });
			for (let offset = 0; offset < claims.length; offset++)
				await index.append({
					...claims[offset]!,
					endpointGeneration: offset + 2,
					endpointFileId: `${stat.dev}:${stat.ino}`,
					endpointMtimeMs: Number(stat.mtimeNs) / 1_000_000,
				});
			expect(inspectors.inspectVetoes(target).kind).toBe("unknown_ownership");
		} finally {
			child.kill();
			await child.exited;
		}
	});

	it.each([
		"opaque_host",
		"opaque_host_with_process",
		"opaque_process",
		"contradictory_process",
		"wrong_host_incarnation",
		"foreign_indexed_host",
		"foreign_actual_host",
		"unregistered_indexed",
		"unregistered_actual",
		"reused_indexed_pid",
		"reused_actual_pid",
	] as const)("refuses an unproved cooperative endpoint transition (%s)", async mismatch => {
		const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60000)"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		try {
			const { inspectors, index, indexed, own, group, token } = await endpointTransitionFixture(child.pid);
			if (
				mismatch === "opaque_host" ||
				mismatch === "opaque_host_with_process" ||
				mismatch === "opaque_process" ||
				mismatch === "contradictory_process" ||
				mismatch === "wrong_host_incarnation"
			) {
				await index.append({
					...indexed,
					endpointGeneration: 2,
					processIncarnation:
						mismatch === "opaque_process"
							? digest("opaque-process")
							: mismatch === "opaque_host_with_process"
								? own.incarnation
								: mismatch === "contradictory_process"
									? previousIncarnation(own.incarnation)
									: undefined,
					hostIncarnation:
						mismatch === "opaque_host" || mismatch === "opaque_host_with_process"
							? digest("opaque-host")
							: mismatch === "wrong_host_incarnation"
								? previousIncarnation(own.incarnation)
								: own.incarnation,
				});
			} else {
				const indexedMismatch =
					mismatch === "foreign_indexed_host" ||
					mismatch === "unregistered_indexed" ||
					mismatch === "reused_indexed_pid";
				const pid = indexedMismatch ? process.pid : child.pid;
				await seed({
					...group,
					members: group.members.flatMap(member => {
						if (member.pid !== pid) return [member];
						if (mismatch.startsWith("unregistered")) return [];
						return [
							{
								...member,
								...(mismatch === "foreign_indexed_host" || mismatch === "foreign_actual_host"
									? { hostId: digest("foreign-host") }
									: { processIncarnation: previousIncarnation(member.processIncarnation) }),
							},
						];
					}),
				});
			}
			expect(inspectors.inspectVetoes(target).kind).toBe("unknown_ownership");
			if (mismatch === "unregistered_actual") {
				let calls = 0;
				await expect(withCooperativeOwnerPublication(token, async () => ++calls)).rejects.toMatchObject({
					code: "unknown_ownership",
				});
				expect(calls).toBe(0);
			}
		} finally {
			child.kill();
			await child.exited;
		}
	});

	it("keeps malformed and additional foreign candidate vetoes after a proved transition", async () => {
		const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60000)"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		try {
			const { agentDir, inspectors, endpointFile, endpoint } = await endpointTransitionFixture(child.pid);
			for (const source of [
				"{malformed",
				"[]",
				JSON.stringify({ ...endpoint, version: 2 }),
				JSON.stringify({ ...endpoint, sessionId: "foreign" }),
			]) {
				await Bun.write(endpointFile, source);
				expect(inspectors.inspectVetoes(target).kind).toBe("unknown_ownership");
				expect((await createNativeOwnerInspectors({ agentDir, cwd: dir }).inspectVetoes(target)).kind).toBe(
					"unknown_ownership",
				);
			}
			await Bun.write(endpointFile, JSON.stringify(endpoint));
			expect(inspectors.inspectVetoes(target).kind).toBe("clear");
			await Bun.write(
				path.join(dir, ".gjc", "state", "chat", "sdk", `${header.id}.json`),
				JSON.stringify({ ...endpoint, pid: process.ppid }),
			);
			expect(inspectors.inspectVetoes(target).kind).toBe("unknown_ownership");
		} finally {
			child.kill();
			await child.exited;
		}
	});

	it("retains generation-zero claims in actual endpoint proof without inventing an absent file binding", async () => {
		const { agentDir, index, inspectors, own, endpoint } = await directEndpointFixture();
		admitOwnerMembershipSync(target, cooperative, { ...options, ...inspectors });
		const endpointFile = path.join(agentDir, "sdk", `${header.id}.json`);
		await Bun.write(endpointFile, JSON.stringify(endpoint));
		expect(inspectors.inspectVetoes(target).kind).toBe("clear");
		const stat = await fs.stat(endpointFile, { bigint: true });
		await index.append({
			type: "host_registered",
			sessionId: header.id,
			locator: { cwd: dir, worktreeRoot: null, stateRoot: agentDir },
			endpointGeneration: 1,
			pid: process.pid,
			endpointFileId: `${stat.dev}:${stat.ino}`,
			endpointMtimeMs: Number(stat.mtimeNs) / 1_000_000,
		});
		expect(inspectors.inspectVetoes(target).kind).toBe("clear");
		const original = await record();
		await seed({
			...original,
			members: original.members.map(member => ({
				...member,
				processIncarnation: previousIncarnation(own.incarnation),
			})),
		});
		expect(inspectors.inspectVetoes(target).kind).toBe("unknown_ownership");
	});

	it("keeps the cooperative epoch through a real generation-zero endpoint publication, join and refresh", async () => {
		const { agentDir, inspectors, endpointFile, endpoint } = await directEndpointFixture();
		const before = inspectors.inspectVetoes(target);
		expect(before.kind).toBe("clear");
		const first = admitOwnerMembershipSync(target, cooperative, { ...options, ...inspectors });
		const original = await record();
		await Bun.write(endpointFile, JSON.stringify(endpoint));
		const after = inspectors.inspectVetoes(target);
		expect(after.kind).toBe("clear");
		expect(after.digest).not.toBe(before.digest);
		expect((await createNativeOwnerInspectors({ agentDir, cwd: dir }).inspectVetoes(target)).kind).toBe(
			"unknown_ownership",
		);
		let calls = 0;
		await expect(withCooperativeOwnerPublication(first, async () => ++calls)).resolves.toBe(1);
		expect(await record()).toEqual(original);
		const second = await admitOwnerMembership(target, cooperative, { ...options, ...inspectors });
		expect(getOwnerMembershipEvidence(second).epoch).toBe(original.epoch);
		await expect(withOwnerPublication(first, async () => ++calls)).rejects.toMatchObject({
			code: "participation_lost",
		});
		await expect(withCooperativeOwnerPublication(first, async () => ++calls)).resolves.toBe(2);
		expect(calls).toBe(2);
		expect(getOwnerMembershipEvidence(first).rev).toBe(getOwnerMembershipEvidence(second).rev);
		expect((await record()).epoch).toBe(original.epoch);
		expect((await record()).members).toHaveLength(2);
	});

	it("does not infer cooperative membership from an actual own-PID endpoint", async () => {
		const { inspectors, endpointFile, endpoint } = await directEndpointFixture();
		await Bun.write(endpointFile, JSON.stringify(endpoint));
		expect(inspectors.inspectVetoes(target).kind).toBe("unknown_ownership");
		code(() => admitOwnerMembershipSync(target, cooperative, { ...options, ...inspectors }), "unknown_ownership");
		expect(await Bun.file(target.authorityKey).exists()).toBe(false);
	});

	it("requires exact member incarnation and local host proof for an actual endpoint", async () => {
		const { inspectors, endpointFile, endpoint, own } = await directEndpointFixture();
		admitOwnerMembershipSync(target, cooperative, { ...options, ...inspectors });
		await Bun.write(endpointFile, JSON.stringify(endpoint));
		const original = await record();
		for (const mismatch of [
			{ processIncarnation: previousIncarnation(own.incarnation) },
			{ hostId: digest("foreign-host") },
		]) {
			await seed({ ...original, members: original.members.map(member => ({ ...member, ...mismatch })) });
			expect(inspectors.inspectVetoes(target).kind).toBe("unknown_ownership");
		}
		await seed(original);
		expect(inspectors.inspectVetoes(target).kind).toBe("clear");
	});

	it("validates actual member endpoint bytes, header, version and descriptor before recognition", async () => {
		const { inspectors, endpointFile, endpoint } = await directEndpointFixture();
		admitOwnerMembershipSync(target, cooperative, { ...options, ...inspectors });
		for (const source of [
			"{malformed",
			"[]",
			JSON.stringify({ ...endpoint, sessionId: "another-session" }),
			JSON.stringify({ ...endpoint, version: 2 }),
			JSON.stringify({ ...endpoint, pid: 0 }),
			new Uint8Array([0xff]),
		]) {
			await Bun.write(endpointFile, source);
			expect(inspectors.inspectVetoes(target).kind).toBe("unknown_ownership");
		}
		await fs.unlink(endpointFile);
		await fs.symlink(transcript, endpointFile);
		expect(inspectors.inspectVetoes(target).kind).toBe("unknown_ownership");
		await fs.unlink(endpointFile);
		await fs.mkdir(endpointFile);
		expect(inspectors.inspectVetoes(target).kind).toBe("unknown_ownership");
	});

	it.each([
		"none",
		"pid",
		"incarnation",
		"file",
		"mtime",
	] as const)("requires consistent indexed bindings before recognizing a member endpoint (%s)", async mismatch => {
		const { agentDir, index, own, inspectors, endpoint } = await directEndpointFixture();
		admitOwnerMembershipSync(target, cooperative, { ...options, ...inspectors });
		const endpointFile = path.join(agentDir, "sdk", `${header.id}.json`);
		await Bun.write(endpointFile, JSON.stringify(endpoint));
		const stat = await fs.stat(endpointFile, { bigint: true });
		await index.append({
			type: "host_registered",
			sessionId: header.id,
			locator: { cwd: dir, worktreeRoot: null, stateRoot: agentDir },
			endpointGeneration: 1,
			pid: mismatch === "pid" ? process.ppid : process.pid,
			processIncarnation: mismatch === "incarnation" ? previousIncarnation(own.incarnation) : own.incarnation,
			hostIncarnation: own.incarnation,
			endpointFileId: `${stat.dev}:${mismatch === "file" ? stat.ino + 1n : stat.ino}`,
			endpointMtimeMs: Number(stat.mtimeNs) / 1_000_000 + (mismatch === "mtime" ? 1000 : 0),
		});
		expect(inspectors.inspectVetoes(target).kind).toBe(mismatch === "none" ? "clear" : "unknown_ownership");
		if (mismatch === "none")
			expect((await createNativeOwnerInspectors({ agentDir, cwd: dir }).inspectVetoes(target)).kind).toBe(
				"owned_by_other",
			);
	});

	it("keeps an exact live cooperative member authoritative after its indexed transport withdraws", async () => {
		const { agentDir, index, own, inspectors, endpoint } = await directEndpointFixture();
		const token = admitOwnerMembershipSync(target, cooperative, { ...options, ...inspectors });
		const file = path.join(agentDir, "sdk", `${header.id}.json`);
		await Bun.write(file, JSON.stringify(endpoint));
		const stat = await fs.stat(file, { bigint: true });
		await index.append({
			type: "host_registered",
			sessionId: header.id,
			locator: { cwd: dir, worktreeRoot: null, stateRoot: agentDir },
			endpointGeneration: 1,
			pid: process.pid,
			processIncarnation: own.incarnation,
			hostIncarnation: own.incarnation,
			endpointFileId: `${stat.dev}:${stat.ino}`,
			endpointMtimeMs: Number(stat.mtimeNs) / 1_000_000,
		});
		await fs.unlink(file);
		expect(inspectors.inspectVetoes(target).kind).toBe("clear");
		expect((await createNativeOwnerInspectors({ agentDir, cwd: dir }).inspectVetoes(target)).kind).toBe(
			"unknown_ownership",
		);
		const epoch = getOwnerMembershipEvidence(token).epoch;
		await expect(withCooperativeOwnerPublication(token, async () => "final-drain")).resolves.toBe("final-drain");
		expect(getOwnerMembershipEvidence(token).epoch).toBe(epoch);
		const current = await record();
		await seed({ ...current, members: [] });
		expect(inspectors.inspectVetoes(target).kind).toBe("unknown_ownership");
	});

	it("scans foreign endpoints after recognizing an adjacent cooperative member endpoint", async () => {
		const { inspectors, endpointFile, endpoint } = await directEndpointFixture();
		const first = admitOwnerMembershipSync(target, cooperative, { ...options, ...inspectors });
		await Bun.write(endpointFile, JSON.stringify(endpoint));
		expect(inspectors.inspectVetoes(target).kind).toBe("clear");
		const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60000)"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		try {
			const peer = observeProcessIncarnation(child.pid);
			if (peer.status !== "present") throw new Error("Expected exact live foreign process identity");
			await Bun.write(
				path.join(dir, ".gjc", "state", "chat", "sdk", `${header.id}.json`),
				JSON.stringify({ ...endpoint, pid: child.pid }),
			);
			expect(inspectors.inspectVetoes(target).kind).toBe("unknown_ownership");
			let calls = 0;
			await expect(withCooperativeOwnerPublication(first, async () => ++calls)).rejects.toMatchObject({
				code: "unknown_ownership",
			});
			expect(calls).toBe(0);
		} finally {
			child.kill();
			await child.exited;
		}
	});

	it("a live direct peer requires exact adjacent cooperative membership and local host proof", async () => {
		const agentDir = path.join(dir, "agent");
		await fs.mkdir(agentDir);
		const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60000)"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		try {
			const peer = observeProcessIncarnation(child.pid);
			if (peer.status !== "present") throw new Error("Expected exact live peer identity");
			await new SessionIndex(agentDir).append({
				type: "host_registered",
				sessionId: header.id,
				locator: { cwd: dir, worktreeRoot: null, stateRoot: agentDir },
				endpointGeneration: 0,
				pid: child.pid,
				processIncarnation: peer.incarnation,
				hostIncarnation: peer.incarnation,
			});
			const inspectors = createCooperativeOwnerInspectors({ agentDir, cwd: dir });
			expect(inspectors.inspectVetoes(target).kind).toBe("unknown_ownership");
			admitOwnerMembershipSync(target, cooperative, options);
			const original = await record();
			const member = { ...original.members[0]!, pid: child.pid, processIncarnation: peer.incarnation };
			await seed({ ...original, members: [member] });
			expect(inspectors.inspectVetoes(target).kind).toBe("clear");
			await Bun.write(
				path.join(dir, ".gjc", "state", "sdk", `${header.id}.json`),
				JSON.stringify({ sessionId: header.id, pid: child.pid, version: 1 }),
			);
			expect(inspectors.inspectVetoes(target).kind).toBe("clear");
			const joined = admitOwnerMembershipSync(target, cooperative, { ...options, ...inspectors });
			expect(getOwnerMembershipEvidence(joined).epoch).toBe(original.epoch);
			expect((await record()).members).toHaveLength(2);
			let calls = 0;
			await expect(withCooperativeOwnerPublication(joined, async () => ++calls)).resolves.toBe(1);
			expect(calls).toBe(1);
			const live = await record();
			await seed({
				...live,
				members: live.members.map(value =>
					value.pid === child.pid ? { ...value, hostId: digest("foreign-host") } : value,
				),
			});
			expect(inspectors.inspectVetoes(target).kind).toBe("unknown_ownership");
		} finally {
			child.kill();
			await child.exited;
		}
	});

	it("async cooperative admission and revision refresh wait for authority without taking a transcript lease", async () => {
		const first = admitOwnerMembershipSync(target, cooperative, options);
		const held = new FileSessionStorage().acquireExclusiveLockSync(`${target.authorityKey}.lock`, {
			ownerHostId: ownerHostIdSync()!,
		})!;
		let admitted = false;
		const admission = admitOwnerMembership(target, cooperative, options).then(token => {
			admitted = true;
			return token;
		});
		const competingAdmission = admitOwnerMembership(target, cooperative, options);
		try {
			await Bun.sleep(20);
			expect(admitted).toBe(false);
		} finally {
			held.releaseSync();
		}
		const [second, third] = await Promise.all([admission, competingAdmission]);
		expect(getOwnerMembershipEvidence(first).epoch).toBe(getOwnerMembershipEvidence(second).epoch);
		expect(getOwnerMembershipEvidence(third).epoch).toBe(getOwnerMembershipEvidence(first).epoch);
		expect((await revalidateOwnerMembership(first)).rev).toBe((await record()).rev);
		expect((await record()).members).toHaveLength(3);
		const blocked = new FileSessionStorage().acquireExclusiveLockSync(`${target.authorityKey}.lock`, {
			ownerHostId: ownerHostIdSync()!,
		})!;
		try {
			await expect(admitOwnerMembership(target, cooperative, options, 0)).rejects.toMatchObject({
				code: "authority_busy",
			});
			await expect(revalidateOwnerMembership(first, 0)).rejects.toMatchObject({ code: "authority_busy" });
		} finally {
			blocked.releaseSync();
		}
		expect((await record()).members).toHaveLength(3);
	});

	it("cooperative publication refreshes a joined revision under authority while strict publication stays exact", async () => {
		const first = admitOwnerMembershipSync(target, cooperative, options);
		const second = admitOwnerMembershipSync(target, cooperative, options);
		let calls = 0;
		await expect(withOwnerPublication(first, async () => ++calls)).rejects.toMatchObject({
			code: "participation_lost",
		});
		await expect(withCooperativeOwnerPublication(first, async () => ++calls)).resolves.toBe(1);
		expect(getOwnerMembershipEvidence(first).rev).toBe(getOwnerMembershipEvidence(second).rev);
		veto = { kind: "unknown_ownership", digest: digest("new unknown fence"), evidence: [] };
		await expect(withCooperativeOwnerPublication(first, async () => ++calls)).rejects.toMatchObject({
			code: "unknown_ownership",
		});
		expect(calls).toBe(1);
		veto = clear;
		const live = await record();
		await seed({ ...live, epoch: randomBytes(16).toString("hex") });
		await expect(withCooperativeOwnerPublication(first, async () => ++calls)).rejects.toMatchObject({
			code: "participation_lost",
		});
		expect(calls).toBe(1);
	});

	it("async publication waits for the same host-qualified real-file lock without retrying the body", async () => {
		const token = admitOwnerMembershipSync(target, cooperative, options);
		const held = new FileSessionStorage().acquireExclusiveLockSync(`${target.authorityKey}.lock`, {
			ownerHostId: ownerHostIdSync()!,
		})!;
		let calls = 0;
		const publication = withOwnerPublication(token, async () => ++calls);
		try {
			await Bun.sleep(20);
			expect(calls).toBe(0);
			expect(await Bun.file(`${target.authorityKey}.lock`).json()).toMatchObject({ hostId: ownerHostIdSync() });
		} finally {
			held.releaseSync();
		}
		await expect(publication).resolves.toBe(1);
		expect(calls).toBe(1);
		expect(await Bun.file(`${target.authorityKey}.lock`).exists()).toBe(false);
	});

	it("async authority contention is bounded and never enters the body", async () => {
		const token = admitOwnerMembershipSync(target, cooperative, options);
		const held = new FileSessionStorage().acquireExclusiveLockSync(`${target.authorityKey}.lock`, {
			ownerHostId: ownerHostIdSync()!,
		})!;
		let calls = 0;
		try {
			await expect(withOwnerPublication(token, async () => ++calls)).rejects.toMatchObject({
				code: "authority_busy",
			});
			expect(calls).toBe(0);
		} finally {
			held.releaseSync();
		}
		await expect(withOwnerPublication(token, async () => ++calls)).resolves.toBe(1);
	});

	it("authority spans awaited managed acquisition, transcript lease, body and managed release", async () => {
		const token = admitOwnerMembershipSync(target, cooperative, options);
		const locksDirectory = path.join(dir, "managed-locks");
		await fs.mkdir(locksDirectory, { mode: 0o700 });
		const managedHeld = Promise.withResolvers<void>();
		const releaseManaged = Promise.withResolvers<void>();
		const blocker = withManagedSessionTransaction({ locksDirectory, sessionId: header.id }, async () => {
			managedHeld.resolve();
			await releaseManaged.promise;
		});
		await managedHeld.promise;
		const acquiring = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const releaseBody = Promise.withResolvers<void>();
		const storage = new FileSessionStorage();
		const publication = withOwnerPublication(token, async () => {
			acquiring.resolve();
			return withManagedSessionTransaction({ locksDirectory, sessionId: header.id }, async scope => {
				scope.assertOwned();
				const lease = storage.acquireExclusiveLockSync(`${transcript}.test-lease`)!;
				try {
					entered.resolve();
					await releaseBody.promise;
					scope.assertOwned();
					return "published";
				} finally {
					lease.releaseSync();
				}
			});
		});
		try {
			await acquiring.promise;
			expect(
				storage.acquireExclusiveLockSync(`${target.authorityKey}.lock`, { ownerHostId: ownerHostIdSync()! }),
			).toBeUndefined();
			code(() => retireOwnerMembershipSync(token), "authority_busy");
			releaseManaged.resolve();
			await blocker;
			await entered.promise;
			expect(await Bun.file(`${transcript}.test-lease`).exists()).toBe(true);
			expect(
				storage.acquireExclusiveLockSync(`${target.authorityKey}.lock`, { ownerHostId: ownerHostIdSync()! }),
			).toBeUndefined();
		} finally {
			releaseManaged.resolve();
			releaseBody.resolve();
		}
		await expect(publication).resolves.toBe("published");
		expect(await Bun.file(`${transcript}.test-lease`).exists()).toBe(false);
		await expect(
			withManagedSessionTransaction({ locksDirectory, sessionId: header.id, waitMs: 0 }, async () => "released"),
		).resolves.toBe("released");
		expect(await Bun.file(`${target.authorityKey}.lock`).exists()).toBe(false);
	});

	it("hot sync and async publication do not rescan transcript, markers or vetoes", async () => {
		let scans = 0;
		const token = admitOwnerMembershipSync(target, cooperative, {
			...options,
			inspectVetoes: () => {
				scans++;
				return veto;
			},
			readMarkers: () => {
				scans++;
				return markers;
			},
		});
		const admittedScans = scans;
		veto = { kind: "owned_by_other", digest: digest("changed veto"), evidence: [] };
		markers = { ...markers, kind: "unknown" };
		await Bun.write(transcript, "managed publication must validate its own transcript lease\n");
		expect(withOwnerPublicationSync(token, () => "sync")).toBe("sync");
		await expect(
			withOwnerPublication(token, async () => {
				await Bun.sleep(0);
				return "async";
			}),
		).resolves.toBe("async");
		expect(scans).toBe(admittedScans);
		code(() => recheckOwnerAdmissionSync(token), "owned_by_other");
	});

	it("async publication fences exact rev, member, mode and epoch before and after await", async () => {
		const token = admitOwnerMembershipSync(target, cooperative, options);
		const original = await record();
		let calls = 0;
		for (const replacement of [
			{ ...original, rev: original.rev + 1 },
			{ ...original, members: original.members.map(member => ({ ...member, runtime: "successor-runtime" })) },
			{ ...original, mode: "exclusive_native" as const },
			{ ...original, epoch: randomBytes(16).toString("hex") },
		]) {
			await seed(replacement);
			await expect(withOwnerPublication(token, async () => ++calls)).rejects.toMatchObject({
				code: "participation_lost",
			});
			expect(calls).toBe(0);
			await seed(original);
			await expect(
				withOwnerPublication(token, async () => {
					await seed(replacement);
					return "late";
				}),
			).rejects.toMatchObject({ code: "participation_lost" });
			expect(await record()).toEqual(replacement);
		}
	});

	it("async publication rejects root replacement after await without touching the retained authority", async () => {
		const token = admitOwnerMembershipSync(target, cooperative, options);
		const original = await Bun.file(target.authorityKey).text();
		const retained = `${dir}-retained`;
		try {
			await expect(
				withOwnerPublication(token, async () => {
					await fs.rename(dir, retained);
					await fs.mkdir(dir, { mode: 0o700 });
					await Bun.write(transcript, `${JSON.stringify(header)}\n`);
				}),
			).rejects.toMatchObject({ code: "authority_changed" });
			expect(await Bun.file(path.join(retained, ".gjc-owners", "header-1.json")).text()).toBe(original);
			expect(await Bun.file(target.authorityKey).exists()).toBe(false);
		} finally {
			await fs.rm(retained, { recursive: true, force: true });
		}
	});

	it("release uncertainty preserves body failure and never removes a successor lock generation", async () => {
		const token = admitOwnerMembershipSync(target, cooperative, options);
		const originalAcquire = FileSessionStorage.prototype.acquireExclusiveLockSync;
		const bodyError = new Error("body failure");
		const releaseError = new Error("release uncertainty");
		const acquire = spyOn(FileSessionStorage.prototype, "acquireExclusiveLockSync").mockImplementation(function (
			this: FileSessionStorage,
			lockPath,
			lockOptions,
		) {
			const lock = originalAcquire.call(this, lockPath, lockOptions);
			if (!lock || lockPath !== `${target.authorityKey}.lock`) return lock;
			return {
				releaseSync: () => {
					lock.releaseSync();
					throw releaseError;
				},
			};
		});
		try {
			const failure = await withOwnerPublication(token, async () => {
				throw bodyError;
			}).catch(error => error);
			expect(failure).toBeInstanceOf(AggregateError);
			expect(failure.errors).toEqual([bodyError, releaseError]);
			expect(await Bun.file(`${target.authorityKey}.lock`).exists()).toBe(false);
		} finally {
			acquire.mockRestore();
		}
		let successor: { releaseSync(): void } | undefined;
		try {
			await expect(
				withOwnerPublication(token, async () => {
					await fs.unlink(`${target.authorityKey}.lock`);
					successor = new FileSessionStorage().acquireExclusiveLockSync(`${target.authorityKey}.lock`, {
						ownerHostId: ownerHostIdSync()!,
					});
					expect(successor).toBeDefined();
					throw bodyError;
				}),
			).rejects.toBe(bodyError);
			expect(await Bun.file(`${target.authorityKey}.lock`).exists()).toBe(true);
		} finally {
			successor?.releaseSync();
		}
	});

	it("async native admission and hydration refresh independent evidence under authority", async () => {
		const previous = admitOwnerMembershipSync(target, cooperative, options);
		retireOwnerMembershipSync(previous);
		const storage = new FileSessionStorage();
		let vetoScans = 0;
		const asyncOptions = {
			runtime: options.runtime,
			capabilities: options.capabilities,
			inspectVetoes: async () => {
				if ([2, 4].includes(++vetoScans))
					expect(
						storage.acquireExclusiveLockSync(`${target.authorityKey}.lock`, { ownerHostId: ownerHostIdSync()! }),
					).toBeUndefined();
				await Bun.sleep(0);
				return veto;
			},
			readMarkers: async () => {
				await Bun.sleep(0);
				return markers;
			},
		};
		const token = await admitOwnerMembershipWithAsyncEvidence(target, exclusive(), asyncOptions);
		expect(vetoScans).toBe(2);
		expect((await recheckOwnerAdmissionWithAsyncEvidence(token)).memberKind).toBe("exclusive_native");
		expect(vetoScans).toBe(4);
		await expect(withOwnerPublication(token, async () => "hot")).resolves.toBe("hot");
		expect(vetoScans).toBe(4);
		veto = { kind: "owned_by_other", digest: digest("new veto"), evidence: [] };
		await expect(recheckOwnerAdmissionWithAsyncEvidence(token)).rejects.toMatchObject({ code: "owned_by_other" });
		expect((await probeSessionOwnershipWithAsyncEvidence(target, asyncOptions)).reason).toBe("owned_by_other");
	});

	it("async legacy proof is issued only for exact row-4 evidence and never bypasses markers or vetoes", async () => {
		const inspectors = { inspectVetoes: async () => veto, readMarkers: async () => markers };
		const attestation = await captureLegacyTakeoverAttestationWithAsyncEvidence(target, inspectors);
		expect(await Bun.file(path.dirname(target.authorityKey)).exists()).toBe(false);
		await expect(
			admitOwnerMembershipWithAsyncEvidence(
				target,
				{ ...exclusive(), legacyAttestation: { ...attestation } },
				{ ...options, ...inspectors },
			),
		).rejects.toMatchObject({ code: "legacy_attestation_required" });
		veto = { kind: "legacy_lifecycle_ambiguous", digest: digest("legacy ambiguous"), evidence: [] };
		await expect(captureLegacyTakeoverAttestationWithAsyncEvidence(target, inspectors)).rejects.toMatchObject({
			code: "legacy_lifecycle_ambiguous",
		});
		veto = clear;
		markers = { ...markers, kind: "present", members: [] };
		await expect(captureLegacyTakeoverAttestationWithAsyncEvidence(target, inspectors)).rejects.toMatchObject({
			code: "authority_lost_unresolved",
		});
		await expect(
			admitOwnerMembershipWithAsyncEvidence(
				target,
				{ ...exclusive(), legacyAttestation: attestation },
				{ ...options, ...inspectors },
			),
		).rejects.toMatchObject({ code: "authority_lost_unresolved" });
		markers = { ...markers, kind: "absent" };
		const token = await admitOwnerMembershipWithAsyncEvidence(
			target,
			{ ...exclusive(), legacyAttestation: attestation },
			{ ...options, ...inspectors },
		);
		expect(getOwnerMembershipEvidence(token).memberKind).toBe("exclusive_native");
	});

	it("changed async same-lock evidence refuses before registering a native member", async () => {
		const previous = admitOwnerMembershipSync(target, cooperative, options);
		retireOwnerMembershipSync(previous);
		const bytes = await Bun.file(target.authorityKey).text();
		let calls = 0;
		await expect(
			admitOwnerMembershipWithAsyncEvidence(target, exclusive(), {
				runtime: options.runtime,
				capabilities: options.capabilities,
				inspectVetoes: async () => ({ ...clear, digest: digest(String(++calls)) }),
				readMarkers: async () => markers,
			}),
		).rejects.toMatchObject({ code: "authority_changed" });
		expect(await Bun.file(target.authorityKey).text()).toBe(bytes);
	});

	it("async deletion refuses live cooperative, native and unknown members without entering deletion", async () => {
		let calls = 0;
		const inspectors = { inspectVetoes: async () => veto, readMarkers: async () => markers };
		const remove = async () => ({ deleted: true as const, value: ++calls });
		const cooperativeToken = admitOwnerMembershipSync(target, cooperative, options);
		await expect(deleteWithOwnerCheck(target, inspectors, remove)).rejects.toMatchObject({ code: "owned_by_other" });
		const live = await record();
		await seed({ ...live, members: live.members.map(member => ({ ...member, hostId: digest("foreign host") })) });
		await expect(deleteWithOwnerCheck(target, inspectors, remove)).rejects.toMatchObject({
			code: "unknown_ownership",
		});
		await seed(live);
		retireOwnerMembershipSync(cooperativeToken);
		const nativeToken = admitOwnerMembershipSync(target, exclusive(), options);
		await expect(deleteWithOwnerCheck(target, inspectors, remove)).rejects.toMatchObject({ code: "owned_by_other" });
		retireOwnerMembershipSync(nativeToken);
		expect(calls).toBe(0);
		expect(await Bun.file(transcript).exists()).toBe(true);
	});

	it("async deletion holds authority through actual transcript, spill and artifact deletion", async () => {
		const token = admitOwnerMembershipSync(target, cooperative, options);
		retireOwnerMembershipSync(token);
		const artifactDirectory = transcript.slice(0, -6);
		const spill = `${transcript}.spill.idx`;
		await Bun.write(spill, "derived index");
		await fs.mkdir(artifactDirectory);
		await Bun.write(path.join(artifactDirectory, "attachment.txt"), "artifact");
		const storage = new FileSessionStorage();
		const deletedTranscript = Promise.withResolvers<void>();
		const finishDelete = Promise.withResolvers<void>();
		const originalUnlink = storage.unlink;
		const unlink = spyOn(storage, "unlink").mockImplementation(async candidate => {
			await originalUnlink.call(storage, candidate);
			if (candidate === transcript) {
				deletedTranscript.resolve();
				await finishDelete.promise;
			}
		});
		let vetoScans = 0;
		let markerScans = 0;
		const deletion = deleteWithOwnerCheck(
			target,
			{
				inspectVetoes: async () => {
					if (++vetoScans === 2) expect(await Bun.file(`${target.authorityKey}.lock`).exists()).toBe(true);
					return veto;
				},
				readMarkers: async () => {
					if (++markerScans === 2) expect(await Bun.file(`${target.authorityKey}.lock`).exists()).toBe(true);
					return markers;
				},
			},
			async resolved => {
				await storage.deleteSessionWithArtifacts(resolved.transcriptPath);
				return { deleted: true, value: "deleted with artifacts" };
			},
		);
		try {
			await deletedTranscript.promise;
			expect(
				storage.acquireExclusiveLockSync(`${target.authorityKey}.lock`, { ownerHostId: ownerHostIdSync()! }),
			).toBeUndefined();
			expect((await record()).state).toBe("retired");
			expect((await fs.stat(artifactDirectory)).isDirectory()).toBe(true);
		} finally {
			finishDelete.resolve();
		}
		try {
			await expect(deletion).resolves.toBe("deleted with artifacts");
		} finally {
			unlink.mockRestore();
		}
		expect(vetoScans).toBe(2);
		expect(markerScans).toBe(2);
		expect(await Bun.file(transcript).exists()).toBe(false);
		await expect(fs.stat(artifactDirectory)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await Bun.file(spill).exists()).toBe(false);
		expect(await Bun.file(target.authorityKey).exists()).toBe(false);
		expect(await Bun.file(`${target.authorityKey}.lock`).exists()).toBe(false);
	});

	it("async deletion retains authority after physical deletion failure or an unverified success claim", async () => {
		const token = admitOwnerMembershipSync(target, cooperative, options);
		retireOwnerMembershipSync(token);
		const original = await Bun.file(target.authorityKey).text();
		const storage = new FileSessionStorage();
		const inspectors = { inspectVetoes: async () => veto, readMarkers: async () => markers };
		const failure = new Error("actual unlink failed");
		const unlink = spyOn(storage, "unlink").mockRejectedValue(failure);
		try {
			await expect(
				deleteWithOwnerCheck(target, inspectors, async resolved => {
					await storage.deleteSessionWithArtifacts(resolved.transcriptPath);
					return { deleted: true, value: 1 };
				}),
			).rejects.toBe(failure);
		} finally {
			unlink.mockRestore();
		}
		await expect(
			deleteWithOwnerCheck(target, inspectors, async () => ({ deleted: true, value: 1 })),
		).rejects.toMatchObject({ code: "unknown_ownership" });
		expect(await Bun.file(target.authorityKey).text()).toBe(original);
		expect(await Bun.file(transcript).exists()).toBe(true);
		const partialFailure = new Error("artifacts cleanup uncertain");
		await expect(
			deleteWithOwnerCheck(target, inspectors, async resolved => {
				await storage.unlink(resolved.transcriptPath);
				throw partialFailure;
			}),
		).rejects.toBe(partialFailure);
		expect(await Bun.file(target.authorityKey).text()).toBe(original);
		expect(await Bun.file(`${target.authorityKey}.lock`).exists()).toBe(false);
	});

	it("async delete rechecks physical identity after awaited evidence even for identical replacement bytes", async () => {
		const token = admitOwnerMembershipSync(target, cooperative, options);
		retireOwnerMembershipSync(token);
		const authority = await Bun.file(target.authorityKey).text();
		const bytes = await Bun.file(transcript).text();
		let scans = 0;
		let calls = 0;
		await expect(
			deleteWithOwnerCheck(
				target,
				{
					inspectVetoes: async () => veto,
					readMarkers: async () => {
						if (++scans === 2) {
							const replacement = path.join(dir, "same-bytes.tmp");
							await Bun.write(replacement, bytes);
							await fs.rename(replacement, transcript);
						}
						return markers;
					},
				},
				async () => ({ deleted: true, value: ++calls }),
			),
		).rejects.toMatchObject({ code: "authority_changed" });
		expect(calls).toBe(0);
		expect(await Bun.file(transcript).text()).toBe(bytes);
		expect(await Bun.file(target.authorityKey).text()).toBe(authority);
	});

	it("async delete repeats every independent veto and refuses unknown or failed marker scans under lock", async () => {
		const token = admitOwnerMembershipSync(target, cooperative, options);
		retireOwnerMembershipSync(token);
		const authority = await Bun.file(target.authorityKey).text();
		let calls = 0;
		for (const kind of [
			"legacy_lifecycle_ambiguous",
			"authority_roots_unresolved",
			"owned_by_other",
			"unknown_ownership",
		] as const) {
			let scans = 0;
			await expect(
				deleteWithOwnerCheck(
					target,
					{
						inspectVetoes: async () => (++scans === 2 ? { kind, digest: digest(kind), evidence: [kind] } : veto),
						readMarkers: async () => markers,
					},
					async () => ({ deleted: true, value: ++calls }),
				),
			).rejects.toMatchObject({ code: kind });
			expect(await Bun.file(target.authorityKey).text()).toBe(authority);
		}
		for (const failure of ["unknown marker", "marker read failed", "veto read failed"]) {
			let markerScans = 0;
			let vetoScans = 0;
			await expect(
				deleteWithOwnerCheck(
					target,
					{
						inspectVetoes: async () => {
							if (++vetoScans === 2 && failure === "veto read failed") throw new Error(failure);
							return veto;
						},
						readMarkers: async () => {
							if (++markerScans !== 2 || failure === "veto read failed") return markers;
							if (failure === "marker read failed") throw new Error(failure);
							return { ...markers, kind: "unknown" };
						},
					},
					async () => ({ deleted: true, value: ++calls }),
				),
			).rejects.toMatchObject({ code: "unknown_ownership" });
			expect(await Bun.file(target.authorityKey).text()).toBe(authority);
		}
		expect(calls).toBe(0);
		expect(await Bun.file(transcript).exists()).toBe(true);
	});

	it("async delete never removes a successor authority installed during deletion", async () => {
		const token = admitOwnerMembershipSync(target, cooperative, options);
		retireOwnerMembershipSync(token);
		const successor = { ...(await record()), epoch: randomBytes(16).toString("hex") };
		await expect(
			deleteWithOwnerCheck(
				target,
				{ inspectVetoes: async () => veto, readMarkers: async () => markers },
				async resolved => {
					await new FileSessionStorage().deleteSessionWithArtifacts(resolved.transcriptPath);
					await seed(successor);
					return { deleted: true, value: "deleted" };
				},
			),
		).rejects.toMatchObject({ code: "authority_changed" });
		expect(await record()).toEqual(successor);
		expect(await Bun.file(`${target.authorityKey}.lock`).exists()).toBe(false);
	});

	it("deletion refuses live/unknown authority and only clears it after actual verified deletion", async () => {
		const token = admitOwnerMembershipSync(target, cooperative, options);
		let called = false;
		code(
			() =>
				deleteWithOwnerCheckSync(target, options, () => {
					called = true;
					return { deleted: true, value: 1 };
				}),
			"owned_by_other",
		);
		expect(called).toBe(false);
		retireOwnerMembershipSync(token);
		code(() => deleteWithOwnerCheckSync(target, options, () => ({ deleted: true, value: 1 })), "unknown_ownership");
		expect(await Bun.file(target.authorityKey).exists()).toBe(true);
		expect(
			deleteWithOwnerCheckSync(target, options, () => {
				sync.unlinkSync(transcript);
				return { deleted: true, value: "deleted" };
			}),
		).toBe("deleted");
		expect(await Bun.file(target.authorityKey).exists()).toBe(false);
	});
});
