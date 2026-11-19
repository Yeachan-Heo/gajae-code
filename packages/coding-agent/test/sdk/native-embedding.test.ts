import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import * as sync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { LifecycleLedger } from "../../src/sdk/broker/lifecycle-ledger";
import { createEmbeddedAgentSession } from "../../src/sdk/embedding";
import {
	attestEmbeddedLegacyTakeover,
	consentEmbeddedDisconnect,
	currentEmbeddedResumeOperation,
	prepareEmbeddedDisconnect,
	reconcileEmbeddedResumeCheckpoint,
	resolveEmbeddedResumeCheckpoint,
	resumeEmbeddedAgentSession,
	terminateEmbeddedAgentSession,
} from "../../src/sdk/native-embedding";
import {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
} from "../../src/sdk/session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { FileSessionStorage, type SessionNoReplacePublicationReceipt } from "../../src/session/session-storage";

const roots: string[] = [];
const authStores: AuthStorage[] = [];
afterEach(async () => {
	for (const auth of authStores.splice(0)) auth.close();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture(entries: unknown[]) {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-admission-")));
	roots.push(root);
	const cwd = path.join(root, "project");
	await fs.mkdir(cwd);
	const file = path.join(root, "selected.jsonl");
	await Bun.write(
		file,
		[{ type: "session", version: 5, id: "selected", cwd, timestamp: "2026-01-01T00:00:00.000Z" }, ...entries]
			.map(entry => JSON.stringify(entry))
			.join("\n") + "\n",
	);
	const resolution = resolveEmbeddedResumeCheckpoint(file);
	if (resolution.kind !== "resolved") throw new Error(`Unexpected fixture: ${resolution.reason}`);
	return { root, cwd, file, agentDir: path.join(root, "agent"), resolution };
}
const user = (id: string, parentId: string | null) => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-01-01T00:00:00.000Z",
	message: { role: "user", content: id, timestamp: 1 },
});

describe("captured fresh native SDK fork", () => {
	for (const scenario of ["explicit non-tail", "managed null", "explicit without cursors"] as const) {
		it.skipIf(process.platform === "win32")(`opens ${scenario} from its one actual no-replace write`, async () => {
			const managed = scenario === "managed null";
			const history = managed
				? Array.from({ length: 257 }, (_, i) => user(`u${i}`, null))
				: scenario === "explicit non-tail"
					? [user("a", null), user("b", "a")]
					: [user("a", null)];
			const f = await fixture(history);
			const runtimeOptions = await forkRuntimeOptions(f);
			const directory = managed ? SessionManager.managedDestination(f.cwd, f.agentDir).directory : f.root;
			const file = managed ? path.join(directory, path.basename(f.file)) : f.file;
			if (managed) {
				await fs.rename(f.file, file);
				await fs.chmod(file, 0o600);
			}
			const original = await Bun.file(file).text();
			let reservedFile: string | undefined;
			let reservedId: string | undefined;
			let firstBytes: string | undefined;
			let issued: SessionNoReplacePublicationReceipt | undefined;
			let publications = 0;
			let factories = 0;
			const openStagedWriter = FileSessionStorage.prototype.openStagedWriter;
			const stagedWriter = spyOn(FileSessionStorage.prototype, "openStagedWriter").mockImplementation(function (
				this: FileSessionStorage,
				file,
				options,
			) {
				const staged = openStagedWriter.call(this, file, options);
				if (file === reservedFile) {
					const publish = staged.publishNoReplace.bind(staged);
					staged.publishNoReplace = () => {
						publications++;
						issued = publish();
						firstBytes = sync.readFileSync(file, "utf8");
						return issued;
					};
				}
				return staged;
			});
			const opened = await createEmbeddedAgentSession({
				...runtimeOptions,
				storage: managed ? { managed: true } : { directory },
				native: {
					create: true,
					ownerPolicy: { kind: "exclusive_native" },
					fork: {
						file,
						selection: {
							snapshotDigest: f.resolution.checkpoint.snapshotDigest,
							targetLeafId: managed ? null : "a",
						},
						reserveSelectedForkTranscript: async identity => {
							expect(reservedFile).toBeUndefined();
							expect(identity.role).toBe("staging");
							expect(path.dirname(identity.file)).toBe(directory);
							expect(sync.existsSync(identity.file)).toBe(false);
							expect(sync.existsSync(ownerRecord(directory, identity.sessionId))).toBe(false);
							reservedFile = identity.file;
							reservedId = identity.sessionId;
						},
					},
				},
				createSession: async options => {
					factories++;
					expect(options.sessionManager?.getSessionOwnerEvidence()?.policy.kind).toBe("exclusive_native");
					expect(options.sessionManager?.getSessionFile()).toBe(reservedFile);
					expect(publications).toBe(1);
					return createAgentSession(options);
				},
			}).finally(() => stagedWriter.mockRestore());
			if (opened.kind !== "opened" || !reservedFile || !issued || firstBytes === undefined)
				throw new Error(`Expected one actual native fork open: ${JSON.stringify(opened)}`);
			const { handle, op, selection } = opened;
			const manager = opened.result.session.sessionManager;
			const owner = manager.getSessionOwnerEvidence();
			expect(factories).toBe(1);
			expect(publications).toBe(1);
			expect(currentEmbeddedResumeOperation(handle)).toBe(op);
			expect(op).toMatchObject({
				memberToken: owner?.memberId,
				authorityKey: owner?.authorityKey,
				epoch: owner?.epoch,
			});
			expect(selection.receipt.routing.action).toBe("PROCEED");
			expect(selection.receipt.durability.proof).toMatchObject({
				op: op.op,
				publicationId: issued.publicationId,
				namespaceSynced: true,
				snapshotDigest: issued.sha256,
				initialPublication: { canonicalPath: reservedFile, headerId: reservedId, predecessor: "absent" },
			});
			const bytes = await Bun.file(reservedFile).text();
			expect(bytes).toBe(firstBytes);
			const [header, ...rows] = bytes
				.trimEnd()
				.split("\n")
				.map(row => JSON.parse(row));
			expect(header).toMatchObject({ type: "session", id: reservedId, parentSession: "selected" });
			expect(rows.slice(0, history.length)).toEqual(history);
			const [marker, ...cursors] = rows.slice(history.length);
			expect(marker).toMatchObject({
				id: op.plan.enroll,
				parentId: managed ? null : "a",
				customType: "gjc.owner_enroll",
				data: { bind: reservedId, member: op.memberToken, epoch: op.epoch, runtime: "embedded_native" },
			});
			expect(cursors).toHaveLength(managed ? 2 : scenario === "explicit non-tail" ? 1 : 0);
			expect(op.plan.cursorIds).toEqual(cursors.map(cursor => cursor.id));
			for (const [idx, cursor] of cursors.entries())
				expect(cursor).toMatchObject({
					customType: "gjc.resume_cursor",
					data: { op: op.op, idx, reason: "fork_init" },
				});
			expect(op.manifest.map(entry => entry.id)).toEqual(rows.slice(history.length).map(entry => entry.id));
			expect(resolveEmbeddedResumeCheckpoint(reservedFile)).toMatchObject({
				kind: "resolved",
				checkpoint: { leafEntryId: op.CB, conversationLeafId: managed ? null : "a" },
			});
			expect(await Bun.file(file).text()).toBe(original);
			expect(sync.existsSync(ownerRecord(path.dirname(file), "selected"))).toBe(false);
			expect(() => opened.result.session.dispose({ strictCloseAttempts: 1 })).toThrow(
				"Native disposal requires registry termination authorization",
			);
			const preparation = await prepareEmbeddedDisconnect(handle, op);
			if (!preparation.inventory) throw new Error("Missing native owned-work inventory");
			const consent = consentEmbeddedDisconnect(handle, preparation, {
				stopAndJoin: true,
				work: { inventory: preparation.inventory, targets: [] },
			});
			if (!consent) throw new Error("Missing registry termination consent");
			const final = await terminateEmbeddedAgentSession(handle, { op, consent });
			expect(final.receipt.terminalDisposition.kind).toBe("retired");
			expect(await Bun.file(file).text()).toBe(original);
		});
	}

	it.skipIf(process.platform === "win32")(
		"refuses a changed source or occupied reservation without claiming the name",
		async () => {
			for (const scenario of ["source ancestor", "foreign occupant"] as const) {
				const f = await fixture([user("a", null)]);
				const sourceDir = path.join(f.root, "source");
				await fs.mkdir(sourceDir);
				const file = path.join(sourceDir, "selected.jsonl");
				await fs.rename(f.file, file);
				const bytes = await Bun.file(file).text();
				let reservedFile: string | undefined;
				let reservedId: string | undefined;
				let factories = 0;
				const result = await createEmbeddedAgentSession({
					cwd: f.cwd,
					agentDir: f.agentDir,
					storage: { directory: f.root },
					native: {
						create: true,
						ownerPolicy: { kind: "exclusive_native" },
						fork: {
							file,
							reserveSelectedForkTranscript: async ({ file, sessionId }) => {
								reservedFile = file;
								reservedId = sessionId;
								if (scenario === "foreign occupant") await Bun.write(file, "foreign\n");
								else {
									await fs.rename(sourceDir, `${sourceDir}-original`);
									await fs.mkdir(sourceDir);
									await Bun.write(path.join(sourceDir, "selected.jsonl"), bytes);
								}
							},
						},
					},
					createSession: async () => {
						factories++;
						throw new Error("Factory must not run");
					},
				});
				expect(result).toMatchObject({
					kind: "refused",
					reason: scenario === "source ancestor" ? "identity-mismatch" : "destination_unavailable",
				});
				if (!reservedFile || !reservedId) throw new Error("Missing reservation");
				expect(factories).toBe(0);
				expect(sync.existsSync(ownerRecord(f.root, reservedId))).toBe(false);
				if (scenario === "foreign occupant") expect(await Bun.file(reservedFile).text()).toBe("foreign\n");
				else expect(sync.existsSync(reservedFile)).toBe(false);
				expect(await Bun.file(file).text()).toBe(bytes);
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"retires only its unpublished admission on cancellation before dispatch",
		async () => {
			const f = await fixture([user("a", null)]);
			await fs.mkdir(f.agentDir, { mode: 0o700 });
			const bytes = await Bun.file(f.file).text();
			const abort = new AbortController();
			let file: string | undefined;
			let record: string | undefined;
			let memberBeforeAbort: string | undefined;
			let factories = 0;
			const install = SessionManager.prototype.installOwnerMembership;
			const installing = spyOn(SessionManager.prototype, "installOwnerMembership").mockImplementation(function (
				this: SessionManager,
				membership,
			) {
				install.call(this, membership);
				if (this.getSessionFile() === file) {
					memberBeforeAbort = this.getSessionOwnerEvidence()?.policy.kind;
					abort.abort();
				}
			});
			const result = await createEmbeddedAgentSession({
				cwd: f.cwd,
				agentDir: f.agentDir,
				storage: { directory: f.root },
				native: {
					create: true,
					ownerPolicy: { kind: "exclusive_native" },
					fork: {
						file: f.file,
						signal: abort.signal,
						reserveSelectedForkTranscript: async identity => {
							file = identity.file;
							record = ownerRecord(f.root, identity.sessionId);
						},
					},
				},
				createSession: async () => {
					factories++;
					throw new Error("Factory must not run");
				},
			}).finally(() => installing.mockRestore());
			expect(result).toMatchObject({ kind: "refused", reason: "cancelled" });
			if (!file || !record) throw new Error("Missing reservation");
			expect(memberBeforeAbort).toBe("exclusive_native");
			expect(await Bun.file(record).json()).toMatchObject({ state: "retired", members: [] });
			expect(sync.existsSync(file)).toBe(false);
			expect(factories).toBe(0);
			expect(await Bun.file(f.file).text()).toBe(bytes);
		},
	);

	for (const canRetire of [true, false])
		it.skipIf(process.platform === "win32")(
			`never constructs or publishes after an admission lock release failure (${canRetire ? "settled" : "retained"})`,
			async () => {
				const f = await fixture([user("a", null)]);
				const original = await Bun.file(f.file).text();
				await fs.mkdir(f.agentDir, { mode: 0o700 });
				let file: string | undefined;
				let record: string | undefined;
				let reportedReleaseFailure = false;
				let factories = 0;
				let stagedOpens = 0;
				const stagedWriter = spyOn(FileSessionStorage.prototype, "openStagedWriter");
				const acquireLock = FileSessionStorage.prototype.acquireExclusiveLockSync;
				const acquire = spyOn(FileSessionStorage.prototype, "acquireExclusiveLockSync").mockImplementation(
					function (this: FileSessionStorage, lockPath, options) {
						if (lockPath !== `${record}.lock`) return acquireLock.call(this, lockPath, options);
						if (reportedReleaseFailure && !canRetire) return undefined;
						const lock = acquireLock.call(this, lockPath, options);
						if (!lock || reportedReleaseFailure) return lock;
						return {
							releaseSync: () => {
								lock.releaseSync();
								reportedReleaseFailure = true;
								throw new Error("Injected admission lock release failure", { cause: { internal: true } });
							},
						};
					},
				);
				const result = await createEmbeddedAgentSession({
					cwd: f.cwd,
					agentDir: f.agentDir,
					storage: { directory: f.root },
					native: {
						create: true,
						ownerPolicy: { kind: "exclusive_native" },
						fork: {
							file: f.file,
							reserveSelectedForkTranscript: async identity => {
								file = identity.file;
								record = ownerRecord(f.root, identity.sessionId);
							},
						},
					},
					createSession: async () => {
						factories++;
						throw new Error("Factory must not run");
					},
				}).finally(() => {
					stagedOpens = stagedWriter.mock.calls.length;
					acquire.mockRestore();
					stagedWriter.mockRestore();
				});
				if (!file || !record) throw new Error("Expected exact fork reservation");
				expect(reportedReleaseFailure).toBe(true);
				const owner = await Bun.file(record).json();
				expect(owner.state).toBe(canRetire ? "retired" : "live");
				expect(owner.members).toHaveLength(canRetire ? 0 : 1);
				if (canRetire) {
					expect(result).toEqual({ kind: "refused", reason: "fork_refused" });
				} else {
					expect(result).toEqual({
						kind: "refused",
						reason: "fork_ownership_retained",
						error: "Fresh fork admission could not be retired",
						forkAdmission: {
							kind: "admitted_unsettled",
							identity: {
								sessionId: owner.headerId,
								file,
								authorityKey: record,
								memberId: owner.members[0].memberId,
								epoch: owner.epoch,
								rev: owner.rev,
								snapshotDigest: createHash("sha256").digest("hex"),
							},
							admissionError: { name: "Error", message: "Injected admission lock release failure" },
							settlementError: {
								name: "OwnerAuthorityError",
								message: "authority_busy",
								code: "authority_busy",
							},
						},
					});
					if (result.kind !== "refused" || !result.forkAdmission) throw new Error("Expected admission receipt");
					const receipt = result.forkAdmission;
					expect(Object.isFrozen(receipt)).toBe(true);
					expect(Object.isFrozen(receipt.identity)).toBe(true);
					expect(Object.isFrozen(receipt.admissionError)).toBe(true);
					expect(Object.isFrozen(receipt.settlementError)).toBe(true);
				}
				expect(stagedOpens).toBe(0);
				expect(sync.existsSync(file)).toBe(false);
				expect(factories).toBe(0);
				expect(await Bun.file(f.file).text()).toBe(original);
			},
		);

	it.skipIf(process.platform === "win32")("does not prepare a managed scope when admission is vetoed", async () => {
		const f = await fixture([user("a", null)]);
		const directory = SessionManager.managedDestination(f.cwd, f.agentDir).directory;
		const internal = path.join(directory, ".gjc-managed-session-internal");
		await fs.rm(internal, { recursive: true });
		const before = (await fs.readdir(directory)).sort();
		let file: string | undefined;
		let vetoes = 0;
		let factories = 0;
		const inspect = LifecycleLedger.inspectOwnershipReadOnly;
		const veto = spyOn(LifecycleLedger, "inspectOwnershipReadOnly").mockImplementation((agentDir, target, limits) => {
			if (target.transcriptPath !== file) return inspect.call(LifecycleLedger, agentDir, target, limits);
			vetoes++;
			return Promise.resolve({ kind: "unknown_ownership", reason: "Injected admission veto" });
		});
		try {
			const result = await createEmbeddedAgentSession({
				cwd: f.cwd,
				agentDir: f.agentDir,
				storage: { managed: true },
				native: {
					create: true,
					ownerPolicy: { kind: "exclusive_native" },
					fork: {
						file: f.file,
						reserveSelectedForkTranscript: async identity => {
							file = identity.file;
						},
					},
				},
				createSession: async () => {
					factories++;
					throw new Error("Factory must not run");
				},
			});
			expect(result).toMatchObject({ kind: "refused", reason: "unknown_ownership" });
			expect(vetoes).toBe(1);
			expect(factories).toBe(0);
			expect((await fs.readdir(directory)).sort()).toEqual(before);
			expect(sync.existsSync(internal)).toBe(false);
		} finally {
			veto.mockRestore();
		}
	});

	for (const fault of ["construction", "fsync and close", "close", "sealed before dispatch"] as const)
		it.skipIf(process.platform === "win32")(`retains the original fork attempt after ${fault}`, async () => {
			const f = await fixture([user("a", null)]);
			await fs.mkdir(f.agentDir, { mode: 0o700 });
			const original = await Bun.file(f.file).text();
			const abort = new AbortController();
			let file: string | undefined;
			let releaseStage: (() => void) | undefined;
			let closeAttempts = 0;
			let publications = 0;
			let factories = 0;
			const openStagedWriter = FileSessionStorage.prototype.openStagedWriter;
			const stagedWriter = spyOn(FileSessionStorage.prototype, "openStagedWriter").mockImplementation(function (
				this: FileSessionStorage,
				destination,
				options,
			) {
				const staged = openStagedWriter.call(this, destination, options);
				if (destination !== file) return staged;
				const close = staged.closeSync.bind(staged);
				releaseStage = close;
				if (fault === "construction") throw new Error("Injected staged construction failure");
				if (fault === "fsync and close") {
					staged.fsync = () => {
						throw new Error("Injected staged fsync failure");
					};
				}
				staged.closeSync = () => {
					closeAttempts++;
					if (fault !== "sealed before dispatch" && closeAttempts === 1)
						throw new Error("Injected staged close failure");
					close();
					if (fault === "sealed before dispatch") abort.abort();
				};
				staged.publishNoReplace = () => {
					publications++;
					throw new Error("Unexpected staged publication");
				};
				return staged;
			});
			try {
				const retained = await createEmbeddedAgentSession({
					cwd: f.cwd,
					agentDir: f.agentDir,
					storage: { directory: f.root },
					native: {
						create: true,
						ownerPolicy: { kind: "exclusive_native" },
						fork: {
							file: f.file,
							signal: abort.signal,
							reserveSelectedForkTranscript: async identity => {
								file = identity.file;
							},
						},
					},
					createSession: async () => {
						factories++;
						throw new Error("Factory must not run");
					},
				});
				if (!file || retained.kind !== "uncertain_cursor")
					throw new Error(`Expected the original retained fork handle, got ${retained.kind}`);
				const { handle, op, selection, error } = retained;
				expect(selection.receipt.terminalDisposition.kind).toBe("retained_live");
				expect(selection.receipt.commitment.continueEligible).toBe(false);
				if (fault === "fsync and close") expect(error).toContain("Injected staged fsync failure");
				if (fault === "close" || fault === "fsync and close")
					expect(error).toContain("Injected staged close failure");
				if (fault === "construction") expect(error).toContain("Injected staged construction failure");
				if (fault === "sealed before dispatch") expect(error).toContain("Fork cancelled; ownership retained");
				const record = await Bun.file(op.authorityKey).text();
				expect(JSON.parse(record)).toMatchObject({ state: "live", mode: "exclusive_native", epoch: op.epoch });
				const stagePrefix = `.${path.basename(file)}.`;
				const stageName = (await fs.readdir(f.root)).find(
					name => name.startsWith(stagePrefix) && name.endsWith(".staged"),
				);
				if (!stageName) throw new Error("Missing original private staged transcript");
				const stageFile = path.join(f.root, stageName);
				const stagedBytes = await Bun.file(stageFile).text();
				const resumed = await resumeEmbeddedAgentSession(handle);
				if (resumed.kind !== "uncertain_cursor") throw new Error(`Expected retained fork; got ${resumed.kind}`);
				expect(resumed.handle).toBe(handle);
				expect(resumed.op).toBe(op);
				const preparation = await prepareEmbeddedDisconnect(handle, op);
				const consent = consentEmbeddedDisconnect(handle, preparation, {
					discardUnpublished: { ids: preparation.heldIds },
				});
				if (!consent) throw new Error("Expected original handle to accept exact teardown consent");
				const term = await terminateEmbeddedAgentSession(handle, { op, consent });
				const closeOutcome = fault === "sealed before dispatch" ? "closed" : "close_unknown";
				expect(term.receipt.routing).toMatchObject({ action: "POST_READONLY", closeOutcome });
				expect(term.receipt.terminalDisposition).toMatchObject({
					kind: "retained_after_close",
					reason: "closure_or_durability_unresolved",
				});
				const again = await terminateEmbeddedAgentSession(handle, { op, consent });
				expect(again.receipt.routing.closeOutcome).toBe(closeOutcome);
				expect(await Bun.file(op.authorityKey).text()).toBe(record);
				expect(await Bun.file(stageFile).text()).toBe(stagedBytes);
				expect(await Bun.file(f.file).text()).toBe(original);
				expect(sync.existsSync(file)).toBe(false);
				expect(closeAttempts).toBe(fault === "construction" ? 0 : 1);
				expect(publications).toBe(0);
				expect(factories).toBe(0);
			} finally {
				stagedWriter.mockRestore();
				releaseStage?.();
			}
		});

	for (const outcome of ["receipt lost", "cancelled", "cancelled with receipt lost"] as const)
		it.skipIf(process.platform === "win32")(`reports ${outcome} after initial publication`, async () => {
			const f = await fixture([user("a", null), user("b", "a")]);
			await fs.mkdir(f.agentDir, { mode: 0o700 });
			const abort = new AbortController();
			const original = await Bun.file(f.file).text();
			let file: string | undefined;
			let factories = 0;
			let publications = 0;
			const openStagedWriter = FileSessionStorage.prototype.openStagedWriter;
			const stagedWriter = spyOn(FileSessionStorage.prototype, "openStagedWriter").mockImplementation(function (
				this: FileSessionStorage,
				destination,
				options,
			) {
				const staged = openStagedWriter.call(this, destination, options);
				if (destination === file) {
					const publish = staged.publishNoReplace.bind(staged);
					staged.publishNoReplace = () => {
						publications++;
						const receipt = publish();
						if (outcome !== "receipt lost") abort.abort();
						if (outcome !== "cancelled") throw new Error("lost initial publication receipt");
						return receipt;
					};
				}
				return staged;
			});
			const retained = await createEmbeddedAgentSession({
				cwd: f.cwd,
				agentDir: f.agentDir,
				storage: { directory: f.root },
				native: {
					create: true,
					ownerPolicy: { kind: "exclusive_native" },
					fork: {
						file: f.file,
						selection: { snapshotDigest: f.resolution.checkpoint.snapshotDigest, targetLeafId: "a" },
						signal: abort.signal,
						reserveSelectedForkTranscript: async identity => {
							file = identity.file;
						},
					},
				},
				createSession: async () => {
					factories++;
					throw new Error("Factory must not run");
				},
			}).finally(() => stagedWriter.mockRestore());
			if (!file || (retained.kind !== "uncertain_cursor" && retained.kind !== "startup_failed"))
				throw new Error(`Expected a cancelled or unproven fork, got ${retained.kind}`);
			const { handle, op } = retained;
			const bytes = await Bun.file(file).text();
			expect(bytes).toContain(`"op":"${op.op}"`);
			if (outcome !== "cancelled") {
				const error =
					outcome === "receipt lost"
						? "lost initial publication receipt"
						: "Fork cancelled; ownership retained; lost initial publication receipt";
				expect(retained).toMatchObject({ kind: "uncertain_cursor", error });
				expect(await Bun.file(op.authorityKey).json()).toMatchObject({
					state: "live",
					mode: "exclusive_native",
					epoch: op.epoch,
				});
				expect(await resumeEmbeddedAgentSession(handle)).toMatchObject({
					kind: "uncertain_cursor",
					handle,
					op,
					error,
				});
				const repair = await reconcileEmbeddedResumeCheckpoint(handle, { op, mode: "repairDurability" });
				expect(repair.receipt.commitment.continueEligible).toBe(false);
				const denied = await terminateEmbeddedAgentSession(handle, { op });
				expect(denied.refusal).toBe("termination_not_authorized");
			} else {
				expect(retained.kind).toBe("startup_failed");
				expect(retained.selection.receipt.terminalDisposition.kind).toBe("retired");
				expect(await Bun.file(op.authorityKey).json()).toMatchObject({ state: "retired", members: [] });
			}
			expect(await Bun.file(file).text()).toBe(bytes);
			expect(await Bun.file(f.file).text()).toBe(original);
			expect(publications).toBe(1);
			expect(factories).toBe(0);
		});
});

function ownerRecord(directory: string, sessionId: string): string {
	return path.join(directory, ".gjc-owners", `${sessionId}.json`);
}

async function forkRuntimeOptions(f: { cwd: string; agentDir: string }) {
	const auth = await AuthStorage.create(path.join(f.agentDir, "auth.db"));
	authStores.push(auth);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing bundled test model");
	auth.setRuntimeApiKey(model.provider, "test-only-key");
	await Bun.write(
		path.join(f.agentDir, "config.yml"),
		JSON.stringify({
			recipe: { enabled: false },
			compaction: { enabled: false },
			retry: { enabled: false },
			tools: { discoveryMode: "off" },
			modelRoles: { default: `${model.provider}/${model.id}` },
		}),
	);
	return {
		cwd: f.cwd,
		agentDir: f.agentDir,
		authStorage: auth,
		model,
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
	} satisfies Omit<CreateAgentSessionOptions, "sessionManager" | "settings" | "modelRegistry" | "agentRegistry">;
}

describe("readonly-first native SDK embedding", () => {
	for (const closureAvailable of [true, false])
		it(`uses actual native runtime closure and ${closureAvailable ? "retires only after final proof" : "retains membership when final evidence is unavailable"}`, async () => {
			const f = await fixture([user("a", null)]);
			const expected = { snapshotDigest: f.resolution.checkpoint.snapshotDigest, resolved: f.resolution.checkpoint };
			const auth = await AuthStorage.create(path.join(f.agentDir, "auth.db"));
			authStores.push(auth);
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Missing bundled test model");
			auth.setRuntimeApiKey(model.provider, "test-only-key");
			await Bun.write(
				path.join(f.agentDir, "config.yml"),
				JSON.stringify({
					recipe: { enabled: false },
					compaction: { enabled: false },
					retry: { enabled: false },
					tools: { discoveryMode: "off" },
					modelRoles: { default: `${model.provider}/${model.id}` },
				}),
			);
			const legacyAttestation = await attestEmbeddedLegacyTakeover({
				...f,
				snapshotDigest: expected.snapshotDigest,
				acknowledged: true,
			});
			const opened = await createEmbeddedAgentSession({
				cwd: f.cwd,
				agentDir: f.agentDir,
				authStorage: auth,
				model,
				storage: { directory: f.root, file: f.file },
				native: { expected, ownerPolicy: { kind: "exclusive_native", expected, legacyAttestation } },
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
			if (opened.kind !== "opened")
				throw new Error(
					`Expected real native runtime: ${JSON.stringify({ kind: opened.kind, reason: "reason" in opened ? opened.reason : undefined, error: "error" in opened ? opened.error : undefined })}`,
				);
			const manager = opened.result.session.sessionManager;
			expect(() => opened.result.session.dispose({ strictCloseAttempts: 1 })).toThrow(
				"Native disposal requires registry termination authorization",
			);
			expect(manager.getStrictCloseState().kind).toBe("none_started");
			const transport = createMockModel({ handler: { content: ["local native answer"] } });
			opened.result.session.agent.streamFn = transport.stream;
			const beforePrompt = await Bun.file(f.file).text();
			await expect(opened.result.session.prompt("blocked raw native prompt")).rejects.toMatchObject({
				reason: "context_mismatch",
			});
			expect(transport.calls).toHaveLength(0);
			expect(await Bun.file(f.file).text()).toBe(beforePrompt);
			const prompt = await opened.runtime.prompt.prompt("native local prompt");
			expect(prompt.kind).toBe("applied");
			await opened.result.session.waitForIdle();
			await opened.result.session.awaitSessionSettlement();
			expect(transport.calls).toHaveLength(1);
			const preparation = await prepareEmbeddedDisconnect(opened.handle, opened.op);
			if (!preparation.inventory) throw new Error("Expected actual native owned-work inventory");
			expect(preparation.inventory.pendingRequests.status).toBe("available");
			expect(preparation.inventory.blockers).toEqual([]);
			const consent = consentEmbeddedDisconnect(opened.handle, preparation, {
				stopAndJoin: true,
				work: { inventory: preparation.inventory, targets: [] },
			});
			if (!consent) throw new Error("Expected exact registry consent");
			const closure = !closureAvailable
				? spyOn(manager, "getResumeClosureEvidence").mockResolvedValue(undefined)
				: undefined;
			try {
				const final = await terminateEmbeddedAgentSession(opened.handle, { op: opened.op, consent });
				expect(manager.getStrictCloseState().kind).toBe("closed");
				expect(final.receipt.routing.action).toBe("POST_READONLY");
				expect(final.receipt.terminalDisposition.kind).toBe(closureAvailable ? "retired" : "retained_after_close");
				const bytes = await Bun.file(f.file).text();
				const repeated = await terminateEmbeddedAgentSession(opened.handle, { op: opened.op });
				expect(repeated.receipt.routing.action).toBe("POST_READONLY");
				expect(await Bun.file(f.file).text()).toBe(bytes);
			} finally {
				closure?.mockRestore();
			}
		});
	it("joins concurrent retained opens through actual held construction and publishes only one runtime", async () => {
		const f = await fixture([user("a", null)]);
		const expected = { snapshotDigest: f.resolution.checkpoint.snapshotDigest, resolved: f.resolution.checkpoint };
		const auth = await AuthStorage.create(path.join(f.agentDir, "auth.db"));
		authStores.push(auth);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing bundled test model");
		auth.setRuntimeApiKey(model.provider, "test-only-key");
		await Bun.write(
			path.join(f.agentDir, "config.yml"),
			JSON.stringify({
				recipe: { enabled: false },
				compaction: { enabled: false },
				retry: { enabled: false },
				tools: { discoveryMode: "off" },
				modelRoles: { default: `${model.provider}/${model.id}` },
			}),
		);
		const legacyAttestation = await attestEmbeddedLegacyTakeover({
			...f,
			snapshotDigest: expected.snapshotDigest,
			acknowledged: true,
		});
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let factories = 0;
		let constructionAllowed = false;
		const repair = spyOn(FileSessionStorage.prototype, "repairDurabilitySync").mockImplementation(() => {
			throw new Error("injected initial durability failure");
		});
		const retained = await createEmbeddedAgentSession({
			cwd: f.cwd,
			agentDir: f.agentDir,
			authStorage: auth,
			model,
			storage: { directory: f.root, file: f.file },
			native: { expected, ownerPolicy: { kind: "exclusive_native", expected, legacyAttestation } },
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
			createSession: async options => {
				factories++;
				if (!constructionAllowed) throw new Error("Factory ran before durability repair");
				const result = await createAgentSession(options);
				entered.resolve();
				await release.promise;
				return result;
			},
		}).finally(() => repair.mockRestore());
		if (retained.kind !== "uncertain_cursor") throw new Error(`Expected retained open, got ${retained.kind}`);
		expect(factories).toBe(0);
		const repaired = await reconcileEmbeddedResumeCheckpoint(retained.handle, {
			op: retained.op,
			mode: "repairDurability",
		});
		expect(repaired.receipt.commitment.continueEligible).toBe(true);
		constructionAllowed = true;
		const first = resumeEmbeddedAgentSession(retained.handle);
		void first.then(
			() => entered.resolve(),
			() => entered.resolve(),
		);
		await entered.promise;
		const second = resumeEmbeddedAgentSession(retained.handle);
		let published = false;
		void first.then(
			() => {
				published = true;
			},
			() => {
				published = true;
			},
		);
		try {
			// Joining the actual held flight must not enqueue another OPEN or factory.
			expect(second).toBe(first);
			expect(factories).toBe(1);
			expect(published).toBe(false);
		} finally {
			release.resolve();
		}
		const [opened, joined] = await Promise.all([first, second]);
		expect(joined).toBe(opened);
		if (opened.kind !== "opened") throw new Error(`Expected actual native runtime, got ${opened.kind}`);
		expect(opened.handle).toBe(retained.handle);
		expect(opened.op).toBe(retained.op);
		expect(factories).toBe(1);
		const preparation = await prepareEmbeddedDisconnect(opened.handle, opened.op);
		if (!preparation.inventory) throw new Error("Missing actual native inventory");
		const consent = consentEmbeddedDisconnect(opened.handle, preparation, {
			stopAndJoin: true,
			work: { inventory: preparation.inventory, targets: [] },
		});
		if (!consent) throw new Error("Missing native termination consent");
		const final = await terminateEmbeddedAgentSession(opened.handle, { op: opened.op, consent });
		expect(final.receipt.routing.action).toBe("POST_READONLY");
		expect(opened.result.session.sessionManager.getStrictCloseState().kind).toBe("closed");
	});

	it("requires interpretation of legacy branches without factory, writer, catalog or agentDir effects", async () => {
		const f = await fixture([user("a", null), user("b", null)]);
		const expected = { snapshotDigest: f.resolution.checkpoint.snapshotDigest, resolved: f.resolution.checkpoint };
		const before = await Bun.file(f.file).text();
		let factories = 0;
		const createSession = async (_options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
			factories++;
			throw new Error("Factory must not run");
		};
		const result = await createEmbeddedAgentSession({
			cwd: f.cwd,
			agentDir: f.agentDir,
			storage: { directory: f.root, file: f.file },
			native: { expected, ownerPolicy: { kind: "exclusive_native", expected } },
			createSession,
		});
		expect(result.kind).toBe("selector");
		expect(factories).toBe(0);
		expect(await Bun.file(f.file).text()).toBe(before);
		expect(await fs.readdir(f.root)).toEqual(["project", "selected.jsonl"]);
	});

	it("refuses changed raw bytes against the consented checkpoint before any factory or writer", async () => {
		const f = await fixture([user("a", null)]);
		const expected = { snapshotDigest: f.resolution.checkpoint.snapshotDigest, resolved: f.resolution.checkpoint };
		await Bun.write(f.file, (await Bun.file(f.file).text()) + JSON.stringify(user("b", "a")) + "\n");
		const before = await Bun.file(f.file).text();
		let factories = 0;
		const result = await createEmbeddedAgentSession({
			cwd: f.cwd,
			agentDir: f.agentDir,
			storage: { directory: f.root, file: f.file },
			native: { expected, ownerPolicy: { kind: "exclusive_native", expected } },
			createSession: async () => {
				factories++;
				throw new Error("must not build");
			},
		});
		expect(result).toMatchObject({ kind: "refused", reason: "stale_snapshot" });
		expect(factories).toBe(0);
		expect(await Bun.file(f.file).text()).toBe(before);
		expect(await fs.readdir(f.root)).toEqual(["project", "selected.jsonl"]);
	});

	it("owns an explicit null-root attempt before startup and never replays its IDs after startup failure", async () => {
		const f = await fixture([user("a", null)]);
		const expected = { snapshotDigest: f.resolution.checkpoint.snapshotDigest, resolved: f.resolution.checkpoint };
		const legacyAttestation = await attestEmbeddedLegacyTakeover({
			...f,
			snapshotDigest: expected.snapshotDigest,
			acknowledged: true,
		});
		let factories = 0;
		const result = await createEmbeddedAgentSession({
			cwd: f.cwd,
			agentDir: f.agentDir,
			storage: { directory: f.root, file: f.file },
			native: {
				expected,
				ownerPolicy: { kind: "exclusive_native", expected, legacyAttestation },
				selection: { snapshotDigest: expected.snapshotDigest, targetLeafId: null, op: "explicit-root" },
			},
			createSession: async () => {
				factories++;
				throw new Error("synthetic startup failure");
			},
		});
		if (result.kind !== "startup_failed")
			throw new Error(
				JSON.stringify(
					"selection" in result
						? {
								kind: result.kind,
								outcome: result.selection.outcome.kind,
								refusal: result.selection.refusal,
								durability: result.selection.receipt.durability,
								shape: result.selection.receipt.manifestShape,
								suffix: result.selection.receipt.commitment.suffixState,
								conflicts: result.selection.receipt.remainingConflict,
								routing: result.selection.receipt.routing,
							}
						: result,
				),
			);
		expect(result.kind).toBe("startup_failed");
		expect(factories).toBe(1);
		expect(result.op.plan.target).toBeNull();
		const bytes = await Bun.file(f.file).text();
		const retried = await resumeEmbeddedAgentSession(result.handle);
		expect(retried.kind).toBe("selection_incomplete");
		if (retried.kind !== "selection_incomplete") throw new Error("Expected closed retained handle");
		expect(retried.handle).toBe(result.handle);
		expect(retried.op).toBe(result.op);
		expect(factories).toBe(1);
		expect(await Bun.file(f.file).text()).toBe(bytes);
		const final = await terminateEmbeddedAgentSession(result.handle, { op: result.op });
		expect(final.receipt.routing.action).toBe("POST_READONLY");
		expect(await Bun.file(f.file).text()).toBe(bytes);
		expect(factories).toBe(1);
	});

	it("applies physical header patches through the canonical parser while retaining raw digest binding", async () => {
		const f = await fixture([user("a", null), { type: "header_patch", patch: { title: "renamed" } }]);
		expect(f.resolution.checkpoint).toMatchObject({
			kind: "tail_unambiguous",
			headerId: "selected",
			leafEntryId: "a",
			authority: "none",
		});
		const before = await fs.readdir(f.root);
		expect(resolveEmbeddedResumeCheckpoint(f.file)).toEqual(f.resolution);
		expect(await fs.readdir(f.root)).toEqual(before);
	});
});
