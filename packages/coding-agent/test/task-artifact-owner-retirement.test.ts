import { afterEach, describe, expect, it, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { NativeExactUnlinkResult } from "@gajae-code/natives";
import * as native from "@gajae-code/natives";
import {
	type ManagedDirectoryRoot,
	ManagedSessionDescendantStore,
	prepareManagedDirectoryRoot,
} from "../src/session/internal/managed-session-storage";
import { captureTaskArtifactOwnerDeletionEvidence } from "../src/session/internal/task-artifact-owner-access";
import {
	OWNER_DIRECTORY,
	OWNER_MANIFEST,
	OWNER_RETIREMENT_SCHEMA_VERSION,
	OWNER_SCHEMA_VERSION,
	ownerAbsolutePath,
	ownerIdForSession,
	ownerRelativePath,
	parseTaskArtifactOwnerRetirementOutcome,
	type TaskArtifactOwnerDeletionEvidence,
	type TaskArtifactOwnerLocator,
	type TaskArtifactOwnerRetirementContinuation,
	type TaskArtifactOwnerStorageContext,
} from "../src/session/task-artifact-owner-codec";
import {
	retireTaskArtifactOwner,
	verifyTaskArtifactOwnerPhysicalRetirement,
	verifyTaskArtifactOwnerRetirementContinuation,
} from "../src/session/task-artifact-owner-retirement";

interface OwnerFixture {
	readonly root: string;
	readonly sessionId: string;
	readonly context: TaskArtifactOwnerStorageContext;
	readonly locator: TaskArtifactOwnerLocator;
	readonly ownerPath: string;
	readonly evidence: TaskArtifactOwnerDeletionEvidence;
}

const fixtureRoots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of fixtureRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function expectedDirectoryRoot(pathname: string): ManagedDirectoryRoot {
	const stat = fs.lstatSync(pathname, { bigint: true });
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("fixture_directory_invalid");
	return {
		canonicalPath: path.resolve(pathname),
		dev: BigInt.asUintN(64, stat.dev),
		ino: BigInt.asUintN(64, stat.ino),
	};
}

async function makeOwnerFixture(): Promise<OwnerFixture> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-owner-retirement-"));
	fixtureRoots.push(root);
	const profileAgentDir = path.resolve(root);
	const sessionsRoot = path.join(profileAgentDir, "sessions");
	fs.mkdirSync(sessionsRoot, { mode: 0o700 });
	const securityPolicy = process.platform === "win32" ? "windows-existing-verify-first" : "default";
	const context: TaskArtifactOwnerStorageContext = {
		rootAuthority: prepareManagedDirectoryRoot(profileAgentDir, securityPolicy),
		sessionsRoot,
		securityPolicy,
		profileAgentDir,
	};
	const sessionId = `retirement-session-${crypto.randomUUID()}`;
	const ownerId = ownerIdForSession(sessionId);
	const rootStore = new ManagedSessionDescendantStore(
		context.rootAuthority,
		sessionsRoot,
		undefined,
		securityPolicy,
		profileAgentDir,
		expectedDirectoryRoot(sessionsRoot),
	);
	let ownerStore: ManagedSessionDescendantStore | undefined;
	let locator: TaskArtifactOwnerLocator;
	let ownerPath: string;
	let ownerRoot: ManagedDirectoryRoot;
	try {
		rootStore.verifyRootSecurity();
		rootStore.ensureDirectory(OWNER_DIRECTORY);
		ownerRoot = rootStore.ensureDirectory(ownerRelativePath(ownerId));
		locator = {
			schemaVersion: OWNER_SCHEMA_VERSION,
			ownerId,
			directoryDev: ownerRoot.dev.toString(),
			directoryIno: ownerRoot.ino.toString(),
		};
		ownerPath = ownerAbsolutePath(context, ownerId);
		ownerStore = new ManagedSessionDescendantStore(
			context.rootAuthority,
			ownerPath,
			undefined,
			securityPolicy,
			profileAgentDir,
			ownerRoot,
		);
		await ownerStore.publishNoReplace(
			OWNER_MANIFEST,
			Buffer.from(`${JSON.stringify({ ...locator, sessionId })}\n`, "utf8"),
		);
		await ownerStore.publishNoReplace("artifact.bin", Buffer.from("original-owner-payload", "utf8"));
	} finally {
		ownerStore?.close();
		rootStore.close();
	}
	const evidence = captureTaskArtifactOwnerDeletionEvidence(context, sessionId, locator);
	if (!evidence) throw new Error("fixture_owner_evidence_missing");
	return { root, sessionId, context, locator, ownerPath, evidence };
}

function continuationFor(
	fixture: OwnerFixture,
	retainedRootPath = `${fixture.ownerPath}.removing`,
): TaskArtifactOwnerRetirementContinuation {
	return {
		schemaVersion: OWNER_RETIREMENT_SCHEMA_VERSION,
		parentIdentity: fixture.evidence.parentIdentity,
		retainedRootPath,
		retainedTreeSnapshot: fixture.evidence.treeSnapshot,
	};
}

function observeActualNativeRemoval() {
	const directRemove = native.exactRemoveDirectoryTree;
	const calls: NativeExactUnlinkResult[] = [];
	const spy = vi.spyOn(native, "exactRemoveDirectoryTree").mockImplementation((pathname, snapshot, parent) => {
		const result = directRemove(pathname, snapshot, parent);
		calls.push(result);
		return result;
	});
	return { calls, spy };
}

describe("task artifact owner native retirement", () => {
	it("forwards the actual native outcome and only verifies a completed physical removal", async () => {
		const fixture = await makeOwnerFixture();
		const { calls, spy } = observeActualNativeRemoval();
		const outcome = retireTaskArtifactOwner(fixture.context, fixture.evidence);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(["completed", "payload_retired", "cleanup_pending", "uncertain"]).toContain(outcome.kind);
		if (calls.length > 0) expect(outcome.nativeOutcome).toBe(calls[0]);
		if (outcome.kind === "completed") {
			expect(calls[0]?.ok).toBe(true);
			verifyTaskArtifactOwnerPhysicalRetirement(fixture.context, fixture.evidence, outcome);
		} else if (outcome.kind === "payload_retired") {
			expect(calls[0]?.ok).toBe(false);
			expect(calls[0]?.code).toBe("cleanup_pending");
			expect(calls[0]?.payloadDurable).toBe(true);
			expect(outcome.continuation.payloadDurable).toBe(true);
			expect(outcome.continuation.retainedRootPath).toBe(`${fixture.ownerPath}.removing`);
		} else if (outcome.kind === "cleanup_pending") {
			expect(calls[0]?.ok).toBe(false);
			expect(calls[0]?.code).toBe("cleanup_pending");
		}
	});
	it("continues an actually retained .removing tree without expanding the captured authority", async () => {
		const fixture = await makeOwnerFixture();
		const removingPath = `${fixture.ownerPath}.removing`;
		fs.renameSync(fixture.ownerPath, removingPath);
		const previous = continuationFor(fixture, removingPath);
		expect(verifyTaskArtifactOwnerRetirementContinuation(fixture.context, fixture.evidence, previous)).toEqual(
			previous,
		);

		const { calls, spy } = observeActualNativeRemoval();
		const outcome = retireTaskArtifactOwner(fixture.context, fixture.evidence, previous);
		expect(spy).toHaveBeenCalledTimes(1);
		if (calls.length > 0) expect(outcome.nativeOutcome).toBe(calls[0]);
		if (outcome.kind === "completed")
			verifyTaskArtifactOwnerPhysicalRetirement(fixture.context, fixture.evidence, outcome);
		else {
			expect(outcome.continuation.retainedRootPath).toBe(removingPath);
			if (fs.existsSync(removingPath))
				expect(
					verifyTaskArtifactOwnerRetirementContinuation(fixture.context, fixture.evidence, outcome.continuation)
						.retainedRootPath,
				).toBe(removingPath);
		}
	});
	it("refuses restored staging and replacement writer markers before any native call", async () => {
		for (const phase of ["staging", "replacement"] as const) {
			const fixture = await makeOwnerFixture();
			const marker = `.${phase}.${crypto.randomUUID()}.${phase}`;
			const markerPath = path.join(fixture.ownerPath, marker);
			fs.writeFileSync(markerPath, "restored managed writer marker", { mode: 0o600 });
			const { spy } = observeActualNativeRemoval();

			const outcome = retireTaskArtifactOwner(fixture.context, fixture.evidence);
			expect(outcome.kind).toBe("uncertain");
			if (outcome.kind !== "uncertain") throw new Error("writer marker unexpectedly retired");
			expect(outcome.reason).toBe("task_artifact_owner_writer_not_quiescent");
			expect(spy).not.toHaveBeenCalled();
			expect(fs.readFileSync(markerPath, "utf8")).toBe("restored managed writer marker");
			vi.restoreAllMocks();
		}
	});
	it("preserves changed payload hashes and replacement manifests without calling native removal", async () => {
		for (const replacement of ["payload", "manifest"] as const) {
			const fixture = await makeOwnerFixture();
			const pathname = path.join(fixture.ownerPath, replacement === "payload" ? "artifact.bin" : OWNER_MANIFEST);
			const bytes = Buffer.from(replacement === "payload" ? "changed-owner-payload" : "replaced-manifest", "utf8");
			fs.writeFileSync(pathname, bytes);
			const { spy } = observeActualNativeRemoval();

			const outcome = retireTaskArtifactOwner(fixture.context, fixture.evidence);
			expect(outcome.kind).toBe("uncertain");
			expect(spy).not.toHaveBeenCalled();
			expect(fs.readFileSync(pathname)).toEqual(bytes);
			vi.restoreAllMocks();
		}
	});

	it("preserves a replaced owner root and owner parent instead of repairing either namespace", async () => {
		const rootFixture = await makeOwnerFixture();
		const displacedOwner = `${rootFixture.ownerPath}.original-${crypto.randomUUID()}`;
		const replacementOwner = `${rootFixture.ownerPath}.replacement-${crypto.randomUUID()}`;
		fs.mkdirSync(replacementOwner, { mode: 0o700 });
		const replacementBytes = Buffer.from("untrusted replacement payload", "utf8");
		fs.writeFileSync(
			path.join(replacementOwner, OWNER_MANIFEST),
			`${JSON.stringify({ ...rootFixture.locator, sessionId: rootFixture.sessionId })}\n`,
			{ mode: 0o600 },
		);
		fs.writeFileSync(path.join(replacementOwner, "artifact.bin"), replacementBytes, { mode: 0o600 });
		fs.renameSync(rootFixture.ownerPath, displacedOwner);
		fs.renameSync(replacementOwner, rootFixture.ownerPath);
		const rootSpy = observeActualNativeRemoval().spy;
		try {
			const outcome = retireTaskArtifactOwner(rootFixture.context, rootFixture.evidence);
			expect(outcome.kind).toBe("uncertain");
			expect(rootSpy).not.toHaveBeenCalled();
			expect(fs.readFileSync(path.join(rootFixture.ownerPath, "artifact.bin"))).toEqual(replacementBytes);
		} finally {
			fs.renameSync(rootFixture.ownerPath, replacementOwner);
			fs.renameSync(displacedOwner, rootFixture.ownerPath);
			vi.restoreAllMocks();
		}

		const parentFixture = await makeOwnerFixture();
		const parent = path.join(parentFixture.context.sessionsRoot, OWNER_DIRECTORY);
		const displacedParent = `${parent}.original-${crypto.randomUUID()}`;
		fs.renameSync(parent, displacedParent);
		fs.mkdirSync(parent, { mode: 0o700 });
		const sentinel = path.join(parent, "foreign-parent-sentinel");
		fs.writeFileSync(sentinel, "untouched parent occupant", { mode: 0o600 });
		const parentSpy = observeActualNativeRemoval().spy;
		try {
			const outcome = retireTaskArtifactOwner(parentFixture.context, parentFixture.evidence);
			expect(outcome.kind).toBe("uncertain");
			expect(parentSpy).not.toHaveBeenCalled();
			expect(fs.readFileSync(sentinel, "utf8")).toBe("untouched parent occupant");
		} finally {
			fs.rmSync(parent, { recursive: true, force: true });
			fs.renameSync(displacedParent, parent);
			vi.restoreAllMocks();
		}
	});

	it("rejects forged completion, contradictory native side roles, and expanding historical authority", async () => {
		const fixture = await makeOwnerFixture();
		const forgedCompletion = {
			kind: "completed",
			evidence: fixture.evidence,
			nativeOutcome: { ok: true },
		};
		expect(() =>
			verifyTaskArtifactOwnerPhysicalRetirement(fixture.context, fixture.evidence, forgedCompletion),
		).toThrow("task_artifact_owner_physical_retirement_unverified");

		const sidePath = path.join(path.dirname(fixture.ownerPath), ".gjc-native-side-role");
		expect(() =>
			parseTaskArtifactOwnerRetirementOutcome(fixture.context, fixture.evidence, {
				kind: "completed",
				evidence: fixture.evidence,
				nativeOutcome: { ok: true, retainedUnknownPath: sidePath },
			}),
		).toThrow("task_artifact_owner_retirement_outcome_invalid");
		expect(() =>
			parseTaskArtifactOwnerRetirementOutcome(fixture.context, fixture.evidence, {
				kind: "cleanup_pending",
				evidence: fixture.evidence,
				continuation: continuationFor(fixture),
				nativeOutcome: { ok: false, code: "cleanup_pending", retainedUnknownPath: sidePath },
			}),
		).toThrow("task_artifact_owner_retirement_outcome_invalid");

		const root = fixture.evidence.treeSnapshot.entries.find(entry => entry.relativePath === "");
		if (!root) throw new Error("fixture owner snapshot root missing");
		const expandedTree = {
			...fixture.evidence.treeSnapshot,
			entries: [
				...fixture.evidence.treeSnapshot.entries,
				{
					relativePath: "unowned.bin",
					kind: "file" as const,
					dev: root.dev,
					ino: (BigInt(root.ino) + 1n).toString(),
					nlink: "1",
					size: "1",
					mtimeNs: "0",
					ctimeNs: "0",
					sha256: crypto.createHash("sha256").update("x").digest("hex"),
				},
			],
		};
		expect(() =>
			verifyTaskArtifactOwnerRetirementContinuation(fixture.context, fixture.evidence, {
				...continuationFor(fixture, fixture.ownerPath),
				payloadDurable: true,
				retainedTreeSnapshot: fixture.evidence.treeSnapshot,
			}),
		).toThrow("task_artifact_owner_retired_payload_changed");
		expect(() =>
			verifyTaskArtifactOwnerRetirementContinuation(fixture.context, fixture.evidence, {
				...continuationFor(fixture, fixture.ownerPath),
				retainedTreeSnapshot: expandedTree,
			}),
		).toThrow("task_artifact_owner_continuation_invalid");
	});

	it("does not treat canonical absence or historical payloadDurable as physical or fresh payload proof", async () => {
		const fixture = await makeOwnerFixture();
		const historical = { ...continuationFor(fixture), payloadDurable: true };
		fs.renameSync(fixture.ownerPath, historical.retainedRootPath);
		expect(() =>
			verifyTaskArtifactOwnerRetirementContinuation(fixture.context, fixture.evidence, historical),
		).toThrow("task_artifact_owner_retired_payload_changed");
		expect(() =>
			verifyTaskArtifactOwnerPhysicalRetirement(fixture.context, fixture.evidence, {
				kind: "completed",
				evidence: fixture.evidence,
				nativeOutcome: { ok: true },
			}),
		).toThrow("task_artifact_owner_physical_retirement_unverified");
	});
});
