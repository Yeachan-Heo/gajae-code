import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	EMPTY_PAYLOAD_SHA256,
	isCanonicalDecimal,
	OWNER_DELETION_SCHEMA_VERSION,
	OWNER_RETIREMENT_SCHEMA_VERSION,
	OWNER_SCHEMA_VERSION,
	ownerAbsolutePath,
	ownerIdForSession,
	parseTaskArtifactOwnerDeletionEvidence,
	parseTaskArtifactOwnerLocator,
	parseTaskArtifactOwnerRetirementContinuation,
	parseTaskArtifactOwnerRetirementOutcome,
	sameTreeContents,
	type TaskArtifactOwnerStorageContext,
} from "../src/session/task-artifact-owner-codec";

const sessionId = "codec-session-7";
const sessionsRoot = path.resolve(os.tmpdir(), "task-artifact-owner-codec");
const locator = {
	schemaVersion: OWNER_SCHEMA_VERSION,
	ownerId: ownerIdForSession(sessionId),
	directoryDev: "11",
	directoryIno: "12",
};
const parentIdentity = { dev: "20", ino: "21" };
const treeSnapshot = {
	rootDev: locator.directoryDev,
	rootIno: locator.directoryIno,
	entries: [
		{
			relativePath: "",
			kind: "directory",
			dev: locator.directoryDev,
			ino: locator.directoryIno,
			nlink: "1",
			size: "0",
			mtimeNs: "100",
			ctimeNs: "101",
		},
		{
			relativePath: "payload.bin",
			kind: "file",
			dev: "13",
			ino: "14",
			nlink: "1",
			size: "4",
			mtimeNs: "102",
			ctimeNs: "103",
			sha256: "a".repeat(64),
		},
	],
};
const evidence = {
	schemaVersion: OWNER_DELETION_SCHEMA_VERSION,
	sessionId,
	locator,
	parentIdentity,
	treeSnapshot,
};
const context: TaskArtifactOwnerStorageContext = {
	rootAuthority: { canonicalPath: sessionsRoot, dev: 1n, ino: 2n },
	sessionsRoot,
	securityPolicy: "default",
	profileAgentDir: path.resolve(os.tmpdir(), "task-artifact-owner-profile"),
};
const ownerPath = ownerAbsolutePath(context, locator.ownerId);

function continuation(retainedTree = treeSnapshot, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: OWNER_RETIREMENT_SCHEMA_VERSION,
		parentIdentity,
		retainedRootPath: ownerPath,
		retainedTreeSnapshot: retainedTree,
		...extra,
	};
}

function scrubbedTree(): typeof treeSnapshot {
	return {
		...treeSnapshot,
		entries: [treeSnapshot.entries[0], { ...treeSnapshot.entries[1], size: "0", sha256: EMPTY_PAYLOAD_SHA256 }],
	};
}

describe("task artifact owner codec", () => {
	it("accepts only canonical native decimal identities and exact locator records", () => {
		expect(isCanonicalDecimal("0")).toBe(true);
		expect(isCanonicalDecimal("18446744073709551615")).toBe(true);
		expect(isCanonicalDecimal("01")).toBe(false);
		expect(isCanonicalDecimal("-1")).toBe(false);
		expect(() => parseTaskArtifactOwnerLocator({ ...locator, directoryDev: "18446744073709551616" })).toThrow();
		expect(() => parseTaskArtifactOwnerLocator({ ...locator, directoryIno: "01" })).toThrow();
		expect(() => parseTaskArtifactOwnerLocator({ ...locator, extra: true })).toThrow();
		expect(parseTaskArtifactOwnerLocator(undefined)).toBeUndefined();
	});

	it("binds immutable evidence to the owner session, root identity, and unique safe tree entries", () => {
		const parsed = parseTaskArtifactOwnerDeletionEvidence(evidence);
		expect(parsed.locator.ownerId).toBe(ownerIdForSession(sessionId));
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen(parsed.locator)).toBe(true);
		expect(Object.isFrozen(parsed.treeSnapshot.entries)).toBe(true);
		expect(Object.isFrozen(parsed.treeSnapshot.entries[1])).toBe(true);
		expect(() => parseTaskArtifactOwnerDeletionEvidence({ ...evidence, sessionId: "different-session" })).toThrow();
		expect(() =>
			parseTaskArtifactOwnerDeletionEvidence({
				...evidence,
				locator: { ...locator, directoryDev: "99" },
			}),
		).toThrow();
		expect(() =>
			parseTaskArtifactOwnerDeletionEvidence({
				...evidence,
				extra: "unknown",
			}),
		).toThrow();
	});

	it("rejects duplicate, unsafe, malformed, and parentless tree entries", () => {
		const file = treeSnapshot.entries[1];
		expect(() =>
			parseTaskArtifactOwnerDeletionEvidence({
				...evidence,
				treeSnapshot: { ...treeSnapshot, entries: [treeSnapshot.entries[0], file, file] },
			}),
		).toThrow("task_artifact_owner_evidence_invalid");
		for (const relativePath of ["../outside", "/absolute", "nested//file", "nested\\file"]) {
			const unsafe = { ...file, relativePath };
			expect(() =>
				parseTaskArtifactOwnerDeletionEvidence({
					...evidence,
					treeSnapshot: {
						...treeSnapshot,
						entries: [treeSnapshot.entries[0], unsafe],
					},
				}),
			).toThrow();
		}
		expect(() =>
			parseTaskArtifactOwnerDeletionEvidence({
				...evidence,
				treeSnapshot: {
					...treeSnapshot,
					entries: [treeSnapshot.entries[0], { ...file, relativePath: "missing-parent/file" }],
				},
			}),
		).toThrow();
		expect(() =>
			parseTaskArtifactOwnerDeletionEvidence({
				...evidence,
				treeSnapshot: {
					...treeSnapshot,
					entries: [treeSnapshot.entries[0], { ...file, sha256: "not-a-sha256" }],
				},
			}),
		).toThrow();
	});

	it("treats entry order as content-significant while rejecting retained-tree expansion", () => {
		const first = { ...treeSnapshot.entries[1], relativePath: "a.bin" };
		const second = { ...treeSnapshot.entries[1], relativePath: "b.bin", ino: "15" };
		const ordered = { ...treeSnapshot, entries: [treeSnapshot.entries[0], first, second] };
		const reversed = { ...treeSnapshot, entries: [treeSnapshot.entries[0], second, first] };
		expect(sameTreeContents(ordered, reversed)).toBe(false);

		const expanded = {
			...treeSnapshot,
			entries: [...treeSnapshot.entries, { ...treeSnapshot.entries[1], relativePath: "injected.bin" }],
		};
		expect(() =>
			parseTaskArtifactOwnerRetirementContinuation(
				context,
				parseTaskArtifactOwnerDeletionEvidence(evidence),
				continuation(expanded),
			),
		).toThrow();
	});

	it("rejects continuation parent changes, owner-path escape, and changed payload hashes", () => {
		const originalEvidence = parseTaskArtifactOwnerDeletionEvidence(evidence);
		expect(() =>
			parseTaskArtifactOwnerRetirementContinuation(context, originalEvidence, {
				...continuation(),
				parentIdentity: { dev: parentIdentity.dev, ino: "22" },
			}),
		).toThrow();
		expect(() =>
			parseTaskArtifactOwnerRetirementContinuation(context, originalEvidence, {
				...continuation(),
				retainedRootPath: `${ownerPath}/../outside`,
			}),
		).toThrow();
		expect(() =>
			parseTaskArtifactOwnerRetirementContinuation(
				context,
				originalEvidence,
				continuation({
					...treeSnapshot,
					entries: [treeSnapshot.entries[0], { ...treeSnapshot.entries[1], sha256: "b".repeat(64) }],
				}),
			),
		).toThrow();
	});

	it("binds native side paths to their exact continuation role", () => {
		const unknownPath = path.join(sessionsRoot, ".task-artifact-owners", ".gjc-retained-unknown");
		const matching = {
			kind: "cleanup_pending",
			evidence,
			continuation: continuation(treeSnapshot, {
				nativeCodes: ["cleanup_pending"],
				retainedUnknownPaths: [unknownPath],
			}),
			nativeOutcome: { ok: false, code: "cleanup_pending", retainedUnknownPath: unknownPath },
		};
		expect(
			parseTaskArtifactOwnerRetirementOutcome(context, parseTaskArtifactOwnerDeletionEvidence(evidence), matching)
				.kind,
		).toBe("cleanup_pending");
		expect(() =>
			parseTaskArtifactOwnerRetirementOutcome(context, parseTaskArtifactOwnerDeletionEvidence(evidence), {
				...matching,
				nativeOutcome: { ok: false, code: "cleanup_pending", retainedSuccessorPath: unknownPath },
			}),
		).toThrow();
		expect(() =>
			parseTaskArtifactOwnerRetirementContinuation(
				context,
				parseTaskArtifactOwnerDeletionEvidence(evidence),
				continuation(treeSnapshot, { retainedUnknownPaths: [path.join(sessionsRoot, "unrelated")] }),
			),
		).toThrow();
	});

	it("round-trips each retirement outcome shape without interpreting DTOs as live proof", () => {
		const parsedEvidence = parseTaskArtifactOwnerDeletionEvidence(evidence);
		const durableContinuation = continuation(scrubbedTree(), {
			retainedRootPath: `${ownerPath}.removing`,
			nativeCodes: ["cleanup_pending"],
			payloadDurable: true,
		});
		const outcomes = [
			// A native-shaped `ok` value tests only the pure decoder, never physical retirement.
			{ kind: "completed", evidence, nativeOutcome: { ok: true } },
			{
				kind: "payload_retired",
				namespace: "retained",
				evidence,
				continuation: durableContinuation,
				nativeOutcome: { ok: false, code: "cleanup_pending", payloadDurable: true },
			},
			{
				kind: "cleanup_pending",
				evidence,
				continuation: continuation(treeSnapshot, { nativeCodes: ["cleanup_pending"] }),
				nativeOutcome: { ok: false, code: "cleanup_pending" },
			},
			{
				kind: "uncertain",
				evidence,
				continuation: continuation(),
				reason: "native state unavailable",
			},
		] as const;
		for (const outcome of outcomes) {
			const decoded = parseTaskArtifactOwnerRetirementOutcome(context, parsedEvidence, outcome);
			expect(decoded.kind).toBe(outcome.kind);
			expect<unknown>(decoded).toEqual(outcome);
		}
	});

	it("rejects contradictory outcome claims and unknown outcome/native fields", () => {
		const parsedEvidence = parseTaskArtifactOwnerDeletionEvidence(evidence);
		const cleanupContinuation = continuation(treeSnapshot, { nativeCodes: ["cleanup_pending"] });
		expect(() =>
			parseTaskArtifactOwnerRetirementOutcome(context, parsedEvidence, { kind: "completed", evidence }),
		).toThrow();
		expect(() =>
			parseTaskArtifactOwnerRetirementOutcome(context, parsedEvidence, {
				kind: "completed",
				evidence,
				nativeOutcome: { ok: false, code: "cleanup_pending" },
			}),
		).toThrow();
		expect(() =>
			parseTaskArtifactOwnerRetirementOutcome(context, parsedEvidence, {
				kind: "payload_retired",
				namespace: "retained",
				evidence,
				continuation: cleanupContinuation,
				nativeOutcome: { ok: false, code: "cleanup_pending" },
			}),
		).toThrow();
		expect(() =>
			parseTaskArtifactOwnerRetirementOutcome(context, parsedEvidence, {
				kind: "cleanup_pending",
				evidence,
				continuation: cleanupContinuation,
				nativeOutcome: { ok: false, code: "cleanup_pending", fabricated: true },
			}),
		).toThrow();
		expect(() =>
			parseTaskArtifactOwnerRetirementOutcome(context, parsedEvidence, {
				kind: "cleanup_pending",
				evidence,
				continuation: cleanupContinuation,
				extra: true,
			}),
		).toThrow();
	});
});
