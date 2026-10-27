import { afterEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ManagedGcSessionRetirementReceipt,
	ManagedGcSessionRetirementTarget,
} from "../src/session/internal/managed-gc-retirement-codec";
import {
	bindManagedGcSessionRetirementTarget,
	deleteManagedSessionCandidate,
	listManagedCandidates,
	type ManagedCandidate,
	type ManagedDeleteCandidateResult,
	type ManagedScope,
	ManagedSessionScopeTestHooks,
	managedDirectoryIdentityForScope,
	prepareManagedSessionScopeForWriteSync,
	publishManagedGcSessionRetirementReceipt,
	readManagedGcSessionRetirementReceipt,
	reconcileManagedTombstones,
	resolveManagedScope,
	resolveManagedScopeForWrite,
	taskArtifactOwnerStorageContextForScope,
} from "../src/session/internal/managed-session-scope";
import { ManagedSessionDescendantStore } from "../src/session/internal/managed-session-storage";
import {
	captureTaskArtifactOwnerDeletionEvidence,
	newSessionRootStore,
} from "../src/session/internal/task-artifact-owner-access";
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

interface Fixture {
	readonly root: string;
	readonly agentDir: string;
	readonly sessionsRoot: string;
	readonly cwd: string;
	readonly scope: ManagedScope;
	readonly sessionId: string;
	readonly transcriptPath: string;
	readonly locator: TaskArtifactOwnerLocator;
	readonly ownerPath: string;
	readonly payloadPath: string;
	readonly evidence: TaskArtifactOwnerDeletionEvidence;
	readonly target: ManagedGcSessionRetirementTarget;
}

const roots: string[] = [];

afterEach(() => {
	ManagedSessionScopeTestHooks.beforeVerifiedDelete = undefined;
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeScope(agentDir: string, sessionsRoot: string, cwd: string): ManagedScope {
	const resolved = resolveManagedScopeForWrite({ agentDir, sessionsRoot, cwd });
	if (resolved.kind !== "resolved") throw new Error(`fixture_scope_resolution_failed:${resolved.code}`);
	const prepared = prepareManagedSessionScopeForWriteSync(resolved.scope);
	if (prepared.kind !== "resolved") throw new Error(`fixture_scope_prepare_failed:${prepared.code}`);
	return prepared.scope;
}

function scopeStore(scope: ManagedScope): ManagedSessionDescendantStore {
	const context = taskArtifactOwnerStorageContextForScope(scope);
	const identity = managedDirectoryIdentityForScope(scope);
	return new ManagedSessionDescendantStore(
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
}

function writeTranscript(
	scope: ManagedScope,
	transcriptPath: string,
	sessionId: string,
	cwd: string,
	locator: TaskArtifactOwnerLocator,
): void {
	const store = scopeStore(scope);
	try {
		store.publishNoReplaceSync(
			path.basename(transcriptPath),
			Buffer.from(
				`${JSON.stringify({ type: "session", id: sessionId, cwd, version: 4, taskArtifactOwner: locator })}\n`,
				"utf8",
			),
		);
	} finally {
		store.close();
	}
}

function makeFixture(): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-task-owner-cleanup-"));
	roots.push(root);
	const agentDir = path.join(root, "profile");
	const sessionsRoot = path.join(agentDir, "sessions");
	const cwd = path.join(root, "workspace-a");
	fs.mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 });
	fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
	const scope = makeScope(agentDir, sessionsRoot, cwd);
	const context = taskArtifactOwnerStorageContextForScope(scope);
	const sessionId = `managed-owner-cleanup-${crypto.randomUUID()}`;
	const ownerId = ownerIdForSession(sessionId);
	const rootStore = newSessionRootStore(context);
	let locator: TaskArtifactOwnerLocator | undefined;
	let ownerPath: string | undefined;
	try {
		rootStore.ensureDirectory(OWNER_DIRECTORY);
		const directory = rootStore.ensureDirectory(ownerRelativePath(ownerId));
		locator = parseTaskArtifactOwnerLocator({
			schemaVersion: OWNER_SCHEMA_VERSION,
			ownerId,
			directoryDev: directory.dev.toString(),
			directoryIno: directory.ino.toString(),
		});
		if (!locator) throw new Error("fixture_owner_locator_missing");
		ownerPath = path.join(sessionsRoot, ownerRelativePath(ownerId));
		const ownerStore = rootStore.deriveSubtree(ownerRelativePath(ownerId));
		try {
			ownerStore.publishNoReplaceSync(
				OWNER_MANIFEST,
				Buffer.from(`${JSON.stringify({ ...locator, sessionId })}\n`, "utf8"),
			);
			ownerStore.publishNoReplaceSync("payload.bin", Buffer.from("owner-payload", "utf8"));
		} finally {
			ownerStore.close();
		}
	} finally {
		rootStore.close();
	}
	if (!locator || !ownerPath) throw new Error("fixture_owner_locator_missing");
	const transcriptPath = path.join(scope.directoryPath, `${sessionId}.jsonl`);
	writeTranscript(scope, transcriptPath, sessionId, cwd, locator);
	const evidence = captureTaskArtifactOwnerDeletionEvidence(context, sessionId, locator);
	if (!evidence) throw new Error("fixture_owner_evidence_missing");
	return {
		root,
		agentDir,
		sessionsRoot,
		cwd,
		scope,
		sessionId,
		transcriptPath,
		locator,
		ownerPath,
		payloadPath: path.join(ownerPath, "payload.bin"),
		evidence,
		target: bindManagedGcSessionRetirementTarget(scope, transcriptPath),
	};
}

function candidateFor(scope: ManagedScope, transcriptPath: string): ManagedCandidate {
	const listing = listManagedCandidates(scope);
	if (listing.kind !== "complete") throw new Error(`fixture_candidate_listing_failed:${listing.kind}`);
	const candidate = listing.owned.find(item => item.path === transcriptPath);
	if (!candidate) throw new Error("fixture_candidate_missing");
	return candidate;
}

function legacyDirectory(sessionsRoot: string, cwd: string): string {
	return path.join(
		sessionsRoot,
		`--${path
			.resolve(cwd)
			.replace(/^[/\\]/, "")
			.replace(/[/\\:]/g, "-")}--`,
	);
}

async function ownerReceipt(fixture: Fixture): Promise<ManagedGcSessionRetirementReceipt | undefined> {
	return readManagedGcSessionRetirementReceipt(fixture.scope, fixture.transcriptPath);
}

function snapshotReadonlyTree(root: string): unknown {
	const entries: unknown[] = [];
	const visit = (pathname: string, relative: string) => {
		const stat = fs.lstatSync(pathname, { bigint: true });
		const base = {
			relative,
			dev: stat.dev.toString(),
			ino: stat.ino.toString(),
			mode: stat.mode.toString(),
			ctimeNs: stat.ctimeNs.toString(),
			kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
		};
		if (stat.isDirectory() && !stat.isSymbolicLink()) {
			entries.push(base);
			for (const name of fs.readdirSync(pathname).sort())
				visit(path.join(pathname, name), path.join(relative, name));
		} else entries.push({ ...base, bytes: stat.isFile() ? fs.readFileSync(pathname).toString("base64") : undefined });
	};
	visit(root, ".");
	return entries;
}

async function addSiblingTranscript(
	fixture: Fixture,
): Promise<{ scope: ManagedScope; path: string; candidate: ManagedCandidate }> {
	const siblingCwd = path.join(fixture.root, "workspace-b");
	fs.mkdirSync(siblingCwd, { mode: 0o700 });
	const scope = makeScope(fixture.agentDir, fixture.sessionsRoot, siblingCwd);
	const transcriptPath = path.join(scope.directoryPath, `${fixture.sessionId}-sibling.jsonl`);
	writeTranscript(scope, transcriptPath, fixture.sessionId, siblingCwd, fixture.locator);
	return { scope, path: transcriptPath, candidate: candidateFor(scope, transcriptPath) };
}

describe("managed task-artifact owner cleanup", () => {
	it("establishes async writer authority for an owner-bearing cold scope", async () => {
		const fixture = makeFixture();
		const cold = resolveManagedScope({
			agentDir: fixture.agentDir,
			sessionsRoot: fixture.sessionsRoot,
			cwd: fixture.cwd,
		});
		if (cold.kind !== "resolved") throw new Error("Expected the existing cold scope");
		expect(() => taskArtifactOwnerStorageContextForScope(cold.scope)).toThrow(
			"managed_gc_scope_authority_unavailable",
		);
		const result = await deleteManagedSessionCandidate(cold.scope, candidateFor(cold.scope, fixture.transcriptPath));
		const receipt = await ownerReceipt(fixture);
		if (!receipt) throw new Error(`Expected native owner disposition, received ${JSON.stringify(result)}`);
		expect(receipt.taskArtifactOwnerDeletionEvidence).toEqual(fixture.evidence);
		if (receipt.state === "owner_retired") {
			expect(receipt.taskArtifactOwnerRetirementOutcome?.kind).toBe("completed");
			expect(result.kind).toBe("deleted");
		} else {
			expect(receipt.state).toBe("owner_pending");
			expect(result).toMatchObject({ kind: "cleanup_pending", phase: "artifacts" });
			expect(receipt.taskArtifactOwnerRetirementOutcome?.kind).toBe("payload_retired");
		}
	});

	it("preserves owner-free deletion through a cold async scope", async () => {
		const fixture = makeFixture();
		const sessionId = `${fixture.sessionId}-owner-free`;
		const transcriptPath = path.join(fixture.scope.directoryPath, `${sessionId}.jsonl`);
		const store = scopeStore(fixture.scope);
		try {
			store.publishNoReplaceSync(
				path.basename(transcriptPath),
				Buffer.from(`${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: fixture.cwd })}\n`),
			);
		} finally {
			store.close();
		}
		const cold = resolveManagedScope({
			agentDir: fixture.agentDir,
			sessionsRoot: fixture.sessionsRoot,
			cwd: fixture.cwd,
		});
		if (cold.kind !== "resolved") throw new Error("Expected the existing cold scope");
		const result = await deleteManagedSessionCandidate(cold.scope, candidateFor(cold.scope, transcriptPath));
		expect(result.kind).toBe("deleted");
		expect(fs.existsSync(transcriptPath)).toBe(false);
		expect(fs.readFileSync(fixture.payloadPath, "utf8")).toBe("owner-payload");
		expect(fs.existsSync(fixture.transcriptPath)).toBe(true);
	});

	it("persists owner disposition before transcript deletion and replays a crash at the transcript fence", async () => {
		const fixture = makeFixture();
		let interrupted = false;
		ManagedSessionScopeTestHooks.beforeVerifiedDelete = event => {
			if (event.stage === "transcript-after-artifacts-removed") {
				interrupted = true;
				throw new Error("simulated_transcript_crash");
			}
		};
		let interruptedResult: ManagedDeleteCandidateResult | undefined;
		try {
			interruptedResult = await deleteManagedSessionCandidate(
				fixture.scope,
				candidateFor(fixture.scope, fixture.transcriptPath),
			);
		} finally {
			ManagedSessionScopeTestHooks.beforeVerifiedDelete = undefined;
		}
		if (interrupted)
			expect(interruptedResult).toMatchObject({ kind: "error", message: "simulated_transcript_crash" });
		else expect(interruptedResult).toMatchObject({ kind: "cleanup_pending", phase: "artifacts" });
		expect(fs.existsSync(fixture.transcriptPath)).toBe(true);
		const beforeReplay = await ownerReceipt(fixture);
		if (!beforeReplay) throw new Error("Expected the persisted owner retirement disposition before replay");
		expect(["owner_pending", "owner_retired"]).toContain(beforeReplay.state);
		expect(beforeReplay?.taskArtifactOwnerDeletionEvidence).toEqual(fixture.evidence);
		const restarted = makeScope(fixture.agentDir, fixture.sessionsRoot, fixture.cwd);
		await reconcileManagedTombstones(restarted);
		const afterReplay = await readManagedGcSessionRetirementReceipt(restarted, fixture.transcriptPath);
		if (!afterReplay) throw new Error("Expected the immutable owner retirement receipt after replay");
		if (afterReplay.state === "owner_retired") {
			expect(fs.existsSync(fixture.transcriptPath)).toBe(false);
			expect(afterReplay.taskArtifactOwnerRetirementOutcome?.kind).toBe("completed");
		} else if (afterReplay?.state === "owner_pending") {
			expect(afterReplay.taskArtifactOwnerDeletionEvidence).toEqual(fixture.evidence);
			const outcome = afterReplay.taskArtifactOwnerRetirementOutcome;
			if (outcome?.kind === "payload_retired") {
				expect(outcome.nativeOutcome.ok).toBe(false);
				expect(outcome.nativeOutcome.code).toBe("cleanup_pending");
				expect(outcome.nativeOutcome.payloadDurable).toBe(true);
				expect(afterReplay.taskArtifactOwnerPayloadRetired).toBe(true);
				expect(afterReplay.taskArtifactOwnerNamespaceRetained).toBe(true);
				expect(fs.existsSync(fixture.transcriptPath)).toBe(false);
				const tombstoneDir = path.join(fixture.scope.directoryPath, ".gjc-managed-session-internal", "tombstones");
				const names = fs.readdirSync(tombstoneDir);
				const tombstoneName = names.find(name => {
					if (name.includes(".cleanup-") || !name.endsWith(".json")) return false;
					const record = JSON.parse(fs.readFileSync(path.join(tombstoneDir, name), "utf8")) as {
						targets?: Array<{ path?: string }>;
					};
					return record.targets?.some(target => target.path === fixture.transcriptPath) ?? false;
				});
				expect(tombstoneName).toBeDefined();
				const pending = names
					.filter(name => name.includes(".cleanup-pending-"))
					.map(
						name =>
							JSON.parse(fs.readFileSync(path.join(tombstoneDir, name), "utf8")) as {
								target?: { path?: string };
								taskArtifactOwnerTranscriptDeleted?: boolean;
							},
					);
				expect(
					pending.some(
						record => record.target?.path === fixture.transcriptPath && record.taskArtifactOwnerTranscriptDeleted,
					),
				).toBe(true);
				const completed = names
					.filter(name => name.includes(".cleanup-completed-"))
					.map(
						name =>
							JSON.parse(fs.readFileSync(path.join(tombstoneDir, name), "utf8")) as {
								target?: { path?: string };
							},
					);
				expect(completed.some(record => record.target?.path === fixture.transcriptPath)).toBe(false);
			} else {
				expect(fs.existsSync(fixture.transcriptPath)).toBe(true);
			}
		} else {
			expect(["prepared", "artifacts_removed"]).toContain(afterReplay.state);
			expect(fs.existsSync(fixture.transcriptPath)).toBe(true);
		}
	});

	it("keeps live same-evidence sibling transcripts pending and rejects forged completion", async () => {
		const fixture = makeFixture();
		const sibling = await addSiblingTranscript(fixture);
		const first = await deleteManagedSessionCandidate(
			fixture.scope,
			candidateFor(fixture.scope, fixture.transcriptPath),
		);
		expect(first).toMatchObject({ kind: "cleanup_pending", phase: "artifacts" });
		expect(fs.existsSync(fixture.transcriptPath)).toBe(true);
		expect(fs.existsSync(sibling.path)).toBe(true);
		expect(fs.readFileSync(fixture.payloadPath, "utf8")).toBe("owner-payload");
		const firstReceipt = await ownerReceipt(fixture);
		expect(firstReceipt?.state).toBe("prepared");
		const second = await deleteManagedSessionCandidate(sibling.scope, sibling.candidate);
		expect(second).toMatchObject({ kind: "cleanup_pending", phase: "artifacts" });
		const secondReceipt = await readManagedGcSessionRetirementReceipt(sibling.scope, sibling.path);
		expect(secondReceipt?.taskArtifactOwnerDeletionEvidence).toEqual(firstReceipt?.taskArtifactOwnerDeletionEvidence);
		expect(secondReceipt?.state).toBe("prepared");
		expect(fs.existsSync(fixture.transcriptPath)).toBe(true);
		expect(fs.existsSync(sibling.path)).toBe(true);
		const siblingTarget = bindManagedGcSessionRetirementTarget(sibling.scope, sibling.path);
		await expect(
			publishManagedGcSessionRetirementReceipt(sibling.scope, {
				...siblingTarget,
				state: "owner_retired",
				taskArtifactOwnerDeletionEvidence: fixture.evidence,
				artifactsRemoved: true,
				taskArtifactOwnerRetirementOutcome: {
					kind: "completed",
					evidence: fixture.evidence,
				},
				taskArtifactOwnerRetired: true,
			}),
		).rejects.toThrow();
		expect(fs.existsSync(fixture.payloadPath)).toBe(true);
		expect(fs.existsSync(fixture.transcriptPath)).toBe(true);
		expect(fs.existsSync(sibling.path)).toBe(true);
	});

	it("leaves owner-bearing legacy transcripts untouched until scope-local authority exists", async () => {
		const fixture = makeFixture();
		const legacyId = `legacy-owner-${crypto.randomUUID()}`;
		const legacy = legacyDirectory(fixture.sessionsRoot, fixture.cwd);
		fs.mkdirSync(legacy, { recursive: true, mode: 0o700 });
		const legacyPath = path.join(legacy, `${legacyId}.jsonl`);
		fs.writeFileSync(
			legacyPath,
			`${JSON.stringify({ type: "session", id: legacyId, cwd: fixture.cwd, version: 4, taskArtifactOwner: fixture.locator })}\n`,
			{ mode: 0o600 },
		);
		const before = snapshotReadonlyTree(fixture.sessionsRoot);
		const candidate = candidateFor(fixture.scope, legacyPath);
		const result = await deleteManagedSessionCandidate(fixture.scope, candidate);
		expect(result).toMatchObject({
			kind: "cleanup_pending",
			phase: "artifacts",
			message: "task_artifact_owner_legacy_scope_unsupported",
		});
		if (result.kind !== "cleanup_pending") throw new Error("legacy_owner_cleanup_not_pending");
		expect(fs.existsSync(result.tombstonePath)).toBe(false);
		expect(fs.readFileSync(legacyPath, "utf8")).toContain(fixture.locator.ownerId);
		expect(fs.readFileSync(fixture.payloadPath, "utf8")).toBe("owner-payload");
		expect(snapshotReadonlyTree(fixture.sessionsRoot)).toEqual(before);
	});

	it("keeps ownerless legacy transcript cleanup on its existing path", async () => {
		const fixture = makeFixture();
		const legacyId = `legacy-plain-${crypto.randomUUID()}`;
		const legacy = legacyDirectory(fixture.sessionsRoot, fixture.cwd);
		fs.mkdirSync(legacy, { recursive: true, mode: 0o700 });
		const legacyPath = path.join(legacy, `${legacyId}.jsonl`);
		fs.writeFileSync(
			legacyPath,
			`${JSON.stringify({ type: "session", id: legacyId, cwd: fixture.cwd, version: 4 })}\n`,
			{ mode: 0o600 },
		);
		const result = await deleteManagedSessionCandidate(fixture.scope, candidateFor(fixture.scope, legacyPath));
		expect(result.kind).toBe("deleted");
		expect(fs.existsSync(legacyPath)).toBe(false);
		expect(fs.readFileSync(fixture.payloadPath, "utf8")).toBe("owner-payload");
	});

	it("fails closed when staging and replacement publication markers appear after capture", async () => {
		const fixture = makeFixture();
		const staging = path.join(fixture.ownerPath, `.payload.bin.${crypto.randomUUID()}.staging`);
		const replacement = path.join(fixture.ownerPath, `.payload.bin.${crypto.randomUUID()}.replacement`);
		let created = false;
		ManagedSessionScopeTestHooks.beforeVerifiedDelete = event => {
			if (event.stage !== "initial" || created) return;
			created = true;
			fs.writeFileSync(staging, "writer");
			fs.writeFileSync(replacement, "writer");
		};
		let deletionResult: ManagedDeleteCandidateResult | undefined;
		try {
			deletionResult = await deleteManagedSessionCandidate(
				fixture.scope,
				candidateFor(fixture.scope, fixture.transcriptPath),
			);
		} finally {
			ManagedSessionScopeTestHooks.beforeVerifiedDelete = undefined;
		}
		expect(deletionResult).toMatchObject({ kind: "error" });
		expect(fs.existsSync(fixture.transcriptPath)).toBe(true);
		expect(fs.readFileSync(fixture.payloadPath, "utf8")).toBe("owner-payload");
		expect(fs.existsSync(staging)).toBe(true);
		expect(fs.existsSync(replacement)).toBe(true);
		const receipt = await ownerReceipt(fixture);
		expect(receipt?.state).toBe("prepared");
	});

	it("rejects profile-root replacement without touching the captured transcript or owner", async () => {
		const fixture = makeFixture();
		const candidate = candidateFor(fixture.scope, fixture.transcriptPath);
		const retainedProfile = `${fixture.agentDir}.retained`;
		fs.renameSync(fixture.agentDir, retainedProfile);
		fs.mkdirSync(path.join(fixture.agentDir, "sessions"), { recursive: true, mode: 0o700 });
		const movedTranscript = path.join(retainedProfile, path.relative(fixture.agentDir, fixture.transcriptPath));
		const result = await deleteManagedSessionCandidate(fixture.scope, candidate);
		expect(result.kind).not.toBe("deleted");
		expect(result.kind).not.toBe("already_deleted");
		expect(fs.readFileSync(movedTranscript, "utf8")).toContain(fixture.locator.ownerId);
		expect(fs.readFileSync(fixture.payloadPath.replace(fixture.agentDir, retainedProfile), "utf8")).toBe(
			"owner-payload",
		);
	});

	it("persists actual native namespace-pending outcomes without accepting DTO-only completion", async () => {
		const fixture = makeFixture();
		const result = await deleteManagedSessionCandidate(
			fixture.scope,
			candidateFor(fixture.scope, fixture.transcriptPath),
		);
		const receipt = await ownerReceipt(fixture);
		expect(receipt).toBeDefined();
		if (receipt?.state === "prepared" || receipt?.state === "artifacts_removed") {
			expect(result).toMatchObject({ kind: "cleanup_pending", phase: "artifacts" });
			expect(fs.existsSync(fixture.transcriptPath)).toBe(true);
		} else if (receipt?.state === "owner_pending") {
			expect(result).toMatchObject({ kind: "cleanup_pending" });
			expect(receipt.taskArtifactOwnerRetired).toBeUndefined();
			expect(receipt.taskArtifactOwnerRetirementOutcome?.kind).not.toBe("completed");
			if (receipt.taskArtifactOwnerRetirementOutcome?.kind === "payload_retired") {
				expect(receipt.taskArtifactOwnerRetirementOutcome.nativeOutcome.ok).toBe(false);
				expect(receipt.taskArtifactOwnerRetirementOutcome.nativeOutcome.code).toBe("cleanup_pending");
			}
			await expect(
				publishManagedGcSessionRetirementReceipt(fixture.scope, {
					...fixture.target,
					state: "owner_retired",
					taskArtifactOwnerDeletionEvidence: fixture.evidence,
					artifactsRemoved: true,
					taskArtifactOwnerRetirementOutcome: {
						kind: "completed",
						evidence: fixture.evidence,
					},
					taskArtifactOwnerRetired: true,
				}),
			).rejects.toThrow();
		} else {
			expect(receipt?.state).toBe("owner_retired");
			expect(["deleted", "cleanup_pending"]).toContain(result.kind);
			if (result.kind === "cleanup_pending") expect(result.phase).toBe("transcript");
		}
	});
});
