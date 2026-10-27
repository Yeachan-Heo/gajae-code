import { afterEach, describe, expect, it, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { NativeExactUnlinkResult } from "@gajae-code/natives";
import * as native from "@gajae-code/natives";
import { collectGcDiskReport, resolveGcDiskPolicy } from "../src/gjc-runtime/gc-runtime";
import { Broker } from "../src/sdk/broker/broker";
import {
	bindManagedGcSessionRetirementTarget,
	discoverManagedGcSessionRetirementReceipts,
	MANAGED_SESSION_BINDING_FILE,
	type ManagedScope,
	managedGcProtocolScopeInspectorForScope,
	prepareManagedSessionScopeForWriteSync,
	publishManagedGcSessionRetirementReceipt,
	readManagedGcSessionRetirementReceipt,
	resolveManagedScopeForWrite,
	taskArtifactOwnerStorageContextForScope,
} from "../src/session/internal/managed-session-scope";
import { ManagedSessionDescendantStore } from "../src/session/internal/managed-session-storage";
import {
	captureTaskArtifactOwnerDeletionEvidence,
	newSessionRootStore,
} from "../src/session/internal/task-artifact-owner-access";
import { hasSiblingTaskArtifactOwnerTranscript } from "../src/session/internal/task-artifact-owner-transcript";
import { FileSessionStorage } from "../src/session/session-storage";
import {
	OWNER_DIRECTORY,
	OWNER_MANIFEST,
	OWNER_SCHEMA_VERSION,
	ownerIdForSession,
	ownerRelativePath,
	type TaskArtifactOwnerDeletionEvidence,
	type TaskArtifactOwnerLocator,
	type TaskArtifactOwnerRetirementOutcome,
} from "../src/session/task-artifact-owner-codec";
import { verifyTaskArtifactOwnerRetirementContinuation } from "../src/session/task-artifact-owner-retirement";

interface Fixture {
	root: string;
	agentDir: string;
	sessionsRoot: string;
	cwd: string;
	scope: ManagedScope;
	sessionId: string;
	transcriptPath: string;
	ownerPath: string;
	locator: TaskArtifactOwnerLocator;
}

const roots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function managedScope(agentDir: string, sessionsRoot: string, cwd: string): ManagedScope {
	const resolved = resolveManagedScopeForWrite({ agentDir, sessionsRoot, cwd });
	if (resolved.kind !== "resolved") throw new Error(`fixture_scope_resolution_failed:${resolved.code}`);
	const prepared = prepareManagedSessionScopeForWriteSync(resolved.scope);
	if (prepared.kind !== "resolved") throw new Error(`fixture_scope_prepare_failed:${prepared.code}`);
	return prepared.scope;
}

function writeSession(scope: ManagedScope, id: string, cwd: string, locator?: TaskArtifactOwnerLocator): string {
	const transcriptPath = path.join(scope.directoryPath, `${id}.jsonl`);
	const header = { type: "session", id, cwd, version: 3, ...(locator ? { taskArtifactOwner: locator } : {}) };
	fs.writeFileSync(transcriptPath, `${JSON.stringify(header)}\n`, { mode: 0o600 });
	return transcriptPath;
}

function makeHistoricalExternalScope() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gc-external-historical-scope-")));
	roots.push(root);
	const agentDir = path.join(root, "profile");
	const configuredRoot = path.join(root, "external");
	const sessionsRoot = path.join(configuredRoot, "sessions");
	const cwd = path.join(root, "workspace");
	for (const directory of [agentDir, configuredRoot, cwd]) fs.mkdirSync(directory, { mode: 0o700 });
	const scope = managedScope(agentDir, sessionsRoot, cwd);
	writeSession(scope, crypto.randomUUID(), cwd);
	fs.rmSync(cwd, { recursive: true });
	return { root, agentDir, configuredRoot, sessionsRoot };
}

function makeFixture(): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-task-owner-retirement-"));
	roots.push(root);
	const agentDir = path.join(root, "profile");
	const sessionsRoot = path.join(agentDir, "sessions");
	const cwd = path.join(root, "workspace");
	fs.mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 });
	fs.mkdirSync(cwd, { mode: 0o700 });
	const scope = managedScope(agentDir, sessionsRoot, cwd);
	const context = taskArtifactOwnerStorageContextForScope(scope);
	const sessionId = `gc-owner-${crypto.randomUUID()}`;
	const ownerId = ownerIdForSession(sessionId);
	const rootStore = newSessionRootStore(context);
	let locator: TaskArtifactOwnerLocator | undefined;
	try {
		rootStore.verifyRootSecurity();
		rootStore.ensureDirectory(OWNER_DIRECTORY);
		const ownerDirectory = rootStore.ensureDirectory(ownerRelativePath(ownerId));
		locator = {
			schemaVersion: OWNER_SCHEMA_VERSION,
			ownerId,
			directoryDev: ownerDirectory.dev.toString(),
			directoryIno: ownerDirectory.ino.toString(),
		};
		const ownerStore = rootStore.deriveSubtree(ownerRelativePath(ownerId));
		try {
			ownerStore.publishNoReplaceSync(
				OWNER_MANIFEST,
				Buffer.from(JSON.stringify({ ...locator, sessionId }), "utf8"),
			);
			ownerStore.publishNoReplaceSync("payload.bin", Buffer.from("owner payload", "utf8"));
		} finally {
			ownerStore.close();
		}
	} finally {
		rootStore.close();
	}
	if (!locator) throw new Error("fixture_owner_locator_missing");
	const transcriptPath = writeSession(scope, sessionId, cwd, locator);
	return {
		root,
		agentDir,
		sessionsRoot,
		cwd,
		scope,
		sessionId,
		transcriptPath,
		ownerPath: path.join(sessionsRoot, OWNER_DIRECTORY, ownerId),
		locator,
	};
}

function gcEnv(fixture: Fixture): NodeJS.ProcessEnv {
	return {
		...process.env,
		GJC_CODING_AGENT_DIR: fixture.agentDir,
		GJC_HARNESS_ROOT_REGISTRY_DIR: path.join(fixture.root, "registry"),
		TMPDIR: path.join(fixture.root, "tmp"),
	};
}

async function backdate(pathname: string, days: number): Promise<void> {
	const old = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
	await fs.promises.utimes(pathname, old, old);
}

function snapshotTree(root: string): string[] {
	const rootStat = fs.lstatSync(root, { bigint: true });
	const result: string[] = [
		`.:${rootStat.dev}:${rootStat.ino}:${rootStat.mode}:${rootStat.size}:${rootStat.mtimeNs}:${rootStat.ctimeNs}`,
	];
	const walk = (directory: string, relative = "") => {
		for (const name of fs.readdirSync(directory).sort()) {
			const pathname = path.join(directory, name);
			const entryRelative = relative ? `${relative}/${name}` : name;
			const stat = fs.lstatSync(pathname, { bigint: true });
			result.push(
				`${entryRelative}:${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
			);
			if (stat.isDirectory() && !stat.isSymbolicLink()) walk(pathname, entryRelative);
		}
	};
	walk(root);
	return result;
}

async function runGc(fixture: Fixture, prune: boolean) {
	return collectGcDiskReport({
		agentDir: fixture.agentDir,
		env: gcEnv(fixture),
		policy: resolveGcDiskPolicy({
			sessions_max_age_days: 30,
			sessions_max_total_bytes: 0,
			natives_keep_versions: 100,
			backups_max_age_days: 3650,
		}),
		prune,
		now: Date.now(),
	});
}

function journalRecords(scopeDirectory: string): Array<{ path: string; record: Record<string, unknown> }> {
	const records: Array<{ path: string; record: Record<string, unknown> }> = [];
	const walk = (directory: string) => {
		for (const name of fs.readdirSync(directory)) {
			const pathname = path.join(directory, name);
			const stat = fs.lstatSync(pathname);
			if (stat.isDirectory() && !stat.isSymbolicLink()) {
				walk(pathname);
				continue;
			}
			if (!stat.isFile() || !name.startsWith("gc-retirement-") || !name.endsWith(".json")) continue;
			records.push({
				path: pathname,
				record: JSON.parse(fs.readFileSync(pathname, "utf8")) as Record<string, unknown>,
			});
		}
	};
	walk(scopeDirectory);
	return records;
}

async function publishPrepared(fixture: Fixture) {
	const target = bindManagedGcSessionRetirementTarget(fixture.scope, fixture.transcriptPath);
	const context = taskArtifactOwnerStorageContextForScope(fixture.scope);
	const evidence = captureTaskArtifactOwnerDeletionEvidence(
		context,
		fixture.sessionId,
		target.taskArtifactOwnerLocator,
	);
	if (!evidence) throw new Error("fixture_owner_evidence_missing");
	const receipt = await publishManagedGcSessionRetirementReceipt(fixture.scope, {
		...target,
		state: "prepared",
		taskArtifactOwnerDeletionEvidence: evidence,
	});
	return { target, context, evidence, receipt };
}

async function publishArtifactsRemoved(fixture: Fixture) {
	const prepared = await publishPrepared(fixture);
	const directory = path.dirname(fixture.transcriptPath);
	const artifactPhase = await new FileSessionStorage().deleteSessionVerified(
		{
			sessionsRoot: fixture.sessionsRoot,
			transcriptPath: fixture.transcriptPath,
			sessionId: fixture.sessionId,
			cwd: fixture.cwd,
			transcriptIdentity: prepared.target.transcriptIdentity,
			plannedArtifactsPath: path.join(directory, `.gjc-delete-gc-${crypto.randomUUID()}-artifacts`),
			plannedTranscriptPath: path.join(directory, `.gjc-delete-gc-${crypto.randomUUID()}-transcript`),
			taskArtifactOwnerStorageContext: prepared.context,
			taskArtifactOwnerDeletionEvidence: prepared.evidence,
			deferTaskArtifactOwnerRetirement: true,
		},
		managedGcProtocolScopeInspectorForScope(fixture.scope),
	);
	if (artifactPhase.kind !== "artifacts_removed")
		throw new Error(`fixture_artifact_phase_failed:${artifactPhase.kind}`);
	const receipt = await publishManagedGcSessionRetirementReceipt(fixture.scope, {
		...prepared.target,
		state: "artifacts_removed",
		taskArtifactOwnerDeletionEvidence: prepared.evidence,
		artifactsRemoved: true,
	});
	return { ...prepared, receipt };
}

describe("owner-aware disk session retirement", () => {
	it.each([
		"live",
		"removed",
		"shared",
		"removed-shared",
	] as const)("authenticates unrelated historical sibling storage without borrowing workspace authority (%s)", async mode => {
		const fixture = makeFixture();
		const otherCwd = path.join(fixture.root, "other-workspace");
		fs.mkdirSync(otherCwd, { mode: 0o700 });
		const other = managedScope(fixture.agentDir, fixture.sessionsRoot, otherCwd);
		const shared = mode === "shared" || mode === "removed-shared";
		writeSession(
			other,
			shared ? fixture.sessionId : crypto.randomUUID(),
			otherCwd,
			shared ? fixture.locator : undefined,
		);
		const bindingPath = path.join(other.directoryPath, MANAGED_SESSION_BINDING_FILE);
		const binding = fs.readFileSync(bindingPath);
		if (mode === "removed" || mode === "removed-shared") fs.rmSync(otherCwd, { recursive: true });
		const owner = snapshotTree(fixture.ownerPath);
		expect(
			await hasSiblingTaskArtifactOwnerTranscript(
				new FileSessionStorage(),
				fixture.transcriptPath,
				fixture.locator,
				taskArtifactOwnerStorageContextForScope(fixture.scope),
				managedGcProtocolScopeInspectorForScope(fixture.scope),
			),
		).toBe(shared);
		expect(fs.readFileSync(bindingPath)).toEqual(binding);
		expect(snapshotTree(fixture.ownerPath)).toEqual(owner);
	});
	it.each([
		"same-owner-sibling",
		"reserved-protocol-alias",
	] as const)("reports a real pre-effect storage refusal as kept with its journal still prepared (%s)", async obstruction => {
		const fixture = makeFixture();
		await backdate(fixture.transcriptPath, 90);
		writeSession(fixture.scope, "newest-session", fixture.cwd);
		const transcript = fs.readFileSync(fixture.transcriptPath);
		const owner = snapshotTree(fixture.ownerPath);
		let injected = false;
		let obstructionPath: string | undefined;
		const originalDelete = FileSessionStorage.prototype.deleteSessionVerified;
		const fault = vi.spyOn(FileSessionStorage.prototype, "deleteSessionVerified").mockImplementation(async function (
			this: FileSessionStorage,
			target,
			inspector,
		) {
			if (target.transcriptPath === fixture.transcriptPath && !injected) {
				injected = true;
				expect((await readManagedGcSessionRetirementReceipt(fixture.scope, fixture.transcriptPath))?.state).toBe(
					"prepared",
				);
				if (obstruction === "same-owner-sibling") {
					obstructionPath = writeSession(fixture.scope, crypto.randomUUID(), fixture.cwd, fixture.locator);
				} else {
					obstructionPath = path.join(fixture.scope.directoryPath, ".gjc-managed-session-internal.saved");
					fs.mkdirSync(obstructionPath, { mode: 0o700 });
				}
			}
			const result = await originalDelete.call(this, target, inspector);
			if (target.transcriptPath === fixture.transcriptPath)
				expect(result).toMatchObject({
					kind: "cleanup_pending",
					phase: "task_artifact_owner",
					artifactsRemoved: false,
				});
			return result;
		});
		const report = await runGc(fixture, true);
		fault.mockRestore();
		expect(injected).toBe(true);
		expect(report.surfaces.sessions.records.find(record => record.path === fixture.transcriptPath)).toMatchObject({
			action: "keep",
			reason: expect.stringContaining("retention_declined"),
		});
		expect(report.totals.failed).toBe(0);
		expect(fs.readFileSync(fixture.transcriptPath)).toEqual(transcript);
		expect(snapshotTree(fixture.ownerPath)).toEqual(owner);
		const receipt = await readManagedGcSessionRetirementReceipt(fixture.scope, fixture.transcriptPath);
		expect(receipt?.state).toBe("prepared");
		expect(receipt?.artifactsRemoved).toBeUndefined();
		if (!obstructionPath) throw new Error("fixture_obstruction_missing");
		fs.rmSync(obstructionPath, { recursive: true });
		const retry = await runGc(fixture, true);
		expect(
			retry.surfaces.sessions.records.find(record => record.path === fixture.transcriptPath)?.reason,
		).not.toContain("task_artifact_owner_shared_with_sibling_transcript");
	});
	it("preserves partial failure after real native scrub when outcome publication fails", async () => {
		const fixture = makeFixture();
		await backdate(fixture.transcriptPath, 90);
		writeSession(fixture.scope, "newest-session", fixture.cwd);
		const transcript = fs.readFileSync(fixture.transcriptPath);
		const payload = fs.readFileSync(path.join(fixture.ownerPath, "payload.bin"));
		const originalRemove = native.exactRemoveDirectoryTree;
		const results: NativeExactUnlinkResult[] = [];
		vi.spyOn(native, "exactRemoveDirectoryTree").mockImplementation((pathname, tree, options) => {
			const result = originalRemove(pathname, tree, options);
			if (pathname === fixture.ownerPath || pathname === `${fixture.ownerPath}.removing`) results.push(result);
			return result;
		});
		const originalPublish = ManagedSessionDescendantStore.prototype.publishNoReplaceSync;
		const digest = crypto.createHash("sha256").update(path.resolve(fixture.transcriptPath)).digest("hex");
		const pending = `.gjc-managed-session-internal/receipts/gc-retirement-${digest}-owner_pending-00000001.json`;
		const retired = `.gjc-managed-session-internal/receipts/gc-retirement-${digest}-owner_retired.json`;
		let blocked = false;
		const fault = vi
			.spyOn(ManagedSessionDescendantStore.prototype, "publishNoReplaceSync")
			.mockImplementation(function (this: ManagedSessionDescendantStore, relative, bytes) {
				if (!blocked && (relative === pending || relative === retired)) {
					blocked = true;
					throw Object.assign(new Error("Injected owner outcome publication failure"), { code: "EIO" });
				}
				return originalPublish.call(this, relative, bytes);
			});
		const first = await runGc(fixture, true);
		fault.mockRestore();
		expect(blocked).toBe(true);
		expect(results.length).toBeGreaterThan(0);
		expect(first.surfaces.sessions.records.find(record => record.path === fixture.transcriptPath)?.action).toBe(
			"reclaim_failed",
		);
		const receipt = await readManagedGcSessionRetirementReceipt(fixture.scope, fixture.transcriptPath);
		expect(receipt?.state).toBe("artifacts_removed");
		const payloadPaths = [
			path.join(fixture.ownerPath, "payload.bin"),
			path.join(`${fixture.ownerPath}.removing`, "payload.bin"),
		];
		expect(payloadPaths.some(pathname => fs.existsSync(pathname) && fs.readFileSync(pathname).equals(payload))).toBe(
			false,
		);
		const nativeCalls = results.length;
		for (const prune of [false, true]) {
			const before = snapshotTree(fixture.root);
			const replay = await runGc(fixture, prune);
			expect(replay.surfaces.sessions.records.find(record => record.path === fixture.transcriptPath)).toMatchObject({
				action: "reclaim_failed",
				phase: "artifacts",
				reason: expect.stringContaining("task_artifact_owner_continuation_invalid"),
			});
			expect(replay.totals.failed).toBeGreaterThan(0);
			expect(fs.readFileSync(fixture.transcriptPath)).toEqual(transcript);
			if (!prune) expect(snapshotTree(fixture.root)).toEqual(before);
			expect(await readManagedGcSessionRetirementReceipt(fixture.scope, fixture.transcriptPath)).toEqual(receipt);
			expect(results.length).toBe(nativeCalls);
		}
	});
	it.each([
		false,
		true,
	])("keeps owner-free GC usable after its historical workspace is removed (prune=%s)", async prune => {
		const fixture = makeFixture();
		writeSession(fixture.scope, fixture.sessionId, fixture.cwd);
		await fs.promises.rm(fixture.ownerPath, { recursive: true });
		await backdate(fixture.transcriptPath, 90);
		writeSession(fixture.scope, "newest-session", fixture.cwd);
		await fs.promises.rm(fixture.cwd, { recursive: true });
		const report = await runGc(fixture, prune);
		expect(report.errors).toEqual([]);
		const oldSession = report.surfaces.sessions.records.find(record => record.path === fixture.transcriptPath);
		expect(oldSession?.action).toBe(prune ? "reclaimed" : "would_reclaim");
		expect(fs.existsSync(fixture.transcriptPath)).toBe(!prune);
		expect(fs.existsSync(path.join(fixture.scope.directoryPath, "newest-session.jsonl"))).toBe(true);
	});
	it.each([
		"binding-bytes",
		"binding-digest",
		"protocol-symlink",
		"journal",
	] as const)("refuses unauthenticated or journal-bearing historical scopes after workspace deletion (%s)", async obstruction => {
		const fixture = makeFixture();
		const bindingPath = path.join(fixture.scope.directoryPath, MANAGED_SESSION_BINDING_FILE);
		if (obstruction === "binding-bytes") {
			const bytes = await Bun.file(bindingPath).text();
			await Bun.write(bindingPath, bytes.trim());
		} else if (obstruction === "binding-digest") {
			const binding = await Bun.file(bindingPath).json();
			await Bun.write(bindingPath, `${JSON.stringify({ ...binding, identityDigest: "a".repeat(52) })}\n`);
		} else if (obstruction === "protocol-symlink") {
			const protocol = path.join(fixture.scope.directoryPath, ".gjc-managed-session-internal");
			await fs.promises.rm(protocol, { recursive: true, force: true });
			const foreign = path.join(fixture.root, "foreign-protocol");
			await fs.promises.mkdir(foreign, { mode: 0o700 });
			await fs.promises.symlink(foreign, protocol, process.platform === "win32" ? "junction" : "dir");
		} else {
			await publishPrepared(fixture);
		}
		await fs.promises.rm(fixture.cwd, { recursive: true });
		const before = snapshotTree(fixture.scope.directoryPath);
		const report = await runGc(fixture, false);
		expect(JSON.stringify(report.errors)).toContain(
			obstruction === "protocol-symlink"
				? "Managed descendant path escapes retained store"
				: "managed_gc_scope_authority_mismatch",
		);
		expect(snapshotTree(fixture.scope.directoryPath)).toEqual(before);
	});

	it("authenticates an external configured root for empty historical journal discovery without mutation", async () => {
		const fixture = makeHistoricalExternalScope();
		const before = snapshotTree(fixture.configuredRoot);
		expect(await discoverManagedGcSessionRetirementReceipts(fixture)).toEqual([]);
		expect(snapshotTree(fixture.configuredRoot)).toEqual(before);
	});

	it.skipIf(process.platform === "win32")(
		"rejects insecure POSIX configured-root permissions without repair",
		async () => {
			const fixture = makeHistoricalExternalScope();
			fs.chmodSync(fixture.configuredRoot, 0o777);
			const before = snapshotTree(fixture.configuredRoot);
			await expect(discoverManagedGcSessionRetirementReceipts(fixture)).rejects.toThrow(
				"managed_gc_scope_authority_mismatch",
			);
			expect(snapshotTree(fixture.configuredRoot)).toEqual(before);
		},
	);

	it("rejects configured-parent replacement even when the original sessions subtree is preserved", async () => {
		const fixture = makeHistoricalExternalScope();
		const originalParent = fs.lstatSync(fixture.configuredRoot, { bigint: true });
		const originalSessions = fs.lstatSync(fixture.sessionsRoot, { bigint: true });
		let checks = 0;
		let retainedSnapshot: string[] | undefined;
		const replaceAfterVerification = (pathname: string): void => {
			if (pathname !== fixture.configuredRoot || ++checks !== 2) return;
			const retained = `${fixture.configuredRoot}.original`;
			fs.renameSync(fixture.configuredRoot, retained);
			fs.mkdirSync(fixture.configuredRoot, { mode: 0o700 });
			fs.renameSync(path.join(retained, "sessions"), fixture.sessionsRoot);
			retainedSnapshot = snapshotTree(fixture.sessionsRoot);
		};
		const originalVerify = native.verifyOwnerOnlyPathSecurity;
		vi.spyOn(native, "verifyOwnerOnlyPathSecurity").mockImplementation((pathname, kind) => {
			const result = originalVerify(pathname, kind);
			replaceAfterVerification(pathname);
			return result;
		});
		const originalExpected = native.verifyOwnerOnlyPathSecurityExpected;
		vi.spyOn(native, "verifyOwnerOnlyPathSecurityExpected").mockImplementation((pathname, kind, dev, ino) => {
			const result = originalExpected(pathname, kind, dev, ino);
			replaceAfterVerification(pathname);
			return result;
		});
		await expect(discoverManagedGcSessionRetirementReceipts(fixture)).rejects.toThrow(
			process.platform === "win32" ? "identity_mismatch" : "managed_gc_scope_authority_mismatch",
		);
		if (!retainedSnapshot) throw new Error("Configured-parent replacement did not reach the verified boundary");
		expect(fs.lstatSync(fixture.configuredRoot, { bigint: true }).ino).not.toBe(originalParent.ino);
		expect(fs.lstatSync(fixture.sessionsRoot, { bigint: true }).ino).toBe(originalSessions.ino);
		expect(snapshotTree(fixture.sessionsRoot)).toEqual(retainedSnapshot);
	});

	for (const phase of ["prepared", "artifacts_removed"] as const) {
		for (const transcriptAuthority of ["retained", "absent", "fsync-empty"] as const) {
			it(`retains a genuine legacy SDK receipt after GC ${phase} with ${transcriptAuthority} authority`, async () => {
				const fixture = makeFixture();
				writeSession(fixture.scope, fixture.sessionId, fixture.cwd);
				const canonicalTranscript = fs.realpathSync(fixture.transcriptPath);
				const originalUnlink = native.exactUnlink;
				const failure = vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
					if (pathname === fixture.transcriptPath || pathname === canonicalTranscript)
						return { ok: false, code: "io_error" };
					return originalUnlink(pathname, identity);
				});
				let broker = new Broker({ agentDir: fixture.agentDir });
				const request = {
					cwd: fixture.cwd,
					stateRoot: path.join(fixture.cwd, ".gjc", "state"),
					sessionId: fixture.sessionId,
					sessionPath: fixture.transcriptPath,
				};
				const requestId = `legacy-sdk-before-gc-${phase}`;
				try {
					await broker.start();
					const initial = await broker.handleRequest("session.delete", request, requestId);
					if (initial.ok || !initial.error.cleanup)
						throw new Error(`Expected genuine SDK pending receipt: ${JSON.stringify(initial)}`);
					expect(initial.error.code).toBe("cleanup_pending");
					expect(initial.error.cleanup.phase).toBe("transcript");
					expect(
						failure.mock.calls.some(
							([pathname]) => pathname === fixture.transcriptPath || pathname === canonicalTranscript,
						),
					).toBe(true);
					failure.mockRestore();
					await broker.stop();
					writeSession(fixture.scope, fixture.sessionId, fixture.cwd, fixture.locator);
					await backdate(fixture.transcriptPath, 90);
					writeSession(fixture.scope, "newest-session", fixture.cwd);
					const { evidence } =
						phase === "prepared" ? await publishPrepared(fixture) : await publishArtifactsRemoved(fixture);
					await runGc(fixture, true);
					const before = await readManagedGcSessionRetirementReceipt(fixture.scope, fixture.transcriptPath);
					if (!before) throw new Error("Expected original GC native disposition");
					if (transcriptAuthority === "absent" && fs.existsSync(fixture.transcriptPath))
						fs.unlinkSync(fixture.transcriptPath);
					if (transcriptAuthority === "fsync-empty") {
						const descriptor = fs.openSync(fixture.transcriptPath, "w", 0o600);
						try {
							fs.fsyncSync(descriptor);
						} finally {
							fs.closeSync(descriptor);
						}
					}
					const journalBefore = journalRecords(fixture.scope.directoryPath);
					const ownerBefore = fs.existsSync(fixture.ownerPath) ? snapshotTree(fixture.ownerPath) : undefined;
					const retainedOwner = before.taskArtifactOwnerRetirementContinuation?.retainedRootPath;
					const retainedBefore =
						retainedOwner && fs.existsSync(retainedOwner) ? snapshotTree(retainedOwner) : undefined;
					const transcriptBefore = fs.existsSync(fixture.transcriptPath)
						? fs.readFileSync(fixture.transcriptPath)
						: undefined;
					broker = new Broker({ agentDir: fixture.agentDir });
					await broker.start();
					const replay = await broker.handleRequest("session.delete", request, requestId);
					expect(retainedOwner && fs.existsSync(retainedOwner) ? snapshotTree(retainedOwner) : undefined).toEqual(
						retainedBefore,
					);
					expect(replay.ok).toBe(false);
					if (replay.ok) throw new Error("Legacy SDK receipt promoted owner/header drift to completion");
					expect(replay.error.code).toBe(
						transcriptAuthority === "fsync-empty" ? "invalid_input" : "cleanup_pending",
					);
					expect(fs.existsSync(fixture.ownerPath) ? snapshotTree(fixture.ownerPath) : undefined).toEqual(
						ownerBefore,
					);
					expect(
						fs.existsSync(fixture.transcriptPath) ? fs.readFileSync(fixture.transcriptPath) : undefined,
					).toEqual(transcriptBefore);
					expect(journalRecords(fixture.scope.directoryPath)).toEqual(journalBefore);
					if (transcriptAuthority === "fsync-empty") {
						await expect(
							readManagedGcSessionRetirementReceipt(fixture.scope, fixture.transcriptPath),
						).rejects.toThrow("task_artifact_owner_transcript_header_invalid");
					} else {
						const after = await readManagedGcSessionRetirementReceipt(fixture.scope, fixture.transcriptPath);
						expect(after?.taskArtifactOwnerDeletionEvidence).toEqual(evidence);
						expect(after?.taskArtifactOwnerRetirementOutcome).toEqual(before.taskArtifactOwnerRetirementOutcome);
					}
				} finally {
					failure.mockRestore();
					await broker.stop();
				}
			});
		}
	}

	for (const phase of ["prepared", "artifacts_removed"] as const) {
		it(`refuses fresh SDK authority adoption after GC ${phase}`, async () => {
			const fixture = makeFixture();
			await backdate(fixture.transcriptPath, 90);
			writeSession(fixture.scope, "newest-session", fixture.cwd);
			let broker = new Broker({ agentDir: fixture.agentDir });
			const request = {
				cwd: fixture.cwd,
				stateRoot: path.join(fixture.cwd, ".gjc", "state"),
				sessionId: fixture.sessionId,
				sessionPath: fixture.transcriptPath,
			};
			const requestId = `sdk-before-gc-${phase}`;
			try {
				const { evidence } =
					phase === "prepared" ? await publishPrepared(fixture) : await publishArtifactsRemoved(fixture);
				await runGc(fixture, true);
				const before = await readManagedGcSessionRetirementReceipt(fixture.scope, fixture.transcriptPath);
				if (!before) throw new Error("Expected original GC owner disposition");
				expect(before.taskArtifactOwnerDeletionEvidence).toEqual(evidence);
				const ownerBefore = fs.existsSync(fixture.ownerPath) ? snapshotTree(fixture.ownerPath) : undefined;
				const retainedOwner = before.taskArtifactOwnerRetirementContinuation?.retainedRootPath;
				const retainedBefore =
					retainedOwner && fs.existsSync(retainedOwner) ? snapshotTree(retainedOwner) : undefined;
				const transcriptBefore = fs.existsSync(fixture.transcriptPath)
					? fs.readFileSync(fixture.transcriptPath)
					: undefined;
				broker = new Broker({ agentDir: fixture.agentDir });
				await broker.start();
				const replay = await broker.handleRequest("session.delete", request, requestId);
				expect(retainedOwner && fs.existsSync(retainedOwner) ? snapshotTree(retainedOwner) : undefined).toEqual(
					retainedBefore,
				);
				expect(replay.ok).toBe(false);
				if (replay.ok) throw new Error("SDK promoted missing owner authority to completion");
				if (replay.error.code === "cleanup_pending") {
					expect(replay.error.cleanup?.phase).toBe("artifacts");
					expect(replay.error.cleanup).not.toHaveProperty("taskArtifactOwnerRetired", true);
				} else {
					expect(replay.error.code).toBe(transcriptBefore ? "invalid_input" : "not_found");
				}
				expect(fs.existsSync(fixture.ownerPath) ? snapshotTree(fixture.ownerPath) : undefined).toEqual(ownerBefore);
				expect(fs.existsSync(fixture.transcriptPath) ? fs.readFileSync(fixture.transcriptPath) : undefined).toEqual(
					transcriptBefore,
				);
				const after = await readManagedGcSessionRetirementReceipt(fixture.scope, fixture.transcriptPath);
				expect(after?.taskArtifactOwnerDeletionEvidence).toEqual(evidence);
				expect(after?.taskArtifactOwnerRetirementOutcome).toEqual(before.taskArtifactOwnerRetirementOutcome);
			} finally {
				await broker.stop();
			}
		});
	}

	it("keeps dry-run read-only while projecting the owner-aware retirement decision", async () => {
		const fixture = makeFixture();
		await backdate(fixture.transcriptPath, 90);
		writeSession(fixture.scope, "newest-session", fixture.cwd);
		const before = snapshotTree(fixture.root);

		const report = await runGc(fixture, false);

		expect(report.surfaces.sessions.records.find(record => record.path === fixture.transcriptPath)?.action).toBe(
			"would_reclaim",
		);
		expect(snapshotTree(fixture.root)).toEqual(before);
		expect(fs.existsSync(fixture.ownerPath)).toBe(true);
		expect(fs.existsSync(fixture.transcriptPath)).toBe(true);
	});

	it("blocks a cross-cwd sibling reference but ignores a valid owner in another private profile", async () => {
		const fixture = makeFixture();
		await backdate(fixture.transcriptPath, 90);
		writeSession(fixture.scope, "newest-session", fixture.cwd);

		const otherProfile = path.join(fixture.root, "other-profile");
		const otherSessions = path.join(otherProfile, "sessions");
		fs.mkdirSync(otherSessions, { recursive: true, mode: 0o700 });
		const otherCwd = path.join(fixture.root, "other-workspace");
		fs.mkdirSync(otherCwd, { mode: 0o700 });
		const otherScope = managedScope(otherProfile, otherSessions, otherCwd);
		const otherContext = taskArtifactOwnerStorageContextForScope(otherScope);
		const otherRootStore = newSessionRootStore(otherContext);
		let otherLocator: TaskArtifactOwnerLocator | undefined;
		try {
			otherRootStore.ensureDirectory(OWNER_DIRECTORY);
			const ownerDirectory = otherRootStore.ensureDirectory(ownerRelativePath(fixture.locator.ownerId));
			otherLocator = {
				schemaVersion: OWNER_SCHEMA_VERSION,
				ownerId: fixture.locator.ownerId,
				directoryDev: ownerDirectory.dev.toString(),
				directoryIno: ownerDirectory.ino.toString(),
			};
			const ownerStore = otherRootStore.deriveSubtree(ownerRelativePath(otherLocator.ownerId));
			try {
				ownerStore.publishNoReplaceSync(
					OWNER_MANIFEST,
					Buffer.from(JSON.stringify({ ...otherLocator, sessionId: fixture.sessionId }), "utf8"),
				);
				ownerStore.publishNoReplaceSync("payload.bin", Buffer.from("other profile payload", "utf8"));
			} finally {
				ownerStore.close();
			}
		} finally {
			otherRootStore.close();
		}
		if (!otherLocator) throw new Error("other_profile_owner_locator_missing");
		const otherTranscript = writeSession(otherScope, fixture.sessionId, otherCwd, otherLocator);
		const profileOnly = await runGc(fixture, false);
		expect(profileOnly.surfaces.sessions.records.find(record => record.path === fixture.transcriptPath)?.action).toBe(
			"would_reclaim",
		);
		fs.unlinkSync(otherTranscript);

		const siblingCwd = path.join(fixture.root, "sibling-workspace");
		fs.mkdirSync(siblingCwd, { mode: 0o700 });
		const siblingScope = managedScope(fixture.agentDir, fixture.sessionsRoot, siblingCwd);
		const siblingTranscript = writeSession(siblingScope, fixture.sessionId, siblingCwd, fixture.locator);
		const shared = await runGc(fixture, false);
		expect(shared.surfaces.sessions.records.find(record => record.path === fixture.transcriptPath)).toMatchObject({
			action: "keep",
			reason: expect.stringContaining("task_artifact_owner_shared_with_sibling_transcript"),
		});
		expect(fs.existsSync(siblingTranscript)).toBe(true);
		expect(fs.existsSync(fixture.ownerPath)).toBe(true);
	});

	it.skipIf(process.platform !== "darwin")(
		"retains the transcript when actual legacy artifact cleanup is native-pending",
		async () => {
			const fixture = makeFixture();
			const artifactsPath = fixture.transcriptPath.slice(0, -".jsonl".length);
			fs.mkdirSync(artifactsPath, { mode: 0o700 });
			fs.writeFileSync(path.join(artifactsPath, "legacy.log"), "actual legacy artifact payload");
			await backdate(fixture.transcriptPath, 90);
			writeSession(fixture.scope, "newest-session", fixture.cwd);
			const ownerBefore = snapshotTree(fixture.ownerPath);
			const originalRemove = native.exactRemoveDirectoryTree;
			const removeSpy = vi
				.spyOn(native, "exactRemoveDirectoryTree")
				.mockImplementation((pathname, snapshot, parent) => originalRemove(pathname, snapshot, parent));
			try {
				const report = await runGc(fixture, true);
				const record = report.surfaces.sessions.records.find(item => item.path === fixture.transcriptPath);
				expect(record).toMatchObject({ action: "reclaim_failed", phase: "artifacts" });
				expect(record?.reason).toContain("cleanup_pending");
				expect(fs.existsSync(fixture.transcriptPath)).toBe(true);
				expect(snapshotTree(fixture.ownerPath)).toEqual(ownerBefore);
				expect(removeSpy.mock.calls.some(([pathname]) => pathname === fixture.ownerPath)).toBe(false);
				const receipt = await readManagedGcSessionRetirementReceipt(fixture.scope, fixture.transcriptPath);
				expect(receipt?.state).toBe("prepared");
				expect(receipt?.taskArtifactOwnerDeletionEvidence).toBeDefined();
			} finally {
				removeSpy.mockRestore();
			}
		},
	);

	for (const phase of ["prepared", "artifacts_removed"] as const) {
		it(`replays ${phase} through actual GC with persisted phase authority`, async () => {
			const fixture = makeFixture();
			await backdate(fixture.transcriptPath, 90);
			writeSession(fixture.scope, "newest-session", fixture.cwd);
			let evidence: TaskArtifactOwnerDeletionEvidence;
			if (phase === "prepared") {
				({ evidence } = await publishPrepared(fixture));
			} else {
				const prepared = await publishArtifactsRemoved(fixture);
				evidence = prepared.evidence;
			}
			const originalRemove = native.exactRemoveDirectoryTree;
			const originalDelete = FileSessionStorage.prototype.deleteSessionVerified;
			const ownerRemoval = vi
				.spyOn(native, "exactRemoveDirectoryTree")
				.mockImplementation((pathname, snapshot, parent) => {
					if (pathname === fixture.ownerPath || pathname === `${fixture.ownerPath}.removing`) {
						const states = journalRecords(fixture.scope.directoryPath).map(entry => entry.record.state);
						expect(states).toContain("artifacts_removed");
						expect(states).not.toContain("owner_retired");
					}
					return originalRemove(pathname, snapshot, parent);
				});
			const transcriptEffects = vi
				.spyOn(FileSessionStorage.prototype, "deleteSessionVerified")
				.mockImplementation(async function (this: FileSessionStorage, target, inspectProtocol) {
					const receipt = await readManagedGcSessionRetirementReceipt(fixture.scope, fixture.transcriptPath);
					if (target.artifactsRemoved === true) expect(receipt?.state).toBe("owner_retired");
					else expect(receipt?.state).toBe("prepared");
					return originalDelete.call(this, target, inspectProtocol);
				});
			try {
				const report = await runGc(fixture, true);
				const record = report.surfaces.sessions.records.find(item => item.path === fixture.transcriptPath);
				const receipt = await readManagedGcSessionRetirementReceipt(fixture.scope, fixture.transcriptPath);
				expect(receipt?.taskArtifactOwnerDeletionEvidence).toEqual(evidence);
				expect(record?.reason).not.toContain("task_artifact_owner_shared_with_sibling_transcript");
				if (
					!ownerRemoval.mock.calls.some(
						([pathname]) => pathname === fixture.ownerPath || pathname === `${fixture.ownerPath}.removing`,
					)
				)
					throw new Error(
						`GC did not reach native owner cleanup: ${record?.action}:${record?.reason}; receipt=${receipt?.state}`,
					);
				if (receipt?.state === "owner_pending") {
					expect(record?.action).toBe("reclaim_failed");
					expect(record?.phase).toBe("artifacts");
					expect(fs.existsSync(fixture.transcriptPath)).toBe(true);
					const outcome = receipt.taskArtifactOwnerRetirementOutcome;
					if (!outcome || outcome.kind === "completed") throw new Error("Expected pending native owner proof");
					verifyTaskArtifactOwnerRetirementContinuation(
						taskArtifactOwnerStorageContextForScope(fixture.scope),
						evidence,
						outcome.continuation,
					);
					if (outcome.kind === "payload_retired") {
						expect(outcome.nativeOutcome).toMatchObject({
							ok: false,
							code: "cleanup_pending",
							payloadDurable: true,
						});
						expect(outcome.continuation.payloadDurable).toBe(true);
						expect(record?.task_artifact_owner_payload_retired).toBe(true);
						expect(record?.task_artifact_owner_namespace_retained).toBe(true);
						expect(record?.task_artifact_owner_retired).toBeUndefined();
					}
				} else {
					expect(receipt?.state).toBe("owner_retired");
					expect(record?.action).toBe("reclaimed");
					expect(receipt?.taskArtifactOwnerRetirementOutcome?.kind).toBe("completed");
				}
			} finally {
				ownerRemoval.mockRestore();
				transcriptEffects.mockRestore();
			}
		});
	}

	it.skipIf(process.platform !== "darwin")(
		"persists actual native owner-pending proof and replays the residual without a transcript",
		async () => {
			const fixture = makeFixture();
			await backdate(fixture.transcriptPath, 90);
			writeSession(fixture.scope, "newest-session", fixture.cwd);
			const prepared = await publishArtifactsRemoved(fixture);
			const originalRemove = native.exactRemoveDirectoryTree;
			const nativeResults: NativeExactUnlinkResult[] = [];
			const statesBeforeNative: unknown[][] = [];
			const removeSpy = vi
				.spyOn(native, "exactRemoveDirectoryTree")
				.mockImplementation((pathname, snapshot, parent) => {
					if (pathname === fixture.ownerPath || pathname === `${fixture.ownerPath}.removing`) {
						const states = journalRecords(fixture.scope.directoryPath).map(entry => entry.record.state);
						statesBeforeNative.push(states);
						expect(states).toContain("artifacts_removed");
					}
					const result = originalRemove(pathname, snapshot, parent);
					if (pathname === fixture.ownerPath || pathname === `${fixture.ownerPath}.removing`)
						nativeResults.push(result);
					return result;
				});
			try {
				const firstReport = await runGc(fixture, true);
				const first = await readManagedGcSessionRetirementReceipt(fixture.scope, fixture.transcriptPath);
				expect(
					firstReport.surfaces.sessions.records.find(item => item.path === fixture.transcriptPath)?.reason,
				).not.toContain("task_artifact_owner_shared_with_sibling_transcript");
				if (first?.state !== "owner_pending") {
					const record = firstReport.surfaces.sessions.records.find(item => item.path === fixture.transcriptPath);
					throw new Error(
						`Expected actual native owner-pending receipt; GC classified ${record?.action}:${record?.reason}; receipt=${first?.state}`,
					);
				}
				expect(nativeResults).toHaveLength(1);
				expect(statesBeforeNative[0]).not.toContain("owner_pending");
				const firstOutcome = first.taskArtifactOwnerRetirementOutcome;
				if (!firstOutcome || firstOutcome.kind === "completed")
					throw new Error("actual_native_owner_pending_outcome_missing");
				expect(firstOutcome.kind).toBe("payload_retired");
				expect(firstOutcome.nativeOutcome).toEqual(nativeResults[0]);
				expect(first.taskArtifactOwnerDeletionEvidence).toEqual(prepared.evidence);
				verifyTaskArtifactOwnerRetirementContinuation(
					taskArtifactOwnerStorageContextForScope(fixture.scope),
					prepared.evidence,
					firstOutcome.continuation,
				);
				expect(
					firstReport.surfaces.sessions.records.find(item => item.path === fixture.transcriptPath),
				).toMatchObject({
					action: "reclaim_failed",
					phase: "artifacts",
					task_artifact_owner_payload_retired: true,
					task_artifact_owner_namespace_retained: true,
				});
				expect(fs.existsSync(fixture.transcriptPath)).toBe(true);

				fs.unlinkSync(fixture.transcriptPath);
				const beforeDryRun = snapshotTree(fixture.root);
				const dryRun = await runGc(fixture, false);
				expect(dryRun.surfaces.sessions.records.find(item => item.path === fixture.transcriptPath)).toMatchObject({
					action: "keep",
					withheld: true,
					task_artifact_owner_payload_retired: true,
					task_artifact_owner_namespace_retained: true,
				});
				expect(snapshotTree(fixture.root)).toEqual(beforeDryRun);

				const replay = await runGc(fixture, true);
				const record = replay.surfaces.sessions.records.find(item => item.path === fixture.transcriptPath);
				const after = await readManagedGcSessionRetirementReceipt(fixture.scope, fixture.transcriptPath);
				expect(nativeResults.length).toBeGreaterThanOrEqual(2);
				expect(statesBeforeNative.at(-1)).toContain("owner_pending");
				if (!after) throw new Error("Expected the immutable owner retirement receipt after GC replay");
				expect(after.taskArtifactOwnerDeletionEvidence).toEqual(prepared.evidence);
				if (after?.state === "owner_pending") {
					const outcome = after.taskArtifactOwnerRetirementOutcome;
					if (!outcome || outcome.kind === "completed")
						throw new Error("replayed_native_owner_pending_outcome_missing");
					expect(outcome.nativeOutcome).toEqual(nativeResults.at(-1));
					verifyTaskArtifactOwnerRetirementContinuation(
						taskArtifactOwnerStorageContextForScope(fixture.scope),
						prepared.evidence,
						outcome.continuation,
					);
					expect(record).toMatchObject({ action: "reclaim_failed", phase: "artifacts" });
					expect(record?.task_artifact_owner_retired).toBeUndefined();
					expect(fs.existsSync(fixture.transcriptPath)).toBe(false);
				} else {
					expect(after?.state).toBe("owner_retired");
					expect(after?.taskArtifactOwnerRetirementOutcome?.nativeOutcome).toEqual(nativeResults.at(-1));
					expect(after?.taskArtifactOwnerPayloadRetired).toBeUndefined();
					expect(after?.taskArtifactOwnerNamespaceRetained).toBeUndefined();
					expect(after?.taskArtifactOwnerRetirementContinuation).toBeUndefined();
					expect(record).toMatchObject({ action: "reclaim_failed", phase: "transcript" });
					expect(record?.task_artifact_owner_retired).toBe(true);
					expect(record?.task_artifact_owner_payload_retired).toBeUndefined();
					expect(record?.task_artifact_owner_namespace_retained).toBeUndefined();
					expect(fs.existsSync(fixture.transcriptPath)).toBe(false);
				}
			} finally {
				removeSpy.mockRestore();
			}
		},
	);

	for (const phase of ["prepared", "artifacts_removed"] as const) {
		it(`discovers and fails closed on transcript-less ${phase} retirement receipts`, async () => {
			const fixture = makeFixture();
			await backdate(fixture.transcriptPath, 90);
			const prepared =
				phase === "prepared" ? await publishPrepared(fixture) : await publishArtifactsRemoved(fixture);
			fs.unlinkSync(fixture.transcriptPath);
			writeSession(fixture.scope, "newest-session", fixture.cwd);
			const beforeDryRun = snapshotTree(fixture.root);
			const dryRun = await runGc(fixture, false);
			expect(dryRun.surfaces.sessions.records.find(record => record.path === fixture.transcriptPath)).toMatchObject({
				action: "keep",
				withheld: true,
			});
			expect(snapshotTree(fixture.root)).toEqual(beforeDryRun);

			const report = await runGc(fixture, true);
			const record = report.surfaces.sessions.records.find(item => item.path === fixture.transcriptPath);
			const after = await readManagedGcSessionRetirementReceipt(fixture.scope, fixture.transcriptPath);
			expect(record?.action).toBe("reclaim_failed");
			if (!after) throw new Error("Expected the immutable owner retirement receipt after GC replay");
			expect(after.taskArtifactOwnerDeletionEvidence).toEqual(prepared.evidence);
			expect(fs.existsSync(fixture.transcriptPath)).toBe(false);
			if (phase === "prepared") {
				expect(after?.state).toBe("prepared");
				expect(record?.phase).toBe("transcript");
				expect(fs.existsSync(fixture.ownerPath)).toBe(true);
			} else {
				expect(["artifacts_removed", "owner_pending", "owner_retired"]).toContain(after?.state);
				if (after?.state === "owner_retired")
					expect(after.taskArtifactOwnerRetirementOutcome?.kind).toBe("completed");
			}
		});
	}

	it("preserves a replaced owner authority during actual GC pruning", async () => {
		const fixture = makeFixture();
		await backdate(fixture.transcriptPath, 90);
		writeSession(fixture.scope, "newest-session", fixture.cwd);
		const displaced = `${fixture.ownerPath}.captured`;
		const replacement = path.join(fixture.root, "replacement-owner");
		fs.renameSync(fixture.ownerPath, displaced);
		fs.mkdirSync(replacement, { mode: 0o700 });
		fs.writeFileSync(path.join(replacement, "foreign.bin"), "foreign payload", { mode: 0o600 });
		fs.renameSync(replacement, fixture.ownerPath);
		const replacementStat = fs.lstatSync(fixture.ownerPath, { bigint: true });

		const report = await runGc(fixture, true);

		expect(report.surfaces.sessions.records.find(record => record.path === fixture.transcriptPath)).toMatchObject({
			action: "keep",
			reason: expect.stringContaining("task_artifact_owner"),
		});
		expect(fs.readFileSync(path.join(fixture.ownerPath, "foreign.bin"), "utf8")).toBe("foreign payload");
		expect(fs.lstatSync(fixture.ownerPath, { bigint: true }).ino).toBe(replacementStat.ino);
		expect(fs.existsSync(displaced)).toBe(true);
		expect(fs.existsSync(fixture.transcriptPath)).toBe(true);
	});

	it("rejects persisted owner-retired flags without current native physical proof", async () => {
		const fixture = makeFixture();
		const target = bindManagedGcSessionRetirementTarget(fixture.scope, fixture.transcriptPath);
		const context = taskArtifactOwnerStorageContextForScope(fixture.scope);
		const evidence = captureTaskArtifactOwnerDeletionEvidence(
			context,
			fixture.sessionId,
			target.taskArtifactOwnerLocator,
		);
		if (!evidence) throw new Error("fixture_owner_evidence_missing");
		await publishManagedGcSessionRetirementReceipt(fixture.scope, {
			...target,
			state: "prepared",
			taskArtifactOwnerDeletionEvidence: evidence,
		});
		await publishManagedGcSessionRetirementReceipt(fixture.scope, {
			...target,
			state: "artifacts_removed",
			taskArtifactOwnerDeletionEvidence: evidence,
			artifactsRemoved: true,
		});
		const forgedCompleted: TaskArtifactOwnerRetirementOutcome = {
			kind: "completed",
			evidence: evidence as TaskArtifactOwnerDeletionEvidence,
			nativeOutcome: { ok: true },
		};

		await expect(
			publishManagedGcSessionRetirementReceipt(fixture.scope, {
				...target,
				state: "owner_retired",
				taskArtifactOwnerDeletionEvidence: evidence,
				artifactsRemoved: true,
				taskArtifactOwnerRetired: true,
				taskArtifactOwnerRetirementOutcome: forgedCompleted,
			}),
		).rejects.toThrow("task_artifact_owner_physical_retirement_unverified");
		expect(fs.existsSync(fixture.ownerPath)).toBe(true);
		expect(fs.existsSync(fixture.transcriptPath)).toBe(true);
	});
});
