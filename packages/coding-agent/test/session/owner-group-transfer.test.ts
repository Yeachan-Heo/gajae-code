import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import * as sync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@gajae-code/natives";
import { nativeProcessBindings } from "@gajae-code/utils/native-process";
import {
	admitOwnerMembershipSync,
	admitOwnerMembershipWithAsyncEvidence,
	captureOwnerTargetSync,
	confirmOwnerFirstWriteMarkerSync,
	deleteWithOwnerCheck,
	deleteWithOwnerCheckSync,
	getOwnerMembershipEvidence,
	getPendingOwnerTransfer,
	type OwnerAdmissionOptions,
	OwnerAuthorityError,
	type OwnerDirectoryPublicationReceipt,
	type OwnerMember,
	type OwnerMembership,
	type OwnerRecord,
	type OwnerRefusal,
	type OwnerTarget,
	type OwnerTransfer,
	ownerFirstWriteMarkerSync,
	ownerHostIdSync,
	probeSessionOwnershipSync,
	publishOwnerDirectory,
	recoverOwnerTransferSync,
	reserveOwnerTransfer,
	reserveOwnerTransferSync,
	retireOwnerMembershipSync,
	revalidateOwnerMembershipSync,
	settleOwnerTransfer,
	settleOwnerTransferSync,
	withOwnerPublication,
	withOwnerPublicationSync,
	withOwnerTransferPublication,
	withOwnerTransferPublicationSync,
} from "../../src/session/owner-group";
import { resolveResumeCheckpoint } from "../../src/session/resume-cursor";
import type { SessionHeader } from "../../src/session/session-manager";
import { FileSessionStorage } from "../../src/session/session-storage";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
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

describe("double-location owner transfer", () => {
	let root: string;
	let old: OwnerTarget;
	let next: OwnerTarget;
	let token: OwnerMembership;
	let header: SessionHeader;
	let options: OwnerAdmissionOptions;
	let cleanup: Array<() => Promise<void>>;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-transfer-"));
		await fs.mkdir(path.join(root, "old"), { mode: 0o700 });
		await fs.mkdir(path.join(root, "next"), { mode: 0o700 });
		const transcript = path.join(root, "old", "anything.jsonl");
		header = { type: "session", version: 5, id: "transfer-header", timestamp: "2026-01-01T00:00:00.000Z", cwd: root };
		await Bun.write(transcript, `${JSON.stringify(header)}\n`);
		old = captureOwnerTargetSync({ transcriptPath: transcript, headerId: "transfer-header" });
		next = captureOwnerTargetSync({
			transcriptPath: path.join(root, "next", "different.jsonl"),
			headerId: "transfer-header",
		});
		options = {
			runtime: "owner-transfer-test",
			capabilities: ["publication", "move"],
			inspectVetoes: () => ({ kind: "clear", digest: digest("clear"), evidence: [] }),
			readMarkers: target => ({
				kind: "absent",
				digest: digest("absent"),
				snapshotDigest: target.snapshotDigest,
				members: [],
			}),
		};
		token = admitOwnerMembershipSync(old, { kind: "cooperative" }, options);
		cleanup = [];
	});
	afterEach(async () => {
		for (const close of cleanup) await close();
		await fs.rm(root, { recursive: true, force: true });
	});
	async function read(target: OwnerTarget): Promise<OwnerRecord> {
		return await Bun.file(target.authorityKey).json();
	}
	async function write(target: OwnerTarget, record: OwnerRecord): Promise<void> {
		await Bun.write(target.authorityKey, `${JSON.stringify(record)}\n`);
		await fs.chmod(target.authorityKey, 0o600);
	}
	async function initiator(member: OwnerMember): Promise<{ member: OwnerMember; stop: () => Promise<void> }> {
		const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60000)"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		let stopped = false;
		const stop = async () => {
			if (!stopped) {
				stopped = true;
				child.kill();
			}
			await child.exited;
		};
		cleanup.push(stop);
		const reference = nativeProcessBindings().Process.fromPid(child.pid);
		expect(reference).not.toBeNull();
		const exact = {
			...member,
			pid: child.pid,
			processIncarnation: reference!.incarnation,
			hostId: ownerHostIdSync()!,
		};
		return { member: exact, stop };
	}
	async function replaceInitiator(member: OwnerMember): Promise<void> {
		for (const target of [old, next]) {
			if (!(await Bun.file(target.authorityKey).exists())) continue;
			const record = await read(target);
			await write(target, {
				...record,
				members: record.members.map(existing => (existing.memberId === member.memberId ? member : existing)),
				transfer: { ...record.transfer!, initiator: member },
			});
		}
	}

	it("reserves both actual roots before any move and fences both admissions/publication", async () => {
		const handle = reserveOwnerTransferSync(token, next);
		const source = await read(old);
		const destination = await read(next);
		expect(getPendingOwnerTransfer(token)).toBe(handle);
		expect(source.state).toBe("transfer_reserved");
		expect(destination.state).toBe("incoming");
		expect(source.transfer?.transferId).toBe(destination.transfer?.transferId);
		expect(source.authorityRoot.realpath).toBe(await fs.realpath(path.dirname(old.transcriptPath)));
		expect(destination.authorityRoot.realpath).toBe(await fs.realpath(path.dirname(next.transcriptPath)));
		expect(await Bun.file(old.transcriptPath).exists()).toBe(true);
		expect(await Bun.file(next.transcriptPath).exists()).toBe(false);
		code(() => admitOwnerMembershipSync(old, { kind: "cooperative" }, options), "transfer_in_progress");
		code(() => admitOwnerMembershipSync(next, { kind: "cooperative" }, options), "transfer_in_progress");
		code(
			() =>
				withOwnerPublicationSync(token, () => {
					throw new Error("must not execute");
				}),
			"participation_lost",
		);
		code(() => recoverOwnerTransferSync(old), "transfer_in_progress");
		expect(settleOwnerTransferSync(handle, "abort")).toBe("aborted");
	});

	it("success settles new live/old moved, is idempotent and routes late teardown", async () => {
		const handle = reserveOwnerTransferSync(token, next);
		await fs.rename(old.transcriptPath, next.transcriptPath);
		expect(settleOwnerTransferSync(handle, "success")).toBe("moved");
		expect((await read(old)).state).toBe("moved");
		expect((await read(next)).state).toBe("live");
		expect((await read(next)).transfer).toBeUndefined();
		expect(getOwnerMembershipEvidence(token).authorityKey).toBe(next.authorityKey);
		withOwnerPublicationSync(token, () => 1);
		expect(settleOwnerTransferSync(handle, "success")).toBe("moved");
		const recapturedOld = captureOwnerTargetSync({ transcriptPath: old.transcriptPath, headerId: old.headerId });
		expect(probeSessionOwnershipSync(recapturedOld, options, "cooperative").reason).toBe("session_moved");
		retireOwnerMembershipSync(token);
		expect((await read(next)).state).toBe("retired");
		expect((await read(old)).state).toBe("moved");
	});

	it("abort restores old live, removes only matching incoming generation and retries idempotently", async () => {
		const epoch = getOwnerMembershipEvidence(token).epoch;
		const handle = reserveOwnerTransferSync(token, next);
		expect(settleOwnerTransferSync(handle, "abort")).toBe("aborted");
		expect(settleOwnerTransferSync(handle, "abort")).toBe("aborted");
		expect((await read(old)).state).toBe("live");
		expect((await read(old)).epoch).toBe(epoch);
		expect(await Bun.file(next.authorityKey).exists()).toBe(false);
		withOwnerPublicationSync(token, () => 1);
	});

	it("cannot settle to the claimed outcome unless actual transcript locations agree", async () => {
		const handle = reserveOwnerTransferSync(token, next);
		code(() => settleOwnerTransferSync(handle, "success"), "transfer_abandoned_ambiguous");
		await fs.copyFile(old.transcriptPath, next.transcriptPath);
		code(() => settleOwnerTransferSync(handle, "success"), "transfer_abandoned_ambiguous");
		code(() => settleOwnerTransferSync(handle, "abort"), "transfer_abandoned_ambiguous");
		await fs.unlink(next.transcriptPath);
		await fs.unlink(old.transcriptPath);
		code(() => settleOwnerTransferSync(handle, "success"), "transfer_abandoned_ambiguous");
		code(() => settleOwnerTransferSync(handle, "abort"), "transfer_abandoned_ambiguous");
		expect((await read(old)).state).toBe("transfer_reserved");
		expect((await read(next)).state).toBe("incoming");
	});

	it("destination authority conflict leaves source live and never moves bytes", async () => {
		const source = await Bun.file(old.authorityKey).text();
		await fs.mkdir(path.dirname(next.authorityKey), { mode: 0o700 });
		await Bun.write(next.authorityKey, "corrupt destination evidence\n");
		await fs.chmod(next.authorityKey, 0o600);
		code(() => reserveOwnerTransferSync(token, next), "destination_authority_conflict");
		expect(await Bun.file(old.authorityKey).text()).toBe(source);
		expect(await Bun.file(next.authorityKey).text()).toBe("corrupt destination evidence\n");
		expect(await Bun.file(old.transcriptPath).exists()).toBe(true);
	});

	it("destination transcript conflict and forged transfer tokens cannot settle", async () => {
		await Bun.write(next.transcriptPath, `${JSON.stringify({ type: "session", id: "transfer-header" })}\n`);
		code(() => reserveOwnerTransferSync(token, next), "destination_authority_conflict");
		code(() => settleOwnerTransferSync({} as OwnerTransfer, "success"), "invalid_transfer");
		expect((await read(old)).state).toBe("live");
	});

	it("foreign or uncertain initiating identity stays protected despite local PID absence", async () => {
		reserveOwnerTransferSync(token, next);
		const record = await read(old);
		await replaceInitiator({ ...record.transfer!.initiator, hostId: digest("foreign host"), pid: 2_147_483_647 });
		code(() => recoverOwnerTransferSync(old), "transfer_in_progress");
		code(() => recoverOwnerTransferSync(next), "transfer_in_progress");
		expect((await read(old)).state).toBe("transfer_reserved");
	});

	it("recovery rolls forward only-new after kernel-proven initiating process exit", async () => {
		reserveOwnerTransferSync(token, next);
		const record = await read(old);
		const child = await initiator(record.transfer!.initiator);
		await replaceInitiator(child.member);
		await fs.rename(old.transcriptPath, next.transcriptPath);
		code(() => recoverOwnerTransferSync(old), "transfer_in_progress");
		await child.stop();
		expect(recoverOwnerTransferSync(old)).toBe("moved");
		expect(recoverOwnerTransferSync(old)).toBe("moved");
		expect((await read(old)).state).toBe("moved");
		expect((await read(next)).state).toBe("live");
		code(() => retireOwnerMembershipSync(token), "participation_lost");
	});

	it("recovery rolls back only-old after kernel-proven initiating process exit", async () => {
		reserveOwnerTransferSync(token, next);
		const record = await read(old);
		const child = await initiator(record.transfer!.initiator);
		await replaceInitiator(child.member);
		await child.stop();
		expect(recoverOwnerTransferSync(next)).toBe("aborted");
		expect((await read(old)).state).toBe("live");
		expect(await Bun.file(next.authorityKey).exists()).toBe(false);
	});

	it("dead-initiator recovery preserves both/neither ambiguity rather than guessing", async () => {
		reserveOwnerTransferSync(token, next);
		const record = await read(old);
		const child = await initiator(record.transfer!.initiator);
		await replaceInitiator(child.member);
		await child.stop();
		await fs.copyFile(old.transcriptPath, next.transcriptPath);
		code(() => recoverOwnerTransferSync(old), "transfer_abandoned_ambiguous");
		await fs.unlink(old.transcriptPath);
		await fs.unlink(next.transcriptPath);
		code(() => recoverOwnerTransferSync(next), "transfer_abandoned_ambiguous");
		expect((await read(old)).state).toBe("transfer_reserved");
		expect((await read(next)).state).toBe("incoming");
	});

	it("backstop completes a crash between old moved and new live", async () => {
		const handle = reserveOwnerTransferSync(token, next);
		await fs.rename(old.transcriptPath, next.transcriptPath);
		const source = await read(old);
		const destination = await read(next);
		await write(next, { ...destination, state: "settled", rev: destination.rev + 1 });
		await write(old, { ...source, state: "moved", rev: source.rev + 1 });
		expect(settleOwnerTransferSync(handle, "success")).toBe("moved");
		expect((await read(next)).state).toBe("live");
	});

	it("backstop can roll back a reservation whose incoming publication never completed", async () => {
		const handle = reserveOwnerTransferSync(token, next);
		await fs.unlink(next.authorityKey);
		expect(settleOwnerTransferSync(handle, "abort")).toBe("aborted");
		expect((await read(old)).state).toBe("live");
	});

	it("stale transfer CAS cannot overwrite a successor destination epoch or transfer ID", async () => {
		const handle = reserveOwnerTransferSync(token, next);
		const destination = await read(next);
		const successorEpoch = randomBytes(16).toString("hex");
		await write(next, { ...destination, epoch: successorEpoch });
		code(() => settleOwnerTransferSync(handle, "abort"), "invalid_transfer");
		expect((await read(next)).epoch).toBe(successorEpoch);
		await write(next, destination);
		const source = await read(old);
		await write(old, { ...source, transfer: { ...source.transfer!, transferId: randomBytes(16).toString("hex") } });
		code(() => settleOwnerTransferSync(handle, "abort"), "invalid_transfer");
		expect((await read(next)).state).toBe("incoming");
	});

	it("late teardown follows moved tombstone but cannot remove a successor epoch", async () => {
		const other = admitOwnerMembershipSync(old, { kind: "cooperative" }, options);
		revalidateOwnerMembershipSync(token);
		const handle = reserveOwnerTransferSync(token, next);
		await fs.rename(old.transcriptPath, next.transcriptPath);
		settleOwnerTransferSync(handle, "success");
		retireOwnerMembershipSync(other);
		expect((await read(next)).members).toHaveLength(1);
		const successor = await read(next);
		await write(next, { ...successor, epoch: randomBytes(16).toString("hex") });
		code(() => retireOwnerMembershipSync(token), "participation_lost");
		expect((await read(next)).members).toHaveLength(1);
	});

	it("deletion follows moved tombstones, refuses the live destination, then cleans both after verified deletion", async () => {
		const handle = reserveOwnerTransferSync(token, next);
		await fs.rename(old.transcriptPath, next.transcriptPath);
		settleOwnerTransferSync(handle, "success");
		code(() => deleteWithOwnerCheckSync(old, options, () => ({ deleted: true, value: 1 })), "owned_by_other");
		retireOwnerMembershipSync(token);
		expect(
			deleteWithOwnerCheckSync(old, options, resolved => {
				sync.unlinkSync(resolved.transcriptPath);
				return { deleted: true, value: resolved.transcriptPath };
			}),
		).toBe(next.transcriptPath);
		expect(await Bun.file(old.authorityKey).exists()).toBe(false);
		expect(await Bun.file(next.authorityKey).exists()).toBe(false);
	});

	it("native async transfer rescans destination evidence under both authority locks and settles", async () => {
		retireOwnerMembershipSync(token);
		const scans: Array<{ key: string; sourceLocked: boolean; destinationLocked: boolean }> = [];
		const nativeToken = await admitOwnerMembershipWithAsyncEvidence(
			old,
			{
				kind: "exclusive_native",
				expected: {
					snapshotDigest: old.snapshotDigest,
					resolved: resolveResumeCheckpoint([header], old.snapshotDigest),
				},
			},
			{
				...options,
				inspectVetoes: async target => {
					scans.push({
						key: target.authorityKey,
						sourceLocked: await Bun.file(`${old.authorityKey}.lock`).exists(),
						destinationLocked: await Bun.file(`${next.authorityKey}.lock`).exists(),
					});
					return options.inspectVetoes(target);
				},
				readMarkers: async target => options.readMarkers(target),
			},
		);
		const handle = await reserveOwnerTransfer(nativeToken, next);
		expect(scans.slice(-2)).toEqual([
			{ key: old.authorityKey, sourceLocked: true, destinationLocked: true },
			{ key: next.authorityKey, sourceLocked: true, destinationLocked: true },
		]);
		await fs.rename(old.transcriptPath, next.transcriptPath);
		await expect(settleOwnerTransfer(handle, "success")).resolves.toBe("moved");
		await expect(settleOwnerTransfer(handle, "success")).resolves.toBe("moved");
		await expect(withOwnerPublication(nativeToken, async () => "destination publication")).resolves.toBe(
			"destination publication",
		);
		expect((await read(old)).state).toBe("moved");
		expect((await read(next)).mode).toBe("exclusive_native");
	});

	it("native async transfer keeps destination vetoes and late successor CAS fencing", async () => {
		retireOwnerMembershipSync(token);
		let destinationVeto = true;
		const nativeToken = await admitOwnerMembershipWithAsyncEvidence(
			old,
			{
				kind: "exclusive_native",
				expected: {
					snapshotDigest: old.snapshotDigest,
					resolved: resolveResumeCheckpoint([header], old.snapshotDigest),
				},
			},
			{
				...options,
				inspectVetoes: async target =>
					target.authorityKey === next.authorityKey && destinationVeto
						? { kind: "owned_by_other", digest: digest("destination veto"), evidence: [] }
						: options.inspectVetoes(target),
				readMarkers: async target => options.readMarkers(target),
			},
		);
		await expect(reserveOwnerTransfer(nativeToken, next)).rejects.toMatchObject({ code: "owned_by_other" });
		expect((await read(old)).state).toBe("live");
		expect(await Bun.file(path.dirname(next.authorityKey)).exists()).toBe(false);
		destinationVeto = false;
		const handle = await reserveOwnerTransfer(nativeToken, next);
		const incoming = await read(next);
		const successor = { ...incoming, epoch: randomBytes(16).toString("hex") };
		await write(next, successor);
		await expect(settleOwnerTransfer(handle, "abort")).rejects.toMatchObject({ code: "invalid_transfer" });
		expect(await read(next)).toEqual(successor);
		expect((await read(old)).state).toBe("transfer_reserved");
	});

	it("transfer publication holds both locks through destination metadata and still permits rollback", async () => {
		const original = await Bun.file(old.transcriptPath).text();
		const handle = reserveOwnerTransferSync(token, next);
		const source = await read(old);
		const destination = await read(next);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const metadata = `${JSON.stringify({ ...header, cwd: path.dirname(next.transcriptPath) })}\n`;
		const publication = withOwnerTransferPublication(handle, async () => {
			await fs.rename(old.transcriptPath, next.transcriptPath);
			await Bun.write(next.transcriptPath, metadata);
			entered.resolve();
			await release.promise;
			return "metadata written";
		});
		try {
			await entered.promise;
			for (const target of [old, next]) {
				expect(
					new FileSessionStorage().acquireExclusiveLockSync(`${target.authorityKey}.lock`, {
						ownerHostId: ownerHostIdSync()!,
					}),
				).toBeUndefined();
			}
			code(() => retireOwnerMembershipSync(token), "authority_busy");
			expect(await read(old)).toEqual(source);
			expect(await read(next)).toEqual(destination);
			await expect(withOwnerPublication(token, async () => "must not run")).rejects.toMatchObject({
				code: "participation_lost",
			});
		} finally {
			release.resolve();
		}
		await expect(publication).resolves.toBe("metadata written");
		expect(await Bun.file(next.transcriptPath).text()).toBe(metadata);
		await fs.rename(next.transcriptPath, old.transcriptPath);
		await Bun.write(old.transcriptPath, original);
		await expect(settleOwnerTransfer(handle, "abort")).resolves.toBe("aborted");
		expect(await Bun.file(old.transcriptPath).text()).toBe(original);
		expect((await read(old)).state).toBe("live");
		expect(await Bun.file(next.authorityKey).exists()).toBe(false);
	});

	it("destination metadata publication settles only explicitly and rejects late handles", async () => {
		const handle = reserveOwnerTransferSync(token, next);
		await fs.rename(old.transcriptPath, next.transcriptPath);
		const metadata = `${JSON.stringify({ ...header, cwd: path.dirname(next.transcriptPath) })}\n`;
		await withOwnerTransferPublication(handle, async () => {
			await Bun.write(next.transcriptPath, metadata);
		});
		expect((await read(old)).state).toBe("transfer_reserved");
		expect((await read(next)).state).toBe("incoming");
		await expect(settleOwnerTransfer(handle, "success")).resolves.toBe("moved");
		const destination = await read(next);
		await expect(
			withOwnerTransferPublication(handle, async () => {
				throw new Error("late body");
			}),
		).rejects.toMatchObject({ code: "invalid_transfer" });
		code(
			() =>
				withOwnerTransferPublicationSync(handle, () => {
					throw new Error("late sync body");
				}),
			"invalid_transfer",
		);
		expect(await read(next)).toEqual(destination);
		expect(await Bun.file(next.transcriptPath).text()).toBe(metadata);
	});

	it("sync transfer metadata uses the same reservation gate without permitting yielding bodies", async () => {
		const handle = reserveOwnerTransferSync(token, next);
		let calls = 0;
		code(
			() =>
				withOwnerTransferPublicationSync(handle, async () => {
					calls++;
				}),
			"participation_lost",
		);
		expect(calls).toBe(0);
		await fs.rename(old.transcriptPath, next.transcriptPath);
		const metadata = `${JSON.stringify({ ...header, cwd: path.dirname(next.transcriptPath) })}\n`;
		expect(
			withOwnerTransferPublicationSync(handle, () => {
				sync.writeFileSync(next.transcriptPath, metadata);
				code(() => retireOwnerMembershipSync(token), "authority_busy");
				return "written";
			}),
		).toBe("written");
		code(() => withOwnerTransferPublicationSync(handle, () => Promise.resolve("yield")), "participation_lost");
		expect((await read(old)).state).toBe("transfer_reserved");
		expect((await read(next)).state).toBe("incoming");
		expect(settleOwnerTransferSync(handle, "success")).toBe("moved");
		expect(await Bun.file(next.transcriptPath).text()).toBe(metadata);
	});

	it("transfer publication fences source and destination rev, epoch, member and transfer ID before and after awaits", async () => {
		const handle = reserveOwnerTransferSync(token, next);
		const originals = [await read(old), await read(next)];
		let calls = 0;
		for (const [index, target] of [old, next].entries()) {
			const original = originals[index];
			const changedMember = { ...original.members[0], runtime: "successor" };
			for (const replacement of [
				{ ...original, rev: original.rev + 1 },
				{ ...original, epoch: randomBytes(16).toString("hex") },
				{ ...original, transfer: { ...original.transfer!, transferId: randomBytes(16).toString("hex") } },
				{ ...original, members: [changedMember], transfer: { ...original.transfer!, initiator: changedMember } },
			]) {
				await write(target, replacement);
				await expect(withOwnerTransferPublication(handle, async () => ++calls)).rejects.toMatchObject({
					code: "invalid_transfer",
				});
				expect(calls).toBe(0);
				await write(target, original);
				await expect(
					withOwnerTransferPublication(handle, async () => {
						await write(target, replacement);
					}),
				).rejects.toMatchObject({ code: "invalid_transfer" });
				expect(await read(target)).toEqual(replacement);
				await write(target, original);
			}
		}
		expect(settleOwnerTransferSync(handle, "abort")).toBe("aborted");
	});

	it("metadata body failure retains both fences until physical rollback and explicit abort", async () => {
		const handle = reserveOwnerTransferSync(token, next);
		const failure = new Error("metadata failed");
		const original = await Bun.file(old.transcriptPath).text();
		await expect(
			withOwnerTransferPublication(handle, async () => {
				await fs.rename(old.transcriptPath, next.transcriptPath);
				await Bun.write(next.transcriptPath, `${JSON.stringify({ ...header, cwd: "changed" })}\n`);
				throw failure;
			}),
		).rejects.toBe(failure);
		expect((await read(old)).state).toBe("transfer_reserved");
		expect((await read(next)).state).toBe("incoming");
		for (const target of [old, next]) expect(await Bun.file(`${target.authorityKey}.lock`).exists()).toBe(false);
		await fs.rename(next.transcriptPath, old.transcriptPath);
		await Bun.write(old.transcriptPath, original);
		await expect(settleOwnerTransfer(handle, "abort")).resolves.toBe("aborted");
	});

	it("transfer publication aggregates release uncertainty and never unlinks a successor lock", async () => {
		const handle = reserveOwnerTransferSync(token, next);
		const bodyError = new Error("metadata failure");
		const releaseError = new Error("release uncertainty");
		const originalAcquire = FileSessionStorage.prototype.acquireExclusiveLockSync;
		const acquire = spyOn(FileSessionStorage.prototype, "acquireExclusiveLockSync").mockImplementation(function (
			this: FileSessionStorage,
			lockPath,
			lockOptions,
		) {
			const lock = originalAcquire.call(this, lockPath, lockOptions);
			if (!lock || lockPath !== `${old.authorityKey}.lock`) return lock;
			return {
				releaseSync: () => {
					lock.releaseSync();
					throw releaseError;
				},
			};
		});
		try {
			const failure = await withOwnerTransferPublication(handle, async () => {
				throw bodyError;
			}).catch(error => error);
			expect(failure).toBeInstanceOf(AggregateError);
			expect(failure.errors).toEqual([bodyError, releaseError]);
		} finally {
			acquire.mockRestore();
		}
		let successor: { releaseSync(): void } | undefined;
		try {
			await expect(
				withOwnerTransferPublication(handle, async () => {
					await fs.unlink(`${next.authorityKey}.lock`);
					successor = new FileSessionStorage().acquireExclusiveLockSync(`${next.authorityKey}.lock`, {
						ownerHostId: ownerHostIdSync()!,
					});
					expect(successor).toBeDefined();
					throw bodyError;
				}),
			).rejects.toBe(bodyError);
			expect(await Bun.file(`${next.authorityKey}.lock`).exists()).toBe(true);
		} finally {
			successor?.releaseSync();
		}
		expect(settleOwnerTransferSync(handle, "abort")).toBe("aborted");
	});

	it("async deletion refuses both transfer locations and follows moved tombstones only after retirement", async () => {
		const inspectors = {
			inspectVetoes: async (target: OwnerTarget) => options.inspectVetoes(target),
			readMarkers: async (target: OwnerTarget) => options.readMarkers(target),
		};
		const handle = reserveOwnerTransferSync(token, next);
		let calls = 0;
		for (const target of [old, next]) {
			await expect(
				deleteWithOwnerCheck(target, inspectors, async () => ({ deleted: true, value: ++calls })),
			).rejects.toMatchObject({ code: "transfer_in_progress" });
		}
		expect(calls).toBe(0);
		await fs.rename(old.transcriptPath, next.transcriptPath);
		settleOwnerTransferSync(handle, "success");
		await expect(
			deleteWithOwnerCheck(old, inspectors, async () => ({ deleted: true, value: ++calls })),
		).rejects.toMatchObject({ code: "owned_by_other" });
		retireOwnerMembershipSync(token);
		const storage = new FileSessionStorage();
		const failure = new Error("physical delete refused");
		const unlink = spyOn(storage, "unlink").mockRejectedValue(failure);
		try {
			await expect(
				deleteWithOwnerCheck(old, inspectors, async resolved => {
					await storage.deleteSessionWithArtifacts(resolved.transcriptPath);
					return { deleted: true, value: resolved.transcriptPath };
				}),
			).rejects.toBe(failure);
			expect((await read(old)).state).toBe("moved");
			expect((await read(next)).state).toBe("retired");
		} finally {
			unlink.mockRestore();
		}
		await expect(
			deleteWithOwnerCheck(old, inspectors, async resolved => {
				for (const target of [old, next]) expect(await Bun.file(`${target.authorityKey}.lock`).exists()).toBe(true);
				await storage.deleteSessionWithArtifacts(resolved.transcriptPath);
				return { deleted: true, value: resolved.transcriptPath };
			}),
		).resolves.toBe(next.transcriptPath);
		for (const target of [old, next]) expect(await Bun.file(target.authorityKey).exists()).toBe(false);
	});

	async function preparedDirectory(
		inspectVetoes = options.inspectVetoes,
	): Promise<{ staged: OwnerTarget; forkToken: OwnerMembership; finalPath: string }> {
		const stage = path.join(root, "private-fork");
		await fs.mkdir(stage, { mode: 0o700 });
		const transcriptPath = path.join(stage, "fork.jsonl");
		const staged = captureOwnerTargetSync({ transcriptPath, headerId: "independent-fork" });
		const forkToken = admitOwnerMembershipSync(staged, { kind: "cooperative" }, { ...options, inspectVetoes });
		withOwnerPublicationSync(forkToken, () => {
			const marker = ownerFirstWriteMarkerSync(forkToken)!;
			const bytes = `${JSON.stringify({ ...header, id: staged.headerId })}\n${JSON.stringify({ type: "fork_init", owner: marker })}\n`;
			const fd = sync.openSync(transcriptPath, "wx", 0o600);
			try {
				sync.writeSync(fd, bytes);
				sync.fsyncSync(fd);
			} finally {
				sync.closeSync(fd);
			}
			const dir = sync.openSync(stage, "r");
			try {
				sync.fsyncSync(dir);
			} finally {
				sync.closeSync(dir);
			}
			confirmOwnerFirstWriteMarkerSync(forkToken, marker, () => {
				const persisted = new FileSessionStorage().readTextSync(transcriptPath);
				return (
					persisted === bytes && JSON.parse(persisted.trim().split("\n")[1]!).owner.memberId === marker.memberId
				);
			});
		});
		return { staged, forkToken, finalPath: path.join(root, "published-fork", "fork.jsonl") };
	}
	function publishDirectory(staged: OwnerTarget, finalPath: string): OwnerDirectoryPublicationReceipt {
		const destinationDirectory = path.dirname(finalPath);
		const renamed = natives.renameNoReplacePath(staged.authorityRoot.realpath, destinationDirectory);
		if (!renamed.ok) throw new Error(renamed.code ?? "directory_rename_failed");
		const fd = sync.openSync(path.dirname(destinationDirectory), "r");
		try {
			sync.fsyncSync(fd);
		} finally {
			sync.closeSync(fd);
		}
		return {
			kind: "checked_directory_rename",
			sourceDirectory: staged.authorityRoot.realpath,
			destinationDirectory,
			namespaceSynced: true,
		};
	}

	it("atomically publishes an independently admitted fork and rebinds only the same physical authority", async () => {
		const { staged, forkToken, finalPath } = await preparedDirectory();
		const before = getOwnerMembershipEvidence(forkToken);
		const sourceRecord = await read(old);
		const forkRecord = await read(staged);
		const originalDirectory = await fs.stat(staged.authorityRoot.realpath, { bigint: true });
		let calls = 0;
		const after = await publishOwnerDirectory(forkToken, finalPath, async () => {
			calls++;
			code(() => withOwnerPublicationSync(forkToken, () => 1), "participation_lost");
			return publishDirectory(staged, finalPath);
		});
		const finalTarget = captureOwnerTargetSync({ transcriptPath: finalPath, headerId: staged.headerId });
		const finalRecord = await read(finalTarget);
		const finalDirectory = await fs.stat(path.dirname(finalPath), { bigint: true });
		expect(calls).toBe(1);
		expect([finalDirectory.dev, finalDirectory.ino]).toEqual([originalDirectory.dev, originalDirectory.ino]);
		expect(finalRecord.authorityRoot).toEqual(finalTarget.authorityRoot);
		expect(finalRecord.ownerDirectory.realpath).toBe(path.dirname(finalTarget.authorityKey));
		expect(finalRecord.members).toEqual(forkRecord.members);
		expect(finalRecord.epoch).toBe(forkRecord.epoch);
		expect(finalRecord.headerId).not.toBe(sourceRecord.headerId);
		expect(finalRecord.epoch).not.toBe(sourceRecord.epoch);
		expect(finalRecord.members[0]!.memberId).not.toBe(sourceRecord.members[0]!.memberId);
		expect(after).toMatchObject({
			authorityKey: finalTarget.authorityKey,
			memberId: before.memberId,
			epoch: before.epoch,
			policy: before.policy,
			rev: before.rev + 1,
		});
		expect(await Bun.file(`${finalTarget.authorityKey}.lock`).exists()).toBe(false);
		expect(sync.existsSync(staged.authorityRoot.realpath)).toBe(false);
		expect(withOwnerPublicationSync(forkToken, () => "published")).toBe("published");
		expect(probeSessionOwnershipSync(staged, options).reason).toBe("authority_changed");
		expect(await read(old)).toEqual(sourceRecord);
		retireOwnerMembershipSync(forkToken);
		expect((await read(finalTarget)).state).toBe("retired");
	});

	it("directory collision never dispatches or alters either owner record", async () => {
		const { staged, forkToken, finalPath } = await preparedDirectory();
		const before = await Bun.file(staged.authorityKey).text();
		await fs.mkdir(path.dirname(finalPath), { mode: 0o700 });
		await Bun.write(path.join(path.dirname(finalPath), "sentinel"), "untouched");
		let calls = 0;
		await expect(
			publishOwnerDirectory(forkToken, finalPath, async () => {
				calls++;
				return publishDirectory(staged, finalPath);
			}),
		).rejects.toMatchObject({ code: "destination_authority_conflict" });
		expect(calls).toBe(0);
		expect(await Bun.file(staged.authorityKey).text()).toBe(before);
		expect(await Bun.file(path.join(path.dirname(finalPath), "sentinel")).text()).toBe("untouched");
		expect(await Bun.file(`${staged.authorityKey}.lock`).exists()).toBe(false);
	});

	it("a fresh independent veto prevents directory callback dispatch", async () => {
		let veto = false;
		const { staged, forkToken, finalPath } = await preparedDirectory(target =>
			veto ? { kind: "owned_by_other", digest: digest("veto"), evidence: [] } : options.inspectVetoes(target),
		);
		const original = await Bun.file(staged.authorityKey).text();
		let calls = 0;
		veto = true;
		await expect(
			publishOwnerDirectory(forkToken, finalPath, async () => {
				calls++;
				return publishDirectory(staged, finalPath);
			}),
		).rejects.toMatchObject({ code: "owned_by_other" });
		expect(calls).toBe(0);
		expect(await Bun.file(staged.authorityKey).text()).toBe(original);
		expect(await Bun.file(`${staged.authorityKey}.lock`).exists()).toBe(false);
	});

	it("retains the actual moved lock and old-root record when rename throws after dispatch", async () => {
		const { staged, forkToken, finalPath } = await preparedDirectory();
		const original = await Bun.file(staged.authorityKey).text();
		const failure = new Error("rename acknowledgement lost");
		await expect(
			publishOwnerDirectory(forkToken, finalPath, async () => {
				publishDirectory(staged, finalPath);
				throw failure;
			}),
		).rejects.toBe(failure);
		const movedRecord = path.join(path.dirname(finalPath), ".gjc-owners", path.basename(staged.authorityKey));
		expect(await Bun.file(movedRecord).text()).toBe(original);
		expect(await Bun.file(`${movedRecord}.lock`).exists()).toBe(true);
		expect(sync.existsSync(staged.authorityRoot.realpath)).toBe(false);
		code(() => getOwnerMembershipEvidence(forkToken), "participation_lost");
		code(() => retireOwnerMembershipSync(forkToken), "participation_lost");
		code(() => withOwnerPublicationSync(forkToken, () => 1), "participation_lost");
		const moved = captureOwnerTargetSync({ transcriptPath: finalPath, headerId: staged.headerId });
		code(() => admitOwnerMembershipSync(moved, { kind: "cooperative" }, options), "authority_changed");
	});

	it.each([
		"source",
		"destination",
		"record",
		"staged_record",
		"lock",
		"receipt",
	] as const)("fails closed on replaced %s evidence without releasing a foreign lock", async replacement => {
		const { staged, forkToken, finalPath } = await preparedDirectory();
		const finalDir = path.dirname(finalPath);
		let retainedDir = finalDir;
		let successor: { releaseSync(): void } | undefined;
		try {
			await expect(
				publishOwnerDirectory(forkToken, finalPath, async () => {
					let receipt: OwnerDirectoryPublicationReceipt;
					if (replacement === "source") {
						retainedDir = `${staged.authorityRoot.realpath}-retained`;
						await fs.rename(staged.authorityRoot.realpath, retainedDir);
						await fs.mkdir(staged.authorityRoot.realpath, { mode: 0o700 });
						receipt = {
							kind: "checked_directory_rename",
							sourceDirectory: staged.authorityRoot.realpath,
							destinationDirectory: finalDir,
							namespaceSynced: true,
						};
					} else {
						receipt = publishDirectory(staged, finalPath);
						if (replacement === "destination") {
							retainedDir = `${finalDir}-retained`;
							await fs.rename(finalDir, retainedDir);
							await fs.mkdir(finalDir, { mode: 0o700 });
						} else if (replacement === "record") {
							const recordPath = path.join(finalDir, ".gjc-owners", path.basename(staged.authorityKey));
							const bytes = await Bun.file(recordPath).text();
							await fs.rename(recordPath, `${recordPath}.retained`);
							await Bun.write(recordPath, bytes);
							await fs.chmod(recordPath, 0o600);
						} else if (replacement === "staged_record") {
							const owners = path.join(finalDir, ".gjc-owners");
							const stagedName = (await fs.readdir(owners)).find(name => name.endsWith(".tmp"))!;
							const recordPath = path.join(owners, stagedName);
							const bytes = await Bun.file(recordPath).text();
							await fs.rename(recordPath, `${recordPath}.retained`);
							await Bun.write(recordPath, bytes);
							await fs.chmod(recordPath, 0o600);
						} else if (replacement === "lock") {
							const lockPath = path.join(finalDir, ".gjc-owners", `${path.basename(staged.authorityKey)}.lock`);
							await fs.rename(lockPath, `${lockPath}.retained`);
							successor = new FileSessionStorage().acquireExclusiveLockSync(lockPath, {
								ownerHostId: ownerHostIdSync()!,
							});
							expect(successor).toBeDefined();
						} else receipt = { ...receipt, sourceDirectory: finalDir };
					}
					return receipt;
				}),
			).rejects.toMatchObject({ code: "authority_changed" });
			const actualLock = path.join(retainedDir, ".gjc-owners", `${path.basename(staged.authorityKey)}.lock`);
			expect(await Bun.file(actualLock).exists()).toBe(true);
			code(() => withOwnerPublicationSync(forkToken, () => 1), "participation_lost");
		} finally {
			successor?.releaseSync();
		}
	});

	it("retains old-root evidence and the moved lock when exact root rebinding throws after publication", async () => {
		const { staged, forkToken, finalPath } = await preparedDirectory();
		const originalBytes = await Bun.file(staged.authorityKey).text();
		const originalReplace = natives.exactReplacePath;
		const failure = new Error("owner root CAS acknowledgement lost");
		const replace = spyOn(natives, "exactReplacePath").mockImplementation(
			(sourcePath, destinationPath, sourceIdentity, destinationIdentity) => {
				const result = originalReplace(sourcePath, destinationPath, sourceIdentity, destinationIdentity);
				if (
					result.ok &&
					destinationPath === path.join(path.dirname(finalPath), ".gjc-owners", path.basename(staged.authorityKey))
				)
					throw failure;
				return result;
			},
		);
		try {
			await expect(
				publishOwnerDirectory(forkToken, finalPath, async () => publishDirectory(staged, finalPath)),
			).rejects.toBe(failure);
			const owners = path.join(path.dirname(finalPath), ".gjc-owners");
			const names = await fs.readdir(owners);
			const evidence = names.find(name => name.includes(".directory-publication-old-root-"))!;
			expect(await Bun.file(path.join(owners, evidence)).text()).toBe(originalBytes);
			expect(await Bun.file(path.join(owners, `${staged.headerId}.json.lock`)).exists()).toBe(true);
			code(() => getOwnerMembershipEvidence(forkToken), "participation_lost");
		} finally {
			replace.mockRestore();
		}
	});

	it("rejects a lock generation replaced immediately after acquisition without adopting or releasing it", async () => {
		const { staged, forkToken, finalPath } = await preparedDirectory();
		const originalAcquire = FileSessionStorage.prototype.acquireExclusiveLockSync;
		let successor: { releaseSync(): void } | undefined;
		let calls = 0;
		let replaced = false;
		const acquire = spyOn(FileSessionStorage.prototype, "acquireExclusiveLockSync").mockImplementation(function (
			this: FileSessionStorage,
			lockPath,
			lockOptions,
		) {
			const acquired = originalAcquire.call(this, lockPath, lockOptions);
			if (acquired && lockPath === `${staged.authorityKey}.lock` && !replaced) {
				replaced = true;
				sync.renameSync(lockPath, `${lockPath}.retained`);
				successor = originalAcquire.call(this, lockPath, lockOptions);
			}
			return acquired;
		});
		try {
			await expect(
				publishOwnerDirectory(forkToken, finalPath, async () => {
					calls++;
					return publishDirectory(staged, finalPath);
				}),
			).rejects.toMatchObject({ code: "authority_changed" });
			expect(calls).toBe(0);
			expect(successor).toBeDefined();
			expect(await Bun.file(`${staged.authorityKey}.lock`).exists()).toBe(true);
		} finally {
			acquire.mockRestore();
			successor?.releaseSync();
		}
	});

	it("detects immediate-parent replacement after rename and retains the actual moved generation", async () => {
		const { staged, forkToken, finalPath } = await preparedDirectory();
		const originalRoot = root;
		const retainedRoot = `${root}-retained`;
		try {
			await expect(
				publishOwnerDirectory(forkToken, finalPath, async () => {
					const receipt = publishDirectory(staged, finalPath);
					await fs.rename(originalRoot, retainedRoot);
					root = retainedRoot;
					await fs.mkdir(originalRoot, { mode: 0o700 });
					return receipt;
				}),
			).rejects.toMatchObject({ code: "authority_changed" });
			const actualLock = path.join(retainedRoot, "published-fork", ".gjc-owners", `${staged.headerId}.json.lock`);
			expect(await Bun.file(actualLock).exists()).toBe(true);
			code(() => getOwnerMembershipEvidence(forkToken), "participation_lost");
		} finally {
			if (root === retainedRoot) await fs.rm(originalRoot, { recursive: true, force: true });
		}
	});

	it("refuses replacement of the retained owner directory after rename", async () => {
		const { staged, forkToken, finalPath } = await preparedDirectory();
		const ownerDir = path.join(path.dirname(finalPath), ".gjc-owners");
		await expect(
			publishOwnerDirectory(forkToken, finalPath, async () => {
				const receipt = publishDirectory(staged, finalPath);
				await fs.rename(ownerDir, `${ownerDir}-retained`);
				await fs.mkdir(ownerDir, { mode: 0o700 });
				return receipt;
			}),
		).rejects.toMatchObject({ code: "authority_changed" });
		expect(await Bun.file(path.join(`${ownerDir}-retained`, `${staged.headerId}.json.lock`)).exists()).toBe(true);
		expect(await fs.readdir(ownerDir)).toEqual([]);
		code(() => getOwnerMembershipEvidence(forkToken), "participation_lost");
	});

	it("rejects non-sibling and aliased destinations before callback dispatch", async () => {
		const { staged, forkToken, finalPath } = await preparedDirectory();
		const alias = path.join(root, "alias");
		await fs.symlink(root, alias, "dir");
		let calls = 0;
		await expect(
			publishOwnerDirectory(forkToken, path.join(alias, "published-fork", "fork.jsonl"), async () => {
				calls++;
				return publishDirectory(staged, finalPath);
			}),
		).rejects.toMatchObject({ code: "invalid_owner_target" });
		expect(calls).toBe(0);
		expect(withOwnerPublicationSync(forkToken, () => "still private")).toBe("still private");
	});

	it("ordinary existing-root members cannot use directory publication", async () => {
		let called = false;
		await expect(
			publishOwnerDirectory(token, path.join(root, "other-final", "anything.jsonl"), async () => {
				called = true;
				return publishDirectory(old, next.transcriptPath);
			}),
		).rejects.toMatchObject({ code: "participation_lost" });
		expect(called).toBe(false);
		expect(withOwnerPublicationSync(token, () => 7)).toBe(7);
	});

	it("transfer uses fresh source bytes, not the original admission snapshot", async () => {
		await fs.appendFile(old.transcriptPath, "\n");
		const handle = reserveOwnerTransferSync(token, next);
		await fs.rename(old.transcriptPath, next.transcriptPath);
		expect(settleOwnerTransferSync(handle, "success")).toBe("moved");
		expect((await Bun.file(next.transcriptPath).text()).endsWith("\n\n")).toBe(true);
	});
});
