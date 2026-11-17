import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { createEmbeddedAgentSession } from "../../src/sdk/embedding";
import {
	consentEmbeddedDisconnect,
	currentEmbeddedResumeOperation,
	prepareEmbeddedDisconnect,
	reconcileEmbeddedResumeCheckpoint,
	terminateEmbeddedAgentSession,
} from "../../src/sdk/native-embedding";
import { adoptNativeRuntimeCommit, invokeNativeRuntime } from "../../src/sdk/native-lifecycle";
import { AuthStorage } from "../../src/session/auth-storage";
import { nativeResumeBinding } from "../../src/session/native-resume";
import { getOwnerMembershipEvidence } from "../../src/session/owner-group";
import { type CommittedSessionEvidence, consumeCommittedSessionEvidence } from "../../src/session/session-manager";
import { FileSessionStorage } from "../../src/session/session-storage";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(managed: boolean, expectedTerminal: "retired" | "retained_after_close" = "retired") {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-successor-")));
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd);
	const auth = await AuthStorage.create(path.join(agentDir, "auth.db"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	await auth.set(model.provider, { type: "api_key", key: "test-only-key" });
	await Bun.write(
		path.join(agentDir, "config.yml"),
		JSON.stringify({
			recipe: { enabled: false },
			compaction: { enabled: false },
			retry: { enabled: false },
			tools: { discoveryMode: "off" },
			modelRoles: { default: `${model.provider}/${model.id}` },
		}),
	);
	const opened = await createEmbeddedAgentSession({
		cwd,
		agentDir,
		authStorage: auth,
		model,
		storage: managed ? { managed: true } : { directory: path.join(root, "sessions") },
		native: { create: true, ownerPolicy: { kind: "exclusive_native" } },
		disableExtensionDiscovery: true,
		extensions: [],
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMcpAutoload: false,
		enableLsp: false,
		skipPythonPreflight: true,
		deferOptionalModelRefresh: true,
		deferMemoryBackendStartup: true,
		notificationHostModeSupported: false,
		sdkHostModeSupported: false,
		toolNames: ["read"],
	});
	if (opened.kind !== "opened") throw new Error(`Expected open, got ${opened.kind}`);
	opened.result.session.agent.streamFn = createMockModel({ handler: { content: ["answer"] } }).stream;
	cleanups.push(async () => {
		const session = opened.result.session;
		const manager = session.sessionManager;
		const op = currentEmbeddedResumeOperation(opened.handle);
		const immutable = structuredClone(op);
		const membership = manager.getOwnerMembership();
		const repaired = await reconcileEmbeddedResumeCheckpoint(opened.handle, { op, mode: "repairDurability" });
		if (expectedTerminal === "retained_after_close") {
			expect(repaired.receipt.debt.rewriteDebt).toBe(true);
			expect(repaired.receipt.outcome).toBe("unknown");
			expect(repaired.receipt.commitment.continueEligible).toBe(false);
		}
		const state = nativeResumeBinding(op);
		const proofs = [...state.proofs];
		const successions = [...state.publicationSuccessions];
		const preparation = await prepareEmbeddedDisconnect(opened.handle, op);
		if (!preparation.inventory) throw new Error("Missing inventory");
		expect(preparation.inventory.blockers).toEqual([]);
		const consent = consentEmbeddedDisconnect(opened.handle, preparation, {
			stopAndJoin: true,
			work: {
				inventory: preparation.inventory,
				targets: preparation.inventory.blockers.flatMap(blocker => (blocker.target ? [blocker.target] : [])),
			},
		});
		if (!consent) throw new Error("Missing consent");
		const terminated = await terminateEmbeddedAgentSession(opened.handle, { op, consent });
		expect(terminated.receipt.routing).toMatchObject({ action: "POST_READONLY" });
		expect(terminated.receipt.terminalDisposition.kind).toBe(expectedTerminal);
		if (expectedTerminal === "retained_after_close") {
			expect(terminated.receipt).toMatchObject({
				op: op.op,
				outcome: "unknown",
				debt: { rewriteDebt: true },
				commitment: { continueEligible: false },
				routing: { closeOutcome: "close_unknown" },
			});
			if (!state.error) throw new Error("Missing original unknown-publication error");
			expect(manager.getStrictCloseState()).toEqual({ kind: "close_unknown", error: state.error });
			expect(currentEmbeddedResumeOperation(opened.handle)).toBe(op);
			expect(op).toEqual(immutable);
			expect(state.proofs).toEqual(proofs);
			expect(state.publicationSuccessions).toEqual(successions);
			expect(manager.getOwnerMembership()).toBe(membership);
			if (!membership) throw new Error("Missing retained native owner");
			expect(getOwnerMembershipEvidence(membership).memberId).toBe(op.memberToken);
			// Unknown closure is not permission to delete owner/evidence files or
			// close shared auth storage while owned writes might remain possible.
			process.stderr.write(
				`Retained unknown-publication fixture: ${root}; close=close_unknown; resources=${session.getDisposeResourceState()}\n`,
			);
			return;
		}
		expect(manager.getStrictCloseState()).toEqual({ kind: "closed" });
		expect(session.getDisposeResourceState()).toBe("settled");
		auth.close();
		await fs.rm(root, { recursive: true, force: true });
	});
	return opened;
}

for (const managed of [true, false]) {
	describe(`native committed successors (${managed ? "managed" : "explicit"})`, () => {
		it("branches with an issuer-bound, immutable, one-shot receipt and admits the next turn", async () => {
			const opened = await fixture(managed);
			const session = opened.result.session;
			const manager = session.sessionManager;
			expect((await opened.runtime.prompt.prompt("first")).kind).toBe("applied");
			await session.waitForIdle();
			expect((await opened.runtime.prompt.prompt("second")).kind).toBe("applied");
			await session.waitForIdle();
			const user = manager.getBranch().find(entry => entry.type === "message" && entry.message.role === "user")!;
			const previousOp = currentEmbeddedResumeOperation(opened.handle);
			const previousMembership = manager.getOwnerMembership();
			let receipt: CommittedSessionEvidence | undefined;
			const commit = manager.commitPreparedNewSession.bind(manager);
			const spy = spyOn(manager, "commitPreparedNewSession").mockImplementation(prepared => {
				receipt = commit(prepared);
				expect(() => adoptNativeRuntimeCommit(session, { ...receipt! })).toThrow("context_mismatch");
				expect(Reflect.set(receipt, "targetLeafId", "forged-target")).toBe(false);
				expect(Reflect.set(receipt.successor, "generation", receipt.predecessor.generation)).toBe(false);
				return receipt;
			});
			try {
				expect((await opened.runtime.session.branch(user.id)).kind).toBe("applied");
			} finally {
				spy.mockRestore();
			}
			if (!receipt?.membership || !receipt.pending || !receipt.publication) throw new Error("Missing evidence");
			expect(receipt.manager).toBe(manager);
			expect(receipt.targetLeafId).toBe(user.parentId);
			expect(receipt.pending.plan.target).toBe(user.parentId);
			expect(receipt.successor.sessionId).toBe(session.sessionId);
			expect(receipt.successor.generation).toBe(receipt.predecessor.generation + 1);
			expect(Object.isFrozen(receipt)).toBe(true);
			expect(Object.isFrozen(receipt.successor)).toBe(true);
			expect(Object.isFrozen(receipt.publication)).toBe(true);
			expect(receipt.membership).not.toBe(previousMembership);
			expect(getOwnerMembershipEvidence(receipt.membership).policy.kind).toBe("exclusive_native");
			expect(currentEmbeddedResumeOperation(opened.handle)).toBe(receipt.pending);
			expect(currentEmbeddedResumeOperation(opened.handle)).not.toBe(previousOp);
			expect(consumeCommittedSessionEvidence(manager, receipt)).toBe(false);
			expect(consumeCommittedSessionEvidence(manager, { ...receipt })).toBe(false);
			expect(() => adoptNativeRuntimeCommit(session, receipt!)).toThrow("context_mismatch");
			expect(await opened.runtime.prompt.prompt("successor")).toMatchObject({ kind: "applied" });
			await session.waitForIdle();
		});

		it("preserves the original operation and member through real global preference publications and authorized retirement", async () => {
			const opened = await fixture(managed);
			const session = opened.result.session;
			const manager = session.sessionManager;
			expect((await opened.runtime.prompt.prompt("before selection")).kind).toBe("applied");
			await session.waitForIdle();
			const original = currentEmbeddedResumeOperation(opened.handle);
			const sessionId = session.sessionId;
			const file = manager.getSessionFile();
			const generation = manager.getSessionIdentityGeneration();
			const membership = manager.getOwnerMembership();
			const immutable = structuredClone(original);
			const state = nativeResumeBinding(original);
			for (const id of ["claude-haiku-4-5", "claude-sonnet-4-5"]) {
				const model = getBundledModel("anthropic", id);
				if (!model) throw new Error(`Missing model ${id}`);
				expect(await session.modelRegistry.getApiKey(model, session.credentialSessionId)).toBe("test-only-key");
				if (!file) throw new Error("Missing native transcript");
				const before = await fs.stat(file, { bigint: true });
				const earlierSuccessions = [...state.publicationSuccessions];
				const earlierProofs = [...state.proofs];
				expect(
					await opened.runtime.preferences.handle("model.select", {
						provider: model.provider,
						modelId: model.id,
						scope: "global",
					}),
				).toMatchObject({
					kind: "applied",
					value: { applied: true, application: "session", durability: "persisted" },
				});
				const after = await fs.stat(file, { bigint: true });
				expect(after.ino).not.toBe(before.ino);
				expect(state.publicationSuccessions.slice(0, earlierSuccessions.length)).toEqual(earlierSuccessions);
				const succession = state.publicationSuccessions.at(-1);
				if (!succession) throw new Error("Missing producer publication succession");
				expect(succession.predecessor.fileIdentity).toEqual({ dev: String(before.dev), ino: String(before.ino) });
				expect(succession.successor.fileIdentity).toEqual({ dev: String(after.dev), ino: String(after.ino) });
				expect(state.proofs.slice(0, earlierProofs.length)).toEqual(earlierProofs);
				expect(currentEmbeddedResumeOperation(opened.handle)).toBe(original);
				expect(original).toEqual(immutable);
				expect(manager.getOwnerMembership()).toBe(membership);
				const repaired = await reconcileEmbeddedResumeCheckpoint(opened.handle, {
					op: original,
					mode: "repairDurability",
				});
				expect(repaired.receipt.outcome).toBe("committed");
				expect(repaired.receipt.commitment.continueEligible).toBe(true);
				expect(repaired.receipt.commitment.dependentsMissing).toEqual([]);
			}
			expect(session.sessionId).toBe(sessionId);
			expect(manager.getSessionFile()).toBe(file);
			expect(manager.getSessionIdentityGeneration()).toBe(generation);
			expect(currentEmbeddedResumeOperation(opened.handle)).toBe(original);
			expect(await opened.runtime.prompt.prompt("after selection")).toMatchObject({ kind: "applied" });
			await session.waitForIdle();
		});

		it("indexes frozen parented entries without rewriting the captured source during global promotion", async () => {
			const opened = await fixture(managed);
			const manager = opened.result.session.sessionManager;
			const op = currentEmbeddedResumeOperation(opened.handle);
			const membership = manager.getOwnerMembership();
			const promote = manager.promoteDefaultModelSelection.bind(manager);
			let captured: string | undefined;
			const frozen = spyOn(manager, "promoteDefaultModelSelection").mockImplementation(stage => {
				expect(stage.entries.some(entry => entry.type !== "session" && entry.parentId !== null)).toBe(true);
				// Native cursor preparations are immutable. Exercise that boundary without
				// replacing the real staging, storage publication, or preference admission.
				for (const entry of stage.entries) Object.freeze(entry);
				captured = JSON.stringify(stage.entries);
				const result = promote(stage);
				expect(JSON.stringify(stage.entries)).toBe(captured);
				return result;
			});
			try {
				expect(
					await opened.runtime.preferences.handle("model.select", {
						provider: "anthropic",
						modelId: "claude-haiku-4-5",
						scope: "global",
					}),
				).toMatchObject({ kind: "applied", value: { applied: true } });
				expect(frozen).toHaveBeenCalledTimes(1);
				expect(currentEmbeddedResumeOperation(opened.handle)).toBe(op);
				expect(manager.getOwnerMembership()).toBe(membership);
				const repaired = await reconcileEmbeddedResumeCheckpoint(opened.handle, { op, mode: "repairDurability" });
				expect(repaired.receipt.outcome).toBe("committed");
				expect(repaired.receipt.commitment.continueEligible).toBe(true);
			} finally {
				frozen.mockRestore();
			}
		});

		it("refuses a byte-identical foreign inode without replacing the original publication evidence", async () => {
			const opened = await fixture(managed);
			const manager = opened.result.session.sessionManager;
			const op = currentEmbeddedResumeOperation(opened.handle);
			const state = nativeResumeBinding(op);
			const file = manager.getSessionFile();
			if (!file) throw new Error("Missing native transcript");
			expect(
				await opened.runtime.preferences.handle("model.select", {
					provider: "anthropic",
					modelId: "claude-haiku-4-5",
					scope: "global",
				}),
			).toMatchObject({ kind: "applied", value: { applied: true } });
			const proven = await reconcileEmbeddedResumeCheckpoint(opened.handle, { op, mode: "repairDurability" });
			expect(proven.receipt.commitment.continueEligible).toBe(true);
			const membership = manager.getOwnerMembership();
			const immutable = structuredClone(op);
			const successions = [...state.publicationSuccessions];
			const proofs = [...state.proofs];
			const bytes = await Bun.file(file).text();
			const retained = `${file}.retained-original`;
			await fs.rename(file, retained);
			await Bun.write(file, bytes);
			try {
				const refused = await reconcileEmbeddedResumeCheckpoint(opened.handle, { op, mode: "repairDurability" });
				expect(refused.receipt.outcome).toBe("unknown");
				expect(refused.receipt.commitment.continueEligible).toBe(false);
				expect(
					await opened.runtime.preferences.handle("model.select", {
						provider: "anthropic",
						modelId: "claude-sonnet-4-5",
						scope: "global",
					}),
				).toMatchObject({ kind: "refused", reason: "uncertain_cursor" });
				expect(currentEmbeddedResumeOperation(opened.handle)).toBe(op);
				expect(op).toEqual(immutable);
				expect(manager.getOwnerMembership()).toBe(membership);
				expect(state.publicationSuccessions).toEqual(successions);
				expect(state.proofs).toEqual(proofs);
				expect(await Bun.file(file).text()).toBe(bytes);
			} finally {
				// Restore the actual producer inode for authorized cleanup, not an inferred successor.
				await fs.rename(retained, file);
			}
		});

		it("retains producer succession and debt when fresh-handle durability repair fails", async () => {
			const opened = await fixture(managed);
			expect(await opened.runtime.prompt.prompt("persist before repair failure")).toMatchObject({ kind: "applied" });
			await opened.result.session.waitForIdle();
			const manager = opened.result.session.sessionManager;
			const op = currentEmbeddedResumeOperation(opened.handle);
			const state = nativeResumeBinding(op);
			expect(
				await opened.runtime.preferences.handle("model.select", {
					provider: "anthropic",
					modelId: "claude-haiku-4-5",
					scope: "global",
				}),
			).toMatchObject({ kind: "applied", value: { applied: true } });
			const successions = [...state.publicationSuccessions];
			const proofs = [...state.proofs];
			const ledger = [...state.ledger];
			const immutable = structuredClone(op);
			// The manager storage proxy returns fresh wrappers, so spy on the real
			// backend method and match only this fixture's transcript.
			const repair = FileSessionStorage.prototype.repairDurabilitySync;
			let faultEntries = 0;
			const failing = spyOn(FileSessionStorage.prototype, "repairDurabilitySync").mockImplementation(function (
				this: FileSessionStorage,
				file,
				expected,
				ranges,
				options,
			) {
				if (file === state.path) {
					faultEntries++;
					throw new Error("injected native durability sync failure");
				}
				return repair.call(this, file, expected, ranges, options);
			});
			try {
				const refused = await reconcileEmbeddedResumeCheckpoint(opened.handle, { op, mode: "repairDurability" });
				expect(faultEntries).toBeGreaterThan(0);
				expect(refused.receipt.commitment.continueEligible).toBe(false);
				expect(state.durabilityState).toBe("repair_failed");
				expect(state.lastError).toContain("injected native durability sync failure");
				expect(
					await opened.runtime.preferences.handle("model.select", {
						provider: "anthropic",
						modelId: "claude-sonnet-4-5",
						scope: "global",
					}),
				).toMatchObject({ kind: "refused" });
				expect(currentEmbeddedResumeOperation(opened.handle)).toBe(op);
				expect(op).toEqual(immutable);
				expect(state.publicationSuccessions).toEqual(successions);
				expect(state.proofs).toEqual(proofs);
				expect([...state.ledger]).toEqual(ledger);
			} finally {
				failing.mockRestore();
			}
			const repaired = await reconcileEmbeddedResumeCheckpoint(opened.handle, { op, mode: "repairDurability" });
			expect(repaired.receipt.outcome).toBe("committed");
			expect(repaired.receipt.commitment.continueEligible).toBe(true);
			const membership = manager.getOwnerMembership();
			if (!membership) throw new Error("Missing original membership");
			expect(getOwnerMembershipEvidence(membership).memberId).toBe(op.memberToken);
		});

		if (!managed)
			it("retains the original operation and proofs when real transcript replacement fails", async () => {
				const opened = await fixture(false, "retained_after_close");
				expect(await opened.runtime.prompt.prompt("persist before replacement failure")).toMatchObject({
					kind: "applied",
				});
				await opened.result.session.waitForIdle();
				const manager = opened.result.session.sessionManager;
				expect(manager.isManagedDestination()).toBe(false);
				const op = currentEmbeddedResumeOperation(opened.handle);
				const state = nativeResumeBinding(op);
				const file = manager.getSessionFile();
				const membership = manager.getOwnerMembership();
				const immutable = structuredClone(op);
				if (!file) throw new Error("Missing native transcript");
				const bytes = await Bun.file(file).text();
				let capturedProofs = [...state.proofs];
				const successions = [...state.publicationSuccessions];
				const failure = new Error("injected transcript replacement failure");
				const rename = FileSessionStorage.prototype.renameSync;
				let faultEntries = 0;
				const replacement = spyOn(FileSessionStorage.prototype, "renameSync").mockImplementation(function (
					this: FileSessionStorage,
					source,
					target,
				) {
					if (target === file) {
						faultEntries++;
						capturedProofs = [...state.proofs];
						throw failure;
					}
					rename.call(this, source, target);
				});
				const replaceExact = FileSessionStorage.prototype.replaceExactSync;
				const exactReplacement = spyOn(FileSessionStorage.prototype, "replaceExactSync").mockImplementation(
					function (this: FileSessionStorage, source, target, expected) {
						if (target === file) {
							faultEntries++;
							capturedProofs = [...state.proofs];
							throw failure;
						}
						return replaceExact.call(this, source, target, expected);
					},
				);
				const promotion = spyOn(manager, "promoteDefaultModelSelection");
				try {
					const selected = await opened.runtime.preferences.handle("model.select", {
						provider: "anthropic",
						modelId: "claude-haiku-4-5",
						scope: "global",
					});
					expect(faultEntries).toBeGreaterThan(0);
					expect(selected).toMatchObject({
						kind: "applied",
						value: { applied: false, application: "recovery-required", durability: "unknown" },
					});
					expect(promotion).toHaveBeenCalledTimes(1);
					const result = promotion.mock.results[0];
					if (result?.type !== "return") throw new Error("Missing real failed promotion result");
					expect(result.value).toMatchObject({ kind: "unknown", error: failure });
					const refused = await opened.runtime.preferences.handle("model.select", {
						provider: "anthropic",
						modelId: "claude-sonnet-4-5",
						scope: "global",
					});
					expect(refused).toMatchObject({
						kind: "refused",
						reconciliation: {
							receipt: {
								debt: { rewriteDebt: true },
								commitment: { continueEligible: false },
							},
						},
					});
					expect(promotion).toHaveBeenCalledTimes(1);
					expect(state.error).toBe(failure);
					expect(currentEmbeddedResumeOperation(opened.handle)).toBe(op);
					expect(op).toEqual(immutable);
					expect(manager.getOwnerMembership()).toBe(membership);
					expect(state.publicationSuccessions).toEqual(successions);
					expect(state.proofs).toEqual(capturedProofs);
					expect(await Bun.file(file).text()).toBe(bytes);
				} finally {
					promotion.mockRestore();
					exactReplacement.mockRestore();
					replacement.mockRestore();
				}
			});

		it("advances the immutable operation and binding after an authenticated move", async () => {
			const opened = await fixture(managed);
			const session = opened.result.session;
			const manager = session.sessionManager;
			expect((await opened.runtime.prompt.prompt("before move")).kind).toBe("applied");
			await session.waitForIdle();
			const previous = currentEmbeddedResumeOperation(opened.handle);
			const nextCwd = path.join(path.dirname(manager.getCwd()), "moved-project");
			await fs.mkdir(nextCwd);
			expect(await invokeNativeRuntime(opened.handle, "session", () => manager.moveTo(nextCwd))).toMatchObject({
				kind: "applied",
			});
			const current = currentEmbeddedResumeOperation(opened.handle);
			expect(current).not.toBe(previous);
			const owner = manager.getSessionOwnerEvidence();
			if (!owner) throw new Error("Missing moved owner");
			expect(current.authorityKey).toBe(owner.authorityKey);
			expect(current.policy.rev).toBe(owner.rev);
			expect((await opened.runtime.prompt.prompt("after move")).kind).toBe("applied");
			await session.waitForIdle();
		});

		it("forks the selected branch and retires the successor membership on authorized TERM", async () => {
			const opened = await fixture(managed);
			const session = opened.result.session;
			expect((await opened.runtime.prompt.prompt("first")).kind).toBe("applied");
			await session.waitForIdle();
			const oldId = session.sessionId;
			const target = session.sessionManager.getLeafId();
			expect((await opened.runtime.prompt.prompt("a later branch")).kind).toBe("applied");
			await session.waitForIdle();
			expect(session.sessionManager.getLeafId()).not.toBe(target);
			const forked = await invokeNativeRuntime(opened.handle, "session", () => {
				session.sessionManager.restorePresentationLeaf(target);
				return session.fork();
			});
			expect(forked.kind).toBe("applied");
			expect(forked.kind === "applied" && forked.value).toBe(true);
			expect(session.sessionId).not.toBe(oldId);
			expect(currentEmbeddedResumeOperation(opened.handle).plan.target).toBe(target);
			expect(await opened.runtime.prompt.prompt("forked")).toMatchObject({ kind: "applied" });
			await session.waitForIdle();
		});
	});
}
