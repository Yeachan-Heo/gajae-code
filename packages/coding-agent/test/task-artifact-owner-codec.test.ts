import { describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
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
	retainedTreeDoesNotExpandAuthority,
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

function directoryEntry(relativePath: string, dev: string, ino: string) {
	return {
		relativePath,
		kind: "directory" as const,
		dev,
		ino,
		nlink: "1",
		size: "0",
		mtimeNs: "100",
		ctimeNs: "101",
	};
}

function quarantineName(relativePath: string, dev: string, ino: string): string {
	const material = `${relativePath}\0${dev}\0${ino}`;
	return `.pi-tree-detached-${crypto.createHash("sha256").update(material, "utf8").digest("hex")}`;
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

	it("maps deterministic quarantined descendants back to immutable original tree authority", () => {
		const nestedTree = {
			...treeSnapshot,
			entries: [
				treeSnapshot.entries[0],
				directoryEntry("outer", "30", "31"),
				directoryEntry("outer/inner", "32", "33"),
				{ ...treeSnapshot.entries[1], relativePath: "outer/inner/payload.bin" },
			],
		};
		const parsedEvidence = parseTaskArtifactOwnerDeletionEvidence({ ...evidence, treeSnapshot: nestedTree });
		const outer = nestedTree.entries[1];
		const inner = nestedTree.entries[2];
		const payload = nestedTree.entries[3];
		const outerName = quarantineName(outer.relativePath, outer.dev, outer.ino);
		const innerName = quarantineName(inner.relativePath, inner.dev, inner.ino);
		const payloadName = quarantineName(payload.relativePath, payload.dev, payload.ino);
		const retainedTree = {
			...nestedTree,
			entries: [
				nestedTree.entries[0],
				{ ...outer, relativePath: outerName },
				{ ...inner, relativePath: `${outerName}/${innerName}` },
				{ ...payload, relativePath: `${outerName}/${innerName}/${payloadName}` },
			],
		};

		expect(retainedTreeDoesNotExpandAuthority(parsedEvidence.treeSnapshot, retainedTree)).toBe(true);
		expect(
			parseTaskArtifactOwnerRetirementContinuation(
				context,
				parsedEvidence,
				continuation(retainedTree, { retainedRootPath: `${ownerPath}.removing` }),
			).retainedTreeSnapshot.entries,
		).toHaveLength(4);

		const unrelatedName = ".pi-tree-detached-not-a-digest";
		const unrelatedTree = {
			...retainedTree,
			entries: [nestedTree.entries[0], { ...payload, relativePath: unrelatedName }],
		};
		expect(retainedTreeDoesNotExpandAuthority(parsedEvidence.treeSnapshot, unrelatedTree)).toBe(false);
		expect(() =>
			parseTaskArtifactOwnerRetirementContinuation(
				context,
				parsedEvidence,
				continuation(unrelatedTree, { retainedRootPath: `${ownerPath}.removing` }),
			),
		).toThrow("task_artifact_owner_continuation_invalid");

		const changedDigestName = `${payloadName.slice(0, -1)}${payloadName.endsWith("0") ? "1" : "0"}`;
		const changedDigestTree = {
			...retainedTree,
			entries: [
				nestedTree.entries[0],
				{ ...outer, relativePath: outerName },
				{ ...inner, relativePath: `${outerName}/${innerName}` },
				{ ...payload, relativePath: `${outerName}/${innerName}/${changedDigestName}` },
			],
		};
		expect(retainedTreeDoesNotExpandAuthority(parsedEvidence.treeSnapshot, changedDigestTree)).toBe(false);

		const changedInodeTree = {
			...retainedTree,
			entries: [
				nestedTree.entries[0],
				{ ...outer, relativePath: outerName },
				{ ...inner, relativePath: `${outerName}/${innerName}` },
				{ ...payload, relativePath: `${outerName}/${innerName}/${payloadName}`, ino: "99" },
			],
		};
		expect(retainedTreeDoesNotExpandAuthority(parsedEvidence.treeSnapshot, changedInodeTree)).toBe(false);

		const misplacedNestedTree = {
			...retainedTree,
			entries: [
				nestedTree.entries[0],
				{ ...inner, relativePath: innerName },
				{ ...payload, relativePath: `${innerName}/${payloadName}` },
			],
		};
		expect(retainedTreeDoesNotExpandAuthority(parsedEvidence.treeSnapshot, misplacedNestedTree)).toBe(false);

		const expandedTree = {
			...retainedTree,
			entries: [
				...retainedTree.entries,
				{
					...payload,
					relativePath: "unowned.bin",
					dev: "40",
					ino: "41",
				},
			],
		};
		expect(retainedTreeDoesNotExpandAuthority(parsedEvidence.treeSnapshot, expandedTree)).toBe(false);
		for (const unauthorizedTree of [changedDigestTree, changedInodeTree, misplacedNestedTree, expandedTree]) {
			expect(() =>
				parseTaskArtifactOwnerRetirementContinuation(
					context,
					parsedEvidence,
					continuation(unauthorizedTree, { retainedRootPath: `${ownerPath}.removing` }),
				),
			).toThrow("task_artifact_owner_continuation_invalid");
		}
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

	it("preserves uncertain native success without granting completed status or accepting success side fields", () => {
		const parsedEvidence = parseTaskArtifactOwnerDeletionEvidence(evidence);
		const uncertainSuccess = {
			kind: "uncertain",
			evidence,
			continuation: continuation(
				{ ...treeSnapshot, entries: [treeSnapshot.entries[0]] },
				{ retainedRootPath: `${ownerPath}.removing` },
			),
			reason: "task_artifact_owner_parent_identity_changed_after_removal",
			nativeOutcome: { ok: true },
		} as const;
		const decoded = parseTaskArtifactOwnerRetirementOutcome(context, parsedEvidence, uncertainSuccess);
		expect(decoded.kind).toBe("uncertain");
		expect(decoded.nativeOutcome).toEqual({ ok: true });
		expect<unknown>(decoded).toEqual(uncertainSuccess);

		for (const nativeOutcome of [
			{ ok: true, code: "cleanup_pending" },
			{ ok: true, payloadDurable: true },
			{ ok: true, windowsErrorCode: "0x00000005" },
			{ ok: true, retainedUnknownPath: path.join(sessionsRoot, ".gjc-retained-unknown") },
		]) {
			expect(() =>
				parseTaskArtifactOwnerRetirementOutcome(context, parsedEvidence, { ...uncertainSuccess, nativeOutcome }),
			).toThrow("task_artifact_owner_retirement_outcome_invalid");
		}
		expect(() =>
			parseTaskArtifactOwnerRetirementOutcome(context, parsedEvidence, {
				kind: "completed",
				evidence,
				nativeOutcome: { ok: true, windowsErrorCode: "0x00000005" },
			}),
		).toThrow("task_artifact_owner_retirement_outcome_invalid");

		expect(() =>
			parseTaskArtifactOwnerRetirementOutcome(context, parsedEvidence, {
				...uncertainSuccess,
				continuation: { ...uncertainSuccess.continuation, nativeCodes: ["invalid code"] },
			}),
		).toThrow("task_artifact_owner_continuation_invalid");
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
