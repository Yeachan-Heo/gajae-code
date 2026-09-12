import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	describeInstallRestore,
	type InstallDispatchAuthority,
	type InstallRepairDependencies,
	type RestoreCandidate,
	repairStandaloneBinary,
} from "../src/cli/doctor/install-repairs";
import {
	activationRecordPath,
	buildActivationRecord,
	createActivationRecordFile,
	snapshotDirectory,
	snapshotRegularFile,
} from "../src/cli/install-activation";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

const ELF_HEADER = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);

function digestOf(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

interface InstallFixture {
	root: string;
	target: string;
	candidatePath: string;
	candidateBytes: Buffer;
	candidateDigest: string;
	authority: InstallDispatchAuthority;
}
async function fixture(): Promise<InstallFixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-doctor-install-"));
	roots.push(root);
	const target = path.join(root, "gjc");
	const targetBytes = Buffer.concat([ELF_HEADER, Buffer.from("old-runtime")]);
	await fs.writeFile(target, targetBytes);
	const candidatePath = path.join(root, "candidate-source");
	const candidateBytes = Buffer.concat([ELF_HEADER, Buffer.from("new-runtime")]);
	await fs.writeFile(candidatePath, candidateBytes);
	// The dispatch authority proves ownership by resolving to the exact
	// currently-running compiled image path; simulate that by pointing the
	// authority at `target` itself so classifySource treats it as standalone.
	const authority: InstallDispatchAuthority = {
		compiled: true,
		selfPath: await fs.realpath(target),
		version: "1.2.3",
	};
	return { root, target, candidatePath, candidateBytes, candidateDigest: digestOf(candidateBytes), authority };
}

function candidateFor(f: InstallFixture): RestoreCandidate {
	return {
		ref: "v1.2.3",
		channel: "stable",
		sha256: f.candidateDigest,
		version: "1.2.3",
		os: process.platform,
		arch: process.arch,
	};
}

function fakeDeps(f: InstallFixture): InstallRepairDependencies {
	return {
		fetchCandidate: async (_candidate, stagingPath) => {
			await fs.copyFile(f.candidatePath, stagingPath);
		},
		verifyCandidate: async (stagingPath, candidate) => {
			const snapshot = await snapshotRegularFile(stagingPath);
			if (!snapshot || snapshot.identity.sha256 !== candidate.sha256) throw new Error("candidate_digest_mismatch");
		},
		smokeCandidate: async stagingPath => {
			const snapshot = await snapshotRegularFile(stagingPath);
			expect(snapshot?.header.subarray(0, 4)).toEqual(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]));
		},
	};
}

describe("doctor standalone install repair: describeInstallRestore", () => {
	it("returns a pure diagnostic descriptor that performs no filesystem mutation", async () => {
		const f = await fixture();
		const beforeBytes = await fs.readFile(f.target);
		const descriptor = await describeInstallRestore(f.target, f.authority, "stable", "v1.2.3");
		expect(descriptor.writes).toBe(false);
		expect(descriptor.fetch).toBe(false);
		expect(descriptor.execute).toBe(false);
		expect(descriptor.owned).toBe(true);
		expect(descriptor.sourceKind).toBe("standalone");
		expect(descriptor.targetIdentity?.sha256).toBe(digestOf(beforeBytes));
		expect(await fs.readFile(f.target)).toEqual(beforeBytes);
		expect(
			await fs
				.lstat(activationRecordPath(f.target))
				.then(() => true)
				.catch(() => false),
		).toBe(false);
	});

	it("never trusts an ELF/PE header alone as ownership proof", async () => {
		const f = await fixture();
		// Authority points somewhere else entirely: the target has a real ELF
		// header but is not the dispatched compiled image.
		const foreignAuthority: InstallDispatchAuthority = {
			compiled: true,
			selfPath: path.join(f.root, "not-the-target"),
			version: "1.2.3",
		};
		const descriptor = await describeInstallRestore(f.target, foreignAuthority, "stable", "v1.2.3");
		expect(descriptor.sourceKind).toBe("unknown");
		expect(descriptor.owned).toBe(false);
	});
});

describe("doctor standalone install repair: repairStandaloneBinary success", () => {
	it("stages, verifies, and publishes a pinned candidate via the shared activation authority", async () => {
		const f = await fixture();
		const descriptor = await describeInstallRestore(f.target, f.authority, "stable", "v1.2.3");
		const result = await repairStandaloneBinary(
			f.target,
			descriptor,
			candidateFor(f),
			["install-replace", "network", "external-execution"],
			fakeDeps(f),
		);
		expect(result.state).toBe("verified");
		expect(result.sideEffectStarted).toBe(true);
		expect((await fs.readFile(f.target)).equals(f.candidateBytes)).toBe(true);
		// Independent post-mutation read, not the mutation's own return value.
		const verified = await snapshotRegularFile(f.target);
		expect(verified?.identity.sha256).toBe(f.candidateDigest);
		// Old bytes are retained, never scrubbed.
		const recordSnapshot = await snapshotRegularFile(activationRecordPath(f.target));
		expect(recordSnapshot).toBeDefined();
		const record = JSON.parse(Buffer.from(await fs.readFile(activationRecordPath(f.target))).toString("utf8"));
		expect(record.phase).toBe("verified");
		const backupPath = path.join(f.root, record.backupName as string);
		const backupBytes = await fs.readFile(backupPath);
		expect(digestOf(backupBytes)).toBe(digestOf(Buffer.concat([ELF_HEADER, Buffer.from("old-runtime")])));
	});
});

describe("doctor standalone install repair: refusals", () => {
	it("refuses a target/ref/version channel mismatch before any staging", async () => {
		const f = await fixture();
		const descriptor = await describeInstallRestore(f.target, f.authority, "stable", "v1.2.3");
		const result = await repairStandaloneBinary(
			f.target,
			descriptor,
			{ ...candidateFor(f), channel: "nightly" },
			["install-replace", "network", "external-execution"],
			fakeDeps(f),
		);
		expect(result.state).toBe("blocked");
		expect(result.reason).toBe("candidate_provenance_mismatch");
		expect(result.sideEffectStarted).toBe(false);
	});

	it("refuses an integrity mismatch between the digest pin and the fetched bytes", async () => {
		const f = await fixture();
		const descriptor = await describeInstallRestore(f.target, f.authority, "stable", "v1.2.3");
		const badDigest = digestOf(Buffer.from("not the real candidate"));
		const result = await repairStandaloneBinary(
			f.target,
			descriptor,
			{ ...candidateFor(f), sha256: badDigest },
			["install-replace", "network", "external-execution"],
			fakeDeps(f),
		);
		expect(result.state).toBe("failed");
		expect(result.sideEffectStarted).toBe(true);
		expect(await fs.readFile(f.target)).toEqual(Buffer.concat([ELF_HEADER, Buffer.from("old-runtime")]));
	});

	it("refuses a ref mismatch against the observed descriptor pin", async () => {
		const f = await fixture();
		const descriptor = await describeInstallRestore(f.target, f.authority, "stable", "v9.9.9");
		const result = await repairStandaloneBinary(
			f.target,
			descriptor,
			candidateFor(f),
			["install-replace", "network", "external-execution"],
			fakeDeps(f),
		);
		expect(result.state).toBe("blocked");
		expect(result.reason).toBe("candidate_provenance_mismatch");
	});

	it("refuses a source-checkout or npm-wrapper target regardless of on-disk bytes", async () => {
		const f = await fixture();
		const foreignAuthority: InstallDispatchAuthority = {
			compiled: true,
			selfPath: path.join(f.root, "elsewhere"),
			version: "1.2.3",
		};
		const descriptor = await describeInstallRestore(f.target, foreignAuthority, "stable", "v1.2.3");
		const result = await repairStandaloneBinary(
			f.target,
			descriptor,
			candidateFor(f),
			["install-replace", "network", "external-execution"],
			fakeDeps(f),
		);
		expect(result.state).toBe("blocked");
		expect(result.reason).toBe("source_not_owned_standalone");
		expect(await fs.readFile(f.target)).toEqual(Buffer.concat([ELF_HEADER, Buffer.from("old-runtime")]));
	});

	it("refuses to publish when the target changed after the descriptor snapshot (target/parent race)", async () => {
		const f = await fixture();
		const descriptor = await describeInstallRestore(f.target, f.authority, "stable", "v1.2.3");
		// A concurrent writer replaces the target after the descriptor was captured.
		await fs.writeFile(f.target, Buffer.concat([ELF_HEADER, Buffer.from("raced-runtime")]));
		const result = await repairStandaloneBinary(
			f.target,
			descriptor,
			candidateFor(f),
			["install-replace", "network", "external-execution"],
			fakeDeps(f),
		);
		expect(result.state).toBe("conflict");
		expect(result.reason).toBe("target_or_parent_changed");
		expect(await fs.readFile(f.target)).toEqual(Buffer.concat([ELF_HEADER, Buffer.from("raced-runtime")]));
	});
});

describe("doctor standalone install repair: partial publication and retained old image", () => {
	it("reports failed and leaves the live target untouched when smoke verification rejects the candidate", async () => {
		const f = await fixture();
		const descriptor = await describeInstallRestore(f.target, f.authority, "stable", "v1.2.3");
		const deps: InstallRepairDependencies = {
			...fakeDeps(f),
			smokeCandidate: async () => {
				throw new Error("smoke_test_failed");
			},
		};
		const result = await repairStandaloneBinary(
			f.target,
			descriptor,
			candidateFor(f),
			["install-replace", "network", "external-execution"],
			deps,
		);
		expect(result.state).toBe("failed");
		expect(result.reason).toBe("smoke_test_failed");
		expect(result.sideEffectStarted).toBe(true);
		expect(await fs.readFile(f.target)).toEqual(Buffer.concat([ELF_HEADER, Buffer.from("old-runtime")]));
		// No activation record is left behind for a failure before the record was ever written.
		expect(
			await fs
				.lstat(activationRecordPath(f.target))
				.then(() => true)
				.catch(() => false),
		).toBe(false);
	});
});

describe("doctor standalone install repair: pending/retry conflict", () => {
	it("reconciles an interrupted staged transaction instead of starting a competing one", async () => {
		const f = await fixture();
		const descriptor = await describeInstallRestore(f.target, f.authority, "stable", "v1.2.3");
		const stagingPath = `${f.target}.restore.interrupted`;
		await fs.copyFile(f.candidatePath, stagingPath);
		const stagingSnapshot = await snapshotRegularFile(stagingPath);
		const parentIdentity = await snapshotDirectory(f.root);
		const pendingCandidate = candidateFor(f);
		const record = buildActivationRecord({
			targetPath: f.target,
			targetIdentity: descriptor.targetIdentity!,
			parentIdentity: parentIdentity!,
			baselineDigest: descriptor.targetDigest,
			stagingPath,
			stagingIdentity: stagingSnapshot!.identity,
			candidate: {
				digest: pendingCandidate.sha256,
				version: pendingCandidate.version,
				channel: pendingCandidate.channel,
				ref: pendingCandidate.ref,
				os: pendingCandidate.os,
				arch: pendingCandidate.arch,
			},
		});
		await createActivationRecordFile(record);

		const result = await repairStandaloneBinary(
			f.target,
			descriptor,
			candidateFor(f),
			["install-replace", "network", "external-execution"],
			fakeDeps(f),
		);
		expect(result.state).toBe("verified");
		expect((await fs.readFile(f.target)).equals(f.candidateBytes)).toBe(true);
	});

	it("refuses a source-wrapper target even under an otherwise valid candidate", async () => {
		const f = await fixture();
		const wrapperTarget = path.join(f.root, "gjc.cmd");
		await fs.writeFile(wrapperTarget, "@echo wrapper");
		const descriptor = await describeInstallRestore(wrapperTarget, f.authority, "stable", "v1.2.3");
		expect(descriptor.sourceKind).toBe("npm-wrapper");
		const result = await repairStandaloneBinary(
			wrapperTarget,
			descriptor,
			candidateFor(f),
			["install-replace", "network", "external-execution"],
			fakeDeps(f),
		);
		expect(result.state).toBe("blocked");
		expect(result.reason).toBe("source_not_owned_standalone");
	});
});

describe("doctor standalone install repair: authorization", () => {
	it("blocks without every required risk-class authorization", async () => {
		const f = await fixture();
		const descriptor = await describeInstallRestore(f.target, f.authority, "stable", "v1.2.3");
		const result = await repairStandaloneBinary(
			f.target,
			descriptor,
			candidateFor(f),
			["install-replace"],
			fakeDeps(f),
		);
		expect(result.state).toBe("blocked");
		expect(result.reason).toBe("authorization_missing");
		expect(result.sideEffectStarted).toBe(false);
	});
});
