import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { LifecycleLedger } from "../../src/sdk/broker/lifecycle-ledger";
import { observeProcessIncarnation } from "../../src/sdk/broker/process-incarnation";
import { SessionIndex } from "../../src/sdk/broker/session-index";
import { createCooperativeOwnerInspectors, createNativeOwnerInspectors } from "../../src/sdk/native-ownership";
import {
	admitOwnerMembershipSync,
	captureOwnerTargetSync,
	getOwnerMembershipEvidence,
	retireOwnerMembershipSync,
} from "../../src/session/owner-group";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture(extra: unknown[] = []) {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-inspection-")));
	roots.push(root);
	const cwd = path.join(root, "project");
	await fs.mkdir(cwd);
	const file = path.join(root, "selected.jsonl");
	const entries = [
		{ type: "session", version: 5, id: "selected", cwd, timestamp: "2026-01-01T00:00:00.000Z" },
		...extra,
	];
	await Bun.write(file, entries.map(item => JSON.stringify(item)).join("\n") + "\n");
	const target = captureOwnerTargetSync({ transcriptPath: file, headerId: "selected" });
	return { root, cwd, file, target, agentDir: path.join(root, "agent") };
}

async function directRegistrationFixture() {
	const f = await fixture();
	await fs.mkdir(f.agentDir);
	const own = observeProcessIncarnation(process.pid);
	if (own.status !== "present") throw new Error("Expected exact live process identity");
	await new SessionIndex(f.agentDir).append({
		type: "host_registered",
		sessionId: f.target.headerId,
		locator: { cwd: f.cwd, worktreeRoot: null, stateRoot: f.agentDir },
		endpointGeneration: 0,
		pid: process.pid,
		processIncarnation: own.incarnation,
	});
	return f;
}

const changedIndex = { kind: "unknown_ownership", reason: "Index changed during authority observation." } as const;

describe("concrete read-only native ownership inspectors", () => {
	it("keeps missing independent authority sources observational without creating their directories", async () => {
		const f = await fixture();
		const before = await fs.readdir(f.root);
		const inspectors = createNativeOwnerInspectors(f);
		expect((await inspectors.inspectVetoes(f.target)).kind).toBe("clear");
		expect(await inspectors.readMarkers(f.target)).toMatchObject({
			kind: "absent",
			snapshotDigest: f.target.snapshotDigest,
			members: [],
		});
		expect(await fs.readdir(f.root)).toEqual(before);
		expect(await Bun.file(f.file).text()).toContain('"selected"');
	});

	it("shares real synchronous evidence for an absent first-write transcript without inventing membership", async () => {
		const f = await fixture();
		const target = captureOwnerTargetSync({ transcriptPath: path.join(f.root, "new.jsonl"), headerId: "new" });
		const inspectors = createCooperativeOwnerInspectors(f);
		expect(inspectors.inspectVetoes(target).kind).toBe("clear");
		expect(inspectors.readMarkers(target)).toMatchObject({
			kind: "absent",
			snapshotDigest: target.snapshotDigest,
			members: [],
		});
		expect(await fs.readdir(f.root)).toEqual(["project", "selected.jsonl"]);
	});

	it("treats malformed enrollment evidence and changed snapshots as unknown, not absent", async () => {
		const f = await fixture([
			{
				type: "custom",
				id: "invalid",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				customType: "gjc.owner_enroll",
				data: { v: 1 },
			},
		]);
		const inspectors = createNativeOwnerInspectors(f);
		expect((await inspectors.readMarkers(f.target)).kind).toBe("unknown");
		await Bun.write(
			f.file,
			(await Bun.file(f.file).text()) +
				JSON.stringify({
					type: "custom",
					id: "later",
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					customType: "ordinary",
				}) +
				"\n",
		);
		expect((await inspectors.readMarkers(f.target)).kind).toBe("unknown");
	});

	it("does not accept a live unindexed endpoint as permission to write, regardless of stale flag", async () => {
		const f = await fixture();
		await Bun.write(
			path.join(f.cwd, ".gjc", "state", "sdk", "selected.json"),
			JSON.stringify({ version: 1, sessionId: "selected", pid: process.pid, stale: true, url: "ws://127.0.0.1:1" }),
		);
		expect((await createNativeOwnerInspectors(f).inspectVetoes(f.target)).kind).toBe("unknown_ownership");
		expect(createCooperativeOwnerInspectors(f).inspectVetoes(f.target).kind).toBe("unknown_ownership");
	});

	it("preserves an unreadable or malformed endpoint as independent uncertainty", async () => {
		const f = await fixture();
		await Bun.write(path.join(f.cwd, ".gjc", "state", "sdk", "selected.json"), "{bad");
		expect((await createNativeOwnerInspectors(f).inspectVetoes(f.target)).kind).toBe("unknown_ownership");
	});

	for (const changedReads of [1, 2]) {
		it(`recaptures complete cooperative evidence after ${changedReads} concurrent index changes`, async () => {
			const f = await directRegistrationFixture();
			const readIndex = SessionIndex.readAuthorityRootsReadOnlySync;
			const proof = readIndex(f.agentDir, f.target.headerId);
			expect(proof.kind).toBe("resolved");
			if (proof.kind !== "resolved") throw new Error("Expected healthy real index");
			expect(proof.identities).toHaveLength(1);
			expect(proof.identities[0]?.pid).toBe(process.pid);
			let reads = 0;
			const index = vi.spyOn(SessionIndex, "readAuthorityRootsReadOnlySync").mockImplementation((...args) => {
				if (reads++ % (changedReads + 1) < changedReads) return changedIndex;
				return readIndex(...args);
			});
			const ledger = vi.spyOn(LifecycleLedger, "inspectOwnershipReadOnlySync");
			const inspectors = createCooperativeOwnerInspectors(f);
			const observed = inspectors.inspectVetoes(f.target);
			expect(observed.kind).toBe("clear");
			expect(observed.evidence[1]).toEqual(proof);
			expect(index).toHaveBeenCalledTimes(changedReads + 1);
			expect(ledger).toHaveBeenCalledTimes(changedReads + 1);
			const token = admitOwnerMembershipSync(
				f.target,
				{ kind: "cooperative" },
				{
					...inspectors,
					runtime: "sdk-native-ownership-test",
					capabilities: ["publication"],
				},
			);
			try {
				expect(getOwnerMembershipEvidence(token).memberKind).toBe("cooperative");
				// Admission independently recaptures before and under the original owner lock.
				expect(index).toHaveBeenCalledTimes(3 * (changedReads + 1));
				expect(ledger).toHaveBeenCalledTimes(3 * (changedReads + 1));
			} finally {
				retireOwnerMembershipSync(token);
			}
		});
	}

	it("refuses cooperative admission after three persistently changed index observations", async () => {
		const f = await directRegistrationFixture();
		const index = vi.spyOn(SessionIndex, "readAuthorityRootsReadOnlySync").mockReturnValue(changedIndex);
		const ledger = vi.spyOn(LifecycleLedger, "inspectOwnershipReadOnlySync");
		expect(() =>
			admitOwnerMembershipSync(
				f.target,
				{ kind: "cooperative" },
				{
					...createCooperativeOwnerInspectors(f),
					runtime: "sdk-native-ownership-test",
					capabilities: [],
				},
			),
		).toThrow("unknown_ownership");
		expect(index).toHaveBeenCalledTimes(3);
		expect(ledger).toHaveBeenCalledTimes(3);
	});

	for (const reason of [
		"Authority roots changed during observation.",
		"Authority index could not be read or revalidated.",
		"Index changed during authority observation. ",
	]) {
		it(`does not recapture other cooperative uncertainty: ${reason}`, async () => {
			const f = await directRegistrationFixture();
			const index = vi.spyOn(SessionIndex, "readAuthorityRootsReadOnlySync").mockReturnValue({
				kind: "unknown_ownership",
				reason,
			});
			expect(createCooperativeOwnerInspectors(f).inspectVetoes(f.target).kind).toBe("unknown_ownership");
			expect(index).toHaveBeenCalledTimes(1);
		});
	}

	it("preserves independent endpoint vetoes after a fresh positive index recapture", async () => {
		const f = await directRegistrationFixture();
		await Bun.write(path.join(f.agentDir, "sdk", "selected.json"), "{malformed");
		const index = vi.spyOn(SessionIndex, "readAuthorityRootsReadOnlySync").mockReturnValueOnce(changedIndex);
		const observed = createCooperativeOwnerInspectors(f).inspectVetoes(f.target);
		expect(observed.kind).toBe("unknown_ownership");
		expect(index).toHaveBeenCalledTimes(2);
		expect(observed.evidence[1]).toMatchObject({ kind: "resolved" });
	});

	it("never retries an independent ledger veto even when the index changed", async () => {
		const f = await directRegistrationFixture();
		await Bun.write(path.join(f.agentDir, "sdk", "lifecycle-ledger.jsonl"), "{malformed\n");
		const index = vi.spyOn(SessionIndex, "readAuthorityRootsReadOnlySync").mockReturnValue(changedIndex);
		const ledger = vi.spyOn(LifecycleLedger, "inspectOwnershipReadOnlySync");
		expect(createCooperativeOwnerInspectors(f).inspectVetoes(f.target).kind).toBe("legacy_lifecycle_ambiguous");
		expect(index).toHaveBeenCalledTimes(1);
		expect(ledger).toHaveBeenCalledTimes(1);
	});

	it("leaves native async index uncertainty non-retrying", async () => {
		const f = await directRegistrationFixture();
		const index = vi.spyOn(SessionIndex, "readAuthorityRootsReadOnly").mockResolvedValue(changedIndex);
		const syncIndex = vi.spyOn(SessionIndex, "readAuthorityRootsReadOnlySync");
		expect((await createNativeOwnerInspectors(f).inspectVetoes(f.target)).kind).toBe("unknown_ownership");
		expect(index).toHaveBeenCalledTimes(1);
		expect(syncIndex).not.toHaveBeenCalled();
	});
});
