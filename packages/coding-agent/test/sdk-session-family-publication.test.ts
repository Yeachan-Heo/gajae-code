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

const originalKey = `${SESSION_FAMILY_FORK_OPERATION}\u0000original-key`;
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

test("original-key lookup recovers publication without terminal receipt or reference rewrites", async () => {
	const { input, ownership, authority } = await materializedForkFixture();
	const reference = await ownership.publishForkAfterTeardown(input);
	await ownership.releaseAfterTeardown(input.root, async () => input.source.close());
	const familyFile = path.join(authority, "sdk", "sessions", "family-ownership.json");
	const journalFile = path.join(authority, "sdk", "lifecycle-ledger.jsonl");
	const beforeFamily = await Bun.file(familyFile).text();
	const beforeJournal = await Bun.file(journalFile).text();
	const beforeFiles = await fs.readdir(reference.sourceDirectory);
	expect(await new SessionFamilyOwnership(authority).lookupForkPublication(originalKey, "request")).toEqual({
		kind: "committed",
		reference,
		state: "awaiting_ready",
		retainedUncertainty: false,
	});
	expect(await Bun.file(familyFile).text()).toBe(beforeFamily);
	expect(await Bun.file(journalFile).text()).toBe(beforeJournal);
	expect(await fs.readdir(reference.sourceDirectory)).toEqual(beforeFiles);
});

test("lookup preserves historical publication after an admitted child continues", async () => {
	const { input, ownership, workspace, manager } = await materializedForkFixture();
	const reference = await ownership.publishForkAfterTeardown(input);
	await ownership.releaseAfterTeardown(input.root, async () => input.source.close());
	const next = await ownership.acquireRoot(workspace, reference.branchId);
	const capture = SessionManager.captureTranscriptReadOnly(manager.getSessionFile()!);
	if (capture.kind !== "captured") throw new Error("Missing child capture");
	const originalDigest = capture.snapshot.identity.sha256;
	const identity = capture.snapshot.identity;
	capture.snapshot.close();
	const opened = await SessionManager.openExistingStrict(
		identity,
		SessionManager.managedDestination(workspace, reference.managedAgentDir!),
	);
	if (opened.kind !== "opened") throw new Error("Missing admitted continuation");
	cleanups.push(async () => {
		await opened.manager.closeStrict();
	});
	opened.manager.appendMessage({ role: "user", content: "later continuation", timestamp: 1 });
	await ownership.releaseAfterTeardown(
		next,
		async () => {
			const outcome = await opened.manager.closeStrict();
			if (outcome.kind !== "closed") throw outcome.error;
		},
		() => opened.manager.captureClosedManagedTranscriptProof(),
	);
	const current = opened.manager.captureClosedManagedTranscriptProof();
	try {
		expect(current.identity.sha256).not.toBe(originalDigest);
	} finally {
		current.close();
	}
	expect(await ownership.lookupForkPublication(originalKey, "request")).toMatchObject({
		kind: "committed",
		reference: { branchId: reference.branchId, resourceId: reference.resourceId, anchor: reference.anchor },
		retainedUncertainty: false,
	});
});

test("absent, conflicting and uncommitted keys never authorize a new publication", async () => {
	const { ownership, authority, index } = await materializedForkFixture();
	const familyFile = path.join(authority, "sdk", "sessions", "family-ownership.json");
	const before = await Bun.file(familyFile).text();
	expect(await ownership.lookupForkPublication(`${SESSION_FAMILY_FORK_OPERATION}\u0000missing`, "request")).toEqual({
		kind: "not_found",
	});
	expect(await ownership.lookupForkPublication(originalKey, "different-request")).toEqual({
		kind: "identity_conflict",
	});
	expect(await ownership.lookupForkPublication(originalKey, "request")).toEqual({
		kind: "unresolved",
		sessionId: "reserved-child",
		state: "awaiting_ready",
	});
	expect(await Bun.file(familyFile).text()).toBe(before);
	await index.updateFamilyOwnershipWithLifecycle(async (_state, ledger) => {
		await ledger.transition("operation", "terminal_ok", {
			resultSessionId: "reserved-child",
			response: { ok: true },
		});
	});
	const afterTerminal = await Bun.file(familyFile).text();
	expect(await ownership.lookupForkPublication(originalKey, "request")).toEqual({
		kind: "unresolved",
		sessionId: "reserved-child",
		state: "terminal_ok",
	});
	expect(await Bun.file(familyFile).text()).toBe(afterTerminal);
});

test("unknown-key lookup does not bootstrap a missing authority directory", async () => {
	const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-family-lookup-"));
	roots.push(root);
	const authority = path.join(root, "absent");
	expect(await new SessionFamilyOwnership(authority).lookupForkPublication(originalKey, "request")).toEqual({
		kind: "not_found",
	});
	expect(await fs.readdir(root)).toEqual([]);
});

test("missing family state retains an existing key without bootstrapping or rerunning it", async () => {
	const { ownership, authority } = await materializedForkFixture();
	const directory = path.join(authority, "sdk", "sessions");
	await fs.rename(directory, `${directory}.retained`);
	const before = await fs.readdir(path.dirname(directory));
	expect(await ownership.lookupForkPublication(originalKey, "request")).toEqual({
		kind: "unresolved",
		sessionId: "reserved-child",
		state: "awaiting_ready",
	});
	expect(await fs.readdir(path.dirname(directory))).toEqual(before);
});

for (const damage of ["malformed", "torn-tail", "conflicting-history"] as const) {
	test(`lookup refuses ${damage} damaged history without recovery writes`, async () => {
		const { input, ownership, authority, index } = await materializedForkFixture();
		await ownership.publishForkAfterTeardown(input);
		const file = path.join(authority, "sdk", "lifecycle-ledger.jsonl");
		let suffix = damage === "malformed" ? "not-json\n" : '{"identity":"operation"';
		if (damage === "conflicting-history") {
			const changed = await index.readFamilyOwnershipWithLifecycle(async (_state, ledger) =>
				structuredClone(ledger.get("operation")!),
			);
			changed.familyFork!.owner.generation++;
			suffix = `${JSON.stringify(changed)}\n`;
		}
		await fs.appendFile(file, suffix);
		const before = await Bun.file(file).text();
		const files = await fs.readdir(path.dirname(file));
		await expect(ownership.lookupForkPublication(originalKey, "request")).rejects.toMatchObject({
			code: "uncertain",
		});
		expect(await Bun.file(file).text()).toBe(before);
		expect(await fs.readdir(path.dirname(file))).toEqual(files);
	});
}

test("a child ID without matching immutable lineage is not committed-key proof", async () => {
	const { input, ownership, index } = await materializedForkFixture();
	await ownership.publishForkAfterTeardown(input);
	await index.updateFamilyOwnership(async state => {
		state.branches.find(branch => branch.branchId === "reserved-child")!.resourceId = "unrelated-resource";
	});
	const before = await index.readFamilyOwnership(async state => structuredClone(state));
	await expect(ownership.lookupForkPublication(originalKey, "request")).rejects.toMatchObject({ code: "uncertain" });
	expect(await index.readFamilyOwnership(async state => state)).toEqual(before);
});

for (const fault of ["file-sync", "directory-sync", "file-close", "directory-close", "replacement"] as const) {
	test(`committed lookup refuses ${fault} without rewriting evidence`, async () => {
		const { input, ownership, authority } = await materializedForkFixture();
		await ownership.publishForkAfterTeardown(input);
		const file = path.join(authority, "sdk", "sessions", "family-ownership.json");
		const directory = path.dirname(file);
		const before = await Bun.file(file).text();
		const originalOpen = fs.open;
		let closes = 0;
		let fileCloses = 0;
		const open = vi.spyOn(fs, "open").mockImplementation(async (name, flags, mode) => {
			const handle = await originalOpen(name, flags, mode);
			if (name === file || name === directory) {
				const close = handle.close.bind(handle);
				handle.close = async () => {
					closes++;
					if (name === file) fileCloses++;
					await close();
					if ((name === file && fault === "file-close") || (name === directory && fault === "directory-close"))
						throw new Error("controlled metadata close uncertainty");
				};
				const sync = handle.sync.bind(handle);
				handle.sync = async () => {
					if ((name === file && fault === "file-sync") || (name === directory && fault === "directory-sync"))
						throw new Error("controlled metadata durability failure");
					await sync();
					if (name === file && fault === "replacement") {
						await fs.rename(file, `${file}.original`);
						await fs.copyFile(`${file}.original`, file);
					}
				};
			}
			return handle;
		});
		try {
			await expect(ownership.lookupForkPublication(originalKey, "request")).rejects.toMatchObject({
				code: "uncertain",
			});
			expect(closes).toBe(2);
			expect(fileCloses).toBe(1);
		} finally {
			open.mockRestore();
		}
		expect(await Bun.file(file).text()).toBe(before);
		if (fault === "replacement") expect(await Bun.file(`${file}.original`).text()).toBe(before);
	});
}

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
		const beforeLookup = await index.readFamilyOwnership(async state => structuredClone(state));
		const lookup = await ownership.lookupForkPublication(originalKey, "request");
		expect(lookup).toMatchObject(
			point === "after-rename"
				? { kind: "committed", retainedUncertainty: true, reference: { branchId: "reserved-child" } }
				: { kind: "unresolved", sessionId: "reserved-child" },
		);
		expect(await index.readFamilyOwnership(async state => state)).toEqual(beforeLookup);
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
