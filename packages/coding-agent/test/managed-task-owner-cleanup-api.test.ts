import { afterEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as util from "node:util";
import type { ManagedGcSessionRetirementReceipt } from "../src/session/internal/managed-gc-retirement-codec";
import {
	bindManagedGcSessionRetirementTarget,
	discoverManagedGcSessionRetirementReceipts,
	listManagedCandidates,
	type ManagedCandidate,
	type ManagedScope,
	managedDirectoryIdentityForScope,
	managedGcProtocolScopeInspectorForScope,
	prepareManagedSessionScopeForWriteSync,
	publishManagedGcSessionRetirementReceipt,
	readManagedGcSessionRetirementReceipt,
	resolveManagedScopeForWrite,
	taskArtifactOwnerStorageContextForScope,
} from "../src/session/internal/managed-session-scope";
import { acquireManagedLock, ManagedSessionDescendantStore } from "../src/session/internal/managed-session-storage";
import {
	type ManagedGcOwnerCleanupAuthority,
	type ManagedGcOwnerCleanupTarget,
	managedGcOwnerDeleteFields,
	persistManagedGcStorageOwnerDisposition,
	prepareManagedGcOwnerTarget,
	retireManagedGcOwnerAfterArtifacts,
} from "../src/session/internal/managed-task-owner-cleanup";
import {
	captureTaskArtifactOwnerDeletionEvidence,
	newSessionRootStore,
} from "../src/session/internal/task-artifact-owner-access";
import { FileSessionStorage } from "../src/session/session-storage";
import {
	OWNER_DIRECTORY,
	OWNER_MANIFEST,
	OWNER_SCHEMA_VERSION,
	ownerIdForSession,
	ownerRelativePath,
	parseTaskArtifactOwnerLocator,
	type TaskArtifactOwnerDeletionEvidence,
	type TaskArtifactOwnerLocator,
} from "../src/session/task-artifact-owner-codec";
import { verifyTaskArtifactOwnerPhysicalRetirement } from "../src/session/task-artifact-owner-retirement";

interface Fixture {
	readonly root: string;
	readonly agentDir: string;
	readonly sessionsRoot: string;
	readonly cwd: string;
	readonly scope: ManagedScope;
	readonly sessionId: string;
	readonly transcriptPath: string;
	readonly ownerPath: string;
	readonly locator: TaskArtifactOwnerLocator;
	readonly evidence: TaskArtifactOwnerDeletionEvidence;
	readonly candidate: ManagedCandidate;
}

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface SiblingTarget {
	readonly scope: ManagedScope;
	readonly transcriptPath: string;
	readonly candidate: ManagedCandidate;
}

function makeFixture(): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-owner-cleanup-api-"));
	roots.push(root);
	const agentDir = path.join(root, "profile");
	const sessionsRoot = path.join(agentDir, "sessions");
	const cwd = path.join(root, "workspace");
	fs.mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 });
	fs.mkdirSync(cwd, { mode: 0o700 });
	const resolved = resolveManagedScopeForWrite({ agentDir, sessionsRoot, cwd });
	if (resolved.kind !== "resolved") throw new Error(`fixture_scope_resolution_failed:${resolved.code}`);
	const prepared = prepareManagedSessionScopeForWriteSync(resolved.scope);
	if (prepared.kind !== "resolved") throw new Error(`fixture_scope_prepare_failed:${prepared.code}`);
	const scope = prepared.scope;
	const storageContext = taskArtifactOwnerStorageContextForScope(scope);
	const sessionId = `managed-owner-api-${crypto.randomUUID()}`;
	const ownerId = ownerIdForSession(sessionId);
	const rootStore = newSessionRootStore(storageContext);
	let locator: TaskArtifactOwnerLocator | undefined;
	try {
		rootStore.ensureDirectory(OWNER_DIRECTORY);
		const ownerDirectory = rootStore.ensureDirectory(ownerRelativePath(ownerId));
		locator = parseTaskArtifactOwnerLocator({
			schemaVersion: OWNER_SCHEMA_VERSION,
			ownerId,
			directoryDev: ownerDirectory.dev.toString(),
			directoryIno: ownerDirectory.ino.toString(),
		});
		if (!locator) throw new Error("fixture_owner_locator_missing");
		const ownerStore = rootStore.deriveSubtree(ownerRelativePath(ownerId));
		try {
			ownerStore.publishNoReplaceSync(
				OWNER_MANIFEST,
				Buffer.from(`${JSON.stringify({ ...locator, sessionId })}\n`, "utf8"),
			);
			ownerStore.publishNoReplaceSync("payload.bin", Buffer.from("real-owner-payload", "utf8"));
		} finally {
			ownerStore.close();
		}
	} finally {
		rootStore.close();
	}
	if (!locator) throw new Error("fixture_owner_locator_missing");
	const transcriptPath = path.join(scope.directoryPath, `${sessionId}.jsonl`);
	const scopeIdentity = managedDirectoryIdentityForScope(scope);
	const scopeStore = new ManagedSessionDescendantStore(
		storageContext.rootAuthority,
		scope.directoryPath,
		undefined,
		storageContext.securityPolicy,
		storageContext.profileAgentDir,
		{
			canonicalPath: scope.directoryPath,
			dev: BigInt.asUintN(64, scopeIdentity.dev),
			ino: BigInt.asUintN(64, scopeIdentity.ino),
		},
	);
	try {
		scopeStore.publishNoReplaceSync(
			path.basename(transcriptPath),
			Buffer.from(
				`${JSON.stringify({ type: "session", id: sessionId, cwd, version: 4, taskArtifactOwner: locator })}\n`,
			),
		);
	} finally {
		scopeStore.close();
	}
	const evidence = captureTaskArtifactOwnerDeletionEvidence(storageContext, sessionId, locator);
	if (!evidence) throw new Error("fixture_owner_evidence_missing");
	const listing = listManagedCandidates(scope);
	if (listing.kind !== "complete") throw new Error(`fixture_candidate_listing_failed:${listing.kind}`);
	const candidate = listing.owned.find(item => item.path === transcriptPath);
	if (!candidate) throw new Error("fixture_candidate_missing");
	return {
		root,
		agentDir,
		sessionsRoot,
		cwd,
		scope,
		sessionId,
		transcriptPath,
		ownerPath: path.join(sessionsRoot, ownerRelativePath(ownerId)),
		locator,
		evidence,
		candidate,
	};
}

function makeSiblingTarget(fixture: Fixture): SiblingTarget {
	const cwd = path.join(fixture.root, "workspace-sibling");
	fs.mkdirSync(cwd, { mode: 0o700 });
	const resolved = resolveManagedScopeForWrite({
		agentDir: fixture.agentDir,
		sessionsRoot: fixture.sessionsRoot,
		cwd,
	});
	if (resolved.kind !== "resolved") throw new Error(`fixture_sibling_scope_resolution_failed:${resolved.code}`);
	const prepared = prepareManagedSessionScopeForWriteSync(resolved.scope);
	if (prepared.kind !== "resolved") throw new Error(`fixture_sibling_scope_prepare_failed:${prepared.code}`);
	const scope = prepared.scope;
	const context = taskArtifactOwnerStorageContextForScope(scope);
	const identity = managedDirectoryIdentityForScope(scope);
	const transcriptPath = path.join(scope.directoryPath, `${fixture.sessionId}-sibling.jsonl`);
	const store = new ManagedSessionDescendantStore(
		context.rootAuthority,
		scope.directoryPath,
		undefined,
		context.securityPolicy,
		context.profileAgentDir,
		{
			canonicalPath: scope.directoryPath,
			dev: BigInt.asUintN(64, identity.dev),
			ino: BigInt.asUintN(64, identity.ino),
		},
	);
	try {
		store.publishNoReplaceSync(
			path.basename(transcriptPath),
			Buffer.from(
				`${JSON.stringify({ type: "session", id: fixture.sessionId, cwd, version: 4, taskArtifactOwner: fixture.locator })}\n`,
			),
		);
	} finally {
		store.close();
	}
	const listing = listManagedCandidates(scope);
	if (listing.kind !== "complete") throw new Error(`fixture_sibling_listing_failed:${listing.kind}`);
	const candidate = listing.owned.find(item => item.path === transcriptPath);
	if (!candidate) throw new Error("fixture_sibling_candidate_missing");
	return { scope, transcriptPath, candidate };
}

function removeTranscript(scope: ManagedScope, transcriptPath: string): void {
	const context = taskArtifactOwnerStorageContextForScope(scope);
	const identity = managedDirectoryIdentityForScope(scope);
	const store = new ManagedSessionDescendantStore(
		context.rootAuthority,
		scope.directoryPath,
		undefined,
		context.securityPolicy,
		context.profileAgentDir,
		{
			canonicalPath: scope.directoryPath,
			dev: BigInt.asUintN(64, identity.dev),
			ino: BigInt.asUintN(64, identity.ino),
		},
	);
	try {
		store.removeIfExistsDescriptor(path.basename(transcriptPath));
	} finally {
		store.close();
	}
}

async function withAuthority<T>(
	fixture: Fixture,
	operation: (authority: ManagedGcOwnerCleanupAuthority) => Promise<T>,
	scope: ManagedScope = fixture.scope,
): Promise<T> {
	const context = taskArtifactOwnerStorageContextForScope(scope);
	// The outer scope fence must not hold the per-transcript journal publication lease.
	const lockKey = crypto.createHash("sha256").update(scope.canonicalCwd).digest("hex");
	const lock = await acquireManagedLock(
		path.join(scope.directoryPath, ".gjc-managed-session-internal", "locks"),
		lockKey,
		context.rootAuthority,
		context.securityPolicy,
	);
	const authority: ManagedGcOwnerCleanupAuthority = {
		agentDir: scope.agentDir,
		sessionsRoot: scope.sessionsRoot,
		directoryPath: scope.directoryPath,
		storageContext: context,
		inspectProtocol: async inputs => {
			lock.assertOwned();
			const snapshots = await managedGcProtocolScopeInspectorForScope(scope)(inputs);
			lock.assertOwned();
			return snapshots;
		},
		assertOwned: () => lock.assertOwned(),
		bindTarget: transcriptPath => bindManagedGcSessionRetirementTarget(scope, transcriptPath),
		readReceipt: async transcriptPath => {
			lock.assertOwned();
			const receipt = await readManagedGcSessionRetirementReceipt(scope, transcriptPath);
			lock.assertOwned();
			return receipt;
		},
		publishReceipt: async receipt => {
			lock.assertOwned();
			const published = await publishManagedGcSessionRetirementReceipt(scope, receipt);
			lock.assertOwned();
			return published;
		},
		findCompletedRetirement: async (evidence, exceptTranscriptPath) => {
			lock.assertOwned();
			const records = await discoverManagedGcSessionRetirementReceipts({
				agentDir: scope.agentDir,
				sessionsRoot: scope.sessionsRoot,
			});
			lock.assertOwned();
			const found = records.find(
				({ scope: source, receipt }) =>
					source.agentDir === scope.agentDir &&
					source.sessionsRoot === scope.sessionsRoot &&
					source.directoryPath !== scope.directoryPath &&
					receipt.transcriptPath !== exceptTranscriptPath &&
					receipt.state === "owner_retired" &&
					receipt.taskArtifactOwnerRetirementOutcome?.kind === "completed" &&
					util.isDeepStrictEqual(receipt.taskArtifactOwnerDeletionEvidence, evidence),
			);
			return found
				? {
						scope: {
							agentDir: found.scope.agentDir,
							sessionsRoot: found.scope.sessionsRoot,
							directoryPath: found.scope.directoryPath,
						},
						receipt: found.receipt,
					}
				: undefined;
		},
	};
	try {
		return await operation(authority);
	} finally {
		await lock.release();
	}
}

async function ownerReceipt(fixture: Fixture): Promise<ManagedGcSessionRetirementReceipt | undefined> {
	return readManagedGcSessionRetirementReceipt(fixture.scope, fixture.transcriptPath);
}

describe("managed GC owner-cleanup API", () => {
	it("captures and persists prepared authority from a real transcript and owner tree", async () => {
		const fixture = makeFixture();
		expect(fs.existsSync(fixture.ownerPath)).toBe(true);
		await withAuthority(fixture, async authority => {
			const prepared = await prepareManagedGcOwnerTarget(authority, fixture.candidate);
			expect(prepared.taskArtifactOwnerDeletionEvidence).toEqual(fixture.evidence);
			const receipt = await authority.readReceipt(fixture.transcriptPath);
			expect(receipt).toMatchObject({
				state: "prepared",
				transcriptPath: fixture.transcriptPath,
				sessionId: fixture.sessionId,
				taskArtifactOwnerDeletionEvidence: fixture.evidence,
			});
		});
	});

	it("does not advance prepared artifact authority after a real owner preflight refusal", async () => {
		const fixture = makeFixture();
		await withAuthority(fixture, async authority => {
			const prepared = await prepareManagedGcOwnerTarget(authority, fixture.candidate);
			const fields = await managedGcOwnerDeleteFields(authority, prepared);
			fs.mkdirSync(path.join(fixture.scope.directoryPath, ".gjc-managed-session-internal.saved"), { mode: 0o700 });
			const deletion = await new FileSessionStorage().deleteSessionVerified(
				{
					sessionsRoot: fixture.sessionsRoot,
					...authority.bindTarget(fixture.transcriptPath),
					...fields,
					plannedArtifactsPath: path.join(fixture.scope.directoryPath, ".gjc-delete-api-preflight-artifacts"),
					plannedTranscriptPath: path.join(fixture.scope.directoryPath, ".gjc-delete-api-preflight-transcript"),
				},
				authority.inspectProtocol,
			);
			if (deletion.kind !== "cleanup_pending" || deletion.phase !== "task_artifact_owner")
				throw new Error(`Expected real owner preflight refusal, got ${deletion.kind}`);
			expect(deletion.artifactsRemoved).toBe(false);
			const progress = await persistManagedGcStorageOwnerDisposition(authority, prepared, deletion);
			expect(progress.state).toBe("pending");
			const receipt = await authority.readReceipt(fixture.transcriptPath);
			expect(receipt?.state).toBe("prepared");
			expect(receipt?.artifactsRemoved).toBeUndefined();
			expect(fs.existsSync(fixture.transcriptPath)).toBe(true);
			expect(fs.readFileSync(path.join(fixture.ownerPath, "payload.bin"), "utf8")).toBe("real-owner-payload");
		});
	});

	it("supplies only persisted receipt authority to native deletion", async () => {
		const fixture = makeFixture();
		await withAuthority(fixture, async authority => {
			const prepared = await prepareManagedGcOwnerTarget(authority, fixture.candidate);
			const fields = await managedGcOwnerDeleteFields(authority, prepared);
			expect(fields.taskArtifactOwnerStorageContext).toEqual(authority.storageContext);
			expect(fields.taskArtifactOwnerDeletionEvidence).toEqual(fixture.evidence);
			expect(fields.deferTaskArtifactOwnerRetirement).toBe(true);
			expect(fields.taskArtifactOwnerRetired).toBeUndefined();
		});
		const receipt = await ownerReceipt(fixture);
		expect(receipt?.state).toBe("prepared");
	});

	it("inherits only a live-verified completed receipt from another authenticated v2 scope", async () => {
		const fixture = makeFixture();
		const sibling = makeSiblingTarget(fixture);
		let ownerTarget!: ManagedGcOwnerCleanupTarget;
		let siblingTarget!: ManagedGcOwnerCleanupTarget;
		await withAuthority(fixture, async authority => {
			ownerTarget = await prepareManagedGcOwnerTarget(authority, fixture.candidate);
			await authority.publishReceipt({
				...authority.bindTarget(fixture.transcriptPath),
				state: "artifacts_removed",
				taskArtifactOwnerDeletionEvidence: fixture.evidence,
				artifactsRemoved: true,
			});
		});
		await withAuthority(
			fixture,
			async authority => {
				siblingTarget = await prepareManagedGcOwnerTarget(authority, sibling.candidate);
				await authority.publishReceipt({
					...authority.bindTarget(sibling.transcriptPath),
					state: "artifacts_removed",
					taskArtifactOwnerDeletionEvidence: fixture.evidence,
					artifactsRemoved: true,
				});
			},
			sibling.scope,
		);

		removeTranscript(sibling.scope, sibling.transcriptPath);
		let sourceReceipt: ManagedGcSessionRetirementReceipt | undefined;
		let sourceProgress: Awaited<ReturnType<typeof retireManagedGcOwnerAfterArtifacts>> | undefined;
		await withAuthority(fixture, async authority => {
			sourceProgress = await retireManagedGcOwnerAfterArtifacts(authority, ownerTarget, [ownerTarget]);
			sourceReceipt = await authority.readReceipt(fixture.transcriptPath);
			expect(sourceReceipt).toBeDefined();
		});

		if (sourceProgress?.state === "owner_retired") {
			verifyTaskArtifactOwnerPhysicalRetirement(
				taskArtifactOwnerStorageContextForScope(fixture.scope),
				fixture.evidence,
				sourceReceipt?.taskArtifactOwnerRetirementOutcome,
			);
			removeTranscript(fixture.scope, fixture.transcriptPath);
			await withAuthority(
				fixture,
				async authority => {
					const found = await authority.findCompletedRetirement(fixture.evidence, sibling.transcriptPath);
					expect(found?.receipt.state).toBe("owner_retired");
					expect(found?.receipt.taskArtifactOwnerDeletionEvidence).toEqual(fixture.evidence);
					const progress = await retireManagedGcOwnerAfterArtifacts(authority, siblingTarget, [siblingTarget]);
					expect(progress.state).toBe("owner_retired");
					const inherited = await authority.readReceipt(sibling.transcriptPath);
					expect(inherited?.state).toBe("owner_retired");
					expect(inherited?.taskArtifactOwnerDeletionEvidence).toEqual(fixture.evidence);
					expect(inherited?.taskArtifactOwnerRetirementOutcome).toEqual(
						sourceReceipt?.taskArtifactOwnerRetirementOutcome,
					);
					verifyTaskArtifactOwnerPhysicalRetirement(
						authority.storageContext,
						fixture.evidence,
						inherited?.taskArtifactOwnerRetirementOutcome,
					);
				},
				sibling.scope,
			);
		} else {
			expect(sourceReceipt?.state).toBe("owner_pending");
			removeTranscript(fixture.scope, fixture.transcriptPath);
			await withAuthority(
				fixture,
				async authority => {
					expect(
						await authority.findCompletedRetirement(fixture.evidence, sibling.transcriptPath),
					).toBeUndefined();
					const progress = await retireManagedGcOwnerAfterArtifacts(authority, siblingTarget, [siblingTarget]);
					const receipt = await authority.readReceipt(sibling.transcriptPath);
					if (progress.state === "owner_retired") {
						expect(receipt?.state).toBe("owner_retired");
						verifyTaskArtifactOwnerPhysicalRetirement(
							authority.storageContext,
							fixture.evidence,
							receipt?.taskArtifactOwnerRetirementOutcome,
						);
					} else {
						expect(receipt?.state).toBe("owner_pending");
						expect(receipt?.taskArtifactOwnerRetirementOutcome?.kind).not.toBe("completed");
					}
				},
				sibling.scope,
			);
		}
	});

	it("rejects a completed receipt without native disposition and preserves the live owner", async () => {
		const fixture = makeFixture();
		await withAuthority(fixture, async authority => {
			const target = await prepareManagedGcOwnerTarget(authority, fixture.candidate);
			await authority.publishReceipt({
				...authority.bindTarget(fixture.transcriptPath),
				state: "artifacts_removed",
				taskArtifactOwnerDeletionEvidence: fixture.evidence,
				artifactsRemoved: true,
			});
			const sourceScope = {
				agentDir: fixture.agentDir,
				sessionsRoot: fixture.sessionsRoot,
				directoryPath: path.join(fixture.sessionsRoot, `v2-${"a".repeat(52)}`),
			};
			const forged: ManagedGcSessionRetirementReceipt = {
				...authority.bindTarget(fixture.transcriptPath),
				transcriptPath: path.join(sourceScope.directoryPath, "retired.jsonl"),
				state: "owner_retired",
				taskArtifactOwnerDeletionEvidence: fixture.evidence,
				artifactsRemoved: true,
				taskArtifactOwnerRetirementOutcome: { kind: "completed", evidence: fixture.evidence },
				taskArtifactOwnerRetired: true,
			};
			const untrustedLookup: ManagedGcOwnerCleanupAuthority = {
				...authority,
				findCompletedRetirement: async () => ({ scope: sourceScope, receipt: forged }),
			};
			await expect(retireManagedGcOwnerAfterArtifacts(untrustedLookup, target, [target])).rejects.toThrow(
				"task_artifact_owner_retirement_outcome_invalid",
			);
			expect(fs.existsSync(fixture.ownerPath)).toBe(true);
			expect((await authority.readReceipt(fixture.transcriptPath))?.state).toBe("artifacts_removed");
		});
	});

	it("runs native owner retirement and records its actual terminal or pending proof", async () => {
		const fixture = makeFixture();
		await withAuthority(fixture, async authority => {
			const target = await prepareManagedGcOwnerTarget(authority, fixture.candidate);
			const progress = await retireManagedGcOwnerAfterArtifacts(authority, target, [target]);
			const receipt = await authority.readReceipt(fixture.transcriptPath);
			expect(receipt).toBeDefined();
			if (progress.state === "owner_retired") {
				expect(receipt?.state).toBe("owner_retired");
				expect(receipt?.taskArtifactOwnerRetirementOutcome?.kind).toBe("completed");
				verifyTaskArtifactOwnerPhysicalRetirement(
					authority.storageContext,
					fixture.evidence,
					receipt?.taskArtifactOwnerRetirementOutcome,
				);
				expect(fs.existsSync(fixture.ownerPath)).toBe(false);
			} else {
				expect(["pending", "payload_retired"]).toContain(progress.state);
				expect(receipt?.state).toBe("owner_pending");
				const outcome = receipt?.taskArtifactOwnerRetirementOutcome;
				expect(outcome).toBeDefined();
				expect(outcome?.kind).not.toBe("completed");
				expect(outcome?.evidence).toEqual(fixture.evidence);
				if (outcome && outcome.kind !== "completed")
					expect(receipt?.taskArtifactOwnerRetirementContinuation).toEqual(outcome.continuation);
				if (receipt?.taskArtifactOwnerRetirementOutcome?.kind === "payload_retired") {
					expect(receipt.taskArtifactOwnerRetirementOutcome.nativeOutcome.ok).toBe(false);
					expect(receipt.taskArtifactOwnerRetirementOutcome.nativeOutcome.code).toBe("cleanup_pending");
					expect(receipt.taskArtifactOwnerRetirementOutcome.nativeOutcome.payloadDurable).toBe(true);
				}
			}
		});
	});
});
