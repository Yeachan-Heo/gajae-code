import { afterEach, expect, test, vi } from "bun:test";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SESSION_FAMILY_FORK_OPERATION } from "../src/sdk/broker/lifecycle-ledger";
import { SessionIndex } from "../src/sdk/broker/session-index";
import {
	describeClosedFamilyForkTranscript,
	type PublishSessionFamilyForkInput,
	SessionFamilyOwnership,
} from "../src/sdk/session-family-ownership";
import { SessionFamilyRegistry } from "../src/sdk/session-family-registry";
import type { SessionFamilyForkBinding } from "../src/sdk/session-family-state";
import { SessionManager } from "../src/session/session-manager";

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function materializedForkFixture(contentDigest?: string) {
	const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-family-publication-"));
	roots.push(root);
	const workspace = path.join(root, "workspace");
	const authority = path.join(root, "authority");
	await fs.mkdir(workspace);
	const ownership = new SessionFamilyOwnership(authority);
	const sourceFile = path.join(workspace, "source.jsonl");
	const sourceText = `${[
		{ type: "session", version: 5, id: "source", cwd: workspace, timestamp: new Date(0).toISOString() },
		{
			type: "message",
			id: "head",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: { role: "user", content: "source history", timestamp: 0 },
		},
	]
		.map(record => JSON.stringify(record))
		.join("\n")}\n`;
	await Bun.write(sourceFile, sourceText);
	const registry = new SessionFamilyRegistry(authority);
	const source = await registry.registerExisting({
		sessionFile: sourceFile,
		sourceDirectory: workspace,
		expectedSessionId: "source",
		expectedCwd: workspace,
		storage: "explicit",
	});
	const capture = SessionManager.captureTranscriptStrict(sourceFile);
	if (capture.kind !== "captured") throw new Error("Missing source capture");
	cleanups.push(async () => capture.snapshot.close());
	const owner = await ownership.acquireRoot(workspace, source.branchId);
	const child = await ownership.reserveChild(owner, "reserved-child");
	await ownership.activateChild(child);
	const agentDir = path.join(root, "agent");
	const destinationDirectory = SessionManager.getDefaultSessionDirReadOnly(workspace, agentDir);
	const index = new SessionIndex(authority);
	await index.updateFamilyOwnershipWithLifecycle(async (state, ledger) => {
		const rootRecord = state.roots.find(candidate => candidate.id === owner.id)!;
		const binding: SessionFamilyForkBinding = {
			version: 1,
			owner: { rootId: owner.id, generation: owner.generation, actor: rootRecord.actor },
			source,
			anchor: {
				entryId: "head",
				capturedDigest: capture.snapshot.identity.sha256,
				inclusionMode: "complete-committed-snapshot",
			},
			destination: {
				resourceId: "reserved-resource",
				sourceDirectory: destinationDirectory,
				managedAgentDir: agentDir,
				workspace: child.workspace,
			},
		};
		await ledger.begin("operation", "request", {
			operationKey: `${SESSION_FAMILY_FORK_OPERATION}\u0000original-key`,
			fingerprint: "source-head-destination",
			intendedSessionId: child.sessionId,
			familyFork: binding,
		});
		await ledger.transition("operation", "effect_started");
	});
	await expect(fs.lstat(agentDir)).rejects.toMatchObject({ code: "ENOENT" });
	const fork = await SessionManager.forkFromCaptured(
		capture.snapshot,
		workspace,
		SessionManager.managedDestination(workspace, agentDir),
		"copy-retain",
		"shadow",
		{ sessionId: child.sessionId },
	);
	if (fork.kind !== "forked") throw new Error("Missing managed child");
	const manager = fork.manager;
	cleanups.push(async () => {
		await manager.closeStrict();
	});
	expect(await manager.closeStrict()).toEqual({ kind: "closed" });
	const proof = manager.captureClosedManagedTranscriptProof();
	let receipt: { identityDigest: string; contentDigest: string };
	try {
		receipt = { ...describeClosedFamilyForkTranscript(proof) };
	} finally {
		proof.close();
	}
	if (contentDigest !== undefined) receipt.contentDigest = contentDigest;
	await index.updateFamilyOwnershipWithLifecycle(async (_state, ledger) => {
		await ledger.transition("operation", "awaiting_ready", { durableEffects: { transcript: receipt } });
	});
	const input: PublishSessionFamilyForkInput = {
		root: owner,
		child,
		operationIdentity: "operation",
		requestHash: "request",
		source: capture.snapshot,
		teardown: async () => {
			const outcome = await manager.closeStrict();
			if (outcome.kind !== "closed") throw outcome.error;
		},
		captureTranscript: () => manager.captureClosedManagedTranscriptProof(),
	};
	return { root, workspace, authority, ownership, input, manager, index, registry, source, sourceFile, sourceText };
}

test("publishes reference and lineage only after actual inactive-child teardown", async () => {
	const context = await materializedForkFixture();
	const { input, index, ownership, workspace, authority, sourceFile, sourceText, registry } = context;
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const teardown = input.teardown;
	input.teardown = async () => {
		entered.resolve();
		await finish.promise;
		await teardown();
	};
	const pending = ownership.publishForkAfterTeardown(input);
	void pending.catch(error => entered.reject(error));
	await entered.promise;
	try {
		const waiting = await index.readFamilyOwnership(async state => state);
		expect(waiting.branches.map(branch => branch.branchId)).toEqual(["source"]);
		expect(waiting.roots[0]!.children[0]!.phase).toBe("active");
		await expect(new SessionFamilyOwnership(authority).acquireRoot(workspace)).rejects.toMatchObject({
			code: "busy_workspace",
		});
	} finally {
		finish.resolve();
	}
	const reference = await pending;
	expect(reference).toMatchObject({
		familyId: "source",
		branchId: "reserved-child",
		resourceId: "reserved-resource",
		parentBranchId: "source",
		anchor: { entryId: "head", inclusionMode: "complete-committed-snapshot" },
	});
	await index.readFamilyOwnershipWithLifecycle(async (state, ledger) => {
		expect(state.branches).toContainEqual(reference);
		expect(state.roots[0]!.children[0]!.phase).toBe("closed");
		// The family replacement, not a separate terminal journal append, is commit.
		expect(ledger.get("operation")?.state).toBe("awaiting_ready");
	});
	expect(await Bun.file(sourceFile).text()).toBe(sourceText);
	await ownership.releaseAfterTeardown(input.root, async () => input.source.close());
	expect((await registry.listForWorkspace(workspace)).map(branch => branch.branchId).sort()).toEqual([
		"reserved-child",
		"source",
	]);
});

for (const change of ["root-draining", "reservation-terminal", "journal-quarantine"] as const) {
	test(`rechecks ${change} after awaited teardown without publishing`, async () => {
		const { input, ownership, index, authority } = await materializedForkFixture();
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const teardown = input.teardown;
		let captures = 0;
		input.teardown = async () => {
			entered.resolve();
			await finish.promise;
			await teardown();
		};
		const capture = input.captureTranscript;
		input.captureTranscript = () => {
			captures++;
			return capture();
		};
		const pending = ownership.publishForkAfterTeardown(input);
		void pending.catch(error => entered.reject(error));
		await entered.promise;
		try {
			if (change === "root-draining") {
				await expect(ownership.releaseAfterTeardown(input.root, async () => {})).rejects.toMatchObject({
					code: "uncertain",
				});
			} else if (change === "reservation-terminal") {
				await index.updateFamilyOwnershipWithLifecycle(async (_state, ledger) => {
					await ledger.transition("operation", "terminal_error", { response: { ok: false } });
				});
			} else {
				await Bun.write(
					path.join(authority, "sdk", "lifecycle-ledger.jsonl.corrupt.1"),
					"unattributable prior evidence\n",
				);
			}
		} finally {
			finish.resolve();
		}
		await expect(pending).rejects.toMatchObject({ code: "uncertain" });
		expect(captures).toBe(0);
		const state = await index.readFamilyOwnership(async state => state);
		expect(state.branches.map(branch => branch.branchId)).toEqual(["source"]);
		expect(state.roots[0]!.phase).toBe("uncertain");
		expect(state.roots[0]!.children[0]!.phase).toBe("uncertain");
	});
}

test("copied capabilities and mismatched requests cannot dispatch fork teardown", async () => {
	const { input, ownership, index } = await materializedForkFixture();
	let calls = 0;
	const before = await index.readFamilyOwnership(async state => structuredClone(state));
	const teardown = async () => {
		calls++;
	};
	await expect(
		ownership.publishForkAfterTeardown({ ...input, root: { ...input.root }, teardown }),
	).rejects.toMatchObject({ code: "stale_reference" });
	await expect(
		ownership.publishForkAfterTeardown({ ...input, requestHash: "another-request", teardown }),
	).rejects.toMatchObject({ code: "stale_reference" });
	expect(calls).toBe(0);
	expect(await index.readFamilyOwnership(async state => state)).toEqual(before);
});

test("refuses a closed child whose receipt does not match the original materialization", async () => {
	const { input, ownership, index } = await materializedForkFixture("0".repeat(64));
	await expect(ownership.publishForkAfterTeardown(input)).rejects.toMatchObject({ code: "uncertain" });
	const state = await index.readFamilyOwnership(async state => state);
	expect(state.branches.map(branch => branch.branchId)).toEqual(["source"]);
	expect(state.roots[0]!.phase).toBe("uncertain");
});

test("a structurally copied closed proof cannot publish a branch", async () => {
	const { input, ownership, index, manager } = await materializedForkFixture();
	const proof = manager.captureClosedManagedTranscriptProof();
	let fakeCloses = 0;
	input.captureTranscript = () => ({
		...proof,
		close: () => {
			fakeCloses++;
		},
	});
	try {
		await expect(ownership.publishForkAfterTeardown(input)).rejects.toMatchObject({ code: "uncertain" });
		expect(fakeCloses).toBe(0);
		expect((await index.readFamilyOwnership(async state => state)).branches.map(branch => branch.branchId)).toEqual([
			"source",
		]);
	} finally {
		proof.close();
	}
});

test("unknown proof closure prevents publication and is never redispatched", async () => {
	const { input, ownership, index, manager } = await materializedForkFixture();
	const originalClose = syncFs.closeSync;
	let descriptor = -1;
	let attempts = 0;
	const close = vi.spyOn(syncFs, "closeSync").mockImplementation(fd => {
		originalClose(fd);
		if (fd === descriptor) {
			attempts++;
			throw new Error("controlled proof close uncertainty");
		}
	});
	input.captureTranscript = () => {
		const proof = manager.captureClosedManagedTranscriptProof();
		const stat = vi.spyOn(syncFs, "fstatSync");
		try {
			expect(proof.revalidate()).toEqual({ kind: "valid" });
			descriptor = stat.mock.calls[0]![0];
		} finally {
			stat.mockRestore();
		}
		return proof;
	};
	try {
		await expect(ownership.publishForkAfterTeardown(input)).rejects.toMatchObject({ code: "uncertain" });
		expect(attempts).toBe(1);
		const state = await index.readFamilyOwnership(async state => state);
		expect(state.branches.map(branch => branch.branchId)).toEqual(["source"]);
		expect(state.roots[0]!.phase).toBe("uncertain");
	} finally {
		close.mockRestore();
	}
});

for (const point of ["before-rename", "after-rename"] as const) {
	test(`family publication remains whole and fenced after ${point} failure`, async () => {
		const { input, ownership, index } = await materializedForkFixture();
		const rename = fs.rename;
		let dispatched = false;
		const fault = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (!dispatched && path.basename(String(to)) === "family-ownership.json") {
				dispatched = true;
				if (point === "after-rename") await rename(from, to);
				throw new Error("controlled family publication uncertainty");
			}
			await rename(from, to);
		});
		try {
			await expect(ownership.publishForkAfterTeardown(input)).rejects.toMatchObject({ code: "uncertain" });
		} finally {
			fault.mockRestore();
		}
		expect(dispatched).toBe(true);
		await index.readFamilyOwnershipWithLifecycle(async (state, ledger) => {
			expect(state.roots[0]!.phase).toBe("uncertain");
			expect(state.roots[0]!.children[0]!.phase).toBe("uncertain");
			expect(ledger.get("operation")?.state).toBe("awaiting_ready");
			if (point === "before-rename") expect(state.branches.map(branch => branch.branchId)).toEqual(["source"]);
			else
				expect(state.branches.find(branch => branch.branchId === "reserved-child")).toMatchObject({
					familyId: "source",
					resourceId: "reserved-resource",
					parentBranchId: "source",
					anchor: { entryId: "head", inclusionMode: "complete-committed-snapshot" },
				});
		});
	});
}

for (const fault of ["teardown", "source-replacement", "child-replacement"] as const) {
	test(`retains uncertainty without publishing after ${fault}`, async () => {
		const { input, ownership, index, sourceFile, manager, authority, workspace } = await materializedForkFixture();
		const childFile = manager.getSessionFile()!;
		const childText = await Bun.file(childFile).text();
		if (fault === "teardown")
			input.teardown = async () => {
				throw new Error("retained child work failed");
			};
		else {
			const file = fault === "source-replacement" ? sourceFile : childFile;
			await fs.rename(file, `${file}.original`);
			await fs.copyFile(`${file}.original`, file);
		}
		await expect(ownership.publishForkAfterTeardown(input)).rejects.toMatchObject({ code: "uncertain" });
		const state = await index.readFamilyOwnership(async state => state);
		expect(state.branches.map(branch => branch.branchId)).toEqual(["source"]);
		expect(state.roots[0]!.phase).toBe("uncertain");
		expect(state.roots[0]!.children[0]!.phase).toBe("uncertain");
		expect(await Bun.file(childFile).text()).toBe(childText);
		await expect(new SessionFamilyOwnership(authority).acquireRoot(workspace)).rejects.toMatchObject({
			code: "uncertain",
		});
	});
}
