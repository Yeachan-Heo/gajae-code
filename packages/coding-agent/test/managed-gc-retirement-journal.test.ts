import { afterEach, describe, expect, it, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import {
	type ManagedGcSessionRetirementReceipt,
	type ManagedGcSessionRetirementTarget,
	managedGcRetirementIdentityRecord,
} from "../src/session/internal/managed-gc-retirement-codec";
import {
	bindManagedGcSessionRetirementTarget,
	computeManagedScopeDigest,
	deleteManagedSessionCandidate,
	discoverManagedGcSessionRetirementReceipts,
	listManagedCandidates,
	type ManagedScope,
	ManagedSessionScopeTestHooks,
	managedDirectoryIdentityForScope,
	prepareManagedSessionScopeForWriteSync,
	publishManagedGcSessionRetirementReceipt,
	readManagedGcSessionRetirementReceipt,
	readManagedGcSessionRetirementReceiptReadOnly,
	reconcileManagedTombstones,
	resolveManagedGcScopeForRead,
	resolveManagedScopeForWrite,
	taskArtifactOwnerStorageContextForScope,
} from "../src/session/internal/managed-session-scope";
import { ManagedSessionDescendantStore } from "../src/session/internal/managed-session-storage";
import {
	captureTaskArtifactOwnerDeletionEvidence,
	newSessionRootStore,
} from "../src/session/internal/task-artifact-owner-access";
import { FileSessionStorage } from "../src/session/session-storage";
import {
	immutableDeletionEvidence,
	OWNER_DIRECTORY,
	OWNER_MANIFEST,
	OWNER_SCHEMA_VERSION,
	ownerAbsolutePath,
	ownerIdForSession,
	ownerRelativePath,
	parseTaskArtifactOwnerLocator,
	type TaskArtifactOwnerDeletionEvidence,
	type TaskArtifactOwnerLocator,
	type TaskArtifactOwnerRetirementContinuation,
} from "../src/session/task-artifact-owner-codec";
import { retireTaskArtifactOwner } from "../src/session/task-artifact-owner-retirement";

interface Fixture {
	readonly temporaryRoot: string;
	readonly agentDir: string;
	readonly sessionsRoot: string;
	readonly cwd: string;
	readonly scope: ManagedScope;
	readonly transcriptPath: string;
	readonly target: ManagedGcSessionRetirementTarget;
	readonly evidence: TaskArtifactOwnerDeletionEvidence;
}

const temporaryRoots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	ManagedSessionScopeTestHooks.beforeVerifiedDelete = undefined;
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("owner-aware readonly data does not authorize legacy effects", () => {
	it("refuses a live owner locator introduced only by a v4 header patch before deleting artifacts", async () => {
		const fixture = makeFixture();
		const locator = fixture.evidence.locator;
		await Bun.write(
			fixture.transcriptPath,
			`${JSON.stringify({ type: "session", version: 4, id: fixture.target.sessionId, cwd: fixture.cwd })}\n${JSON.stringify({ type: "header_patch", patch: { taskArtifactOwner: locator } })}\n`,
		);
		const listed = listManagedCandidates(fixture.scope);
		if (listed.kind !== "complete") throw new Error(listed.message);
		const candidate = listed.owned.find(value => value.path === fixture.transcriptPath);
		if (!candidate) throw new Error("owner_candidate_missing");
		const artifactRoot = fixture.transcriptPath.slice(0, -6);
		fs.mkdirSync(artifactRoot, { mode: 0o700 });
		await Bun.write(path.join(artifactRoot, "retained.txt"), "retained artifact");
		const before = fs.readFileSync(fixture.transcriptPath);
		const unlink = vi.spyOn(native, "exactUnlink");
		const removal = vi.spyOn(native, "exactRemoveDirectoryTree");
		const result = await deleteManagedSessionCandidate(fixture.scope, candidate);
		expect(result).toMatchObject({ kind: "error", message: "task_artifact_owner_legacy_scope_unsupported" });
		expect(fs.readFileSync(fixture.transcriptPath)).toEqual(before);
		expect(fs.readFileSync(path.join(artifactRoot, "retained.txt"), "utf8")).toBe("retained artifact");
		expect(unlink).toHaveBeenCalledTimes(0);
		expect(removal).toHaveBeenCalledTimes(0);
	});

	it("rechecks owner header patches at the immediate deletion fence", async () => {
		const fixture = makeFixture();
		const header = `${JSON.stringify({ type: "session", version: 4, id: fixture.target.sessionId, cwd: fixture.cwd })}\n`;
		await Bun.write(fixture.transcriptPath, header);
		const listed = listManagedCandidates(fixture.scope);
		if (listed.kind !== "complete") throw new Error(listed.message);
		const candidate = listed.owned.find(value => value.path === fixture.transcriptPath);
		if (!candidate) throw new Error("owner_candidate_missing");
		const storage = vi.spyOn(FileSessionStorage.prototype, "deleteSessionVerified");
		ManagedSessionScopeTestHooks.beforeVerifiedDelete = async () => {
			await Bun.write(
				fixture.transcriptPath,
				`${header}${JSON.stringify({ type: "header_patch", patch: { taskArtifactOwner: fixture.evidence.locator } })}\n`,
			);
		};
		const result = await deleteManagedSessionCandidate(fixture.scope, candidate);
		expect(result).toMatchObject({ kind: "error", message: "task_artifact_owner_legacy_scope_unsupported" });
		expect(storage).toHaveBeenCalledTimes(0);
		expect(fs.readFileSync(fixture.transcriptPath, "utf8")).toContain("header_patch");
	});

	it("refuses malformed owner claims instead of treating the tombstone as absent", async () => {
		for (const ownerValue of [null, { sessionId: "foreign" }]) {
			const fixture = makeFixture();
			const listed = listManagedCandidates(fixture.scope);
			if (listed.kind !== "complete") throw new Error(listed.message);
			const candidate = listed.owned.find(value => value.path === fixture.transcriptPath);
			if (!candidate) throw new Error("owner_candidate_missing");
			const tombstone = path.join(
				fixture.scope.directoryPath,
				".gjc-managed-session-internal/tombstones",
				`${"b".repeat(64)}.json`,
			);
			await Bun.write(
				tombstone,
				JSON.stringify(
					{
						schemaVersion: 2,
						state: "retired",
						scope: computeManagedScopeDigest(fixture.scope.platform, fixture.scope.canonicalCwd),
						targets: [{ ...candidate, taskArtifactOwnerDeletionEvidence: ownerValue }],
					},
					(_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
				),
			);
			fs.chmodSync(tombstone, 0o600);
			const before = fs.readFileSync(fixture.transcriptPath);
			const storage = vi.spyOn(FileSessionStorage.prototype, "deleteSessionVerified");
			await expect(reconcileManagedTombstones(fixture.scope)).rejects.toThrow(
				"task_artifact_owner_legacy_scope_unsupported",
			);
			expect(storage).toHaveBeenCalledTimes(0);
			expect(fs.readFileSync(fixture.transcriptPath)).toEqual(before);
			storage.mockRestore();
		}
	});

	it("refuses owner tombstone retirement even when the canonical transcript is absent", async () => {
		const fixture = makeFixture();
		const listed = listManagedCandidates(fixture.scope);
		if (listed.kind !== "complete") throw new Error(listed.message);
		const candidate = listed.owned.find(value => value.path === fixture.transcriptPath);
		if (!candidate) throw new Error("owner_candidate_missing");
		const store = openScopeStore(fixture.scope);
		const name = `${"a".repeat(64)}.json`;
		try {
			store.publishNoReplaceSync(
				`.gjc-managed-session-internal/tombstones/${name}`,
				Buffer.from(
					JSON.stringify(
						{
							schemaVersion: 2,
							state: "retired",
							scope: computeManagedScopeDigest(fixture.scope.platform, fixture.scope.canonicalCwd),
							targets: [{ ...candidate, taskArtifactOwnerDeletionEvidence: fixture.evidence }],
						},
						(_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
					),
				),
			);
		} finally {
			store.close();
		}
		fs.unlinkSync(fixture.transcriptPath);
		const ownerPayload = path.join(
			fixture.sessionsRoot,
			ownerRelativePath(fixture.evidence.locator.ownerId),
			"payload.json",
		);
		const before = fs.readFileSync(ownerPayload);
		const unlink = vi.spyOn(native, "exactUnlink");
		const removal = vi.spyOn(native, "exactRemoveDirectoryTree");
		await expect(reconcileManagedTombstones(fixture.scope)).rejects.toThrow(
			"task_artifact_owner_legacy_scope_unsupported",
		);
		expect(fs.readFileSync(ownerPayload)).toEqual(before);
		expect(
			fs.readdirSync(path.join(fixture.scope.directoryPath, ".gjc-managed-session-internal/tombstones")),
		).toEqual([name]);
		expect(unlink).toHaveBeenCalledTimes(0);
		expect(removal).toHaveBeenCalledTimes(0);
	});
});

function makeScope(agentDir: string, sessionsRoot: string, cwd: string): ManagedScope {
	const result = resolveManagedScopeForWrite({ agentDir, sessionsRoot, cwd });
	if (result.kind !== "resolved") throw new Error(`fixture_scope_resolution_failed:${result.code}`);
	const prepared = prepareManagedSessionScopeForWriteSync(result.scope);
	if (prepared.kind !== "resolved") throw new Error(`fixture_scope_prepare_failed:${prepared.code}`);
	return prepared.scope;
}

function openScopeStore(scope: ManagedScope): ManagedSessionDescendantStore {
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

function makeFixture(): Fixture {
	const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-gc-retirement-journal-"));
	temporaryRoots.push(temporaryRoot);
	const agentDir = path.join(temporaryRoot, "profile");
	const sessionsRoot = path.join(agentDir, "sessions");
	const cwd = path.join(temporaryRoot, "cwd");
	fs.mkdirSync(sessionsRoot, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	const scope = makeScope(agentDir, sessionsRoot, cwd);
	const ownerContext = taskArtifactOwnerStorageContextForScope(scope);
	const sessionId = "managed-gc-journal-fixture";
	const ownerId = ownerIdForSession(sessionId);
	const rootStore = newSessionRootStore(ownerContext);
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
				Buffer.from(
					JSON.stringify({
						schemaVersion: OWNER_SCHEMA_VERSION,
						ownerId,
						directoryDev: locator.directoryDev,
						directoryIno: locator.directoryIno,
						sessionId,
					}),
					"utf8",
				),
			);
			ownerStore.publishNoReplaceSync("payload.json", Buffer.from("fixture payload", "utf8"));
		} finally {
			ownerStore.close();
		}
	} finally {
		rootStore.close();
	}
	if (!locator) throw new Error("fixture_owner_locator_missing");
	const transcriptPath = path.join(scope.directoryPath, "fixture.jsonl");
	const transcriptStore = openScopeStore(scope);
	try {
		transcriptStore.publishNoReplaceSync(
			"fixture.jsonl",
			Buffer.from(
				`${JSON.stringify({
					type: "session",
					id: sessionId,
					cwd,
					version: 3,
					taskArtifactOwner: locator,
				})}\n`,
				"utf8",
			),
		);
	} finally {
		transcriptStore.close();
	}
	const target = bindManagedGcSessionRetirementTarget(scope, transcriptPath);
	const evidence = captureTaskArtifactOwnerDeletionEvidence(ownerContext, sessionId, locator);
	if (!evidence) throw new Error("fixture_owner_evidence_missing");
	return { temporaryRoot, agentDir, sessionsRoot, cwd, scope, transcriptPath, target, evidence };
}

function preparedReceipt(fixture: Fixture): ManagedGcSessionRetirementReceipt {
	return {
		...fixture.target,
		state: "prepared",
		taskArtifactOwnerDeletionEvidence: fixture.evidence,
	};
}

function uncertainContinuation(fixture: Fixture): TaskArtifactOwnerRetirementContinuation {
	return {
		schemaVersion: 1,
		parentIdentity: fixture.evidence.parentIdentity,
		retainedRootPath: ownerAbsolutePath(
			taskArtifactOwnerStorageContextForScope(fixture.scope),
			fixture.target.taskArtifactOwnerLocator.ownerId,
		),
		retainedTreeSnapshot: fixture.evidence.treeSnapshot,
	};
}

function pendingReceipt(fixture: Fixture, reason: string): ManagedGcSessionRetirementReceipt {
	const continuation = uncertainContinuation(fixture);
	return {
		...fixture.target,
		state: "owner_pending",
		taskArtifactOwnerDeletionEvidence: fixture.evidence,
		taskArtifactOwnerRetirementOutcome: {
			kind: "uncertain",
			evidence: fixture.evidence,
			continuation,
			reason,
		},
		taskArtifactOwnerRetirementContinuation: continuation,
	};
}

function substitutedReceiptRecord(
	fixture: Fixture,
	evidence: TaskArtifactOwnerDeletionEvidence,
	state: "artifacts_removed" | "owner_pending",
): Record<string, unknown> {
	const common = {
		schemaVersion: 1,
		state,
		scope: computeManagedScopeDigest(fixture.scope.platform, fixture.scope.canonicalCwd),
		transcriptPath: fixture.target.transcriptPath,
		sessionId: fixture.target.sessionId,
		cwd: fixture.target.cwd,
		transcriptIdentity: managedGcRetirementIdentityRecord(fixture.target.transcriptIdentity),
		taskArtifactOwnerDeletionEvidence: evidence,
	};
	if (state === "artifacts_removed") return { ...common, artifactsRemoved: true };
	const continuation: TaskArtifactOwnerRetirementContinuation = {
		schemaVersion: 1,
		parentIdentity: evidence.parentIdentity,
		retainedRootPath: ownerAbsolutePath(
			taskArtifactOwnerStorageContextForScope(fixture.scope),
			fixture.target.taskArtifactOwnerLocator.ownerId,
		),
		retainedTreeSnapshot: evidence.treeSnapshot,
	};
	return {
		...common,
		artifactsRemoved: true,
		ownerRetirementAttempt: 1,
		taskArtifactOwnerRetirementOutcome: {
			kind: "uncertain",
			evidence,
			continuation,
			reason: "substituted_history_fixture",
		},
		taskArtifactOwnerRetirementContinuation: continuation,
	};
}

function readReceiptSuffix(fixture: Fixture, suffix: string): unknown {
	const scope = fixture.scope;
	const store = openScopeStore(scope);
	try {
		const key = crypto.createHash("sha256").update(path.resolve(fixture.transcriptPath), "utf8").digest("hex");
		const relative = `.gjc-managed-session-internal/receipts/gc-retirement-${key}-${suffix}.json`;
		const snapshot = store.readExpected(relative);
		if (!snapshot) throw new Error("fixture_receipt_missing");
		return JSON.parse(snapshot.bytes.toString("utf8")) as unknown;
	} finally {
		store.close();
	}
}

function snapshotTree(root: string): unknown[] {
	const entries: unknown[] = [];
	const visit = (pathname: string, relative: string): void => {
		const stat = fs.lstatSync(pathname, { bigint: true });
		entries.push({
			relative,
			dev: stat.dev.toString(),
			ino: stat.ino.toString(),
			mode: stat.mode.toString(),
			ctimeNs: stat.ctimeNs.toString(),
			kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
		});
		if (stat.isDirectory() && !stat.isSymbolicLink()) {
			for (const name of fs.readdirSync(pathname).sort()) {
				visit(path.join(pathname, name), path.join(relative, name));
			}
		} else if (stat.isFile()) {
			entries.push({ relative: `${relative}:bytes`, bytes: fs.readFileSync(pathname).toString("base64") });
		}
	};
	visit(root, ".");
	return entries;
}

describe("managed GC retirement journal", () => {
	it("persists actual native disposition and replays pending namespaces after transcript absence", async () => {
		const fixture = makeFixture();
		const prepared = await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		expect(prepared.state).toBe("prepared");
		expect((await readManagedGcSessionRetirementReceipt(fixture.scope, fixture.transcriptPath))?.state).toBe(
			"prepared",
		);

		const artifactsRemoved: ManagedGcSessionRetirementReceipt = {
			...preparedReceipt(fixture),
			state: "artifacts_removed",
			artifactsRemoved: true,
		};
		expect((await publishManagedGcSessionRetirementReceipt(fixture.scope, artifactsRemoved)).state).toBe(
			"artifacts_removed",
		);
		expect((await readManagedGcSessionRetirementReceipt(fixture.scope, fixture.transcriptPath))?.state).toBe(
			"artifacts_removed",
		);

		const pending = pendingReceipt(fixture, "test_retry_required");
		expect((await publishManagedGcSessionRetirementReceipt(fixture.scope, pending)).state).toBe("owner_pending");
		expect((await readManagedGcSessionRetirementReceipt(fixture.scope, fixture.transcriptPath))?.state).toBe(
			"owner_pending",
		);

		const outcome = retireTaskArtifactOwner(
			taskArtifactOwnerStorageContextForScope(fixture.scope),
			fixture.evidence,
			uncertainContinuation(fixture),
		);
		const disposition: ManagedGcSessionRetirementReceipt =
			outcome.kind === "completed"
				? {
						...fixture.target,
						state: "owner_retired",
						taskArtifactOwnerDeletionEvidence: fixture.evidence,
						artifactsRemoved: true,
						taskArtifactOwnerRetirementOutcome: outcome,
						taskArtifactOwnerRetired: true,
					}
				: {
						...fixture.target,
						state: "owner_pending",
						taskArtifactOwnerDeletionEvidence: fixture.evidence,
						artifactsRemoved: true,
						taskArtifactOwnerRetirementOutcome: outcome,
						taskArtifactOwnerRetirementContinuation: outcome.continuation,
						...(outcome.kind === "payload_retired"
							? {
									taskArtifactOwnerPayloadRetired: true as const,
									taskArtifactOwnerNamespaceRetained: true as const,
								}
							: {}),
					};
		const published = await publishManagedGcSessionRetirementReceipt(fixture.scope, disposition);
		expect(published.state).toBe(outcome.kind === "completed" ? "owner_retired" : "owner_pending");
		if (outcome.kind === "payload_retired") {
			expect(outcome.nativeOutcome.payloadDurable).toBe(true);
			expect(outcome.nativeOutcome.ok).toBe(false);
			expect(outcome.nativeOutcome.code).toBe("cleanup_pending");
			expect(published.taskArtifactOwnerRetired).toBeUndefined();
			await expect(
				publishManagedGcSessionRetirementReceipt(fixture.scope, {
					...disposition,
					state: "owner_retired",
					taskArtifactOwnerRetired: true,
				}),
			).rejects.toThrow();
		}
		expect(
			(await readManagedGcSessionRetirementReceipt(fixture.scope, fixture.transcriptPath))
				?.taskArtifactOwnerRetirementOutcome,
		).toEqual(outcome);

		const store = openScopeStore(fixture.scope);
		try {
			store.removeIfExistsDescriptor("fixture.jsonl");
		} finally {
			store.close();
		}
		const reopenedScope = makeScope(fixture.agentDir, fixture.sessionsRoot, fixture.cwd);
		const replayed = await readManagedGcSessionRetirementReceipt(reopenedScope, fixture.transcriptPath);
		expect(replayed?.state).toBe(disposition.state);
		expect(replayed?.taskArtifactOwnerRetirementOutcome).toEqual(outcome);
		expect(replayed?.taskArtifactOwnerRetired).toBe(outcome.kind === "completed" ? true : undefined);
	});

	it("rejects substituted later evidence and changed transcript identity", async () => {
		const fixture = makeFixture();
		await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		const substitutedEvidence = immutableDeletionEvidence(
			fixture.evidence.sessionId,
			fixture.evidence.locator,
			{ ...fixture.evidence.parentIdentity, ino: String(BigInt(fixture.evidence.parentIdentity.ino) + 1n) },
			fixture.evidence.treeSnapshot,
		);
		await expect(
			publishManagedGcSessionRetirementReceipt(fixture.scope, {
				...fixture.target,
				state: "artifacts_removed",
				artifactsRemoved: true,
				taskArtifactOwnerDeletionEvidence: substitutedEvidence,
			}),
		).rejects.toThrow();

		const store = openScopeStore(fixture.scope);
		try {
			const key = crypto.createHash("sha256").update(path.resolve(fixture.transcriptPath), "utf8").digest("hex");
			store.publishNoReplaceSync(
				`.gjc-managed-session-internal/receipts/gc-retirement-${key}-artifacts_removed.json`,
				Buffer.from(
					`${JSON.stringify(substitutedReceiptRecord(fixture, substitutedEvidence, "artifacts_removed"))}\n`,
				),
			);
			store.publishNoReplaceSync(
				`.gjc-managed-session-internal/receipts/gc-retirement-${key}-owner_pending-00000001.json`,
				Buffer.from(`${JSON.stringify(substitutedReceiptRecord(fixture, substitutedEvidence, "owner_pending"))}\n`),
			);
		} finally {
			store.close();
		}
		await expect(readManagedGcSessionRetirementReceipt(fixture.scope, fixture.transcriptPath)).rejects.toThrow();
		await expect(
			readManagedGcSessionRetirementReceiptReadOnly(fixture.scope, fixture.transcriptPath),
		).rejects.toThrow();

		const replacedTranscript = makeFixture();
		await publishManagedGcSessionRetirementReceipt(replacedTranscript.scope, preparedReceipt(replacedTranscript));
		const replacementStore = openScopeStore(replacedTranscript.scope);
		try {
			const old = replacementStore.readExpected("fixture.jsonl");
			if (!old) throw new Error("fixture_transcript_missing");
			replacementStore.replaceExpected(
				"fixture.jsonl",
				Buffer.concat([old.bytes, Buffer.from('{"extra":true}\n')]),
				old,
			);
		} finally {
			replacementStore.close();
		}
		await expect(
			readManagedGcSessionRetirementReceipt(replacedTranscript.scope, replacedTranscript.transcriptPath),
		).rejects.toThrow();
		await expect(
			readManagedGcSessionRetirementReceiptReadOnly(replacedTranscript.scope, replacedTranscript.transcriptPath),
		).rejects.toThrow();
	});

	it("rejects wrong profile/root scope and transcripts outside the trusted scope parent", () => {
		const fixture = makeFixture();
		const originalAgentDir = fixture.scope.agentDir;
		fixture.scope.agentDir = path.join(fixture.temporaryRoot, "other-profile");
		expect(() => taskArtifactOwnerStorageContextForScope(fixture.scope)).toThrow();
		fixture.scope.agentDir = originalAgentDir;
		const originalSessionsRoot = fixture.scope.sessionsRoot;
		fixture.scope.sessionsRoot = path.join(fixture.temporaryRoot, "other-sessions");
		expect(() => taskArtifactOwnerStorageContextForScope(fixture.scope)).toThrow();
		fixture.scope.sessionsRoot = originalSessionsRoot;
		expect(() =>
			bindManagedGcSessionRetirementTarget(fixture.scope, path.join(fixture.temporaryRoot, "outside.jsonl")),
		).toThrow();
	});

	it("resolves and reads owner journals without changing managed bytes, modes, ctimes, or private directories", async () => {
		const fixture = makeFixture();
		await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		const before = snapshotTree(fixture.temporaryRoot);
		const resolved = resolveManagedGcScopeForRead({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			sessionsRoot: fixture.sessionsRoot,
		});
		expect(resolved.kind).toBe("resolved");
		if (resolved.kind !== "resolved") throw new Error(`readonly_scope_resolution_failed:${resolved.code}`);
		expect((await readManagedGcSessionRetirementReceiptReadOnly(resolved.scope, fixture.transcriptPath))?.state).toBe(
			"prepared",
		);
		const discovered = await discoverManagedGcSessionRetirementReceipts({
			agentDir: fixture.agentDir,
			sessionsRoot: fixture.sessionsRoot,
		});
		expect(discovered.map(item => item.receipt.transcriptPath)).toContain(fixture.transcriptPath);
		expect(snapshotTree(fixture.temporaryRoot)).toEqual(before);
	});

	it("discovers original prepared authority in a fresh process after transcript absence", async () => {
		const fixture = makeFixture();
		await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		const store = openScopeStore(fixture.scope);
		try {
			store.removeIfExistsDescriptor(path.basename(fixture.transcriptPath));
		} finally {
			store.close();
		}
		const moduleUrl = new URL("../src/session/internal/managed-session-scope.ts", import.meta.url).href;
		const script =
			`import { discoverManagedGcSessionRetirementReceipts } from ${JSON.stringify(moduleUrl)};
` +
			`  const records = await discoverManagedGcSessionRetirementReceipts({
` +
			`    agentDir: ${JSON.stringify(fixture.agentDir)},
` +
			`    sessionsRoot: ${JSON.stringify(fixture.sessionsRoot)},
` +
			`  });
` +
			`  process.stdout.write(JSON.stringify(records.map(({ receipt }) => ({
` +
			`    transcriptPath: receipt.transcriptPath, state: receipt.state,
` +
			`  }))));
`;
		const child = Bun.spawnSync({
			cmd: [process.execPath, "-e", script],
			cwd: fixture.temporaryRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(child.exitCode).toBe(0);
		expect(JSON.parse(Buffer.from(child.stdout).toString("utf8"))).toContainEqual({
			transcriptPath: fixture.transcriptPath,
			state: "prepared",
		});
		expect(fs.existsSync(fixture.transcriptPath)).toBe(false);
	});

	it("rejects forged prepared target identity and transcript-key substitution", async () => {
		const fixture = makeFixture();
		const key = crypto.createHash("sha256").update(path.resolve(fixture.transcriptPath), "utf8").digest("hex");
		const forged = {
			schemaVersion: 1,
			state: "prepared",
			scope: computeManagedScopeDigest(fixture.scope.platform, fixture.scope.canonicalCwd),
			transcriptPath: fixture.transcriptPath,
			sessionId: fixture.target.sessionId,
			cwd: fixture.cwd,
			taskArtifactOwnerLocator: fixture.target.taskArtifactOwnerLocator,
			transcriptIdentity: {
				...managedGcRetirementIdentityRecord(fixture.target.transcriptIdentity),
				ino: (fixture.target.transcriptIdentity.ino + 1n).toString(),
			},
			taskArtifactOwnerDeletionEvidence: fixture.evidence,
		};
		const substitutedPath = path.join(fixture.scope.directoryPath, "substituted.jsonl");
		const substitutedKey = crypto.createHash("sha256").update(path.resolve(substitutedPath), "utf8").digest("hex");
		const store = openScopeStore(fixture.scope);
		try {
			for (const receiptKey of [key, substitutedKey]) {
				store.publishNoReplaceSync(
					`.gjc-managed-session-internal/receipts/gc-retirement-${receiptKey}-prepared.json`,
					Buffer.from(`${JSON.stringify(forged)}\n`, "utf8"),
				);
			}
		} finally {
			store.close();
		}
		await expect(
			readManagedGcSessionRetirementReceiptReadOnly(fixture.scope, fixture.transcriptPath),
		).rejects.toThrow();
		await expect(readManagedGcSessionRetirementReceiptReadOnly(fixture.scope, substitutedPath)).rejects.toThrow();
		expect(fs.existsSync(fixture.transcriptPath)).toBe(true);
		expect(
			fs.readFileSync(
				path.join(
					ownerAbsolutePath(
						taskArtifactOwnerStorageContextForScope(fixture.scope),
						fixture.target.taskArtifactOwnerLocator.ownerId,
					),
					"payload.json",
				),
				"utf8",
			),
		).toBe("fixture payload");
	});

	it("rejects a numbered-attempt gap and later states without prepared authority", async () => {
		const fixture = makeFixture();
		await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		await publishManagedGcSessionRetirementReceipt(fixture.scope, {
			...preparedReceipt(fixture),
			state: "artifacts_removed",
			artifactsRemoved: true,
		});
		await publishManagedGcSessionRetirementReceipt(fixture.scope, pendingReceipt(fixture, "first_attempt"));
		await publishManagedGcSessionRetirementReceipt(fixture.scope, pendingReceipt(fixture, "second_attempt"));
		const store = openScopeStore(fixture.scope);
		try {
			const key = crypto.createHash("sha256").update(path.resolve(fixture.transcriptPath), "utf8").digest("hex");
			store.removeIfExistsDescriptor(
				`.gjc-managed-session-internal/receipts/gc-retirement-${key}-owner_pending-00000001.json`,
			);
		} finally {
			store.close();
		}
		await expect(readManagedGcSessionRetirementReceipt(fixture.scope, fixture.transcriptPath)).rejects.toThrow();

		const noPrepared = makeFixture();
		const malformedJournal = openScopeStore(noPrepared.scope);
		try {
			const key = crypto.createHash("sha256").update(path.resolve(noPrepared.transcriptPath), "utf8").digest("hex");
			malformedJournal.publishNoReplaceSync(
				`.gjc-managed-session-internal/receipts/gc-retirement-${key}-artifacts_removed.json`,
				Buffer.from("{}\n", "utf8"),
			);
		} finally {
			malformedJournal.close();
		}
		await expect(
			readManagedGcSessionRetirementReceipt(noPrepared.scope, noPrepared.transcriptPath),
		).rejects.toThrow();
	});

	it("discovers prepared authority after transcript absence instead of rebinding from a later receipt", async () => {
		const fixture = makeFixture();
		await publishManagedGcSessionRetirementReceipt(fixture.scope, preparedReceipt(fixture));
		const store = openScopeStore(fixture.scope);
		try {
			store.removeIfExistsDescriptor("fixture.jsonl");
		} finally {
			store.close();
		}
		const reopenedScope = makeScope(fixture.agentDir, fixture.sessionsRoot, fixture.cwd);
		const recovered = await readManagedGcSessionRetirementReceipt(reopenedScope, fixture.transcriptPath);
		expect(recovered?.state).toBe("prepared");
		expect(recovered?.sessionId).toBe(fixture.target.sessionId);
		const laterReceipt = readReceiptSuffix(fixture, "prepared");
		expect((laterReceipt as Record<string, unknown>).state).toBe("prepared");
	});
});
