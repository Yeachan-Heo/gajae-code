import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	continuationExtendsPrevious,
	type ManagedGcSessionRetirementTarget,
	managedGcRetirementIdentityRecord,
	managedGcRetirementIdentityValue,
	parseManagedGcRetirementReceipt,
} from "../src/session/internal/managed-gc-retirement-codec";
import type { NativeDirectoryTreeSnapshot, SessionStorageFileIdentity } from "../src/session/session-storage";
import {
	EMPTY_PAYLOAD_SHA256,
	immutableDeletionEvidence,
	ownerAbsolutePath,
	ownerIdForSession,
	parseTaskArtifactOwnerLocator,
	type TaskArtifactOwnerRetirementContinuation,
	type TaskArtifactOwnerStorageContext,
} from "../src/session/task-artifact-owner-codec";

interface Fixture {
	readonly ownerContext: TaskArtifactOwnerStorageContext;
	readonly target: ManagedGcSessionRetirementTarget;
	readonly scopeDigest: string;
	readonly evidence: ReturnType<typeof immutableDeletionEvidence>;
	readonly continuation: TaskArtifactOwnerRetirementContinuation;
}

function fixture(): Fixture {
	const sessionsRoot = path.resolve(os.tmpdir(), "gjc-managed-gc-retirement-codec-sessions");
	const sessionId = "portable-session-fixture";
	const locator = parseTaskArtifactOwnerLocator({
		schemaVersion: 1,
		ownerId: ownerIdForSession(sessionId),
		directoryDev: "7",
		directoryIno: "19",
	});
	if (!locator) throw new Error("fixture_locator_missing");
	const treeSnapshot: NativeDirectoryTreeSnapshot = {
		rootDev: "7",
		rootIno: "19",
		entries: [
			{
				relativePath: "",
				kind: "directory",
				dev: "7",
				ino: "19",
				nlink: "1",
				size: "0",
				mtimeNs: "0",
				ctimeNs: "0",
			},
		],
	};
	const evidence = immutableDeletionEvidence(sessionId, locator, { dev: "3", ino: "5" }, treeSnapshot);
	// The pure decoder uses the canonical sessions root only; no root authority or physical proof is fabricated.
	const ownerContext = {
		sessionsRoot,
		securityPolicy: "default",
		profileAgentDir: path.resolve(os.tmpdir(), "gjc-managed-gc-retirement-codec-profile"),
	} as TaskArtifactOwnerStorageContext;
	const transcriptIdentity: SessionStorageFileIdentity = {
		dev: 11n,
		ino: 23n,
		nlink: 1n,
		size: 123,
		mtimeNs: -456n,
		sha256: "a".repeat(64),
	};
	const target: ManagedGcSessionRetirementTarget = {
		transcriptPath: path.join(sessionsRoot, "session", "transcript.jsonl"),
		sessionId,
		cwd: path.resolve(os.tmpdir(), "portable-fixture-cwd"),
		transcriptIdentity,
		taskArtifactOwnerLocator: locator,
	};
	const continuation: TaskArtifactOwnerRetirementContinuation = {
		schemaVersion: 1,
		parentIdentity: evidence.parentIdentity,
		retainedRootPath: ownerAbsolutePath(ownerContext, locator.ownerId),
		retainedTreeSnapshot: evidence.treeSnapshot,
	};
	return { ownerContext, target, scopeDigest: "d".repeat(64), evidence, continuation };
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function cleanupPendingOutcome(test: Fixture): Record<string, unknown> {
	return {
		kind: "cleanup_pending",
		evidence: clone(test.evidence),
		continuation: clone(test.continuation),
	};
}

function payloadRetiredOutcome(test: Fixture): {
	outcome: Record<string, unknown>;
	continuation: TaskArtifactOwnerRetirementContinuation;
} {
	const continuation: TaskArtifactOwnerRetirementContinuation = {
		...test.continuation,
		retainedRootPath: `${ownerAbsolutePath(test.ownerContext, test.target.taskArtifactOwnerLocator.ownerId)}.removing`,
		nativeCodes: ["cleanup_pending"],
		payloadDurable: true,
	};
	return {
		continuation,
		outcome: {
			kind: "payload_retired",
			namespace: "retained",
			evidence: clone(test.evidence),
			continuation: clone(continuation),
			nativeOutcome: { ok: false, code: "cleanup_pending", payloadDurable: true },
		},
	};
}

function wire(
	test: Fixture,
	state: "prepared" | "artifacts_removed" | "owner_pending" | "owner_retired",
): Record<string, unknown> {
	const common = {
		schemaVersion: 1,
		state,
		scope: test.scopeDigest,
		transcriptPath: test.target.transcriptPath,
		sessionId: test.target.sessionId,
		cwd: test.target.cwd,
		transcriptIdentity: managedGcRetirementIdentityRecord(test.target.transcriptIdentity),
		taskArtifactOwnerDeletionEvidence: clone(test.evidence),
	};
	if (state === "prepared") return common;
	if (state === "artifacts_removed") return { ...common, artifactsRemoved: true };
	if (state === "owner_pending") {
		const outcome = cleanupPendingOutcome(test);
		return {
			...common,
			artifactsRemoved: true,
			ownerRetirementAttempt: 1,
			taskArtifactOwnerRetirementOutcome: outcome,
			taskArtifactOwnerRetirementContinuation: clone(test.continuation),
		};
	}
	return {
		...common,
		artifactsRemoved: true,
		taskArtifactOwnerRetired: true,
		taskArtifactOwnerRetirementOutcome: {
			kind: "completed",
			evidence: clone(test.evidence),
			nativeOutcome: { ok: true },
		},
	};
}

function decode(test: Fixture, value: unknown) {
	return parseManagedGcRetirementReceipt(value, test.scopeDigest, test.ownerContext, test.target);
}

describe("managed GC retirement codec", () => {
	it("decodes each protocol state without performing retirement", () => {
		const test = fixture();
		for (const state of ["prepared", "artifacts_removed", "owner_pending", "owner_retired"] as const) {
			const receipt = decode(test, wire(test, state));
			expect(receipt.state).toBe(state);
			expect(receipt.transcriptIdentity.mtimeNs).toBe(-456n);
		}
		// The completed native-shaped DTO is only decoded data, not physical-retirement proof.
		expect(decode(test, wire(test, "owner_retired")).taskArtifactOwnerRetirementOutcome?.kind).toBe("completed");
	});

	it("preserves strict six-field identity encoding and signed nanosecond timestamps", () => {
		const test = fixture();
		const encoded = managedGcRetirementIdentityRecord(test.target.transcriptIdentity);
		expect(Object.keys(encoded).sort()).toEqual(["dev", "ino", "mtimeNs", "nlink", "sha256", "size"]);
		expect(managedGcRetirementIdentityValue(encoded)).toEqual(test.target.transcriptIdentity);
		expect(() => managedGcRetirementIdentityValue({ ...encoded, extra: true })).toThrow();
		expect(() => managedGcRetirementIdentityValue({ ...encoded, sha256: "A".repeat(64) })).toThrow();
		expect(() => managedGcRetirementIdentityValue({ ...encoded, mtimeNs: "-0" })).toThrow();
		expect(() => managedGcRetirementIdentityValue({ ...encoded, size: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
	});

	it("rejects unknown keys and wrong scope, transcript, cwd, session, or transcript identity", () => {
		const test = fixture();
		const unknown = wire(test, "prepared");
		unknown.futureField = true;
		expect(() => decode(test, unknown)).toThrow();

		const wrongScope = wire(test, "prepared");
		wrongScope.scope = "e".repeat(64);
		expect(() => decode(test, wrongScope)).toThrow();

		const wrongTranscript = wire(test, "prepared");
		wrongTranscript.transcriptPath = path.join(test.ownerContext.sessionsRoot, "other.jsonl");
		expect(() => decode(test, wrongTranscript)).toThrow();

		const wrongCwd = wire(test, "prepared");
		wrongCwd.cwd = path.resolve(os.tmpdir(), "other-cwd");
		expect(() => decode(test, wrongCwd)).toThrow();

		const wrongSession = wire(test, "prepared");
		wrongSession.sessionId = "other-session";
		expect(() => decode(test, wrongSession)).toThrow();

		const wrongIdentity = wire(test, "prepared");
		wrongIdentity.transcriptIdentity = {
			...(wrongIdentity.transcriptIdentity as Record<string, unknown>),
			ino: "24",
		};
		expect(() => decode(test, wrongIdentity)).toThrow();

		const invalidHash = wire(test, "prepared");
		invalidHash.transcriptIdentity = {
			...(invalidHash.transcriptIdentity as Record<string, unknown>),
			sha256: "f".repeat(63),
		};
		expect(() => decode(test, invalidHash)).toThrow();
	});

	it("rejects malformed owner locator and deletion evidence", () => {
		const test = fixture();
		const wrongLocator = wire(test, "prepared");
		const evidence = wrongLocator.taskArtifactOwnerDeletionEvidence as Record<string, unknown>;
		const locator = evidence.locator as Record<string, unknown>;
		locator.ownerId = "f".repeat(64);
		expect(() => decode(test, wrongLocator)).toThrow();

		const wrongEvidence = wire(test, "prepared");
		const invalidEvidence = wrongEvidence.taskArtifactOwnerDeletionEvidence as Record<string, unknown>;
		invalidEvidence.sessionId = "different-session";
		expect(() => decode(test, wrongEvidence)).toThrow();

		const mismatchedLocator = fixture();
		const alternateLocator = parseTaskArtifactOwnerLocator({
			schemaVersion: 1,
			ownerId: ownerIdForSession(mismatchedLocator.target.sessionId),
			directoryDev: "8",
			directoryIno: "20",
		});
		if (!alternateLocator) throw new Error("fixture_alternate_locator_missing");
		const alternateEvidence = immutableDeletionEvidence(
			mismatchedLocator.target.sessionId,
			alternateLocator,
			mismatchedLocator.evidence.parentIdentity,
			{
				...mismatchedLocator.evidence.treeSnapshot,
				rootDev: "8",
				rootIno: "20",
				entries: mismatchedLocator.evidence.treeSnapshot.entries.map(entry => ({ ...entry, dev: "8", ino: "20" })),
			},
		);
		const locatorMismatch = wire(mismatchedLocator, "prepared");
		locatorMismatch.taskArtifactOwnerDeletionEvidence = clone(alternateEvidence);
		expect(() => decode(mismatchedLocator, locatorMismatch)).toThrow();
	});

	it("rejects malformed individual attempts while leaving gap detection to the journal reader", () => {
		const test = fixture();
		const malformed = wire(test, "owner_pending");
		malformed.ownerRetirementAttempt = Number.MAX_SAFE_INTEGER + 1;
		expect(() => decode(test, malformed)).toThrow();

		const laterIndividualAttempt = wire(test, "owner_pending");
		laterIndividualAttempt.ownerRetirementAttempt = 2;
		expect(decode(test, laterIndividualAttempt).ownerRetirementAttempt).toBe(2);

		const inconsistentNativeDisposition = wire(test, "owner_pending");
		const outcome = inconsistentNativeDisposition.taskArtifactOwnerRetirementOutcome as Record<string, unknown>;
		outcome.nativeOutcome = { ok: false, code: "unrecorded_native_code" };
		expect(() => decode(test, inconsistentNativeDisposition)).toThrow();
	});

	it("rejects a non-expanding-history violation in a continuation", () => {
		const test = fixture();
		const expanded: NativeDirectoryTreeSnapshot = {
			...test.evidence.treeSnapshot,
			entries: [
				...test.evidence.treeSnapshot.entries,
				{
					relativePath: "new-file",
					kind: "file",
					dev: "7",
					ino: "20",
					nlink: "1",
					size: "1",
					mtimeNs: "0",
					ctimeNs: "0",
					sha256: "b".repeat(64),
				},
			],
		};
		const value = wire(test, "owner_pending");
		const outcome = value.taskArtifactOwnerRetirementOutcome as Record<string, unknown>;
		const outcomeContinuation = outcome.continuation as Record<string, unknown>;
		outcomeContinuation.retainedTreeSnapshot = expanded;
		(value.taskArtifactOwnerRetirementContinuation as Record<string, unknown>).retainedTreeSnapshot = expanded;
		expect(() => decode(test, value)).toThrow();
	});

	it("rejects contradictory payload-retired owner flags", () => {
		const test = fixture();
		const { outcome, continuation } = payloadRetiredOutcome(test);
		const value = {
			...wire(test, "owner_pending"),
			taskArtifactOwnerRetirementOutcome: outcome,
			taskArtifactOwnerRetirementContinuation: clone(continuation),
			taskArtifactOwnerPayloadRetired: true,
			taskArtifactOwnerNamespaceRetained: false,
		};
		expect(() => decode(test, value)).toThrow();
	});

	it("accepts a structurally consistent payload-retired pending DTO", () => {
		const test = fixture();
		const { outcome, continuation } = payloadRetiredOutcome(test);
		const value = {
			...wire(test, "owner_pending"),
			taskArtifactOwnerRetirementOutcome: outcome,
			taskArtifactOwnerRetirementContinuation: clone(continuation),
			taskArtifactOwnerPayloadRetired: true,
			taskArtifactOwnerNamespaceRetained: true,
		};
		expect(decode(test, value).taskArtifactOwnerPayloadRetired).toBe(true);
	});

	it("requires continuation history to preserve parent, root, entry, and side-role authority", () => {
		const test = fixture();
		const oldFile = {
			relativePath: "payload",
			kind: "file" as const,
			dev: "7",
			ino: "21",
			nlink: "1",
			size: "4",
			mtimeNs: "0",
			ctimeNs: "0",
			sha256: "c".repeat(64),
		};
		const previous: TaskArtifactOwnerRetirementContinuation = {
			...test.continuation,
			retainedTreeSnapshot: {
				...test.evidence.treeSnapshot,
				entries: [...test.evidence.treeSnapshot.entries, oldFile],
			},
			detachedPaths: [test.continuation.retainedRootPath],
			retainedSuccessorPaths: [path.join(test.ownerContext.sessionsRoot, ".gjc-successor")],
			payloadDurable: false,
		};
		const emptied: TaskArtifactOwnerRetirementContinuation = {
			...previous,
			retainedTreeSnapshot: {
				...previous.retainedTreeSnapshot,
				entries: [
					previous.retainedTreeSnapshot.entries[0]!,
					{ ...oldFile, size: "0", sha256: EMPTY_PAYLOAD_SHA256 },
				],
			},
			payloadDurable: true,
		};
		expect(continuationExtendsPrevious(previous, emptied)).toBe(true);
		expect(
			continuationExtendsPrevious(previous, {
				...emptied,
				parentIdentity: { ...emptied.parentIdentity, ino: "6" },
			}),
		).toBe(false);
		expect(
			continuationExtendsPrevious(previous, {
				...emptied,
				retainedTreeSnapshot: { ...emptied.retainedTreeSnapshot, rootIno: "22" },
			}),
		).toBe(false);
		expect(
			continuationExtendsPrevious(previous, {
				...emptied,
				retainedTreeSnapshot: {
					...emptied.retainedTreeSnapshot,
					entries: [emptied.retainedTreeSnapshot.entries[0]!],
				},
				retainedSuccessorPaths: [],
			}),
		).toBe(false);
		expect(
			continuationExtendsPrevious(previous, {
				...emptied,
				retainedSuccessorPaths: [],
				retainedPlaceholderPaths: [path.join(test.ownerContext.sessionsRoot, ".gjc-successor")],
			}),
		).toBe(false);
	});
});
